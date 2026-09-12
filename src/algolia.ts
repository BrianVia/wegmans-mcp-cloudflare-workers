import { env } from "./env.js";
const ALGOLIA_APP_ID = "QGPPR19V8V";
const ALGOLIA_API_KEY = "9a10b1401634e9a6e55161c3a60c200d";
const ALGOLIA_URL = `https://${ALGOLIA_APP_ID.toLowerCase()}-dsn.algolia.net/1/indexes/*/queries?x-algolia-api-key=${ALGOLIA_API_KEY}&x-algolia-application-id=${ALGOLIA_APP_ID}`;

/**
 * POST a batch of queries to the Wegmans Algolia index.
 * Single home for the Algolia credentials/URL — do not duplicate them elsewhere.
 */
export async function algoliaQuery<T>(requests: unknown[]): Promise<T> {
  const res = await fetch(ALGOLIA_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ requests }),
  });

  if (!res.ok) {
    throw new Error(`Algolia query failed: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<T>;
}

export interface AlgoliaProduct {
  productId: string;
  productName: string;
  price_inStore?: { amount: number; unitPrice?: string };
  price_delivery?: { amount: number; unitPrice?: string };
  images?: string[];
  category?: Array<{ name: string; key: string; seo: string }>;
  categoryPageId?: string[];
  planogram?: { aisle?: string };
  filterTags?: string[];
  isSoldByWeight?: boolean;
  onlineSellByUnit?: string;
  onlineApproxUnitWeight?: number;
  allergensAndWarnings?: string;
  digitalCouponsOfferIds?: string[];
  storeNumber?: string;
  bottleDeposit?: number;
  objectID: string;
  brand?: string;
  size?: string;
  upc?: string | string[];
  rating?: number;
  reviewCount?: number;
  ebtEligible?: boolean;
  fulfilmentType?: string[];
  categories?: { lvl0?: string; lvl1?: string; lvl2?: string };
}

interface AlgoliaResponse {
  results: Array<{
    hits: AlgoliaProduct[];
    nbHits: number;
    page: number;
    nbPages: number;
    hitsPerPage: number;
    processingTimeMS: number;
    query: string;
    index: string;
  }>;
}

export interface SearchOptions {
  query: string;
  storeNumber?: string;
  fulfillmentType?: "instore" | "delivery";
  page?: number;
  hitsPerPage?: number;
  category?: string;
}

export async function searchProducts(options: SearchOptions): Promise<AlgoliaResponse> {
  const {
    query,
    storeNumber = env().WEGMANS_STORE,
    fulfillmentType = "instore",
    page = 0,
    hitsPerPage = 20,
    category,
  } = options;

  let filters = `storeNumber:${storeNumber} AND fulfilmentType:${fulfillmentType} AND excludeFromWeb:false AND isSoldAtStore:true`;
  if (category) {
    filters += ` AND categoryPageId:"${category}"`;
  }

  const body = {
    requests: [
      {
        indexName: "products",
        analytics: true,
        analyticsTags: [
          "product-search",
          "organic",
          `store-${storeNumber}`,
          `fulfillment-${fulfillmentType}`,
        ],
        attributesToHighlight: [],
        clickAnalytics: true,
        enableRules: true,
        facets: ["*"],
        filters,
        getRankingInfo: false,
        highlightPostTag: "__/ais-highlight__",
        highlightPreTag: "__ais-highlight__",
        maxValuesPerFacet: 100,
        page,
        hitsPerPage,
        query,
        responseFields: [
          "hits",
          "facets",
          "hitsPerPage",
          "nbHits",
          "nbPages",
          "page",
          "processingTimeMS",
          "query",
        ],
      },
    ],
  };

  return algoliaQuery<AlgoliaResponse>(body.requests);
}

/**
 * Look up a single product by ID at a given store.
 * Returns null when the product doesn't exist at that store;
 * throws when the Algolia request itself fails.
 */
export async function lookupProduct(
  productId: string,
  storeNumber: string
): Promise<AlgoliaProduct | null> {
  const data = await algoliaQuery<{ results: Array<{ hits: AlgoliaProduct[] }> }>([
    {
      indexName: "products",
      filters: `objectID:${storeNumber}-${productId}`,
      hitsPerPage: 1,
      attributesToHighlight: [],
    },
  ]);

  return data.results[0]?.hits[0] ?? null;
}

export function formatProduct(hit: AlgoliaProduct): string {
  const lines: string[] = [];

  lines.push(`**${hit.productName}**`);

  if (hit.brand) lines.push(`Brand: ${hit.brand}`);
  if (hit.size) lines.push(`Size: ${hit.size}`);

  // Price
  if (hit.price_inStore) {
    const price = `$${hit.price_inStore.amount.toFixed(2)}`;
    const unit = hit.price_inStore.unitPrice ? ` (${hit.price_inStore.unitPrice})` : "";
    lines.push(`In-store price: ${price}${unit}`);
  }
  if (hit.price_delivery) {
    const price = `$${hit.price_delivery.amount.toFixed(2)}`;
    const unit = hit.price_delivery.unitPrice ? ` (${hit.price_delivery.unitPrice})` : "";
    lines.push(`Delivery price: ${price}${unit}`);
  }

  // Location
  if (hit.planogram?.aisle) {
    lines.push(`Aisle: ${hit.planogram.aisle}`);
  }

  // Category
  if (hit.category?.length) {
    const cats = hit.category.map((c) => c.name).join(" > ");
    lines.push(`Category: ${cats}`);
  }

  // Tags
  if (hit.filterTags?.length) {
    lines.push(`Tags: ${hit.filterTags.join(", ")}`);
  }

  // Rating
  if (hit.rating) {
    lines.push(`Rating: ${hit.rating}${hit.reviewCount ? ` (${hit.reviewCount} reviews)` : ""}`);
  }

  // Weight
  if (hit.isSoldByWeight) {
    lines.push(`Sold by weight (${hit.onlineSellByUnit ?? "lb"})`);
  }

  // Allergens
  if (hit.allergensAndWarnings) {
    lines.push(`Allergens: ${hit.allergensAndWarnings}`);
  }

  // Image
  if (hit.images?.length) {
    lines.push(`Image: ${hit.images[0]}`);
  }

  lines.push(`Product ID: ${hit.productId}`);

  return lines.join("\n");
}
