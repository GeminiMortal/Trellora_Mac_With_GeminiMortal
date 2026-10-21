/**
 * PluginManagementPanel — settings section for installed plugins.
 * 插件管理面板 —— 已安装插件的设置区块。
 *
 * Lists installed plugins with enable/disable/uninstall controls and an
 * install-from-URL entry. Permission state is surfaced read-only; L2 grants
 * happen via the host authorization dialog at activation time.
 *
 * 列出已安装插件，提供启用/禁用/卸载与按 URL 安装入口。权限状态只读展示；
 * L2 授权在激活时经宿主授权对话框完成。
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Group, Paper, Stack, Text, TextInput, Title } from '@mantine/core';
import { t, useI18n } from '../../i18n/index.ts';

interface PluginSummary {
  manifest: { id: string; name: string; version: string; description?: string; permissions: string[] };
  state: string;
  error?: string;
}

export default function PluginManagementPanel() {
  useI18n();
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setPlugins(await window.electronAPI.plugin.list());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const install = useCallback(async () => {
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await window.electronAPI.plugin.installFromUrl(url.trim());
      setUrl('');
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [url, refresh]);

  const toggle = useCallback(async (id: string, nextState: string) => {
    setBusy(true);
    setError(null);
    try {
      if (nextState === 'active') await window.electronAPI.plugin.enable(id);
      else await window.electronAPI.plugin.disable(id);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const uninstall = useCallback(async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await window.electronAPI.plugin.uninstall(id);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return (
    <Stack gap="md">
      <Title order={4}>{t('插件管理')}</Title>
      <Text size="sm" c="dimmed">{t('从 GitHub Release 安装插件包，或管理已安装插件的启用状态。')}</Text>

      {error && <Alert color="red" onClose={() => setError(null)}>{error}</Alert>}

      <Paper withBorder p="md">
        <Group align="flex-end" grow>
          <TextInput
            label={t('插件下载地址（GitHub Release URL）')}
            placeholder="https://github.com/.../releases/download/.../plugin.zip"
            value={url}
            onChange={(e) => setUrl(e.currentTarget.value)}
          />
          <Button onClick={() => void install()} loading={busy} disabled={!url.trim()}>{t('安装')}</Button>
        </Group>
      </Paper>

      {plugins.length === 0 ? (
        <Text size="sm" c="dimmed">{t('尚未安装插件。')}</Text>
      ) : (
        plugins.map((p) => (
          <Paper key={p.manifest.id} withBorder p="md">
            <Group justify="space-between" align="flex-start">
              <Stack gap={4}>
                <Group gap="xs">
                  <Text fw={500}>{p.manifest.name}</Text>
                  <Text size="sm" c="dimmed">v{p.manifest.version}</Text>
                  <Badge size="sm" color={p.state === 'active' ? 'green' : p.state === 'error' ? 'red' : 'gray'}>{p.state}</Badge>
                </Group>
                {p.manifest.description && <Text size="sm" c="dimmed">{p.manifest.description}</Text>}
                <Text size="xs" c="dimmed">{p.manifest.id}</Text>
                {p.manifest.permissions.length > 0 && (
                  <Group gap={4}>
                    {p.manifest.permissions.map((perm) => (
                      <Badge key={perm} size="xs" variant="outline" color={perm.startsWith('system:') ? 'orange' : 'blue'}>{perm}</Badge>
                    ))}
                  </Group>
                )}
                {p.error && <Text size="sm" c="red">{p.error}</Text>}
              </Stack>
              <Group gap="xs">
                {p.state === 'active' ? (
                  <Button size="xs" variant="light" onClick={() => void toggle(p.manifest.id, 'disabled')} disabled={busy}>{t('禁用')}</Button>
                ) : (
                  <Button size="xs" variant="light" color="green" onClick={() => void toggle(p.manifest.id, 'active')} disabled={busy}>{t('启用')}</Button>
                )}
                <Button size="xs" variant="light" color="red" onClick={() => void uninstall(p.manifest.id)} disabled={busy}>{t('卸载')}</Button>
              </Group>
            </Group>
          </Paper>
        ))
      )}
    </Stack>
  );
}
