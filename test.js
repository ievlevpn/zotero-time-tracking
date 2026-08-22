// Self-check for the pure helpers: `node test.js`.
const assert = require("assert");
const { parseDuration, fmtTotal, fmtClock, sortKey, sumSeconds, startOfDay, historyByDay, heatmapWeeks, level, rollUp, fuzzy, periodStart, goalProgress, goalPace, canComplete } = require("./bootstrap.js");

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
assert.strictEqual(fmtTotal(3600), "1h");        // whole hours drop the "0m"
assert.strictEqual(fmtTotal(72000), "20h");
assert.strictEqual(fmtTotal(-1800), "-30m");   // manual subtractions can go negative
assert.strictEqual(fmtTotal(-5400), "-1h 30m");
assert.strictEqual(fmtTotal(-3600), "-1h");

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

// Fuzzy collection filter: subsequence, case handled by the caller.
assert.ok(fuzzy("", "anything"));                  // empty query matches all
assert.ok(fuzzy("mdv", "medieval europe"));        // gaps are fine
assert.ok(fuzzy("medieval", "medieval europe"));
assert.ok(fuzzy("europe", "medieval europe"));
assert.ok(!fuzzy("veidem", "medieval europe"));    // order matters
assert.ok(!fuzzy("medievalx", "medieval europe"));
assert.ok(fuzzy("me", "me"));
assert.ok(!fuzzy("mee", "me"));

// Per-collection rollup. An item in two collections counts in both, so the
// group totals can exceed the time actually spent — that is deliberate.
const membership = { "1/AAAA": [10, 20], "1/BBBB": [20] };
const groups = rollUp(log, (r) => membership[r.libraryID + "/" + r.itemKey] || []);
assert.strictEqual(groups.get(10), 6000);              // AAAA only
assert.strictEqual(groups.get(20), 6600);              // AAAA + BBBB
assert.strictEqual([...groups.values()].reduce((a, b) => a + b), 12600);
assert.ok([...groups.values()].reduce((a, b) => a + b) > sumSeconds(log), "overlap is counted twice, by design");
assert.strictEqual(rollUp(log, () => []).size, 0);     // items in no collection
assert.strictEqual(rollUp([], () => [1]).size, 0);

// Goal periods. Same conventions as the heatmap: local time, Monday weeks.
const noon = today + 12 * 3600e3;
assert.strictEqual(periodStart("total", noon), 0);
assert.strictEqual(periodStart("day", noon), today);
assert.ok(periodStart("week", noon) <= today);
assert.strictEqual(new Date(periodStart("week", noon)).getDay(), 1, "weeks start on Monday");
assert.strictEqual(new Date(periodStart("month", noon)).getDate(), 1);
assert.strictEqual(new Date(periodStart("month", noon)).getHours(), 0);
assert.ok(noon - periodStart("week", noon) < 7 * DAY);

// Progress: only sessions in the window and matching the goal count.
const goal = { seconds: 3600, period: "day" };
const mineOnly = (r) => r.itemKey === "AAAA";
assert.deepStrictEqual(goalProgress(log, goal, mineOnly, noon),
	{ done: 600, target: 3600, complete: false, ratio: 600 / 3600 });
assert.deepStrictEqual(goalProgress(log, goal, () => true, noon),
	{ done: 1200, target: 3600, complete: false, ratio: 1200 / 3600 });
assert.strictEqual(goalProgress(log, { seconds: 3600, period: "total" }, mineOnly, noon).done, 6000);
// Ratio is clamped, so an overshot goal doesn't overflow its bar.
assert.strictEqual(goalProgress(log, { seconds: 60, period: "total" }, mineOnly, noon).ratio, 1);
assert.strictEqual(goalProgress([], goal, () => true, noon).done, 0);

// Marked read early: done however little time it took, and no longer paced.
const marked = { seconds: 72000, period: "total", completedAt: today, deadline: today + 3 * DAY };
assert.deepStrictEqual(goalProgress(log, marked, mineOnly, noon),
	{ done: 6000, target: 72000, complete: true, ratio: 1 });
assert.strictEqual(goalPace(marked, 6000, noon), null, "a finished goal needs no pace");
assert.ok(canComplete({ period: "total" }));
assert.ok(!canComplete({ period: "week" }), "a recurring goal has nothing to finish");

// Pace: only for a dated total that is still short.
const dated = { seconds: 7200, period: "total", deadline: today + 3 * DAY };
assert.strictEqual(goalPace(dated, 3600, noon).days, 4);           // today counts
assert.strictEqual(goalPace(dated, 3600, noon).perDay, 900);       // 1h left over 4 days
assert.strictEqual(goalPace(dated, 7200, noon), null, "met goals need no pace");
assert.strictEqual(goalPace({ seconds: 7200, period: "week" }, 0, noon), null);
assert.strictEqual(goalPace({ seconds: 7200, period: "total" }, 0, noon), null, "no deadline, no pace");
assert.strictEqual(goalPace({ ...dated, deadline: today - DAY }, 0, noon), null, "past due");

// --- smoke test -----------------------------------------------------------
// Drive a whole session against a stubbed Zotero. This exists because a careless
// edit once deleted refreshViews() and every caller kept "working" — the throw
// happened after the important part, so nothing looked broken for six releases.
const { __internals: I } = require("./bootstrap.js");
const written = [], logged = [];
const attach = { id: 10, libraryID: 1, key: "ATT", parentID: 1 };
const book = { id: 1, libraryID: 1, key: "BOOK", isRegularItem: () => true, getDisplayTitle: () => "Book" };
Object.defineProperty(attach, "parentItem", { get() { return global.Zotero.Items.get(this.parentID); } });
let openReaders = [{ itemID: 10 }];
let refreshes = 0;
global.Zotero = {
	logError: (e) => logged.push(e),   // checked below: only expected ones allowed
	Items: { get: (id) => ({ 10: attach, 1: book }[id] || false) },
	Reader: { get _readers() { return openReaders; } },
	Utilities: { randomString: () => "id" + written.length },
	ItemTreeManager: { refreshColumns: () => refreshes++ },
	ItemPaneManager: { refreshInfoRow: () => refreshes++ },
	ProgressWindow: function () { this.changeHeadline = () => {}; this.show = () => {}; this.startCloseTimer = () => {}; },
	Prefs: { get: () => undefined, set: () => {} },
};
global.Components = { classes: {}, interfaces: {} };
I.setActive(true);
I.setRegistered("col", "row");   // as startup() would, so refreshViews() has work to do
I.setDB({ queryAsync: (sql, params) => { written.push(sql.trim().split(/\s+/)[0]); return Promise.resolve([]); } });

I.start("stopwatch", book);
assert.ok(I.getTimer(), "timer runs after start");
assert.strictEqual(I.log.length, 1, "starting logs a session row");
assert.strictEqual(written[0], "INSERT");

const session = I.log[0];
session.seconds = 0;
I.getTimer().counted = 120;          // pretend two minutes passed
I.tick();                            // absorb + paint, and must not throw
assert.strictEqual(session.seconds, 120, "the row tracks counted time");

I.setPaused(true);
assert.strictEqual(I.getTimer().running, false, "pause stops the clock");
I.setPaused(false);

// Switching tabs must never look like closing one. An open reader whose item is
// briefly out of Zotero's cache resolves to nothing; that is "can't tell", not
// "closed", and a timer must survive it.
let unloaded = false;
const cachedGet = global.Zotero.Items.get;
global.Zotero.Items.get = (id) => {
	if (unloaded) { const e = new Error("not yet loaded"); e.name = "UnloadedDataException"; throw e; }
	return cachedGet(id);
};
unloaded = true;
I.checkOrphaned(); I.checkOrphaned(); I.checkOrphaned();
assert.ok(I.getTimer(), "an unresolvable item is not a closed tab");
unloaded = false;
global.Zotero.Items.get = cachedGet;

// Closing the book stops the timer — after one grace check, not immediately.
openReaders = [];
I.checkOrphaned();
assert.ok(I.getTimer(), "one missed check is a grace period");
I.checkOrphaned();
assert.strictEqual(I.getTimer(), null, "a closed book stops the timer");
assert.strictEqual(I.log.length, 1, "the session is kept, not dropped");
assert.strictEqual(I.log[0].seconds, 120, "with its time intact");
assert.ok(refreshes > 0, "the column and item pane get refreshed");
assert.ok(written.includes("UPDATE"), "the final duration is written");

// The only failures the run may swallow are the cache misses we staged.
assert.deepStrictEqual([...new Set(logged.map((e) => e.name))].sort(), ["UnloadedDataException"],
	"unexpected errors were swallowed: " + logged.map((e) => e.message).join("; "));

// --- the history window renders end to end --------------------------------
// buildHistory() is called inside safe(), so a throw halfway through leaves a
// half-drawn window and says nothing. That is exactly how a stray edit once
// emptied the day list below its headers. Draw it against a fake DOM instead.
const node = (tag) => ({ tag, className: "", textContent: "", id: "", title: "", hidden: false,
	style: {}, dataset: {}, children: [], isConnected: true, parentElement: null,
	append(...c) { for (const x of c) if (x && typeof x === "object") { x.parentElement = this; this.children.push(x); } },
	insertBefore(n) { n.parentElement = this; this.children.push(n); },
	replaceChildren(...c) { this.children = []; this.append(...c); },
	addEventListener() {}, remove() {}, querySelectorAll: () => [], focus() {} });
const fakeDoc = () => ({ defaultView: {}, head: node("head"), body: node("body"), title: "",
	createElement: node, getElementById: () => null, querySelectorAll: () => [] });

global.Zotero.getMainWindow = () => ({ ZoteroPane: { selectItem() {} }, focus() {} });
global.Zotero.Items.getIDFromLibraryAndKey = () => 1;
global.Zotero.Items.getByLibraryAndKey = () => book;
global.Zotero.Collections = { get: () => null, getByLibraryAndKey: () => null };
book.getCollections = () => [];

I.log.length = 0;
I.log.push({ id: "h1", libraryID: 1, itemKey: "BOOK", title: "A Book", mode: "stopwatch", started: Date.now() - 3600e3, seconds: 1860 },
	{ id: "h2", libraryID: 1, itemKey: "BOOK", title: "A Book", mode: "pomodoro", started: Date.now() - 86400000, seconds: 3000 });
I.goals.push({ id: "g1", libraryID: 1, scope: "item", key: "BOOK", seconds: 7200, period: "total", updatedAt: Date.now() });

const drawn = (body, cls) => body.children.filter((c) => c.className === cls).length;
for (const view of ["days", "collections", "goals"]) {
	const doc = fakeDoc();
	I.buildHistory({ document: doc, __view: view });
	assert.ok(doc.body.children.length > 1, `${view} view drew something`);
}

const doc = fakeDoc();
I.buildHistory({ document: doc });
assert.strictEqual(drawn(doc.body, "day"), 2, "one header per day");
assert.strictEqual(drawn(doc.body, "item"), 2, "and its items under it — not just the header");
assert.strictEqual(drawn(doc.body, "sessions"), 2, "each with its sessions");

console.log("ok");
