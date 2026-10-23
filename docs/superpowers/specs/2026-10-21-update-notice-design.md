# Update notice and auto-update (0.3.0)

## Why

Nobody running MQTT Scope finds out about a new version unless they visit the
releases page. 0.2.1 fixed a layout bug that users had been living with, and
there was no way to tell them. The maintainer wants every install to learn
about new versions and update **when it suits the user**, never by surprise.

The app is used against live brokers, often on robots. Anything that restarts
the app or grabs focus unprompted drops a session someone is watching.

## Goals

- Every install learns that a newer release exists, quietly.
- The user sees what changed and decides when to update.
- Builds that can replace themselves do so with one click and one restart.
- Builds that cannot get the right next step for how they were installed.

## Non-goals

- Publishing to the AUR (no account yet; the CI `aur` job stays as it is).
- Code signing, macOS auto-update (needs signing), winget/Homebrew.
- Telling 0.2.x users about 0.3.0: only versions that contain this
  feature can be told.
- Pre-releases or update channels.

## Anti-goals (a failure even if it works)

- The app restarts, downloads, or installs without the user asking.
- Unprompted popups, modal dialogs or focus stealing because of an update.
  (The Installing dialog and the restarted window coming to the front follow
  the user's own Restart to update; see Installing.)
- Error toasts when there is no internet. Robot networks are often offline;
  a failed check must be silent (logged only).
- A check that sends anything beyond a plain request for the latest release.

## Behaviour (decided by the maintainer)

**Checking.** At startup and every 6 hours while running, on by default. A
Settings → General switch, "Check for updates", turns it off. The Settings button **Check for updates** (bottom of the dialog; macOS also
keeps Help → Check for Updates…) always works, also when the switch is off, and is the only
path that reports "You're on the latest version" (as a toast) or a failure.
Only GitHub's latest-release endpoint for `ToRexZ/mqtt-scope` is contacted;
drafts and pre-releases are therefore never offered.

**Notice.** When a newer version exists, a quiet **↑ Update 0.3.1** button
appears in the top bar beside Settings, in every main window. It stays until
handled. Clicking it opens a small panel (not a modal) showing the running and
new versions, that release's notes from GitHub, and actions. **Later** closes
the panel; the button stays. **Skip this version** hides the button until a
release newer than the skipped one appears. *(Builder-check call:)* Check for
updates ignores a skip: if the skipped version is still the
latest, the manual check shows the button again and clears the skip. That is
the way to undo a skip. Every panel also has a small **Open release page**
link, so a self-update that fails still leaves a manual way out.

**Self-updating builds** (Linux AppImage, Windows installer). Nothing is
downloaded until the user clicks **Download update**. The download runs in the
background with progress on the button. When done the button becomes
**Restart to update**. Clicking it quits and relaunches into the new version as
a fresh start (one window, connection dialog, as on any launch). If any window
is connected to a broker, the panel first asks inline, not as a modal:
"Restarting disconnects N broker(s)" with **Restart** / **Cancel**. Restoring
windows and connections after the restart is a non-goal. If the user quits
instead, the update installs on that quit. A failed download or install shows
its error in the panel (not a toast) and offers retry plus the release page.

**Installing** *(decided after measuring the Windows installer, 0.3.0)*. The
app has to exit for the install to replace it, so it cannot report the
install's progress. Once a restart goes ahead (no confirm needed, or
**Restart** in the confirm), every main window shows a modal *Installing MQTT
Scope x.y.z* dialog: an animated, indeterminate bar (a sliding segment; a
pulse with reduced motion) and no buttons, since it cannot be stopped.
Nothing opens over it or takes its focus meanwhile. This is the one modal an
update shows, and only after the user asked for the restart. Main broadcasts
this state, then starts the install 300 ms later so every window can draw it
first. Starting the unsigned Windows installer blocked the main process for
5–15 s in a Windows 11 VM, and after any click Windows marked the window Not
Responding and froze the bar; so Restart to update starts it from a worker
thread and quits once it has started (install on quit keeps the plain start).
A failed start or install closes the dialog and shows its error as before. On
Windows the installer then runs with its window instead of silently (silent,
the screen stayed empty for the 25–50 s the install took): its progress bar
shows the install, it keeps the existing installation's mode without asking,
and starts the new version and closes itself instead of waiting on its Finish
page (`build/installer.nsh`; a fresh install is unchanged). Each version's
installer is run that way by the version before it, so that file stays in the
build for good. The new version, started with `--updated`, brings its first
window to the front once: after a click elsewhere Windows would open it
behind other windows, and it is the window the user asked to restart into, so
this is not unprompted focus stealing. The AppImage restarts within seconds.
Installing on quit stays silent.

**AppImage file names** keep the version (`MQTT-Scope-0.3.0-linux-x86_64.AppImage`).
electron-updater writes the update under the new versioned name and removes
the old file, which breaks launchers pointing at the old path; an AppImage
renamed to a name without a version is replaced in place instead. The README
says so: rename it (e.g. `MQTT-Scope.AppImage`) for a stable path. Release
asset names do not change.

**Builds that cannot self-update** (Linux tar.gz, Windows portable, macOS dmg
and zip). The main action is **Download**, which opens that version's GitHub
release page in the browser.

**pacman package installs** (built from `packaging/aur`). The notice appears;
the panel says the app was installed by the package manager and shows a
command to copy that builds that exact version. From 0.3.0 on, CI attaches the
release's ready PKGBUILD and `mqtt-scope.desktop` to every GitHub release, so
the command fetches them from **that version's** release (not from `main`, which
can lag) into a scratch folder and runs `makepkg -si`. It must work when run
again for a later version (no "folder already exists" failure). Once the
package is on the AUR the panel switches to `yay -Syu` (a one-line change).
The README install section points at the same release-attached PKGBUILD.

## Constraints

- Renderer windows are sandboxed, deny new windows and navigation, and have a
  CSP: network access and opening the browser happen in the main process, over
  IPC. The renderer never passes a URL to open; main builds the release URL
  itself.
- One main process serves several windows: update state lives in main and is
  broadcast, so acting in one window updates the button in all of them.
- Release notes are untrusted text for rendering purposes: show them as text
  (simple line/bullet formatting at most), never as HTML.
- The test suite must not touch the network: the release endpoint and the
  updater feed need an override for tests (env var, like
  `MQTTSCOPE_USER_DATA`). The override must also work in **packaged** builds,
  because the release gate below runs a packaged app against a local feed.
- CI release job: compute the release's PKGBUILD/.SRCINFO (the logic the `aur`
  job already has) on every tag, attach PKGBUILD and `mqtt-scope.desktop` to the
  release, and keep the AUR push itself gated on `AUR_SSH_PRIVATE_KEY`. CI never
  writes to `main`.
- Existing release flow: tag `v*` → CI builds, attests and publishes with
  `--publish never` and an explicit file list. Self-update needs the
  electron-builder update description files (`latest.yml`,
  `latest-linux.yml`, and their `.blockmap` files where produced) uploaded to
  the release too, and a `publish` (GitHub) entry in the build config so
  packaged apps know where to look.
- `electron-updater` treats a `resources/package-type` file as a request to
  update deb/rpm/pacman installs itself. Self-updating a pacman install is not
  wanted here, so the PKGBUILD's marker for "installed by pacman" must not
  trigger that path.

## Release gate (decided)

0.3.0's updater cannot be repaired by an update, so before tagging 0.3.0:
build the packaged Linux AppImage of 0.3.0, serve a fake 0.3.1 (update
description file + AppImage) from a local feed through the override, and
watch the real path end to end: notice → Download update → Restart to update →
the app comes back as 0.3.1, under the expected file name, with settings
intact. Also check quit-to-install. The Windows installer path ships without a
dry run; its fallback is the release-page link. The first real update
(0.3.0 → 0.3.1) should follow soon after, while being watched.

## How installs are told apart (builder's call, suggested)

- AppImage: `process.env.APPIMAGE` is set.
- Windows portable: `process.env.PORTABLE_EXECUTABLE_DIR` is set; otherwise
  Windows is the installer build.
- pacman: a marker the PKGBUILD writes into the installed app (see constraint
  above for what not to name it).
- Everything else on Linux: tar.gz. macOS: manual.
- Unpackaged (`npm start`): never offers an update, but the check can still be
  exercised through the test override.

## Left to the builder

- Module layout (suggested: one main-process `updater.js` owning state, timer,
  check and electron-updater wiring; one renderer module for button + panel).
- Version comparison, storage of the skipped version and the setting (the
  setting belongs in `settings.json` with the others).
- Exact panel layout and styling, following existing top-bar and menu styles.
- Test design: unit tests for version comparison and install detection; an
  e2e test against a local fake release endpoint for the notice, Later, Skip,
  the Settings check button and the offline case. The electron-updater download/install
  itself can be faked behind the module boundary.
- README "Updates" section (including the AppImage rename tip and the
  release-attached PKGBUILD), CHANGELOG entry, version bump to 0.3.0 (new
  feature: minor bump; fixes stay patch releases).
