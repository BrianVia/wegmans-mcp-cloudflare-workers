import { getAccessToken } from "./tokens.js";

const MY_ITEMS_API =
  "https://api.digitaldevelopment.wegmans.cloud/commerce/my-items?api-version=2024-01-26";

export interface MyItemRecord {
  itemNumber: number;
  rank: number;
  lastPurchasedDate: string; // "2026-04-04"
}

/**
 * Fetch the user's ranked purchase list from the Wegmans My Items API.
 * Returns all items with product ID, frequency rank, and last purchased date.
 * This is much richer than the Algolia-based approach.
 */
export async function fetchMyItemsFromAPI(): Promise<MyItemRecord[]> {
  const token = await getAccessToken();
  const res = await fetch(MY_ITEMS_API, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      origin: "https://www.wegmans.com",
      referer: "https://www.wegmans.com/",
    },
  });

  if (!res.ok) {
    throw new Error(`My Items API error: ${res.status}`);
  }

  return (await res.json()) as MyItemRecord[];
}
