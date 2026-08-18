// Self-check for the pure helpers: `node test.js`.
const assert = require("assert");
const { parseDuration, fmtTotal, fmtClock, sortKey, sumSeconds, startOfDay } = require("./bootstrap.js");

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

console.log("ok");
