// BillTrix Desktop — Windows app around the BillTrix web app (cloud data + offline copy + built-in Print Agent)
const { app, BrowserWindow, Menu, shell, session, dialog, ipcMain, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const APP_NAME = 'BillTrix';
const DEFAULT_URL = 'https://billone.upendrakumar-raj.workers.dev';
const AGENT_PORT = 18181;

/* ---------- settings kept in %APPDATA%\BillTrix\desktop.json ---------- */
const CFG_FILE = () => path.join(app.getPath('userData'), 'desktop.json');
function readCfg() { try { return JSON.parse(fs.readFileSync(CFG_FILE(), 'utf8')); } catch { return {}; } }
function writeCfg(c) { try { fs.writeFileSync(CFG_FILE(), JSON.stringify(c, null, 2)); } catch {} }
const cfg = () => ({ url: DEFAULT_URL, zoom: 0, ...readCfg() });
const appOrigin = () => new URL(cfg().url).origin;

/* ---------- one window only ---------- */
if (!app.requestSingleInstanceLock()) { app.quit(); }
let win = null;
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.setAppUserModelId('app.billtrix.desktop');

/* ---------- built-in Print Agent (the same agent v3 used with the browser) ---------- */
let agent = null;
function agentScript() {
  const packed = path.join(process.resourcesPath || '', 'agent.ps1');
  return fs.existsSync(packed) ? packed : path.join(__dirname, 'resources', 'agent.ps1');
}
function agentAlive() {
  return new Promise((resolve) => {
    try {
      const req = net.request({ url: `http://127.0.0.1:${AGENT_PORT}/status`, method: 'GET' });
      const t = setTimeout(() => { try { req.abort(); } catch {} resolve(false); }, 1500);
      req.on('response', (r) => { clearTimeout(t); resolve(r.statusCode === 200); r.on('data', () => {}); });
      req.on('error', () => { clearTimeout(t); resolve(false); });
      req.setHeader('Origin', appOrigin());
      req.end();
    } catch { resolve(false); }
  });
}
async function startAgent() {
  if (process.platform !== 'win32') return;
  if (await agentAlive()) return; // an agent installed earlier is already running: use it
  const ps1 = agentScript();
  if (!fs.existsSync(ps1)) return;
  try {
    agent = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps1], { windowsHide: true, stdio: 'ignore' });
    agent.on('exit', () => { agent = null; });
  } catch (e) { agent = null; }
}
function stopAgent() { try { if (agent) agent.kill(); } catch {} agent = null; }
ipcMain.handle('bt:agent-restart', async () => { stopAgent(); await new Promise((r) => setTimeout(r, 400)); await startAgent(); await new Promise((r) => setTimeout(r, 1500)); return agentAlive(); });

/* ---------- window ---------- */
function offlinePage() { return path.join(__dirname, 'offline.html'); }
function createWindow() {
  const c = cfg();
  win = new BrowserWindow({
    width: 1366, height: 800, minWidth: 1000, minHeight: 640, show: false, title: APP_NAME,
    icon: path.join(__dirname, 'build', 'icon.png'), autoHideMenuBar: true, backgroundColor: '#ffffff',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, partition: 'persist:billtrix' },
  });
  const wc = win.webContents;
  wc.setUserAgent(wc.getUserAgent().replace(/Electron\/\S+\s?/, '') + ` BillTrixDesktop/${app.getVersion()}`);
  win.once('ready-to-show', () => { win.maximize(); win.show(); if (c.zoom) wc.setZoomLevel(c.zoom); });

  /* links: BillTrix stays inside the app; WhatsApp, maps, mail and other sites open in the normal browser */
  const inside = (u) => { try { return new URL(u).origin === appOrigin(); } catch { return false; } };
  wc.setWindowOpenHandler(({ url }) => {
    if (inside(url) || url === 'about:blank') return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: path.join(__dirname, 'build', 'icon.png'), webPreferences: { partition: 'persist:billtrix', sandbox: true, contextIsolation: true } } };
    shell.openExternal(url); return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => { if (!inside(url) && !url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); } });

  /* no internet and no saved copy yet → friendly page with “Try again” */
  wc.on('did-fail-load', (_e, code, _desc, url, isMain) => { if (isMain && code !== -3 && !String(url).startsWith('file:')) win.loadFile(offlinePage()); });
  wc.on('zoom-changed', () => setTimeout(() => writeCfg({ ...readCfg(), zoom: wc.getZoomLevel() }), 50));

  win.loadURL(c.url + (c.url.includes('?') ? '&' : '?') + 'source=desktop');
  win.on('closed', () => { win = null; });
}

/* microphone (voice billing) and notifications (Boss alerts) only for BillTrix itself */
function permissions() {
  const s = session.fromPartition('persist:billtrix');
  const ok = new Set(['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);
  s.setPermissionRequestHandler((wc, perm, cb, details) => { let same = false; try { same = new URL(details.requestingUrl || wc.getURL()).origin === appOrigin(); } catch {} cb(same && ok.has(perm)); });
  s.setPermissionCheckHandler((_wc, perm, origin) => { try { return new URL(origin).origin === appOrigin() && ok.has(perm); } catch { return false; } });
}

/* ---------- menu (press Alt to see it) ---------- */
function menu() {
  const startup = () => app.getLoginItemSettings().openAtLogin;
  const tpl = [
    { label: 'BillTrix', submenu: [
      { label: 'Home', accelerator: 'Alt+Home', click: () => win && win.loadURL(cfg().url + '?source=desktop') },
      { label: 'Reload', accelerator: 'F5', click: () => win && win.webContents.reload() },
      { label: 'Reload (clear cache)', accelerator: 'Ctrl+Shift+R', click: () => win && win.webContents.reloadIgnoringCache() },
      { type: 'separator' },
      { label: 'Start with Windows', type: 'checkbox', checked: startup(), click: (m) => app.setLoginItemSettings({ openAtLogin: m.checked }) },
      { label: 'Restart print helper', click: async () => { stopAgent(); await startAgent(); dialog.showMessageBox(win, { message: 'Print helper restarted.', type: 'info' }); } },
      { type: 'separator' },
      { label: 'Exit', accelerator: 'Alt+F4', role: 'quit' },
    ] },
    { label: 'View', submenu: [
      { role: 'zoomIn', accelerator: 'Ctrl+=' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { type: 'separator' }, { role: 'togglefullscreen', accelerator: 'F11' },
    ] },
    { label: 'Help', submenu: [
      { label: 'About BillTrix Desktop', click: () => dialog.showMessageBox(win, { type: 'info', title: 'BillTrix Desktop', message: `BillTrix Desktop ${app.getVersion()}`, detail: `Server: ${cfg().url}\nData folder: ${app.getPath('userData')}\nThe app updates itself; features come from the cloud.` }) },
      { label: 'Developer tools', accelerator: 'Ctrl+Shift+I', click: () => win && win.webContents.toggleDevTools() },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

/* ---------- self-update of the desktop shell (GitHub releases; set "publish" in package.json) ---------- */
function autoUpdate() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.on('update-downloaded', async () => {
      const r = await dialog.showMessageBox(win, { type: 'info', buttons: ['Restart now', 'Later'], defaultId: 1, title: 'BillTrix update', message: 'A new BillTrix Desktop version is ready.', detail: 'Restart when you are free (not in the middle of a bill).' });
      if (r.response === 0) autoUpdater.quitAndInstall();
    });
    autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 3600 * 1000);
  } catch {}
}

app.whenReady().then(async () => {
  permissions();
  menu();
  await startAgent();
  createWindow();
  autoUpdate();
});
ipcMain.handle('bt:retry', () => { if (win) win.loadURL(cfg().url + '?source=desktop'); });
app.on('window-all-closed', () => { stopAgent(); app.quit(); });
app.on('before-quit', stopAgent);
