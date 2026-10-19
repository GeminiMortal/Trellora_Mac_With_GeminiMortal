import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();

// 清除旧版本安装包，避免累积占用磁盘空间
const outputDir = path.join(root, 'trellora');
try {
  const entries = await fs.readdir(outputDir);
  const stalePatterns = [/\.dmg$/i, /\.dmg\.blockmap$/i, /\.zip$/i, /\.zip\.blockmap$/i, /\.part_[a-z]+$/i, /SHA256SUMS\.txt$/i, /latest-mac\.yml$/i, /builder-debug\.yml$/i, /builder-effective-config\.yaml$/i];
  let removed = 0;
  for (const name of entries) {
    if (stalePatterns.some(p => p.test(name))) {
      await fs.rm(path.join(outputDir, name), { force: true });
      removed++;
    }
  }
  if (removed) console.log(`已清除 ${removed} 个旧版本构建产物。`);
} catch { /* 首次构建，目录不存在 */ }
const iconset = path.join(root, 'build', 'icon.iconset');
const iconSource = path.join(root, 'build', 'icon.png');
const icnsTarget = path.join(root, 'build', 'icon.icns');

/** macOS Dock/DMG icons require an .icns bundle; regenerate it from the canonical 1024px PNG. */
async function generateIcns() {
  const sourceStat = await fs.stat(iconSource);
  try {
    const targetStat = await fs.stat(icnsTarget);
    if (targetStat.mtimeMs >= sourceStat.mtimeMs) return;
  } catch { /* First build on this machine. */ }
  const sizes = [[16, 'icon_16x16'], [32, 'icon_16x16@2x'], [32, 'icon_32x32'], [64, 'icon_32x32@2x'], [128, 'icon_128x128'], [256, 'icon_128x128@2x'], [256, 'icon_256x256'], [512, 'icon_256x256@2x'], [512, 'icon_512x512'], [1024, 'icon_512x512@2x']];
  await fs.rm(iconset, { recursive: true, force: true });
  await fs.mkdir(iconset, { recursive: true });
  for (const [size, name] of sizes) {
    execFileSync('sips', ['-z', String(size), String(size), iconSource, '--out', path.join(iconset, `${name}.png`)], { stdio: 'pipe' });
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icnsTarget], { stdio: 'pipe' });
  await fs.rm(iconset, { recursive: true, force: true });
  console.log('mac package icon generated: build/icon.icns');
}

await generateIcns();
// GitHub 直连不稳定时默认走 npmmirror 镜像，可用环境变量覆盖。
const env = { ...process.env };
if (!env.ELECTRON_MIRROR) env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
const cli = createRequire(import.meta.url).resolve('electron-builder/out/cli/cli.js');
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [cli, '--mac', ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit' });
  child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`macOS package build exited ${code}`)));
});

// electron-builder identity=null 会跳过签名，修改过内容的 app 保持损坏的 linker 签名，
// 双击时被 Gatekeeper 报“已损坏”。这里统一做 ad-hoc 重签并清除隔离标记。
const macOutputDirectory = path.join(root, 'trellora', 'mac-arm64');
const applications = (await fs.readdir(macOutputDirectory)).filter((name) => name.endsWith('.app'));
for (const name of applications) {
  const bundle = path.join(macOutputDirectory, name);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' });
  execFileSync('codesign', ['-v', bundle], { stdio: 'inherit' });
  try { execFileSync('xattr', ['-dr', 'com.apple.quarantine', bundle]); } catch { /* 无 quarantine 时忽略。 */ }
  console.log(`ad-hoc 签名已修复: ${bundle}`);
}
