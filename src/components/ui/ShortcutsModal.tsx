/**
 * ShortcutsModal — keyboard shortcuts reference (Cmd+/ or ?).
 * 快捷键速查表 —— 全局呼出（Cmd+/ 或 ?）。
 */
import React from 'react';
import { Modal, Stack, Group, Text, Kbd, Divider } from '@mantine/core';
import { t, useI18n } from '../../i18n/index.ts';

interface ShortcutItem { keys: string; desc: string }
interface ShortcutGroup { title: string; items: ShortcutItem[] }

const groups: ShortcutGroup[] = [
  {
    title: '全局',
    items: [
      { keys: 'Cmd/Ctrl + B', desc: '收起/展开左侧边栏' },
      { keys: 'Cmd/Ctrl + /', desc: '打开快捷键速查表' },
      { keys: 'Ctrl + `', desc: '打开/聚焦终端' },
      { keys: 'Cmd/Ctrl + Shift + L', desc: '切换日志面板' },
    ],
  },
  {
    title: '编辑器',
    items: [
      { keys: 'Cmd/Ctrl + S', desc: '保存当前笔记' },
      { keys: 'Cmd/Ctrl + Z', desc: '撤销' },
      { keys: 'Cmd/Ctrl + Shift + Z', desc: '重做' },
      { keys: 'Cmd/Ctrl + B', desc: '加粗（选中文本）' },
      { keys: 'Cmd/Ctrl + I', desc: '斜体（选中文本）' },
    ],
  },
  {
    title: '导航',
    items: [
      { keys: 'Cmd/Ctrl + 1~7', desc: '切换主导航项' },
      { keys: 'Esc', desc: '关闭当前弹窗/面板' },
    ],
  },
];

export default function ShortcutsModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  useI18n();
  return (
    <Modal
      opened={isOpen}
      onClose={onClose}
      title={t('键盘快捷键')}
      centered
      size="md"
      radius="md"
    >
      <Stack gap="lg">
        {groups.map((group) => (
          <Stack key={group.title} gap="xs">
            <Text size="sm" fw={600}>{group.title}</Text>
            <Divider />
            {group.items.map((item) => (
              <Group key={item.keys} justify="space-between" gap="md">
                <Text size="sm">{item.desc}</Text>
                <Kbd>{item.keys}</Kbd>
              </Group>
            ))}
          </Stack>
        ))}
      </Stack>
    </Modal>
  );
}
