import { searchProducts, type AlgoliaProduct } from "./algolia.js";
import { addToCart, getCart, type ExistingLineItem } from "./cart.js";
import { queryProductsByIds } from "./my-items.js";
import { loadPurchaseHistory } from "./purchase-history.js";
import { env } from "./env.js";

const GENERIC_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "baked",
  "fresh",
  "for",
  "from",
  "in",
  "instore",
  "item",
  "items",
  "of",
  "pack",
  "pk",
  "store",
  "the",
  "to",
  "wegmans",
]);

export interface GrocerySyncItemResult {
  item: string;
  status: "already_in_cart" | "added" | "no_match";
  reason: string;
  productId?: string;
  productName?: string;
  quantityAdded?: number;
  matchedCartItems?: string[];
}

export interface GrocerySyncResult {
  parsedItems: string[];
  added: GrocerySyncItemResult[];
  alreadyInCart: GrocerySyncItemResult[];
  unresolved: GrocerySyncItemResult[];
}

interface NoteItemDescriptor {
  raw: string;
  normalized: string;
  tokens: string[];
  packCount?: number;
}

function normalizeText(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/coca-cola/g, "coca cola")
    .replace(/\bcoke\b/g, "coca cola")
    .replace(/12pk/g, "12 pack")
    .replace(/(\d+)\s*pk\b/g, "$1 pack")
    .replace(/(\d+)\s*ct\b/g, "$1 count")
    .replace(/parmigiano reggiano/g, "parmesan")
    .replace(/parmesan cheese/g, "parmesan")
    .replace(/bagels\b/g, "bagel")
    .replace(/strawberries\b/g, "strawberry")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function singularizeToken(token: string): string {
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("s") && token.length > 3 && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function tokenizeMeaningful(text: string): string[] {
  return Array.from(
    new Set(
      normalizeText(text)
        .split(" ")
        .map((token) => singularizeToken(token))
        .filter((token) => token.length > 1 && !GENERIC_STOPWORDS.has(token))
    )
  );
}

function extractPackCount(text: string): number | undefined {
  const normalized = normalizeText(text);
  const direct = normalized.match(/\b(\d+)\s+(?:pack|count)\b/);
  if (direct) return Number(direct[1]);
  const multipack = normalized.match(/\b(\d+)\s+x\b/);
  if (multipack) return Number(multipack[1]);
  return undefined;
}

function parseNoteItems(noteContent: string): string[] {
  const lines = noteContent.split(/\r?\n/);
  let inItemsSection = false;
  const explicitItems: string[] = [];
  const fallbackItems: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const cleanedHeader = trimmed.replace(/\*/g, "").trim().toLowerCase();

    if (!trimmed) continue;

    if (cleanedHeader === "items") {
      inItemsSection = true;
      continue;
    }

    if (trimmed.startsWith("**") && trimmed.endsWith("**")) {
      inItemsSection = false;
      continue;
    }

    const bulletMatch = trimmed.match(/^[*-]\s*(?:\[[ xX]\]\s*)?(.*)$/);
    if (!bulletMatch) continue;

    const value = bulletMatch[1]?.trim();
    if (!value) continue;

    if (inItemsSection) {
      explicitItems.push(value);
    } else {
      fallbackItems.push(value);
    }
  }

  const items = explicitItems.length > 0 ? explicitItems : fallbackItems;
  return items.filter((item) => normalizeText(item).length > 0);
}

function buildNoteDescriptor(item: string): NoteItemDescriptor {
  return {
    raw: item,
    normalized: normalizeText(item),
    tokens: tokenizeMeaningful(item),
    packCount: extractPackCount(item),
  };
}

function getAttributeValue(
  fields: Array<{ name: string; value: unknown }> | undefined,
  name: string
): unknown {
  return fields?.find((field) => field.name === name)?.value;
}

function stringifyUnknown(value: unknown): string {
  if (Array.isArray(value)) return value.map((entry) => stringifyUnknown(entry)).join(" ");
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function buildCartItemCorpus(item: ExistingLineItem): string {
  const variantFields = item.variant.attributesRaw ?? [];
  const customFields = item.custom?.customFieldsRaw ?? [];
  const parts = [
    item.name,
    item.productKey ?? item.variant.sku,
    stringifyUnknown(getAttributeValue(variantFields, "consumerBrandName")),
    stringifyUnknown(getAttributeValue(variantFields, "webProductDescription")),
    stringifyUnknown(getAttributeValue(variantFields, "packSize")),
    stringifyUnknown(getAttributeValue(variantFields, "productKeywords")),
    stringifyUnknown(getAttributeValue(customFields, "category")),
    stringifyUnknown(getAttributeValue(customFields, "note")),
  ];
  return parts.filter(Boolean).join(" ");
}

function buildProductCorpus(product: AlgoliaProduct): string {
  const parts = [
    product.productName,
    product.brand ?? "",
    product.size ?? "",
    product.category?.map((entry) => entry.name).join(" ") ?? "",
    product.categories?.lvl0 ?? "",
    product.categories?.lvl1 ?? "",
    product.categories?.lvl2 ?? "",
  ];
  return parts.filter(Boolean).join(" ");
}

function scoreCandidate(note: NoteItemDescriptor, corpus: string): number {
  const normalizedCorpus = normalizeText(corpus);
  if (!normalizedCorpus) return 0;

  const corpusTokens = new Set(tokenizeMeaningful(corpus));
  let score = 0;
  let matchedTokens = 0;

  if (normalizedCorpus.includes(note.normalized)) {
    score += 8;
  }

  for (const token of note.tokens) {
    if (corpusTokens.has(token)) {
      matchedTokens += 1;
      score += 3;
    }
  }

  if (note.packCount !== undefined) {
    const corpusPackCount = extractPackCount(corpus);
    if (corpusPackCount === note.packCount) {
      score += 4;
    } else {
      score -= 6;
    }
  }

  if (note.tokens.length > 1 && matchedTokens === note.tokens.length) {
    score += 4;
  }

  if (note.tokens.length > 0 && matchedTokens === 0) {
    score -= 4;
  }

  return score;
}

function isCartEquivalent(note: NoteItemDescriptor, cartItem: ExistingLineItem): boolean {
  const corpus = buildCartItemCorpus(cartItem);
  const score = scoreCandidate(note, corpus);
  if (score < 6) return false;

  const corpusTokens = new Set(tokenizeMeaningful(corpus));
  const matchedTokens = note.tokens.filter((token) => corpusTokens.has(token)).length;
  const requiredMatches = note.tokens.length <= 1 ? 1 : Math.max(2, note.tokens.length - 1);
  return matchedTokens >= requiredMatches;
}

async function findPreferredProduct(
  note: NoteItemDescriptor,
  storeNumber: string,
  myItemsLimit: number
): Promise<AlgoliaProduct | null> {
  const history = await loadPurchaseHistory();
  const myItems = Object.values(history.products)
    .sort((a, b) => (a.rank || Infinity) - (b.rank || Infinity))
    .slice(0, myItemsLimit)
    .map((item) => ({ id: item.productId, score: item.totalPurchaseCount }));
  if (myItems.length > 0) {
    const preferred = await queryProductsByIds(
      myItems.map((entry) => entry.id),
      storeNumber,
      myItems.map((entry) => entry.score)
    );

    const bestHistoryMatch = preferred.products
      .map((product) => ({
        product,
        score: scoreCandidate(note, product.productName),
      }))
      .sort((a, b) => b.score - a.score)[0];

    if (bestHistoryMatch && bestHistoryMatch.score >= 6) {
      return {
        productId: bestHistoryMatch.product.productId,
        productName: bestHistoryMatch.product.productName,
        objectID: `${storeNumber}-${bestHistoryMatch.product.productId}`,
      };
    }
  }

  const search = await searchProducts({
    query: note.raw.replace(/\s*-\s*/g, " "),
    storeNumber,
    hitsPerPage: 8,
  });

  const hits = search.results[0]?.hits ?? [];
  const bestSearchMatch = hits
    .map((product) => ({ product, score: scoreCandidate(note, buildProductCorpus(product)) }))
    .sort((a, b) => b.score - a.score)[0];

  if (!bestSearchMatch || bestSearchMatch.score < 4) {
    return hits[0] ?? null;
  }

  return bestSearchMatch.product;
}

export async function syncGroceryNote(params: {
  noteContent: string;
  dryRun?: boolean;
  storeNumber?: string;
  fulfillment?: "instore" | "pickup" | "delivery";
  myItemsLimit?: number;
}): Promise<GrocerySyncResult> {
  const parsedItems = parseNoteItems(params.noteContent);
  const descriptors = parsedItems.map((item) => buildNoteDescriptor(item));
  const cart = await getCart();
  const cartItems = cart.grocery?.lineItems ?? [];
  const storeNumber = params.storeNumber ?? env().WEGMANS_STORE;
  const fulfillment = params.fulfillment ?? "instore";
  const myItemsLimit = params.myItemsLimit ?? 75;

  const added: GrocerySyncItemResult[] = [];
  const alreadyInCart: GrocerySyncItemResult[] = [];
  const unresolved: GrocerySyncItemResult[] = [];

  for (const note of descriptors) {
    const matches = cartItems.filter((item) => isCartEquivalent(note, item));
    if (matches.length > 0) {
      alreadyInCart.push({
        item: note.raw,
        status: "already_in_cart",
        reason: "Equivalent item already present in cart",
        matchedCartItems: matches.map((item) => `${item.name} (qty: ${item.quantity})`),
      });
      continue;
    }

    const preferredProduct = await findPreferredProduct(note, storeNumber, myItemsLimit);
    if (!preferredProduct) {
      unresolved.push({
        item: note.raw,
        status: "no_match",
        reason: "No obvious preferred product or search match found",
      });
      continue;
    }

    if (params.dryRun) {
      added.push({
        item: note.raw,
        status: "added",
        reason: "Would add missing item",
        productId: preferredProduct.productId,
        productName: preferredProduct.productName,
        quantityAdded: 1,
      });
      continue;
    }

    const addResult = await addToCart(preferredProduct.productId, 1, storeNumber, fulfillment);
    if (!addResult.success) {
      unresolved.push({
        item: note.raw,
        status: "no_match",
        reason: addResult.error ?? "Failed to add matched product to cart",
        productId: preferredProduct.productId,
        productName: preferredProduct.productName,
      });
      continue;
    }

    added.push({
      item: note.raw,
      status: "added",
      reason: "Added missing item to cart",
      productId: preferredProduct.productId,
      productName: addResult.product.productName,
      quantityAdded: 1,
    });
  }

  return { parsedItems, added, alreadyInCart, unresolved };
}
