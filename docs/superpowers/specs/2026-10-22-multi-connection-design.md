# Multiple connections in tabs (0.4.0)

## Why

Watching two robots, or a robot and the fleet broker, at the same time means
opening a second window today (Mod+Shift+N), one connection per window. The
windows do not know about each other, cannot be combined, and every one of
them is a full-size app frame. The maintainer wants several connections open
at once in one window, as tabs, like Chrome: each tab is its own connection
with its own tree, inspector, plots and publisher, and tabs move freely
between windows.

## Goals

- Several live connections per window, one per tab, switched with a click or
  a shortcut.
- A tab in the background keeps its connection and keeps recording, so
  switching back shows everything that arrived meanwhile.
- Tabs behave like Chrome tabs: reorder, drag to another window, tear off into
  a new window, close, reopen.
- The app comes back the way it was left (a setting, on by default).

## Non-goals

- One plot showing signals from two connections. Plots stay inside their tab.
- Drawing tabs into the OS title bar (frameless window, custom window
  buttons). The native title bar stays; the tab strip is the first row below it.
- Duplicating a tab, renaming a tab, pinned tabs, tab groups.
- An unread or message counter on tabs (telemetry would keep it ticking).
- An app-wide memory budget across tabs.
- Syncing plot layouts between profiles. Layout import/export already exists
  for copying one profile's layout to another.

## Anti-goals (a failure even if it works)

- A background tab misses messages, stops recording plot data, or falls
  behind and floods when shown.
- Moving a tab to another window reconnects, or loses messages or history.
- One connection's data appears in another tab, a pop-out, or a plot of
  another tab, including when both brokers publish the same topic.
- Two tabs with the same client ID kicking each other off a broker.
- Switching tabs is noticeably slow, or resets the tree's expansion,
  selection, scroll position or the inspector of the tab switched to.

## Behaviour (decided by the maintainer)

**Layout.** Row 1 is the tab strip: the brand, the tabs, `+`, then at the far
right the global buttons (Update from 0.3.0, Settings). Below it everything
belongs to the active tab:

```
[icon MQTT Scope][● CAPRA500-0041 ×][● local ×][+]          [Update][Settings]
 Disconnect  Subscriptions      812 topics · 3.4k msgs · 220/s   Pause  Clear
┌ tree ──────────────┬ Inspector | Plots ──────────────────────────────────┐
│                    │                                                     │
├ publisher ─────────┴─────────────────────────────────────────────────────┤
└ status bar (this tab's state and URL) ───────────────────────────────────┘
```

The connection pill is gone; its job is done by the tab. Disconnect and
Subscriptions move into the tab's toolbar, as do the stats, Pause and Clear.
The status bar shows the active tab's connection. The window title is
"MQTT Scope — <active tab name>".

**Space in the strip.** Each tab shows a status dot, the full profile name and
`×`. As tabs are added, space is given up in this order: the brand collapses
to the app icon alone, then all tabs shrink equally down to a minimum width
(about 100 px), then the strip scrolls sideways. `+` always stays visible
right after the last tab. The strip never wraps, also in the narrow stacked
layout (below 900 px), where the tab toolbar may wrap instead.

**Names that do not fit** scroll slowly and continuously inside their tab
(every cut-off tab, not only the active or hovered one). With the OS's reduce
motion setting they do not move and end in "…" instead. A tab always shows its
full name in a tooltip.

**Status dot.** Green: connected. Amber: connecting or reconnecting. Red: the
connection failed or dropped. Grey: disconnected by the user. A tab in the
background shows the same dot, which is how a dropped connection is noticed.

**New tabs.** `+`, Mod+T and Mod+K open a new tab labelled "New connection"
whose content is the connection dialog (profiles, edit, connect), drawn inside
the tab instead of as a modal over the window, so the other tabs stay usable.
Cancel or Esc closes that tab. Connect connects in this tab. A failed connect
keeps the tab and shows the error with Retry; until a tab has connected once
it can also go back to the profile list.

**A tab belongs to its profile** once it has connected. Disconnect keeps the
tab, its tree, history and plot data; the button becomes Reconnect. Connecting
to another broker means a new tab.

**No duplicates, across all windows.** Opening a profile that is already open
in any tab, in any window, does not open it again: that window comes to the
front and switches to that tab (and the new, empty tab closes). The reason is
the stable client ID of persistent-session profiles: two clients with one ID
throw each other off the broker.

**Background tabs** stay connected and keep everything going: messages go
into their tree and history, plots keep recording. They skip only drawing
(tree, inspector, charts, stats); the first frame after switching shows the
current state.

**Closing.** `×`, middle-click and Mod+W close a tab: disconnect and forget
its data. It asks first only when the tab's plots hold recorded data (the
layout itself is kept per profile, see below). Closing the window's last tab
leaves a "New connection" tab, the same as a fresh start. Mod+Shift+T reopens
the last closed tab of this window: same profile, connected again, starting
with empty data.

**Right-click on a tab:** Close, Close other tabs, Close tabs to the right,
Move to new window, Reconnect or Disconnect. The close entries ask once if any
of the tabs to close holds plot data.

**Reordering and moving.** Drag a tab along the strip to reorder it. Drag it
onto another window's strip to move it there, at the drop position. Drop it
outside every window to open a new window holding just that tab. Dragging out
a window's last tab closes the emptied window. A moved tab keeps its
connection (no reconnect, no lost messages) and all of its state: tree and
history, selection and inspector, publisher draft, plot tabs, plot data and
zoom, and its pop-out windows, which now belong to the new window. A large tab
may take a moment to move; that is acceptable.

**Pop-outs** (inspector and plot windows) belong to their tab, get the
profile name in their title ("CAPRA500-0041 — /robot/state"), close when their
tab closes, and only ever receive their own connection's messages.

**Plot layouts are kept per profile.** Each profile remembers its own plot
tabs, plots and series. Opening a profile brings back its layout. A profile
opened for the first time starts with a copy of the most recently used layout.
On upgrade, every existing profile starts with today's (global) layout.
Renaming a profile keeps its layout (layouts are keyed by profile id);
deleting a profile deletes its layout.

**Editing and deleting profiles.** Editing a profile that is open in a tab
takes effect at that tab's next connect, and the tab shows a small "reconnect
to apply" hint. A profile that is open in any tab cannot be deleted: Delete is
disabled with the tooltip "Close its tab first".

**Shared by all tabs:** settings (including history and plot limits, which
apply to each tab separately), saved and recent published messages, shortcuts,
and panel sizes (tree width or height, publisher height, inspector view
mode, plot settings width). Switching tabs never moves a splitter.

**Restore on launch.** A Settings → General switch, "Reopen tabs on launch",
on by default. When on, launching the app reopens the windows that were open
when it was last quit, each at its position and size, with its tabs in order
and the same active tab, and connects them. A tab the user had disconnected
comes back disconnected (with Reconnect). "New connection" tabs and tabs whose
profile was deleted are not restored. A window closed while other windows stay
open is forgotten. A broker that cannot be reached shows the error and Retry in
its tab. When the switch is off the app starts as today: one window with a
"New connection" tab. A second launch while the app runs opens one new window
with a "New connection" tab, as today.

**Closing a window with several connected tabs** asks "Close 3 connections?"
only when restore is off. With restore on it closes without asking.

**Shortcuts** (new actions, all rebindable in Settings like the others):

| Action | Default |
|---|---|
| New tab | Mod+T (and Mod+K, existing "connections") |
| Close tab | Mod+W |
| Next / previous tab | Mod+Tab / Mod+Shift+Tab, also Mod+PageDown / Mod+PageUp |
| Go to tab 1–8 | Mod+1 … Mod+8 |
| Go to last tab | Mod+9 |
| Reopen closed tab | Mod+Shift+T |
| Inspector / Plots | Alt+1 / Alt+2 (moved from Mod+1 / Mod+2) |

These work everywhere in the window, including in the publisher's payload
box, which today swallows every Tab key. Existing per-connection actions
(Subscriptions, Pause, hold, reset plots, find, publish) act on the active
tab. A user whose saved shortcuts still hold the old defaults for Inspector
and Plots gets them moved to Alt+1 / Alt+2; custom bindings are kept, and a
clash shows the existing conflict warning.

**Memory.** History limits (per topic), the pause queue and the plot point
budget stay as they are and apply per tab. There is no app-wide cap, so five
busy tabs can use five times the memory of one.

## Constraints

- One main process owns every MQTT client. Today each main window has exactly
  one `MqttSession`, found from the IPC sender; nothing in IPC names a
  connection. With tabs, a connection needs an id that is unique in the app
  and stays the same when its tab moves to another window. Every `mqtt:*`
  call and event carries it.
- Main is the authority on which profiles are open (no duplicates across
  windows, delete blocked while open), because windows do not share renderer
  state.
- Moving a tab hands its connection to another window in main and its
  renderer state to the other renderer. Messages arriving during the hand-over
  are held in main and delivered to the receiving window afterwards, in order.
- Pop-outs are matched to messages by topic only today. They must be matched
  by connection and topic.
- 0.3.0's updater counts connected brokers per window for its "Restarting
  disconnects N broker(s)" confirm (`connectedCount` in `main/main.js`). It
  must count connections across all tabs. A restart for an update is a launch
  like any other, so with restore on the tabs come back after it.
- Renderer views (tree view, inspector, plots panel, publisher) are written as
  one per window and have no teardown. Per tab they need a dispose that stops
  their timers, observers and document listeners, or closed tabs leak.
- Hard-coded element ids (`#viewer-host`, `#conn-label`, `#stat-*`,
  `pub-topics`, …) become per-tab.
- The plot layout stores' sanitizers drop unknown fields. The new per-profile
  layout data needs its own store entry (jsonStore allows a fixed list of
  names) and must not be lost through the existing sanitizers.
- Two windows saving different profiles' layouts must not overwrite each
  other's changes.
- Renderer windows stay sandboxed with the existing CSP; tab moves and
  tear-off go through main.
- Window placement on Wayland (Hyprland) is decided by the compositor, so a
  torn-off window may not appear at the drop point there. That is acceptable.
  Dragging between windows must work on Linux (X11 and Wayland), Windows and
  macOS.
- The automated tests run without network and without a real mouse drag
  between OS windows. Moving a tab needs a path the e2e tests can drive (the
  same move the drag triggers).

## Delivery

One PR for 0.4.0 on branch `multi-connection`, built in stages that are each
tested before the next:

1. Main: several sessions per window with connection ids. Renderer: per-tab
   tree, inspector, plots, publisher, with dispose. Still one visible
   connection per window at this stage; existing tests pass.
2. The tab strip: tabs, `+`, status dots, name scrolling and tooltips, sizing
   and brand collapse, reorder, context menu, shortcuts, per-tab toolbar and
   status bar, close confirm, reopen closed tab.
3. Connection dialog inside the tab, no duplicates across windows, profile
   edit and delete rules, per-profile plot layouts with migration, restore on
   launch and its setting, window close confirm.
4. Moving tabs between windows, tear-off into a new window, pop-outs moving
   with their tab.
5. README, CHANGELOG, version 0.4.0, new screenshots for the README and
   website.

The branch starts from `feature/update-notice` and is rebased onto `main` once
0.3.0 is merged.

## Left to the builder

- Module layout (suggested: a per-tab `ConnectionTab` in the renderer owning
  what `app.js` holds as globals today, with `app.js` becoming the window
  shell: tab strip, global settings, shortcut dispatch to the active tab).
- How connection ids are made and how main routes batches per connection.
- How tab state is serialised for a move (history payloads are binary and can
  be large; transferring buffers rather than copying is preferred).
- The per-profile layout file format and the migration. Suggested: a new
  store file, leaving `plotTabs.json` as it was, so going back to 0.3 shows
  the pre-upgrade layout.
- Where the restore state is stored and when it is saved (it must survive a
  crash reasonably: save on change, not only on quit).
- Scrolling speed and pause at the ends of tab names, exact tab widths, the
  drag preview, the brand collapse breakpoint.
- `window.__mqttscope` (the e2e test hook): keep its current shape for the
  active tab so existing tests need few changes, and add the tab list.
- Test design: unit tests for the pure parts (tab order, close and reopen
  history, restore state, per-profile layout store and migration, open-profile
  registry, shortcut migration); integration tests for several sessions in
  main and per-connection routing; e2e tests for two tabs on two brokers with
  the same topic, a background tab recording, close confirm, shortcuts,
  no duplicates across windows, restore on and off, moving a tab between
  windows with its pop-outs, and per-profile layouts.
