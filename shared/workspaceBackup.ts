/**
 * Shared types for workspace and library backups, restore previews, and backup status.
 * 工作区与资料库备份、恢复预览及备份状态的共享类型。
 */

/**
 * A backup root: either the workspace itself or an external library.
 * 备份根目录：工作区本身或外部资料库。
 */
export interface BackupRoot {
  /** Unique root id used by manifest entries. / 清单条目使用的唯一根 id。 */
  id: string;
  /** Absolute path of the root on disk. / 根目录在磁盘上的绝对路径。 */
  sourcePath: string;
  /** Human-readable label. / 可读标签。 */
  label: string;
  /** Whether the root is the workspace or a library. / 根目录是工作区还是资料库。 */
  kind: 'workspace' | 'library';
  /** Path relative to the workspace, when the root lives inside it. / 根目录位于工作区内时的相对路径。 */
  workspaceRelativePath?: string;
}

/**
 * A registered note or materials folder participating in backups.
 * 参与备份的已注册笔记或资料文件夹。
 */
export interface BackupRegistration {
  /** Whether the entry holds notes or materials. / 条目是笔记还是资料。 */
  kind: 'note' | 'materials';
  /** Id of the backup root containing this entry. / 包含该条目的备份根 id。 */
  rootId: string;
  /** Path relative to the root. / 相对根目录的路径。 */
  relativePath: string;
  /** Original source path, when known. / 原始来源路径（如果已知）。 */
  sourcePath?: string;
  /** Display alias. / 显示别名。 */
  alias: string;
  /** Optional icon identifier. / 可选图标标识。 */
  icon?: string;
  /** Whether the entry was created by the app or upgraded from a legacy layout. / 条目由应用创建还是从旧布局升级而来。 */
  origin?: 'created' | 'upgraded';
}

/**
 * A single backed-up file with integrity metadata.
 * 单个备份文件及其完整性元数据。
 */
export interface BackupFile {
  /** Id of the backup root containing the file. / 包含该文件的备份根 id。 */
  rootId: string;
  /** Path relative to the root. / 相对根目录的路径。 */
  relativePath: string;
  /** File size in bytes. / 文件字节大小。 */
  size: number;
  /** Hex SHA-256 digest of the file content. / 文件内容的十六进制 SHA-256 摘要。 */
  sha256: string;
  /** SQLite database version, when the file is a database. / 文件为数据库时的 SQLite 版本号。 */
  databaseVersion?: number;
}

/**
 * Manifest describing the contents and provenance of one backup archive.
 * 描述一份备份归档内容与来源的清单。
 */
export interface BackupManifest {
  /** Manifest schema version. / 清单结构版本。 */
  schemaVersion: 1;
  /** Application version that wrote the backup. / 写入备份的应用版本号。 */
  appVersion: string;
  /** ISO timestamp of backup creation. / 备份创建时的 ISO 时间戳。 */
  createdAt: string;
  /** Unique backup id. / 唯一备份 id。 */
  backupId: string;
  /** Whether the backup was manual or scheduled daily. / 备份是手动还是每日定时。 */
  kind: 'manual' | 'daily';
  /** Backup roots captured in this archive. / 本归档捕获的备份根。 */
  roots: BackupRoot[];
  /** Registered folders captured in this archive. / 本归档捕获的注册文件夹。 */
  registrations: BackupRegistration[];
  /** Workspace identity scope of the backup. / 备份的工作区身份范围。 */
  sourceScope: { workspaceId: string; principalId: string };
  /** Absolute workspace path at backup time, when different machines need reconciliation. / 备份时的工作区绝对路径，供跨机器校对。 */
  sourceWorkspacePath?: string;
  /** File inventory with integrity hashes. / 含完整性哈希的文件清单。 */
  files: BackupFile[];
  /** Empty directories preserved in the archive. / 归档中保留的空目录。 */
  directories: Array<{ rootId: string; relativePath: string }>;
  /** Paths intentionally left out of the archive. / 有意排除在归档之外的路径。 */
  omitted: string[];
}

/**
 * One source folder considered for backup.
 * 参与备份评估的单个来源文件夹。
 */
export interface BackupSource {
  /** Absolute path of the source. / 来源的绝对路径。 */
  path: string;
  /** Display alias. / 显示别名。 */
  alias: string;
  /** Whether the source holds notes or materials. / 来源是笔记还是资料。 */
  kind: 'note' | 'materials';
  /** Whether the source lives inside the workspace. / 来源是否位于工作区内。 */
  internal: boolean;
  /** Whether the source currently exists on disk. / 来源当前是否存在于磁盘上。 */
  exists: boolean;
}

/**
 * User-configurable backup settings and the last run outcome.
 * 用户可配置的备份设置及最近一次运行结果。
 */
export interface BackupConfiguration {
  /** Whether backups are enabled. / 是否启用备份。 */
  enabled: boolean;
  /** Directory receiving backup archives. / 接收备份归档的目录。 */
  targetDirectory: string;
  /** Extra external library paths included in backups. / 备份包含的额外外部资料库路径。 */
  externalLibraries: string[];
  /** ISO timestamp of the last successful backup. / 最近一次成功备份的 ISO 时间戳。 */
  lastSuccessfulAt?: string;
  /** Path of the last successful archive. / 最近一次成功归档的路径。 */
  lastSuccessfulPath?: string;
  /** Date string of the last daily backup. / 最近一次每日备份的日期字符串。 */
  lastDailyDate?: string;
  /** Last backup error message. / 最近一次备份错误信息。 */
  lastError?: string;
}

/**
 * Live progress and configuration snapshot of a backup operation.
 * 备份操作的实时进度与配置快照。
 */
export interface BackupStatus {
  /** Id of the running operation, when one is active. / 正在运行的操作 id（如有）。 */
  operationId?: string;
  /** Current operation phase. / 当前操作阶段。 */
  phase: 'idle' | 'preparing' | 'capturing' | 'packing' | 'validating' | 'restoring' | 'completed' | 'failed';
  /** Human-readable progress message. / 可读的进度信息。 */
  message: string;
  /** Items completed so far. / 已完成条目数。 */
  completed: number;
  /** Total items to process. / 需处理的条目总数。 */
  total: number;
  /** Output archive path once produced. / 生成后的输出归档路径。 */
  outputPath?: string;
  /** Backup configuration in effect. / 生效的备份配置。 */
  configuration: BackupConfiguration;
  /** Absolute workspace path being backed up. / 正在备份的工作区绝对路径。 */
  workspacePath: string;
  /** Sources considered for this backup. / 本次备份评估的来源列表。 */
  sources: BackupSource[];
}

/**
 * Dry-run preview of what a restore would write, with warnings.
 * 恢复将写入内容的预演预览，附带警告。
 */
export interface RestorePreview {
  /** Id of the restore operation. / 恢复操作 id。 */
  operationId: string;
  /** Manifest of the archive to restore. / 待恢复归档的清单。 */
  manifest: BackupManifest;
  /** Directory the restore would write into. / 恢复将写入的目标目录。 */
  targetDirectory: string;
  /** Planned write targets mapping roots to destination paths. / 将根映射到目标路径的计划写入项。 */
  targets: Array<{ rootId: string; sourcePath: string; targetPath: string }>;
  /** Warnings surfaced during preview. / 预览过程中产生的警告。 */
  warnings: string[];
}

/**
 * Live progress of a restore operation.
 * 恢复操作的实时进度。
 */
export interface RestoreStatus {
  /** Id of the restore operation. / 恢复操作 id。 */
  operationId: string;
  /** Current operation phase. / 当前操作阶段。 */
  phase: 'validating' | 'restoring' | 'completed' | 'failed';
  /** Human-readable progress message. / 可读的进度信息。 */
  message: string;
  /** Items completed so far. / 已完成条目数。 */
  completed: number;
  /** Total items to process. / 需处理的条目总数。 */
  total: number;
  /** Workspace path being restored. / 正在恢复的工作区路径。 */
  workspacePath: string;
  /** Directory the restore writes into. / 恢复写入的目标目录。 */
  targetDirectory: string;
  /** Warnings accumulated during restore. / 恢复过程中累积的警告。 */
  warnings: string[];
}

/**
 * Connection settings hints recovered from a backup for re-linking services.
 * 从备份中恢复、用于重新连接服务的连接设置提示。
 */
export interface RestoredConnectionHints {
  /** AI model settings profiles found in the backup. / 备份中发现的 AI 模型设置档案。 */
  aiModelSettings?: { profiles: Array<{ id: string; label: string; config: { model?: string; endpoint?: string } }> };
  /** Model hub providers found in the backup. / 备份中发现的模型中心供应商。 */
  modelHub?: { providers: Array<{ id?: string; label?: string; endpoint?: string }> };
  /** Parsing service endpoint found in the backup. / 备份中发现的解析服务端点。 */
  parsing?: { mineruEndpoint?: string };
}
