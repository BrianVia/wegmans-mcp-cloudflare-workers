import { getAccessToken } from "./tokens.js";

const ORDERS_API =
  "https://api.digitaldevelopment.wegmans.cloud/commerce/order/orders";
const API_VERSION = "2024-03-04-preview";

export interface OrderLineItem {
  key: string; // productKey (e.g. "116893")
  name: string;
  quantity: number;
  chargedPricePerUnit: number;
  totalPrice: {
    centAmount: number;
    currencyCode: string;
  };
  variant: {
    sku: string;
    images?: Array<{ url: string }>;
  };
  lineItemCustom: {
    category?: string;
    quantityOrdered?: number;
    quantityFulfilled?: number;
    fulfillmentPrice?: number;
    baseAmountInCents?: number;
  };
}

export interface Order {
  orderId: string;
  orderNumber: string;
  orderSubmittedDate: string;
  orderState: string;
  state: { key: string; name: string };
  shipmentState?: string;
  taxedPrice: {
    totalNet: { centAmount: number };
    totalGross: { centAmount: number };
    totalTax: { centAmount: number };
  };
  lineItems: OrderLineItem[];
}

interface OrderListResponse {
  orders: Array<{
    orderId: string;
    orderNumber: string;
    orderSubmittedDate: string;
    state: { key: string };
  }>;
  count: number;
  offset: number;
  total: number;
}

interface OrderDetailResponse {
  orders: Order[];
  count: number;
  offset: number;
  total: number;
}

export interface FetchOrdersResult {
  orders: Order[];
  /** Completed orders whose detail fetch failed and were therefore dropped. */
  failedCount: number;
}

/**
 * Fetch all completed orders with their line items.
 * The list endpoint returns 10 at a time without line items,
 * so we paginate the list then fetch each order's detail.
 * Failed detail fetches are dropped but counted in `failedCount`.
 */
export async function fetchOrders(): Promise<FetchOrdersResult> {
  const token = await getAccessToken();
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/json",
    origin: "https://www.wegmans.com",
    referer: "https://www.wegmans.com/",
  };

  // Step 1: Paginate the order list to get all order IDs
  const allOrderIds: Array<{ orderId: string; state: string }> = [];
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const url = `${ORDERS_API}?api-version=${API_VERSION}&offset=${offset}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Orders list API error: ${res.status}`);

    const data = (await res.json()) as OrderListResponse;
    total = data.total;

    for (const o of data.orders) {
      allOrderIds.push({ orderId: o.orderId, state: o.state.key });
    }
    offset += data.orders.length;

    // Safety valve
    if (data.orders.length === 0) break;
  }

  // Step 2: Fetch detail for completed orders only
  const completedIds = allOrderIds
    .filter((o) => o.state === "order-complete")
    .map((o) => o.orderId);

  const orders: Order[] = [];
  let failedCount = 0;

  // ponytail: one request supports fewer than 1000 orders; split into Durable Object alarm batches above that ceiling.
  for (let i = 0; i < completedIds.length; i += 10) {
    const batch = completedIds.slice(i, i + 10);
    const results = await Promise.all(
      batch.map(async (id) => {
        const url = `${ORDERS_API}/${id}?api-version=${API_VERSION}`;
        const res = await fetch(url, { headers });
        if (!res.ok) return null;
        const data = (await res.json()) as OrderDetailResponse;
        return data.orders[0] ?? null;
      })
    );
    for (const order of results) {
      if (order) {
        orders.push(order);
      } else {
        failedCount += 1;
      }
    }
  }

  return { orders, failedCount };
}
