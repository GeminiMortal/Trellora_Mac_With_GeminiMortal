/**
 * Runs Mammoth DOCX parsing in an isolated Node worker thread with cancel/timeout handling.
 * 在隔离的 Node Worker 线程中运行 Mammoth DOCX 解析，支持取消与超时处理。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { PipelineStageError } from './stageErrors.ts';

const MAMMOTH_TIMEOUT_MS = 5 * 60 * 1000;

interface MammothWorkerMessage {
  ok: boolean;
  counts?: Record<string, number>;
  code?: string;
  message?: string;
  diagnostic?: string;
  retryable?: boolean;
}

/**
 * Progress event emitted while the Mammoth stage runs.
 * Mammoth 阶段运行期间发出的进度事件。
 */
export interface MammothStageProgress {
  /** Completed work units. / 已完成工作单元数。 */
  completed: number;
  /** Total work units. / 总工作单元数。 */
  total: number;
  /** Human-readable progress message. / 面向用户的进度信息。 */
  message: string;
}

/**
 * Result of a successful Mammoth DOCX parse.
 * Mammoth DOCX 解析成功的结果。
 */
export interface MammothStageResult {
  /** Counts of generated artifacts (e.g. blocks). / 生成产物的计数（如文档块数量）。 */
  counts: Record<string, number>;
}

/**
 * Mammoth runs in an isolated Node worker so a large DOCX cannot block the
 * Electron main process. The worker writes only into the orchestrator's stage
 * temp directory; the original document remains read-only.
 * Mammoth 运行在隔离的 Node Worker 中，避免大型 DOCX 阻塞 Electron 主进程；
 * Worker 只写入编排器分配的阶段临时目录，原始文档保持只读。
 *
 * @param params - Parse job parameters / 解析任务参数
 * @param params.inputPath - Absolute path of the source DOCX / 源 DOCX 绝对路径
 * @param params.outputDir - Stage temp directory the worker writes into / Worker 写入的阶段临时目录
 * @param params.sourceName - Optional display name of the source document / 可选的源文档显示名称
 * @param params.signal - Abort signal used to cancel the parse / 用于取消解析的中止信号
 * @param params.onProgress - Optional progress callback / 可选的进度回调
 * @param params.workerScriptPath - Optional override of the worker script location / 可选的 Worker 脚本路径覆盖
 * @returns Resolves with parse counts on success / 成功时返回解析计数
 */
export function runMammothDocxParse(params: {
  inputPath: string;
  outputDir: string;
  sourceName?: string;
  signal: AbortSignal;
  onProgress?: (progress: MammothStageProgress) => void;
  workerScriptPath?: string;
}): Promise<MammothStageResult> {
  if (!fs.existsSync(params.inputPath) || !fs.statSync(params.inputPath).isFile()) {
    throw new PipelineStageError('SOURCE_NOT_FOUND', '原始 DOCX 不存在或不可读。', false);
  }
  if (path.extname(params.inputPath).toLowerCase() !== '.docx') {
    throw new PipelineStageError('UNSUPPORTED_FORMAT', 'Mammoth 仅支持 DOCX 文档。', false);
  }
  if (params.signal.aborted) {
    throw new PipelineStageError('STAGE_CANCELLED', 'DOCX 解析任务已取消。', true);
  }

  const workerPath = params.workerScriptPath ?? resolveMammothWorkerPath();
  if (!fs.existsSync(workerPath)) {
    throw new PipelineStageError('MAMMOTH_WORKER_MISSING', 'Mammoth 解析组件缺失，请重新构建或安装应用。', false, workerPath);
  }
  fs.mkdirSync(params.outputDir, { recursive: true });
  params.onProgress?.({ completed: 0, total: 1, message: '正在使用 Mammoth 解析 DOCX。' });

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, {
      workerData: {
        inputPath: params.inputPath,
        outputDir: params.outputDir,
        sourceName: params.sourceName ?? path.basename(params.inputPath),
      },
    });
    let settled = false;
    // Settle-once guard shared by message/abort/timeout/exit paths to avoid double resolution.
    // message/abort/timeout/exit 各路径共用的“只结束一次”守卫，防止重复 settle。
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      params.signal.removeEventListener('abort', abort);
      callback();
    };
    const abort = (): void => {
      void worker.terminate();
      finish(() => reject(new PipelineStageError('STAGE_CANCELLED', 'DOCX 解析任务已取消。', true)));
    };
    const timeout = setTimeout(() => {
      void worker.terminate();
      finish(() => reject(new PipelineStageError('MAMMOTH_TIMEOUT', 'Mammoth 解析 DOCX 超时，可以重试。', true)));
    }, MAMMOTH_TIMEOUT_MS);

    params.signal.addEventListener('abort', abort, { once: true });
    worker.once('message', (message: MammothWorkerMessage) => {
      if (!message?.ok) {
        finish(() => reject(new PipelineStageError(
          message?.code ?? 'MAMMOTH_PARSE_FAILED',
          message?.message ?? 'Mammoth 解析 DOCX 失败。',
          message?.retryable !== false,
          message?.diagnostic,
        )));
        return;
      }
      const counts = message.counts ?? {};
      finish(() => {
        params.onProgress?.({ completed: 1, total: 1, message: `DOCX 解析完成，共生成 ${counts.blocks ?? 0} 个文档块。` });
        resolve({ counts });
      });
    });
    worker.once('error', (error) => {
      finish(() => reject(new PipelineStageError('MAMMOTH_WORKER_FAILED', `Mammoth 解析组件启动失败：${error.message}`, true, error.stack)));
    });
    worker.once('exit', (code) => {
      if (settled) return;
      finish(() => reject(new PipelineStageError('MAMMOTH_WORKER_EXITED', `Mammoth 解析组件异常退出（代码 ${code}）。`, true)));
    });
  });
}

function resolveMammothWorkerPath(): string {
  // Packaged apps load the worker from app.asar.unpacked; dev uses the sibling bundle.
  // 打包后从 app.asar.unpacked 加载 Worker；开发环境使用同目录 bundle。
  if (__dirname.includes(`${path.sep}app.asar${path.sep}`)) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'dist-electron', 'mammothWorker.js');
  }
  return path.join(__dirname, 'mammothWorker.js');
}
