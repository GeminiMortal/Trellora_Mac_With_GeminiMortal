const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const w = new BrowserWindow({
    width: 420, height: 320, x: 100, y: 100,
    titleBarStyle: 'hiddenInset',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<body style="margin:0;font-family:sans-serif">' +
    '<div style="height:90px;background:#122b45;color:#fff;display:flex;align-items:center;justify-content:center;-webkit-app-region:drag">上半部：按住拖动我（app-region drag）</div>' +
    '<div style="height:90px;background:#eef;color:#333;display:flex;align-items:center;justify-content:center">中间：不可拖拽区</div>' +
    '<div style="height:90px;background:#2a6;color:#fff;display:flex;align-items:center;justify-content:center;-webkit-app-region:drag">下半部：也可拖动</div>' +
    '</body>'
  ));
});
app.on('window-all-closed', () => app.quit());
