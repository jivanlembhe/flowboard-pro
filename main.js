const { app, BrowserWindow, Menu, Tray, ipcMain, dialog, shell, nativeImage } = require('electron');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');

const USER_DATA   = app.getPath('userData');
const DB_FILE     = path.join(USER_DATA, 'flowboard_data.json');
const BACKUP_DIR  = path.join(USER_DATA, 'backups');
const LOG_FILE    = path.join(USER_DATA, 'app.log');

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
  console.log(msg);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); process.exit(0); }

let mainWindow = null;
let tray       = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1400,
    height: 880,
    minWidth:  900,
    minHeight: 600,
    title: 'FlowBoard Pro',
    backgroundColor: '#07080d',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false,
    frame: true,
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => { mainWindow.show(); log('Window shown'); });

  mainWindow.on('close', (e) => {
    if (!app.isQuiting) { e.preventDefault(); mainWindow.hide(); }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  const img = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();

  tray = new Tray(img);
  tray.setToolTip('FlowBoard Pro');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open FlowBoard',    click: showWindow },
    { type: 'separator' },
    { label: 'Backup Data Now',   click: backupNow },
    { label: 'Open Backup Folder',click: () => shell.openPath(BACKUP_DIR) },
    { label: 'Open Data Folder',  click: () => shell.openPath(USER_DATA)  },
    { type: 'separator' },
    { label: 'Quit',              click: quitApp   },
  ]));
  tray.on('double-click', showWindow);
}

function showWindow() {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  else createWindow();
}

function quitApp() { app.isQuiting = true; app.quit(); }

function backupNow(silent = false) {
  if (!fs.existsSync(DB_FILE)) return;
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(BACKUP_DIR, `flowboard_backup_${ts}.json`);
  fs.copyFileSync(DB_FILE, dest);
  log(`Backup created: ${dest}`);
  pruneBackups();
  if (!silent) {
    dialog.showMessageBox(mainWindow, {
      type: 'info', title: 'Backup Complete',
      message: `✅ Backup saved!\n\n📁 ${dest}`,
      buttons: ['Open Folder', 'OK'],
    }).then(r => { if (r.response === 0) shell.openPath(BACKUP_DIR); });
  }
  return dest;
}

function pruneBackups() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('flowboard_backup_') && f.endsWith('.json'))
    .map(f => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  files.slice(30).forEach(({ f }) => fs.unlinkSync(path.join(BACKUP_DIR, f)));
}

function scheduleBackup() {
  setInterval(() => backupNow(true), 30 * 60 * 1000);
}

ipcMain.handle('db-read',  ()         => fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : null);
ipcMain.handle('db-write', (_, data)  => { fs.writeFileSync(DB_FILE, JSON.stringify(data), 'utf8'); return true; });
ipcMain.handle('backup-now', ()       => backupNow(false));
ipcMain.handle('backup-list', ()      => fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json'))
  .map(f => { const s = fs.statSync(path.join(BACKUP_DIR, f)); return { name: f, size: s.size, mtime: s.mtime }; })
  .sort((a, b) => new Date(b.mtime) - new Date(a.mtime)));
ipcMain.handle('backup-restore', async (_, name) => {
  const res = await dialog.showMessageBox(mainWindow, {
    type: 'warning', title: 'Restore Backup',
    message: `Restore from:\n${name}\n\nThis will overwrite current data. Continue?`,
    buttons: ['Restore', 'Cancel'], defaultId: 1,
  });
  if (res.response === 0) { backupNow(true); fs.copyFileSync(path.join(BACKUP_DIR, name), DB_FILE); return true; }
  return false;
});
ipcMain.handle('export-path', async (_, defaultName) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Excel', defaultPath: path.join(os.homedir(), 'Desktop', defaultName),
    filters: [{ name: 'Excel', extensions: ['xlsx'] }],
  });
  return res.filePath || null;
});
ipcMain.handle('write-file', (_, filePath, base64Data) => {
  fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
  shell.showItemInFolder(filePath);
  return true;
});
ipcMain.handle('app-info', () => ({
  version: app.getVersion(), userData: USER_DATA, backupDir: BACKUP_DIR,
  dbFile: DB_FILE, platform: process.platform, electron: process.versions.electron,
}));
ipcMain.handle('open-path', (_, p) => shell.openPath(p));

app.whenReady().then(() => {
  log(`FlowBoard Pro starting`);
  createWindow();
  createTray();
  scheduleBackup();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'Backup Now', accelerator: 'Ctrl+Shift+B', click: () => backupNow() },
      { label: 'Open Backup Folder', click: () => shell.openPath(BACKUP_DIR) },
      { type: 'separator' },
      { label: 'Quit', accelerator: 'Ctrl+Q', click: quitApp },
    ]},
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ]},
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
      { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
      { type: 'separator' }, { role: 'togglefullscreen' },
      { label: 'DevTools', accelerator: 'F12', click: () => mainWindow?.webContents.toggleDevTools() },
    ]},
  ]));
});

app.on('second-instance', () => showWindow());
app.on('window-all-closed', () => {});
app.on('before-quit', () => backupNow(true));
