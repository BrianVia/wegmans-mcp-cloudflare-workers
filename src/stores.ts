const STORES_API = "https://www.wegmans.com/api/stores";

export interface WegmansStore {
  name: string;
  storeNumber: number;
  stateAbbreviation: string;
  city: string;
  zip: string;
  streetAddress: string;
  phoneNumber: string;
  latitude: number;
  longitude: number;
  hasPharmacy: boolean;
  hasPickup: boolean;
  hasDelivery: boolean;
  hasECommerce: boolean;
  sellsAlcohol: boolean;
  alcoholTypesForSale?: string[];
  openState: string;
  slug: string;
}

let storeCache: WegmansStore[] | null = null;

async function fetchAllStores(): Promise<WegmansStore[]> {
  if (storeCache) return storeCache;

  const res = await fetch(STORES_API);
  if (!res.ok) {
    throw new Error(`Failed to fetch stores: ${res.status}`);
  }

  const data = (await res.json()) as WegmansStore[];
  storeCache = data;
  return data;
}

export async function findStores(query: string): Promise<WegmansStore[]> {
  const stores = await fetchAllStores();
  const q = query.toLowerCase().trim();

  return stores.filter((s) => {
    return (
      s.name.toLowerCase().includes(q) ||
      s.city.toLowerCase().includes(q) ||
      s.stateAbbreviation.toLowerCase() === q ||
      s.zip.startsWith(q) ||
      s.slug.includes(q) ||
      String(s.storeNumber) === q
    );
  });
}
