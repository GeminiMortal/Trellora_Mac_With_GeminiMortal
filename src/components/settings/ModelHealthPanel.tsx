import { useState } from 'react';
import { Alert, Badge, Button, Group, Loader, Paper, Stack, Text } from '@mantine/core';
import { ArrowRight, CheckCircle2, Sparkles, XCircle } from 'lucide-react';
import { t, useI18n } from '../../i18n/index.ts';
import type { AiModelSettings, ModelHub } from '../../electron';
import { evaluateModelHealth, findZombieProfiles } from './modelHealth.ts';

interface ModelHealthPanelProps {
  settings: AiModelSettings;
  hub: ModelHub;
  aiAvailable: boolean | null;
  aiStatusMessage: string | null;
  onFix: (category: 'generation' | 'embedding' | 'rerank') => void;
  onDismissWizard: () => void;
  wizardDismissed: boolean;
}

/** 模型配置顶部的健康总览：一眼看清三类模型是否就绪；未就绪给出一键修复入口。 */
export function ModelHealthPanel({ settings, hub, aiAvailable, aiStatusMessage, onFix, onDismissWizard, wizardDismissed }: ModelHealthPanelProps) {
  useI18n();
  const items = evaluateModelHealth(settings, hub);
  const problems = items.filter((item) => !item.ok);
  const neverConfigured = settings.profiles.length <= 1 && !items[0].ok;

  if (neverConfigured && !wizardDismissed) {
    return (
      <Paper withBorder radius="lg" p="lg" mb="lg" className="settings-model-wizard">
        <Group justify="space-between" wrap="nowrap" gap="md">
          <Group gap="sm" wrap="nowrap" align="flex-start">
            <Badge size="lg" radius="md" variant="light" color="brand" leftSection={<Sparkles size={16} />}>{t('快速开始')}</Badge>
            <Stack gap={4}>
              <Text fw={700}>{t('三步启用 AI 功能')}</Text>
              <Text size="sm" c="dimmed">{t('1. 选择本地 Ollama 或远程 API　2. 填写 API Key（远程需要）　3. 选择模型并保存')}</Text>
            </Stack>
          </Group>
          <Group gap="sm" wrap="nowrap">
            <Button variant="subtle" color="gray" size="compact-sm" onClick={onDismissWizard}>{t('稍后再说')}</Button>
            <Button rightSection={<ArrowRight size={15} />} onClick={() => onFix('generation')}>{t('开始配置')}</Button>
          </Group>
        </Group>
      </Paper>
    );
  }

  if (problems.length === 0) {
    return (
      <Alert variant="light" color="teal" icon={<CheckCircle2 size={18} />} mb="lg">
        {t('模型配置就绪：{0}', { '0': items.map((item) => `${item.label} ${item.reason}`).join(' · ') })}
        {aiAvailable === false && aiStatusMessage ? <Text size="xs" c="dimmed" mt={4}>{t('连接检测：')}{aiStatusMessage}</Text> : null}
      </Alert>
    );
  }

  return (
    <Alert variant="light" color="orange" icon={<Sparkles size={18} />} mb="lg">
      <Stack gap="xs">
        {items.map((item) => (
          <Group key={item.key} justify="space-between" wrap="nowrap" gap="sm">
            <Group gap="xs" wrap="nowrap">
              {item.ok
                ? <CheckCircle2 size={15} color="var(--mantine-color-teal-6)" />
                : <XCircle size={15} color="var(--mantine-color-orange-6)" />}
              <Text size="sm">{item.label}</Text>
              <Text size="xs" c={item.ok ? 'dimmed' : 'orange'} style={{ overflowWrap: 'anywhere' }}>{item.reason}</Text>
            </Group>
            {!item.ok ? <Button size="compact-xs" variant="light" color="orange" rightSection={<ArrowRight size={13} />} onClick={() => onFix(item.fixCategory)}>{t('去修复')}</Button> : null}
          </Group>
        ))}
        {aiAvailable === false && aiStatusMessage ? <Text size="xs" c="dimmed">{t('连接检测：')}{aiStatusMessage}</Text> : null}
      </Stack>
    </Alert>
  );
}

interface ZombieCleanupBarProps {
  settings: AiModelSettings;
  onClean: (ids: string[]) => void;
}

/** 空档案清理提示条：只统计"自动迁移生成且从未配置"的档案，手动配置过的不算。 */
export function ZombieCleanupBar({ settings, onClean }: ZombieCleanupBarProps) {
  useI18n();
  const zombieIds = findZombieProfiles(settings);
  const [confirming, setConfirming] = useState(false);
  if (zombieIds.length === 0) return null;
  return (
    <Group justify="space-between" gap="sm" mb="md" className="settings-zombie-cleanup">
      <Text size="xs" c="dimmed">{t('有 {0} 个从未配置过的连接（多为升级时自动生成）。', { '0': String(zombieIds.length) })}</Text>
      <Group gap="xs" wrap="nowrap">
        {confirming ? <>
          <Loader size={14} />
          <Button size="compact-xs" variant="light" color="red" onClick={() => { onClean(zombieIds); setConfirming(false); }}>{t('确认清理')}</Button>
          <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setConfirming(false)}>{t('取消')}</Button>
        </> : (
          <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setConfirming(true)}>{t('清理未使用连接')}</Button>
        )}
      </Group>
    </Group>
  );
}
