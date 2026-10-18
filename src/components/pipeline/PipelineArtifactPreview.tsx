/**
 * Artifact preview panel for pipeline stage outputs (structured tree, parent/child, text, JSON views).
 * 流水线阶段产物预览面板，支持结构化树形、父子层级、纯文本和 JSON 四种预览模式。
 */
import { t, useI18n } from '../../i18n/index.ts';
import { useId, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Box,
  Button,
  Collapse,
  Group,
  Loader,
  Paper,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { Boxes, Braces, ChevronDown, ChevronRight, FileText, ListTree } from 'lucide-react';
import type { PipelineArtifactPreview } from '../../electron';
import {
  buildArtifactPreviewItems,
  getArtifactPreviewModes,
  type ArtifactPreviewItem,
  type ArtifactPreviewMode,
} from '../../utils/pipeline/pipelineArtifactPreview.ts';

/**
 * Props for the PipelineArtifactPreviewContent component.
 * PipelineArtifactPreviewContent 组件的属性定义。
 */
interface PipelineArtifactPreviewProps {
  /** Artifact preview data from the pipeline / 流水线返回的产物预览数据 */
  preview: PipelineArtifactPreview;
  /** Currently active preview mode / 当前激活的预览模式 */
  mode: ArtifactPreviewMode;
  /** Callback when the user switches preview mode / 用户切换预览模式时的回调 */
  onModeChange: (mode: ArtifactPreviewMode) => void;
  /** Async loader for child chunks of a parent, used in structured mode / 异步加载父块子块的回调，用于结构化模式 */
  onLoadChildren?: (parentChunkId: string, offset?: number) => Promise<PipelineArtifactPreview>;
}

const MODE_LABELS: Record<ArtifactPreviewMode, string> = {
  structured: '结构化',
  text: '纯文本',
  json: 'JSON',
};

const MODE_DESCRIPTIONS: Record<ArtifactPreviewMode, string> = {
  structured: '按节点层级或 Parent / Child 关系组织当前页，便于检查结构。',
  text: '只显示每条记录的正文，不展示 JSON 字段。',
  json: '格式化显示当前页的完整字段，便于核对原始产物。',
};

const TREE_TYPE_LABELS: Record<string, string> = {
  DOCUMENT_ROOT: '文档根节点',
  DOCUMENT_TITLE: '文档标题',
  HEADING: '标题',
  HEADING_CANDIDATE: '候选标题',
  BODY: '正文',
  LIST_ITEM: '列表项',
  TABLE_ROW: '表格行',
  QUOTE: '引用',
  STEP_ITEM: '步骤',
  BLANK: '空行',
  NOISE: '噪声',
  SEPARATOR: '分隔符',
};

/**
 * Main artifact preview content with mode switching and scrollable preview area.
 * 产物预览主内容区，包含模式切换和可滚动预览区域。
 *
 * @param props - PipelineArtifactPreviewProps / 组件属性
 */
export function PipelineArtifactPreviewContent({ preview, mode, onModeChange, onLoadChildren }: PipelineArtifactPreviewProps) {
  useI18n();
  const modes = getArtifactPreviewModes(preview.stage, preview.fileName);
  const activeMode = modes.includes(mode) ? mode : modes[0];
  const modeDescription = activeMode === 'structured' && preview.fileName === 'parents.jsonl'
    ? 'Parent 默认收起；点击 Parent 可按需展开或收回其 Child。'
    : MODE_DESCRIPTIONS[activeMode];
  const items = useMemo(
    () => buildArtifactPreviewItems(preview.rows, preview.fileName),
    [preview.fileName, preview.rows],
  );

  return (
    <Stack gap="xs">
      {modes.length > 1 ? (
        <Group justify="space-between" align="center" wrap="wrap" gap="xs">
          <Stack gap={1}>
            <Text size="xs" fw={650}>{t("预览方式")}</Text>
            <Text size="xs" c="dimmed">{modeDescription}</Text>
          </Stack>
          <SegmentedControl
            size="xs"
            value={activeMode}
            onChange={(value) => onModeChange(value as ArtifactPreviewMode)}
            data={modes.map((value) => ({ value, label: t(MODE_LABELS[value]) }))}
            aria-label={t("切换产物预览方式")}
          />
        </Group>
      ) : null}

      <ScrollArea h={440} type="auto" offsetScrollbars>
        {items.length > 0 ? (
          activeMode === 'structured'
            ? <StructuredPreview items={items} onLoadChildren={onLoadChildren} />
            : activeMode === 'text'
              ? <TextPreview items={items} />
              : <JsonPreview items={items} />
        ) : (
          <Text size="xs" c="dimmed" ta="center" py="xl">{t("该产物没有可显示的文本行。")}</Text>
        )}
      </ScrollArea>
    </Stack>
  );
}

/**
 * Render items in structured tree/parent-child mode with indentation.
 * 以结构化树形/父子层级模式渲染条目，支持缩进展示。
 */
function StructuredPreview({
  items,
  onLoadChildren,
}: {
  items: ArtifactPreviewItem[];
  onLoadChildren?: (parentChunkId: string, offset?: number) => Promise<PipelineArtifactPreview>;
}) {
  useI18n();
  return (
    <Stack gap="xs" pr="xs">
      {items.map((item) => item.kind === 'parent' && item.id && onLoadChildren
        ? <ParentPreviewGroup key={item.lineNumber} item={item} onLoadChildren={onLoadChildren} />
        : <StructuredPreviewItem key={item.lineNumber} item={item} />)}
    </Stack>
  );
}

/**
 * Collapsible parent chunk group that lazy-loads its child chunks on expand.
 * 可折叠的父块分组，展开时按需懒加载子块数据。
 */
function ParentPreviewGroup({
  item,
  onLoadChildren,
}: {
  item: ArtifactPreviewItem;
  onLoadChildren: (parentChunkId: string, offset?: number) => Promise<PipelineArtifactPreview>;
}) {
  useI18n();
  const regionId = useId();
  const [expanded, setExpanded] = useState(false);
  const [focused, setFocused] = useState(false);
  const [childrenPreview, setChildrenPreview] = useState<PipelineArtifactPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const childItems = useMemo(
    () => childrenPreview ? buildArtifactPreviewItems(childrenPreview.rows, childrenPreview.fileName) : [],
    [childrenPreview],
  );

  const loadPage = async (offset = 0) => {
    if (!item.id) return;
    setLoading(true);
    setError(null);
    try {
      setChildrenPreview(await onLoadChildren(item.id, offset));
    } catch (loadError) {
      setChildrenPreview(null);
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  };

  const toggleExpanded = () => {
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    if (nextExpanded && !childrenPreview && !loading) void loadPage(0);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggleExpanded();
  };

  return (
    <Stack gap={0}>
      <Box
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-controls={regionId}
        aria-label={t("{0} {1} 的子块", { '0': expanded ? t("收起") : t("展开"), '1': item.id })}
        onClick={toggleExpanded}
        onKeyDown={handleKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          cursor: 'pointer',
          borderRadius: 'var(--mantine-radius-md)',
          outline: focused ? '2px solid var(--mantine-color-blue-5)' : 'none',
          outlineOffset: 2,
        }}
      >
        <StructuredPreviewItem
          item={item}
          toggle={{ expanded, loading, childCount: childrenPreview?.lineCount }}
        />
      </Box>

      <Collapse in={expanded}>
        <Box
          id={regionId}
          ml="lg"
          mt={6}
          pl="md"
          style={{ borderInlineStart: '2px solid var(--mantine-color-grape-6)' }}
        >
          {loading ? (
            <Group gap="xs" py="md" justify="center">
              <Loader size={16} />
              <Text size="xs" c="dimmed">{t("正在读取该 Parent 的 Child…")}</Text>
            </Group>
          ) : error ? (
            <Alert color="red" variant="light" title={t("子块读取失败")}>
              <Stack gap="xs">
                <Text size="xs">{error}</Text>
                <Button size="compact-xs" variant="light" color="red" onClick={() => void loadPage(0)}>{t("重新读取")}</Button>
              </Stack>
            </Alert>
          ) : childrenPreview && childItems.length > 0 ? (
            <Stack gap="xs">
              {childItems.map((child) => <StructuredPreviewItem key={child.lineNumber} item={child} />)}
              <Group justify="space-between" gap="xs" wrap="wrap">
                <Text size="xs" c="dimmed">
                  Child {childrenPreview.offset + 1}–{childrenPreview.offset + childItems.length} / {childrenPreview.lineCount}
                </Text>
                <Group gap="xs">
                  <Button
                    size="compact-xs"
                    variant="default"
                    disabled={childrenPreview.offset <= 0 || loading}
                    onClick={() => void loadPage(Math.max(0, childrenPreview.offset - childrenPreview.limit))}
                  >
                    {t("上一页")}
                  </Button>
                  <Button
                    size="compact-xs"
                    variant="default"
                    disabled={!childrenPreview.hasMore || loading}
                    onClick={() => void loadPage(childrenPreview.offset + childrenPreview.limit)}
                  >
                    {t("下一页")}
                  </Button>
                </Group>
              </Group>
            </Stack>
          ) : childrenPreview ? (
            <Alert color="yellow" variant="light">{t("该 Parent 没有匹配的 Child，请重新运行父子切块阶段。")}</Alert>
          ) : null}
        </Box>
      </Collapse>
    </Stack>
  );
}

/**
 * Render a single structured preview item (tree node, parent, child, or plain record).
 * 渲染单个结构化预览条目（树节点、父块、子块或普通记录）。
 */
function StructuredPreviewItem({
  item,
  toggle,
}: {
  item: ArtifactPreviewItem;
  toggle?: { expanded: boolean; loading: boolean; childCount?: number };
}) {
  useI18n();
  const treeDepth = item.kind === 'tree' ? Math.min(Math.max(item.depth ?? 0, 0), 6) : 0;
  const color = item.kind === 'tree' ? 'teal' : item.kind === 'parent' ? 'blue' : item.kind === 'child' ? 'grape' : 'gray';
  const Icon = item.kind === 'tree' ? ListTree : item.kind === 'parent' || item.kind === 'child' ? Boxes : FileText;
  const title = item.kind === 'tree'
    ? TREE_TYPE_LABELS[item.type ?? ''] ?? item.type ?? '结构节点'
    : item.kind === 'parent'
      ? `Parent${item.ordinal !== null ? ` ${item.ordinal}` : ''}`
      : item.kind === 'child'
        ? `Child${item.ordinal !== null ? ` ${item.ordinal}` : ''}`
        : '未识别记录';
  const lineRange = formatSourceLineRange(item);

  return (
    <Box
      ml={treeDepth * 14}
      pl={treeDepth > 0 ? 'sm' : 0}
      style={treeDepth > 0 ? { borderInlineStart: `2px solid var(--mantine-color-${color}-6)` } : undefined}
    >
      <Paper withBorder radius="md" p="sm">
        <Stack gap="xs">
          <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs">
            <Group gap="xs" align="flex-start">
              <ThemeIcon size={28} radius="md" color={color} variant="light">
                <Icon size={15} />
              </ThemeIcon>
              <Stack gap={1}>
                <Group gap={6} wrap="wrap">
                  <Text size="sm" fw={700}>{title}</Text>
                  {item.id ? <Badge size="xs" variant="outline" color={color} ff="monospace">{item.id}</Badge> : null}
                </Group>
                <Text size="xs" c="dimmed">
                  {t("产物第")} {item.lineNumber} {t("行")}{lineRange ? t(" · 原文{0}", { '0': lineRange }) : ''}
                </Text>
              </Stack>
            </Group>
            <Group gap={5} wrap="wrap">
              {toggle ? (
                <Badge
                  size="sm"
                  color="blue"
                  variant="light"
                  leftSection={toggle.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                >
                  {toggle.loading ? t("读取中") : toggle.expanded ? t("收起{0}", { '0': toggle.childCount === undefined ? '' : t(" · {0} 个 Child", { '0': toggle.childCount }) }) : t("展开 Child")}
                </Badge>
              ) : null}
              {item.parentId ? <Badge size="xs" color="gray" variant="light">{t("父级")} {item.parentId}</Badge> : null}
              {item.depth !== null ? <Badge size="xs" color="gray" variant="light">{t("深度")} {item.depth}</Badge> : null}
              {item.childCount !== null ? <Badge size="xs" color="gray" variant="light">{t("子节点")} {item.childCount}</Badge> : null}
              {item.charCount !== null ? <Badge size="xs" color="gray" variant="light">{item.charCount} {t("字符")}</Badge> : null}
            </Group>
          </Group>

          {item.sectionPath.length > 0 ? (
            <Group gap={6} align="flex-start" wrap="nowrap">
              <Text size="xs" c="dimmed" style={{ flex: '0 0 auto' }}>{t("章节路径")}</Text>
              <Text size="xs" c={color} fw={600} style={{ overflowWrap: 'anywhere' }}>
                {item.sectionPath.join(' / ')}
              </Text>
            </Group>
          ) : item.sectionContext ? (
            <Text size="xs" c={color} fw={600} style={{ whiteSpace: 'pre-wrap' }}>{item.sectionContext}</Text>
          ) : null}

          <Text
            size="sm"
            fw={item.kind === 'tree' && (item.type === 'HEADING' || item.type === 'DOCUMENT_TITLE') ? 650 : 400}
            style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.65 }}
          >
            {item.text || t("（空内容）")}
          </Text>

          {item.boundaryReason || item.overlapChars || item.confidence !== null ? (
            <Group gap={5} wrap="wrap">
              {item.boundaryReason ? <Badge size="xs" variant="dot" color={color}>{item.boundaryReason}</Badge> : null}
              {item.overlapChars ? <Badge size="xs" variant="light" color="orange">{t("重叠")} {item.overlapChars} {t("字符")}</Badge> : null}
              {item.confidence !== null ? <Badge size="xs" variant="light" color="gray">{t("置信度")} {formatConfidence(item.confidence)}</Badge> : null}
            </Group>
          ) : null}
        </Stack>
      </Paper>
    </Box>
  );
}

/**
 * Render items in plain text mode showing only the text body per record.
 * 以纯文本模式渲染条目，仅展示每条记录的正文内容。
 */
function TextPreview({ items }: { items: ArtifactPreviewItem[] }) {
  useI18n();
  return (
    <Stack gap="xs" pr="xs">
      {items.map((item) => (
        <Paper key={item.lineNumber} withBorder radius="md" p="sm">
          <Group align="flex-start" gap="sm" wrap="nowrap">
            <Text size="xs" c="dimmed" ff="monospace" w={44} ta="right" style={{ flex: '0 0 auto' }}>{item.lineNumber}</Text>
            <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.7 }}>
              {item.text || ' '}
            </Text>
          </Group>
        </Paper>
      ))}
    </Stack>
  );
}

/**
 * Render items in JSON mode showing formatted full record fields.
 * 以 JSON 模式渲染条目，展示格式化的完整字段数据。
 */
function JsonPreview({ items }: { items: ArtifactPreviewItem[] }) {
  useI18n();
  return (
    <Stack gap="xs" pr="xs">
      {items.map((item) => (
        <Paper key={item.lineNumber} withBorder radius="md" p="sm">
          <Group align="flex-start" gap="sm" wrap="nowrap">
            <Text size="xs" c="dimmed" ff="monospace" w={44} ta="right" style={{ flex: '0 0 auto' }}>{item.lineNumber}</Text>
            <Box style={{ minWidth: 0, flex: 1 }}>
              <Group gap={5} mb={6}>
                <Braces size={13} />
                <Text size="xs" c="dimmed">{t("完整记录")}</Text>
              </Group>
              <Text
                component="pre"
                size="xs"
                ff="monospace"
                m={0}
                style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.55 }}
              >
                {item.prettyJson || ' '}
              </Text>
            </Box>
          </Group>
        </Paper>
      ))}
    </Stack>
  );
}

/**
 * Format source line range for display (e.g. "第 3–7 行"), or null if unavailable.
 * 格式化原始行号范围用于显示（如"第 3–7 行"），不可用时返回 null。
 */
function formatSourceLineRange(item: ArtifactPreviewItem): string | null {
  if (item.firstLineNo === null && item.lastLineNo === null) return null;
  const start = item.firstLineNo ?? item.lastLineNo;
  const end = item.lastLineNo ?? item.firstLineNo;
  return start === end ? `第 ${start} 行` : `第 ${start}–${end} 行`;
}

/**
 * Format a confidence value (0–1 or 0–100) as a percentage string.
 * 将置信度值（0–1 或 0–100）格式化为百分比字符串。
 */
function formatConfidence(value: number): string {
  const percentage = value <= 1 ? value * 100 : value;
  return `${Math.round(percentage)}%`;
}

/** Re-export ArtifactPreviewMode type for consumers / 为外部消费者重导出 ArtifactPreviewMode 类型 */
export type { ArtifactPreviewMode } from '../../utils/pipeline/pipelineArtifactPreview.ts';
