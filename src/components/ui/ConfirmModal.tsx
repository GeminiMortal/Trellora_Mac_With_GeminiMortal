/**
 * ConfirmModal — themed confirmation dialog replacing native window.confirm.
 * 确认对话框 —— 替代原生 window.confirm 的主题化确认框。
 *
 * Variants: 'default' (neutral) | 'danger' (destructive, red confirm).
 * 变体：'default' 中性 ｜ 'danger' 危险（红色确认按钮）。
 */
import React from 'react';
import { Modal, Button, Group, Text, Stack } from '@mantine/core';
import { t, useI18n } from '../../i18n/index.ts';

export interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  detail?: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'default' | 'danger';
  onConfirm: () => void;
  onClose: () => void;
}

export default function ConfirmModal({
  isOpen,
  title,
  message,
  detail,
  confirmText,
  cancelText,
  variant = 'default',
  onConfirm,
  onClose,
}: ConfirmModalProps) {
  useI18n();
  return (
    <Modal
      opened={isOpen}
      onClose={onClose}
      title={title}
      centered
      size="sm"
      radius="md"
      closeOnClickOutside
    >
      <Stack gap="md">
        <Text size="sm">{message}</Text>
        {detail && (
          <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>{detail}</Text>
        )}
        <Group justify="flex-end" gap="sm">
          <Button variant="subtle" color="gray" onClick={onClose}>
            {cancelText ?? t('取消')}
          </Button>
          <Button
            color={variant === 'danger' ? 'red' : 'primary'}
            variant={variant === 'danger' ? 'filled' : 'filled'}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmText ?? t('确认')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
