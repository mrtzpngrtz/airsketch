const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let mainWindow;

function createWindow() {
  // A5 portrait dimensions: 148mm × 210mm (aspect ratio ~0.7:1)
  // Using 2x scale for comfortable viewing: 592 × 840
  const win = new BrowserWindow({
    width: 592,
    height: 840,
    title: 'airsketch',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableWebSQL: false
    }
  });

  mainWindow = win;
  win.loadFile('index.html');

  // Bluetooth Device Selection Handler
  win.webContents.on('select-bluetooth-device', (event, deviceList, callback) => {
    event.preventDefault(); // Prevent default behavior

    console.log('Bluetooth devices found:', deviceList);

    // Send list to renderer to show UI
    win.webContents.send('bluetooth-device-list', deviceList);

    // Set up a one-time listener for the selection response
    // Using a named function to be able to remove it if needed, or just .once
    ipcMain.once('bluetooth-device-selected', (event, deviceId) => {
      if (deviceId) {
        callback(deviceId);
      } else {
        // Cancelled
        callback('');
      }
    });
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
