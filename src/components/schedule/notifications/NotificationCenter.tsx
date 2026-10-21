/**
 * NotificationCenter — drawer showing notification history + quick settings.
 * 通知中心 — 显示通知历史与快捷设置的侧栏抽屉。
 */
import { useState, useEffect, useCallback } from 'react';
import { Drawer, Stack, Group, Text, ActionIcon, ScrollArea, Divider, Switch, Badge } from '@mantine/core';
import { Bell, BellOff, Trash2, Clock } from 'lucide-react';
import { t, useI18n } from '../../../i18n/index.ts';

interface NotificationEntry {
  id: string;
  itemId: string;
  title: string;
  location?: string;
  startAt: string;
  receivedAt: number;
  read: boolean;
}

interface NotificationCenterProps {
  opened: boolean;
  onClose: () => void;
  onClickItem: (itemId: string) => void;
}

export default function NotificationCenter({ opened, onClose, onClickItem }: NotificationCenterProps) {
  useI18n();
  const [notifications, setNotifications] = useState<NotificationEntry[]>([]);
  const [globalMuted, setGlobalMuted] = useState(false);

  // Subscribe to reminder events
  useEffect(() => {
    const unsub = (window as any).electronAPI?.onScheduleReminder?.((event: any) => {
      setNotifications((prev) => [
        {
          id: event.reminderId,
          itemId: event.itemId,
          title: event.title,
          location: event.location,
          startAt: event.startAt,
          receivedAt: Date.now(),
          read: false,
        },
        ...prev,
      ].slice(0, 100)); // keep last 100
    });
    return unsub;
  }, []);

  const handleMarkAllRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }, []);

  const handleClear = useCallback(() => {
    setNotifications([]);
  }, []);

  const handleClick = useCallback((entry: NotificationEntry) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === entry.id ? { ...n, read: true } : n)),
    );
    onClickItem(entry.itemId);
    onClose();
  }, [onClickItem, onClose]);

  const unreadCount = notifications.filter((n) => !n.read).length;

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    const now = new Date();
    const diffMin = Math.floor((now.getTime() - d.getTime()) / 60000);
    if (diffMin < 1) return t('刚刚');
    if (diffMin < 60) return t('{0}分钟前', { '0': diffMin });
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return t('{0}小时前', { '0': diffHr });
    return d.toLocaleDateString();
  };

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="xs"
      title={
        <Group justify="space-between" w="100%">
          <Group gap="xs">
            <Bell size={16} />
            <Text fw={600}>{t('通知中心')}</Text>
            {unreadCount > 0 && (
              <Badge size="xs" color="red" variant="filled">{unreadCount}</Badge>
            )}
          </Group>
          <Group gap="xs">
            {notifications.length > 0 && (
              <>
                <ActionIcon aria-label="标记已读"
                  variant="subtle"
                  size="sm"
                  onClick={handleMarkAllRead}
                  title={t('全部已读')}
                >
                  <Clock size={14} />
                </ActionIcon>
                <ActionIcon aria-label="清除通知"
                  variant="subtle"
                  size="sm"
                  color="red"
                  onClick={handleClear}
                  title={t('清除全部')}
                >
                  <Trash2 size={14} />
                </ActionIcon>
              </>
            )}
          </Group>
        </Group>
      }
    >
      <Stack gap="xs">
        <Group justify="space-between" px="xs">
          <Text size="xs" c="dimmed">{t('全局免打扰')}</Text>
          <Switch
            size="xs"
            checked={globalMuted}
            onChange={(e) => setGlobalMuted(e.currentTarget.checked)}
            onLabel={<BellOff size={10} />}
          />
        </Group>
        <Divider />
        <ScrollArea h="calc(100vh - 180px)">
          {notifications.length === 0 ? (
            <Stack align="center" py="xl" gap="xs">
              <Bell size={32} opacity={0.2} />
              <Text size="sm" c="dimmed">{t('暂无通知')}</Text>
            </Stack>
          ) : (
            <Stack gap={2}>
              {notifications.map((n) => (
                <div
                  key={n.id}
                  className={`schedule-notification-item ${n.read ? 'read' : 'unread'}`}
                  onClick={() => handleClick(n)}
                >
                  <Group justify="space-between" w="100%">
                    <Text size="sm" fw={n.read ? 400 : 600} truncate="end">
                      {n.title}
                    </Text>
                    {!n.read && <div className="schedule-notification-dot" />}
                  </Group>
                  <Text size="xs" c="dimmed">
                    {n.location && `📍 ${n.location} · `}
                    ⏰ {n.startAt.includes('T') ? n.startAt.split('T')[1]?.slice(0, 5) : n.startAt}
                    {' · '}
                    {formatTime(n.receivedAt)}
                  </Text>
                </div>
              ))}
            </Stack>
          )}
        </ScrollArea>
      </Stack>
    </Drawer>
  );
}