/**
 * Workspace directory validation: ensures a chosen folder is readable, writable and ready to host Trellora data.
 * 工作区目录校验：确保所选文件夹可读写，并已准备好承载 Trellora 数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getLibraryMetaDirectory } from '../files/treeOrder.ts';

const workspaceSystemDirectoryName = '.menghan-workspace';

/**
 * Result of validating a system workspace directory.
 * 系统工作区目录的校验结果。
 */
export interface SystemWorkspaceValidationResult {
  /** Resolved absolute workspace path / 解析后的绝对工作区路径 */
  path: string;
  /** Resolved absolute system directory path / 解析后的绝对系统目录路径 */
  systemDirectory: string;
}

/**
 * Result of validating a note library workspace directory.
 * 笔记库工作区目录的校验结果。
 */
export interface WorkspaceValidationResult {
  /** Resolved absolute workspace path / 解析后的绝对工作区路径 */
  path: string;
  /** Resolved absolute metadata directory path / 解析后的绝对元数据目录路径 */
  metaDirectory: string;
}

/**
 * Create and validate a system workspace directory plus its system subdirectory.
 * 创建并校验系统工作区目录及其系统子目录。
 *
 * @param workspacePath - Requested workspace directory path / 请求的工作区目录路径
 * @returns Resolved workspace and system directory paths / 解析后的工作区与系统目录路径
 */
export function validateSystemWorkspaceDirectory(workspacePath: string): SystemWorkspaceValidationResult {
  const resolvedPath = path.resolve(workspacePath);

  try {
    fs.mkdirSync(resolvedPath, { recursive: true });
    fs.accessSync(resolvedPath, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    throw new Error(`工作区必须可读写：${resolvedPath}`);
  }

  const systemDirectory = path.join(resolvedPath, workspaceSystemDirectoryName);
  try {
    fs.mkdirSync(systemDirectory, { recursive: true });
    fs.accessSync(systemDirectory, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    throw new Error(`无法在工作区中创建系统文件目录：${systemDirectory}`);
  }

  return { path: resolvedPath, systemDirectory };
}

/**
 * Validate an existing note library directory and ensure its metadata directory is writable.
 * 校验已存在的笔记库目录，并确保其元数据目录可写。
 *
 * @param workspacePath - Requested library directory path / 请求的笔记库目录路径
 * @returns Resolved library and metadata directory paths / 解析后的笔记库与元数据目录路径
 */
export function validateWorkspaceDirectory(workspacePath: string): WorkspaceValidationResult {
  const resolvedPath = path.resolve(workspacePath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`选择的笔记库不存在：${resolvedPath}`);
  }

  const stat = fs.statSync(resolvedPath);
  if (!stat.isDirectory()) {
    throw new Error(`选择的位置不是文件夹：${resolvedPath}`);
  }

  try {
    fs.accessSync(resolvedPath, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    throw new Error(`选择的笔记库必须可读写：${resolvedPath}`);
  }

  const metaDirectory = getLibraryMetaDirectory(resolvedPath);
  try {
    fs.mkdirSync(metaDirectory, { recursive: true });
    fs.accessSync(metaDirectory, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    throw new Error(`无法在该笔记库中创建系统元数据目录：${metaDirectory}`);
  }

  return { path: resolvedPath, metaDirectory };
}
