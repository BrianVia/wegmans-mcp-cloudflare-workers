import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  computeIntervals,
  computeProductSummary,
  classifyUrgency,
  generateShoppingList,
  getProductInsight,
} from "../src/patterns.ts";

// ─── Helpers ───
//
// Fixed reference instant: local noon, June 15 2026. Constructed with the
// local-time Date constructor so the local calendar date is June 15 in EVERY
// timezone — keeps assertions TZ-agnostic.
const NOW = new Date(2026, 5, 15, 12, 0, 0);

/** YYYY-MM-DD string offset by whole days from NOW's calendar date (June 15 2026). */
function day(offset) {
  return new Date(Date.UTC(2026, 5, 15 + offset)).toISOString().slice(0, 10);
}

function makeSummary(overrides = {}) {
  return {
    productId: "100001",
    productName: "Wegmans Whole Milk",
    department: "Dairy",
    purchaseDates: [],
    totalPurchaseCount: 0,
    averageIntervalDays: null,
    medianIntervalDays: null,
    lastPurchasedDate: "",
    predictedNextDate: null,
    rank: 1,
    ...overrides,
  };
}

/** A product that qualifies for the shopping list (≥3 dates, fresh, predicted). */
function listProduct(id, { daysUntil, daysSinceLast = 2, median = 7 } = {}) {
  return makeSummary({
    productId: id,
    productName: `Product ${id}`,
    purchaseDates: [day(-daysSinceLast - 14), day(-daysSinceLast - 7), day(-daysSinceLast)],
    lastPurchasedDate: day(-daysSinceLast),
    medianIntervalDays: median,
    averageIntervalDays: median,
    predictedNextDate: day(daysUntil),
  });
}

// ─── computeIntervals ───

describe("computeIntervals", () => {
  test("dedupes same-day purchases (including timestamp variants)", () => {
    const intervals = computeIntervals([
      "2026-01-01",
      "2026-01-01T15:30:00Z", // same calendar day, full ISO timestamp
      "2026-01-05",
    ]);
    assert.deepEqual(intervals, [4]);
  });

  test("single date returns empty array", () => {
    assert.deepEqual(computeIntervals(["2026-01-01"]), []);
  });

  test("empty input returns empty array", () => {
    assert.deepEqual(computeIntervals([]), []);
  });

  test("correct gaps across month and year boundaries", () => {
    assert.deepEqual(computeIntervals(["2026-01-30", "2026-02-02"]), [3]);
    assert.deepEqual(computeIntervals(["2025-12-29", "2026-01-03"]), [5]);
  });

  test("multiple gaps, unsorted input", () => {
    const intervals = computeIntervals(["2026-01-10", "2026-01-01", "2026-01-04"]);
    assert.deepEqual(intervals, [3, 6]);
  });
});

// ─── computeProductSummary ───

describe("computeProductSummary", () => {
  test("median with odd interval count", () => {
    // intervals: [3, 7, 2] → sorted [2, 3, 7] → median 3
    const s = computeProductSummary(
      "1", "Milk", "Dairy",
      ["2026-01-01", "2026-01-04", "2026-01-11", "2026-01-13"],
      4, 1
    );
    assert.equal(s.medianIntervalDays, 3);
    assert.equal(s.averageIntervalDays, 4);
    assert.equal(s.predictedNextDate, "2026-01-16"); // last day + 3
  });

  test("median with even interval count averages the middle pair", () => {
    // intervals: [3, 4] → median 3.5; predicted = last + round(3.5) = +4
    const s = computeProductSummary(
      "1", "Milk", "Dairy",
      ["2026-01-01", "2026-01-04", "2026-01-08"],
      3, 1
    );
    assert.equal(s.medianIntervalDays, 3.5);
    assert.equal(s.predictedNextDate, "2026-01-12");
  });

  test("predictedNextDate crosses month boundary correctly", () => {
    // interval [10], last day Jan 25 → predicted Feb 4
    const s = computeProductSummary(
      "1", "Milk", "Dairy",
      ["2026-01-15", "2026-01-25"],
      2, 1
    );
    assert.equal(s.predictedNextDate, "2026-02-04");
  });

  test("predictedNextDate is exact across a DST transition", () => {
    // US DST springs forward 2026-03-08. interval [20], last day Mar 1
    // → predicted must be Mar 21 regardless of local timezone rules.
    const s = computeProductSummary(
      "1", "Milk", "Dairy",
      ["2026-02-09", "2026-03-01"],
      2, 1
    );
    assert.equal(s.predictedNextDate, "2026-03-21");
  });

  test("null intervals and no prediction with fewer than 2 unique days", () => {
    const s = computeProductSummary(
      "1", "Milk", "Dairy",
      ["2026-01-01", "2026-01-01T08:00:00Z"], // one unique day
      2, 1
    );
    assert.equal(s.averageIntervalDays, null);
    assert.equal(s.medianIntervalDays, null);
    assert.equal(s.predictedNextDate, null);
    assert.equal(s.lastPurchasedDate, "2026-01-01");
  });

  test("totalPurchaseCount falls back to unique-day count when 0 passed", () => {
    const s = computeProductSummary(
      "1", "Milk", "Dairy",
      ["2026-01-01", "2026-01-04", "2026-01-08"],
      0, 1
    );
    assert.equal(s.totalPurchaseCount, 3);
  });

  test("totalPurchaseCount is preserved when non-zero", () => {
    const s = computeProductSummary(
      "1", "Milk", "Dairy",
      ["2026-01-01", "2026-01-04"],
      9, 1
    );
    assert.equal(s.totalPurchaseCount, 9);
  });
});

// ─── classifyUrgency ───

describe("classifyUrgency", () => {
  function product(daysUntil, daysSinceLast = 5) {
    return makeSummary({
      purchaseDates: [day(-daysSinceLast - 7), day(-daysSinceLast)],
      lastPurchasedDate: day(-daysSinceLast),
      medianIntervalDays: 7,
      predictedNextDate: day(daysUntil),
    });
  }

  test("overdue when daysUntil < 0", () => {
    const r = classifyUrgency(product(-1), NOW);
    assert.equal(r.urgency, "overdue");
    assert.equal(r.daysUntil, -1);
  });

  test("due_soon at boundaries 0, 1, 2", () => {
    for (const d of [0, 1, 2]) {
      const r = classifyUrgency(product(d), NOW);
      assert.equal(r.urgency, "due_soon", `daysUntil=${d}`);
      assert.equal(r.daysUntil, d);
    }
  });

  test("upcoming at boundaries 3 and 7", () => {
    for (const d of [3, 7]) {
      const r = classifyUrgency(product(d), NOW);
      assert.equal(r.urgency, "upcoming", `daysUntil=${d}`);
      assert.equal(r.daysUntil, d);
    }
  });

  test("not_due when daysUntil > 7", () => {
    const r = classifyUrgency(product(8), NOW);
    assert.equal(r.urgency, "not_due");
    assert.equal(r.daysUntil, 8);
  });

  test("unknown with no prediction; daysSince still computed", () => {
    const p = makeSummary({ lastPurchasedDate: day(-4) });
    const r = classifyUrgency(p, NOW);
    assert.equal(r.urgency, "unknown");
    assert.equal(r.daysUntil, null);
    assert.equal(r.daysSince, 4);
  });

  test("daysSince is null (not 0) when never purchased", () => {
    const r = classifyUrgency(makeSummary(), NOW);
    assert.equal(r.urgency, "unknown");
    assert.equal(r.daysSince, null);
  });

  test("daysSince is 0 when purchased today", () => {
    const r = classifyUrgency(product(3, 0), NOW);
    assert.equal(r.daysSince, 0);
  });

  test("regression: late-evening local now does not push daysSince to 1", () => {
    // The old implementation diffed the local instant against the UTC-midnight
    // parse of the date string, so daysSince drifted by ±1 with local clock time.
    const lateEvening = new Date(2026, 5, 10, 23, 30, 0); // local 23:30, June 10
    const p = makeSummary({ lastPurchasedDate: "2026-06-10" });
    assert.equal(classifyUrgency(p, lateEvening).daysSince, 0);
  });

  test("regression: early-morning next day gives exactly 1", () => {
    const earlyMorning = new Date(2026, 5, 11, 0, 30, 0); // local 00:30, June 11
    const p = makeSummary({ lastPurchasedDate: "2026-06-10" });
    assert.equal(classifyUrgency(p, earlyMorning).daysSince, 1);
  });

  test("regression: daysUntil is a whole calendar-day diff at any time of day", () => {
    const lateEvening = new Date(2026, 5, 10, 23, 30, 0);
    const p = makeSummary({
      lastPurchasedDate: "2026-06-03",
      medianIntervalDays: 9,
      predictedNextDate: "2026-06-12",
    });
    const r = classifyUrgency(p, lateEvening);
    assert.equal(r.daysUntil, 2);
    assert.equal(r.urgency, "due_soon");
  });
});

// ─── generateShoppingList ───

describe("generateShoppingList", () => {
  test("skips products with fewer than 3 purchase dates", () => {
    const p = makeSummary({
      productId: "1",
      purchaseDates: [day(-9), day(-2)],
      lastPurchasedDate: day(-2),
      medianIntervalDays: 7,
      predictedNextDate: day(1),
    });
    assert.deepEqual(generateShoppingList({ 1: p }, { now: NOW }), []);
  });

  test("skips stale items: daysSince > 3x median interval", () => {
    // median 5, last bought 16 days ago → 16 > 15, stale
    const stale = listProduct("1", { daysUntil: 0, daysSinceLast: 16, median: 5 });
    assert.deepEqual(generateShoppingList({ 1: stale }, { now: NOW }), []);
    // 14 days ago with median 5 → 14 <= 15, kept
    const fresh = listProduct("2", { daysUntil: 0, daysSinceLast: 14, median: 5 });
    assert.equal(generateShoppingList({ 2: fresh }, { now: NOW }).length, 1);
  });

  test("skips stale items: daysSince > 90 even within 3x median", () => {
    // median 40 → 3x = 120, but 95 > 90 hard cap
    const p = listProduct("1", { daysUntil: 0, daysSinceLast: 95, median: 40 });
    assert.deepEqual(generateShoppingList({ 1: p }, { now: NOW }), []);
  });

  test("respects lookaheadDays cutoff for upcoming items", () => {
    const p = listProduct("1", { daysUntil: 5 });
    assert.equal(generateShoppingList({ 1: p }, { now: NOW, lookaheadDays: 4 }).length, 0);
    assert.equal(generateShoppingList({ 1: p }, { now: NOW, lookaheadDays: 5 }).length, 1);
  });

  test("includeOverdue: false excludes overdue items", () => {
    const products = {
      a: listProduct("a", { daysUntil: -3 }),
      b: listProduct("b", { daysUntil: 1 }),
    };
    const withOverdue = generateShoppingList(products, { now: NOW });
    assert.deepEqual(withOverdue.map((i) => i.productId), ["a", "b"]);
    const without = generateShoppingList(products, { now: NOW, includeOverdue: false });
    assert.deepEqual(without.map((i) => i.productId), ["b"]);
  });

  test("excludes not_due items entirely", () => {
    const p = listProduct("1", { daysUntil: 10 });
    assert.deepEqual(generateShoppingList({ 1: p }, { now: NOW, lookaheadDays: 30 }), []);
  });

  test("sorts overdue → due_soon → upcoming, by daysUntil within a tier", () => {
    const products = {
      up5: listProduct("up5", { daysUntil: 5 }),
      due2: listProduct("due2", { daysUntil: 2 }),
      over: listProduct("over", { daysUntil: -2 }),
      up3: listProduct("up3", { daysUntil: 3 }),
      due0: listProduct("due0", { daysUntil: 0 }),
    };
    const list = generateShoppingList(products, { now: NOW });
    assert.deepEqual(
      list.map((i) => i.productId),
      ["over", "due0", "due2", "up3", "up5"]
    );
    assert.deepEqual(
      list.map((i) => i.urgency),
      ["overdue", "due_soon", "due_soon", "upcoming", "upcoming"]
    );
  });

  test("maxItems truncates after sorting (keeps the most urgent)", () => {
    const products = {
      up5: listProduct("up5", { daysUntil: 5 }),
      over: listProduct("over", { daysUntil: -2 }),
      due0: listProduct("due0", { daysUntil: 0 }),
    };
    const list = generateShoppingList(products, { now: NOW, maxItems: 2 });
    assert.deepEqual(list.map((i) => i.productId), ["over", "due0"]);
  });

  test("daysSinceLastPurchase and daysUntilPredicted are exact day counts", () => {
    const p = listProduct("1", { daysUntil: 1, daysSinceLast: 6 });
    const [item] = generateShoppingList({ 1: p }, { now: NOW });
    assert.equal(item.daysSinceLastPurchase, 6);
    assert.equal(item.daysUntilPredicted, 1);
  });
});

// ─── getProductInsight ───

describe("getProductInsight", () => {
  test("no purchase history message", () => {
    const p = makeSummary({ productName: "Oat Milk" });
    assert.equal(
      getProductInsight(p, NOW),
      "No purchase history found for Oat Milk."
    );
  });

  test("not enough history message includes accurate daysSince", () => {
    const p = makeSummary({
      productName: "Oat Milk",
      purchaseDates: [day(-4)],
      lastPurchasedDate: day(-4),
    });
    const insight = getProductInsight(p, NOW);
    assert.match(insight, /Not enough purchase history/);
    assert.match(insight, /4 days ago/);
  });

  test("overdue insight reports overdue day count", () => {
    const p = makeSummary({
      productName: "Eggs",
      purchaseDates: [day(-19), day(-12), day(-5)],
      lastPurchasedDate: day(-5),
      medianIntervalDays: 3,
      predictedNextDate: day(-2),
    });
    const insight = getProductInsight(p, NOW);
    assert.match(insight, /every 3 days/);
    assert.match(insight, /Last bought 5 days ago/);
    assert.match(insight, /2 days overdue/);
  });
});
