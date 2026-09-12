import type { ProductSummary } from "./purchase-history.js";

// ─── Calendar-day arithmetic ───
//
// All purchase dates are YYYY-MM-DD strings (or ISO timestamps sliced to 10
// chars). To avoid timezone off-by-one errors we never diff raw Date instants;
// instead we map each side to a whole "day number" (days since the Unix epoch)
// and diff those. "Today" is the user's LOCAL calendar date.

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** Day number for a YYYY-MM-DD (or ISO timestamp) date string. */
function dayNumberFromDateString(dateStr: string): number {
  const [y, m, d] = dateStr.slice(0, 10).split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!) / MS_PER_DAY;
}

/** Day number for the local calendar date of the given instant. */
function dayNumberFromLocalDate(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / MS_PER_DAY;
}

// ─── Interval computation ───

/**
 * Compute pairwise intervals in days between unique purchase dates.
 * Deduplicates to unique calendar days first.
 */
export function computeIntervals(dates: string[]): number[] {
  const uniqueDays = [...new Set(dates.map((d) => d.slice(0, 10)))].sort();
  if (uniqueDays.length < 2) return [];

  const intervals: number[] = [];
  for (let i = 1; i < uniqueDays.length; i++) {
    const days =
      dayNumberFromDateString(uniqueDays[i]!) -
      dayNumberFromDateString(uniqueDays[i - 1]!);
    if (days > 0) intervals.push(days);
  }
  return intervals;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

// ─── Product summary ───

export function computeProductSummary(
  productId: string,
  productName: string,
  department: string,
  dates: string[],
  totalPurchaseCount: number,
  rank: number
): ProductSummary {
  const uniqueDays = [...new Set(dates.map((d) => d.slice(0, 10)))].sort();
  const intervals = computeIntervals(dates);

  const lastDay = uniqueDays[uniqueDays.length - 1];
  const avgInterval = intervals.length > 0 ? Math.round(mean(intervals) * 10) / 10 : null;
  const medInterval = intervals.length > 0 ? Math.round(median(intervals) * 10) / 10 : null;

  let predictedNext: string | null = null;
  if (lastDay && medInterval !== null && medInterval > 0) {
    // Pure UTC day arithmetic: setDate() on a UTC-midnight Date works in
    // local time and can land a day off when a DST transition falls inside
    // the interval. Date.UTC normalizes day overflow for us.
    const predictedDayNumber = dayNumberFromDateString(lastDay) + Math.round(medInterval);
    predictedNext = new Date(predictedDayNumber * MS_PER_DAY).toISOString().slice(0, 10);
  }

  return {
    productId,
    productName,
    department,
    purchaseDates: uniqueDays,
    totalPurchaseCount: totalPurchaseCount || uniqueDays.length,
    averageIntervalDays: avgInterval,
    medianIntervalDays: medInterval,
    lastPurchasedDate: lastDay ?? "",
    predictedNextDate: predictedNext,
    rank,
  };
}

// ─── Urgency classification ───

export type Urgency = "overdue" | "due_soon" | "upcoming" | "not_due" | "unknown";

export function classifyUrgency(
  product: ProductSummary,
  now: Date = new Date()
): { urgency: Urgency; daysUntil: number | null; daysSince: number | null } {
  const today = dayNumberFromLocalDate(now);

  // null = never purchased; 0 = purchased today. These are different facts.
  const daysSince = product.lastPurchasedDate
    ? today - dayNumberFromDateString(product.lastPurchasedDate)
    : null;

  if (!product.predictedNextDate || product.medianIntervalDays === null) {
    return { urgency: "unknown", daysUntil: null, daysSince };
  }

  const daysUntil = dayNumberFromDateString(product.predictedNextDate) - today;

  let urgency: Urgency;
  if (daysUntil < 0) urgency = "overdue";
  else if (daysUntil <= 2) urgency = "due_soon";
  else if (daysUntil <= 7) urgency = "upcoming";
  else urgency = "not_due";

  return { urgency, daysUntil, daysSince };
}

// ─── Shopping list ───

export interface ShoppingListItem {
  productId: string;
  productName: string;
  department: string;
  urgency: Urgency;
  daysSinceLastPurchase: number;
  daysUntilPredicted: number | null;
  averageIntervalDays: number | null;
  medianIntervalDays: number | null;
  lastPurchasedDate: string;
  reason: string;
}

export function generateShoppingList(
  products: Record<string, ProductSummary>,
  options: {
    lookaheadDays?: number;
    maxItems?: number;
    includeOverdue?: boolean;
    now?: Date;
  } = {}
): ShoppingListItem[] {
  const { lookaheadDays = 7, maxItems = 20, includeOverdue = true, now = new Date() } = options;
  const items: ShoppingListItem[] = [];

  for (const product of Object.values(products)) {
    // Need at least 3 purchase dates for a meaningful pattern
    if (product.purchaseDates.length < 3) continue;
    if (!product.predictedNextDate || product.medianIntervalDays === null) continue;

    const { urgency, daysUntil, daysSince } = classifyUrgency(product, now);
    // ≥3 purchase dates guarantees lastPurchasedDate is set, so daysSince is
    // never null here; the guard exists only to narrow the type.
    if (daysSince === null) continue;

    // Skip items where the last purchase was more than 3x their median interval ago
    // or more than 90 days ago — these are items the user has likely stopped buying
    if (daysSince > product.medianIntervalDays * 3 || daysSince > 90) continue;

    if (urgency === "unknown" || urgency === "not_due") continue;
    if (!includeOverdue && urgency === "overdue") continue;
    if (urgency === "upcoming" && daysUntil !== null && daysUntil > lookaheadDays) continue;

    const interval = Math.round(product.medianIntervalDays);
    let reason: string;
    if (urgency === "overdue") {
      reason = `Last bought ${daysSince} days ago, you usually buy every ${interval} days (${Math.abs(daysUntil!)} days overdue)`;
    } else if (urgency === "due_soon") {
      reason = `Last bought ${daysSince} days ago, you usually buy every ${interval} days (due ${daysUntil === 0 ? "today" : `in ${daysUntil} day${daysUntil === 1 ? "" : "s"}`})`;
    } else {
      reason = `Last bought ${daysSince} days ago, you usually buy every ${interval} days (due in ${daysUntil} days)`;
    }

    items.push({
      productId: product.productId,
      productName: product.productName,
      department: product.department,
      urgency,
      daysSinceLastPurchase: daysSince,
      daysUntilPredicted: daysUntil,
      averageIntervalDays: product.averageIntervalDays,
      medianIntervalDays: product.medianIntervalDays,
      lastPurchasedDate: product.lastPurchasedDate,
      reason,
    });
  }

  // Sort: overdue first, then by daysUntil ascending
  const urgencyOrder: Record<Urgency, number> = {
    overdue: 0,
    due_soon: 1,
    upcoming: 2,
    not_due: 3,
    unknown: 4,
  };

  items.sort((a, b) => {
    const ua = urgencyOrder[a.urgency];
    const ub = urgencyOrder[b.urgency];
    if (ua !== ub) return ua - ub;
    return (a.daysUntilPredicted ?? 999) - (b.daysUntilPredicted ?? 999);
  });

  return items.slice(0, maxItems);
}

// ─── Natural language insight ───

export function getProductInsight(product: ProductSummary, now: Date = new Date()): string {
  const { urgency, daysUntil, daysSince } = classifyUrgency(product, now);

  if (urgency === "unknown") {
    if (product.lastPurchasedDate) {
      return `You last bought ${product.productName} ${daysSince} days ago. Not enough purchase history to predict a pattern yet.`;
    }
    return `No purchase history found for ${product.productName}.`;
  }

  const interval = Math.round(product.medianIntervalDays!);
  const count = product.purchaseDates.length;

  if (urgency === "overdue") {
    return `You buy ${product.productName} roughly every ${interval} days (based on ${count} purchases). Last bought ${daysSince} days ago — ${Math.abs(daysUntil!)} days overdue.`;
  }
  if (urgency === "due_soon") {
    return `You buy ${product.productName} roughly every ${interval} days (based on ${count} purchases). Last bought ${daysSince} days ago — due ${daysUntil === 0 ? "today" : "tomorrow"}.`;
  }
  if (urgency === "upcoming") {
    return `You buy ${product.productName} roughly every ${interval} days (based on ${count} purchases). Last bought ${daysSince} days ago — next purchase predicted in ${daysUntil} days.`;
  }
  return `You buy ${product.productName} roughly every ${interval} days (based on ${count} purchases). Last bought ${daysSince} days ago — not due for ${daysUntil} days.`;
}
