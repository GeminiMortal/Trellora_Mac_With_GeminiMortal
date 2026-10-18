const { app, safeStorage } = require('electron');
app.whenReady().then(() => {
  console.log('isEncryptionAvailable:', safeStorage.isEncryptionAvailable());
  try {
    const enc = safeStorage.encryptString('test-key-123456');
    console.log('encrypt: OK,', enc.length, 'bytes');
    console.log('decrypt:', safeStorage.decryptString(enc));
  } catch (error) {
    console.log('encrypt FAILED:', error.message);
  }
  setTimeout(() => app.exit(0), 500);
}).catch(error => { console.log('ready FAILED:', error.message); app.exit(1); });
