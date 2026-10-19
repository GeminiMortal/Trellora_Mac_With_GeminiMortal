/**
 * Resolves and loads the native sqlite-vec extension for vector search databases.
 * 解析并为向量检索数据库加载原生 sqlite-vec 扩展。
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

/**
 * Platform-specific sqlite-vec extension configuration.
 * 平台特定的 sqlite-vec 扩展配置。
 */
const SQLITE_VEC_PLATFORM_CONFIG: Record<string, { package: string; binary: string }> = {
  darwin: { package: 'sqlite-vec-darwin-arm64', binary: 'vec0.dylib' },
  win32: { package: 'sqlite-vec-windows-x64', binary: 'vec0.dll' },
};

/**
 * Native SQLite loading needs a physical extension path; an ASAR virtual path cannot be loaded.
 * SQLite 原生加载需要物理扩展文件路径；ASAR 虚拟路径无法被加载。
 *
 * @returns Absolute path to the packaged extension, or an empty string outside packaged runs / 已打包扩展的绝对路径；非打包运行时返回空字符串
 */
export function sqliteVecPackagedExtensionPath(): string {
  const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  if (!resourcesPath) return '';

  const config = SQLITE_VEC_PLATFORM_CONFIG[process.platform];
  if (!config) return '';

  return path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', config.package, config.binary);
}

/**
 * Loads sqlite-vec into a database, preferring the packaged binary and falling back to the installed module.
 * 将 sqlite-vec 加载进数据库：优先使用打包二进制，回退到已安装模块。
 *
 * @param database - Open better-sqlite3 database to extend / 需要扩展的已打开 better-sqlite3 数据库
 */
export function loadSqliteVec(database: Database.Database): void {
  const packaged = sqliteVecPackagedExtensionPath();
  if (packaged && fs.existsSync(packaged)) database.loadExtension(packaged);
  else (require('sqlite-vec') as { load(database: Database.Database): void }).load(database);
}
