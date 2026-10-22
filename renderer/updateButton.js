// The top-bar update button, the panel it opens (anchored under it, not a
// modal) and the Installing dialog shown while a restart installs the update.
// Draws updateView.js's views of the UpdateState that main broadcasts to every
// main window, and sends the user's intents back over IPC. Nothing here
// decides anything about updates: that all happens in main.

import { el, button, toast, overlayHost } from './ui.js';
import { buttonView, panelView, installingView, checkedView } from './updateView.js';

const PANEL_ID = 'update-panel';
const MARGIN = 8; // px kept clear of the window's edges
const GAP = 6; // px between the button and the panel

// Returns { installing() }: whether the Installing dialog shows, so the window
// opens nothing over it.
export function initUpdateButton(api, buttonEl) {
  let state = null;
  let confirm = null; // brokers a restart disconnects, while the panel asks about it
  let isOpen = false;

  // aria-haspopup is set while the button opens the panel (see render).
  buttonEl.setAttribute('aria-controls', PANEL_ID);
  buttonEl.setAttribute('aria-expanded', 'false');

  const title = el('h2', 'update-title');
  title.id = `${PANEL_ID}-title`;
  const current = el('div', 'update-current');
  const notes = el('div', 'update-notes'); // untrusted text: textContent only
  const message = el('div', 'update-message'); // also describes the actions (see render)
  message.id = `${PANEL_ID}-message`;
  message.setAttribute('aria-live', 'polite');
  const command = el('code', 'update-command');
  const actions = el('div', 'update-actions');
  const links = el('div', 'update-links');
  const panel = el('div', 'update-panel');
  Object.assign(panel, { id: PANEL_ID, hidden: true, tabIndex: -1 });
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-labelledby', title.id);
  panel.append(title, current, notes, message, command, actions, links);
  // Right after the button, so Tab goes from the button into the panel.
  buttonEl.after(panel);
  // Should the install fail, focus goes back to the panel if open, else the button.
  const installing = installingDialog(() => (isOpen ? panel : buttonEl.hidden ? null : buttonEl));

  // Download/Retry reject only when the panel was out of date (nothing to
  // download any more); the broadcast that changed that redraws it.
  const download = () => api.updateDownload().catch(() => {});
  const failed = (what) => (err) => toast(`Could not ${what}: ${err.message}`, 'error');
  const intents = {
    download,
    retry: download,
    openRelease: () => api.updateOpenRelease().catch(failed('open the release page')),
    copyCommand: () => api.copyText(state.pacmanCommand).then(() => toast('Command copied'), failed('copy the command')),
    skip: () => api.updateSkip(),
    later: () => close({ returnFocus: true }),
    restart,
    confirmRestart: async () => {
      await api.updateRestart(true);
      confirm = null;
      render();
    },
    cancel: () => {
      confirm = null;
      render('restart');
    },
  };

  // Restart to update, from the panel or the top-bar button. Main answers
  // { confirm: n } while n brokers are connected: the panel then asks inline
  // (opening for it if need be) with Cancel, the safe choice, focused.
  // { ok: true } means the app is quitting; a failed install arrives as an
  // 'error' broadcast like any other change.
  async function restart() {
    const res = await api.updateRestart(false);
    if (!(res?.confirm > 0) || state?.status !== 'ready') return;
    confirm = res.confirm;
    if (isOpen) render('cancel');
    else open('cancel');
  }

  // Keeps the buttons of an unchanged view in place (a click must survive a
  // progress update), rebuilding them only when the set of actions changes.
  function syncButtons(container, items, className) {
    const key = items.map((i) => i.id).join(' ');
    if (container.dataset.key !== key) {
      container.dataset.key = key;
      container.replaceChildren(
        ...items.map((i) => {
          const b = button('', '', () => intents[i.id](), className);
          b.dataset.action = i.id;
          return b;
        }),
      );
    }
    items.forEach((item, n) => {
      const b = container.children[n];
      if (b.textContent !== item.label) b.textContent = item.label;
      b.disabled = !!item.disabled;
      b.classList.toggle('primary', !!item.primary);
    });
  }

  const setText = (node, text) => {
    if (node.textContent !== text) node.textContent = text;
  };

  // Draws the current state. `focusId` moves focus to that action ('panel':
  // the panel itself); otherwise focus that was in the panel stays on the same
  // action, or on the panel when that action went away.
  function render(focusId) {
    const view = buttonView(state);
    if (!view) {
      // Focus on the button or in the panel goes to the button's neighbour
      // rather than being dropped with them.
      const hadFocus = buttonEl.contains(document.activeElement) || panel.contains(document.activeElement);
      close();
      buttonEl.hidden = true;
      if (hadFocus) (panel.nextElementSibling || buttonEl.previousElementSibling)?.focus();
      return;
    }
    buttonEl.hidden = false;
    buttonEl.dataset.tone = view.tone;
    if (view.click === 'panel') buttonEl.setAttribute('aria-haspopup', 'dialog');
    else buttonEl.removeAttribute('aria-haspopup');
    if (buttonEl.textContent !== (view.icon ? `${view.icon} ${view.text}` : view.text)) {
      const icon = [];
      if (view.icon) {
        icon.push(el('span', 'update-icon', view.icon), ' ');
        icon[0].setAttribute('aria-hidden', 'true'); // decoration: the name is "Update 0.3.1"
      }
      buttonEl.replaceChildren(...icon, view.text);
    }

    const focused = panel.contains(document.activeElement) ? document.activeElement : null;
    const v = panelView(state, { confirm });
    setText(title, v.title);
    setText(current, v.current);
    setText(notes, v.notes);
    notes.classList.toggle('empty', v.noNotes);
    message.hidden = !v.message;
    message.dataset.tone = v.message?.tone ?? '';
    setText(message, v.message?.text ?? '');
    command.hidden = !v.command;
    setText(command, v.command ?? '');
    syncButtons(actions, v.actions, 'btn');
    syncButtons(links, v.links, 'btn link');
    // The message (e.g. "Restarting disconnects 1 broker.") is read out with the button that answers it.
    for (const b of actions.children) {
      if (v.message) b.setAttribute('aria-describedby', message.id);
      else b.removeAttribute('aria-describedby');
    }
    place();

    const byId = (id) => panel.querySelector(`[data-action="${id}"]:not(:disabled)`);
    if (focusId === 'panel') panel.focus();
    else if (focusId) byId(focusId)?.focus();
    else if (focused && (!panel.contains(document.activeElement) || document.activeElement.disabled)) (byId(focused.dataset.action) || panel).focus();
  }

  // Under the button, right edges aligned, kept inside the window.
  function place() {
    if (!isOpen) return;
    const anchor = buttonEl.getBoundingClientRect();
    const top = anchor.bottom + GAP;
    panel.style.top = `${top}px`;
    panel.style.maxHeight = `${Math.max(0, window.innerHeight - top - MARGIN)}px`;
    const width = panel.offsetWidth;
    panel.style.left = `${Math.max(MARGIN, Math.min(anchor.right - width, window.innerWidth - width - MARGIN))}px`;
  }

  // `focusId` as for render: a check the user asked for focuses the panel, a
  // confirm its Cancel; opening from the button leaves focus on the button.
  function open(focusId) {
    if (!buttonView(state)) return;
    isOpen = true;
    panel.hidden = false;
    buttonEl.setAttribute('aria-expanded', 'true');
    render(focusId);
  }

  // `returnFocus` moves focus to the button (Later, Escape in the panel).
  function close({ returnFocus = false } = {}) {
    if (!isOpen) return;
    isOpen = false;
    confirm = null;
    panel.hidden = true;
    buttonEl.setAttribute('aria-expanded', 'false');
    if (returnFocus) buttonEl.focus();
  }

  function apply(next) {
    state = next;
    if (state?.status !== 'ready') confirm = null;
    render();
    installing.render(installingView(state));
  }

  // Toggles the panel, except once the update is downloaded: then it restarts.
  buttonEl.addEventListener('click', () => {
    if (buttonView(state)?.click === 'restart') restart();
    else if (isOpen) close();
    else open();
  });
  const onEscape = (e) => {
    if (e.key !== 'Escape' || !isOpen) return;
    e.preventDefault();
    e.stopPropagation(); // the panel's Escape, not the window's
    close({ returnFocus: true });
  };
  panel.addEventListener('keydown', onEscape);
  buttonEl.addEventListener('keydown', onEscape);
  // Escape or a click anywhere else closes it too, leaving focus where it is.
  document.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  document.addEventListener('mousedown', (e) => {
    if (!panel.contains(e.target) && !buttonEl.contains(e.target)) close();
  });
  // The bar wraps in a narrow window, so the button moves when anything in it changes size.
  const bar = buttonEl.parentElement;
  const resized = new ResizeObserver(() => place());
  for (const node of [bar, ...bar.children]) if (node !== panel) resized.observe(node);
  window.addEventListener('resize', place);

  api.onUpdateChecked((checked) => {
    const reaction = checkedView(checked, state);
    if (reaction?.open) open('panel');
    else if (reaction?.toast) toast(reaction.toast, reaction.kind);
  });
  // Listen first, then read, so no change falls in between (see preload.js).
  api.onUpdateState(apply);
  api.updateState().then(apply, () => {});
  return { installing: installing.isOpen };
}

// The Installing dialog: modal, above everything including the panel, with an
// animated bar and no buttons (the install cannot be stopped). Focus moves into
// it; if it closes (a failed install), focus returns to where it was, or to
// fallbackFocus() when that is gone.
function installingDialog(fallbackFocus) {
  const title = el('h3', 'installing-title');
  title.id = 'update-installing-title';
  const text = el('p', 'installing-text');
  text.id = 'update-installing-text';
  // No aria-valuenow: indeterminate. The bar moves by a CSS animation of
  // transform (opacity with reduced motion), which the compositor keeps
  // running even while the main process is busy starting the install.
  const bar = el('div', 'installing-bar');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-labelledby', title.id);
  bar.append(el('div', 'installing-bar-fill'));
  const box = el('div', 'modal installing');
  box.tabIndex = -1;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', title.id);
  box.setAttribute('aria-describedby', text.id);
  box.append(title, bar, text);
  const overlay = el('div', 'modal-overlay installing-overlay');
  overlay.append(box);
  // Nothing under it reacts: keys and clicks stop here (menu shortcuts still
  // work), and Tab cannot move focus out.
  overlay.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Tab' || e.key === 'Escape') e.preventDefault();
  });
  overlay.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    e.preventDefault();
  });
  let returnTo = null;

  // view: installingView's, or null to close.
  function render(view) {
    if (view) {
      if (title.textContent !== view.title) title.textContent = view.title;
      if (text.textContent !== view.text) text.textContent = view.text;
      if (!overlay.isConnected) {
        returnTo = document.activeElement;
        overlayHost().append(overlay);
        box.focus();
      }
      return;
    }
    if (!overlay.isConnected) return;
    const hadFocus = overlay.contains(document.activeElement);
    overlay.remove();
    const back = returnTo?.isConnected && !returnTo.closest('[hidden]') && !returnTo.disabled ? returnTo : fallbackFocus();
    returnTo = null;
    if (hadFocus) back?.focus();
  }
  return { render, isOpen: () => overlay.isConnected };
}
