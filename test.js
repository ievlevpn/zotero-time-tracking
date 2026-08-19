// Self-check for the pure helpers: `node test.js`.
const assert = require("assert");
const { parseDuration, fmtTotal, fmtClock, sortKey, sumSeconds, startOfDay, historyByDay, heatmapWeeks, level } = require("./bootstrap.js");

// A bare number means minutes; h/m/s are honoured; junk is ignored.
assert.strictEqual(parseDuration("25"), 1500);
assert.strictEqual(parseDuration("1h 23m"), 4980);
assert.strictEqual(parseDuration("1h30"), 5400);
assert.strictEqual(parseDuration("45s"), 45);
assert.strictEqual(parseDuration("-10"), -600);
assert.strictEqual(parseDuration(""), 0);
assert.strictEqual(parseDuration("soon"), 0);

assert.strictEqual(fmtTotal(0), "");
assert.strictEqual(fmtTotal(45), "45s");
assert.strictEqual(fmtTotal(1500), "25m");
assert.strictEqual(fmtTotal(4980), "1h 23m");
assert.strictEqual(fmtTotal(3600), "1h 0m");
assert.strictEqual(fmtTotal(-1800), "-30m");   // manual subtractions can go negative
assert.strictEqual(fmtTotal(-5400), "-1h 30m");

assert.strictEqual(fmtClock(0), "0:00");
assert.strictEqual(fmtClock(65), "1:05");
assert.strictEqual(fmtClock(3725), "1:02:05");

// The session log: totals per item, per day, and across the library.
const DAY = 86400000;
const today = startOfDay(Date.now());
const row = (id, itemKey, started, seconds, mode = "stopwatch") =>
	({ id, libraryID: 1, itemKey, title: "t", mode, started, seconds });

const log = [
	row("a", "AAAA", today - 3 * DAY, 1800),          // 30m, three days ago
	row("b", "AAAA", today + 9 * 3600e3, 900),        // 15m, today
	row("c", "BBBB", today + 10 * 3600e3, 600),       // 10m, today, other item
	row("d", "AAAA", today + 11 * 3600e3, -300, "manual"),  // manual subtraction
	row("e", "AAAA", today - 30 * DAY, 3600),         // last month
];

assert.strictEqual(sumSeconds(log), 6600);                                   // everything
assert.strictEqual(sumSeconds(log, { id: "1/AAAA" }), 6000);                 // one item
assert.strictEqual(sumSeconds(log, { since: today }), 1200);                 // today
assert.strictEqual(sumSeconds(log, { since: today, id: "1/AAAA" }), 600);    // today, one item
assert.strictEqual(sumSeconds(log, { since: startOfDay(Date.now() - 6 * DAY) }), 3000); // last 7 days
assert.strictEqual(sumSeconds([], { since: today }), 0);

// startOfDay is a floor: any moment in a day maps to the same midnight.
assert.strictEqual(startOfDay(today), today);
assert.strictEqual(startOfDay(today + DAY - 1), today);
assert.strictEqual(new Date(today).getHours(), 0);

// The library column's sort key: string order must match duration order, and
// zero must never produce an empty cell (the tree sorts empties to the top when
// you sort descending, which would float unread items above everything).
const durations = [0, 1, 59, 60, 3599, 3600, 86400, 999999];
const byKey = [...durations].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
assert.deepStrictEqual(byKey, durations);
assert.notStrictEqual(sortKey(0), "");
assert.strictEqual(sortKey(-100), sortKey(0));      // clamped, not "-000000100"
assert.strictEqual(sortKey(0).length, sortKey(999999).length);
assert.strictEqual(fmtTotal(parseInt(sortKey(4980), 10)), "1h 23m");  // round-trips for display

// History rollup: newest day first, items merged per day and sorted by time.
const days = historyByDay(log);
assert.deepStrictEqual(days.map((d) => d.day), [today, today - 3 * DAY, today - 30 * DAY]);

const [t] = days;
assert.strictEqual(t.seconds, 1200);                       // 900 + 600 - 300
assert.strictEqual(t.items.length, 2);
assert.deepStrictEqual(t.items.map((e) => e.seconds), [600, 600]);   // 900-300 and 600
assert.deepStrictEqual(t.items.map((e) => e.itemKey).sort(), ["AAAA", "BBBB"]);
const aaaa = t.items.find((e) => e.itemKey === "AAAA");
assert.strictEqual(aaaa.sessions, 2);                      // the timer and the manual row merge
assert.strictEqual(aaaa.title, "t");
assert.strictEqual(aaaa.rows.length, 2);                   // raw rows kept, for editing
assert.deepStrictEqual(aaaa.rows.map((r) => r.id).sort(), ["b", "d"]);
assert.deepStrictEqual(historyByDay([]), []);

// Within a day, the longest read comes first.
const ranked = historyByDay([row("x", "LOW", today + 1000, 60), row("y", "HIGH", today + 2000, 3600)]);
assert.deepStrictEqual(ranked[0].items.map((e) => e.itemKey), ["HIGH", "LOW"]);

// Sessions on the same day for the same item collapse to one line; different
// days stay apart even for the same item.
assert.strictEqual(days[1].items.length, 1);
assert.strictEqual(days[1].items[0].sessions, 1);

// Heatmap grid: 53 Monday-first columns ending in the current week.
const grid = heatmapWeeks(log, Date.now());
assert.strictEqual(grid.length, 53);
assert.ok(grid.every((w) => w.length === 7));
const cells = grid.flat().filter(Boolean);
assert.strictEqual(cells.at(-1).day, today);                  // last real cell is today
assert.ok(grid.at(-1).slice(grid.at(-1).findIndex((c) => c && c.day === today) + 1).every((c) => c === null));
assert.strictEqual(new Date(grid[0][0].day).getDay(), 1);     // columns start on Monday
assert.strictEqual(cells.filter((c) => c.day === today)[0].seconds, 1200);  // today's total
assert.strictEqual(cells.filter((c) => c.seconds > 0).length, 3);  // 3 days with sessions in range
// Days are unique and strictly increasing across the grid.
assert.ok(cells.every((c, i) => i === 0 || c.day > cells[i - 1].day));

// Crossing a DST boundary must not skip or duplicate a day: every column is
// exactly 7 distinct calendar days, and every cell is local midnight.
assert.ok(cells.every((c) => new Date(c.day).getHours() === 0));

assert.deepStrictEqual([0, 1, 899, 900, 2699, 2700, 7199, 7200].map(level), [0, 1, 1, 2, 2, 3, 3, 4]);

console.log("ok");
