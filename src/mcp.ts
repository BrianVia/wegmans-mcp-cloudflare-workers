import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  ZodRawShapeCompat,
  ShapeOutput,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { z } from "zod";
import { env } from "./env.js";
import { searchProducts, formatProduct, lookupProduct } from "./algolia.js";
import { findStores } from "./stores.js";
import { addToCart, getCart, removeFromCart, type CartResponse } from "./cart.js";
import { queryProductsByIds } from "./my-items.js";
import { syncPurchaseHistory, loadPurchaseHistory, loadMyItems } from "./purchase-history.js";
import { classifyUrgency, generateShoppingList, getProductInsight } from "./patterns.js";
import { syncGroceryNote } from "./grocery-sync.js";

const PREFS_KEY = "preferences";

export async function createMcpServer(): Promise<McpServer> {
// The owner's food preferences ride along as server instructions so every client sees them on connect.
const preferences = await env().DATA.get(PREFS_KEY);
const server = new McpServer({ name: "wegmans-mcp", version: "1.0.0" }, {
  instructions: preferences
    ? `The account owner's food and shopping preferences. Respect them when searching, choosing products, and adding to the cart:\n\n${preferences}`
    : "No food preferences set yet. Use set_food_preferences to store the owner's preferences (markdown).",
});

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
};

/**
 * Register a tool with uniform error handling: any thrown error becomes a
 * text result instead of an MCP protocol failure.
 */
function registerTool<Args extends ZodRawShapeCompat>(
  name: string,
  description: string,
  schema: Args,
  handler: (args: ShapeOutput<Args>) => Promise<ToolResult>
): void {
  // Widen the schema so server.tool's generic resolves to a concrete type;
  // ToolCallback<Args> is a conditional type that TypeScript cannot evaluate
  // while Args is a free type variable.
  const broadSchema: ZodRawShapeCompat = schema;
  server.tool(name, description, broadSchema, async (args) => {
    try {
      // The SDK validates `args` against `schema` before invoking the
      // callback, so narrowing back to this tool's concrete shape is sound.
      return await handler(args as ShapeOutput<Args>);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }] };
    }
  });
}

registerTool(
  "get_food_preferences",
  "Read the account owner's food and shopping preferences (markdown). Also delivered automatically as server instructions on connect.",
  {},
  async () => ({ content: [{ type: "text", text: (await env().DATA.get(PREFS_KEY)) ?? "No preferences set." }] })
);

registerTool(
  "set_food_preferences",
  "Replace the account owner's food and shopping preferences (markdown). Read them first with get_food_preferences and merge; this overwrites the whole document.",
  { content: z.string().min(1).max(20_000).describe("Full markdown document of preferences.") },
  async ({ content }) => {
    await env().DATA.put(PREFS_KEY, content);
    return { content: [{ type: "text", text: `Saved ${content.length} characters of preferences.` }] };
  }
);

registerTool(
  "sync_grocery_note",
  "Parse grocery-note content, compare it against the live Wegmans cart with normalized matching, and add only the missing items. Uses purchase-history preferences first, then search fallback.",
  {
    note_content: z.string().describe("Raw note content from Apple Notes or another grocery list source."),
    dry_run: z.boolean().optional().describe("When true, do not add anything; only report what would be added."),
    store_number: z.string().optional().describe("Wegmans store number (default: WEGMANS_STORE)"),
    fulfillment: z.enum(["instore", "pickup", "delivery"]).optional().describe("Fulfillment type (default: instore)"),
    my_items_limit: z.number().int().min(1).max(200).optional()
      .describe("How many purchase-history items to score before falling back to search (default: 75)"),
  },
  async ({ note_content, dry_run, store_number, fulfillment, my_items_limit }) => {
    const result = await syncGroceryNote({
      noteContent: note_content, dryRun: dry_run, storeNumber: store_number, fulfillment, myItemsLimit: my_items_limit,
    });
    const sections = [`Parsed ${result.parsedItems.length} grocery item(s).`];
    if (result.alreadyInCart.length > 0) sections.push(["Already in cart:",
      ...result.alreadyInCart.map((item) => `- ${item.item} -> ${item.matchedCartItems?.join("; ") ?? "matched cart item"}`)].join("\n"));
    if (result.added.length > 0) sections.push([dry_run ? "Would add:" : "Added:",
      ...result.added.map((item) => `- ${item.item} -> ${item.productName ?? item.productId ?? "unknown product"}`)].join("\n"));
    if (result.unresolved.length > 0) sections.push(["Unresolved:",
      ...result.unresolved.map((item) => `- ${item.item} -> ${item.reason}`)].join("\n"));
    return { content: [{ type: "text", text: sections.join("\n\n") }] };
  }
);

registerTool(
  "search_products",
  "Search for products at Wegmans. Returns product names, prices, aisle locations, and more.",
  {
    query: z.string().describe("Search term (e.g. 'bananas', 'organic milk', 'wegmans pizza')"),
    store_number: z.string().optional().describe("Wegmans store number (default: 133)"),
    fulfillment: z
      .enum(["instore", "delivery"])
      .optional()
      .describe("Fulfillment type: instore or delivery (default: instore)"),
    page: z.number().int().min(0).optional().describe("Page number for pagination (default: 0)"),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Max number of results to return (default: 10, max: 50)"),
  },
  async ({ query, store_number, fulfillment, page, max_results }) => {
    const response = await searchProducts({
      query,
      storeNumber: store_number,
      fulfillmentType: fulfillment,
      page,
      hitsPerPage: max_results ?? 10,
    });

    const result = response.results[0];
    if (!result || result.hits.length === 0) {
      return {
        content: [{ type: "text", text: `No products found for "${query}".` }],
      };
    }

    const header = `Found ${result.nbHits} products for "${result.query}" (showing ${result.hits.length}, page ${result.page + 1}/${result.nbPages})`;
    const products = result.hits.map((hit, i) => `### ${i + 1}. ${formatProduct(hit)}`).join("\n\n---\n\n");

    return {
      content: [{ type: "text", text: `${header}\n\n${products}` }],
    };
  }
);

registerTool(
  "get_product_details",
  "Get detailed information about a specific Wegmans product by its product ID.",
  {
    product_id: z.string().describe("The Wegmans product ID"),
    store_number: z.string().optional().describe("Wegmans store number (default: 133)"),
  },
  async ({ product_id, store_number }) => {
    const storeNum = store_number ?? env().WEGMANS_STORE;
    const product = await lookupProduct(product_id, storeNum);

    if (!product) {
      return {
        content: [{ type: "text", text: `Product ${product_id} not found at store ${storeNum}.` }],
      };
    }

    // Return the full raw product data for maximum detail
    return {
      content: [{ type: "text", text: JSON.stringify(product, null, 2) }],
    };
  }
);

registerTool(
  "browse_category",
  "Browse Wegmans products by category/department (e.g. 'Produce', 'Deli', 'Bakery').",
  {
    category: z
      .string()
      .describe(
        "Category to browse. Examples: 'Produce', 'Deli', 'Bakery', 'Dairy', 'Meat', 'Frozen', 'Beverages'"
      ),
    store_number: z.string().optional().describe("Wegmans store number (default: 133)"),
    page: z.number().int().min(0).optional().describe("Page number (default: 0)"),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Max results (default: 20)"),
  },
  async ({ category, store_number, page, max_results }) => {
    const response = await searchProducts({
      query: "",
      storeNumber: store_number,
      page,
      hitsPerPage: max_results ?? 20,
      category,
    });

    const result = response.results[0];
    if (!result || result.hits.length === 0) {
      return {
        content: [{ type: "text", text: `No products found in category "${category}".` }],
      };
    }

    const header = `Browsing "${category}" — ${result.nbHits} products (showing ${result.hits.length}, page ${result.page + 1}/${result.nbPages})`;
    const products = result.hits.map((hit, i) => `### ${i + 1}. ${formatProduct(hit)}`).join("\n\n---\n\n");

    return {
      content: [{ type: "text", text: `${header}\n\n${products}` }],
    };
  }
);

registerTool(
  "find_stores",
  "Find Wegmans store locations by name, city, state, or zip code. Returns store numbers, addresses, phone numbers, and available services.",
  {
    query: z
      .string()
      .describe("Search by city name, state abbreviation, zip code, or store name (e.g. 'Rochester', 'NY', '14618')"),
  },
  async ({ query }) => {
    const stores = await findStores(query);

    if (stores.length === 0) {
      return {
        content: [{ type: "text", text: `No Wegmans stores found matching "${query}".` }],
      };
    }

    const formatted = stores
      .map((s) => {
        const lines = [
          `**${s.name}, ${s.stateAbbreviation}** (Store #${s.storeNumber})`,
          `Address: ${s.streetAddress}, ${s.city}, ${s.stateAbbreviation} ${s.zip}`,
          `Phone: ${s.phoneNumber}`,
        ];
        const services: string[] = [];
        if (s.hasPharmacy) services.push("Pharmacy");
        if (s.hasPickup) services.push("Pickup");
        if (s.hasDelivery) services.push("Delivery");
        if (s.sellsAlcohol) services.push(`Alcohol (${s.alcoholTypesForSale?.join(", ")})`);
        if (services.length) lines.push(`Services: ${services.join(", ")}`);
        return lines.join("\n");
      })
      .join("\n\n---\n\n");

    return {
      content: [{ type: "text", text: `Found ${stores.length} store(s):\n\n${formatted}` }],
    };
  }
);

registerTool(
  "add_to_cart",
  "Add a product to your Wegmans shopping cart by product ID and quantity. Requires WEGMANS_EMAIL, WEGMANS_PASSWORD, and WEGMANS_CUSTOMER_ID env vars. Use search_products first to find product IDs.",
  {
    product_id: z.string().describe("The Wegmans product ID (from search results)"),
    quantity: z.number().int().min(1).default(1).describe("Quantity to add (default: 1)"),
    store_number: z.string().optional().describe("Wegmans store number (default: from WEGMANS_STORE env or 133)"),
    fulfillment: z
      .enum(["instore", "pickup", "delivery"])
      .optional()
      .describe("Fulfillment type (default: instore)"),
  },
  async ({ product_id, quantity, store_number, fulfillment }) => {
    const result = await addToCart(product_id, quantity, store_number, fulfillment);

    if (!result.success) {
      return {
        content: [{ type: "text", text: `Failed to add to cart: ${result.error}` }],
      };
    }

    const price = result.product.price_inStore
      ? `$${result.product.price_inStore.amount.toFixed(2)}`
      : "unknown price";

    return {
      content: [
        {
          type: "text",
          text: `Added to cart: ${quantity}x **${result.product.productName}** (${price} each)\nProduct ID: ${product_id}`,
        },
      ],
    };
  }
);

registerTool(
  "remove_from_cart",
  "Remove a product from your Wegmans shopping cart entirely by product ID. The cart is rewritten without that SKU (the API has no per-line delete). Use get_cart to find product IDs. Call sequentially, never in parallel with other cart writes.",
  {
    product_id: z.string().describe("The Wegmans product ID (from get_cart or search results)"),
    store_number: z.string().optional().describe("Wegmans store number (default: from WEGMANS_STORE env or 133)"),
    fulfillment: z
      .enum(["instore", "pickup", "delivery"])
      .optional()
      .describe("Fulfillment type (default: instore)"),
  },
  async ({ product_id, store_number, fulfillment }) => {
    const result = await removeFromCart(product_id, store_number, fulfillment);
    if (!result.success) {
      return { content: [{ type: "text", text: `Failed to remove from cart: ${result.error}` }] };
    }
    const text = result.removed
      ? `Removed product ${product_id} from cart. ${result.totalCartItems} line item(s) remain.`
      : `Product ${product_id} was not in the cart (${result.totalCartItems} line item(s), unchanged).`;
    return { content: [{ type: "text", text }] };
  }
);

registerTool(
  "get_my_items",
  "Get the user's frequently purchased Wegmans items, sorted by purchase frequency (most bought first). Great for building shopping lists based on past preferences.",
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Number of items to return (default: 25, max: 100)"),
    store_number: z.string().optional().describe("Wegmans store number (default: from WEGMANS_STORE env or 133)"),
  },
  async ({ limit, store_number }) => {
    const allItems = await loadMyItems();
    const count = limit ?? 25;
    const store = store_number ?? env().WEGMANS_STORE;

    const topItems = allItems.slice(0, count);
    if (topItems.length === 0) {
      return { content: [{ type: "text", text: "No purchase history found." }] };
    }
    const ids = topItems.map((i) => i.id);
    const scores = topItems.map((i) => i.score);

    const result = await queryProductsByIds(ids, store, scores);

    if (result.products.length === 0) {
      return {
        content: [{ type: "text", text: "No purchase history found." }],
      };
    }

    const header = `Your top ${result.products.length} most-purchased items (out of ${allItems.length} total):`;
    const items = result.products
      .map(
        (p, i) =>
          `${i + 1}. **${p.productName}** — ${p.price} (Aisle: ${p.aisle}) [ID: ${p.productId}]`
      )
      .join("\n");

    return {
      content: [{ type: "text", text: `${header}\n\n${items}` }],
    };
  }
);

/**
 * Format the cart GET response into a readable summary.
 * Falls back to raw JSON when the response doesn't match the expected shape,
 * so the tool stays useful if Wegmans changes the API.
 */
function formatCart(cart: CartResponse): string {
  const lineItems = cart.grocery?.lineItems;
  if (!Array.isArray(lineItems)) {
    return `Unexpected cart response shape; raw response:\n${JSON.stringify(cart, null, 2)}`;
  }

  if (lineItems.length === 0) {
    return "Your cart is empty.";
  }

  const wellFormed = lineItems.every(
    (li) =>
      typeof li?.name === "string" &&
      typeof li?.quantity === "number" &&
      typeof li?.price?.value?.centAmount === "number"
  );
  if (!wellFormed) {
    return `Unexpected line item shape; raw response:\n${JSON.stringify(cart, null, 2)}`;
  }

  let subtotalCents = 0;
  let itemCount = 0;
  const lines = lineItems.map((li, i) => {
    const unitCents = li.price.value.centAmount;
    const lineTotalCents = li.totalPrice?.centAmount ?? unitCents * li.quantity;
    subtotalCents += lineTotalCents;
    itemCount += li.quantity;
    return `${i + 1}. **${li.name}** — ${li.quantity} x $${(unitCents / 100).toFixed(2)} = $${(lineTotalCents / 100).toFixed(2)} [ID: ${li.variant?.sku ?? "?"}]`;
  });

  return [
    `Cart: ${lineItems.length} line item(s), ${itemCount} total item(s)`,
    "",
    ...lines,
    "",
    `Subtotal: $${(subtotalCents / 100).toFixed(2)}`,
  ].join("\n");
}

registerTool(
  "get_cart",
  "Get the current contents of your Wegmans shopping cart.",
  {},
  async () => {
    const cart = await getCart();
    return {
      content: [{ type: "text", text: formatCart(cart) }],
    };
  }
);

// ─── Purchase Intelligence Tools ───

registerTool(
  "sync_purchase_history",
  "Fetch your complete Wegmans purchase history from in-store receipts, online orders, and purchase rankings. Merges all sources into a local timeline and computes purchase patterns. Run this first to get data, then use get_purchase_patterns or get_shopping_suggestions to analyze.",
  {},
  async () => {
    const stats = await syncPurchaseHistory();
    const lines = [
      `Purchase history synced successfully:`,
      `- ${stats.receiptsCount} in-store receipts (${stats.receiptItemsCount} line items)`,
      `- ${stats.ordersCount} online orders (${stats.orderItemsCount} line items)`,
      `- ${stats.totalEvents} total purchase events`,
      `- ${stats.uniqueProducts} unique products tracked`,
    ];
    if (stats.orderDetailFailures > 0) {
      lines.push(
        `- WARNING: ${stats.orderDetailFailures} order(s) could not be fetched and were dropped from this sync`
      );
    }
    lines.push(
      ``,
      `Use get_purchase_patterns, get_shopping_suggestions, or get_product_history to analyze.`
    );
    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  }
);

registerTool(
  "get_purchase_patterns",
  "Analyze your purchase patterns. Shows how often you buy each item, when you last bought it, and when you'll likely need it again. Useful for 'when did I last buy milk?' or 'how often do I buy eggs?'. Requires sync_purchase_history to have been run first.",
  {
    product_name: z
      .string()
      .optional()
      .describe("Filter by product name (partial match, case-insensitive)"),
    department: z
      .string()
      .optional()
      .describe("Filter by department (e.g. 'Dairy', 'Produce')"),
    urgency: z
      .enum(["overdue", "due_soon", "upcoming", "all"])
      .optional()
      .describe("Filter by urgency (default: all)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Max results (default: 25)"),
  },
  async ({ product_name, department, urgency, limit }) => {
    const history = await loadPurchaseHistory();
    if (!history.lastSyncedAt) {
      return {
        content: [
          {
            type: "text",
            text: "No purchase history found. Run sync_purchase_history first.",
          },
        ],
      };
    }

    let products = Object.values(history.products);

    // Filter by name
    if (product_name) {
      const q = product_name.toLowerCase();
      products = products.filter((p) =>
        p.productName.toLowerCase().includes(q)
      );
    }

    // Filter by department
    if (department) {
      const q = department.toLowerCase();
      products = products.filter((p) =>
        p.department.toLowerCase().includes(q)
      );
    }

    // Filter by urgency
    if (urgency && urgency !== "all") {
      products = products.filter((p) => {
        const { urgency: u } = classifyUrgency(p);
        return u === urgency;
      });
    }

    // Sort by rank descending (most purchased first), then by last purchase
    products.sort((a, b) => b.rank - a.rank);

    const count = limit ?? 25;
    const shown = products.slice(0, count);

    if (shown.length === 0) {
      return {
        content: [{ type: "text", text: "No matching products found." }],
      };
    }

    const urgencyIcon: Record<string, string> = {
      overdue: "!!",
      due_soon: "!",
      upcoming: "~",
      not_due: "-",
      unknown: "?",
    };

    const lines = shown.map((p, i) => {
      const { urgency: u, daysSince, daysUntil } = classifyUrgency(p);
      const interval = p.medianIntervalDays
        ? `Every ~${Math.round(p.medianIntervalDays)} days`
        : "Unknown interval";
      const lastStr = p.lastPurchasedDate
        ? `Last: ${daysSince}d ago`
        : "Never";
      const nextStr =
        daysUntil !== null
          ? daysUntil < 0
            ? `${Math.abs(daysUntil)}d overdue`
            : daysUntil === 0
              ? "Due today"
              : `Due in ${daysUntil}d`
          : "";
      return `${i + 1}. [${urgencyIcon[u]}] **${p.productName}** (${p.department})\n   ${p.purchaseDates.length} purchases | ${interval} | ${lastStr} | ${nextStr} [ID: ${p.productId}]`;
    });

    const syncAge = Math.round(
      (Date.now() - new Date(history.lastSyncedAt).getTime()) / 60000
    );
    const header = `Purchase patterns (${shown.length} of ${products.length} products) | Synced ${syncAge < 60 ? `${syncAge}m ago` : `${Math.round(syncAge / 60)}h ago`}\n\nLegend: !! = overdue, ! = due soon, ~ = upcoming, - = not due, ? = unknown\n`;

    return {
      content: [{ type: "text", text: header + "\n" + lines.join("\n\n") }],
    };
  }
);

registerTool(
  "get_shopping_suggestions",
  "Generate a smart shopping list based on your purchase patterns. Returns items you're likely to need soon, sorted by urgency. Great for 'what do I need this week?' or 'build me a shopping list'. Requires sync_purchase_history to have been run first.",
  {
    lookahead_days: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .describe("How many days ahead to look (default: 7)"),
    max_items: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Max suggestions (default: 20)"),
  },
  async ({ lookahead_days, max_items }) => {
    const history = await loadPurchaseHistory();
    if (!history.lastSyncedAt) {
      return {
        content: [
          {
            type: "text",
            text: "No purchase history found. Run sync_purchase_history first.",
          },
        ],
      };
    }

    const suggestions = generateShoppingList(history.products, {
      lookaheadDays: lookahead_days ?? 7,
      maxItems: max_items ?? 20,
      includeOverdue: true,
    });

    if (suggestions.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No items predicted to be needed in the next ${lookahead_days ?? 7} days.`,
          },
        ],
      };
    }

    const urgencyIcon: Record<string, string> = {
      overdue: "!!",
      due_soon: "!",
      upcoming: "~",
      not_due: "-",
      unknown: "?",
    };

    const lines = suggestions.map(
      (s, i) =>
        `${i + 1}. [${urgencyIcon[s.urgency]}] **${s.productName}** (${s.department}) [ID: ${s.productId}]\n   ${s.reason}`
    );

    const syncAge = Math.round(
      (Date.now() - new Date(history.lastSyncedAt).getTime()) / 60000
    );
    const header = `Suggested shopping list (next ${lookahead_days ?? 7} days) | ${suggestions.length} items | Synced ${syncAge < 60 ? `${syncAge}m ago` : `${Math.round(syncAge / 60)}h ago`}`;

    return {
      content: [{ type: "text", text: header + "\n\n" + lines.join("\n\n") }],
    };
  }
);

registerTool(
  "get_product_history",
  "Get the complete purchase timeline for a specific product. Shows every time you bought it with dates, quantities, prices. Plus computed pattern summary. Useful for 'show me my milk purchases' or 'how much do I spend on eggs?'.",
  {
    product_id: z.string().describe("Wegmans product ID"),
  },
  async ({ product_id }) => {
    const history = await loadPurchaseHistory();
    if (!history.lastSyncedAt) {
      return {
        content: [
          {
            type: "text",
            text: "No purchase history found. Run sync_purchase_history first.",
          },
        ],
      };
    }

    const product = history.products[product_id];
    if (!product) {
      return {
        content: [
          {
            type: "text",
            text: `Product ${product_id} not found in purchase history.`,
          },
        ],
      };
    }

    // Get events for this product
    const events = history.events
      .filter((e) => e.productId === product_id)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp)); // newest first

    const insight = getProductInsight(product);

    const totalSpent = events.reduce(
      (s, e) => s + e.unitPrice * e.quantity,
      0
    );
    const avgPrice =
      events.length > 0 ? totalSpent / events.length : 0;

    const header = [
      `## ${product.productName} (ID: ${product_id})`,
      ``,
      insight,
      ``,
      `**Summary**: ${product.purchaseDates.length} purchases | Total spent: $${totalSpent.toFixed(2)} | Avg per trip: $${avgPrice.toFixed(2)}`,
    ].join("\n");

    const timeline = events
      .map((e) => {
        const date = e.timestamp.slice(0, 10);
        const price = `$${(e.unitPrice * e.quantity).toFixed(2)}`;
        return `| ${date} | ${e.quantity} | ${price} | ${e.source} | ${e.storeNumber || "-"} |`;
      })
      .join("\n");

    const table = events.length > 0
      ? `\n### Timeline\n| Date | Qty | Price | Source | Store |\n|------|-----|-------|--------|-------|\n${timeline}`
      : "\n*No individual purchase events found — last purchase date from My Items API only.*";

    return {
      content: [{ type: "text", text: header + table }],
    };
  }
);

return server;
}
