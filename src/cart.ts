import { lookupProduct, type AlgoliaProduct } from "./algolia.js";
import { getAccessToken } from "./tokens.js";
import { env } from "./env.js";

// Re-exported for existing consumers of dist/cart.js (see CLAUDE.md); the
// implementation lives in algolia.ts because it is an Algolia query.
export { lookupProduct };

const CART_API =
  "https://api.digitaldevelopment.wegmans.cloud/commerce/cart/carts/lineitems?api-version=2024-02-19-preview";
const CART_GET_API =
  "https://api.digitaldevelopment.wegmans.cloud/commerce/cart/carts?api-version=2024-02-19-preview";

interface CartLineItem {
  custom: Array<{ name: string; value: unknown }>;
  distributionChannelKey: string;
  isAlcoholic: boolean;
  isSoldByWeight: boolean;
  onlineApproxUnitWeight: number;
  onlineSellByUnit: string;
  quantity: number;
  sku: string;
  standalonePrice: number;
}

interface CartRequest {
  StoreKey: string;
  cartData: Array<{
    custom: Array<{ name: string; value: string }>;
    isAlcoholic: boolean;
    lineItems: CartLineItem[];
  }>;
  customerEmail: string;
  customerID: string;
}

export interface ExistingLineItem {
  productKey?: string;
  variant: {
    sku: string;
    attributesRaw?: Array<{ name: string; value: unknown }>;
  };
  name: string;
  quantity: number;
  price: { value: { centAmount: number } };
  totalPrice?: { centAmount: number };
  custom?: {
    customFieldsRaw?: Array<{ name: string; value: unknown }>;
  };
}

export interface CartResponse {
  grocery?: {
    lineItems: ExistingLineItem[];
    custom?: {
      customFieldsRaw?: Array<{ name: string; value: unknown }>;
    };
  };
}

export async function getCart(): Promise<CartResponse> {
  const accessToken = await getAccessToken();
  const res = await fetch(CART_GET_API, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      origin: "https://www.wegmans.com",
      referer: "https://www.wegmans.com/",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch cart: ${res.status} ${text}`);
  }

  return (await res.json()) as CartResponse;
}

function channelSuffixFor(fulfillmentType: string): string {
  return fulfillmentType === "instore"
    ? "Instore"
    : fulfillmentType === "delivery"
      ? "Delivery"
      : "Pickup";
}

function findField(
  fields: Array<{ name: string; value: unknown }> | undefined,
  name: string
): unknown {
  return fields?.find((f) => f.name === name)?.value;
}

/**
 * Fetch the current cart and convert existing line items to the POST format
 * so we can preserve them when adding new items.
 *
 * Existing items must keep the cart's own store/fulfillment channel and their
 * own per-item attributes — never the new call's arguments — otherwise adding
 * one item silently rewrites the whole cart (e.g. flips a delivery cart to
 * instore). The cart GET carries cart-level `storeNumber`/`fulfillmentType` in
 * grocery.custom.customFieldsRaw, and per-item `isSoldByWeight`,
 * `onlineSellByUnit`, `onlineApproxUnitWeight`, and `isAlcoholItem` in
 * variant.attributesRaw.
 */
async function getCurrentCartLineItems(
  fallbackStoreNumber: string,
  fallbackFulfillmentType: string
): Promise<CartLineItem[]> {
  const data = await getCart();
  const lineItems = data.grocery?.lineItems ?? [];

  // Cart-level store/fulfillment from the GET response; fall back to the new
  // call's values only if the cart doesn't carry them.
  const cartFields = data.grocery?.custom?.customFieldsRaw;
  const cartStore =
    (findField(cartFields, "storeNumber") as string | undefined) ?? fallbackStoreNumber;
  const cartFulfillment =
    (findField(cartFields, "fulfillmentType") as string | undefined) ?? fallbackFulfillmentType;

  return lineItems.map((li) => {
    // The line item's custom fields from the GET response are already in the
    // POST format (planogram, category, upc, ...), so pass them through.
    const customFields: Array<{ name: string; value: unknown }> =
      li.custom?.customFieldsRaw ?? [];
    const attrs = li.variant.attributesRaw;

    return {
      custom: customFields,
      // The GET response carries no per-item distribution channel, so derive
      // it from the cart-level store/fulfillment rather than the new call's.
      distributionChannelKey: `${cartStore}-${channelSuffixFor(cartFulfillment)}`,
      isAlcoholic: (findField(attrs, "isAlcoholItem") as boolean | undefined) ?? false,
      isSoldByWeight: (findField(attrs, "isSoldByWeight") as boolean | undefined) ?? false,
      // Only present in the GET response for sold-by-weight items; 0 matches
      // what the website sends for everything else.
      onlineApproxUnitWeight:
        (findField(attrs, "onlineApproxUnitWeight") as number | undefined) ?? 0,
      onlineSellByUnit: (findField(attrs, "onlineSellByUnit") as string | undefined) ?? "ea",
      quantity: li.quantity,
      sku: li.variant.sku,
      standalonePrice: li.price.value.centAmount,
    };
  });
}

function buildCartLineItem(
  product: AlgoliaProduct,
  quantity: number,
  storeNumber: string,
  fulfillmentType: string
): CartLineItem {
  const priceInCents = product.price_inStore
    ? Math.round(product.price_inStore.amount * 100)
    : 0;

  const categoryName = product.category?.[0]?.name ?? "Unknown";
  const categoryId = product.category?.[0]?.key ?? "";

  const upcValue = Array.isArray(product.upc) ? product.upc : product.upc ? [product.upc] : [];
  const fulfillmentTypes = product.fulfilmentType ?? ["instore", "pickup", "delivery"];

  return {
    custom: [
      { name: "category", value: categoryName },
      { name: "categoryId", value: categoryId },
      { name: "itemLevelAdjustments", value: "[]" },
      { name: "isSoldAtStore", value: true },
      { name: "ebtEligible", value: product.ebtEligible ?? true },
      { name: "isAvailable", value: true },
      {
        name: "planogram",
        value: JSON.stringify(product.planogram ?? {}),
      },
      { name: "note", value: "" },
      { name: "bottleDeposit", value: product.bottleDeposit ?? 0 },
      { name: "upc", value: upcValue },
      {
        name: "fulfillmentTypes",
        value: fulfillmentTypes,
      },
      { name: "maxQuantity", value: "20" },
    ],
    distributionChannelKey: `${storeNumber}-${channelSuffixFor(fulfillmentType)}`,
    isAlcoholic: false,
    isSoldByWeight: product.isSoldByWeight ?? false,
    onlineApproxUnitWeight: product.onlineApproxUnitWeight ?? 0,
    onlineSellByUnit: product.onlineSellByUnit ?? "ea",
    quantity,
    sku: product.productId,
    standalonePrice: priceInCents,
  };
}

export interface AddToCartResult {
  success: boolean;
  product: AlgoliaProduct;
  quantity: number;
  totalCartItems?: number;
  response?: unknown;
  error?: string;
}

export interface RemoveFromCartResult {
  success: boolean;
  productId: string;
  removed: boolean;
  totalCartItems?: number;
  response?: unknown;
  error?: string;
}

interface CartWriteContext {
  store: string;
  fulfillment: string;
  storeKey: string;
  accessToken: string;
  customerEmail: string;
  customerID: string;
}

async function resolveCartWriteContext(
  storeNumber?: string,
  fulfillmentType?: string
): Promise<CartWriteContext> {
  const customerEmail = env().WEGMANS_EMAIL;
  if (!customerEmail) throw new Error("Missing required env var: WEGMANS_EMAIL");
  const customerID = env().WEGMANS_CUSTOMER_ID;
  if (!customerID) throw new Error("Missing required env var: WEGMANS_CUSTOMER_ID");
  const store = storeNumber ?? env().WEGMANS_STORE;
  const fulfillment = fulfillmentType ?? "instore";
  const accessToken = await getAccessToken();
  const storeKey = await getStoreKey(store);
  return { store, fulfillment, storeKey, accessToken, customerEmail, customerID };
}

/**
 * POST the full set of line items back to the cart API. Callers own the merge
 * (add) or filter (remove); this only serializes and submits, so the whole-cart
 * write stays in one place. Returns the parsed response on success, or an error
 * string the caller surfaces in its own result shape.
 */
async function submitCart(
  ctx: CartWriteContext,
  lineItems: CartLineItem[]
): Promise<{ ok: true; response: unknown } | { ok: false; error: string }> {
  const cartRequest: CartRequest = {
    StoreKey: ctx.storeKey,
    cartData: [
      {
        custom: [
          { name: "orderLevelAdjustments", value: "[]" },
          { name: "storeNumber", value: ctx.store },
          { name: "fulfillmentType", value: ctx.fulfillment },
        ],
        isAlcoholic: false,
        lineItems,
      },
    ],
    customerEmail: ctx.customerEmail,
    customerID: ctx.customerID,
  };

  const res = await fetch(CART_API, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      authorization: `Bearer ${ctx.accessToken}`,
      origin: "https://www.wegmans.com",
      referer: "https://www.wegmans.com/",
    },
    body: JSON.stringify(cartRequest),
  });

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: `Cart API error ${res.status}: ${text}` };
  }

  return { ok: true, response: await res.json() };
}

export async function addToCart(
  productId: string,
  quantity: number,
  storeNumber?: string,
  fulfillmentType?: string
): Promise<AddToCartResult> {
  const ctx = await resolveCartWriteContext(storeNumber, fulfillmentType);

  // Look up the product to get full details
  const product = await lookupProduct(productId, ctx.store);
  if (!product) {
    return {
      success: false,
      product: { productId, productName: "Unknown" } as AlgoliaProduct,
      quantity,
      error: `Product ${productId} not found at store ${ctx.store}`,
    };
  }

  // Fetch existing cart items so we don't blow them away. This throws on any
  // read failure — a cart write must never proceed on partial information.
  const existingItems = await getCurrentCartLineItems(ctx.store, ctx.fulfillment);

  // Merge: if the product already exists in cart, update its quantity; otherwise append
  const newItem = buildCartLineItem(product, quantity, ctx.store, ctx.fulfillment);
  let merged = false;
  const mergedItems = existingItems.map((item) => {
    if (item.sku === newItem.sku) {
      merged = true;
      return { ...item, quantity: item.quantity + quantity, custom: newItem.custom };
    }
    return item;
  });
  if (!merged) {
    mergedItems.push(newItem);
  }

  const result = await submitCart(ctx, mergedItems);
  if (!result.ok) {
    return { success: false, product, quantity, error: result.error };
  }

  return {
    success: true,
    product,
    quantity,
    totalCartItems: mergedItems.length,
    response: result.response,
  };
}

/**
 * Drop a product from the cart entirely (the cart API has no per-line delete —
 * the whole cart is rewritten without the target SKU). No-op success if the SKU
 * isn't present, so callers can remove idempotently.
 */
export async function removeFromCart(
  productId: string,
  storeNumber?: string,
  fulfillmentType?: string
): Promise<RemoveFromCartResult> {
  const ctx = await resolveCartWriteContext(storeNumber, fulfillmentType);

  // Throws on any read failure — never write the cart on partial information.
  const existingItems = await getCurrentCartLineItems(ctx.store, ctx.fulfillment);
  const remainingItems = existingItems.filter((item) => item.sku !== productId);

  if (remainingItems.length === existingItems.length) {
    return {
      success: true,
      productId,
      removed: false,
      totalCartItems: existingItems.length,
    };
  }

  const result = await submitCart(ctx, remainingItems);
  if (!result.ok) {
    return { success: false, productId, removed: false, error: result.error };
  }

  return {
    success: true,
    productId,
    removed: true,
    totalCartItems: remainingItems.length,
    response: result.response,
  };
}

let storeKeyCache: Map<string, string> = new Map();

async function getStoreKey(storeNumber: string): Promise<string> {
  const cached = storeKeyCache.get(storeNumber);
  if (cached) return cached;

  const res = await fetch("https://www.wegmans.com/api/stores");
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch store list: ${res.status} ${text}`);
  }

  const stores = (await res.json()) as Array<{
    storeNumber: number;
    key: string;
  }>;
  for (const s of stores) {
    storeKeyCache.set(String(s.storeNumber), s.key);
  }

  const key = storeKeyCache.get(storeNumber);
  if (!key) {
    throw new Error(`Store ${storeNumber} not found in Wegmans store list`);
  }
  return key;
}
