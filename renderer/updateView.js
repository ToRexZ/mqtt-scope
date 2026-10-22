// What the top-bar update button, its panel and the Installing dialog show,
// from the UpdateState the main process broadcasts (see main/updater.js).
// Pure: no DOM, no IPC, and no update logic (versions, URLs and what may be
// skipped are decided in main). updateButton.js draws these views and maps
// their action ids to intents.

// The builds that download and install updates themselves. Must match
// SELF_UPDATING in main/updateCheck.js (a unit test checks).
export const SELF_UPDATING_KINDS = new Set(['appimage', 'nsis']);

const STATUSES = new Set(['available', 'downloading', 'ready', 'installing', 'error']);
const percent = (state) => state.progress ?? 0;

// { icon, text, tone, click } for the button, or null while it is hidden. The
// icon is decoration (the DOM side hides it from assistive tech). `click` is
// what pressing it does: 'panel' toggles the panel; 'restart' (once the update
// is downloaded) restarts into it, the panel opening only to confirm.
export function buttonView(state) {
  if (!state || !STATUSES.has(state.status) || !state.latest) return null;
  switch (state.status) {
    case 'available':
      return { icon: '↑', text: `Update ${state.latest.version}`, tone: 'available', click: 'panel' };
    case 'downloading':
      return { icon: null, text: `Downloading ${percent(state)}%`, tone: 'progress', click: 'panel' };
    case 'ready':
      return { icon: null, text: 'Restart to update', tone: 'ready', click: 'restart' };
    case 'installing':
      return { icon: null, text: 'Installing…', tone: 'progress', click: 'panel' };
    default:
      return { icon: null, text: 'Update failed', tone: 'failed', click: 'panel' };
  }
}

const action = (id, label, { primary = false, disabled = false } = {}) => ({ id, label, primary, disabled });
const LATER = action('later', 'Later');

// The panel for `state`, or null while the button is hidden. `confirm` is the
// broker count main asked to confirm a restart for (this window's own step).
// Action ids: download, progress, restart, confirmRestart, cancel, retry,
// openRelease, copyCommand, later; link ids: skip, openRelease.
export function panelView(state, { confirm = null } = {}) {
  if (!buttonView(state)) return null;
  const { status, kind, latest } = state;
  const hasNotes = typeof latest.notes === 'string' && latest.notes.trim() !== '';
  const view = {
    title: `MQTT Scope ${latest.version}`,
    current: `You have ${state.current}`,
    notes: hasNotes ? latest.notes : 'No release notes.',
    noNotes: !hasNotes,
    message: null, // { text, tone: 'info'|'warn'|'error' }
    command: null,
    actions: [],
    links: [],
  };
  // Skipping acts only while the update is offered or failed (main ignores it otherwise).
  if (status === 'available' || status === 'error') view.links.push({ id: 'skip', label: 'Skip this version' });

  if (kind === 'pacman') {
    view.message = { text: 'Installed by the package manager. Update with:', tone: 'info' };
    view.command = state.pacmanCommand;
    view.actions = [action('copyCommand', 'Copy command', { primary: true }), LATER];
  } else if (!SELF_UPDATING_KINDS.has(kind)) {
    // Download is the release page itself, so there is no separate link.
    view.actions = [action('openRelease', 'Download', { primary: true }), LATER];
    return view;
  } else if (status === 'downloading') {
    view.actions = [action('progress', `Downloading… ${percent(state)}%`, { primary: true, disabled: true }), LATER];
  } else if (status === 'ready' && confirm > 0) {
    view.message = { text: `Restarting disconnects ${confirm} broker${confirm === 1 ? '' : 's'}.`, tone: 'warn' };
    view.actions = [action('confirmRestart', 'Restart', { primary: true }), action('cancel', 'Cancel')];
  } else if (status === 'ready') {
    view.actions = [action('restart', 'Restart to update', { primary: true }), LATER];
  } else if (status === 'installing') {
    view.actions = [action('progress', 'Installing…', { primary: true, disabled: true })];
  } else if (status === 'error') {
    view.message = { text: state.error, tone: 'error' };
    view.actions = [action('retry', 'Retry', { primary: true }), LATER];
  } else {
    view.actions = [action('download', 'Download update', { primary: true }), LATER];
  }
  view.links.push({ id: 'openRelease', label: 'Open release page' });
  return view;
}

// The dialog every main window shows while a restart installs the update
// ({ title, text }), or null. It has no actions: the install cannot be
// stopped once started. The button and panel stay under it (the panel open or
// closed as it was), so a failed install shows its error and Retry there.
export function installingView(state) {
  if (state?.status !== 'installing' || !state.latest || !SELF_UPDATING_KINDS.has(state.kind)) return null;
  return {
    title: `Installing MQTT Scope ${state.latest.version}`,
    // The Windows installer shows its own progress window once this app has closed.
    text: state.kind === 'nsis' ? 'MQTT Scope closes now. The installer shows its progress, then MQTT Scope opens again.' : 'MQTT Scope restarts in a moment.',
  };
}

// What a window does with the answer to Help → Check for Updates…:
// { toast, kind } to show, { open: true } for the panel, or null.
export function checkedView(checked, state) {
  switch (checked?.result) {
    case 'available':
      return { open: true };
    case 'latest':
      return { toast: `You're on the latest version (${state?.current ?? ''})`, kind: 'info' };
    case 'error':
      return { toast: `Couldn't check for updates: ${checked.error}`, kind: 'error' };
    case 'disabled':
      return { toast: 'Update checks are off in development builds', kind: 'info' };
    default:
      return null;
  }
}
