'use strict';

// The application menu, as a template for Menu.buildFromTemplate. Pure (no
// Electron), so the menu of every platform can be tested anywhere. Linux and
// Windows show no menu bar; main.js sets the menu all the same, for its
// accelerators.
//
// isMac: the macOS menu. shortcuts: action id -> accelerator label, from the
// renderer's settings: those keys are handled (and rebindable) in the
// renderer, so the menu only shows them and must not register them a second
// time. act: what the items do: send(action) to the focused main window,
// closeTab(window) and closeWindow(window) for the focused window (Electron
// passes it to click), newWindow(), openDataFolder(), checkForUpdates(),
// about(), showLogFile().
function menuTemplate({ isMac, shortcuts = {}, act }) {
  const keys = (id) => (shortcuts[id] ? { accelerator: shortcuts[id], registerAccelerator: false } : {});
  const send = (action) => () => act.send(action);
  return [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Window', click: () => act.newWindow(), ...keys('newWindow') },
        { label: 'New Tab', click: send('newTab'), ...keys('newTab') },
        // A pop-out closes itself (its page takes the same key).
        { label: 'Close Tab', click: (_item, win) => act.closeTab(win), ...keys('closeTab') },
        { label: 'Reopen Closed Tab', click: send('reopenTab'), ...keys('reopenTab') },
        // A fixed key, not the renderer's: it closes any window, a pop-out too.
        ...(isMac ? [{ label: 'Close Window', accelerator: 'Cmd+Shift+W', click: (_item, win) => act.closeWindow(win) }] : []),
        { type: 'separator' },
        { label: 'New Connection Tab…', click: send('connections'), ...keys('connections') },
        { label: 'Subscriptions…', click: send('subscriptions'), ...keys('subscriptions') },
        { label: 'Settings…', click: send('settings'), ...keys('settings') },
        // Linux and Windows have no visible menu: these live in Settings.
        ...(isMac ? [{ type: 'separator' }, { label: 'Open Data Folder', click: () => act.openDataFolder() }] : []),
        // macOS: Close Tab and Close Window above replace the close role (Quit is in the app menu).
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Inspector', click: send('tabInspector'), ...keys('tabInspector') },
        { label: 'Plots', click: send('tabPlots'), ...keys('tabPlots') },
        { label: 'Add Data to New Plot…', click: send('newPlot'), ...keys('newPlot') },
        { label: 'Maximize Inspector', click: send('maximize'), ...keys('maximize') },
        { type: 'separator' },
        { label: 'Pause / Resume Updates', click: send('pause'), ...keys('pause') },
        { label: 'Hold / Follow (Freeze Plots)', click: send('hold'), ...keys('hold') },
        { label: 'Reload: Clear Messages and Restart Plots', click: send('reset'), ...keys('reset') },
        { label: 'Clear Topics', click: send('clear'), ...keys('clear') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen', accelerator: isMac ? 'Ctrl+Cmd+F' : 'Shift+F11' },
        { role: 'toggleDevTools' },
      ],
    },
    ...(isMac
      ? [
        {
          label: 'Help',
          submenu: [
            { label: 'Keyboard Shortcuts…', click: send('keyboardSettings') },
            { label: 'Check for Updates…', click: () => act.checkForUpdates() },
            { label: 'About MQTT Scope', click: () => act.about() },
            { label: 'Show Log File', click: () => act.showLogFile() },
          ],
        },
        ]
      : []),
  ];
}

module.exports = { menuTemplate };
