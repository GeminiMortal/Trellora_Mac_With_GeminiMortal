/**
 * PluginLibraryView — 插件库独立页面（MainView = 'plugins'）。
 * Standalone plugin-library page (MainView = 'plugins').
 *
 * 这里是完整独立的一页（类似 Wiki / 知识图谱 / 日程），
 * 从左侧 NavRail「工具 → 插件库」进入，不再嵌套在设置页里。
 *
 * 设计要点：
 * - Hero 头部：标题 + 副标题 + 全局搜索 + 状态筛选 + 安装入口
 * - 卡片网格：已安装插件卡片（名称/版本/描述/权限分组/状态），支持批量选择
 * - 详情侧栏：点击卡片右侧滑出详情（manifest 全量、权限、UI 命令、操作）
 * - 安装向导：URL / 本地 ZIP 两种方式，带拖拽区
 * - 响应式：宽屏 3 列 → 窄屏 1 列；详情侧栏窄屏转抽屉
 *
 * 权限只读展示；L2 授权在激活时经宿主授权对话框完成（契约 §7）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Divider,
  Group,
  Modal,
  Paper,
  ScrollArea,
  SegmentedControl,
  Select,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  AlertTriangle,
  Bot,
  CalendarDays,
  Check,
  Circle,
  Database,
  Download,
  Eye,
  FileArchive,
  FileText,
  Filter,
  Info,
  Package,
  Puzzle,
  RefreshCw,
  Search,
  Settings2,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { t, useI18n } from '../../i18n/index.ts';
import { showToast } from '../../utils/ui/feedback.ts';
import './PluginLibraryView.css';

// ── 类型（与 electron/plugins/pluginTypes.ts 的 PluginManifest 对齐）────────

interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  main?: string;
  engine?: { trellora: string };
  permissions: string[];
  activation?: string[];
  contributes?: {
    uiCommands?: Array<{ id: string; title: string; panel?: 'sidebar' | 'command-palette' | 'toolbar' }>;
  };
}

type PluginState = 'registered' | 'active' | 'disabled' | 'error';

interface PluginSummary {
  manifest: PluginManifest;
  state: PluginState;
  error?: string;
}

type StateFilter = 'all' | 'active' | 'disabled' | 'registered' | 'error';

// ── 权限分组（按契约 §7 的权限前缀与 L2 分级）──────────────────────────────

interface PermissionGroupInfo {
  prefix: string;
  label: string;
  color: string;
  risk: 'high' | 'medium' | 'low';
  icon: typeof Eye;
  description: string;
}

const PERMISSION_GROUPS: PermissionGroupInfo[] = [
  { prefix: 'system:', label: '系统级', color: 'red', risk: 'high', icon: ShieldAlert, description: '文件 / 网络 / 子进程（激活时需显式授权）' },
  { prefix: 'ui:', label: '界面交互', color: 'blue', risk: 'low', icon: Eye, description: '注册侧边栏 / 命令面板 / 工具栏命令' },
  { prefix: 'schedule:', label: '日程写入', color: 'teal', risk: 'medium', icon: CalendarDays, description: '向日程 upsert / 删除条目' },
  { prefix: 'ai:', label: 'AI 提供方', color: 'orange', risk: 'medium', icon: Bot, description: '注册自定义 AI 生成提供方' },
  { prefix: 'pipeline:', label: '解析流水线', color: 'violet', risk: 'medium', icon: FileText, description: '按扩展名注册文档解析路由' },
  { prefix: 'data:', label: '数据源', color: 'grape', risk: 'medium', icon: Database, description: '注册检索 / 向量数据源' },
];

const STATE_META: Record<PluginState, { label: string; color: string; icon: typeof Circle }> = {
  active: { label: '已启用', color: 'green', icon: Check },
  disabled: { label: '已禁用', color: 'gray', icon: Circle },
  registered: { label: '已注册', color: 'blue', icon: Sparkles },
  error: { label: '错误', color: 'red', icon: AlertTriangle },
};

function groupPermissions(permissions: string[]): Array<{ group: PermissionGroupInfo; perms: string[] }> {
  const buckets = new Map<PermissionGroupInfo, string[]>();
  for (const permission of permissions) {
    const group = PERMISSION_GROUPS.find((g) => permission.startsWith(g.prefix));
    if (group) {
      const list = buckets.get(group) ?? [];
      list.push(permission);
      buckets.set(group, list);
    }
  }
  return [...buckets.entries()].map(([group, perms]) => ({ group, perms }));
}

function riskBadgeColor(risk: PermissionGroupInfo['risk']): string {
  return risk === 'high' ? 'red' : risk === 'medium' ? 'orange' : 'green';
}

function riskLabel(risk: PermissionGroupInfo['risk']): string {
  return risk === 'high' ? '高风险' : risk === 'medium' ? '中风险' : '低风险';
}

// ── 主组件 ────────────────────────────────────────────────────────────────

export default function PluginLibraryView({ active }: { active: boolean }) {
  useI18n();
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [installTab, setInstallTab] = useState<'url' | 'file'>('url');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [detailPlugin, setDetailPlugin] = useState<PluginSummary | null>(null);
  const [installModalOpen, setInstallModalOpen] = useState(false);
  const [fileDragOver, setFileDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const list = (await window.electronAPI.plugin.list()) as unknown as PluginSummary[];
      setPlugins(list);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  const installFromUrl = useCallback(async () => {
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await window.electronAPI.plugin.installFromUrl(url.trim());
      setUrl('');
      showToast({ type: 'success', message: t('插件安装成功。') });
      await refresh();
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      showToast({ type: 'error', message: t('安装失败：{0}', { 0: message }) });
    } finally {
      setBusy(false);
    }
  }, [url, refresh]);

  const installFromZip = useCallback(async (zipPath: string) => {
    setBusy(true);
    setError(null);
    try {
      await window.electronAPI.plugin.installFromZip(zipPath);
      showToast({ type: 'success', message: t('插件安装成功。') });
      await refresh();
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      showToast({ type: 'error', message: t('安装失败：{0}', { 0: message }) });
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const chooseZip = useCallback(async () => {
    const zipPath = await window.electronAPI.plugin.chooseZip();
    if (zipPath) await installFromZip(zipPath);
  }, [installFromZip]);

  const toggle = useCallback(async (id: string, nextState: 'active' | 'disabled') => {
    setBusy(true);
    setError(null);
    try {
      if (nextState === 'active') await window.electronAPI.plugin.enable(id);
      else await window.electronAPI.plugin.disable(id);
      await refresh();
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      showToast({ type: 'error', message: t('操作失败：{0}', { 0: message }) });
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const uninstall = useCallback(async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await window.electronAPI.plugin.uninstall(id);
      setSelectedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
      if (detailPlugin?.manifest.id === id) setDetailPlugin(null);
      await refresh();
      showToast({ type: 'success', message: t('插件已卸载。') });
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      showToast({ type: 'error', message: t('卸载失败：{0}', { 0: message }) });
    } finally {
      setBusy(false);
    }
  }, [refresh, detailPlugin]);

  const bulkAction = useCallback(async (action: 'enable' | 'disable' | 'uninstall') => {
    if (selectedIds.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const id of selectedIds) {
        if (action === 'enable') await window.electronAPI.plugin.enable(id);
        else if (action === 'disable') await window.electronAPI.plugin.disable(id);
        else await window.electronAPI.plugin.uninstall(id);
      }
      setSelectedIds(new Set());
      await refresh();
      showToast({ type: 'success', message: action === 'uninstall' ? t('已批量卸载。') : action === 'enable' ? t('已批量启用。') : t('已批量禁用。') });
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      showToast({ type: 'error', message: t('批量操作失败：{0}', { 0: message }) });
    } finally {
      setBusy(false);
    }
  }, [selectedIds, refresh]);

  const filteredPlugins = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return plugins.filter((p) => {
      const matchesSearch = !query
        || p.manifest.name.toLowerCase().includes(query)
        || p.manifest.id.toLowerCase().includes(query)
        || (p.manifest.description ?? '').toLowerCase().includes(query)
        || (p.manifest.author ?? '').toLowerCase().includes(query);
      const matchesFilter = stateFilter === 'all' || p.state === stateFilter;
      return matchesSearch && matchesFilter;
    });
  }, [plugins, searchQuery, stateFilter]);

  const allFilteredIds = useMemo(() => new Set(filteredPlugins.map((p) => p.manifest.id)), [filteredPlugins]);
  const allSelected = filteredPlugins.length > 0 && selectedIds.size === filteredPlugins.length && filteredPlugins.every((p) => selectedIds.has(p.manifest.id));

  const toggleSelectAll = () => {
    if (allSelected) setSelectedIds(new Set());
    else setSelectedIds(allFilteredIds);
  };

  const toggleSelectOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const activeCount = plugins.filter((p) => p.state === 'active').length;
  const errorCount = plugins.filter((p) => p.state === 'error').length;

  return (
    <div className="plugin-library-view" data-theme="dark">
      {/* ── Hero 头部 ─────────────────────────────────────────────────── */}
      <header className="pl-hero">
        <div className="pl-hero-main">
          <div className="pl-hero-icon"><Puzzle size={28} /></div>
          <div className="pl-hero-text">
            <Title order={1} className="pl-hero-title">插件库</Title>
            <Text size="sm" c="dimmed" className="pl-hero-subtitle">
              管理已安装插件、扩展 Trellora 能力。支持 GitHub Release ZIP 与本地安装。
            </Text>
          </div>
        </div>
        <div className="pl-hero-stats">
          <div className="pl-stat"><span className="pl-stat-num">{plugins.length}</span><span className="pl-stat-label">全部</span></div>
          <div className="pl-stat pl-stat-active"><span className="pl-stat-num">{activeCount}</span><span className="pl-stat-label">已启用</span></div>
          {errorCount > 0 && <div className="pl-stat pl-stat-error"><span className="pl-stat-num">{errorCount}</span><span className="pl-stat-label">异常</span></div>}
        </div>
        <div className="pl-hero-actions">
          <Button leftSection={<Download size={16} />} onClick={() => { setInstallTab('url'); setInstallModalOpen(true); }} disabled={busy}>
            {t('安装插件')}
          </Button>
          <Tooltip label={t('刷新插件列表')} withArrow>
            <ActionIcon variant="default" size="lg" onClick={() => void refresh()} loading={busy} aria-label={t('刷新')}>
              <RefreshCw size={18} />
            </ActionIcon>
          </Tooltip>
        </div>
      </header>

      {error && (
        <Alert color="red" icon={<AlertTriangle size={16} />} onClose={() => setError(null)} mx={20} mt="md">
          {error}
        </Alert>
      )}

      {/* ── 工具条：搜索 / 筛选 / 批量 ─────────────────────────────────── */}
      <div className="pl-toolbar">
        <TextInput
          placeholder={t('搜索插件名称、ID、描述或作者…')}
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.currentTarget.value)}
          leftSection={<Search size={16} />}
          rightSection={searchQuery ? <ActionIcon size="sm" variant="subtle" onClick={() => setSearchQuery('')} aria-label={t('清除搜索')}><X size={14} /></ActionIcon> : undefined}
          className="pl-search"
          size="md"
        />
        <Select
          placeholder={t('全部状态')}
          value={stateFilter}
          onChange={(value) => setStateFilter((value as StateFilter) ?? 'all')}
          data={[
            { value: 'all', label: t('全部状态') },
            { value: 'active', label: t('已启用') },
            { value: 'disabled', label: t('已禁用') },
            { value: 'registered', label: t('已注册') },
            { value: 'error', label: t('错误') },
          ]}
          leftSection={<Filter size={16} />}
          size="md"
          className="pl-filter"
        />
        {filteredPlugins.length > 0 && (
          <Checkbox
            checked={allSelected}
            onChange={toggleSelectAll}
            label={allSelected ? t('取消全选') : t('全选')}
            size="md"
            className="pl-select-all"
          />
        )}
      </div>

      {/* ── 批量操作条 ─────────────────────────────────────────────────── */}
      {selectedIds.size > 0 && (
        <Paper withBorder className="pl-bulk-bar" mx={20} mt="sm" p="sm">
          <Group justify="space-between" wrap="wrap">
            <Text size="sm" fw={500}>{t('已选择 {0} 个插件', { 0: selectedIds.size })}</Text>
            <Group gap="xs">
              <Button size="sm" variant="light" color="green" leftSection={<Check size={14} />} onClick={() => void bulkAction('enable')} disabled={busy}>{t('启用')}</Button>
              <Button size="sm" variant="light" color="gray" leftSection={<Circle size={14} />} onClick={() => void bulkAction('disable')} disabled={busy}>{t('禁用')}</Button>
              <Button size="sm" variant="light" color="red" leftSection={<Trash2 size={14} />} onClick={() => void bulkAction('uninstall')} disabled={busy}>{t('卸载')}</Button>
              <ActionIcon size="sm" variant="subtle" onClick={() => setSelectedIds(new Set())} aria-label={t('取消选择')}><X size={14} /></ActionIcon>
            </Group>
          </Group>
        </Paper>
      )}

      {/* ── 卡片网格 ───────────────────────────────────────────────────── */}
      <ScrollArea className="pl-scroll" type="auto">
        <div className="pl-grid-wrap">
          {loading ? (
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="lg">
              {[...Array(6)].map((_, index) => (
                <Paper key={index} withBorder className="pl-card pl-card-skeleton" p="lg">
                  <Skeleton height={28} width="55%" mb="sm" />
                  <Skeleton height={14} width="85%" mb="xs" />
                  <Skeleton height={14} width="70%" />
                </Paper>
              ))}
            </SimpleGrid>
          ) : plugins.length === 0 ? (
            <div className="pl-empty">
              <Package size={72} />
              <Title order={3}>{t('尚未安装插件')}</Title>
              <Text size="sm" c="dimmed">{t('点击右上角「安装插件」，从 GitHub Release 或本地 ZIP 添加第一个插件。')}</Text>
            </div>
          ) : filteredPlugins.length === 0 ? (
            <div className="pl-empty">
              <Search size={72} />
              <Title order={3}>{t('没有匹配的插件')}</Title>
              <Text size="sm" c="dimmed">{t('尝试调整搜索关键词或状态筛选。')}</Text>
            </div>
          ) : (
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="lg">
              {filteredPlugins.map((plugin) => (
                <PluginCard
                  key={plugin.manifest.id}
                  plugin={plugin}
                  selected={selectedIds.has(plugin.manifest.id)}
                  busy={busy}
                  onSelect={() => toggleSelectOne(plugin.manifest.id)}
                  onDetail={() => setDetailPlugin(plugin)}
                  onToggle={() => void toggle(plugin.manifest.id, plugin.state === 'active' ? 'disabled' : 'active')}
                  onUninstall={() => void uninstall(plugin.manifest.id)}
                />
              ))}
            </SimpleGrid>
          )}
        </div>
      </ScrollArea>

      {/* ── 安装弹窗 ───────────────────────────────────────────────────── */}
      <Modal
        opened={installModalOpen}
        onClose={() => setInstallModalOpen(false)}
        title={t('安装插件')}
        size="lg"
        centered
        classNames={{ content: 'pl-install-modal' }}
      >
        <Stack gap="lg">
          <SegmentedControl
            fullWidth
            value={installTab}
            onChange={(value) => setInstallTab(value as 'url' | 'file')}
            data={[
              { value: 'url', label: t('从 URL 安装') },
              { value: 'file', label: t('从本地 ZIP 安装') },
            ]}
          />
          {installTab === 'url' ? (
            <Stack gap="md">
              <TextInput
                label={t('插件下载地址（GitHub Release ZIP）')}
                description={t('指向包含 plugin.json 的插件 ZIP 包直链。')}
                placeholder="https://github.com/owner/repo/releases/download/tag/plugin.zip"
                value={url}
                onChange={(event) => setUrl(event.currentTarget.value)}
                leftSection={<Download size={16} />}
                size="md"
              />
              <Group justify="flex-end" gap="xs">
                <Button variant="subtle" onClick={() => setInstallModalOpen(false)}>{t('取消')}</Button>
                <Button onClick={() => void installFromUrl()} loading={busy} disabled={!url.trim()}>
                  {t('安装')}
                </Button>
              </Group>
            </Stack>
          ) : (
            <Stack gap="md">
              <div
                className={`pl-file-drop${fileDragOver ? ' is-dragging' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setFileDragOver(true); }}
                onDragLeave={() => setFileDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setFileDragOver(false);
                  const file = e.dataTransfer.files?.[0];
                  if (file && file.name.toLowerCase().endsWith('.zip')) {
                    void chooseZip();
                  } else {
                    showToast({ type: 'warning', message: t('请提供 .zip 格式的插件包。') });
                  }
                }}
              >
                <FileArchive size={52} />
                <Text fw={600} size="sm">{busy ? t('安装中…') : t('拖拽 ZIP 文件到此处，或点击选择')}</Text>
                <Text size="xs" c="dimmed">{t('仅接受 .zip 插件包，须包含 plugin.json 与 main.js')}</Text>
                <Button variant="outline" size="sm" mt="sm" onClick={() => void chooseZip()} disabled={busy}>
                  {t('选择文件')}
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".zip"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void chooseZip();
                  }}
                />
              </div>
            </Stack>
          )}
        </Stack>
      </Modal>

      {/* ── 详情侧栏 ───────────────────────────────────────────────────── */}
      <div className={`pl-detail-panel${detailPlugin ? ' is-open' : ''}`} aria-hidden={!detailPlugin}>
        {detailPlugin && (
          <>
            <div className="pl-detail-header">
              <div className="pl-detail-header-main">
                <div className="pl-detail-icon"><Puzzle size={22} /></div>
                <div>
                  <Title order={4} style={{ minWidth: 0 }}>{detailPlugin.manifest.name}</Title>
                  <Group gap="xs">
                    <Badge size="sm" variant={detailPlugin.state === 'active' ? 'filled' : 'light'} color={STATE_META[detailPlugin.state].color}>
                      {t(STATE_META[detailPlugin.state].label)}
                    </Badge>
                    <Text size="sm" c="dimmed">v{detailPlugin.manifest.version}</Text>
                    {detailPlugin.manifest.author && <Text size="sm" c="dimmed">· {detailPlugin.manifest.author}</Text>}
                  </Group>
                </div>
              </div>
              <ActionIcon variant="subtle" onClick={() => setDetailPlugin(null)} aria-label={t('关闭详情')}>
                <X size={18} />
              </ActionIcon>
            </div>
            <ScrollArea className="pl-detail-scroll" type="auto">
              <PluginDetail plugin={detailPlugin} onClose={() => setDetailPlugin(null)} />
            </ScrollArea>
          </>
        )}
      </div>
    </div>
  );
}

// ── 插件卡片 ────────────────────────────────────────────────────────────────

function PluginCard({
  plugin,
  selected,
  busy,
  onSelect,
  onDetail,
  onToggle,
  onUninstall,
}: {
  plugin: PluginSummary;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onDetail: () => void;
  onToggle: () => void;
  onUninstall: () => void;
}) {
  const { manifest } = plugin;
  const stateMeta = STATE_META[plugin.state];
  const grouped = groupPermissions(manifest.permissions);
  const canEnable = plugin.state !== 'active';
  const StateIcon = stateMeta.icon;

  return (
    <Paper
      withBorder
      className={`pl-card${selected ? ' is-selected' : ''}`}
      data-state={plugin.state}
      onClick={onDetail}
    >
      <div className="pl-card-select">
        <Checkbox
          checked={selected}
          onChange={onSelect}
          onClick={(event) => event.stopPropagation()}
          aria-label={t('选择 {0}', { 0: manifest.name })}
        />
      </div>
      <div className="pl-card-icon">
        <ThemeIcon size={44} radius={10} variant="light" color={stateMeta.color}>
          <Puzzle size={22} />
        </ThemeIcon>
      </div>
      <div className="pl-card-body">
        <Group gap="xs" wrap="nowrap">
          <Text fw={650} size="md" truncate className="pl-card-title">{manifest.name}</Text>
        </Group>
        <Group gap={6} wrap="wrap">
          <Badge size="xs" variant="light" color={stateMeta.color} leftSection={<StateIcon size={10} />}>
            {t(stateMeta.label)}
          </Badge>
          <Badge size="xs" variant="outline" color="gray">v{manifest.version}</Badge>
          {manifest.activation?.map((a) => (
            <Badge key={a} size="xs" variant="dot" color="gray">{a}</Badge>
          ))}
        </Group>
        {manifest.description && (
          <Text size="sm" c="dimmed" lineClamp={2} className="pl-card-desc">{manifest.description}</Text>
        )}
        <Group gap={4} wrap="wrap">
          {grouped.map(({ group, perms }) => {
            const Icon = group.icon;
            return (
              <Tooltip key={group.prefix} label={`${group.label}（${perms.length}）`} withArrow>
                <Badge size="xs" variant="outline" color={group.color} leftSection={<Icon size={10} />}>
                  {group.label} {perms.length}
                </Badge>
              </Tooltip>
            );
          })}
        </Group>
        {plugin.error && <Text size="xs" c="red" lineClamp={1}>{plugin.error}</Text>}
      </div>
      <div className="pl-card-actions" onClick={(e) => e.stopPropagation()}>
        <Tooltip label={canEnable ? t('启用') : t('禁用')} withArrow>
          <ActionIcon
            size="md"
            variant="light"
            color={canEnable ? 'green' : 'gray'}
            onClick={onToggle}
            disabled={busy}
            aria-label={canEnable ? t('启用') : t('禁用')}
          >
            {canEnable ? <Check size={16} /> : <Circle size={16} />}
          </ActionIcon>
        </Tooltip>
        <Tooltip label={t('卸载')} withArrow>
          <ActionIcon size="md" variant="light" color="red" onClick={onUninstall} disabled={busy} aria-label={t('卸载')}>
            <Trash2 size={16} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={t('详情')} withArrow>
          <ActionIcon size="md" variant="subtle" onClick={onDetail} aria-label={t('详情')}>
            <Info size={16} />
          </ActionIcon>
        </Tooltip>
      </div>
    </Paper>
  );
}

// ── 详情内容 ────────────────────────────────────────────────────────────────

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Group gap="sm" align="flex-start" wrap="nowrap">
      <Text size="sm" c="dimmed" w={96} style={{ flexShrink: 0 }}>{label}</Text>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </Group>
  );
}

function PluginDetail({ plugin, onClose }: { plugin: PluginSummary; onClose: () => void }) {
  const { manifest } = plugin;
  const grouped = groupPermissions(manifest.permissions);

  return (
    <Stack gap="md" p="lg">
      <Divider label={t('基本信息')} labelPosition="left" />
      <Stack gap="xs">
        <DetailRow label={t('插件 ID')}><Text size="sm" style={{ fontFamily: 'var(--mantine-font-family-monospace)' }}>{manifest.id}</Text></DetailRow>
        {manifest.description && <DetailRow label={t('描述')}><Text size="sm">{manifest.description}</Text></DetailRow>}
        {manifest.license && <DetailRow label={t('许可证')}><Text size="sm">{manifest.license}</Text></DetailRow>}
        {manifest.engine?.trellora && <DetailRow label={t('最低版本')}><Text size="sm">{t('Trellora {0}', { 0: manifest.engine.trellora })}</Text></DetailRow>}
        {manifest.main && <DetailRow label={t('入口文件')}><Text size="sm" style={{ fontFamily: 'var(--mantine-font-family-monospace)' }}>{manifest.main}</Text></DetailRow>}
        {manifest.activation && manifest.activation.length > 0 && (
          <DetailRow label={t('激活方式')}>
            <Group gap={4} wrap="wrap">
              {manifest.activation.map((activation) => <Badge key={activation} size="xs" variant="outline">{activation}</Badge>)}
            </Group>
          </DetailRow>
        )}
      </Stack>

      <Divider label={t('权限')} labelPosition="left" />
      {grouped.length === 0 ? (
        <Text size="sm" c="dimmed">{t('未声明权限。')}</Text>
      ) : (
        <Stack gap="sm">
          {grouped.map(({ group, perms }) => {
            const Icon = group.icon;
            return (
              <Stack key={group.prefix} gap={4}>
                <Group gap="xs">
                  <Icon size={15} color={`var(--mantine-color-${group.color}-6)`} />
                  <Text fw={600} size="sm">{group.label}</Text>
                  <Badge size="xs" variant="outline" color={riskBadgeColor(group.risk)}>{riskLabel(group.risk)}</Badge>
                </Group>
                <Text size="xs" c="dimmed">{group.description}</Text>
                <Group gap={4} wrap="wrap">
                  {perms.map((perm) => (
                    <Badge key={perm} size="xs" variant="light" color="gray" style={{ fontFamily: 'var(--mantine-font-family-monospace)' }}>{perm}</Badge>
                  ))}
                </Group>
              </Stack>
            );
          })}
        </Stack>
      )}

      {manifest.contributes?.uiCommands && manifest.contributes.uiCommands.length > 0 && (
        <>
          <Divider label={t('UI 命令')} labelPosition="left" />
          <Stack gap="xs">
            {manifest.contributes.uiCommands.map((command) => (
              <Paper key={command.id} withBorder p="xs" radius="sm">
                <Group gap="xs">
                  <Settings2 size={14} color="var(--mantine-color-gray-6)" />
                  <Text fw={500} size="sm">{command.title}</Text>
                  <Text size="xs" c="dimmed" style={{ fontFamily: 'var(--mantine-font-family-monospace)' }}>{command.id}</Text>
                  {command.panel && <Badge size="xs" variant="outline">{command.panel}</Badge>}
                </Group>
              </Paper>
            ))}
          </Stack>
        </>
      )}

      {plugin.error && (
        <>
          <Divider label={t('错误信息')} labelPosition="left" />
          <Alert color="red" variant="filled" icon={<AlertTriangle size={16} />} title={t('插件错误')}>{plugin.error}</Alert>
        </>
      )}

      <Divider label={t('操作')} labelPosition="left" />
      <Group justify="flex-end" gap="xs">
        <Button
          variant="light"
          color={plugin.state === 'active' ? 'gray' : 'green'}
          onClick={() => {
            onClose();
            if (plugin.state === 'active') void window.electronAPI.plugin.disable(manifest.id);
            else void window.electronAPI.plugin.enable(manifest.id);
          }}
        >
          {plugin.state === 'active' ? t('禁用') : t('启用')}
        </Button>
        <Button variant="light" color="red" onClick={() => { onClose(); void window.electronAPI.plugin.uninstall(manifest.id); }}>
          {t('卸载')}
        </Button>
      </Group>
    </Stack>
  );
}
