"""
Module: stage_errors
Error types for pipeline stage execution. Provides structured error codes
and diagnostic information for Worker-Electron error handling.
模块：stage_errors
流水线阶段执行的错误类型。提供结构化错误码和诊断信息，
用于 Worker 与 Electron 的错误处理。
"""

from __future__ import annotations


class StageError(Exception):
    """
    Base error for pipeline stage failures.
    Contains error code, user-facing message, retryability flag, and optional diagnostic.
    流水线阶段失败的基础错误。
    包含错误码、面向用户的消息、可重试标志和可选诊断信息。
    """

    def __init__(self, code: str, message: str, retryable: bool, diagnostic: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.diagnostic = diagnostic


class StageCancelled(StageError):
    """
    Raised when a stage is cancelled via the cancel event.
    当阶段通过取消事件被取消时抛出。
    """

    def __init__(self) -> None:
        super().__init__('STAGE_CANCELLED', '文档处理任务已取消。', True)
