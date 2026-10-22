# Changelog

All notable changes to MQTT Scope. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - 2026-10-21

### Added

- **Update notice.** MQTT Scope checks GitHub for a newer release at startup
  and every 6 hours. When there is one, an **Update x.y.z** button appears in
  the top bar and opens a panel with the release notes. **Later** closes the
  panel; **Skip this version** hides that version until a newer one is out.
  Turn the automatic checks off in **Settings → General → Check for updates**.
- **Help → Check for Updates…** checks right away, tells you when you are on
  the latest version or the check failed, and un-skips a skipped version.
- **Self-update.** The AppImage and the Windows installer download the update
  on request (**Download update**) and install it with **Restart to update**
  (which asks first if brokers are connected), or when you quit. Tar.gz,
  Windows portable and macOS builds open the release page instead; Arch Linux
  packages show a command to copy.
- **Restart to update** shows an *Installing MQTT Scope x.y.z* dialog with a
  moving progress bar in every window until the app closes. On Windows the
  installer's window then shows the install's progress and opens the new
  version when it is done; the AppImage restarts into it within seconds.
- Releases now include `PKGBUILD` and `mqtt-scope.desktop` for Arch Linux, so
  `makepkg -si` works from the release files alone.
- After a self-update the AppImage has the new version in its file name:
  rename it (e.g. `MQTT-Scope.AppImage`) to keep launchers working.
- The AppImage shows the MQTT Scope icon in the dock and app grid on GNOME
  (Ubuntu) instead of a generic one. For that it adds a menu entry when it
  first starts, which follows self-updates and disappears from the menus
  once the AppImage is deleted (none is added when the Arch package or an
  AppImage manager already provides one).

## [0.2.1] - 2026-10-21

### Added

- Release files come with signed GitHub build attestations: check a download
  with `gh attestation verify <file> --repo ToRexZ/mqtt-scope`.

### Fixed

- **Narrow windows.** Tiling window managers can make the window narrower than
  its 900 px minimum, which cut off the inspector, publisher and top bar. Below
  that width the topic tree now sits above the inspector (drag the bar between
  them to resize; the height is remembered), the top bar wraps, and a narrow
  but tall inspector shows the message history below the message.
- The inspector's topic no longer collapses into a column of single characters
  when the inspector is narrow; its buttons wrap below it instead.
- A remembered tree width no longer squeezes the inspector after the window
  gets smaller.

## [0.2.0] - 2026-10-20

### Added

- **Plot tabs.** Organise plots in named tabs (e.g. *Safety*, *Motion*), each
  with its own plots and arrangement. Tabs are saved automatically; double-click
  to rename, right-click (or **⋯**) to duplicate, delete, or export/import a tab
  as a `.json` file to share. Data is collected for every tab, so switching tabs
  shows the full timeline. Each tab shows how many plots it holds.
- **Lichtblick-style plot layout.** Plots fill the tab. Drag a plot by its title
  onto the edge of another plot to put it beside, above or below it, onto its
  middle to swap them, or onto another tab to move it there (Esc cancels). Drag
  the gaps between plots to resize them (double-click a gap to even them out).
  **Arrange** lays them out in rows again. A plot never gets so small that its
  lanes overlap; below that the tab scrolls.
- **State transitions plots.** Switch a plot between *Lines* and *States*. In a
  State transitions plot every series is a labelled lane that changes colour
  when its value changes, with the values written in and the current value next
  to the label. Plots made only of true/false values start in this mode.
- **Zoom.** Drag across a plot to zoom into that time range (all plots in the
  tab follow); drag a box to zoom into a value range as well. **Reset view** on
  each zoomed plot (and in the toolbar), double-click or Esc go back to the live
  view.
- **Vertical lines at timestamps** on plots, like Lichtblick's time grid (on by
  default; plot settings → X axis to turn them off for a plot). They are drawn
  over state lanes so they stay visible on the data.
- **Pop-out plots.** Open a plot in its own window, to put it on another screen;
  it keeps plotting live and has its own time window, freeze and zoom.
- **Full screen** for a single plot.
- **Plot settings panel** for the selected plot, laid out like Lichtblick's:
  title, plot type, time window, legend and values, y-axis range, time grid,
  and per series visibility, label (alias), colour picker or palette colour,
  display style (line, line and points, steps, state lane) and line width. The
  panel can be hidden and resized.
- **Synced time bar.** Hovering one plot moves the time bar on every plot of the
  tab, and the legends show the values at that moment.
- **Rebindable keyboard shortcuts** in Settings → Keyboard (clashes are
  flagged; the menu shows the current keys).
- **Space** holds and releases the inspector's message, or freezes the plots on
  the Plots tab. **Ctrl+R** clears received messages and restarts the plot
  timelines (pop-out windows too) without disconnecting.
- Setting: clicking a topic in the tree also expands it one level.
- Website at <https://torexz.github.io/mqtt-scope/> and an Arch Linux package
  (`packaging/aur`, `mqtt-scope-bin`).

### Changed

- Icons are monochrome line icons that follow the theme.
- Plots are saved in `plotTabs.json`. `plots.json` keeps the tab on screen in
  the 0.1 format, so 0.1.0 still finds its plots; plots changed by 0.1.0 after
  an upgrade come back as a *Plots (older version)* tab instead of being lost.
  Plots saved by 0.1.0 open as a tab.
- Each window keeps its own plot tab on screen; changes made in one window
  appear in the others.
- Plotting is much lighter at high message rates and with long histories (about
  0.003 ms per message per plotted value, and a few ms per redraw at 100,000
  points). All plotted data together is capped at roughly 150 MB.
- Space and Enter press a button reached with the keyboard instead of
  triggering a shortcut.

### Fixed

- Freeze now also holds plots whose time window is *All*, and legends show the
  values at the moment of freezing rather than newer ones.

## [0.1.0] - 2026-10-19

First release.

- Saved connections over TCP, TLS (custom CA, client certificates), WebSocket
  and secure WebSocket; MQTT 3.1.1 and 5.0; passwords in the OS keychain.
- Auto-subscribed, virtualised topic tree with live counts, filtering by text or
  MQTT wildcard, retained-message deletion and pause.
- Inspector for large messages: JSON tree with changed fields highlighted, text,
  raw, hex, structural diff, chart, history, search and pop-out windows; exact
  64-bit integers.
- Live plots of any numeric topic or JSON field, with a picker for several
  topics at once, aliases and CSV export.
- Publisher with JSON/text/hex payloads, saved messages, recent publishes and
  safety guards for live systems.
- Several brokers at once (one window each); installers for Linux, Windows and
  macOS.

[Unreleased]: https://github.com/ToRexZ/mqtt-scope/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/ToRexZ/mqtt-scope/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/ToRexZ/mqtt-scope/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/ToRexZ/mqtt-scope/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ToRexZ/mqtt-scope/releases/tag/v0.1.0
