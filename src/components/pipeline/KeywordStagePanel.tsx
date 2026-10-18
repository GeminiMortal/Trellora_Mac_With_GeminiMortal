/**
 * Keyword extraction configuration panel and preview modal for the pipeline.
 * 流水线关键词提取配置面板与关键词预览弹窗，支持词典管理、参数调节和原文证据高亮。
 */
import { t, useI18n } from '../../i18n/index.ts';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  NumberInput,
  Paper,
  ScrollArea,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Textarea,
} from '@mantine/core';
import { AlertCircle, BookOpen, Highlighter, Save } from 'lucide-react';
import type {
  KeywordExtractionConfig,
  PipelineKeywordPreview,
  PipelineKeywordPreviewItem,
  PipelineKeywordPreviewRow,
  PipelineKeywordResources,
} from '../../electron';

const FEATURE_LABELS: Record<string, string> = {
  tfidf: '词频-逆文档频率',
  textRank: 'TextRank',
  position: '位置权重',
  sentenceSpread: '句子分布',
  sectionMatch: '章节匹配',
  termQuality: '术语质量',
  domainBoost: '业务词典命中',
  overlapOnly: '仅重叠区域',
  overlapPenalty: '重叠惩罚',
  boilerplatePenalty: '套话惩罚',
  noisePenalty: '噪声惩罚',
};

/**
 * Props for the KeywordStageConfig component.
 * KeywordStageConfig 组件的属性定义。
 */
interface KeywordStageConfigProps {
  /** Keyword resources loaded from the pipeline, or null while loading / 从流水线加载的关键词资源，加载中为 null */
  resources: PipelineKeywordResources | null;
  /** Whether a save operation is in progress / 是否正在保存中 */
  saving: boolean;
  /** Error message to display, or null / 需要显示的错误消息，无错误时为 null */
  error: string | null;
  /** Callback to save keyword extraction config changes / 保存关键词提取配置变更的回调 */
  onSaveConfig: (patch: Partial<KeywordExtractionConfig>) => Promise<void>;
  /** Callback to save the business dictionary content / 保存业务词典内容的回调 */
  onSaveDictionary: (content: string) => Promise<void>;
}

/**
 * Configuration panel for keyword extraction: enable/disable, top-K, and business dictionary.
 * 关键词提取配置面板：启用/禁用开关、Top-K 参数和业务词典管理。
 *
 * @param props - KeywordStageConfigProps / 组件属性
 */
export function KeywordStageConfig({ resources, saving, error, onSaveConfig, onSaveDictionary }: KeywordStageConfigProps) {
  useI18n();
  const [enabled, setEnabled] = useState(true);
  const [maxKeywords, setMaxKeywords] = useState(10);
  const [dictionaryText, setDictionaryText] = useState('');

  useEffect(() => {
    if (!resources) return;
    setEnabled(resources.config.enabled);
    setMaxKeywords(resources.config.maxKeywords);
    setDictionaryText(resources.dictionaryTerms.join('\n'));
  }, [resources]);

  const dictionaryCount = useMemo(
    () => dictionaryText.split(/\r?\n/u).map((term) => term.trim()).filter(Boolean).length,
    [dictionaryText],
  );

  if (!resources) {
    return <Alert icon={<AlertCircle size={14} />} color="gray" variant="light">{t("正在读取关键词设置。")}</Alert>;
  }

  return (
    <Stack gap="sm">
      <Alert icon={<BookOpen size={14} />} color="blue" variant="light" py={7}>
        {t("关键词只从当前子块原文中提取。修改设置后只会重新处理关键词及其下游阶段，不会重做解析和切块。")}
      </Alert>
      {resources.validationError ? (
        <Alert icon={<AlertCircle size={14} />} color="orange" variant="light" py={7}>
          {resources.validationError.message}
        </Alert>
      ) : null}
      {error ? (
        <Alert icon={<AlertCircle size={14} />} color="red" variant="light" py={7}>
          {error}
        </Alert>
      ) : null}

      <Group align="flex-end" wrap="wrap">
        <Switch
          label={t("启用关键词提取")}
          description={t("关闭时保留空结果，方便安全回滚")}
          checked={enabled}
          onChange={(event) => setEnabled(event.currentTarget.checked)}
          disabled={saving}
        />
        <NumberInput
          label={t("每个子块 Top-K")}
          description={t("最多保留的关键词数量")}
          min={1}
          max={20}
          step={1}
          w={150}
          value={maxKeywords}
          onChange={(value) => setMaxKeywords(typeof value === 'number' ? value : 10)}
          disabled={saving}
        />
        <Button
          size="xs"
          leftSection={<Save size={13} />}
          loading={saving}
          onClick={() => void onSaveConfig({ enabled, maxKeywords })}
        >
          {t("保存关键词设置")}
        </Button>
      </Group>

      <Paper withBorder radius="sm" p="sm">
        <Stack gap="xs">
          <Group justify="space-between" align="flex-end">
            <div>
              <Text size="xs" fw={650}>{t("业务词典")}</Text>
              <Text size="xs" c="dimmed">{t("每行一个术语；用于候选加权，不会凭空注入原文。")}</Text>
            </div>
            <Badge size="xs" variant="light" color={dictionaryCount > 5000 ? 'red' : 'gray'}>
              {dictionaryCount} / 5000
            </Badge>
          </Group>
          <Textarea
            size="xs"
            minRows={4}
            maxRows={10}
            autosize
            value={dictionaryText}
            onChange={(event) => setDictionaryText(event.currentTarget.value)}
            placeholder={t("例如：访问控制\n最小权限\nsqlite-vec")}
            disabled={saving}
          />
          <Group justify="flex-end">
            <Button
              size="xs"
              variant="light"
              leftSection={<Save size={13} />}
              loading={saving}
              onClick={() => void onSaveDictionary(dictionaryText)}
            >
              {t("保存业务词典")}
            </Button>
          </Group>
        </Stack>
      </Paper>
    </Stack>
  );
}

/**
 * Props for the KeywordPreviewModal component.
 * KeywordPreviewModal 组件的属性定义。
 */
interface KeywordPreviewModalProps {
  /** Whether the modal is currently visible / 弹窗是否可见 */
  opened: boolean;
  /** Paginated keyword preview data, or null if no document selected / 分页关键词预览数据，未选中文档时为 null */
  preview: PipelineKeywordPreview | null;
  /** Whether preview data is currently loading / 预览数据是否正在加载 */
  loading: boolean;
  /** Error message to display, or null / 需要显示的错误消息，无错误时为 null */
  error: string | null;
  /** Callback when the modal is closed / 弹窗关闭时触发的回调 */
  onClose: () => void;
  /** Callback to load a specific page of preview results / 加载指定页预览结果的回调 */
  onLoadPage: (offset: number) => void;
}

/**
 * Modal for previewing extracted keywords with paginated chunk views and evidence highlighting.
 * 关键词预览弹窗，支持分页查看子块关键词、点击关键词高亮原文证据。
 *
 * @param props - KeywordPreviewModalProps / 组件属性
 */
export function KeywordPreviewModal({ opened, preview, loading, error, onClose, onLoadPage }: KeywordPreviewModalProps) {
  useI18n();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    const firstRow = preview?.rows.find((row) => row.keywords.length > 0);
    const firstKeyword = firstRow?.keywords[0];
    setSelectedKey(firstRow && firstKeyword ? keywordKey(firstRow, firstKeyword) : null);
  }, [preview?.offset, preview?.rows]);

  return (
    <Modal opened={opened} onClose={onClose} title={t("关键词预览 · 点击关键词查看原文证据")} centered size="xl">
      <Stack gap="sm">
        {loading ? (
          <Text size="xs" c="dimmed" ta="center" py="xl">{t("正在读取关键词和对应子块原文。")}</Text>
        ) : error ? (
          <Alert icon={<AlertCircle size={14} />} color="red" variant="light">{error}</Alert>
        ) : preview ? (
          <>
            <Group justify="space-between" wrap="wrap">
              <Text size="xs" c="dimmed">
                {preview.rowCount > 0 ? t("显示第 {0}–{1} 个子块，共 {2} 个", { '0': preview.offset + 1, '1': preview.offset + preview.rows.length, '2': preview.rowCount }) : t("没有可展示的子块")}
              </Text>
              <Badge size="xs" variant="light" color="blue">{t("关键词证据来自当前子块原文")}</Badge>
            </Group>
            <ScrollArea h={500} type="auto" offsetScrollbars>
              <Stack gap="sm" pr="xs">
                {preview.rows.map((row) => (
                  <KeywordPreviewRowView key={row.chunkId} row={row} selectedKey={selectedKey} onSelect={setSelectedKey} />
                ))}
                {preview.rows.length === 0 ? <Text size="xs" c="dimmed" ta="center" py="xl">{t("当前没有关键词结果。")}</Text> : null}
              </Stack>
            </ScrollArea>
            <Group justify="space-between">
              <Button
                size="xs"
                variant="default"
                disabled={preview.offset <= 0 || loading}
                onClick={() => onLoadPage(Math.max(0, preview.offset - preview.limit))}
              >
                {t("上一页")}
              </Button>
              <Button
                size="xs"
                variant="default"
                disabled={!preview.hasMore || loading}
                onClick={() => onLoadPage(preview.offset + preview.limit)}
              >
                {t("下一页")}
              </Button>
            </Group>
          </>
        ) : (
          <Text size="xs" c="dimmed" ta="center" py="xl">{t("请选择一个已完成关键词阶段的文档。")}</Text>
        )}
      </Stack>
    </Modal>
  );
}

/**
 * Render a single chunk row with its keywords and highlight-selected evidence.
 * 渲染单个子块行，展示关键词列表并高亮选中的关键词原文证据。
 */
function KeywordPreviewRowView({ row, selectedKey, onSelect }: { row: PipelineKeywordPreviewRow; selectedKey: string | null; onSelect: (key: string) => void }) {
  useI18n();
  const selectedKeyword = row.keywords.find((keyword) => keywordKey(row, keyword) === selectedKey) ?? null;
  return (
    <Paper withBorder radius="sm" p="sm">
      <Stack gap="xs">
        <Group justify="space-between" wrap="wrap">
          <Group gap="xs">
            <Badge size="xs" variant="light" color="violet">{t("子块")} {row.ordinal}</Badge>
            {row.sourceLocations.map((location) => <Badge key={location} size="xs" variant="outline" color="gray">{location}</Badge>)}
          </Group>
          <Text size="xs" c="dimmed">{row.keywords.length ? t("{0} 个关键词", { '0': row.keywords.length }) : t("无关键词")}</Text>
        </Group>

        <Paper withBorder radius="sm" p="xs" bg="gray.0">
          <Text size="xs" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {selectedKeyword ? highlightChunkText(row.text, selectedKeyword.occurrences) : row.text}
          </Text>
        </Paper>

        {row.keywords.length > 0 ? (
          <Group gap={6} wrap="wrap">
            {row.keywords.map((keyword) => {
              const key = keywordKey(row, keyword);
              return (
                <Button
                  key={key}
                  size="compact-xs"
                  variant={key === selectedKey ? 'filled' : 'light'}
                  color={key === selectedKey ? 'yellow' : 'blue'}
                  leftSection={<Highlighter size={12} />}
                  onClick={() => onSelect(key)}
                >
                  {keyword.term} · {keyword.score.toFixed(2)}
                </Button>
              );
            })}
          </Group>
        ) : (
          <Text size="xs" c="dimmed">{emptyReasonLabel(row.emptyReason)}</Text>
        )}

        {selectedKeyword ? <KeywordEvidenceDetail keyword={selectedKeyword} /> : null}
      </Stack>
    </Paper>
  );
}

/**
 * Display detailed scoring features and occurrence offsets for a selected keyword.
 * 展示选中关键词的详细评分特征和原文出现偏移量。
 */
function KeywordEvidenceDetail({ keyword }: { keyword: PipelineKeywordPreviewItem }) {
  useI18n();
  const featureEntries = Object.entries(keyword.features).filter(([key]) => FEATURE_LABELS[key]);
  return (
    <Paper withBorder radius="sm" p="xs" bg="yellow.0">
      <Stack gap={5}>
        <Group gap="xs" wrap="wrap">
          <Badge size="xs" color="yellow" variant="filled">{t("第")} {keyword.rank} {t("位")}</Badge>
          <Badge size="xs" variant="light" color="blue">{t("得分")} {keyword.score.toFixed(4)}</Badge>
          <Badge size="xs" variant="light" color="gray">{keyword.kind}</Badge>
          {keyword.forcedTop1 ? <Badge size="xs" variant="light" color="orange">{t("最低关键词兜底")}</Badge> : null}
        </Group>
        <Text size="xs" c="dimmed">
          {t("原文偏移（0 起）：")}{keyword.occurrences.length > 0 ? keyword.occurrences.map((occurrence) => `${occurrence.start}–${occurrence.end}`).join('、') : t("无")}
        </Text>
        <SimpleGrid cols={{ base: 2, sm: 4 }} spacing={4}>
          {featureEntries.map(([key, value]) => (
            <Badge key={key} size="xs" variant="outline" color="gray">
              {FEATURE_LABELS[key]}：{formatFeatureValue(value)}
            </Badge>
          ))}
        </SimpleGrid>
      </Stack>
    </Paper>
  );
}

/**
 * Highlight keyword occurrences within chunk text by wrapping matched ranges in <mark> elements.
 * 通过将匹配范围包裹在 <mark> 元素中，高亮显示子块文本中的关键词出现位置。
 *
 * @param text - The full chunk text / 子块完整文本
 * @param occurrences - Array of start/end offset pairs / 起止偏移量数组
 * @returns ReactNode with highlighted segments / 包含高亮片段的 ReactNode
 */
function highlightChunkText(text: string, occurrences: PipelineKeywordPreviewItem['occurrences']): ReactNode {
  const characters = Array.from(text);
  const ranges = occurrences
    .map((occurrence) => ({ start: Math.max(0, occurrence.start), end: Math.min(characters.length, occurrence.end) }))
    .filter((occurrence) => occurrence.end > occurrence.start)
    .sort((left, right) => left.start - right.start);
  if (ranges.length === 0) return text;

  const output: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start < cursor) return;
    if (range.start > cursor) output.push(<span key={`text-${index}`}>{characters.slice(cursor, range.start).join('')}</span>);
    output.push(<mark key={`mark-${index}`} style={{ background: '#ffe066', padding: '0 2px', borderRadius: 3 }}>{characters.slice(range.start, range.end).join('')}</mark>);
    cursor = range.end;
  });
  if (cursor < characters.length) output.push(<span key="text-tail">{characters.slice(cursor).join('')}</span>);
  return output;
}

/**
 * Build a stable unique key for a keyword within a chunk row.
 * 为子块行内的关键词构建稳定的唯一键。
 */
function keywordKey(row: PipelineKeywordPreviewRow, keyword: PipelineKeywordPreviewItem): string {
  return `${row.chunkId}:${keyword.rank}`;
}

/**
 * Format a keyword feature value for display (boolean as 是/否, number to 2 decimals).
 * 格式化关键词特征值用于显示（布尔值显示为是/否，数值保留两位小数）。
 */
function formatFeatureValue(value: number | boolean): string {
  if (typeof value === 'boolean') return value ? '是' : t("否");
  return value.toFixed(2);
}

/**
 * Map an empty-reason code to a user-facing explanation string.
 * 将空关键词原因代码映射为面向用户的说明文字。
 */
function emptyReasonLabel(reason: string | null): string {
  if (reason === 'EMPTY_TEXT') return '该子块没有可分析的正文。';
  if (reason === 'NO_VALID_CANDIDATE') return '该子块没有通过证据校验的候选词。';
  return '该子块没有生成关键词。';
}
