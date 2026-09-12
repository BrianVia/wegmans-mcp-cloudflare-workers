import { fetchReceipts, type Receipt } from "./receipts.js";
import { fetchOrders, type Order } from "./orders.js";
import { fetchMyItemsFromAPI, type MyItemRecord } from "./my-items-api.js";
import { computeProductSummary } from "./patterns.js";
import { env } from "./env.js";

// ─── Types ───

export interface PurchaseEvent {
  id: string;
  source: "receipt" | "order";
  sourceId: string;
  productId: string;
  productName: string;
  department: string;
  quantity: number;
  unitPrice: number;
  storeNumber: string;
  timestamp: string;
}

export interface ProductSummary {
  productId: string;
  productName: string;
  department: string;
  purchaseDates: string[];
  totalPurchaseCount: number;
  averageIntervalDays: number | null;
  medianIntervalDays: number | null;
  lastPurchasedDate: string;
  predictedNextDate: string | null;
  rank: number;
}

export interface PurchaseHistoryData {
  lastSyncedAt: string;
  events: PurchaseEvent[];
  products: Record<string, ProductSummary>;
}

export interface ScoredItem {
  id: string;
  score: number;
}

// ─── Persistence ───

const emptyHistory = (): PurchaseHistoryData => ({ lastSyncedAt: "", events: [], products: {} });

export async function loadPurchaseHistory(): Promise<PurchaseHistoryData> {
  return (await env().DATA.get<PurchaseHistoryData>("purchase-history", "json")) ?? emptyHistory();
}

async function savePurchaseHistory(data: PurchaseHistoryData): Promise<void> {
  const myItems = Object.values(data.products)
    .sort((a, b) => (a.rank || Infinity) - (b.rank || Infinity))
    .map((product) => ({ id: product.productId, score: product.totalPurchaseCount }));
  await Promise.all([
    env().DATA.put("purchase-history", JSON.stringify(data)),
    env().DATA.put("my-items", JSON.stringify(myItems)),
  ]);
}

export async function loadMyItems(): Promise<ScoredItem[]> {
  return (await env().DATA.get<ScoredItem[]>("my-items", "json")) ?? [];
}

// ─── Event conversion ───

function receiptToEvents(receipt: Receipt): PurchaseEvent[] {
  return receipt.items.map((item) => ({
    id: `receipt-${receipt.id}-${item.itemNumber}`,
    source: "receipt" as const,
    sourceId: receipt.id,
    productId: item.itemNumber,
    productName: item.productNameCopy,
    department: item.departmentName,
    quantity: item.quantity,
    unitPrice: item.discountedUnitPrice ?? item.unitPrice,
    storeNumber: String(receipt.storeNumber),
    timestamp: receipt.purchaseTimestamp,
  }));
}

function orderToEvents(order: Order): PurchaseEvent[] {
  if (!order.lineItems) return [];
  return order.lineItems.map((li) => ({
    id: `order-${order.orderId}-${li.key}`,
    source: "order" as const,
    sourceId: order.orderId,
    productId: li.key,
    productName: li.name,
    department: li.lineItemCustom?.category ?? "Unknown",
    quantity: li.quantity,
    unitPrice: li.chargedPricePerUnit,
    storeNumber: "",
    timestamp: order.orderSubmittedDate,
  }));
}

// ─── Sync ───

export interface SyncStats {
  receiptsCount: number;
  ordersCount: number;
  receiptItemsCount: number;
  orderItemsCount: number;
  totalEvents: number;
  uniqueProducts: number;
  /** Completed orders whose detail fetch failed and were dropped from the sync. */
  orderDetailFailures: number;
}

export async function syncPurchaseHistory(): Promise<SyncStats> {
  // Fetch all sources in parallel
  const [receipts, { orders, failedCount: orderDetailFailures }, myItems] = await Promise.all([
    fetchReceipts(),
    fetchOrders(),
    fetchMyItemsFromAPI(),
  ]);

  // Convert to events
  const receiptEvents = receipts.flatMap(receiptToEvents);
  const orderEvents = orders.flatMap(orderToEvents);
  const allEvents = [...receiptEvents, ...orderEvents];

  // Dedup by event ID
  const eventMap = new Map<string, PurchaseEvent>();
  for (const event of allEvents) {
    eventMap.set(event.id, event);
  }
  const events = [...eventMap.values()];

  // Build my-items lookup for rank and lastPurchasedDate
  const myItemsMap = new Map<string, MyItemRecord>();
  for (const item of myItems) {
    myItemsMap.set(String(item.itemNumber), item);
  }

  // Group events by product
  const eventsByProduct = new Map<string, PurchaseEvent[]>();
  for (const event of events) {
    const existing = eventsByProduct.get(event.productId) ?? [];
    existing.push(event);
    eventsByProduct.set(event.productId, existing);
  }

  // Also include products from my-items that might not have receipt/order events
  for (const item of myItems) {
    const pid = String(item.itemNumber);
    if (!eventsByProduct.has(pid)) {
      eventsByProduct.set(pid, []);
    }
  }

  // Compute product summaries
  const products: Record<string, ProductSummary> = {};
  for (const [productId, productEvents] of eventsByProduct) {
    const myItem = myItemsMap.get(productId);

    // Collect purchase dates from events
    const dates = productEvents.map((e) => e.timestamp);

    // If my-items API has a lastPurchasedDate not in our events, include it
    if (myItem?.lastPurchasedDate) {
      const apiDate = myItem.lastPurchasedDate + "T00:00:00Z";
      const apiDay = myItem.lastPurchasedDate;
      const existingDays = new Set(dates.map((d) => d.slice(0, 10)));
      if (!existingDays.has(apiDay)) {
        dates.push(apiDate);
      }
    }

    // Get product name from events, or fall back to product ID
    const name =
      productEvents[0]?.productName ?? `Product ${productId}`;
    const department = productEvents[0]?.department ?? "Unknown";
    const rank = myItem?.rank ?? 0;

    const totalQuantity = productEvents.reduce((s, e) => s + e.quantity, 0);

    const summary = computeProductSummary(
      productId,
      name,
      department,
      dates,
      totalQuantity,
      rank
    );
    products[productId] = summary;
  }

  const data: PurchaseHistoryData = {
    lastSyncedAt: new Date().toISOString(),
    events,
    products,
  };

  await savePurchaseHistory(data);

  return {
    receiptsCount: receipts.length,
    ordersCount: orders.length,
    receiptItemsCount: receiptEvents.length,
    orderItemsCount: orderEvents.length,
    totalEvents: events.length,
    uniqueProducts: Object.keys(products).length,
    orderDetailFailures,
  };
}
