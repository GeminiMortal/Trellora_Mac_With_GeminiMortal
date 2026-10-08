import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** electron-builder identity=null 跳过签名，修改过内容的 app 保持损坏的 linker 签名；
 *  afterPack 在 dmg/zip 打包前重签，确保所有目标里的 app 签名一致。 */
export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const bundle = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' });
  try { execFileSync('xattr', ['-dr', 'com.apple.quarantine', bundle]); } catch { /* 无 quarantine 时忽略。 */ }
  console.log(`afterPack: ad-hoc 签名已修复 ${bundle}`);
}
