import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

/** Native SQLite loading needs a physical extension path; an ASAR virtual path cannot be loaded. */
export function sqliteVecPackagedExtensionPath(): string {
  const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  if (!resourcesPath) return '';
  if (process.platform === 'darwin') return path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'sqlite-vec-darwin-arm64', 'vec0.dylib');
  return path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'sqlite-vec-windows-x64', 'vec0.dll');
}

export function loadSqliteVec(database: Database.Database): void {
  const packaged = sqliteVecPackagedExtensionPath();
  if (packaged && fs.existsSync(packaged)) database.loadExtension(packaged);
  else (require('sqlite-vec') as { load(database: Database.Database): void }).load(database);
}
