"""
Module: protocol
NDJSON protocol implementation for Worker-Electron communication.
Handles thread-safe message serialization and stdin/stdout I/O.
模块：protocol
Worker 与 Electron 通信的 NDJSON 协议实现。
处理线程安全的消息序列化和 stdin/stdout I/O。
"""

from __future__ import annotations

import json
import sys
import threading
from typing import Any


class ProtocolWriter:
    """Thread-safe NDJSON message writer to stdout. / 线程安全的 NDJSON 消息写入器。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()

    def send(self, message: dict[str, Any]) -> None:
        """
        Serialize and send a protocol message to stdout.
        序列化并发送协议消息到 stdout。

        Worker stdout is an NDJSON transport, not an artifact file. Escaping
        non-ASCII characters keeps the protocol safe even if a packaged
        Windows runtime starts with a legacy console code page.
        Worker stdout 是 NDJSON 传输通道，非 ASCII 字符转义确保
        即使在 Windows 旧版控制台代码页下也能安全传输。
        """
        line = json.dumps(message, ensure_ascii=True, separators=(',', ':'))
        with self._lock:
            sys.stdout.write(line + '\n')
            sys.stdout.flush()


def read_requests():
    """
    Generator that reads NDJSON requests from stdin line by line.
    从 stdin 逐行读取 NDJSON 请求的生成器。
    """
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            yield value


def configure_stdio_utf8() -> None:
    """
    Configure UTF-8 encoding for all stdio streams.
    Tolerates embedded runtimes that don't support reconfiguration.
    为所有 stdio 流配置 UTF-8 编码。
    兼容不支持重新配置的嵌入式运行时。
    """
    for stream, errors in ((sys.stdin, 'strict'), (sys.stdout, 'strict'), (sys.stderr, 'replace')):
        reconfigure = getattr(stream, 'reconfigure', None)
        if not callable(reconfigure):
            continue
        try:
            reconfigure(encoding='utf-8', errors=errors)
        except (AttributeError, OSError, ValueError):
            # Some test wrappers and frozen runtimes expose non-reconfigurable
            # streams. The protocol's ASCII-safe JSON remains the fallback.
            # 部分测试包装器和冻结运行时的流不支持重新配置，
            # 协议的 ASCII 安全 JSON 作为后备方案。
            continue
