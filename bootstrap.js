/* Reading Time — a tiny Zotero plugin (bootstrapped, Zotero 7+).
 *
 * Adds a clock button to the reader toolbar with a stopwatch, a pomodoro
 * timer and manual time entry.
 *
 * Storage is the plugin's own `time-tracker.sqlite`, next to zotero.sqlite in
 * the Zotero data directory: one append-only row per reading session, so
 * "how much did I read today" is a SUM away. The whole table is mirrored in
 * memory at startup, which keeps every read (item totals, today, this week)
 * a synchronous array scan.
 * ponytail: linear scans over that mirror — a few thousand rows a year is
 * nothing. If the log ever gets big, query SQLite instead of scanning.
 *
 * No build step: plain bootstrapped plugin. Zip the folder — see README.md.
 */

// Pomodoro phase lengths, in minutes. The focus length is adjustable from the
// popup in 5-minute steps and remembered in a Zotero pref; the break isn't.
const FOCUS_MIN = 25;     // default, before the pref is read
const BREAK_MIN = 5;
const FOCUS_PREF = "readingTime.focusMin";
const FOCUS_RANGE = [5, 120];

const CHECK_IN = 3600;    // seconds of counted time between "still reading?" prompts
const FLUSH_EVERY = 60;   // seconds between DB writes while a timer runs
const ORPHAN_EVERY = 5;   // seconds between "is the book still open?" checks
const MAX_STEP = 5;       // seconds; longer gaps mean the machine slept
const DAY = 86400000;

let active = false;       // between startup() and shutdown()
let focusMin = FOCUS_MIN;
let onRenderToolbar;
let infoRowID = null;     // registration IDs come back namespaced with the
let columnKey = null;     // plugin ID, so keep what register*() returns
let menuID = null;
let itemMenuID = null;
let collectionMenuID = null;
let db = null;            // the usable connection, or null
let dbConn = null;        // every connection we open, usable or not — see openDB()
const log = [];           // every session row, mirrored from the DB
let timer = null;         // the single active timer, or null — see start()
let ticker = null;        // the one interval, running for the whole session
let ticks = 0;
let asking = false;       // a modal prompt is up; a modal spins the event loop,
                          // so the ticker can fire again while we wait
const bars = new Map();   // container element → { reader, doc, btn, label, host, id }
let panel = null;         // the single open popup: { el, btn, cleanup, refresh }

// --- duration parse/format -------------------------------------------------

// "1h 23m", "90", "45s", "-10" → seconds. A bare number means minutes.
function parseDuration(str) {
	let total = 0;
	for (const m of String(str || "").matchAll(/(-?\d+(?:\.\d+)?)\s*([hms])?/gi)) {
		const unit = (m[2] || "m").toLowerCase();
		total += parseFloat(m[1]) * (unit === "h" ? 3600 : unit === "s" ? 1 : 60);
	}
	return total;
}

// Human form: "", "45s", "25m", "1h 23m".
function fmtTotal(sec) {
	if (Math.abs(sec) < 60) return sec ? Math.round(sec) + "s" : "";
	const min = Math.round(sec / 60);
	return Math.abs(min) >= 60 ? `${(min / 60 | 0)}h ${Math.abs(min % 60)}m` : `${min}m`;
}

// The item tree compares cells as strings, so the library column's cell value
// has to be lexically ordered: zero-padded seconds. Always a number, never "" —
// an empty cell is special-cased to sort last ascending, which flips it to the
// top when you sort descending. Unread items belong at the bottom either way.
function sortKey(sec) {
	return String(Math.round(Math.max(0, sec))).padStart(9, "0");
}

// Live form: 12:34 / 1:02:05
function fmtClock(sec) {
	sec = Math.max(0, Math.round(sec));
	const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
	const p = (n) => String(n).padStart(2, "0");
	return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

// --- the session log -------------------------------------------------------

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS sessions (
		id TEXT PRIMARY KEY,
		libraryID INTEGER NOT NULL,
		itemKey TEXT NOT NULL,
		title TEXT,
		mode TEXT NOT NULL,        -- stopwatch | pomodoro | manual
		started INTEGER NOT NULL,  -- unix ms
		seconds INTEGER NOT NULL   -- countable time; manual entries may be negative
	)`,
	`CREATE INDEX IF NOT EXISTS sessions_item ON sessions (libraryID, itemKey)`,
	`CREATE INDEX IF NOT EXISTS sessions_started ON sessions (started)`,
];

const COLS = ["id", "libraryID", "itemKey", "title", "mode", "started", "seconds"];

// <Zotero data dir>/time-tracker.sqlite — ours alone, next to zotero.sqlite.
//
// Opened by absolute path on purpose: that marks it an "external" DB, which
// keeps Zotero from treating it like the library — no WAL, no idle backups, no
// "Checking database integrity…" dialog on the next launch after a force-quit,
// and no corruption handler that could interrupt startup over a time log.
//
// `dbConn` tracks the connection from the moment it exists; `db` is only set
// once it's usable. They are separate because Gecko's Sqlite.sys.mjs holds a
// shutdown blocker that "waits for all connections to be closed before
// shutdown" — an open connection nobody has a reference to hangs Zotero's quit
// forever, and a killed Zotero loses the add-on state it hadn't flushed yet.
// So: every connection we open must be reachable by closeDB(), always.
async function openDB() {
	if (dbConn) await closeDB();   // never run two connections at once
	const conn = new Zotero.DBConnection(Zotero.DataDirectory.getDatabase("time-tracker"));
	dbConn = conn;
	log.length = 0;   // a reopen must not double every session
	try {
		// Best effort: an old version's leftover -wal can make this fail with
		// SQLITE_BUSY, and that must not take the rest of the open down with it.
		await conn.queryAsync("PRAGMA journal_mode = DELETE").catch(oops);
		for (const sql of SCHEMA) await conn.queryAsync(sql);
		for (const row of await conn.queryAsync("SELECT * FROM sessions ORDER BY started")) {
			log.push(Object.fromEntries(COLS.map((c) => [c, row[c]])));  // rows are proxies
		}
	}
	catch (e) {
		await closeDB();
		throw e;
	}
	if (!active) return closeDB();   // shut down while we were opening
	db = conn;                       // only now can anything else use it
	refreshViews();
	paint();
}

async function closeDB() {
	const conn = dbConn;
	db = dbConn = null;
	if (conn) await conn.closeDatabase().catch(oops);
}

const oops = (e) => Zotero.logError(e);

// Zotero dispatches renderToolbar to every plugin from one unguarded loop, so a
// throw in our hook silently kills the toolbar buttons of every plugin after us
// — and inside the 1 Hz tick it would stop the live time updating at all.
// Nothing on those paths is allowed to escape.
function safe(fn, fallback) {
	try { return fn(); } catch (e) { oops(e); return fallback; }
}
const idOf = (item) => item.libraryID + "/" + item.key;

// Modal, on purpose: both callers are guardrails, and a notification you can
// miss is not a guardrail. But never without a window to parent it to — a
// parentless modal can end up invisible and block the app from ever quitting,
// and a quit that never finishes is the next launch failing. No window means
// "no", which stops the timer rather than leaving it running.
function confirm(text) {
	const win = Zotero.getMainWindow();
	if (!win) return false;
	return safe(() => Services.prompt.confirm(win, "Reading time", text), false);
}

// Same rules as confirm(), but with an editable value. Returns null on cancel.
function promptValue(text, initial) {
	const win = Zotero.getMainWindow();
	if (!win) return null;
	return safe(() => {
		const out = { value: initial };
		return Services.prompt.prompt(win, "Reading time", text, out, null, {}) ? out.value : null;
	}, null);
}

// Pure, so test.js can exercise it: total seconds in `rows`, optionally
// limited to one item and/or to sessions started at or after `since`.
function sumSeconds(rows, { since = 0, id = null } = {}) {
	let total = 0;
	for (const r of rows) {
		if (r.started >= since && (!id || r.libraryID + "/" + r.itemKey === id)) total += r.seconds;
	}
	return total;
}

const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

const totalFor = (item) => (item ? sumSeconds(log, { id: idOf(item) }) : 0);

function addRow(item, mode, seconds, started = Date.now()) {
	if (!db) return null;
	const row = {
		id: Zotero.Utilities.randomString(12),
		libraryID: item.libraryID, itemKey: item.key,
		title: item.getDisplayTitle(), mode, started, seconds: Math.round(seconds),
	};
	log.push(row);
	db.queryAsync(`INSERT INTO sessions (${COLS.join(", ")}) VALUES (${COLS.map(() => "?").join(", ")})`,
		COLS.map((c) => row[c])).catch(oops);
	return row;
}

function saveRow(row) {
	if (!db) return;   // nothing to write to; the in-memory log still has it
	db.queryAsync("UPDATE sessions SET seconds = ?, title = ? WHERE id = ?",
		[row.seconds, row.title, row.id]).catch(oops);
}

function dropRow(row) {
	const i = log.indexOf(row);
	if (i >= 0) log.splice(i, 1);
	if (!db) return;
	db.queryAsync("DELETE FROM sessions WHERE id = ?", [row.id]).catch(oops);
}

// The reader is attached to an attachment; time belongs on its parent, if any.
// Zotero.Items.get() throws UnloadedDataException when an id is known but the
// object isn't in the cache yet — routine while tabs are still settling.
function itemOf(reader) {
	return safe(() => {
		const att = reader && Zotero.Items.get(reader.itemID);
		return (att && att.parentItem) || att || null;
	}, null);
}

// --- timer -----------------------------------------------------------------

const phaseLen = () => (timer.phase === "focus" ? focusMin : BREAK_MIN) * 60;

// Adjusting a running focus phase changes what's left of it right away — down
// far enough and it simply ends, which is the honest reading of "make it
// shorter" while you're already past the new length.
function bumpFocus(delta) {
	focusMin = Math.min(FOCUS_RANGE[1], Math.max(FOCUS_RANGE[0], focusMin + delta));
	safe(() => Zotero.Prefs.set(FOCUS_PREF, focusMin));
	paint();
}

// Fold the currently-running segment into the accumulators, so everything else
// can just read them — including the live row, which keeps today's total honest
// while a timer is still running.
function absorb() {
	if (!timer) return;
	if (timer.running) {
		// Clamped: the ticker runs every second, so a longer gap means the
		// machine slept or the timer stalled — that time wasn't spent reading.
		const d = Math.min((Date.now() - timer.segStart) / 1000, MAX_STEP);
		timer.segStart = Date.now();
		timer.phaseElapsed += d;
		if (timer.phase === "focus") timer.counted += d;  // breaks don't count
	}
	timer.row.seconds = Math.round(timer.counted);
}

// One timer, ever: two running at once would double-count the same stretch of
// time, and the second one to stop would be the one you didn't mean to keep.
// Taking over from another item is allowed, but never silently.
function start(mode, item) {
	if (!db) return;
	if (timer && !isMine(item)) {
		const other = timer.row.title || "another item";
		if (!confirm(`A ${timer.mode} has been running on “${other}” for ${fmtTotal(timer.counted)}.\n\nStop it and start timing this item instead?`)) return;
	}
	if (timer) stop();  // flush the old one first
	timer = {
		id: idOf(item), mode, row: addRow(item, mode, 0), capAt: CHECK_IN,
		counted: 0, running: true, segStart: Date.now(),
		phase: "focus", phaseElapsed: 0,
	};
	ticks = 0;
	paint();
}

function setPaused(paused) {
	absorb();
	timer.running = !paused;
	timer.segStart = Date.now();
	saveRow(timer.row);
	paint();
	refreshViews();
}

function stop(discard) {
	if (!timer) return;
	absorb();
	// A started-and-immediately-stopped timer isn't history worth keeping.
	if (discard || timer.row.seconds < 1) dropRow(timer.row);
	else saveRow(timer.row);
	timer = null;
	paint();
	refreshViews();
}

function nextPhase(auto) {
	absorb();
	timer.phase = timer.phase === "focus" ? "break" : "focus";
	timer.phaseElapsed = 0;
	timer.segStart = Date.now();
	saveRow(timer.row);
	if (auto) alertPhase();
	paint();
}

// One interval for the session, not just while a timer runs: paint() is also
// what notices a missing toolbar button and puts it back, and buttons go
// missing whether or not you happen to be timing something.
// ponytail: a fixed 1 Hz walk over at most a handful of open readers — make it
// adaptive only if it ever shows up in a profile.
function pulse() {
	// Zotero deletes a plugin's scope on shutdown but does not nuke the sandbox,
	// so an interval that outlives us keeps running. `active` is cleared first
	// thing in shutdown, which stops an old instance from redrawing — or from
	// putting its own toolbar button back next to the new instance's.
	if (!active) return;
	safe(() => (timer ? tick() : paint()));
}

function tick() {
	ticks++;
	safe(absorb);
	if (ticks % ORPHAN_EVERY === 0) safe(checkOrphaned);
	if (!timer) return paint();   // the check may have stopped it
	// Each step can drop the timer (a check-in answered with "stop"), so re-test
	// it — and reach paint() no matter which of them did what.
	if (timer && timer.running && timer.counted >= timer.capAt) askCheckIn();
	else if (timer && timer.mode === "pomodoro" && timer.running && timer.phaseElapsed >= phaseLen()) safe(() => nextPhase(true));
	if (timer && timer.running && ticks % FLUSH_EVERY === 0) safe(() => saveRow(timer.row));
	paint();
}

// A timer left running logs a walk away from the desk as reading. Every hour we
// pause first — so answering never costs time — and ask what to actually keep.
// The prompt is pre-filled with the elapsed time: confirm it, correct it, or
// cancel to stop the timer with what's already counted.
function askCheckIn() {
	if (asking) return;
	asking = true;
	setPaused(true);
	const counted = timer.counted;
	const answer = promptValue(
		`This timer has been running for ${fmtTotal(counted)} without a stop.\n\n`
		+ `How much of it was actually reading? Cancel stops the timer and keeps ${fmtTotal(counted)}.`,
		fmtTotal(counted));
	asking = false;
	if (!timer) return;              // stopped from elsewhere while the prompt was up
	if (answer === null) return stop();
	const keep = parseDuration(answer);
	if (keep <= 0) return stop(true);   // nothing worth keeping — drop the session
	timer.counted = keep;
	timer.capAt = keep + CHECK_IN;
	setPaused(false);
}

function notify(text, beep) {
	try {
		const pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline(text);
		pw.show();
		pw.startCloseTimer(6000);
		if (beep) Components.classes["@mozilla.org/sound;1"].getService(Components.interfaces.nsISound).beep();
	} catch (e) { oops(e); }
}

function alertPhase() {
	notify(timer.phase === "focus"
		? `🍅 Break over — ${focusMin} min of reading`
		: `☕ Time for a ${BREAK_MIN} min break`, true);
}

// Closing the book ends the sitting. A timer whose item has no reader open
// anywhere is counting time nobody is spending, and with its toolbar gone there
// is nothing on screen to notice it by. Two strikes a few seconds apart, so a
// reader that is merely mid-initialisation doesn't count as closed.
// Three answers, not two: open, not open, or "can't tell". A reader whose item
// isn't in Zotero's cache right now resolves to null, and counting that as
// closed would stop a timer on a tab sitting right in front of you — which is
// easy to hit while switching tabs, since that is when items load and unload.
function readerOpenFor(id) {
	const readers = Zotero.Reader._readers || [];
	if (!readers.length) return false;                    // nothing open anywhere
	const ids = readers.map((r) => safe(() => idFor(r), null));
	if (ids.includes(id)) return true;
	return ids.some(Boolean) ? false : null;              // none resolved → unknown
}

function checkOrphaned() {
	const open = readerOpenFor(timer.id);
	if (open !== false) {
		if (open) timer.orphaned = 0;   // null: hold the count, we simply don't know
		return;
	}
	if ((timer.orphaned = (timer.orphaned || 0) + 1) < 2) return;
	const kept = fmtTotal(timer.counted);
	const what = timer.row && timer.row.title;
	stop();
	notify(`⏹ Timer stopped — ${what ? `“${what}” was closed` : "the tab was closed"}${kept ? `, kept ${kept}` : ""}`);
}

// Text shown next to the clock button (and big inside the popup).
function liveText() {
	const pre = timer.running ? "" : "⏸ ";
	if (timer.mode === "stopwatch") return pre + "⏱ " + fmtClock(timer.counted);
	return pre + (timer.phase === "focus" ? "🍅 " : "☕ ") + fmtClock(phaseLen() - timer.phaseElapsed);
}

const isMine = (item) => !!(timer && item && timer.id === idOf(item));

// --- toolbar ---------------------------------------------------------------

const CSS = `
/* The live time rides inside the button, so the toolbar's fixed-size grid
   doesn't wrap it onto a second row. */
.rt-btn { display:inline-flex; align-items:center; gap:4px;
	width:auto !important; min-width:auto !important; flex:0 0 auto;
	padding:0 5px; font-size:15px; background:none; border:none; cursor:pointer; }
.rt-live { font:12px/1 sans-serif; opacity:.85; white-space:nowrap; }
.rt-live:empty { display:none; }
.rt-panel { position:fixed; z-index:99999; width:260px; box-sizing:border-box;
	background:Canvas; color:CanvasText; border:1px solid GrayText; border-radius:6px;
	box-shadow:0 2px 10px rgba(0,0,0,.25); font:13px sans-serif; padding:10px; }
.rt-panel .rt-row { display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
.rt-panel .rt-muted { color:GrayText; font-size:11px; }
.rt-panel .rt-total { font-weight:700; }
.rt-panel .rt-big { font:600 22px/1.3 sans-serif; text-align:center; padding:6px 0 2px; }
.rt-panel .rt-actions { display:flex; gap:6px; margin-top:8px; }
.rt-panel button { flex:1; font:12px sans-serif; padding:5px 6px; border:1px solid GrayText;
	border-radius:5px; background:transparent; color:CanvasText; cursor:pointer; white-space:nowrap; }
.rt-panel button:hover { background:Highlight; color:HighlightText; }
.rt-panel .rt-add { display:flex; gap:6px; margin-top:8px; border-top:1px solid GrayText; padding-top:8px; }
.rt-panel .rt-add input { flex:1; min-width:0; box-sizing:border-box; padding:4px 6px; font:12px sans-serif; }
.rt-panel .rt-add button { flex:0 0 auto; }
.rt-panel .rt-pom { display:flex; align-items:center; gap:6px; margin-top:8px; }
/* a class rule with display beats the UA's [hidden], so say it again */
.rt-panel .rt-pom[hidden] { display:none; }
.rt-panel .rt-pom .rt-muted { flex:1; }
.rt-panel .rt-pom button { flex:0 0 auto; padding:2px 8px; }
`;

function injectCSS(doc) {
	if (doc.getElementById("rt-css")) return;
	const style = doc.createElement("style");
	style.id = "rt-css";
	style.textContent = CSS;
	(doc.head || doc.documentElement).append(style);
}

// A toolbar's item, resolved once and kept. Resolving it per tick meant a
// single Items.get() miss — it throws UnloadedDataException for an id that is
// known but not in the cache — blanked the live time in both the button and the
// popup while the timer went on counting. The id can't change for a given
// reader, so there is nothing to re-resolve.
function idFor(reader) {
	const item = itemOf(reader);
	return item ? idOf(item) : null;
}

// Build the clock button and its live-time label.
function makeButton(doc, reader) {
	const btn = doc.createElement("button");
	btn.className = "toolbar-button rt-btn";
	btn.title = "Reading time";
	const label = el(doc, "span", "rt-live");
	btn.append(el(doc, "span", null, "🕐"), label);
	btn.addEventListener("click", () => togglePanel(reader, doc, btn));
	return { btn, label };
}

// The reader wipes its custom-section container and re-fires this on every
// render, so a bar is only ever as current as the last render. Key by that
// container: re-renders replace the entry instead of piling up, and paint()
// has something stable to put the button back into.
function renderButton(event) {
	const { reader, doc, append } = event;
	injectCSS(doc);
	const { btn, label } = makeButton(doc, reader);
	append(btn);
	const host = (btn.parentElement && btn.parentElement.parentElement) || null;
	bars.set(host || doc, { reader, doc, btn, label, host, id: idFor(reader) });
	paint();
}

// Put a button back into a container that still exists but no longer has ours.
function restoreButton(bar) {
	const section = el(bar.doc, "div", "section");
	const { btn, label } = makeButton(bar.doc, bar.reader);
	section.append(btn);
	bar.host.append(section);
	bar.btn = btn;
	bar.label = label;
}

// After an upgrade our buttons left with the old sandbox, and Zotero only
// re-fires renderToolbar when the reader next renders — which may be never for
// a tab you are already looking at. Claim the open ones now.
function adoptOpenReaders() {
	for (const reader of (Zotero.Reader._readers || [])) safe(() => {
		const doc = reader._iframeWindow && reader._iframeWindow.document;
		const host = doc && doc.querySelector(".toolbar .custom-sections");
		if (!host || bars.has(host)) return;
		for (const stray of host.querySelectorAll(".rt-btn")) (stray.parentElement || stray).remove();
		injectCSS(doc);
		const bar = { reader, doc, host, btn: null, label: null, id: idFor(reader) };
		restoreButton(bar);
		bars.set(host, bar);
	});
	paint();
}

// One toolbar. Returns false when the bar is finished with, for any reason.
function paintBar(bar) {
	if (!bar.doc.defaultView) return false;              // reader tab closed
	if (!bar.id) bar.id = idFor(bar.reader);             // wasn't loaded when we rendered
	if (!bar.btn.isConnected) {
		// Zotero dispatches renderToolbar to every plugin from a single
		// unguarded loop, so if a peer registered before us throws, our turn
		// never comes and the button stays missing until some later render.
		// If the container is still there, put it back ourselves.
		if (!bar.host || !bar.host.isConnected) return false;
		restoreButton(bar);
	}
	// An older instance whose shutdown didn't finish can keep re-adding its own
	// button beside ours. One toolbar, one clock: ours is the one in `bars`.
	if (bar.host) {
		for (const other of bar.host.querySelectorAll(".rt-btn")) {
			if (other !== bar.btn) (other.parentElement || other).remove();
		}
	}
	bar.label.textContent = (timer && bar.id === timer.id) ? liveText() : "";
	return true;
}

// The library column and the item-pane row cache their values, so nudge them
// when a total settles. Never on the 1 Hz tick — refreshing the column rebuilds
// the tree; the live count belongs in the toolbar button, not the library view.
function refreshViews() {
	if (!active) return;  // don't rebuild the item tree while Zotero is tearing down
	try { if (columnKey) Zotero.ItemTreeManager.refreshColumns(); } catch (e) { oops(e); }
	try { if (infoRowID) Zotero.ItemPaneManager.refreshInfoRow(infoRowID); } catch (e) { oops(e); }
}

function paint() {
	for (const [key, bar] of [...bars]) {
		// Every property read above can throw "can't access dead object" once a
		// reader tab is closed and its document is collected. Unguarded, one dead
		// bar ends the whole loop before the live toolbar or the popup is
		// reached — and since it is never removed, it does that again every
		// second: both displays freeze for good. Guard per bar, drop on failure.
		if (!safe(() => paintBar(bar), false)) bars.delete(key);
	}
	if (panel) safe(() => { if (panel.el.isConnected) panel.refresh(); else closePanel(); });
}

// --- popup -----------------------------------------------------------------

function el(doc, tag, cls, text) {
	const e = doc.createElement(tag);
	if (cls) e.className = cls;
	if (text != null) e.textContent = text;
	return e;
}

function togglePanel(reader, doc, btn) {
	const same = panel && panel.btn === btn;
	closePanel();
	if (!same) openPanel(reader, doc, btn);
}

function closePanel() {
	if (!panel) return;
	panel.cleanup();
	panel.el.remove();
	panel = null;
}

function openPanel(reader, doc, btn) {
	// Sweep anything an earlier open may have left behind. A stray box would sit
	// there forever: unclosable, because closePanel() bails when `panel` is null,
	// and frozen, because paint() only refreshes what `panel` points at.
	for (const stray of doc.querySelectorAll(".rt-panel")) stray.remove();

	const box = el(doc, "div", "rt-panel");
	const rect = btn.getBoundingClientRect();
	const vw = (doc.defaultView && doc.defaultView.innerWidth) || 800;
	box.style.top = rect.bottom + 4 + "px";
	box.style.left = Math.max(8, Math.min(rect.left, vw - 268)) + "px";
	doc.body.append(box);

	// Publish the panel before filling it, so however the rest of this function
	// goes, what is on screen is always what closePanel() and paint() act on.
	panel = { el: box, btn, cleanup: () => {}, refresh: () => {} };
	panel.cleanup = watchOutside(reader, doc, box, btn);
	tryFill(doc, box, reader);
}

// The item may not be in Zotero's cache the instant you open the popup on a tab
// you just switched to, and the database may still be loading. Neither is a
// dead end, so wait for them on the 1 Hz pulse instead of showing a refusal.
function tryFill(doc, box, reader) {
	const item = itemOf(reader);
	if (!item || !db) {
		box.replaceChildren(el(doc, "div", "rt-muted", db ? "Loading item…" : "Loading sessions…"));
		panel.refresh = () => safe(() => tryFill(doc, box, reader));
		return;
	}
	box.replaceChildren();
	panel.refresh = () => {};
	safe(() => fillPanel(doc, box, item));   // sets panel.refresh when it succeeds
	safe(() => panel.refresh());
}

// Close on a click outside or on Escape. The document sits in a nested iframe,
// so events there never reach the reader document — listen on both. Touching a
// torn-down view's window can throw ("dead object"), hence the guard.
function watchOutside(reader, doc, box, btn) {
	const onDown = (e) => { if (!box.contains(e.target) && e.target !== btn) closePanel(); };
	const onKey = (e) => { if (e.key === "Escape") closePanel(); };
	const docs = [doc];
	const inner = safe(() => reader._internalReader._primaryView._iframeWindow.document, null);
	if (inner && inner !== doc) docs.push(inner);
	for (const d of docs) {
		d.addEventListener("pointerdown", onDown, true);
		d.addEventListener("keydown", onKey, true);
	}
	return () => {
		for (const d of docs) {
			d.removeEventListener("pointerdown", onDown, true);
			d.removeEventListener("keydown", onKey, true);
		}
	};
}

function fillPanel(doc, box, item) {
	// Stats: this item, plus today and the last 7 days across the whole library.
	const stats = [["This item", () => totalFor(item)],
		["Today", () => sumSeconds(log, { since: startOfDay(Date.now()) })],
		["Last 7 days", () => sumSeconds(log, { since: startOfDay(Date.now() - 6 * DAY) })]];
	const values = stats.map(([name]) => {
		const row = el(doc, "div", "rt-row");
		const value = el(doc, "span", "rt-total");
		row.append(el(doc, "span", "rt-muted", name), value);
		box.append(row);
		return value;
	});

	const big = el(doc, "div", "rt-big");
	const actions = el(doc, "div", "rt-actions");
	const note = el(doc, "div", "rt-muted");
	box.append(big, actions, note);

	const add = el(doc, "div", "rt-add");
	const input = doc.createElement("input");
	input.type = "text";
	input.placeholder = "25m, 1h 30m, -10m";
	input.addEventListener("keydown", (e) => {
		if (e.key === "Escape") return;  // let it bubble so the panel closes
		e.stopPropagation();             // keys must not trigger reader shortcuts
		if (e.key === "Enter") submit();
	});
	const addBtn = el(doc, "button", null, "Add");
	addBtn.addEventListener("click", () => submit());
	add.append(input, addBtn);
	const more = el(doc, "button", null, "📊 History for this item…");
	more.style.marginTop = "8px";
	more.addEventListener("click", () => { closePanel(); openHistory(itemFilter(item)); });
	box.append(add, more);

	// Manual time is just another row in the log — negative to subtract.
	const submit = () => {
		const delta = parseDuration(input.value);
		if (!delta) return;
		input.value = "";
		addRow(item, "manual", delta);
		paint();
		refreshViews();
	};

	const button = (text, fn) => {
		const b = el(doc, "button", null, text);
		b.addEventListener("click", fn);
		return b;
	};

	// Focus length, adjustable before or during a run.
	const pom = el(doc, "div", "rt-pom");
	const pomLabel = el(doc, "span", "rt-muted");
	const less = button("−5", () => bumpFocus(-5));
	const more5 = button("+5", () => bumpFocus(5));
	less.title = more5.title = "Pomodoro focus length";
	pom.append(pomLabel, less, more5);
	box.insertBefore(pom, add);

	// "Armed" is pomodoro chosen but not started: the length is on screen to be
	// adjusted, and nothing is counting until Start.
	let armed = false;
	let key = null;
	const refresh = () => {
		pomLabel.textContent = `🍅 Focus ${focusMin}m`;
		stats.forEach(([, get], i) => { values[i].textContent = fmtTotal(safe(get, 0)) || "0m"; });
		const mine = isMine(item);
		const pomo = armed || (mine && timer.mode === "pomodoro");
		big.textContent = mine ? liveText() : (armed ? "🍅 " + fmtClock(focusMin * 60) : "");
		big.style.display = mine || armed ? "" : "none";
		pom.hidden = !pomo;
		// Rebuild the buttons only when the state they depend on changes.
		const k = mine ? `${timer.mode}/${timer.running}/${timer.phase}`
			: timer ? "other" : armed ? "armed" : "idle";
		if (k === key) return;
		key = k;
		actions.replaceChildren();
		if (mine) {
			actions.append(
				button(timer.running ? "⏸ Pause" : "▶ Resume", () => setPaused(timer.running)),
				button("⏹ Stop", () => stop()));
			if (timer.mode === "pomodoro") actions.append(button("⏭ Skip", () => nextPhase(false)));
		} else if (armed) {
			actions.append(
				button("▶ Start", () => { armed = false; start("pomodoro", item); }),
				button("Cancel", () => { armed = false; refresh(); }));
		} else {
			actions.append(
				button("⏱ Stopwatch", () => start("stopwatch", item)),
				button("🍅 Pomodoro", () => { armed = true; refresh(); }));
		}
		note.textContent = k === "other" ? "A timer is running on another item." : "";
	};

	panel.refresh = refresh;
}

// --- history window --------------------------------------------------------

// Roll the flat session log up into days, and each day into items. Pure, so
// test.js can check it; the window is just this shape turned into DOM.
function historyByDay(rows) {
	const days = new Map();
	for (const r of rows) {
		const day = startOfDay(r.started);
		if (!days.has(day)) days.set(day, new Map());
		const items = days.get(day);
		const id = r.libraryID + "/" + r.itemKey;
		const e = items.get(id) || { id, libraryID: r.libraryID, itemKey: r.itemKey, title: "", seconds: 0, sessions: 0, rows: [] };
		e.seconds += r.seconds;
		e.sessions += 1;
		e.rows.push(r);
		if (r.title) e.title = r.title;   // the most recent title wins
		items.set(id, e);
	}
	return [...days.keys()].sort((a, b) => b - a).map((day) => {
		const items = [...days.get(day).values()].sort((a, b) => b.seconds - a.seconds);
		return { day, seconds: items.reduce((t, e) => t + e.seconds, 0), items };
	});
}

// A GitHub-style calendar: `weeks` columns of 7 days ending with the current
// week, Monday first. Future days in the current week come back null so the
// last column stops at today. Walks with setDate() rather than adding 86400000
// so a DST change doesn't skip or repeat a day.
function heatmapWeeks(rows, now, weeks = 53) {
	const byDay = new Map();
	for (const r of rows) {
		const d = startOfDay(r.started);
		byDay.set(d, (byDay.get(d) || 0) + r.seconds);
	}
	const today = startOfDay(now);
	const cur = new Date(today);
	cur.setDate(cur.getDate() - ((cur.getDay() + 6) % 7) - (weeks - 1) * 7);  // Monday of the first week
	const out = [];
	for (let w = 0; w < weeks; w++) {
		const week = [];
		for (let i = 0; i < 7; i++) {
			const day = cur.getTime();
			week.push(day > today ? null : { day, seconds: byDay.get(day) || 0 });
			cur.setDate(cur.getDate() + 1);
		}
		out.push(week);
	}
	return out;
}

// Five buckets, GitHub-style: nothing, a look, a sitting, a session, a day of it.
const level = (sec) => sec <= 0 ? 0 : sec < 900 ? 1 : sec < 2700 ? 2 : sec < 7200 ? 3 : 4;

// Session rows carry the title the item had when they were logged, so renaming
// an item in Zotero would leave its past sessions showing the old name. Ask the
// item what it is called now, and fall back to the stored name for items that
// no longer exist — which is the reason to keep storing it at all.
function currentTitle(e) {
	return safe(() => {
		const id = Zotero.Items.getIDFromLibraryAndKey(e.libraryID, e.itemKey);
		const item = id && Zotero.Items.get(id);
		return (item && item.getDisplayTitle()) || null;
	}, null);
}

// Sum seconds per group, given a lookup from a row to the groups it belongs to.
// An item in several collections counts in each of them, so these totals can
// add up to more than the time actually spent — that is the honest answer to
// "how much have I read in this collection". Pure, so test.js can check it.
function rollUp(rows, groupsOf) {
	const totals = new Map();
	for (const r of rows) {
		for (const g of groupsOf(r)) totals.set(g, (totals.get(g) || 0) + r.seconds);
	}
	return totals;
}

// Every collection an item sits in, plus their ancestors: time in a
// sub-collection counts towards the parent, which is what people mean by
// "how much have I read in this project".
function collectionsOf(item) {
	const out = new Set();
	for (const id of safe(() => item.getCollections(), [])) {
		let c = Zotero.Collections.get(id);
		// Stop at the first ancestor already seen — its own ancestors are in too.
		while (c && !out.has(c.id)) {
			out.add(c.id);
			c = c.parentID ? Zotero.Collections.get(c.parentID) : null;
		}
	}
	return out;
}

// Collections with time in `rows`, biggest first. Membership is asked of Zotero
// now rather than stored per session: collections change, sessions don't.
function byCollection(rows) {
	const cache = new Map();
	const groupsOf = (r) => {
		const key = r.libraryID + "/" + r.itemKey;
		if (!cache.has(key)) {
			cache.set(key, safe(() => {
				const id = Zotero.Items.getIDFromLibraryAndKey(r.libraryID, r.itemKey);
				const item = id && Zotero.Items.get(id);
				return item ? collectionsOf(item) : [];
			}, []));
		}
		return cache.get(key);
	};
	return [...rollUp(rows, groupsOf)]
		.map(([id, seconds]) => ({ id, seconds, name: safe(() => Zotero.Collections.get(id).name, null) }))
		.filter((c) => c.name && c.seconds > 0)
		.sort((a, b) => b.seconds - a.seconds);
}

function dayLabel(ms) {
	if (ms === startOfDay(Date.now())) return "Today";
	if (ms === startOfDay(Date.now() - DAY)) return "Yesterday";
	return new Date(ms).toLocaleDateString(undefined,
		{ weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

const HISTORY_CSS = `
body { margin:0; padding:16px; font:13px sans-serif; background:Canvas; color:CanvasText; }
h1 { font-size:15px; margin:0 0 12px; }
.sums { display:flex; gap:8px; margin-bottom:16px; }
.sums div { flex:1; border:1px solid GrayText; border-radius:6px; padding:8px; text-align:center; }
.sums b { display:block; font-size:15px; }
.sums span { color:GrayText; font-size:11px; }
.day { display:flex; justify-content:space-between; align-items:baseline; gap:8px;
	margin:16px 0 4px; padding-bottom:3px; border-bottom:1px solid GrayText; font-weight:700; }
.item { display:flex; align-items:baseline; gap:8px; padding:3px 4px; border-radius:4px; cursor:pointer; }
.item:hover { background:Highlight; color:HighlightText; }
.item .t { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.item .n { color:GrayText; font-size:11px; white-space:nowrap; }
.item:hover .n { color:HighlightText; }
.item b { font-variant-numeric:tabular-nums; white-space:nowrap; }
.empty { color:GrayText; padding:24px 0; text-align:center; }
.top { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.item button { font:10px sans-serif; padding:0 5px; border:1px solid transparent;
	border-radius:4px; background:transparent; color:inherit; cursor:pointer; }
.item:hover button { border-color:HighlightText; }
.top button, .session button { font:11px sans-serif; padding:2px 8px; border:1px solid GrayText;
	border-radius:5px; background:transparent; color:CanvasText; cursor:pointer; }
.top button:hover, .session button:hover { background:Highlight; color:HighlightText; }
.item .caret { color:GrayText; font-size:9px; width:9px; }
.coll { padding-left:10px; }
.day .rt-muted { font-weight:400; }
.item:hover .caret { color:HighlightText; }
.sessions { margin:0 0 4px 18px; }
.session { display:flex; align-items:baseline; gap:8px; padding:2px 4px; font-size:12px; color:GrayText; }
.session .when { font-variant-numeric:tabular-nums; }
.session .mode { flex:1; min-width:0; }
.session b { color:CanvasText; font-variant-numeric:tabular-nums; }
.session .act { display:flex; gap:4px; align-items:center; }

/* heatmap */
body { --l0:#ebedf0; --l1:#9be9a8; --l2:#40c463; --l3:#30a14e; --l4:#216e39; }
@media (prefers-color-scheme: dark) {
	body { --l0:#2a2f35; --l1:#0e4429; --l2:#006d32; --l3:#26a641; --l4:#39d353; }
}
.hm { display:flex; gap:4px; align-items:flex-start; overflow-x:auto; padding-bottom:4px; }
.hm-wd, .hm-cols { display:grid; grid-template-rows:repeat(7, 10px); gap:3px; }
.hm-cols { grid-auto-flow:column; grid-auto-columns:10px; }
.hm-wd { margin-top:12px; }  /* clear the month row so the rows line up */
.hm-wd span { font-size:9px; line-height:10px; color:GrayText; padding-right:2px; }
.hm-months { display:grid; grid-auto-flow:column; grid-auto-columns:10px; gap:3px; height:12px; }
.hm-months span { font-size:9px; color:GrayText; white-space:nowrap; }
.hm-cols i { border-radius:2px; background:var(--l0); }
.hm-cols i[data-l="1"] { background:var(--l1); }
.hm-cols i[data-l="2"] { background:var(--l2); }
.hm-cols i[data-l="3"] { background:var(--l3); }
.hm-cols i[data-l="4"] { background:var(--l4); }
.hm-cols i[data-l] { cursor:pointer; }
.hm-cols i.blank { background:transparent; }
.legend { display:flex; align-items:center; gap:3px; justify-content:flex-end;
	font-size:10px; color:GrayText; margin:2px 0 16px; }
.legend i { width:10px; height:10px; border-radius:2px; background:var(--l0); }
`;

let historyWin = null;
let historyFilter = null;   // { title, match(row) } — one item, one collection, or null

const inFilter = (r) => !historyFilter || historyFilter.match(r);

function itemFilter(item) {
	const id = idOf(item);
	return { title: item.getDisplayTitle(), match: (r) => r.libraryID + "/" + r.itemKey === id };
}

// Membership is resolved once, when the filter is made: every item in the
// collection and in everything below it.
function collectionFilter(collection) {
	const keys = new Set();
	const add = (c) => {
		for (const it of safe(() => c.getChildItems(), [])) keys.add(it.libraryID + "/" + it.key);
	};
	add(collection);
	for (const sub of safe(() => collection.getDescendents(false, "collection"), [])) {
		const c = Zotero.Collections.get(sub.id);
		if (c) add(c);
	}
	return { title: collection.name, match: (r) => keys.has(r.libraryID + "/" + r.itemKey) };
}

function openHistory(filter) {
	const main = Zotero.getMainWindow();
	if (!main) return;
	historyFilter = filter || null;
	if (historyWin && !historyWin.closed) {
		historyWin.focus();
		return safe(() => buildHistory(historyWin));
	}
	// about:blank rather than a packaged XHTML: opened from a chrome window it
	// inherits chrome privileges, and the whole document is built here anyway.
	historyWin = main.openDialog("about:blank", "reading-time-history",
		"chrome,centerscreen,resizable,scrollbars,width=800,height=700");
	if (!historyWin) return;
	const build = () => safe(() => buildHistory(historyWin));
	if (historyWin.document.readyState === "complete") build();
	else historyWin.addEventListener("load", build, { once: true });
}

// The calendar, its month row and its legend, as two block elements.
function heatmapEls(doc, rows) {
	const weeks = heatmapWeeks(rows, Date.now());

	const months = el(doc, "div", "hm-months");
	const cols = el(doc, "div", "hm-cols");
	let lastMonth = -1;
	weeks.forEach((week, w) => {
		const first = week.find(Boolean);
		const month = first ? new Date(first.day).getMonth() : lastMonth;
		// Label a column when its month is new, except in the last two columns
		// where the text would run off the end.
		const label = month !== lastMonth && w < weeks.length - 2
			? new Date(first.day).toLocaleDateString(undefined, { month: "short" }) : "";
		months.append(el(doc, "span", null, label));
		lastMonth = month;

		for (const cell of week) {
			const box = el(doc, "i");
			cols.append(box);
			if (!cell) { box.className = "blank"; continue; }  // future days in this week
			box.dataset.l = level(cell.seconds);
			box.title = (fmtTotal(cell.seconds) || "Nothing") + " — " + new Date(cell.day)
				.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
			box.addEventListener("click", () => {
				const anchor = doc.getElementById("d" + cell.day);
				if (anchor) anchor.scrollIntoView({ block: "center", behavior: "smooth" });
			});
		}
	});

	const wd = el(doc, "div", "hm-wd");
	for (const d of ["Mon", "", "Wed", "", "Fri", "", ""]) wd.append(el(doc, "span", null, d));

	const stack = el(doc, "div");
	stack.append(months, cols);
	const grid = el(doc, "div", "hm");
	grid.append(wd, stack);

	const legend = el(doc, "div", "legend");
	legend.append(el(doc, "span", null, "Less"));
	for (let l = 0; l <= 4; l++) {
		const box = el(doc, "i");
		if (l) box.dataset.l = l;
		legend.append(box);
	}
	legend.append(el(doc, "span", null, "More"));
	return [grid, legend];
}

// One logged session: when it started, how it was tracked, how long — and the
// two things you can do to it. Editing writes an absolute duration; 0 deletes.
function sessionRow(doc, win, r) {
	const line = el(doc, "div", "session");
	const live = !!(timer && timer.row === r);
	line.append(
		el(doc, "span", "when", new Date(r.started).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })),
		el(doc, "span", "mode", r.mode),
		el(doc, "b", null, live ? "running" : (fmtTotal(r.seconds) || "0s")));

	const act = el(doc, "span", "act");
	if (live) {
		act.append(el(doc, "span", "n", "stop the timer to edit"));
	} else {
		const edit = el(doc, "button", null, "✎");
		edit.title = "Change this session's duration";
		edit.addEventListener("click", (e) => { e.stopPropagation(); editSession(win, r); });
		const del = el(doc, "button", null, "✕");
		del.title = "Delete this session";
		del.addEventListener("click", (e) => { e.stopPropagation(); deleteSession(win, r); });
		act.append(edit, del);
	}
	line.append(act);
	line.addEventListener("click", (e) => e.stopPropagation());  // don't collapse the list
	return line;
}

function editSession(win, r) {
	const answer = promptValue(
		`Session on ${new Date(r.started).toLocaleString()}.\n\nNew duration (0 deletes it):`,
		fmtTotal(r.seconds) || "0s");
	if (answer === null) return;
	const sec = Math.round(parseDuration(answer));
	if (sec <= 0) dropRow(r);
	else { r.seconds = sec; saveRow(r); }
	refreshViews();
	paint();
	safe(() => buildHistory(win));
}

function deleteSession(win, r) {
	if (!confirm(`Delete this ${fmtTotal(r.seconds) || "0s"} session from ${new Date(r.started).toLocaleString()}?`)) return;
	dropRow(r);
	refreshViews();
	paint();
	safe(() => buildHistory(win));
}

function buildHistory(win) {
	const doc = win.document;
	const main = Zotero.getMainWindow();
	const rows = log.filter(inFilter);
	doc.title = "Reading time";
	doc.head.replaceChildren(el(doc, "style", null, HISTORY_CSS));

	const head = el(doc, "div", "top");
	head.append(el(doc, "h1", null, historyFilter ? historyFilter.title : "Reading time"));
	if (historyFilter) {
		const all = el(doc, "button", null, "← All items");
		all.addEventListener("click", () => { historyFilter = null; safe(() => buildHistory(win)); });
		head.append(all);
	}
	doc.body.replaceChildren(head);

	const sums = el(doc, "div", "sums");
	const spans = [["Today", 0], ["Last 7 days", 6], ["Last 30 days", 29], ["All time", null]];
	for (const [name, back] of spans) {
		const box = el(doc, "div");
		const since = back === null ? 0 : startOfDay(Date.now() - back * DAY);
		box.append(el(doc, "b", null, fmtTotal(sumSeconds(rows, { since })) || "0m"),
			el(doc, "span", null, name));
		sums.append(box);
	}
	doc.body.append(sums);
	doc.body.append(...heatmapEls(doc, rows));

	const colls = byCollection(rows);
	if (colls.length > 1) {
		const head2 = el(doc, "div", "day");
		head2.append(el(doc, "span", null, "By collection"),
			el(doc, "span", "rt-muted", "sub-collections included"));
		doc.body.append(head2);
		const SHOWN = 12;
		for (const c of colls.slice(0, SHOWN)) {
			const row = el(doc, "div", "item coll");
			row.append(el(doc, "span", "t", c.name), el(doc, "b", null, fmtTotal(c.seconds) || "0m"));
			row.title = "Show only this collection";
			row.addEventListener("click", () => safe(() => {
				const collection = Zotero.Collections.get(c.id);
				if (!collection) return;
				historyFilter = collectionFilter(collection);
				buildHistory(win);
			}));
			doc.body.append(row);
		}
		// No silent truncation: say what was left out.
		if (colls.length > SHOWN) {
			doc.body.append(el(doc, "div", "item rt-muted",
				`+${colls.length - SHOWN} more collections`));
		}
	}

	const days = historyByDay(rows);
	if (!days.length) {
		doc.body.append(el(doc, "div", "empty", "No reading sessions yet."));
		return;
	}
	for (const d of days) {
		const head = el(doc, "div", "day");
		head.id = "d" + d.day;
		head.append(el(doc, "span", null, dayLabel(d.day)), el(doc, "span", null, fmtTotal(d.seconds) || "0m"));
		doc.body.append(head);
		for (const e of d.items) {
			const row = el(doc, "div", "item");
			const caret = el(doc, "span", "caret", "▸");
			row.append(caret, el(doc, "span", "t", currentTitle(e) || e.title || "(untitled)"),
				el(doc, "span", "n", e.sessions + (e.sessions === 1 ? " session" : " sessions")),
				el(doc, "b", null, fmtTotal(e.seconds) || "0m"));
			row.title = "Show this day's sessions";
			const show = el(doc, "button", null, "↗");
			show.title = "Show in library";
			show.addEventListener("click", (ev) => safe(() => {
				ev.stopPropagation();
				const itemID = Zotero.Items.getIDFromLibraryAndKey(e.libraryID, e.itemKey);
				if (!itemID) return;
				main.ZoteroPane.selectItem(itemID);
				main.focus();
			}));
			row.append(show);

			const list = el(doc, "div", "sessions");
			list.hidden = true;
			for (const r of e.rows.slice().sort((a, b) => a.started - b.started)) {
				list.append(sessionRow(doc, win, r));
			}

			row.addEventListener("click", () => { list.hidden = !list.hidden; caret.textContent = list.hidden ? "▸" : "▾"; });
			doc.body.append(row, list);
		}
	}
}

// --- plugin lifecycle ------------------------------------------------------

// Not async, and nothing here waits on I/O: Zotero awaits every plugin's
// startup() in sequence inside its own init, so anything slow here delays the
// launch and anything that hangs stops it. The database loads in the
// background — until it lands, `db` is null and every writer bails.
function startup({ id }) {
	active = true;
	focusMin = safe(() => Number(Zotero.Prefs.get(FOCUS_PREF)), 0) || FOCUS_MIN;
	openDB().catch(oops);
	onRenderToolbar = renderButton;
	Zotero.Reader.registerEventListener("renderToolbar", onRenderToolbar, id);
	ticker = setInterval(pulse, 1000);
	infoRowID = Zotero.ItemPaneManager.registerInfoRow({
		rowID: "reading-time",
		pluginID: id,
		label: { l10nID: "reading-time-row-label" },
		position: "end",
		editable: true,
		onGetData: ({ item }) => fmtTotal(totalFor(item)),
		// Editing the field logs the difference, so history stays append-only.
		onSetData: ({ item, value }) => {
			const delta = parseDuration(value) - totalFor(item);
			if (Math.abs(delta) >= 1) { addRow(item, "manual", delta); refreshViews(); }
		},
	});
	columnKey = Zotero.ItemTreeManager.registerColumn({
		dataKey: "readingTime",
		label: "Reading time",
		pluginID: id,
		flex: 0,
		width: "90",   // string, not a number — the API validator rejects the column otherwise
		dataProvider: (item) => sortKey(totalFor(item)),
		renderCell: (index, data, column, isFirstColumn, doc) => {
			const cell = doc.createElement("span");
			cell.className = `cell ${column.className}`;
			cell.textContent = fmtTotal(parseInt(data, 10) || 0);  // 0 → blank cell
			return cell;
		},
		zoteroPersist: ["width", "hidden", "sortDirection"],
	});
	if (!columnKey) Zotero.logError(new Error("Reading Time: item tree column was rejected"));
	menuID = Zotero.MenuManager.registerMenu({
		menuID: "reading-time-history",
		pluginID: id,
		target: "main/menubar/tools",
		menus: [{ menuType: "menuitem", l10nID: "reading-time-history-menu", onCommand: () => openHistory() }],
	});
	collectionMenuID = Zotero.MenuManager.registerMenu({
		menuID: "reading-time-collection-history",
		pluginID: id,
		target: "main/library/collection",
		menus: [{
			menuType: "menuitem",
			l10nID: "reading-time-collection-history-menu",
			onCommand: () => safe(() => {
				const collection = Zotero.getMainWindow().ZoteroPane.getSelectedCollection();
				openHistory(collection ? collectionFilter(collection) : null);
			}),
		}],
	});
	itemMenuID = Zotero.MenuManager.registerMenu({
		menuID: "reading-time-item-history",
		pluginID: id,
		target: "main/library/item",
		menus: [{
			menuType: "menuitem",
			l10nID: "reading-time-item-history-menu",
			onCommand: () => safe(() => {
				const items = Zotero.getMainWindow().ZoteroPane.getSelectedItems();
				const item = items && items[0];
				const target = item && (item.parentItem || item);
				openHistory(target ? itemFilter(target) : null);
			}),
		}],
	});
	for (const win of Zotero.getMainWindows()) onMainWindowLoad({ window: win });
	safe(adoptOpenReaders);
}

function onMainWindowLoad({ window }) {
	window.MozXULElement.insertFTLIfNeeded("reading-time.ftl");
}

function onMainWindowUnload() {}

async function shutdown() {
	// Order matters: stopping the clock cannot be left to code that might throw
	// on the way there, or the old instance keeps ticking and redrawing.
	active = false;
	if (ticker) { clearInterval(ticker); ticker = null; }
	safe(stop);
	safe(closePanel);
	for (const bar of bars.values()) safe(() => bar.btn.remove());
	bars.clear();
	if (onRenderToolbar && Zotero.Reader.unregisterEventListener) {
		Zotero.Reader.unregisterEventListener("renderToolbar", onRenderToolbar);
	}
	onRenderToolbar = null;
	if (infoRowID) Zotero.ItemPaneManager.unregisterInfoRow(infoRowID);
	if (columnKey) Zotero.ItemTreeManager.unregisterColumn(columnKey);
	if (menuID) Zotero.MenuManager.unregisterMenu(menuID);
	if (itemMenuID) Zotero.MenuManager.unregisterMenu(itemMenuID);
	if (collectionMenuID) Zotero.MenuManager.unregisterMenu(collectionMenuID);
	if (historyWin && !historyWin.closed) historyWin.close();
	historyWin = null;
	infoRowID = columnKey = menuID = itemMenuID = collectionMenuID = null;
	// Must actually complete: Gecko will not finish shutting down until every
	// SQLite connection is closed. Racing this against a setTimeout only looked
	// like a bound — timers may already be dead this late in shutdown, and
	// walking away from an open connection is what hangs the quit.
	await closeDB();
	log.length = 0;
}

function install() {}
function uninstall() {}

// node-only: lets test.js import the pure helpers; no-op inside Zotero.
if (typeof module !== "undefined") {
	module.exports = { parseDuration, fmtTotal, fmtClock, sortKey, sumSeconds, startOfDay, historyByDay, heatmapWeeks, level, rollUp };
	// Enough of the machinery for test.js to drive a whole session. A smoke test
	// is what catches an edit that quietly deletes a function everything calls.
	module.exports.__internals = {
		start, stop, tick, paint, setPaused, checkOrphaned, log, bars,
		setActive: (v) => { active = v; }, setDB: (v) => { db = v; }, getTimer: () => timer,
		setRegistered: (col, row) => { columnKey = col; infoRowID = row; },
	};
}
