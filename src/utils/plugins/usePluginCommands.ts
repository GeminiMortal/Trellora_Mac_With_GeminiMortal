/**
 * Plugin command hooks: list panel-bound plugin commands and invoke them from the UI.
 * 插件命令 Hook：列出绑定面板的插件命令，并从界面调用它们。
 */
import { useCallback, useEffect, useState } from 'react';
import { showToast } from '../ui/feedback.ts';
import { t } from '../../i18n/index.ts';

/**
 * One plugin-contributed UI command as reported by the main process.
 * 主进程返回的单条插件 UI 命令。
 */
export interface PluginCommand {
    id: string;
    title: string;
    panel?: string;
}

interface PluginCommandHost {
    listCommands: () => Promise<Array<{ id: string; title: string; panel?: string }>>;
    invokeCommand: (commandId: string, args?: { trigger?: 'command-palette' | 'sidebar' | 'toolbar'; payload?: unknown }) => Promise<{ ok: boolean }>;
}

function getCommandHost(): PluginCommandHost | null {
    return (window.electronAPI as { plugin?: PluginCommandHost } | undefined)?.plugin ?? null;
}

/**
 * Loads plugin commands bound to one panel, refreshing whenever the plugin set changes.
 * 加载绑定到指定面板的插件命令，并在插件集合变化时刷新。
 *
 * @param panel - Panel id contributed commands must declare / 插件命令声明的面板标识
 * @returns The current command list / 当前命令列表
 */
export function usePluginCommands(panel: string): PluginCommand[] {
    const [commands, setCommands] = useState<PluginCommand[]>([]);

    useEffect(() => {
        const host = getCommandHost();
        let disposed = false;
        if (!host) return () => { disposed = true; };
        const refresh = () => {
            host.listCommands()
                .then((list) => { if (!disposed) setCommands(list.filter((command) => (command.panel ?? 'sidebar') === panel)); })
                .catch(() => { if (!disposed) setCommands([]); });
        };
        refresh();
        const timer = setInterval(refresh, 10_000);
        return () => { disposed = true; clearInterval(timer); };
    }, [panel]);

    return commands;
}

/**
 * Invokes a plugin command from the UI, surfacing failures as toasts instead of silent drops.
 * 从界面调用插件命令，失败时以 toast 提示而不是静默丢弃。
 *
 * @param trigger - Where the command was triggered from / 命令的触发来源
 * @returns An invoker accepting the command id / 接收命令 id 的调用函数
 */
export function useInvokePluginCommand(trigger: 'command-palette' | 'sidebar' | 'toolbar'): (commandId: string) => Promise<void> {
    return useCallback(async (commandId: string) => {
        const host = getCommandHost();
        if (!host) return;
        try {
            await host.invokeCommand(commandId, { trigger });
        } catch (error) {
            showToast({ type: 'error', title: t('插件命令执行失败'), message: (error as Error).message });
        }
    }, [trigger]);
}
