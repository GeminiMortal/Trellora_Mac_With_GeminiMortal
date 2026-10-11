import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = path.join(rootDir, 'pipeline-python');
const dependenciesDirectory = path.join(sourceDirectory, '.deps');
const workerPackageDirectory = path.join(sourceDirectory, 'pipeline_worker');
const runtimeDirectory = path.join(rootDir, 'build', 'pipeline-runtime');
const isDarwin = process.platform === 'darwin';

assertDirectory(sourceDirectory, 'Python Worker 源码目录');
assertDirectory(dependenciesDirectory, 'Python Worker 依赖目录');
assertDirectory(workerPackageDirectory, 'Python Worker 包目录');
assertDirectory(path.join(dependenciesDirectory, 'jieba'), 'Jieba 依赖');

resetRuntimeDirectory(runtimeDirectory);
const workerPackageFilter = (source) => !path.relative(workerPackageDirectory, source).split(path.sep).includes('__pycache__') && !source.endsWith('.pyc');
let hello;
let probe;
if (isDarwin) {
  // macOS 包不捆绑 Python 解释器，运行时使用系统 python3；只携带 Worker 模块与依赖。
  cpSync(workerPackageDirectory, path.join(runtimeDirectory, 'pipeline_worker'), { recursive: true, filter: workerPackageFilter });
  copyWorkerDependencies(dependenciesDirectory, path.join(runtimeDirectory, '.deps'));
  probe = probePythonRuntime(resolvePythonExecutable());
  hello = verifyWorkerHandshake(runtimeDirectory, 'python3', ['-E', '-m', 'pipeline_worker']);
  writeJsonAtomically(path.join(runtimeDirectory, 'runtime-manifest.json'), {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    python: {
      implementation: probe.implementation,
      version: probe.version.text,
      executableName: 'python3',
      standardLibrary: null,
      dependencyDirectory: '.deps',
    },
    worker: {
      protocolVersion: hello.protocolVersion,
      engineVersion: hello.engineVersion,
      version: hello.workerVersion,
      jiebaVersion: probe.jiebaVersion,
      capabilities: hello.capabilities,
    },
  });
} else {
  const pythonExecutable = resolvePythonExecutable();
  const pythonHome = path.dirname(pythonExecutable);
  assertDirectory(pythonHome, 'Python 运行时目录');
  probe = probePythonRuntime(pythonExecutable);
  const pythonDllName = `python${probe.version.major}${probe.version.minor}.dll`;
  assertFile(path.join(pythonHome, pythonDllName), 'Python 动态库');
  copyPythonRuntime(pythonHome, runtimeDirectory, pythonDllName);
  cpSync(workerPackageDirectory, path.join(runtimeDirectory, 'pipeline_worker'), { recursive: true, filter: workerPackageFilter });
  copyWorkerDependencies(dependenciesDirectory, path.join(runtimeDirectory, '.deps'));
  writeRuntimePathFile(runtimeDirectory, pythonDllName);
  hello = verifyWorkerHandshake(runtimeDirectory, 'python-worker.exe', ['-E', '-m', 'pipeline_worker']);
  writeJsonAtomically(path.join(runtimeDirectory, 'runtime-manifest.json'), {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    python: {
      implementation: probe.implementation,
      version: probe.version.text,
      executableName: 'python-worker.exe',
      standardLibrary: 'Lib',
      dependencyDirectory: '.deps',
    },
    worker: {
      protocolVersion: hello.protocolVersion,
      engineVersion: hello.engineVersion,
      version: hello.workerVersion,
      jiebaVersion: probe.jiebaVersion,
      capabilities: hello.capabilities,
    },
  });
}

console.log(`pipeline runtime prepared: ${runtimeDirectory}`);

function resolvePythonExecutable() {
  const configured = process.env.MENGHAN_PIPELINE_PYTHON?.trim();
  if (configured) {
    const resolved = path.resolve(configured);
    assertFile(resolved, 'MENGHAN_PIPELINE_PYTHON');
    return resolved;
  }
  if (isDarwin) {
    for (const command of ['python3']) {
      try {
        const executable = execFileSync(command, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
        const resolved = path.resolve(executable); assertFile(resolved, '当前 Python 解释器'); return resolved;
      } catch { /* Try the next local interpreter. */ }
    }
    throw new Error('无法定位用于发布的 python3。请设置 MENGHAN_PIPELINE_PYTHON 指向 Python 3 解释器。');
  }
  // The Windows launcher selects standalone CPython even when Conda comes first in PATH.
  for (const [command, args] of [['py', ['-3', '-c', 'import sys; print(sys.executable)']], ['python', ['-c', 'import sys; print(sys.executable)']]]) {
    try {
      const executable = execFileSync(command, args, { encoding: 'utf8', windowsHide: true }).trim();
      const resolved = path.resolve(executable); assertFile(resolved, '当前 Python 解释器'); return resolved;
    } catch { /* Try the next local interpreter; isolated release verification remains mandatory. */ }
  }
  throw new Error('无法定位用于发布的 CPython x64。请设置 MENGHAN_PIPELINE_PYTHON 指向独立 CPython 的完整 python.exe。');
}

function probePythonRuntime(executable) {
  const program = [
    'import importlib.metadata as metadata, json, platform, sys',
    `sys.path.insert(0, ${JSON.stringify(dependenciesDirectory)})`,
    "import jieba",
    "print(json.dumps({'implementation': platform.python_implementation(), 'version': list(sys.version_info[:3]), 'jiebaVersion': metadata.version('jieba')}))",
  ].join('; ');
  const output = run(executable, ['-E', '-c', program], { cwd: sourceDirectory, timeout: 60_000 });
  let value;
  try {
    value = JSON.parse(output.stdout.trim());
  } catch {
    throw new Error(`Python Worker 依赖探测没有返回有效 JSON：${output.stdout}`);
  }
  if (value.implementation !== 'CPython' || !Array.isArray(value.version) || value.version.length < 2) {
    throw new Error('发布 Worker 必须使用可识别的 CPython 运行时。');
  }
  return {
    implementation: value.implementation,
    version: { major: Number(value.version[0]), minor: Number(value.version[1]), text: value.version.join('.') },
    jiebaVersion: String(value.jiebaVersion),
  };
}

function resetRuntimeDirectory(target) {
  const buildDirectory = path.join(rootDir, 'build');
  const resolvedTarget = path.resolve(target);
  if (!resolvedTarget.startsWith(`${path.resolve(buildDirectory)}${path.sep}`)) throw new Error('拒绝清理 build 目录之外的路径。');
  rmSync(resolvedTarget, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  mkdirSync(resolvedTarget, { recursive: true });
}

function copyPythonRuntime(pythonHome, target, pythonDllName) {
  cpSync(path.join(pythonHome, 'python.exe'), path.join(target, 'python-worker.exe'));
  for (const fileName of [pythonDllName, 'python3.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'LICENSE.txt']) {
    const source = path.join(pythonHome, fileName);
    if (existsSync(source)) cpSync(source, path.join(target, fileName));
  }
  const standardLibrary = path.join(pythonHome, 'Lib');
  assertDirectory(standardLibrary, 'Python Lib 目录');
  // 应用依赖只来自经过验证的 .deps；不复制构建机的 site-packages，避免把
  // 无关的本地包或用户路径带入 portable 包。
  cpSync(standardLibrary, path.join(target, 'Lib'), {
    recursive: true,
    filter: (source) => {
      const parts = path.relative(standardLibrary, source).split(path.sep);
      return !parts.some((part) => ['site-packages', '__pycache__', 'test', 'idlelib', 'tkinter', 'turtledemo', 'ensurepip', 'pydoc_data', 'unittest', 'venv'].includes(part))
        && !source.endsWith('.pyc');
    },
  });
  const dllDirectory = path.join(pythonHome, 'DLLs');
  assertDirectory(dllDirectory, 'Python DLLs 目录');
  cpSync(dllDirectory, path.join(target, 'DLLs'), { recursive: true });
}

function copyWorkerDependencies(source, target) {
  mkdirSync(target, { recursive: true });
  // 复制所有依赖包（jieba、networkx 等），跳过 __pycache__ 和 .pyc。
  for (const name of readdirSync(source)) {
    if (name.startsWith('.') || name === '__pycache__') continue;
    const src = path.join(source, name);
    const dst = path.join(target, name);
    const stat = statSync(src, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isDirectory()) {
      cpSync(src, dst, {
        recursive: true,
        filter: (entry) => !entry.endsWith('.pyc') && !path.relative(src, entry).split(path.sep).includes('__pycache__'),
      });
    } else if (stat.isFile() && !name.endsWith('.pyc')) {
      cpSync(src, dst);
    }
  }
}

function writeRuntimePathFile(target, pythonDllName) {
  const pthName = `${path.basename(pythonDllName, '.dll') }._pth`;
  writeFileSync(path.join(target, pthName), ['.', 'Lib', 'DLLs', '.deps', 'import site', ''].join('\r\n'), 'utf8');
}

function verifyWorkerHandshake(target, executableName, workerArgs) {
  const executable = executableName === 'python3' ? 'python3' : path.join(target, executableName);
  const request = [
    JSON.stringify({ id: 'runtime-hello', method: 'hello', params: { protocolVersion: 1 } }),
    JSON.stringify({ id: 'runtime-shutdown', method: 'shutdown', params: {} }),
    '',
  ].join('\n');
  const result = run(executable, workerArgs, { cwd: target, input: request, timeout: 60_000, isolatedRuntime: !isDarwin });
  const messages = result.stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  const hello = messages.find((message) => message.id === 'runtime-hello');
  const shutdown = messages.find((message) => message.id === 'runtime-shutdown');
  if (!hello?.ok || hello.protocolVersion !== 1 || !Array.isArray(hello.capabilities) || !hello.capabilities.includes('runStage:chunks-v2')) {
    throw new Error('发布 Worker 握手失败，缺少 Parent/Child chunks-v2 能力。');
  }
  if (!shutdown?.ok) throw new Error('发布 Worker 无法优雅关闭。');
  if (hello.capabilities.includes('runStage:parse') || Object.hasOwn(hello, 'doclingVersion')) throw new Error('瘦身后的 Worker 不得再暴露 Docling 解析能力。');
  return hello;
}

function run(command, args, options) {
  const isolatedPath = options.isolatedRuntime
    ? (isDarwin ? '/usr/bin:/bin:/usr/sbin:/sbin' : `${process.env.SystemRoot}/System32;${process.env.SystemRoot}`)
    : undefined;
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: 'utf8',
    timeout: options.timeout,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PYTHONHOME: '', PYTHONPATH: '', ...(isolatedPath ? { PATH: isolatedPath } : {}) },
  });
  if (result.error) throw new Error(`无法启动 ${path.basename(command)}：${result.error.message}`);
  if (result.status !== 0) throw new Error(`${path.basename(command)} 运行失败（${result.status ?? '未知'}）：${result.stderr || result.stdout}`);
  return result;
}

function writeJsonAtomically(target, value) {
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, target);
}

function assertDirectory(target, label) {
  if (!existsSync(target)) throw new Error(`${label}不存在：${target}`);
}

function assertFile(target, label) {
  if (!existsSync(target)) throw new Error(`${label}不存在：${target}`);
}
