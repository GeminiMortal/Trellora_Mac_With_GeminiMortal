// Electron stub for headless verification (plugin system tests).
// 无头校验用的 Electron 替身（插件系统测试）。
export const app = { getPath: () => '/tmp', getVersion: () => '1.3.0', isPackaged: false };
export const dialog = { showMessageBox: async () => ({ response: 1 }) };
export const BrowserWindow = class {};
export const net = { request: () => { throw new Error('net not available in stub'); } };
export const safeStorage = { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => String(b) };
export const protocol = { registerSchemesAsPrivileged: () => {} };
export default { app, dialog, BrowserWindow, net, safeStorage, protocol };
