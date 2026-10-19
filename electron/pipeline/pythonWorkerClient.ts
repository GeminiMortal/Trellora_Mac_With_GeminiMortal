/**
 * Python worker client: spawns the pipeline worker, performs the hello handshake,
 * and speaks the NDJSON request/response protocol with timeouts and cancellation.
 * Python Worker 客户端：启动流水线 Worker、执行 hello 握手，并以超时与取消语义收发 NDJSON 协议消息。
 */

import { app } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { PIPELINE_ENGINE_VERSION, PIPELINE_PROTOCOL_VERSION, type PipelineProgressEvent, type PipelineStageId, type WorkerRunStageResult } from './types.ts';

interface WorkerMessage {
  id?: string;
  type?: string;
  ok?: boolean;
  code?: string;
  message?: string;
  diagnostic?: string;
  retryable?: boolean;
  [key: string]: unknown;
}

interface PendingRequest {
  resolve: (message: WorkerMessage) => void;
  reject: (error: WorkerClientError) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface WorkerCommand {
  executable: string;
  args: string[];
  cwd: string;
  packaged: boolean;
}

/**
 * Error raised by the worker client with a stable code and retry hint.
 * Worker 客户端抛出的错误，携带稳定错误码与可重试提示。
 */
export class WorkerClientError extends Error {
  /** Stable error code / 稳定错误码 */
  readonly code: string;
  /** Whether the operation may be retried / 操作是否可重试 */
  readonly retryable: boolean;
  /** Optional developer diagnostics / 可选开发者诊断信息 */
  readonly diagnostic?: string;

  /**
   * Creates a worker client error.
   * 创建 Worker 客户端错误。
   *
   * @param code - Stable error code / 稳定错误码
   * @param message - Human-readable message / 可读错误信息
   * @param retryable - Whether retry may succeed (defaults to true) / 重试是否可能成功（默认 true）
   * @param diagnostic - Optional diagnostic detail / 可选诊断细节
   */
  constructor(code: string, message: string, retryable = true, diagnostic?: string) {
    super(message);
    this.name = 'WorkerClientError';
    this.code = code;
    this.retryable = retryable;
    this.diagnostic = diagnostic;
  }
}

/**
 * Callbacks wired into the client by its owner.
 * 由持有方注入客户端的回调。
 */
export interface WorkerClientOptions {
  /** Progress event callback / 进度事件回调 */
  onProgress?: (event: Omit<PipelineProgressEvent, 'libraryPath' | 'documentId'>) => void;
  /** Worker stderr log sink / Worker stderr 日志接收器 */
  onLog?: (message: string) => void;
}

/**
 * Result of Jieba search tokenization performed by the worker.
 * 由 Worker 执行的 Jieba 检索分词结果。
 */
export interface WorkerSearchTokenizationResult {
  /** Produced tokens / 产出的词元 */
  tokens: string[];
  /** Tokenizer id / 分词器标识 */
  tokenizer: string;
  /** Tokenizer version / 分词器版本 */
  tokenizerVersion: string;
  /** Dictionary hash used / 使用的词典哈希 */
  dictionaryHash: string;
}

/**
 * Manages one Python worker process and its NDJSON protocol.
 * 管理单个 Python Worker 进程及其 NDJSON 协议。
 */
export class PythonWorkerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private sequence = 0;
  private helloPromise: Promise<void> | null = null;
  private capabilities = new Set<string>();
  private readonly options: WorkerClientOptions;

  /**
   * Creates the client (the process starts lazily on first request).
   * 创建客户端（进程在首次请求时惰性启动）。
   *
   * @param options - Progress and log callbacks / 进度与日志回调
   */
  constructor(options: WorkerClientOptions = {}) {
    this.options = options;
  }

  /**
   * Starts the worker if needed and returns its advertised capabilities.
   * 必要时启动 Worker 并返回其声明的能力列表。
   *
   * @returns Capability names / 能力名称列表
   */
  async probe(): Promise<string[]> {
    await this.ensureStarted();
    return [...this.capabilities];
  }

  /**
   * Runs one pipeline stage. stage supports document stages plus the
   * library-level 'graph' (graph assembly, outside the document stage order).
   * stage 支持文档级阶段与库级 'graph'（图装配，不属于文档流水线顺序）。
   *
   * @param params - Stage parameters / 阶段参数
   * @param params.jobId - Job id for progress and cancellation / 用于进度与取消的任务 ID
   * @param params.stage - Stage identifier / 阶段标识
   * @param params.inputPath - Input path / 输入路径
   * @param params.outputDir - Output directory / 输出目录
   * @param params.options - Stage-specific options / 阶段专属选项
   * @returns Stage result with manifest path and counters / 含清单路径与计数的阶段结果
   */
  async runStage(params: { jobId: string; stage: PipelineStageId | 'graph'; inputPath: string; outputDir: string; options?: Record<string, unknown> }): Promise<WorkerRunStageResult> {
    const response = await this.request('runStage', {
      jobId: params.jobId,
      stage: params.stage,
      inputPath: params.inputPath,
      outputDir: params.outputDir,
      options: params.options ?? {},
    }, 6 * 60 * 60 * 1000);
    return {
      artifactManifest: String(response.artifactManifest ?? ''),
      counts: isRecord(response.counts) ? Object.fromEntries(Object.entries(response.counts).flatMap(([key, value]) => typeof value === 'number' ? [[key, value]] : [])) : {},
    };
  }

  /**
   * Tokenizes a search query with Jieba using the library dictionary.
   * 使用资料库词典以 Jieba 对检索查询分词。
   *
   * @param params - Tokenization parameters / 分词参数
   * @param params.query - Query text / 查询文本
   * @param params.dictionaryTerms - Dictionary terms / 词典词表
   * @param params.stopwords - Stopwords to drop / 需丢弃的停用词
   * @returns Tokens plus tokenizer provenance / 词元及分词器来源信息
   */
  async tokenizeSearch(params: { query: string; dictionaryTerms: string[]; stopwords: string[] }): Promise<WorkerSearchTokenizationResult> {
    const response = await this.request('tokenizeSearch', params, 15_000);
    if (!Array.isArray(response.tokens)
      || response.tokens.length > 64
      || response.tokens.some((token) => typeof token !== 'string' || !token || token.length > 128)) {
      throw new WorkerClientError('SEARCH_TOKENIZE_RESPONSE_INVALID', 'Jieba 检索分词返回了无效词元。', false);
    }
    return {
      tokens: response.tokens as string[],
      tokenizer: String(response.tokenizer ?? ''),
      tokenizerVersion: String(response.tokenizerVersion ?? ''),
      dictionaryHash: String(response.dictionaryHash ?? ''),
    };
  }

  /**
   * Cancels a running job by id.
   * 按 ID 取消运行中的任务。
   *
   * @param jobId - Job id to cancel / 要取消的任务 ID
   */
  async cancel(jobId: string): Promise<void> {
    if (!this.child) return;
    await this.request('cancel', { jobId }, 10_000);
  }

  /**
   * Gracefully stops the worker, escalating to kill if it does not exit in time.
   * 优雅停止 Worker，未在时限内退出则强制结束进程。
   */
  async shutdown(): Promise<void> {
    if (!this.child) return;
    const child = this.child;
    let exited = child.exitCode !== null || child.signalCode !== null;
    const exit = new Promise<void>(resolve => child.once('exit', () => { exited = true; resolve(); }));
    try {
      await this.request('shutdown', {}, 2_000);
    } catch {
      child.kill();
    } finally {
      await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 2_000))]);
      if (!exited) { child.kill(); await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 1_000))]); }
      this.handleProcessFailure(new WorkerClientError('WORKER_STOPPED', '文档处理 Worker 已关闭。', true));
      this.child = null;
      this.helloPromise = null;
      this.capabilities.clear();
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && this.helloPromise) return this.helloPromise;
    const { executable, args, cwd, packaged } = await resolveWorkerCommand();
    if (!fs.existsSync(cwd)) throw new WorkerClientError('WORKER_NOT_FOUND', '文档处理 Worker 目录不存在，请重新安装应用或配置开发环境。', false);
    if (packaged && path.isAbsolute(executable) && !fs.existsSync(executable)) {
      throw new WorkerClientError(
        'WORKER_RUNTIME_MISSING',
        packaged ? '文档处理运行时缺失或安装不完整，请重新安装Trellora；笔记编辑和文件浏览仍可正常使用。' : '开发环境缺少 Python Worker，请创建 pipeline-python/.venv 或安装 Python 后重试。',
        false,
      );
    }
    if (packaged && !fs.existsSync(path.join(cwd, 'runtime-manifest.json')) && !fs.existsSync(path.join(cwd, 'pipeline_worker'))) {
      throw new WorkerClientError('WORKER_RUNTIME_MISSING', '文档处理运行时清单缺失，请重新安装Trellora；笔记编辑和文件浏览仍可正常使用。', false);
    }

    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    const output = readline.createInterface({ input: child.stdout });
    output.on('line', (line) => this.handleLine(line));
    child.stdin.setDefaultEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data: string) => this.options.onLog?.(`[PIPELINE] ${data.trim()}`));
    child.on('error', (error) => this.handleProcessFailure(new WorkerClientError('WORKER_START_FAILED', `文档处理 Worker 启动失败：${error.message}`, true, error.stack)));
    child.on('exit', (code, signal) => {
      if (this.child === child) { this.child = null; this.helloPromise = null; this.capabilities.clear(); }
      if (code !== 0 && code !== null) this.handleProcessFailure(new WorkerClientError('WORKER_CRASHED', `文档处理 Worker 已退出（代码 ${code}）。`, true));
      else if (signal) this.handleProcessFailure(new WorkerClientError('WORKER_CRASHED', `文档处理 Worker 被终止（${signal}）。`, true));
      else this.handleProcessFailure(new WorkerClientError('WORKER_STOPPED', '文档处理 Worker 已关闭。', true));
    });

    this.helloPromise = this.request('hello', { protocolVersion: PIPELINE_PROTOCOL_VERSION }, 15_000).then((response) => {
      if (response.protocolVersion !== PIPELINE_PROTOCOL_VERSION) {
        throw new WorkerClientError('PROTOCOL_MISMATCH', '文档处理 Worker 协议版本不兼容，请更新应用。', false);
      }
      if (response.engineVersion !== PIPELINE_ENGINE_VERSION) throw new WorkerClientError('ENGINE_MISMATCH', '文档处理引擎版本不兼容，请更新应用。', false);
      this.capabilities = new Set(Array.isArray(response.capabilities)
        ? response.capabilities.filter((value): value is string => typeof value === 'string')
        : []);
    }).catch((error) => {
      this.helloPromise = null;
      this.capabilities.clear();
      this.child?.kill();
      this.child = null;
      throw error;
    });
    return this.helloPromise;
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<WorkerMessage> {
    return new Promise((resolve, reject) => {
      void this.ensureChildForRequest(method, params, timeoutMs, resolve, reject);
    });
  }

  private async ensureChildForRequest(method: string, params: Record<string, unknown>, timeoutMs: number, resolve: PendingRequest['resolve'], reject: PendingRequest['reject']): Promise<void> {
    try {
      if (method !== 'hello') await this.ensureStarted();
      if (method === 'runStage' && isRecord(params.options) && typeof params.options.llmPhase === 'string' && !this.capabilities.has('runStage:chunks-llm-v1')) {
        throw new WorkerClientError('WORKER_CAPABILITY_MISSING', '当前文档处理 Worker 不支持智能切块 continuation，请更新应用与 Worker runtime。', false);
      }
      if (method === 'tokenizeSearch' && !this.capabilities.has('tokenizeSearch:jieba-v1')) {
        throw new WorkerClientError('WORKER_CAPABILITY_MISSING', '当前文档 Worker 不支持 Jieba 检索分词，请更新应用与 Worker runtime。', false);
      }
      const child = this.child;
      if (!child?.stdin.writable) throw new WorkerClientError('WORKER_NOT_RUNNING', '文档处理 Worker 尚未运行。', true);
      const id = `req-${++this.sequence}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new WorkerClientError('WORKER_TIMEOUT', `文档处理 Worker 在 ${Math.round(timeoutMs / 1000)} 秒内未响应。`, true));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      // Keep request JSON ASCII-safe as well. This protects packaged
      // runtimes whose stdin still uses a legacy code page before reconfigure.
      // 请求 JSON 同样保持 ASCII 安全。这保护发布版运行时——其 stdin 在 reconfigure 之前仍使用旧代码页。
      child.stdin.write(`${stringifyWorkerRequest({ id, method, params })}\n`);
    } catch (error) {
      reject(error instanceof WorkerClientError ? error : new WorkerClientError('WORKER_REQUEST_FAILED', String(error), true));
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: WorkerMessage;
    try {
      message = JSON.parse(line) as WorkerMessage;
    } catch {
      this.options.onLog?.('[PIPELINE] Worker 输出了无法识别的协议消息。');
      return;
    }
    if (message.type === 'progress') {
      this.options.onProgress?.({
        jobId: String(message.jobId ?? ''),
        stage: isPipelineStage(String(message.stage ?? '')) ? String(message.stage) as PipelineStageId : 'parse',
        completed: Number(message.completed ?? 0),
        ...(typeof message.total === 'number' ? { total: message.total } : {}),
        ...(typeof message.unit === 'string' ? { unit: message.unit } : {}),
        message: String(message.message ?? ''),
      });
      return;
    }
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok === false) {
      pending.reject(new WorkerClientError(
        String(message.code ?? 'WORKER_FAILED'),
        String(message.message ?? '文档处理 Worker 执行失败。'),
        message.retryable !== false,
        typeof message.diagnostic === 'string' ? message.diagnostic : undefined,
      ));
      return;
    }
    pending.resolve(message);
  }

  private handleProcessFailure(error: WorkerClientError): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    this.options.onLog?.(`[PIPELINE] ${error.message}`);
  }
}

function isPipelineStage(value: string): value is PipelineStageId {
  return value === 'parse' || value === 'lines' || value === 'signals' || value === 'ambiguity' || value === 'tree' || value === 'chunks' || value === 'keywords' || value === 'entities';
}

const MINIMUM_PYTHON_MAJOR = 3;
const MINIMUM_PYTHON_MINOR = 10;
let systemPythonProbe: Promise<string | null> | null = null;

/**
 * Verifies the interpreter meets the worker source's minimum version (graph_leiden
 * uses PEP 604 union types, requiring 3.10+).
 * 校验解释器满足 Worker 源码的版本下限（graph_leiden 等使用 PEP 604 联合类型，需 3.10+）。
 */
function probePythonVersion(executable: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, ['-E', '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    let output = '';
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve(value);
    };
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('error', () => finish(false));
    child.on('exit', (code) => {
      const match = /^(\d+)\.(\d+)/m.exec(output.trim());
      if (!match) return finish(false);
      const [major, minor] = [Number(match[1]), Number(match[2])];
      finish(code === 0 && (major > MINIMUM_PYTHON_MAJOR || (major === MINIMUM_PYTHON_MAJOR && minor >= MINIMUM_PYTHON_MINOR)));
    });
    setTimeout(() => finish(false), 6_000).unref();
  });
}

/**
 * 从 Finder 启动时 PATH 是干净的 /usr/bin:/bin，裸 python3 会命中系统 3.9；按绝对路径优先级探测。
 * When launched from Finder the PATH is a clean /usr/bin:/bin, so a bare python3 resolves to the system 3.9; candidates are probed by absolute-path priority.
 *
 * @returns Candidate interpreter paths in priority order / 按优先级排列的候选解释器路径
 */
function darwinPythonCandidates(): string[] {
  const candidates: string[] = [];
  const configured = process.env.MENGHAN_PIPELINE_PYTHON?.trim();
  if (configured) candidates.push(path.resolve(configured));
  for (const directory of ['/opt/homebrew/bin', '/usr/local/bin']) {
    for (const suffix of ['3.13', '3.12', '3.11', '3.10']) candidates.push(path.join(directory, `python${suffix}`));
    candidates.push(path.join(directory, 'python3'));
  }
  const frameworkRoot = '/Library/Frameworks/Python.framework/Versions';
  try {
    for (const version of fs.readdirSync(frameworkRoot)) {
      if (version === 'Current') continue;
      candidates.push(path.join(frameworkRoot, version, 'bin', 'python3'));
    }
  } catch { /* 未安装 python.org 发行版。 */ }
  candidates.push('/usr/bin/python3');
  candidates.push('python3');
  return candidates;
}

/**
 * Windows Python 探测：检查常见安装路径和 PATH 中的 python 命令。
 * Windows Python probe: checks common installation paths and python command in PATH.
 *
 * @returns Candidate interpreter paths in priority order / 按优先级排列的候选解释器路径
 */
function windowsPythonCandidates(): string[] {
  const candidates: string[] = [];
  const configured = process.env.MENGHAN_PIPELINE_PYTHON?.trim();
  if (configured) candidates.push(path.resolve(configured));

  // 检查用户目录下的 Python 安装
  const userProfile = process.env.USERPROFILE || process.env.HOME || '';
  if (userProfile) {
    for (const suffix of ['313', '312', '311', '310']) {
      candidates.push(path.join(userProfile, 'AppData', 'Local', 'Programs', 'Python', `Python${suffix}`, 'python.exe'));
    }
  }

  // 检查 Program Files 下的 Python
  const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432].filter(Boolean);
  for (const dir of programFiles) {
    for (const suffix of ['Python313', 'Python312', 'Python311', 'Python310']) {
      candidates.push(path.join(dir!, suffix, 'python.exe'));
    }
  }

  // 检查 PATH 中的 python 命令
  candidates.push('python');
  candidates.push('python3');

  return candidates;
}

/**
 * 跨平台 Python 探测：根据当前操作系统选择合适的探测策略。
 * Cross-platform Python probe: selects the appropriate probe strategy based on the current OS.
 *
 * @returns Candidate interpreter paths in priority order / 按优先级排列的候选解释器路径
 */
function getPythonCandidates(): string[] {
  if (process.platform === 'win32') {
    return windowsPythonCandidates();
  }
  return darwinPythonCandidates();
}

/**
 * 进程内一次性探测可用解释器；结果缓存，安装新 Python 后重启应用即可生效。
 * Probes for a usable interpreter once per process; the result is cached, so a restart picks up newly installed Pythons.
 *
 * @returns Compatible interpreter path or null / 兼容解释器路径，找不到时为 null
 */
function findCompatibleSystemPython(): Promise<string | null> {
  systemPythonProbe ??= (async () => {
    for (const candidate of getPythonCandidates()) {
      if (candidate.includes(path.sep) && !fs.existsSync(candidate)) continue;
      if (await probePythonVersion(candidate)) return candidate;
    }
    return null;
  })();
  return systemPythonProbe;
}

async function resolveWorkerCommand(): Promise<WorkerCommand> {
  const developmentDirectory = path.resolve(__dirname, '../pipeline-python');
  if (!app.isPackaged) {
    const venvPython = path.join(developmentDirectory, '.venv', 'bin', 'python');
    if (fs.existsSync(venvPython)) return { executable: venvPython, args: ['-m', 'pipeline_worker'], cwd: developmentDirectory, packaged: false };
    const systemPython = await findCompatibleSystemPython();
    if (!systemPython) throw new WorkerClientError('WORKER_RUNTIME_MISSING', `开发环境缺少 Python ${MINIMUM_PYTHON_MAJOR}.${MINIMUM_PYTHON_MINOR}+，请创建 pipeline-python/.venv 或安装 Homebrew Python 后重试。`, false);
    return { executable: systemPython, args: ['-m', 'pipeline_worker'], cwd: developmentDirectory, packaged: false };
  }
  const runtimeDirectory = path.join(process.resourcesPath, 'pipeline-runtime');
  const bundledPython = path.join(runtimeDirectory, 'python-worker');
  if (fs.existsSync(bundledPython)) return { executable: bundledPython, args: ['-E', '-m', 'pipeline_worker'], cwd: runtimeDirectory, packaged: true };
  const systemPython = await findCompatibleSystemPython();
  if (!systemPython) throw new WorkerClientError('WORKER_RUNTIME_MISSING', `文档处理需要 Python ${MINIMUM_PYTHON_MAJOR}.${MINIMUM_PYTHON_MINOR} 或更高版本，当前系统未找到可用解释器。请安装 Homebrew Python（brew install python@3.12）后重启应用；笔记编辑和文件浏览仍可正常使用。`, false);
  return { executable: systemPython, args: ['-E', '-m', 'pipeline_worker'], cwd: runtimeDirectory, packaged: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringifyWorkerRequest(value: Record<string, unknown>): string {
  return JSON.stringify(value).replace(/[^\p{ASCII}]/gu, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
