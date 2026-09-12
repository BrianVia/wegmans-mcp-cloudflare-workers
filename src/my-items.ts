/**
 * "My Items" — the user's purchase history / frequently bought items.
 *
 * Wegmans stores this as a scored list of product IDs that gets passed to Algolia.
 * The scores represent purchase frequency/recency (higher = more frequently bought).
 *
 * The product IDs are queried against Algolia to get full product details.
 */

import { algoliaQuery } from "./algolia.js";

export interface MyItemsResult {
  products: Array<{
    productId: string;
    productName: string;
    price: string;
    aisle: string;
    score: number;
  }>;
  total: number;
}

/**
 * Query Algolia for a batch of products by their IDs.
 * Uses the same scored filter approach that the Wegmans frontend uses.
 */
export async function queryProductsByIds(
  productIds: string[],
  storeNumber: string,
  scores?: number[]
): Promise<MyItemsResult> {
  // Build the scored filter string like the frontend does
  const filterParts = productIds.map((id, i) => {
    const score = scores?.[i] ?? (productIds.length - i);
    return `productID:${id}<score=${score}>`;
  });

  const filters = `storeNumber:${storeNumber} AND fulfilmentType:instore AND excludeFromWeb:false AND isSoldAtStore:true AND (${filterParts.join(" OR ")})`;

  const data = await algoliaQuery<{
    results: Array<{
      hits: Array<{
        productId: string;
        productName: string;
        price_inStore?: { amount: number; unitPrice?: string };
        planogram?: { aisle?: string };
        _rankingInfo?: { filters?: number };
      }>;
      nbHits: number;
    }>;
  }>([
    {
      indexName: "products",
      analytics: true,
      analyticsTags: ["my-items-count"],
      attributesToHighlight: [],
      clickAnalytics: true,
      enableRules: true,
      facets: ["*"],
      filters,
      hitsPerPage: productIds.length,
      page: 0,
      query: "",
      getRankingInfo: true,
    },
  ]);

  const result = data.results[0];
  if (!result) return { products: [], total: 0 };

  // Sort by score (ranking info filters field) descending — most purchased first
  const products = result.hits
    .sort((a, b) => (b._rankingInfo?.filters ?? 0) - (a._rankingInfo?.filters ?? 0))
    .map((h) => ({
      productId: h.productId,
      productName: h.productName,
      price: h.price_inStore ? `$${h.price_inStore.amount.toFixed(2)}` : "N/A",
      aisle: h.planogram?.aisle ?? "Unknown",
      score: h._rankingInfo?.filters ?? 0,
    }));

  return { products, total: result.nbHits };
}
