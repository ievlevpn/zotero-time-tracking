# Reading Time (Zotero plugin)

Adds a 🕐 button to the reader toolbar. Click it for a small popup with three
ways to log time on the item you're reading:

- **⏱ Stopwatch** — counts up until you pause or stop.
- **🍅 Pomodoro** — 25 min focus / 5 min break, with a chime and a notification
  at each switch. Breaks don't count toward reading time.
- **Manual entry** — type `25`, `1h 30m`, `45s`, or `-10` to subtract.

While a timer runs the live time sits inside the clock button, so you can close
the popup and keep reading. The popup also shows **This item / Today / Last 7
days**, and the item's total appears as a **Reading time** row in the item pane
(editable — an edit is logged as a manual adjustment).

In the library view, right-click the column headers and tick **Reading time** to
show the per-item total as a sortable column. It sorts by real duration, not by
the text, and it refreshes when a timer stops — not every second, since that
would rebuild the tree.

## Storage

Everything lands in **`time-tracker.sqlite`**, the plugin's own database next to
`zotero.sqlite` in your Zotero data directory. One append-only row per session:

```sql
CREATE TABLE sessions (
    id        TEXT PRIMARY KEY,
    libraryID INTEGER NOT NULL,
    itemKey   TEXT NOT NULL,
    title     TEXT,                -- denormalised, as of when the session started
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

The plugin opens it by absolute path, which tells Zotero it's an "external"
database: no WAL, no idle backups, and no integrity-check dialog at startup —
a time log should never be able to interrupt Zotero. Back it up yourself if you
care about it. Zotero holds the file open while it runs, so read it with
`sqlite3 -readonly`, or close Zotero first.

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

- `FOCUS_MIN` / `BREAK_MIN` at the top of `bootstrap.js` set the pomodoro phases.
- `node test.js` runs the self-check for duration parsing/formatting and the
  session-log sums.

## Guardrails

- **One timer at a time.** Two running at once would double-count the same
  stretch of time, so starting one on another item asks before taking over —
  it never switches silently.
- **Six hours in a row.** A timer left running overnight would log a night's
  sleep as reading. At six hours of counted time it pauses itself and asks
  whether you're still reading; "no" stops it and keeps what it counted, "yes"
  buys another six hours. Change `MAX_SESSION` in `bootstrap.js` to adjust.

## Caveats

- **No idle detection.** The stopwatch keeps counting if you walk away — pause
  it, or use the pomodoro. Machine sleep isn't counted (gaps over 5 s are
  ignored).
- A session is attributed to the day it *started*, so one that runs past
  midnight counts toward the previous day.
- The DB is written every 60 s and on every pause/stop/phase change, so a crash
  costs at most a minute.
- Versions before 0.2.0 stored the total in the item's **Extra** field. Those
  `Reading time: …` lines are ignored now and can be deleted by hand.
