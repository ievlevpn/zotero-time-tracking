/* Reading Time — a tiny Zotero plugin (bootstrapped, Zotero 10).
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
// Three states on purpose: undefined = never asked, "" = asked and declined,
// anything else = the tag to apply.
const TAG_PREF = "readingTime.readTag";
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
const goals = [];         // every goal row, likewise — there are only ever a few
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
	if (Math.abs(min) < 60) return `${min}m`;
	const rest = Math.abs(min % 60);
	return rest ? `${(min / 60 | 0)}h ${rest}m` : `${(min / 60 | 0)}h`;   // "20h", not "20h 0m"
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
		seconds INTEGER NOT NULL,  -- countable time; manual entries may be negative
		note    TEXT               -- optional line about what you read
	)`,
	`CREATE INDEX IF NOT EXISTS sessions_item ON sessions (libraryID, itemKey)`,
	`CREATE INDEX IF NOT EXISTS sessions_started ON sessions (started)`,
];

const COLS = ["id", "libraryID", "itemKey", "title", "mode", "started", "seconds", "note"];

// One row per goal. Keyed by item/collection key rather than a numeric id so a
// goal survives anything that renumbers rows, and matching `sessions` in using
// libraryID: whatever translates one table for another machine translates both.
const GOAL_SCHEMA = [
	`CREATE TABLE IF NOT EXISTS goals (
		id         TEXT PRIMARY KEY,
		libraryID  INTEGER NOT NULL,
		scope      TEXT NOT NULL CHECK (scope IN ('item', 'collection', 'all')),
		key        TEXT,                      -- item/collection key; NULL for 'all'
		seconds    INTEGER NOT NULL CHECK (seconds > 0),
		period     TEXT NOT NULL CHECK (period IN ('total', 'day', 'week', 'month')),
		deadline   INTEGER,                   -- unix ms; only meaningful with 'total'
		notifiedAt  INTEGER,                  -- when this goal was last announced
		completedAt INTEGER,                  -- marked read early; done regardless of time
		updatedAt   INTEGER NOT NULL
	)`,
	// One goal per target per period. IFNULL, because SQLite counts NULLs as
	// distinct and 'all' goals would otherwise multiply freely.
	`CREATE UNIQUE INDEX IF NOT EXISTS goals_target
		ON goals (libraryID, scope, IFNULL(key, ''), period)`,
];

const GOAL_COLS = ["id", "libraryID", "scope", "key", "seconds", "period", "deadline", "notifiedAt", "completedAt", "updatedAt"];

// Bump when the shape changes; the stamp is a marker for migrations that can't
// be made idempotent. Adding a column doesn't need one — see migrate().
const DB_VERSION = 3;

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
	log.length = 0;    // a reopen must not double every session
	goals.length = 0;
	try {
		// Best effort: an old version's leftover -wal can make this fail with
		// SQLITE_BUSY, and that must not take the rest of the open down with it.
		await conn.queryAsync("PRAGMA journal_mode = DELETE").catch(oops);
		for (const sql of SCHEMA.concat(GOAL_SCHEMA)) await conn.queryAsync(sql);
		await migrate(conn);
		const version = Number(await conn.valueQueryAsync("PRAGMA user_version")) || 0;
		if (version !== DB_VERSION) await conn.queryAsync(`PRAGMA user_version = ${DB_VERSION}`);
		for (const row of await conn.queryAsync("SELECT * FROM sessions ORDER BY started")) {
			log.push(Object.fromEntries(COLS.map((c) => [c, row[c]])));  // rows are proxies
		}
		for (const row of await conn.queryAsync("SELECT * FROM goals")) {
			goals.push(Object.fromEntries(GOAL_COLS.map((c) => [c, row[c]])));
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

// Columns added to an existing table. Driven by what the file actually has
// rather than by the version stamp: CREATE TABLE IF NOT EXISTS gives a fresh
// database every column already, so a version-driven ALTER would fail on it.
const ADDED_COLUMNS = [
	["goals", "completedAt", "INTEGER"],
	["sessions", "note", "TEXT"],
];

async function migrate(conn) {
	for (const [table, column, type] of ADDED_COLUMNS) {
		const columns = (await conn.queryAsync(`PRAGMA table_info(${table})`)).map((r) => r.name);
		if (!columns.includes(column)) {
			await conn.queryAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
		}
	}
}

async function closeDB() {
	const conn = dbConn;
	db = dbConn = null;
	if (conn) await conn.closeDatabase().catch(oops);
}

// Zotero's debug viewer turns debug output on globally while it is open and
// renders one DOM node per line, so anything failing repeatedly on the 1 Hz
// pulse would bury the log someone is trying to read. Identical messages are
// reported at most once a minute; a different one always gets through.
let lastOops = "", lastOopsAt = 0;
function oops(e) {
	const message = String((e && e.message) || e);
	const now = Date.now();
	if (message === lastOops && now - lastOopsAt < 60000) return;
	lastOops = message;
	lastOopsAt = now;
	Zotero.logError(e);
}

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
		title: item.getDisplayTitle(), mode, started, seconds: Math.round(seconds), note: null,
	};
	log.push(row);
	db.queryAsync(`INSERT INTO sessions (${COLS.join(", ")}) VALUES (${COLS.map(() => "?").join(", ")})`,
		COLS.map((c) => row[c])).catch(oops);
	return row;
}

function saveRow(row) {
	if (!db) return;   // nothing to write to; the in-memory log still has it
	db.queryAsync("UPDATE sessions SET seconds = ?, title = ?, note = ? WHERE id = ?",
		[row.seconds, row.title, row.note || null, row.id]).catch(oops);
}

// Upsert: the unique index makes "set a goal" replace the one already on that
// target for that period, rather than quietly stacking a second.
function saveGoal(goal) {
	goal.updatedAt = Date.now();
	if (!goals.includes(goal)) goals.push(goal);
	if (!db) return;
	db.queryAsync(`INSERT OR REPLACE INTO goals (${GOAL_COLS.join(", ")}) VALUES (${GOAL_COLS.map(() => "?").join(", ")})`,
		GOAL_COLS.map((c) => goal[c] === undefined ? null : goal[c])).catch(oops);
}

function dropGoal(goal) {
	const i = goals.indexOf(goal);
	if (i >= 0) goals.splice(i, 1);
	if (!db) return;
	db.queryAsync("DELETE FROM goals WHERE id = ?", [goal.id]).catch(oops);
}

function dropRow(row) {
	const i = log.indexOf(row);
	if (i >= 0) log.splice(i, 1);
	if (!db) return;
	db.queryAsync("DELETE FROM sessions WHERE id = ?", [row.id]).catch(oops);
}

// Time belongs to the parent item — that is what itemOf() resolves to. So when
// a standalone PDF gains a parent (Zotero's "Create Parent Item"), the sessions
// already logged against the attachment have to follow, or they sit apart from
// everything logged afterwards, filed under the PDF's filename. Idempotent, and
// anything Zotero can't resolve right now is left alone rather than guessed at.
function reparentRows(resolve) {
	let moved = 0;
	for (const id of new Set(log.map((r) => r.libraryID + "/" + r.itemKey))) {
		const cut = id.indexOf("/");
		const libraryID = Number(id.slice(0, cut));
		const key = id.slice(cut + 1);
		const parent = resolve(libraryID, key);
		if (!parent) continue;

		for (const r of log) {
			if (r.libraryID !== libraryID || r.itemKey !== key) continue;
			r.libraryID = parent.libraryID;
			r.itemKey = parent.key;
			r.title = parent.title;
			moved++;
		}
		// A goal set on the standalone PDF moves too — unless the parent already
		// has one for that period, in which case the parent's wins.
		for (const g of goals.slice()) {
			if (g.scope !== "item" || g.libraryID !== libraryID || g.key !== key) continue;
			const clash = goals.find((x) => x !== g && x.scope === "item" && x.period === g.period
				&& x.libraryID === parent.libraryID && x.key === parent.key);
			if (clash) dropGoal(g);
			else { g.libraryID = parent.libraryID; g.key = parent.key; saveGoal(g); }
		}
		if (db) {
			db.queryAsync("UPDATE sessions SET libraryID = ?, itemKey = ?, title = ? WHERE libraryID = ? AND itemKey = ?",
				[parent.libraryID, parent.key, parent.title, libraryID, key]).catch(oops);
		}
	}
	return moved;
}

const parentOf = (libraryID, key) => safe(() => {
	const item = Zotero.Items.getByLibraryAndKey(libraryID, key);
	const parent = item && item.isAttachment() && item.parentItem;
	return parent ? { libraryID: parent.libraryID, key: parent.key, title: parent.getDisplayTitle() } : null;
}, null);

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
	safe(() => panel && panel.flush());   // typed text belongs to the session it was typed during
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
	if (timer && timer.running && ticks % FLUSH_EVERY === 0) {
		safe(() => saveRow(timer.row));
		safe(checkGoals);   // a goal met mid-session shouldn't wait for the stop
	}
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
.rt-panel .rt-goal { margin-top:8px; }
.rt-panel .rt-note { margin-top:8px; }
.rt-panel .rt-note input { width:100%; box-sizing:border-box; padding:4px 6px; font:12px sans-serif;
	background:Canvas; color:CanvasText; border:1px solid GrayText; border-radius:4px; }
.rt-panel .rt-goalbtn { width:100%; margin-top:8px; }
.rt-panel .rt-goal .rt-row .rt-muted { flex:1; min-width:0; overflow:hidden;
	text-overflow:ellipsis; white-space:nowrap; }
.rt-panel .rt-mark { flex:0 0 auto; font:12px/1 sans-serif; padding:1px 4px; margin-left:2px;
	border:1px solid transparent; border-radius:4px; background:transparent;
	color:GrayText; cursor:pointer; }
.rt-panel .rt-goal:hover .rt-mark { color:CanvasText; border-color:GrayText; }
.rt-panel .rt-goaledit { margin-top:8px; border-top:1px solid GrayText; padding-top:8px; }
.rt-panel .rt-seg { display:flex; gap:4px; margin-top:6px; }
.rt-panel .rt-seg button.on { background:Highlight; color:HighlightText; }
.rt-panel .bar { height:6px; border-radius:3px; background:color-mix(in srgb, CanvasText 15%, Canvas);
	overflow:hidden; margin-top:3px; }
.rt-panel .bar i { display:block; height:100%; background:#40c463; }
.rt-panel .bar i.done { background:#216e39; }
.rt-panel .rt-pom { display:flex; align-items:center; gap:6px; margin-top:8px; }
/* a class rule with display beats the UA's [hidden], so say it again */
.rt-panel .rt-pom[hidden] { display:none; }
.rt-panel .rt-pom .rt-muted { flex:1; }
.rt-panel .rt-pom button { flex:0 0 auto; padding:2px 8px; }
`;

function injectCSS(doc) {
	let style = doc.getElementById("rt-css");
	if (!style) {
		style = doc.createElement("style");
		style.id = "rt-css";
		(doc.head || doc.documentElement).append(style);
	}
	// Replace the contents rather than bailing when the element exists: after an
	// upgrade a reader tab still holds the previous version's stylesheet, and
	// every rule added since would be missing until the tab was reopened.
	if (style.textContent !== CSS) style.textContent = CSS;
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
	safe(checkGoals);
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
	safe(panel.flush);   // a half-typed note is still a note
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
	panel = { el: box, btn, cleanup: () => {}, refresh: () => {}, flush: () => {} };
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
	safe(panel.flush);          // rebuilding is a close, as far as pending text goes
	box.replaceChildren();
	panel.refresh = () => {};
	panel.flush = () => {};
	safe(() => fillPanel(doc, box, item, reader));   // sets panel.refresh when it succeeds
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

function fillPanel(doc, box, item, reader) {
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

	// Goals covering this item. Membership is resolved once, here — not on every
	// repaint — and only the two most specific are shown; the popup is 260px.
	const mine = goalsFor(item).slice(0, 2);
	const bars = mine.map((g) => {
		const wrap = el(doc, "div", "rt-goal");
		const head = el(doc, "div", "rt-row");
		const label = el(doc, "span", "rt-muted");
		const value = el(doc, "span", "rt-total");
		head.append(label, value);
		const bar = el(doc, "div", "bar");
		const fill = el(doc, "i");
		bar.append(fill);
		let mark = null;
		if (canComplete(g)) {
			mark = el(doc, "button", "rt-mark");
			mark.addEventListener("click", (e) => {
				e.stopPropagation();          // don't open the editor as well
				toggleComplete(g);
				rebuild();
			});
			head.append(mark);
		}
		wrap.append(head, bar);
		if (g.scope === "item") {
			wrap.title = "Change this goal";
			wrap.style.cursor = "pointer";
			wrap.addEventListener("click", () => editing(true));
		}
		box.insertBefore(wrap, add);
		return { g, label, value, fill, mark };
	});

	// The note belongs to the session being timed and to nothing else. Stopping
	// commits it and empties the field, so what is on screen is always the note
	// for what is running now — never a leftover that looks unsaved.
	const notable = () => (timer && timer.id === idOf(item) && timer.row) || null;

	const noteBox = el(doc, "div", "rt-note");
	const noteInput = doc.createElement("input");
	noteInput.type = "text";
	noteInput.placeholder = "📝 Note for this session…";
	// Typed-but-uncommitted text, tracked explicitly: the 1 Hz refresh must not
	// overwrite what is being typed, and relying on activeElement is fragile
	// once the popup can be torn out from under a focused field.
	let noteDirty = false;
	const saveNote = () => {
		noteDirty = false;
		const r = notable();
		if (!r) return;
		const value = noteInput.value.trim() || null;
		if (value === (r.note || null)) return;
		r.note = value;
		saveRow(r);
	};
	noteInput.addEventListener("input", () => { noteDirty = true; });
	noteInput.addEventListener("keydown", (e) => {
		if (e.key === "Escape") return;   // let it bubble so the panel closes
		e.stopPropagation();              // keys must not trigger reader shortcuts
		if (e.key === "Enter") saveNote();
	});
	noteInput.addEventListener("blur", saveNote);
	noteBox.append(noteInput);
	box.insertBefore(noteBox, add);

	// Setting a goal without leaving the book. The item's own goal is the one
	// worth having here; collection and library-wide goals live in the Goals tab.
	const rebuild = () => safe(() => tryFill(doc, box, reader));
	const ownGoal = (period) => goals.find((g) => g.scope === "item" && g.libraryID === item.libraryID
		&& g.key === item.key && (!period || g.period === period));

	const goalBtn = el(doc, "button", "rt-goalbtn", ownGoal() ? "🎯 Change goal…" : "🎯 Set a goal…");
	const editor = el(doc, "div", "rt-goaledit");
	const gInput = doc.createElement("input");
	gInput.type = "text";
	gInput.placeholder = "3h, 45m, 20h";
	const gPeriod = periodPicker(doc, "total");
	const gFields = el(doc, "div", "rt-add");
	gFields.append(gInput);
	const gButtons = el(doc, "div", "rt-actions");
	const gSave = el(doc, "button", null, "Save");
	const gDrop = el(doc, "button", null, "Remove");
	const gCancel = el(doc, "button", null, "Cancel");
	gButtons.append(gSave, gDrop, gCancel);
	editor.append(gFields, gPeriod.el, gButtons);
	editor.hidden = true;
	box.insertBefore(goalBtn, add);
	box.insertBefore(editor, add);

	const editing = (on) => {
		editor.hidden = !on;
		goalBtn.hidden = on;
		if (!on) return;
		const g = ownGoal();
		gInput.value = g ? fmtTotal(g.seconds) : "";
		gPeriod.value = g ? g.period : "total";
		gDrop.hidden = !g;
		gInput.focus();
	};
	goalBtn.addEventListener("click", () => editing(true));
	gCancel.addEventListener("click", () => editing(false));
	gInput.addEventListener("keydown", (e) => {
		if (e.key === "Escape") return;   // let it bubble so the panel closes
		e.stopPropagation();              // keys must not trigger reader shortcuts
		if (e.key === "Enter") gSave.click();
	});
	gSave.addEventListener("click", () => safe(() => {
		const seconds = Math.round(parseDuration(gInput.value));
		if (seconds <= 0) { gInput.focus(); return; }
		// Same upsert rule as the Goals tab: one goal per target per period.
		const g = ownGoal(gPeriod.value)
			|| { id: Zotero.Utilities.randomString(12), libraryID: item.libraryID, scope: "item", key: item.key };
		Object.assign(g, { seconds, period: gPeriod.value, deadline: null, notifiedAt: null });
		saveGoal(g);
		rebuild();          // the new bar has to come from a fresh goalsFor()
	}));
	gDrop.addEventListener("click", () => safe(() => {
		const g = ownGoal();
		if (g) dropGoal(g);
		rebuild();
	}));

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
		for (const b of bars) {
			const matches = goalMatcher(b.g);
			const { done, ratio } = matches ? goalProgress(log, b.g, matches, Date.now()) : { done: 0, ratio: 0 };
			b.label.textContent = `${b.g.scope === "item" ? "Goal" : goalTitle(b.g) || "Goal"} ${periodLabel[b.g.period]}`;
			b.value.textContent = `${fmtTotal(done) || "0m"} / ${fmtTotal(b.g.seconds)}`;
			b.fill.style.width = Math.round(ratio * 100) + "%";
			b.fill.className = ratio >= 1 ? "done" : "";
			if (b.mark) {
				b.mark.textContent = b.g.completedAt ? "↺" : "✓";
				b.mark.title = b.g.completedAt ? "Reopen this goal" : "Mark as read — finished early";
			}
		}
		const jotting = notable();
		noteBox.hidden = !jotting;
		if (!jotting) {
			noteInput.value = "";   // the session it belonged to is over and saved
			noteDirty = false;
		}
		else if (!noteDirty) noteInput.value = jotting.note || "";   // never overwrite typing
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
	panel.flush = saveNote;
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

// --- goals -----------------------------------------------------------------

// Start of the window a goal is measured over. Local time, weeks from Monday —
// the same conventions as the heatmap, or the numbers wouldn't agree.
function periodStart(period, now) {
	if (period === "total") return 0;
	if (period === "day") return startOfDay(now);
	if (period === "month") {
		const d = new Date(now);
		d.setDate(1); d.setHours(0, 0, 0, 0);
		return d.getTime();
	}
	const d = new Date(startOfDay(now));       // week
	d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
	return d.getTime();
}

// Pure: `matches` decides which sessions count, so the Zotero lookups stay out.
function goalProgress(rows, goal, matches, now) {
	const since = periodStart(goal.period, now);
	let done = 0;
	for (const r of rows) {
		if (r.started >= since && matches(r)) done += r.seconds;
	}
	// Marked read counts as finished however much time it took — reading faster
	// than you estimated is a good outcome, not an unmet goal.
	const complete = !!goal.completedAt;
	return {
		done, target: goal.seconds, complete,
		ratio: complete ? 1 : Math.max(0, Math.min(1, done / goal.seconds)),
	};
}

// What you'd have to average from now on to land a deadline. null when there is
// nothing to pace: no deadline, already done, or the day has arrived.
function goalPace(goal, done, now) {
	if (goal.completedAt || goal.period !== "total" || !goal.deadline || done >= goal.seconds) return null;
	const days = Math.ceil((startOfDay(goal.deadline) - startOfDay(now)) / DAY) + 1;
	return days > 0 ? { perDay: (goal.seconds - done) / days, days } : null;
}

const periodLabel = { total: "once", day: "per day", week: "per week", month: "per month" };

// A recurring goal resets; there is nothing to finish early.
const canComplete = (g) => g.period === "total";

function toggleComplete(g) {
	const marking = !g.completedAt;
	// Finished is finished: if what's being timed counts toward this goal, it
	// stops — and stops first, so its last seconds land before the goal closes.
	// The goal's own matcher decides, so this reads the same for a book, a
	// collection, or all reading.
	if (marking && timer) {
		const matches = safe(() => goalMatcher(g), null);
		if (matches && safe(() => matches(timer.row), false)) stop();
	}
	g.completedAt = marking ? Date.now() : null;
	saveGoal(g);
	if (g.scope === "item") applyReadTag(g, marking);
}

const readTag = () => safe(() => Zotero.Prefs.get(TAG_PREF), undefined);

// Asked once, the first time you mark something read, and changeable from the
// Goals view afterwards. Cancelling is taken as "no tag" so it isn't asked
// again on every book — the setting is right there to change.
function askReadTag() {
	const current = readTag();
	const answer = promptValue(
		"Tag items you mark as read?\n\nEnter a tag name, or leave it empty for none.",
		current === undefined ? "read" : current);
	const tag = answer === null ? (current || "") : answer.trim();
	safe(() => Zotero.Prefs.set(TAG_PREF, tag));
	return tag;
}

// Only ever from a click on ✓ or ↺: nothing tags an item on its own, however
// much time it has had.
function applyReadTag(g, marking) {
	const tag = readTag() === undefined ? askReadTag() : readTag();
	if (!tag) return;
	safe(() => {
		const item = Zotero.Items.getByLibraryAndKey(g.libraryID, g.key);
		if (!item) return;
		if (marking === item.hasTag(tag)) return;      // already how it should be
		if (marking) item.addTag(tag);
		else item.removeTag(tag);
		item.saveTx();
	});
}

// The sessions a goal counts. Resolved when asked, never stored: collection
// membership changes, and an orphaned goal must report itself rather than
// silently matching nothing.
function goalMatcher(g) {
	if (g.scope === "all") return (r) => r.libraryID === g.libraryID;
	if (g.scope === "item") return (r) => r.libraryID === g.libraryID && r.itemKey === g.key;
	const collection = safe(() => Zotero.Collections.getByLibraryAndKey(g.libraryID, g.key), null);
	return collection ? collectionFilter(collection).match : null;   // null → orphan
}

function goalTitle(g) {
	if (g.scope === "all") return "All reading";
	return safe(() => {
		if (g.scope === "collection") {
			const c = Zotero.Collections.getByLibraryAndKey(g.libraryID, g.key);
			return c ? c.name : null;
		}
		const item = Zotero.Items.getByLibraryAndKey(g.libraryID, g.key);
		return item ? item.getDisplayTitle() : null;
	}, null);
}

// Goals covering one item: its own, its collections', and any library-wide one.
// Membership is asked once by the caller, not on every repaint.
function goalsFor(item) {
	const cols = collectionsOf(item);
	const keys = new Set();
	for (const id of cols) {
		const c = safe(() => Zotero.Collections.get(id), null);
		if (c) keys.add(c.key);
	}
	return goals.filter((g) => g.libraryID === item.libraryID && (
		g.scope === "all"
		|| (g.scope === "item" && g.key === item.key)
		|| (g.scope === "collection" && keys.has(g.key))))
		.sort((a, b) => ({ item: 0, collection: 1, all: 2 })[a.scope] - ({ item: 0, collection: 1, all: 2 })[b.scope]);
}

// Announce a goal the moment it is met, once per period.
function checkGoals() {
	const now = Date.now();
	for (const g of goals) {
		if (g.completedAt) continue;   // already settled, by hand
		const matches = goalMatcher(g);
		if (!matches) continue;
		const { done, ratio } = goalProgress(log, g, matches, now);
		const since = periodStart(g.period, now);
		if (ratio < 1) continue;
		if (g.notifiedAt && g.notifiedAt >= since) continue;   // already said so this period
		g.notifiedAt = now;
		saveGoal(g);
		notify(`🎯 Goal reached — ${fmtTotal(done)} ${periodLabel[g.period]} on ${goalTitle(g) || "a deleted item"}`);
	}
}

// Classic subsequence match: every character of the query appears in the text,
// in order, not necessarily adjacent. "mdv" finds "Medieval Europe".
function fuzzy(q, text) {
	if (!q) return true;
	let i = 0;
	for (let j = 0; j < text.length && i < q.length; j++) {
		if (text[j] === q[i]) i++;
	}
	return i === q.length;
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
.nav { display:flex; gap:4px; }
.top button.on { background:Highlight; color:HighlightText; }
.goal { margin:14px 0; }
.picker { max-height:260px; overflow-y:auto; margin:8px 0; }
.setting { margin-left:auto; align-self:center; font-size:11px; color:GrayText; cursor:pointer; }
.setting:hover { text-decoration:underline; color:CanvasText; }
.goal-head .link { cursor:pointer; }
.goal-head .link:hover { text-decoration:underline; }
.goal-head { display:flex; align-items:baseline; gap:8px; }
.goal-head .t { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
.goal-head button { font:11px sans-serif; padding:0 5px; border:1px solid transparent; border-radius:4px;
	background:transparent; color:CanvasText; cursor:pointer; }
.goal-head button:hover { border-color:GrayText; }
.bar { height:8px; border-radius:4px; background:var(--l0); overflow:hidden; margin:5px 0 3px; }
.bar i { display:block; height:100%; background:var(--l2); }
.bar i.done { background:var(--l4); }
.editor { border:1px solid GrayText; border-radius:6px; padding:10px; margin:14px 0; }
.editor-line { display:flex; gap:6px; margin-top:8px; align-items:center; }
.rt-seg { display:flex; gap:4px; }
.rt-seg button { font:12px sans-serif; padding:4px 10px; border:1px solid GrayText; border-radius:5px;
	background:transparent; color:CanvasText; cursor:pointer; }
.rt-seg button.on { background:Highlight; color:HighlightText; }
.editor input, .editor select { padding:4px 6px; font:12px sans-serif;
	background:Canvas; color:CanvasText; border:1px solid GrayText; border-radius:4px; }
.editor input[type=text] { flex:1; min-width:0; }
.editor button { font:12px sans-serif; padding:4px 10px; border:1px solid GrayText; border-radius:5px;
	background:transparent; color:CanvasText; cursor:pointer; }
.editor button:hover { background:Highlight; color:HighlightText; }
.search { width:100%; box-sizing:border-box; margin:12px 0 0; padding:5px 8px;
	font:13px sans-serif; background:Canvas; color:CanvasText; border:1px solid GrayText; border-radius:5px; }
.day .rt-muted { font-weight:400; }
.item:hover .caret { color:HighlightText; }
.sessions { margin:0 0 4px 18px; }
.session { display:flex; align-items:baseline; gap:8px; padding:2px 4px; font-size:12px; color:GrayText; }
.session .when { font-variant-numeric:tabular-nums; }
.session .mode { color:GrayText; }
.session b { color:CanvasText; font-variant-numeric:tabular-nums; }
.session .act { display:flex; gap:4px; align-items:center; }
.snote { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
	color:CanvasText; cursor:text; }
.snote-blank { color:GrayText; opacity:0; }
.session:hover .snote-blank { opacity:1; }
.snote-input { flex:1; min-width:0; padding:1px 5px; font:11px sans-serif;
	background:Canvas; color:CanvasText; border:1px solid GrayText; border-radius:4px; }

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
let historyView = "days";   // "days" | "collections" | "goals"
let goalDraft = null;       // the goal being edited, or a target waiting for one
let goalPick = null;        // "item" | "collection" while choosing what a new goal is about
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
	safe(() => reparentRows(parentOf));   // items unloaded at startup get their chance here
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
		el(doc, "span", "mode", r.mode));

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
	// The note shares the session's line — most sessions have none, and a blank
	// row each would be all the eye saw. It is edited where it sits, no dialog
	// for one line of text.
	const note = el(doc, "div", "snote");
	const show = () => {
		note.textContent = r.note || "Add a note…";
		note.className = r.note ? "snote" : "snote snote-blank";
	};
	const edit = () => {
		const input = doc.createElement("input");
		input.type = "text";
		input.className = "snote-input";
		input.value = r.note || "";
		input.placeholder = "What did you read?";
		let closed = false;
		const close = (save) => {
			if (closed) return;
			closed = true;
			if (save) { r.note = input.value.trim() || null; saveRow(r); }
			input.replaceWith(note);
			show();
		};
		input.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter") close(true);
			else if (e.key === "Escape") close(false);
		});
		input.addEventListener("blur", () => close(true));
		note.replaceWith(input);
		input.focus();
	};
	note.addEventListener("click", (e) => { e.stopPropagation(); edit(); });
	show();

	line.append(note, el(doc, "b", null, live ? "running" : (fmtTotal(r.seconds) || "0s")), act);
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

// A row of buttons rather than a <select>: native dropdowns don't reliably open
// inside the reader's document, and this matches every other control we draw.
// "once" is the default — a goal is a target to reach, not a treadmill, unless
// you say otherwise.
function periodPicker(doc, initial, onChange) {
	const box = el(doc, "div", "rt-seg");
	const buttons = [];
	let value = initial || "total";
	const paint = () => { for (const [v, b] of buttons) b.className = v === value ? "on" : ""; };
	for (const [v, label] of [["total", "once"], ["day", "day"], ["week", "week"], ["month", "month"]]) {
		const b = el(doc, "button", null, label);
		b.addEventListener("click", () => { value = v; paint(); if (onChange) onChange(v); });
		buttons.push([v, b]);
		box.append(b);
	}
	paint();
	return {
		el: box,
		get value() { return value; },
		set value(v) { value = v; paint(); },
	};
}

// Start (or resume) editing the goal for one target.
function startGoal(target) {
	const same = (g) => g.libraryID === target.libraryID && g.scope === target.scope
		&& (g.key || null) === (target.key || null);
	const existing = goals.filter(same);
	goalDraft = existing.length
		? Object.assign({}, existing[0], { title: target.title })
		: Object.assign({ seconds: 3600, period: "total", deadline: null }, target);
	historyView = "goals";
	goalPick = null;
	if (historyWin && !historyWin.closed) return safe(() => buildHistory(historyWin));
	openHistory(null);
}

// Save a draft as a goal. One goal per target per period — except "all
// reading", where a second would just be a competing answer to the same
// question, so it replaces whatever was there.
function commitGoal(draft, seconds, period, deadline) {
	const g = goals.find((x) => x.libraryID === draft.libraryID && x.scope === draft.scope
		&& (x.key || null) === (draft.key || null)
		&& (x.scope === "all" || x.period === period))
		|| { id: Zotero.Utilities.randomString(12), libraryID: draft.libraryID, scope: draft.scope, key: draft.key || null };
	Object.assign(g, { seconds, period, deadline: deadline || null, notifiedAt: null });
	saveGoal(g);
	if (g.scope === "all") {
		for (const other of goals.slice()) {
			if (other !== g && other.scope === "all" && other.libraryID === g.libraryID) dropGoal(other);
		}
	}
	return g;
}

function goalEditor(doc, win) {
	const box = el(doc, "div", "editor");
	const title = goalDraft.title || goalTitle(goalDraft) || "this item";
	box.append(el(doc, "div", "rt-muted", `Goal for “${title}”`));

	const line = el(doc, "div", "editor-line");
	const target = doc.createElement("input");
	target.type = "text";
	target.value = fmtTotal(goalDraft.seconds) || "1h";
	target.placeholder = "3h, 45m, 20h";

	const by = doc.createElement("input");
	by.type = "date";
	by.title = "Deadline (optional)";
	if (goalDraft.deadline) by.value = new Date(goalDraft.deadline).toISOString().slice(0, 10);
	const period = periodPicker(doc, goalDraft.period, (v) => { by.hidden = v !== "total"; });
	by.hidden = period.value !== "total";

	line.append(target, period.el, by);
	box.append(line);

	const buttons = el(doc, "div", "editor-line");
	const save = el(doc, "button", null, "Save goal");
	save.addEventListener("click", () => safe(() => {
		const seconds = Math.round(parseDuration(target.value));
		if (seconds <= 0) { target.focus(); return; }
		commitGoal(goalDraft, seconds, period.value,
			period.value === "total" && by.value ? new Date(by.value + "T00:00:00").getTime() : null);
		goalDraft = null;
		buildHistory(win);
	}));
	const cancel = el(doc, "button", null, "Cancel");
	cancel.addEventListener("click", () => { goalDraft = null; safe(() => buildHistory(win)); });
	buttons.append(save, cancel);
	box.append(buttons);
	return box;
}

// Which pile a goal belongs in. A one-off that is done is finished, whether you
// marked it read or simply reached the time; a recurring one never is, because
// it starts again.
function goalDone(g, done) {
	return g.period === "total" && (!!g.completedAt || done >= g.seconds);
}

// Take me to the thing this goal is about.
function reveal(g) {
	safe(() => {
		const main = Zotero.getMainWindow();
		if (!main) return;
		if (g.scope === "collection") {
			const collection = Zotero.Collections.getByLibraryAndKey(g.libraryID, g.key);
			if (collection) main.ZoteroPane.collectionsView.selectCollection(collection.id);
		} else {
			const itemID = Zotero.Items.getIDFromLibraryAndKey(g.libraryID, g.key);
			if (itemID) main.ZoteroPane.selectItem(itemID);
		}
		main.focus();
	});
}

function goalRow(doc, win, g, now) {
	const matches = goalMatcher(g);
	const name = goalTitle(g);
	const { done, ratio, complete } = matches ? goalProgress(log, g, matches, now) : { done: 0, ratio: 0 };

	const box = el(doc, "div", "goal");
	const head = el(doc, "div", "goal-head");
	const title = el(doc, "span", "t", name || "(deleted)");
	if (name && g.scope !== "all") {
		title.className = "t link";
		title.title = g.scope === "collection" ? "Show this collection" : "Show this book";
		title.addEventListener("click", () => reveal(g));
	}
	head.append(title,
		el(doc, "span", "rt-muted", `${fmtTotal(g.seconds)} ${periodLabel[g.period]}`),
		el(doc, "b", null, `${fmtTotal(done) || "0m"} / ${fmtTotal(g.seconds)}`));

	if (canComplete(g)) {
		const mark = el(doc, "button", null, g.completedAt ? "↺" : "✓");
		mark.title = g.completedAt ? "Not finished after all — reopen this goal"
			: "Mark as read — finished early";
		mark.addEventListener("click", () => { toggleComplete(g); safe(() => buildHistory(win)); });
		head.append(mark);
	}
	const edit = el(doc, "button", null, "✎");
	edit.title = "Change this goal";
	edit.addEventListener("click", () => { goalDraft = Object.assign({}, g, { title: name }); safe(() => buildHistory(win)); });
	const del = el(doc, "button", null, "✕");
	del.title = "Delete this goal";
	del.addEventListener("click", () => { dropGoal(g); safe(() => buildHistory(win)); });
	head.append(edit, del);
	box.append(head);

	const bar = el(doc, "div", "bar");
	const fill = el(doc, "i");
	fill.style.width = Math.round(ratio * 100) + "%";
	if (ratio >= 1 || complete) fill.className = "done";
	bar.append(fill);
	box.append(bar);

	const pace = matches && goalPace(g, done, now);
	const foot = !matches ? "The item or collection this goal was set on is gone."
		: g.completedAt ? `Marked read ${new Date(g.completedAt).toLocaleDateString()} · ${fmtTotal(done) || "0m"} of ${fmtTotal(g.seconds)}`
		: pace ? `${fmtTotal(pace.perDay)} a day to finish by ${new Date(g.deadline).toLocaleDateString()}`
		: ratio >= 1 ? "Done ✓" : `${fmtTotal(g.seconds - done)} to go`;
	box.append(el(doc, "div", "rt-muted", foot));
	return box;
}

// Pick what a new goal is about. The whole library, not only what has been read
// — a goal is usually set on the book you are about to start.
function goalPicker(doc, win) {
	const wanted = goalPick;
	const taken = new Set(goals.filter((g) => g.scope === wanted).map((g) => g.libraryID + "/" + g.key));
	const libraryID = safe(() => Zotero.Libraries.userLibraryID, 1);

	const box = el(doc, "div", "editor");
	box.append(el(doc, "div", "rt-muted", wanted === "collection" ? "Which collection?" : "Which book?"));
	const search = doc.createElement("input");
	search.type = "search";
	search.className = "search";
	search.placeholder = "Filter…";
	const list = el(doc, "div", "picker");
	const cancel = el(doc, "button", null, "Cancel");
	cancel.addEventListener("click", () => { goalPick = null; safe(() => buildHistory(win)); });
	box.append(search, list, cancel);

	let choices = null;   // null while loading
	const render = () => {
		list.replaceChildren();
		if (!choices) return list.append(el(doc, "div", "rt-muted", "Loading…"));
		const shown = choices.filter((c) => fuzzy(search.value.trim().toLowerCase(), c.title.toLowerCase()));
		if (!shown.length) {
			list.append(el(doc, "div", "rt-muted", choices.length ? "Nothing matches." : "Nothing to choose from."));
			return;
		}
		for (const c of shown.slice(0, 40)) {
			const row = el(doc, "div", "item");
			row.append(el(doc, "span", "t", c.title));
			row.addEventListener("click", () => {
				goalPick = null;
				startGoal({ libraryID: c.libraryID, scope: wanted, key: c.key, title: c.title });
			});
			list.append(row);
		}
		// No silent truncation: say what the filter is hiding.
		if (shown.length > 40) list.append(el(doc, "div", "rt-muted", `+${shown.length - 40} more — keep typing`));
	};
	search.addEventListener("input", render);
	render();

	const ready = (found) => {
		choices = found.filter((c) => c.title && !taken.has(c.libraryID + "/" + c.key));
		choices.sort((a, b) => a.title.localeCompare(b.title));
		safe(render);
		safe(() => search.focus());
	};
	if (wanted === "collection") {
		ready(safe(() => Zotero.Collections.getByLibrary(libraryID, true)
			.map((c) => ({ libraryID: c.libraryID, key: c.key, title: c.name })), []));
	} else {
		// Items load asynchronously; the list fills itself in when they arrive.
		safe(() => Zotero.Items.getAll(libraryID, true).then(
			(items) => safe(() => ready(items.filter((i) => i.isRegularItem())
				.map((i) => ({ libraryID: i.libraryID, key: i.key, title: i.getDisplayTitle() })))),
			oops));
	}
	return box;
}

function buildGoals(doc, win) {
	const bar = el(doc, "div", "editor-line");
	const adder = (label, fn) => {
		const b = el(doc, "button", null, label);
		b.addEventListener("click", () => safe(fn));
		bar.append(b);
	};
	adder("＋ Book", () => { goalPick = "item"; goalDraft = null; buildHistory(win); });
	adder("＋ Collection", () => { goalPick = "collection"; goalDraft = null; buildHistory(win); });
	adder("＋ All reading", () => {
		goalPick = null;
		startGoal({ libraryID: Zotero.Libraries.userLibraryID, scope: "all", key: null, title: "All reading" });
	});
	// A setting, not a fourth way to add a goal: off to the side, in the quiet
	// type used for asides elsewhere in this window.
	const tag = readTag();
	const setting = el(doc, "span", "setting",
		tag === undefined ? "🏷 Tag books you mark as read?"
		: tag ? `🏷 Marking read adds the tag “${tag}”` : "🏷 Marking read adds no tag");
	setting.title = "Change what marking a book read does";
	setting.addEventListener("click", () => safe(() => { askReadTag(); buildHistory(win); }));
	bar.append(setting);
	doc.body.append(bar);

	if (goalPick) doc.body.append(goalPicker(doc, win));
	else if (goalDraft) doc.body.append(goalEditor(doc, win));

	const now = Date.now();
	if (!goals.length) {
		doc.body.append(el(doc, "div", "empty",
			"No goals yet. Add one above, or right-click a book or collection in your library."));
		return;
	}

	// Separate piles, because they answer different questions: what am I working
	// through, what is a project taking, how much am I reading at all — and what
	// is already behind me.
	const finished = [], sections = { item: [], collection: [], all: [] };
	for (const g of goals) {
		const matches = goalMatcher(g);
		const { done } = matches ? goalProgress(log, g, matches, now) : { done: 0 };
		(goalDone(g, done) ? finished : sections[g.scope]).push(g);
	}

	const pile = (title, list) => {
		if (!list.length) return;
		doc.body.append(el(doc, "div", "day", title));
		for (const g of list.sort((a, b) => b.seconds - a.seconds)) doc.body.append(goalRow(doc, win, g, now));
	};
	pile("All reading", sections.all);   // the one that covers everything comes first
	pile("Books", sections.item);
	pile("Collections", sections.collection);
	pile("Finished", finished);
}

// Its own view rather than a block in the day list: collections answer a
// different question, and the day list is long enough already.
function buildCollections(doc, win, rows) {
	const colls = byCollection(rows);
	const search = doc.createElement("input");
	search.type = "search";
	search.className = "search";
	search.placeholder = "Filter collections…";
	const list = el(doc, "div");
	const note = el(doc, "div", "day");
	note.append(el(doc, "span", null, "By collection"),
		el(doc, "span", "rt-muted", "sub-collections included"));
	doc.body.append(search, note, list);

	const render = () => {
		list.replaceChildren();
		const shown = colls.filter((c) => fuzzy(search.value.trim().toLowerCase(), c.name.toLowerCase()));
		if (!shown.length) {
			list.append(el(doc, "div", "empty", colls.length ? "No collections match." : "No reading in any collection yet."));
			return;
		}
		for (const c of shown) {
			const row = el(doc, "div", "item coll");
			row.append(el(doc, "span", "t", c.name), el(doc, "b", null, fmtTotal(c.seconds) || "0m"));
			row.title = "Show only this collection";
			row.addEventListener("click", () => safe(() => {
				const collection = Zotero.Collections.get(c.id);
				if (!collection) return;
				historyFilter = collectionFilter(collection);
				historyView = "days";          // narrowed: show it on the timeline
				buildHistory(win);
			}));
			list.append(row);
		}
	};
	search.addEventListener("input", render);
	render();
	search.focus();
}

function buildHistory(win) {
	const doc = win.document;
	const main = Zotero.getMainWindow();
	const rows = log.filter(inFilter);
	doc.title = "Reading time";
	doc.head.replaceChildren(el(doc, "style", null, HISTORY_CSS));

	const head = el(doc, "div", "top");
	head.append(el(doc, "h1", null, historyFilter ? historyFilter.title : "Reading time"));
	const nav = el(doc, "div", "nav");
	if (historyFilter) {
		const all = el(doc, "button", null, "← All");
		all.addEventListener("click", () => { historyFilter = null; safe(() => buildHistory(win)); });
		nav.append(all);
	}
	for (const [id, label] of [["days", "Days"], ["collections", "Collections"], ["goals", "Goals"]]) {
		const tab = el(doc, "button", historyView === id ? "on" : null, label);
		tab.addEventListener("click", () => { historyView = id; safe(() => buildHistory(win)); });
		nav.append(tab);
	}
	head.append(nav);
	doc.body.replaceChildren(head);

	if (historyView === "goals") return buildGoals(doc, win);

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
	if (historyView === "collections") return buildCollections(doc, win, rows);
	doc.body.append(...heatmapEls(doc, rows));

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
			l10nID: "reading-time-collection-goal-menu",
			onCommand: (ev, ctx) => safe(() => {
				const row = ctx && ctx.collectionTreeRows && ctx.collectionTreeRows[0];
				if (!(row && row.isCollection && row.isCollection())) return;
				const c = row.ref;
				startGoal({ libraryID: c.libraryID, scope: "collection", key: c.key, title: c.name });
			}),
		}, {
			menuType: "menuitem",
			l10nID: "reading-time-collection-history-menu",
			// ZoteroPane.getSelectedCollection() was removed in Zotero 10 and now
			// throws, which safe() swallowed — the menu item simply did nothing.
			// The row the menu was opened on is better evidence than the selection
			// anyway. A library root or a saved search isn't a collection, so
			// those open the window unscoped rather than doing nothing.
			onCommand: (ev, ctx) => safe(() => {
				const row = ctx && ctx.collectionTreeRows && ctx.collectionTreeRows[0];
				const collection = row && row.isCollection && row.isCollection() ? row.ref : null;
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
			l10nID: "reading-time-item-goal-menu",
			onCommand: (ev, ctx) => safe(() => {
				const item = ctx && ctx.items && ctx.items[0];
				const target = item && (item.parentItem || item);
				if (!target) return;
				startGoal({ libraryID: target.libraryID, scope: "item", key: target.key, title: target.getDisplayTitle() });
			}),
		}, {
			menuType: "menuitem",
			l10nID: "reading-time-item-history-menu",
			// Same reasoning: take the item from the menu's own context rather
			// than re-deriving it from the pane's selection.
			onCommand: (ev, ctx) => safe(() => {
				const item = ctx && ctx.items && ctx.items[0];
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
	module.exports = { parseDuration, fmtTotal, fmtClock, sortKey, sumSeconds, startOfDay, historyByDay, heatmapWeeks, level, rollUp, fuzzy, periodStart, goalProgress, goalPace, canComplete, goalDone };
	// Enough of the machinery for test.js to drive a whole session. A smoke test
	// is what catches an edit that quietly deletes a function everything calls.
	module.exports.__internals = {
		start, stop, tick, paint, setPaused, checkOrphaned, buildHistory, openPanel, closePanel,
		reparentRows, idFor, readerOpenFor, shutdown, log, goals, bars,
		setView: (v) => { historyView = v; },
		setPick: (v) => { goalPick = v; },
		commitGoal, toggleComplete, applyReadTag, checkGoals,
		setActive: (v) => { active = v; }, setDB: (v) => { db = v; }, getTimer: () => timer,
		setRegistered: (col, row) => { columnKey = col; infoRowID = row; },
	};
}
