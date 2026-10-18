"""
Module: pipeline_worker
Trellora local document parsing worker. Handles NDJSON protocol communication
with Electron main process and executes document processing stages.
模块：pipeline_worker
Trellora 本地文档解析 Worker。通过 NDJSON 协议与 Electron 主进程通信，
执行文档处理各阶段任务。
"""

import sys
from pathlib import Path


# Development dependency path for local .deps directory / 开发环境依赖路径
development_dependencies = Path(__file__).resolve().parents[1] / '.deps'
if development_dependencies.is_dir():
    dependency_path = str(development_dependencies)
    if dependency_path not in sys.path:
        sys.path.insert(0, dependency_path)

# Worker version identifier / Worker 版本标识
WORKER_VERSION = '0.3.0'
# NDJSON protocol version for Electron compatibility / NDJSON 协议版本，用于 Electron 兼容性
PROTOCOL_VERSION = 1
