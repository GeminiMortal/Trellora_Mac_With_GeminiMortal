"""
Module: lines_stage
Logical line extraction stage. Converts normalized Markdown into a bounded,
source-aware line stream with metadata for downstream processing.
模块：lines_stage
逻辑行提取阶段。将标准化 Markdown 转换为有界的、带来源感知的行流，
并附带下游处理所需的元数据。
"""

from __future__ import annotations

import json
import os
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from threading import Event
from typing import Any, Callable, Iterator

from .stage_errors import StageCancelled, StageError


# Schema version for lines output format / 行输出格式的 schema 版本
LINES_SCHEMA_VERSION = 2
# Interval for writing checkpoints during processing / 处理过程中写入检查点的间隔
CHECKPOINT_INTERVAL = 200


def run_lines_stage(
    input_path: str,
    output_dir: str,
    cancel_event: Event,
    progress: Callable[[int, int | None, str, str], None],
    stage_key: str = '',
) -> dict[str, Any]:
    """
    Expand the normalized Markdown into a bounded, source-aware line stream.
    将标准化 Markdown 展开为有界的、带来源感知的行流。
    """
    parse_dir = Path(input_path)
    output = Path(output_dir)
    markdown_path = parse_dir / 'document.md'
    blocks_path = parse_dir / 'blocks.jsonl'
    line_layout_path = parse_dir / 'line-layout.jsonl'
    if not markdown_path.is_file():
        raise StageError('LINES_INPUT_NOT_FOUND', '解析阶段缺少 document.md，无法生成逻辑行。', False)
    if not blocks_path.is_file():
        raise StageError('LINES_INPUT_NOT_FOUND', '解析阶段缺少 blocks.jsonl，无法建立来源映射。', False)

    output.mkdir(parents=True, exist_ok=True)
    lines_path = output / 'lines.jsonl'
    checkpoint_path = output / 'checkpoint.json'
    checkpoint = _read_checkpoint(checkpoint_path, stage_key)
    resume_line = int(checkpoint.get('lastLineNo', 0)) if checkpoint else 0
    written_lines = int(checkpoint.get('records', 0)) if checkpoint else 0
    if resume_line > 0 and not lines_path.is_file():
        resume_line = 0
        written_lines = 0
    mode = 'a' if resume_line > 0 else 'w'
    total_lines = _count_lines(markdown_path)
    block_cursor = BlockCursor(blocks_path)
    line_layout_cursor = LineLayoutCursor(line_layout_path)
    current_line = 0
    max_chars = 0
    active_fence: str | None = None
    code_lines = 0
    fence_lines = 0

    try:
        with markdown_path.open('r', encoding='utf-8', errors='replace', newline='') as source, lines_path.open(mode, encoding='utf-8', newline='\n') as destination:
            for value in source:
                _raise_if_cancelled(cancel_event)
                current_line += 1
                raw_text = value.rstrip('\r\n')
                normalized_text = normalize_text(raw_text)
                is_code_fence, in_code_fence, active_fence = track_markdown_fence(raw_text, active_fence)
                if is_code_fence:
                    fence_lines += 1
                elif in_code_fence:
                    code_lines += 1
                max_chars = max(max_chars, len(raw_text))
                source_ref = block_cursor.resolve(normalized_text)
                layout = line_layout_cursor.resolve(current_line)
                if current_line <= resume_line:
                    continue
                record = {
                    'schemaVersion': LINES_SCHEMA_VERSION,
                    'lineNo': current_line,
                    'blockId': source_ref.get('blockId') if source_ref else None,
                    'rawText': raw_text,
                    'normalizedText': normalized_text,
                    'page': source_ref.get('page') if source_ref else None,
                    'sourceRef': source_ref.get('sourceRef') if source_ref else None,
                    'source': source_ref.get('source') if source_ref else None,
                    'isSynthetic': False,
                    'isCodeFence': is_code_fence,
                    'inCodeFence': in_code_fence,
                    'blankBefore': layout['blankBefore'],
                }
                destination.write(json.dumps(record, ensure_ascii=False, separators=(',', ':')) + '\n')
                written_lines += 1
                if written_lines % CHECKPOINT_INTERVAL == 0:
                    destination.flush()
                    _write_checkpoint(checkpoint_path, stage_key, current_line, written_lines, False)
                if current_line == 1 or current_line % 100 == 0:
                    progress(current_line, total_lines, 'line', f'正在生成第 {current_line} 行逻辑行。')
            destination.flush()
            os.fsync(destination.fileno())
        _raise_if_cancelled(cancel_event)
        counts = {
            'lines': written_lines,
            'blankLines': _count_blank_lines(lines_path),
            'maxLineChars': max_chars,
            'sourceLines': total_lines,
            'codeLines': code_lines,
            'codeFenceLines': fence_lines,
        }
        report = {
            'schemaVersion': LINES_SCHEMA_VERSION,
            'stage': 'lines',
            'stageKey': stage_key,
            'counts': counts,
            'checkpoint': {'lastLineNo': current_line, 'records': written_lines, 'complete': True},
            'generatedAt': datetime.now(timezone.utc).isoformat(),
        }
        _write_json(output / 'lines-report.json', report)
        _write_checkpoint(checkpoint_path, stage_key, current_line, written_lines, True)
        progress(current_line, total_lines, 'line', f'逻辑行生成完成，共 {written_lines} 行。')
        return counts
    except StageError:
        raise
    except Exception as exc:
        raise StageError('LINES_WRITE_FAILED', f'逻辑行阶段写入失败：{exc}', True) from exc
    finally:
        block_cursor.close()
        line_layout_cursor.close()


def normalize_text(value: str) -> str:
    """
    Normalize Unicode text by applying NFKC normalization and removing control characters.
    通过应用 NFKC 标准化和移除控制字符来标准化 Unicode 文本。
    """
    value = unicodedata.normalize('NFKC', value)
    value = ''.join(character for character in value if character not in '\x00\x0b\x0c\x85')
    return ' '.join(value.replace('\u200b', '').split())


def track_markdown_fence(value: str, active_fence: str | None) -> tuple[bool, bool, str | None]:
    """
    Track fenced code blocks so later stages do not treat code comments as headings.
    跟踪围栏代码块，以便后续阶段不会将代码注释误认为标题。
    """
    match = re.match(r'^ {0,3}(`{3,}|~{3,})(.*)$', value)
    if match is None:
        return False, active_fence is not None, active_fence

    marker = match.group(1)
    trailing = match.group(2)
    if active_fence is None:
        return True, False, marker
    if marker[0] == active_fence[0] and len(marker) >= len(active_fence) and not trailing.strip():
        return True, False, None
    return False, True, active_fence


class BlockCursor:
    """
    Cursor for matching logical lines to their source blocks.
    用于将逻辑行匹配到其源块的游标。
    """

    def __init__(self, path: Path) -> None:
        self.stream = path.open('r', encoding='utf-8', errors='replace')
        self.block: dict[str, Any] | None = None
        self.parts: list[str] = []
        self.part_index = 0

    def resolve(self, normalized_line: str) -> dict[str, Any] | None:
        """
        Resolve source block reference for a normalized line.
        解析标准化行的源块引用。
        """
        if not normalized_line:
            return None
        for _ in range(32):
            if not self.parts or self.part_index >= len(self.parts):
                if not self._advance():
                    return self.block
            expected = normalize_text(self.parts[self.part_index])
            if expected == normalized_line:
                result = self._source_ref(self.block)
                self.part_index += 1
                return result
            if expected and normalized_line and (expected in normalized_line or normalized_line in expected):
                result = self._source_ref(self.block)
                self.part_index += 1
                return result
            if self.part_index > 0:
                self._advance()
                continue
            if not self._advance():
                return self.block
        return self._source_ref(self.block)

    def _advance(self) -> bool:
        """
        Read next block from the blocks JSONL file.
        从 blocks JSONL 文件读取下一个块。
        """
        line = self.stream.readline()
        if not line:
            self.block = None
            self.parts = []
            self.part_index = 0
            return False
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            return self._advance()
        if not isinstance(value, dict):
            return self._advance()
        self.block = value
        text = str(value.get('text') or value.get('rawText') or '')
        self.parts = text.splitlines() or [text]
        self.part_index = 0
        return True

    @staticmethod
    def _source_ref(block: dict[str, Any] | None) -> dict[str, Any] | None:
        """
        Extract source reference metadata from a block.
        从块中提取源引用元数据。
        """
        if not block:
            return None
        source = block.get('source') if isinstance(block.get('source'), dict) else {}
        return {
            'blockId': block.get('blockId'),
            'page': source.get('page'),
            'sourceRef': source.get('sourceRef') or source.get('line'),
            'source': source,
        }

    def close(self) -> None:
        """Close the underlying stream. / 关闭底层流。"""
        self.stream.close()


class LineLayoutCursor:
    """
    Optional parser metadata for blank lines removed from the preview artifact.
    用于预览工件中移除的空行的可选解析器元数据。
    """

    def __init__(self, path: Path) -> None:
        self.stream = path.open('r', encoding='utf-8', errors='replace') if path.is_file() else None

    def resolve(self, line_no: int) -> dict[str, bool]:
        """
        Resolve blank-before metadata for a given line number.
        解析给定行号的 blank-before 元数据。
        """
        if self.stream is None:
            return {'blankBefore': False}
        for raw_line in self.stream:
            try:
                value = json.loads(raw_line)
            except json.JSONDecodeError:
                continue
            if not isinstance(value, dict):
                continue
            if int(value.get('lineNo', -1)) != line_no:
                continue
            return {'blankBefore': value.get('blankBefore') is True}
        return {'blankBefore': False}

    def close(self) -> None:
        """Close the underlying stream. / 关闭底层流。"""
        if self.stream is not None:
            self.stream.close()


def _count_lines(path: Path) -> int:
    """Count total lines in a file. / 统计文件总行数。"""
    with path.open('r', encoding='utf-8', errors='replace') as stream:
        return sum(1 for _ in stream)


def _count_blank_lines(path: Path) -> int:
    """Count blank lines in a JSONL file. / 统计 JSONL 文件中的空行数。"""
    with path.open('r', encoding='utf-8', errors='replace') as stream:
        return sum(1 for value in stream if not json.loads(value).get('normalizedText'))


def _read_checkpoint(path: Path, stage_key: str) -> dict[str, Any] | None:
    """
    Read checkpoint state for resumable processing.
    读取检查点状态以支持可恢复处理。
    """
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(value, dict) or value.get('stageKey') != stage_key or value.get('complete'):
            return None
        return value
    except (OSError, json.JSONDecodeError):
        return None


def _write_checkpoint(path: Path, stage_key: str, last_line_no: int, records: int, complete: bool) -> None:
    """
    Write checkpoint state for resumable processing.
    写入检查点状态以支持可恢复处理。
    """
    _write_json(path, {
        'schemaVersion': LINES_SCHEMA_VERSION,
        'stage': 'lines',
        'stageKey': stage_key,
        'lastLineNo': last_line_no,
        'records': records,
        'complete': complete,
        'updatedAt': datetime.now(timezone.utc).isoformat(),
    })


def _write_json(path: Path, value: dict[str, Any]) -> None:
    """
    Atomic JSON file write using temporary file + rename.
    使用临时文件 + 重命名的原子 JSON 文件写入。
    """
    temporary = path.with_name(f'.{path.name}.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def _raise_if_cancelled(cancel_event: Event) -> None:
    """Raise StageCancelled if cancel event is set. / 如果取消事件已设置则抛出 StageCancelled。"""
    if cancel_event.is_set():
        raise StageCancelled()
