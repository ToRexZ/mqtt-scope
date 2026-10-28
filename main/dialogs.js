'use strict';

// The buttons of a question (an action or Cancel) for dialog.showMessageBox,
// in the order of the platform: GTK dialogs on Linux put the action on the
// right, after Cancel; Windows lists the action first; macOS shows the first
// button rightmost. Cancel is the default either way (Enter does not delete).
// okId is the response that means the action.
function question(okLabel, platform = process.platform) {
  const ok = String(okLabel || 'OK');
  const [buttons, okId, cancelId] = platform === 'linux' ? [['Cancel', ok], 1, 0] : [[ok, 'Cancel'], 0, 1];
  return { buttons, okId, cancelId, defaultId: cancelId };
}

module.exports = { question };
