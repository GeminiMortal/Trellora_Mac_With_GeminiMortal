/**
 * Launch electron-builder with argv passed through untouched.
 * 原样透传参数启动 electron-builder。
 *
 * DSH's bundled Node runtime wraps `node` as a launcher shim, so a script run
 * this way looks like "packaged Electron" to yargs, and the wrapper's own
 * script path leaks into electron-builder's positional arguments. This wrapper
 * normalizes argv before spawning the electron-builder CLI.
 * DSH 内置 Node 是启动器 shim，脚本会被 yargs 识别成“已打包的 Electron”，
 * 包装脚本自身的路径会混入 electron-builder 的位置参数。本包装先规整 argv 再启动 CLI。
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const cli = require.resolve('electron-builder/out/cli/cli.js');
// yargs parses process.argv when electron-builder accesses `.argv`, and its
// Electron detection ("packaged Electron, not `electron script.js`") makes it
// treat only argv[0] as the program name. The DSH runtime launches scripts via
// an Electron shim, so the wrapper script path at argv[1] would leak into the
// positional arguments and electron-builder would report "Unknown argument".
// Drop argv[1] entirely and expose only the explicit argument list so yargs
// never sees the wrapper's own path.
// yargs 在 electron-builder 访问 `.argv` 时解析 process.argv，其 Electron 判定
// （“已打包的 Electron，而不是 electron script.js”）只把 argv[0] 当程序名。
// DSH 运行时经 Electron shim 启动脚本，argv[1] 上的包装脚本路径会被当成位置参数，
// electron-builder 于是报 Unknown argument。这里把 argv[1] 整个丢弃，只保留显式参数，
// 让 yargs 永远看不到包装脚本自身的路径。
const arguments_ = process.argv.slice(2);
process.argv = [process.argv[0], cli, ...arguments_];
const node = path.join(path.dirname(process.execPath), 'node');
const result = spawnSync(node, [cli, ...arguments_], {
  stdio: 'inherit', windowsHide: true, shell: false,
  // Keep argv stable for the child CLI's own yargs parse: argv[1] is the CLI
  // path (consumed as the script name) and the rest are the real arguments.
  // 子进程 CLI 的 yargs 解析同样依赖 argv 布局：argv[1] 是 CLI 路径（被当作脚本名吞掉），
  // 其余为真实参数。
  env: { ...process.env, DSH_ELECTRON_BUILDER_ARGV: JSON.stringify([cli, ...arguments_]) },
});
if (result.error) { console.error(result.error); process.exit(1); }
process.exit(result.status ?? 1);
