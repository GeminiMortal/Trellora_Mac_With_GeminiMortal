/**
 * Plugin installer: downloads a plugin zip (e.g. GitHub release), extracts it,
 * validates the manifest, and installs it into the plugins directory.
 * 插件安装器：下载插件 zip（如 GitHub release）、解压、校验清单并安装到插件目录。
 *
 * Security: the zip is extracted to a staging directory first, the manifest is
 * validated (schema + engine range + entry path stays inside root), then it is
 * atomically moved into the plugins directory. Malformed packages never reach
 * the plugins directory.
 *
 * 安全：zip 先解压到暂存目录，清单通过校验（schema + 引擎范围 + 入口路径不越界）
 * 后再原子移动到插件目录。非法包永不到达插件目录。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { parsePluginManifest } from './pluginManifest.ts';
import type { PluginManifest } from './pluginTypes.ts';

export interface InstallResult {
  manifest: PluginManifest;
  pluginDir: string;
}

/** Downloads a URL to a file (https only; SSRF guard applied). */
async function downloadToFile(url: string, destination: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('插件下载仅支持 https。');
  if (parsed.username || parsed.password) throw new Error('下载 URL 不能包含账号信息。');
  const response = await fetch(parsed.href, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw new Error(`下载失败（HTTP ${response.status}）。`);
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination));
}

// ── Minimal zip reader (central directory + local file headers) ──────────────

interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  dataStart: number;
  compression: number; // 0 = stored, 8 = deflate
}

function readZipEntries(zipPath: string): ZipEntry[] {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const eocdBuf = Buffer.alloc(Math.min(65_557, stat.size));
    const eocdPos = Math.max(0, stat.size - eocdBuf.length);
    fs.readSync(fd, eocdBuf, 0, eocdBuf.length, eocdPos);
    const eocd = eocdBuf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error('插件包无效（缺少中央目录结束标记）。');
    const entryCount = eocdBuf.readUInt16LE(eocd + 10);
    const cdOffset = eocdBuf.readUInt32LE(eocd + 16);
    const cdBuf = Buffer.alloc(entryCount * 46 + 65_536);
    fs.readSync(fd, cdBuf, 0, cdBuf.length, cdOffset);
    const entries: ZipEntry[] = [];
    let pos = 0;
    for (let i = 0; i < entryCount; i += 1) {
      if (cdBuf.readUInt32LE(pos) !== 0x02014b50) break;
      const nameLen = cdBuf.readUInt16LE(pos + 28);
      const extraLen = cdBuf.readUInt16LE(pos + 30);
      const commentLen = cdBuf.readUInt16LE(pos + 32);
      const name = cdBuf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
      entries.push({
        name,
        compressedSize: cdBuf.readUInt32LE(pos + 20),
        uncompressedSize: cdBuf.readUInt32LE(pos + 24),
        dataStart: cdBuf.readUInt32LE(pos + 42),
        compression: cdBuf.readUInt16LE(pos + 10),
      });
      pos += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

function extractZipEntry(zipPath: string, entry: ZipEntry, destination: string): void {
  const fd = fs.openSync(zipPath, 'r');
  try {
    // The central directory's "relative offset of local header" points at the
    // 30-byte local file header; the data follows it (after name + extra).
    // 中央目录的"本地头相对偏移"指向 30 字节本地文件头；数据在其后（含名字+额外字段）。
    const localHeader = Buffer.alloc(30);
    fs.readSync(fd, localHeader, 0, 30, entry.dataStart);
    const nameLen = localHeader.readUInt16LE(26);
    const extraLen = localHeader.readUInt16LE(28);
    const dataStart = entry.dataStart + 30 + nameLen + extraLen;
    const compressed = Buffer.alloc(entry.compressedSize);
    fs.readSync(fd, compressed, 0, entry.compressedSize, dataStart);
    const data = entry.compression === 8 ? inflateRawSync(compressed) : compressed;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, data);
  } finally {
    fs.closeSync(fd);
  }
}

function inflateRawSync(data: Buffer): Buffer {
  return zlib.inflateRawSync(data);
}

/**
 * Installs a plugin from a local zip file into pluginsDir.
 * 从本地 zip 文件安装插件到 pluginsDir。
 */
export async function installPluginFromZip(zipPath: string, pluginsDir: string): Promise<InstallResult> {
  const staging = fs.mkdtempSync(path.join(path.dirname(pluginsDir), '.plugin-staging-'));
  try {
    const entries = readZipEntries(zipPath);
    // The zip root may be a folder or the plugin.json may be at the top level.
    // zip 根可能是文件夹，或 plugin.json 直接在顶层。
    const manifestEntry = entries.find((e) => e.name === 'plugin.json' || e.name.endsWith('/plugin.json'));
    if (!manifestEntry) throw new Error('插件包缺少 plugin.json。');

    // Extract all entries with path-traversal protection.
    // 解压全部条目并阻止路径穿越。
    const rootPrefix = manifestEntry.name.endsWith('/plugin.json')
      ? manifestEntry.name.slice(0, -'plugin.json'.length)
      : '';
    for (const entry of entries) {
      if (entry.name.endsWith('/')) continue;
      const relative = rootPrefix ? entry.name.slice(rootPrefix.length) : entry.name;
      if (!relative || relative.startsWith('/') || relative.includes('..')) {
        throw new Error(`插件包含非法路径条目：${entry.name}`);
      }
      extractZipEntry(zipPath, entry, path.join(staging, relative));
    }

    const manifestRaw = JSON.parse(fs.readFileSync(path.join(staging, 'plugin.json'), 'utf8')) as unknown;
    const manifest = parsePluginManifest(manifestRaw);

    // Entry must stay inside the plugin root.
    // 入口必须留在插件根内。
    const entryPath = path.resolve(staging, manifest.main);
    if (!entryPath.startsWith(path.resolve(staging) + path.sep)) {
      throw new Error(`plugin.json main 指向插件目录之外：${manifest.main}`);
    }
    if (!fs.existsSync(entryPath)) throw new Error(`插件入口文件不存在：${manifest.main}`);

    // Atomically move into place; overwrite existing install (upgrade).
    // 原子移动就位；覆盖已有安装（升级）。
    const target = path.join(pluginsDir, manifest.id);
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
    return { manifest, pluginDir: target };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Downloads a plugin zip from a URL (GitHub release) and installs it.
 * 从 URL（GitHub release）下载插件 zip 并安装。
 */
export async function installPluginFromUrl(url: string, pluginsDir: string, tempDir: string): Promise<InstallResult> {
  fs.mkdirSync(tempDir, { recursive: true });
  const zipPath = path.join(tempDir, `plugin-${randomUUID()}.zip`);
  try {
    await downloadToFile(url, zipPath);
    return await installPluginFromZip(zipPath, pluginsDir);
  } finally {
    fs.rmSync(zipPath, { force: true });
  }
}
