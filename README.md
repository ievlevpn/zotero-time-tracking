# Reading Time (Zotero plugin)

Built for **Zotero 10**. It uses plugin APIs that arrived across the 7.x line —
reader toolbar events, custom item-tree columns, item-pane info rows, and the
menu API — and is only tested against 10.

Adds a 🕐 button to the reader toolbar. Click it for a small popup with three
ways to log time on the item you're reading:

- **⏱ Stopwatch** — counts up until you pause or stop.
- **🍅 Pomodoro** — clicking it doesn't start anything: the length appears with
  `−5` / `+5` to adjust (5–120 min) and a **▶ Start** button. Then focus / 5 min
  break, with a chime and a notification at each switch; breaks don't count
  toward reading time. The length can still be adjusted mid-run, and is
  remembered in `extensions.zotero.readingTime.focusMin`.
- **Manual entry** — type `25`, `1h 30m`, `45s`, or `-10` to subtract.

While a timer runs the live time sits inside the clock button, so you can close
the popup and keep reading. The popup also shows **This item / Today / Last 7
days**, and the item's total appears as a **Reading time** row in the item pane
(editable — an edit is logged as a manual adjustment).

In the library view, right-click the column headers and tick **Reading time** to
show the per-item total as a sortable column. It sorts by real duration, not by
the text, and it refreshes when a timer stops — not every second, since that
would rebuild the tree.

## History

**Tools → Reading Time History…** (or the 📊 button in the reader popup) opens a
window with:

- totals for today / 7 days / 30 days / all time;
- a GitHub-style heatmap of the last 53 weeks — hover a square for that day's
  time, click one to jump to that day below;
- every day you read, newest first, with each item's time and session count.
  Click a line to unfold that day's individual sessions — each one can be
  re-timed (✎, enter a new duration; 0 deletes it) or deleted (✕). Use ↗ to
  select the item in the library.

For one item only, use **↗ right-click an item → Reading Time History…** in the
library, or the 📊 button in the reader popup. Right-clicking a **collection**
does the same for everything in it, sub-collections included. Everything — totals, heatmap,
day list — narrows to it; "← All items" goes back.

The **Collections** tab is a view of its own: every collection you've read in,
biggest first, with a fuzzy filter — `mdv` finds *Medieval Europe*. Time in a
sub-collection counts towards its parents, and an item in two collections counts
in both, so those totals can add up to more than the time you actually spent.
Click one to narrow the window to it and drop back to the day view.

Collection membership is asked of Zotero when you open the window, never stored:
collections change, sessions don't.

## Goals

Set one on the book you're reading straight from the reader popup — **🎯 Set a
goal…**, or click an existing goal's bar to change it. For collections and
library-wide goals, right-click in the library → **Set reading goal…**, or open
the **Goals** tab in the history window. A goal is a target plus a period:

- `20h` **in total**, optionally by a date — the window then shows the pace
  you'd need (`38m a day to finish by 30 Sep`);
- `3h` **per week**, or per day, or per month — progress resets each period.

Collection goals count sub-collections, and an item counts towards both its own
goal and any collection goal covering it. `All reading` goals cover the whole
library. Whatever you're reading shows its two most relevant goals as bars in
the reader popup, and a goal announces itself the moment it's met — once per
period, not once per session.

Goals live in a `goals` table beside the sessions, keyed by item/collection key
rather than a numeric id, so they survive anything that renumbers rows. The
target of a deleted item or collection is shown as *(deleted)* rather than being
cleaned up behind your back.

## Storage

Everything lands in **`time-tracker.sqlite`**, the plugin's own database next to
`zotero.sqlite` in your Zotero data directory. One append-only row per session:

```sql
CREATE TABLE sessions (
    id        TEXT PRIMARY KEY,
    libraryID INTEGER NOT NULL,
    itemKey   TEXT NOT NULL,
    title     TEXT,                -- as of when the session ran; the history
                                   -- window shows the item's current name and
                                   -- falls back to this once it is deleted
    mode      TEXT NOT NULL,       -- stopwatch | pomodoro | manual
    started   INTEGER NOT NULL,    -- unix ms
    seconds   INTEGER NOT NULL     -- countable time; manual rows may be negative
);
```

Nothing is written to the item itself, so nothing another plugin (or you) can
clobber by editing **Extra**. The trade-off: reading time doesn't sync with the
library — copy the file if you want it on another machine.

The whole table is mirrored in memory at startup, so every total in the UI is a
synchronous scan. Query it yourself for anything the popup doesn't show:

```sql
-- minutes per day, last 30 days
SELECT date(started / 1000, 'unixepoch', 'localtime') AS day,
       SUM(seconds) / 60 AS minutes
FROM sessions GROUP BY day ORDER BY day DESC LIMIT 30;

-- most-read items
SELECT title, SUM(seconds) / 60 AS minutes
FROM sessions GROUP BY libraryID, itemKey ORDER BY minutes DESC LIMIT 20;
```

Every connection the plugin opens is tracked from the moment it exists and
closed on any failure. That is not tidiness: Gecko will not finish shutting down
until every SQLite connection is closed, so one leaked connection hangs Zotero's
quit, and a Zotero that gets killed instead of quitting can lose add-on state —
which shows up as the plugin uninstalling itself.

The plugin opens it by absolute path, which tells Zotero it's an "external"
database: no WAL, no idle backups, and no integrity-check dialog at startup —
a time log should never be able to interrupt Zotero. Back it up yourself if you
care about it. Zotero holds the file open while it runs, so read it with
`sqlite3 -readonly`, or close Zotero first.

## Compatibility

`manifest.json` declares `strict_min_version: "9.999"` rather than `"10.0"`.
Zotero's own pre-releases version themselves as `10.0-beta.N`, and Mozilla's
comparator sorts a pre-release suffix *below* the plain number — so a minimum of
`"10.0"` would lock the plugin out of every Zotero 10 beta. The `.999` idiom is
the same one Zotero's own plugin templates used for the 7.0 betas.

`strict_max_version` is `"10.*"`, so the plugin will need a look before it runs
on Zotero 11.

## Install (dev)

```sh
# Build the installable .xpi (just a zip of these files):
cd zotero-time-tracking
zip -r reading-time.xpi manifest.json bootstrap.js locale icons
```

Then in Zotero: **Tools → Plugins → gear icon → Install Plugin From File…**
and pick `reading-time.xpi`. Open any PDF and look for 🕐 in the reader toolbar.

For live development, point Zotero at the folder instead of zipping: create a
file named `reading-time@local` (the id from `manifest.json`) inside your Zotero
profile's `extensions/` directory whose contents are the absolute path to this
folder, then restart Zotero.

## Tweak it

- The pomodoro focus length lives in the popup (`−5` / `+5`); `BREAK_MIN` at the
  top of `bootstrap.js` sets the break.
- `node test.js` runs the self-checks: duration parsing/formatting, the
  session-log sums, the heatmap grid, and a smoke test that drives a whole
  session (start → tick → pause → book closed) against a stubbed Zotero.

## Guardrails

- **Closing the book stops the timer.** A timer whose item has no reader open
  anywhere is counting time nobody is spending, and with its toolbar gone there
  is nothing on screen to notice it by. It stops, keeps what it counted, and
  says so. Only on certainty: an open tab whose item Zotero hasn't loaded reads
  as "don't know", never as closed, so switching tabs can't stop your timer.
- **One timer at a time.** Two running at once would double-count the same
  stretch of time, so starting one on another item asks before taking over —
  it never switches silently.
- **Hourly check-in.** Forgetting to stop the timer is the normal failure, so
  every hour it pauses itself and asks how much of that hour was actually
  reading, pre-filled with the elapsed time. Confirm it, type a smaller value
  (`20m`), enter `0` to throw the session away, or cancel to stop the timer and
  keep what's counted. Answering costs no time, since it pauses first. Change
  `CHECK_IN` in `bootstrap.js` to adjust.

## Caveats

- The button puts itself back. Zotero hands `renderToolbar` to every plugin
  from one unguarded loop and the reader wipes the container on each render,
  so a peer plugin that throws first takes our button down with it. A 1 Hz
  check restores it, and open readers are claimed on startup so upgrading the
  plugin doesn't leave already-open tabs without it.

- **No idle detection.** The stopwatch keeps counting if you walk away — pause
  it, or use the pomodoro. Machine sleep isn't counted (gaps over 5 s are
  ignored).
- A session is attributed to the day it *started*, so one that runs past
  midnight counts toward the previous day.
- The DB is written every 60 s and on every pause/stop/phase change, so a crash
  costs at most a minute.
- Versions before 0.2.0 stored the total in the item's **Extra** field. Those
  `Reading time: …` lines are ignored now and can be deleted by hand.
