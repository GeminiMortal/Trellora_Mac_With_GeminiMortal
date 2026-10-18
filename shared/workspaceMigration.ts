/**
 * Shared types for workspace data migration: previews, phases, and live status.
 * 工作区数据迁移的共享类型：预览、阶段与实时状态。
 */

/**
 * A note or materials library participating in a workspace migration.
 * 参与工作区迁移的笔记或资料库。
 */
export interface WorkspaceMigrationLibrary {
  /** Absolute path of the library. / 资料库绝对路径。 */
  path: string;
  /** Display alias. / 显示别名。 */
  alias: string;
  /** Whether the library holds notes or materials. / 资料库是笔记还是资料。 */
  kind: 'note' | 'materials';
  /** Whether the library lives inside the workspace. / 资料库是否位于工作区内。 */
  internal: boolean;
}

/**
 * Dry-run preview of a workspace migration before it starts.
 * 工作区迁移开始前的预演预览。
 */
export interface WorkspaceMigrationPreview {
  /** Id of the migration operation. / 迁移操作 id。 */
  operationId: string;
  /** Current workspace path. / 当前工作区路径。 */
  sourcePath: string;
  /** Destination workspace path. / 目标工作区路径。 */
  targetPath: string;
  /** Number of files to migrate. / 需迁移的文件数。 */
  fileCount: number;
  /** Total bytes to migrate. / 需迁移的总字节数。 */
  totalBytes: number;
  /** Libraries involved in the migration. / 参与迁移的资料库。 */
  libraries: WorkspaceMigrationLibrary[];
}

/**
 * Lifecycle phases of a workspace migration.
 * 工作区迁移的生命周期阶段。
 */
export type WorkspaceMigrationPhase = 'idle' | 'preparing' | 'copying' | 'mapping'
  | 'validating' | 'switching' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

/**
 * Live progress of a workspace migration.
 * 工作区迁移的实时进度。
 */
export interface WorkspaceMigrationStatus {
  /** Id of the running operation, when one is active. / 正在运行的操作 id（如有）。 */
  operationId?: string;
  /** Current migration phase. / 当前迁移阶段。 */
  phase: WorkspaceMigrationPhase;
  /** Human-readable progress message. / 可读的进度信息。 */
  message: string;
  /** Overall progress ratio from 0 to 1. / 总体进度比例（0 到 1）。 */
  progress: number;
  /** Bytes copied so far. / 已复制的字节数。 */
  completedBytes: number;
  /** Total bytes to copy. / 需复制的总字节数。 */
  totalBytes: number;
  /** Files copied so far. / 已复制的文件数。 */
  completedFiles: number;
  /** Total files to copy. / 需复制的总文件数。 */
  totalFiles: number;
  /** File currently being copied. / 正在复制的文件。 */
  currentFile?: string;
  /** Source workspace path. / 源工作区路径。 */
  sourcePath?: string;
  /** Target workspace path. / 目标工作区路径。 */
  targetPath?: string;
  /** Whether the migration can be cancelled at this point. / 当前是否可取消迁移。 */
  canCancel: boolean;
}

/**
 * Combined migration state: live status plus any pending preview awaiting confirmation.
 * 迁移的组合状态：实时状态加等待确认的预览。
 */
export interface WorkspaceMigrationState {
  /** Live migration status. / 实时迁移状态。 */
  status: WorkspaceMigrationStatus;
  /** Pending preview awaiting user confirmation, if any. / 等待用户确认的预览（如有）。 */
  pending: WorkspaceMigrationPreview | null;
}
