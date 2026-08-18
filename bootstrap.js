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

// Pomodoro phase lengths, in minutes. Edit to taste.
const FOCUS_MIN = 25;
const BREAK_MIN = 5;

const MAX_SESSION = 6 * 3600;  // seconds of counted time before we ask if you're still there
const FLUSH_EVERY = 60;   // seconds between DB writes while a timer runs
const MAX_STEP = 5;       // seconds; longer gaps mean the machine slept
const DAY = 86400000;

let onRenderToolbar;
let infoRowID = null;     // both IDs come back namespaced with the plugin ID
let columnKey = null;
let db = null;            // Zotero.DBConnection for time-tracker.sqlite
const log = [];           // every session row, mirrored from the DB
let timer = null;         // the single active timer, or null — see start()
let ticker = null;        // setInterval handle, alive only while a timer exists
let ticks = 0;
let asking = false;       // a modal prompt is up; a modal spins the event loop,
                          // so the ticker can fire again while we wait
const bars = new Set();   // rendered toolbars: { reader, doc, btn, label }
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
async function openDB() {
	const conn = new Zotero.DBConnection(Zotero.DataDirectory.getDatabase("time-tracker"));
	// Drop any WAL left by an earlier version: one writer, tiny writes, and no
	// stray -wal/-shm files to confuse `sqlite3` while Zotero is running.
	await conn.queryAsync("PRAGMA journal_mode = DELETE");
	for (const sql of SCHEMA) await conn.queryAsync(sql);
	for (const row of await conn.queryAsync("SELECT * FROM sessions ORDER BY started")) {
		log.push(Object.fromEntries(COLS.map((c) => [c, row[c]])));  // rows are proxies
	}
	db = conn;  // only once it's usable, so everything else can just check `db`
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
// miss is not a guardrail. Falls back to "no" if the prompt can't be shown.
function confirm(text) {
	return safe(() => Services.prompt.confirm(Zotero.getMainWindow(), "Reading time", text), false);
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
	db.queryAsync("UPDATE sessions SET seconds = ?, title = ? WHERE id = ?",
		[row.seconds, row.title, row.id]).catch(oops);
}

function dropRow(row) {
	const i = log.indexOf(row);
	if (i >= 0) log.splice(i, 1);
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

const phaseLen = () => (timer.phase === "focus" ? FOCUS_MIN : BREAK_MIN) * 60;

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
		id: idOf(item), mode, row: addRow(item, mode, 0), capAt: MAX_SESSION,
		counted: 0, running: true, segStart: Date.now(),
		phase: "focus", phaseElapsed: 0,
	};
	ticks = 0;
	if (!ticker) ticker = setInterval(tick, 1000);
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

function stop() {
	if (!timer) return;
	absorb();
	// A started-and-immediately-stopped timer isn't history worth keeping.
	if (timer.row.seconds < 1) dropRow(timer.row);
	else saveRow(timer.row);
	timer = null;
	if (ticker) { clearInterval(ticker); ticker = null; }
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

function tick() {
	absorb();
	if (timer.running && timer.counted >= timer.capAt) return askStillReading();
	if (timer.mode === "pomodoro" && timer.running && timer.phaseElapsed >= phaseLen()) nextPhase(true);
	if (timer.running && ++ticks % FLUSH_EVERY === 0) saveRow(timer.row);
	paint();
}

// A timer left running overnight logs a night's sleep as reading. At the cap we
// pause first, so the answer never costs time, then ask.
function askStillReading() {
	if (asking) return;
	asking = true;
	setPaused(true);
	const keep = confirm(`This timer has counted ${fmtTotal(timer.counted)} without stopping. `
		+ `Still reading?\n\nYes keeps it running; No stops it and saves what's counted so far.`);
	asking = false;
	if (!timer) return;         // stopped from elsewhere while the prompt was up
	if (!keep) return stop();
	timer.capAt += MAX_SESSION;
	setPaused(false);
}

function alertPhase() {
	const focus = timer.phase === "focus";
	try {
		const pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline(focus ? `🍅 Break over — ${FOCUS_MIN} min of reading` : `☕ Time for a ${BREAK_MIN} min break`);
		pw.show();
		pw.startCloseTimer(6000);
		Components.classes["@mozilla.org/sound;1"].getService(Components.interfaces.nsISound).beep();
	} catch (e) { oops(e); }
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
`;

function injectCSS(doc) {
	if (doc.getElementById("rt-css")) return;
	const style = doc.createElement("style");
	style.id = "rt-css";
	style.textContent = CSS;
	(doc.head || doc.documentElement).append(style);
}

function renderButton(event) {
	const { reader, doc, append } = event;
	injectCSS(doc);
	const btn = doc.createElement("button");
	btn.className = "toolbar-button rt-btn";
	btn.title = "Reading time";
	const label = el(doc, "span", "rt-live");
	btn.append(el(doc, "span", null, "🕐"), label);
	btn.addEventListener("click", () => togglePanel(reader, doc, btn));
	append(btn);
	bars.add({ reader, doc, btn, label });
	paint();
}

function paint() {
	for (const bar of [...bars]) {
		// The reader wipes and re-fires the toolbar hook on every React render, so
		// entries go stale constantly — drop them, or they pile up for the session
		// and every one of them is another chance to throw mid-loop.
		if (!bar.doc.defaultView || !bar.btn.isConnected) { bars.delete(bar); continue; }
		safe(() => { bar.label.textContent = isMine(itemOf(bar.reader)) ? liveText() : ""; });
	}
	if (panel) safe(() => panel.refresh());
}

// The library column and the item-pane row cache their values, so nudge them
// when a total settles. Never on the 1 Hz tick — refreshing the column rebuilds
// the tree; the live count belongs in the toolbar button, not the library view.
function refreshViews() {
	try { if (columnKey) Zotero.ItemTreeManager.refreshColumns(); } catch (e) { oops(e); }
	try { if (infoRowID) Zotero.ItemPaneManager.refreshInfoRow(infoRowID); } catch (e) { oops(e); }
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
	const item = itemOf(reader);
	const box = el(doc, "div", "rt-panel");
	const rect = btn.getBoundingClientRect();
	const vw = (doc.defaultView && doc.defaultView.innerWidth) || 800;
	box.style.top = rect.bottom + 4 + "px";
	box.style.left = Math.max(8, Math.min(rect.left, vw - 268)) + "px";
	doc.body.append(box);

	const onDown = (e) => { if (!box.contains(e.target) && e.target !== btn) closePanel(); };
	const onKey = (e) => { if (e.key === "Escape") closePanel(); };
	// The document lives in a nested iframe, so clicks there don't reach the
	// reader doc — listen on both so outside-click and Escape always work.
	const docs = [doc];
	const inner = reader && reader._internalReader && reader._internalReader._primaryView
		&& reader._internalReader._primaryView._iframeWindow
		&& reader._internalReader._primaryView._iframeWindow.document;
	if (inner && inner !== doc) docs.push(inner);
	for (const d of docs) {
		d.addEventListener("pointerdown", onDown, true);
		d.addEventListener("keydown", onKey, true);
	}
	const cleanup = () => {
		for (const d of docs) {
			d.removeEventListener("pointerdown", onDown, true);
			d.removeEventListener("keydown", onKey, true);
		}
	};

	if (!item || !db) {
		box.append(el(doc, "div", "rt-muted", db ? "No item for this tab." : "Session database unavailable."));
		panel = { el: box, btn, cleanup, refresh: () => {} };
		return;
	}

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
	box.append(add);

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

	let key = null;
	const refresh = () => {
		stats.forEach(([, get], i) => { values[i].textContent = fmtTotal(get()) || "0m"; });
		const mine = isMine(item);
		big.textContent = mine ? liveText() : "";
		big.style.display = mine ? "" : "none";
		// Rebuild the buttons only when the state they depend on changes.
		const k = mine ? `${timer.mode}/${timer.running}/${timer.phase}` : (timer ? "other" : "idle");
		if (k === key) return;
		key = k;
		actions.replaceChildren();
		if (mine) {
			actions.append(
				button(timer.running ? "⏸ Pause" : "▶ Resume", () => setPaused(timer.running)),
				button("⏹ Stop", () => stop()));
			if (timer.mode === "pomodoro") actions.append(button("⏭ Skip", () => nextPhase(false)));
		} else {
			actions.append(
				button("⏱ Stopwatch", () => start("stopwatch", item)),
				button("🍅 Pomodoro", () => start("pomodoro", item)));
		}
		note.textContent = k === "other" ? "A timer is running on another item." : "";
	};

	panel = { el: box, btn, cleanup, refresh };
	refresh();
}

// --- plugin lifecycle ------------------------------------------------------

async function startup({ id }) {
	try { await openDB(); } catch (e) { oops(e); }
	onRenderToolbar = renderButton;
	Zotero.Reader.registerEventListener("renderToolbar", onRenderToolbar, id);
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
	for (const win of Zotero.getMainWindows()) onMainWindowLoad({ window: win });
}

function onMainWindowLoad({ window }) {
	window.MozXULElement.insertFTLIfNeeded("reading-time.ftl");
}

function onMainWindowUnload() {}

async function shutdown() {
	stop();
	closePanel();
	for (const bar of bars) bar.btn.remove();
	bars.clear();
	if (onRenderToolbar && Zotero.Reader.unregisterEventListener) {
		Zotero.Reader.unregisterEventListener("renderToolbar", onRenderToolbar);
	}
	onRenderToolbar = null;
	if (infoRowID) Zotero.ItemPaneManager.unregisterInfoRow(infoRowID);
	if (columnKey) Zotero.ItemTreeManager.unregisterColumn(columnKey);
	infoRowID = columnKey = null;
	if (db) { await db.closeDatabase().catch(oops); db = null; }
	log.length = 0;
}

function install() {}
function uninstall() {}

// node-only: lets test.js import the pure helpers; no-op inside Zotero.
if (typeof module !== "undefined") module.exports = { parseDuration, fmtTotal, fmtClock, sortKey, sumSeconds, startOfDay };
