// Self-check for the pure helpers and the machinery: `node test.js`.
const assert = require("assert");
const { parseDuration, fmtTotal, fmtClock, sortKey, sumSeconds, startOfDay, historyByDay, heatmapWeeks, streaks, level, rollUp, fuzzy, periodStart, goalProgress, goalPace, canComplete, goalDone } = require("./bootstrap.js");

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
// Streaks: days in a row, now and at best. Yesterday still counts as current —
// a streak that died at midnight would be broken every morning.
const day = (back) => { const d = new Date(today); d.setDate(d.getDate() - back); return { started: d.getTime(), seconds: 60 }; };
assert.deepStrictEqual(streaks([], Date.now()), { current: 0, longest: 0 });
assert.deepStrictEqual(streaks([day(0)], Date.now()), { current: 1, longest: 1 });
assert.deepStrictEqual(streaks([day(0), day(1), day(2)], Date.now()), { current: 3, longest: 3 });
assert.deepStrictEqual(streaks([day(1), day(2)], Date.now()), { current: 2, longest: 2 },
	"a run ending yesterday is still running");
assert.deepStrictEqual(streaks([day(2), day(3)], Date.now()), { current: 0, longest: 2 },
	"but one ending the day before is over");
assert.deepStrictEqual(streaks([day(0), day(5), day(6), day(7), day(8)], Date.now()),
	{ current: 1, longest: 4 }, "the best run need not be the current one");
assert.deepStrictEqual(streaks([day(0), day(0), day(1)], Date.now()), { current: 2, longest: 2 },
	"two sessions in a day are one day");

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

// Which pile a goal belongs in: a one-off is finished when marked read or when
// the time is in; a recurring one never is, because it starts again.
assert.ok(goalDone({ period: "total", seconds: 3600 }, 3600));
assert.ok(goalDone({ period: "total", seconds: 3600, completedAt: 1 }, 60), "marked read counts");
assert.ok(!goalDone({ period: "total", seconds: 3600 }, 3599));
assert.ok(!goalDone({ period: "week", seconds: 3600 }, 99999), "a weekly goal is never behind you");

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
let openNotes = [];
let refreshes = 0;
global.Zotero = {
	logError: (e) => logged.push(e),   // checked below: only expected ones allowed
	getMainWindow: () => null,         // no window yet; the corner clock stays away
	Items: { get: (id) => ({ 10: attach, 1: book }[id] || false) },
	Reader: { get _readers() { return openReaders; },
		getByTabID: (id) => openReaders.find((r) => r.tabID === id) || null },
	Notes: { get _editorInstances() { return openNotes; } },
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
	listeners: {},
	addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
	remove() {
		const p = this.parentElement;
		if (p) p.children = p.children.filter((c) => c !== this);
		this.parentElement = null;
		this.isConnected = false;
	},
	querySelectorAll: () => [], focus() {}, replaceWith() {} });
const fakeDoc = () => ({ defaultView: { innerWidth: 900 }, head: node("head"), body: node("body"), title: "",
	createElement: node, getElementById: () => null, querySelectorAll: () => [],
	addEventListener() {}, removeEventListener() {} });

global.Zotero.getMainWindow = () => ({ ZoteroPane: { selectItem() {} }, focus() {} });
global.Zotero.Items.getIDFromLibraryAndKey = () => 1;
global.Zotero.Items.getByLibraryAndKey = () => book;
global.Zotero.Collections = { get: () => null, getByLibraryAndKey: () => null };
book.getCollections = () => [];

I.log.length = 0;
I.log.push({ id: "h1", libraryID: 1, itemKey: "BOOK", title: "A Book", mode: "stopwatch", started: Date.now() - 3600e3, seconds: 1860, note: "ch. 3-4, the argument about coinage" },
	{ id: "h2", libraryID: 1, itemKey: "BOOK", title: "A Book", mode: "pomodoro", started: Date.now() - 86400000, seconds: 3000 });
I.goals.push({ id: "g1", libraryID: 1, scope: "item", key: "BOOK", seconds: 7200, period: "total", updatedAt: Date.now() });

const drawn = (body, cls) => body.children.filter((c) => c.className === cls).length;
// A library-wide goal has no item or collection to be set from, so the Goals
// view has to offer it — the scope existed in the schema long before anything
// could create one.
global.Zotero.Libraries = { userLibraryID: 1 };
const goalsDoc = fakeDoc();
I.setView("goals");
I.buildHistory({ document: goalsDoc });
const buttons = [];
const findButtons = (n) => { if (n.tag === "button") buttons.push(n); (n.children || []).forEach(findButtons); };
goalsDoc.body.children.forEach(findButtons);
for (const label of [/book/i, /collection/i, /all reading/i]) {
	assert.ok(buttons.some((b) => label.test(b.textContent)),
		`the Goals view offers ${label} goals`);
}

// Goals are filed by what they are about, with finished ones out of the way.
I.goals.length = 0;
I.goals.push(
	{ id: "s1", libraryID: 1, scope: "item", key: "BOOK", seconds: 7200, period: "total", updatedAt: 1 },
	{ id: "s2", libraryID: 1, scope: "collection", key: "COLL", seconds: 10800, period: "week", updatedAt: 1 },
	{ id: "s3", libraryID: 1, scope: "all", key: null, seconds: 3600, period: "day", updatedAt: 1 },
	{ id: "s4", libraryID: 1, scope: "item", key: "DONE", seconds: 3600, period: "total", completedAt: Date.now(), updatedAt: 1 });
const piles = fakeDoc();
I.setView("goals");
I.buildHistory({ document: piles });
const headers = piles.body.children.filter((c) => c.className === "day").map((c) => c.textContent);
assert.deepStrictEqual(headers, ["All reading", "Books", "Collections", "Finished"],
	"the goal covering everything leads; finished ones go last");
I.goals.length = 0;

for (const view of ["days", "collections", "goals"]) {
	const doc = fakeDoc();
	I.setView(view);
	I.buildHistory({ document: doc });
	assert.ok(doc.body.children.length > 1, `${view} view drew something`);
}
I.setView("days");

const doc = fakeDoc();
I.buildHistory({ document: doc });
assert.strictEqual(drawn(doc.body, "day"), 2, "one header per day");
assert.strictEqual(drawn(doc.body, "item"), 2, "and its items under it — not just the header");
assert.strictEqual(drawn(doc.body, "sessions"), 2, "each with its sessions");

// A session's note is drawn under it, and an empty one still offers the slot.
const notes = [];
const walk = (n) => { if ((n.className || "").startsWith("snote")) notes.push(n); (n.children || []).forEach(walk); };
doc.body.children.forEach(walk);
assert.strictEqual(notes.length, 2, "every session has a note line");
assert.ok(notes.some((n) => n.textContent.includes("coinage")), "the written note is shown");
assert.ok(notes.some((n) => n.className.includes("snote-blank")), "an unwritten one is an invitation, not a blank");

// --- the note field belongs to the running session -------------------------
// Clicking outside closes the panel on pointerdown, which removes the focused
// input — and removing a focused element fires no blur. Enter was once the only
// way the text reached the database.
const button = node("button");
button.getBoundingClientRect = () => ({ bottom: 20, left: 10 });
const reader = { itemID: 10 };
const noteFieldIn = (doc) => {
	const found = [];
	const walk = (n) => { if (n.tag === "input") found.push(n); (n.children || []).forEach(walk); };
	doc.body.children.forEach(walk);
	return found.find((i) => (i.placeholder || "").includes("Note for this session"));
};

I.log.length = 0;
I.start("stopwatch", book);
const timed = I.log[0];

let panelDoc = fakeDoc();
I.openPanel(reader, panelDoc, button);
let field = noteFieldIn(panelDoc);
assert.ok(field, "a running timer offers a note field");
field.value = "ch. 3-4, the argument about coinage";
field.listeners.input.forEach((fn) => fn());
I.closePanel();                                   // clicked outside; no blur fires
assert.strictEqual(timed.note, "ch. 3-4, the argument about coinage",
	"closing the popup commits what was typed");

// Stopping saves what is in the field and empties it: the session it belonged
// to is over, and leftover text would read as unsaved.
panelDoc = fakeDoc();
I.openPanel(reader, panelDoc, button);
field = noteFieldIn(panelDoc);
field.value = "and the bit about coinage in ch. 5";
field.listeners.input.forEach((fn) => fn());
I.stop();
assert.strictEqual(timed.note, "and the bit about coinage in ch. 5", "stopping commits the text");
assert.strictEqual(field.value, "", "and empties the field");
assert.ok(field.parentElement.hidden, "which has no session left to attach to");
I.closePanel();

// --- a PDF that gains a parent hands over its time -------------------------
I.log.length = 0;
I.goals.length = 0;
I.log.push(
	{ id: "p1", libraryID: 1, itemKey: "PDFKEY", title: "de Libera - Penser au Moyen Age.pdf", mode: "stopwatch", started: 1, seconds: 2100 },
	{ id: "p2", libraryID: 1, itemKey: "PDFKEY", title: "de Libera - Penser au Moyen Age.pdf", mode: "stopwatch", started: 2, seconds: 600 },
	{ id: "p3", libraryID: 1, itemKey: "OTHER", title: "Something Else", mode: "stopwatch", started: 3, seconds: 300 });
I.goals.push({ id: "gp", libraryID: 1, scope: "item", key: "PDFKEY", seconds: 3600, period: "total", updatedAt: 1 });

const resolve = (libraryID, key) => key === "PDFKEY"
	? { libraryID: 1, key: "PARENT", title: "Penser au Moyen Âge" } : null;

assert.strictEqual(I.reparentRows(resolve), 2, "both sessions moved");
assert.deepStrictEqual(I.log.map((r) => r.itemKey), ["PARENT", "PARENT", "OTHER"]);
assert.ok(I.log.every((r) => r.itemKey !== "PARENT" || r.title === "Penser au Moyen Âge"), "and took the parent's title");
assert.strictEqual(I.log[2].title, "Something Else", "unrelated sessions untouched");
assert.strictEqual(I.goals[0].key, "PARENT", "a goal on the PDF follows it");
assert.strictEqual(sumSeconds(I.log, { id: "1/PARENT" }), 2700, "the time is whole again");

assert.strictEqual(I.reparentRows(resolve), 0, "idempotent: nothing left to move");

// If the parent already has a goal for that period, the parent's wins.
I.log.push({ id: "p4", libraryID: 1, itemKey: "PDF2", title: "x.pdf", mode: "stopwatch", started: 4, seconds: 60 });
I.goals.push({ id: "g2", libraryID: 1, scope: "item", key: "PDF2", seconds: 999, period: "total", updatedAt: 1 });
I.reparentRows((lib, key) => key === "PDF2" ? { libraryID: 1, key: "PARENT", title: "Penser au Moyen Âge" } : null);
assert.strictEqual(I.goals.length, 1, "the duplicate goal is dropped, not merged into a conflict");
assert.strictEqual(I.goals[0].seconds, 3600, "and the one already on the parent survives");

// A session outlives its item. Trashing closes the reader (Zotero does that),
// which stops the timer through the orphan check; emptying the trash later
// leaves rows pointing at a key nothing resolves. They keep the title they were
// logged with rather than becoming "(untitled)".
const goneDoc = fakeDoc();
const resolvable = global.Zotero.Items.getByLibraryAndKey;
global.Zotero.Items.getByLibraryAndKey = () => false;
global.Zotero.Items.getIDFromLibraryAndKey = () => 0;
I.log.length = 0;
I.log.push({ id: "g1", libraryID: 1, itemKey: "GONE", title: "A Book That Was Deleted",
	mode: "stopwatch", started: Date.now() - 3600e3, seconds: 1200, note: null });
I.setView("days");
I.buildHistory({ document: goneDoc });
const titles = [];
const walkTitles = (n) => { if (n.className === "t") titles.push(n.textContent); (n.children || []).forEach(walkTitles); };
goneDoc.body.children.forEach(walkTitles);
assert.deepStrictEqual(titles, ["A Book That Was Deleted"], "the time survives the item");
global.Zotero.Items.getByLibraryAndKey = resolvable;
global.Zotero.Items.getIDFromLibraryAndKey = () => 1;
I.log.length = 0;

// --- several attachments, one item -----------------------------------------
// A book's PDF and its appendix are the same reading. itemOf() resolves every
// attachment to its parent before anything is recorded, so both readers key to
// the same item — and a timer survives closing one of the two tabs.
const pdf = { id: 30, libraryID: 1, key: "PDF_A", parentID: 1, isAttachment: () => true };
const appendix = { id: 31, libraryID: 1, key: "PDF_B", parentID: 1, isAttachment: () => true };
for (const a of [pdf, appendix]) {
	Object.defineProperty(a, "parentItem", { get() { return global.Zotero.Items.get(this.parentID); } });
}
const shelf = { 30: pdf, 31: appendix, 1: book };
global.Zotero.Items.get = (id) => shelf[id] || false;

assert.strictEqual(I.idFor({ itemID: 30 }), I.idFor({ itemID: 31 }),
	"both attachments are the same item's time");
assert.strictEqual(I.idFor({ itemID: 30 }), "1/BOOK");

openReaders = [{ itemID: 30 }, { itemID: 31 }];
assert.strictEqual(I.readerOpenFor("1/BOOK"), true);
openReaders = [{ itemID: 31 }];                       // one of the two tabs closed
assert.strictEqual(I.readerOpenFor("1/BOOK"), true, "the other attachment still counts as open");
openReaders = [];
assert.strictEqual(I.readerOpenFor("1/BOOK"), false, "the last one closed ends it");

// --- a note is the same item's time ---------------------------------------
// Writing about a book is time on the book: a note rolls up to its parent just
// like an attachment does, so both land on the same total.
const memo = { id: 32, libraryID: 1, key: "NOTE", parentID: 1 };
Object.defineProperty(memo, "parentItem", { get() { return global.Zotero.Items.get(this.parentID); } });
shelf[32] = memo;
assert.strictEqual(I.idFor({ itemID: 32 }), "1/BOOK", "a note counts as its parent");

openNotes = [{ itemID: 32, viewMode: "tab" }];
assert.strictEqual(I.readerOpenFor("1/BOOK"), true, "a note tab holds the timer open");
openNotes = [{ itemID: 32, viewMode: "library" }];
assert.strictEqual(I.readerOpenFor("1/BOOK"), false,
	"but a note merely selected in the item pane is not a sitting");

// The note toolbar has no plugin API, so the button is put there by hand — and
// put back when React drops it, which is the only thing keeping it on screen.
const end = node("div");
end.className = "end";
const noteDoc = fakeDoc();
noteDoc.querySelector = (sel) => (sel === ".toolbar .end" ? end : null);
openNotes = [{ itemID: 32, viewMode: "tab", _iframeWindow: { document: noteDoc } }];
I.adoptOpenNotes();
const clock = () => end.children.filter((c) => (c.className || "").includes("rt-btn"));
assert.strictEqual(clock().length, 1, "a note tab gets a clock button");
I.adoptOpenNotes();
assert.strictEqual(clock().length, 1, "and only ever one");

const dropped = clock()[0];
end.children = [];                       // React re-rendered the toolbar
dropped.isConnected = false;
I.paint();
assert.strictEqual(clock().length, 1, "a dropped button is put back");
I.bars.clear();
openNotes = [];

// --- marking a book read tags it, and stops its timer ---------------------
// Only ever from a click: nothing tags an item on its own, however much time it
// has had. The tag is asked for once and then remembered.
let prefs = {};
global.Zotero.Prefs = { get: (k) => prefs[k], set: (k, v) => { prefs[k] = v; } };
let asked = 0;
global.Services = { prompt: { prompt: (win, title, text, out) => { asked++; out.value = "read"; return true; } } };
const tagged = [];
const taggedItem = { hasTag: (t) => tagged.includes(t), addTag: (t) => tagged.push(t),
	removeTag: (t) => tagged.splice(tagged.indexOf(t), 1), saveTx: () => {} };
global.Zotero.Items.getByLibraryAndKey = () => taggedItem;
global.Zotero.ProgressWindow = function () { this.changeHeadline = () => {}; this.show = () => {}; this.startCloseTimer = () => {}; };

I.goals.length = 0;
I.log.length = 0;
const bookGoal = { id: "t1", libraryID: 1, scope: "item", key: "BOOK", seconds: 3600, period: "total", updatedAt: 1 };
I.goals.push(bookGoal);

// Finishing a goal stops whatever is being timed toward it — and only that.
I.start("stopwatch", book);
I.getTimer().counted = 240;
const timedRow = I.getTimer().row;
const elsewhere = { id: "t0", libraryID: 1, scope: "item", key: "ELSEWHERE", seconds: 3600, period: "total", updatedAt: 1 };
I.goals.push(elsewhere);
I.toggleComplete(elsewhere);
assert.ok(I.getTimer(), "a goal on another book leaves the timer running");
I.goals.splice(I.goals.indexOf(elsewhere), 1);

I.toggleComplete(bookGoal);
assert.strictEqual(I.getTimer(), null, "finishing the book stops its timer");
assert.strictEqual(timedRow.seconds, 240, "with its last seconds saved first");
assert.strictEqual(asked, 1, "asked for a tag once, the first time");
assert.deepStrictEqual(tagged, ["read"], "and the item is tagged");

I.toggleComplete(bookGoal);                        // reopened
assert.deepStrictEqual(tagged, [], "reopening takes the tag off again");
assert.strictEqual(asked, 1, "and never asks again");

// Declining is remembered as declining, not as "ask me later".
prefs = {}; asked = 0;
global.Services.prompt.prompt = (win, title, text, out) => { asked++; out.value = "  "; return true; };
I.toggleComplete(bookGoal);
assert.deepStrictEqual(tagged, [], "no tag when none was wanted");
assert.strictEqual(prefs["readingTime.readTag"], "", "the choice is stored");
I.toggleComplete(bookGoal);
assert.strictEqual(asked, 1, "and not asked a second time");

// Reaching a target on its own is not a click: it tags nothing.
prefs = { "readingTime.readTag": "read" };
I.goals.length = 0;
I.log.length = 0;
I.log.push({ id: "tl", libraryID: 1, itemKey: "BOOK", title: "A Book", mode: "stopwatch", started: Date.now(), seconds: 99999 });
I.goals.push({ id: "t2", libraryID: 1, scope: "item", key: "BOOK", seconds: 60, period: "total", updatedAt: 1 });
I.checkGoals();
assert.deepStrictEqual(tagged, [], "a goal reached on its own tags nothing");
assert.strictEqual(I.goals[0].completedAt, undefined, "and is not marked read");
I.goals.length = 0;
I.log.length = 0;

// Only a book can be marked "read": finishing a collection or an all-reading
// goal tags nothing and doesn't even ask, since there is no one item it means.
prefs = {}; asked = 0;
let lookups = 0;
const realLookup = global.Zotero.Items.getByLibraryAndKey;
global.Zotero.Items.getByLibraryAndKey = (...args) => { lookups++; return realLookup(...args); };
global.Services.prompt.prompt = (win, title, text, out) => { asked++; out.value = "read"; return true; };

for (const wide of [
	{ id: "w1", libraryID: 1, scope: "collection", key: "COLL", seconds: 3600, period: "total", updatedAt: 1 },
	{ id: "w2", libraryID: 1, scope: "all", key: null, seconds: 3600, period: "total", updatedAt: 1 },
]) {
	I.goals.length = 0;
	I.goals.push(wide);
	I.toggleComplete(wide);
	assert.ok(wide.completedAt, `a ${wide.scope} goal can still be marked finished`);
	assert.deepStrictEqual(tagged, [], `finishing a ${wide.scope} goal tags nothing`);
	assert.strictEqual(asked, 0, `a ${wide.scope} goal never asks about a tag`);
	assert.strictEqual(lookups, 0, `a ${wide.scope} goal looks up no item at all`);
	I.toggleComplete(wide);
	assert.deepStrictEqual(tagged, [], `reopening a ${wide.scope} goal touches nothing either`);
}
global.Zotero.Items.getByLibraryAndKey = realLookup;
I.goals.length = 0;

// The popup's own "mark as read" just tags, with no goal in sight — and unlike
// the goal button it asks even if tagging was declined before, since clicking it
// is someone asking for the tag directly.
prefs = {}; asked = 0;
global.Services.prompt.prompt = (win, title, text, out) => { asked++; out.value = "read"; return true; };
I.goals.length = 0;
I.toggleRead(taggedItem);
assert.deepStrictEqual(tagged, ["read"], "tags the item");
assert.strictEqual(I.goals.length, 0, "and creates no goal");
I.toggleRead(taggedItem);
assert.deepStrictEqual(tagged, [], "clicking again takes it off");

prefs = { "readingTime.readTag": "" };   // declined earlier, for goals
asked = 0;
I.toggleRead(taggedItem);
assert.strictEqual(asked, 1, "an explicit click asks again");
assert.deepStrictEqual(tagged, ["read"], "and tags once a tag is given");
tagged.length = 0;

// --- what happens when things go sideways ---------------------------------
const book2 = { id: 2, libraryID: 1, key: "BOOK2", isRegularItem: () => true,
	getDisplayTitle: () => "Another Book", getCollections: () => [] };
shelf[2] = book2;
const pdfC = { id: 40, libraryID: 1, key: "PDF_C", parentID: 2, isAttachment: () => true };
Object.defineProperty(pdfC, "parentItem", { get() { return global.Zotero.Items.get(this.parentID); } });
shelf[40] = pdfC;
global.Zotero.Items.getIDFromLibraryAndKey = (lib, key) => (key === "BOOK2" ? 2 : 1);
openReaders = [{ itemID: 30 }, { itemID: 40 }];   // both books open in tabs

// (1) A second timer in another book asks first, and Cancel changes nothing.
I.log.length = 0;
I.start("stopwatch", book);
I.getTimer().counted = 300;
const first = I.getTimer().row;
delete global.Services;                       // no prompt available → treated as "no"
I.start("stopwatch", book2);
assert.strictEqual(I.getTimer().row, first, "declining leaves the running timer alone");
assert.strictEqual(I.log.length, 1, "and starts nothing");

global.Services = { prompt: { confirm: () => true } };
I.start("stopwatch", book2);
assert.strictEqual(I.getTimer().id, "1/BOOK2", "accepting switches to the new book");
assert.strictEqual(first.seconds, 300, "the first session is stopped and kept, not discarded");
assert.strictEqual(I.log.length, 2, "one row each");

// (3) A crash loses at most the flush interval: the row is rewritten every
// FLUSH_EVERY ticks, so what survives is the last flush rather than nothing.
I.getTimer().counted = 120;
written.length = 0;
for (let i = 0; i < 60; i++) I.tick();
assert.ok(written.includes("UPDATE"), "a running session is written to disk about once a minute");

// (4) A plugin upgrade stops and saves the running session — Zotero calls
// shutdown() on the old instance before starting the new one.
const running = I.getTimer().row;
global.Zotero.Reader.unregisterEventListener = () => {};
global.Zotero.ItemPaneManager.unregisterInfoRow = () => {};
global.Zotero.ItemTreeManager.unregisterColumn = () => {};
I.setDB({ queryAsync: () => Promise.resolve([]), closeDatabase: () => Promise.resolve() });
I.shutdown().catch((e) => { throw e; });   // stops and saves before its first await
assert.strictEqual(I.getTimer(), null, "no timer survives the upgrade");
assert.ok(running.seconds > 0, "its time was saved on the way out");

// (5) The floating clock: it shows itself while a timer runs and the library is
// what you are looking at, folds to a line, and stays hidden once dismissed.
I.setActive(true);                       // shutdown() above turned everything off
I.setDB({ queryAsync: () => Promise.resolve([]) });
const mainDoc = fakeDoc();
let selectedTab = "zotero-pane";
const selected = [];
global.Zotero.getMainWindow = () => ({ document: mainDoc, focus() {},
	Zotero_Tabs: { get selectedID() { return selectedTab; }, select: (id) => selectedTab = id },
	ZoteroPane: { selectItem: (id) => selected.push(id) } });
const mini = () => mainDoc.body.children.filter((c) => (c.className || "").includes("rt-corner"));
const dig = (n, out = []) => { out.push(n); (n.children || []).forEach((c) => dig(c, out)); return out; };
const inMini = () => (mini().length ? dig(mini()[0]) : []);

I.autoMini();
assert.strictEqual(mini().length, 0, "no timer, no clock");

I.start("stopwatch", book);
I.getTimer().counted = 90;
I.autoMini();
assert.strictEqual(mini().length, 1, "a running timer shows itself in the library");
assert.ok(inMini().some((n) => (n.textContent || "").includes("Book")),
	"folded, the line carries the title — it is all the context there is");
assert.ok(!inMini().some((n) => (n.textContent || "").includes("Mark as read")),
	"and nothing else: folded is one line");

const fold = inMini().find((n) => n.textContent === "▴");
fold.listeners.click.forEach((fn) => fn());
assert.ok(inMini().some((n) => (n.textContent || "").includes("Mark as read")),
	"unfolding gives the whole panel");

// Only the timed item's own tab is off limits — it has the clock in its toolbar.
// Another book's tab is somewhere the timer is just as invisible.
openReaders = [{ itemID: 30, tabID: "tab-book" }, { itemID: 40, tabID: "tab-other" }];
selectedTab = "tab-book";
I.autoMini();
assert.strictEqual(mini().length, 0, "not over the tab of the very thing being timed");
selectedTab = "tab-other";
I.autoMini();
assert.strictEqual(mini().length, 1, "but yes over another book's");
selectedTab = "zotero-pane";
I.autoMini();
assert.strictEqual(mini().length, 1, "and in the library");

// The title is the way back to whatever is being timed.
inMini().find((n) => (n.className || "") === "rt-back").listeners.click.forEach((fn) => fn());
assert.strictEqual(selectedTab, "tab-book", "its title selects the tab it is on");
openReaders = [];
I.autoMini();
inMini().find((n) => (n.className || "") === "rt-back").listeners.click.forEach((fn) => fn());
assert.deepStrictEqual(selected, [1], "with nothing open, it falls back to the library");

inMini().find((n) => n.textContent === "✕").listeners.click.forEach((fn) => fn());
assert.strictEqual(mini().length, 0, "✕ hides it");
I.autoMini();
assert.strictEqual(mini().length, 0, "and it stays hidden for that session");

I.stop();
I.start("stopwatch", book);
I.autoMini();
assert.strictEqual(mini().length, 1, "but the next session shows it again");

// A popup someone actually asked for outranks the corner clock. Taking the one
// panel slot from under it would leave it on screen, unclosable and frozen.
const readerDoc = fakeDoc();
const readerBtn = node("button");
readerBtn.getBoundingClientRect = () => ({ bottom: 20, left: 10 });
I.openPanel({ itemID: 40 }, readerDoc, readerBtn);
assert.strictEqual(mini().length, 0, "opening a reader popup closes the corner clock");
I.autoMini();
assert.strictEqual(readerDoc.body.children.filter((c) => (c.className || "").includes("rt-panel")).length, 1,
	"and the corner clock does not orphan it a second later");
assert.strictEqual(mini().length, 0, "nor put itself back on top of it");
I.closePanel();
I.autoMini();
assert.strictEqual(mini().length, 1, "it comes back once the popup is gone");

// A click that lands after the timer stopped must not throw out of the handler.
I.stop();
assert.doesNotThrow(() => { I.setPaused(true); I.nextPhase(false); }, "no timer, no controls to work");
I.setFolded(true);
I.stop();
I.autoMini();
assert.strictEqual(mini().length, 0, "stopping takes it away");

// (6) Under a minute is a misclick, not reading — dropped rather than filed.
// Unless something was typed against it: that text is someone's, not noise.
I.setDB({ queryAsync: () => Promise.resolve([]) });
I.log.length = 0;
I.start("stopwatch", book2);
I.getTimer().counted = 45;
I.stop();
assert.strictEqual(I.log.length, 0, "a 45-second session is not kept");

I.start("stopwatch", book2);
I.getTimer().counted = 45;
I.getTimer().row.note = "the epigraph";
I.stop();
assert.strictEqual(I.log.length, 1, "but one with a note is");

I.start("stopwatch", book2);
I.getTimer().counted = 60;
I.stop();
assert.strictEqual(I.log.length, 2, "and a full minute is kept on its own");

console.log("ok");
