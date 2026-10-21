/**
 * Plugin permission manager.
 * 插件权限管理器。
 *
 * Enforces the three-tier model: L0 core (no check), L1 capability
 * (declared in manifest), L2 system (explicit user grant persisted per
 * plugin). L1 is auto-granted at install time since it is visible in the
 * permission disclosure; L2 requires the user to confirm.
 *
 * 三层权限模型执行：L0 核心（免检）、L1 能力（清单声明即授权）、
 * L2 系统（用户显式授权并按插件持久化）。L1 在安装时随权限展示自动授权；
 * L2 需用户确认。
 */

import type { PluginPermission } from './pluginTypes.ts';
import { L2_PERMISSIONS } from './pluginTypes.ts';

export class PluginPermissionDeniedError extends Error {
  readonly pluginId: string;
  readonly permission: PluginPermission;

  constructor(pluginId: string, permission: PluginPermission) {
    super(`插件 ${pluginId} 缺少权限 ${permission}，调用被拒绝。`);
    this.name = 'PluginPermissionDeniedError';
    this.pluginId = pluginId;
    this.permission = permission;
  }
}

/** Persists which L2 permissions each plugin has been granted. */
export interface PermissionStore {
  read(): Record<string, PluginPermission[]>;
  write(state: Record<string, PluginPermission[]>): void;
}

export class PluginPermissionManager {
  private readonly declared = new Map<string, Set<PluginPermission>>();
  private readonly grantedL2 = new Map<string, Set<PluginPermission>>();

  constructor(private readonly store: PermissionStore) {
    const persisted = store.read();
    for (const [id, perms] of Object.entries(persisted)) {
      this.grantedL2.set(id, new Set(perms));
    }
  }

  /** Registers the manifest-declared permissions for a plugin. */
  declare(pluginId: string, permissions: readonly PluginPermission[]): void {
    this.declared.set(pluginId, new Set(permissions));
    // L2 permissions must start ungranted; persist whatever is already there.
    if (!this.grantedL2.has(pluginId)) this.grantedL2.set(pluginId, new Set());
  }

  isDeclared(pluginId: string, permission: PluginPermission): boolean {
    return this.declared.get(pluginId)?.has(permission) ?? false;
  }

  isGranted(pluginId: string, permission: PluginPermission): boolean {
    if (!L2_PERMISSIONS.has(permission)) {
      // L1: declared in manifest is sufficient.
      return this.isDeclared(pluginId, permission);
    }
    return this.grantedL2.get(pluginId)?.has(permission) ?? false;
  }

  /** Grants an L2 permission (after explicit user authorization). */
  grant(pluginId: string, permission: PluginPermission): void {
    if (!L2_PERMISSIONS.has(permission)) return; // L1 needs no grant step
    if (!this.isDeclared(pluginId, permission)) {
      throw new PluginPermissionDeniedError(pluginId, permission);
    }
    let set = this.grantedL2.get(pluginId);
    if (!set) { set = new Set(); this.grantedL2.set(pluginId, set); }
    set.add(permission);
    this.persist();
  }

  /** Revokes an L2 permission. */
  revoke(pluginId: string, permission: PluginPermission): void {
    this.grantedL2.get(pluginId)?.delete(permission);
    this.persist();
  }

  /** Throws if the permission is not granted for this plugin. */
  assert(pluginId: string, permission: PluginPermission): void {
    if (!this.isGranted(pluginId, permission)) {
      throw new PluginPermissionDeniedError(pluginId, permission);
    }
  }

  /** Lists all permissions (declared and their grant state) for one plugin. */
  inspect(pluginId: string): Array<{ permission: PluginPermission; declared: boolean; granted: boolean }> {
    const declared = this.declared.get(pluginId) ?? new Set<PluginPermission>();
    const granted = this.grantedL2.get(pluginId) ?? new Set<PluginPermission>();
    const all = new Set<PluginPermission>([...declared, ...granted]);
    return [...all].map((permission) => ({
      permission,
      declared: declared.has(permission),
      granted: this.isGranted(pluginId, permission),
    }));
  }

  /** Removes all state for a plugin (uninstall). */
  forget(pluginId: string): void {
    this.declared.delete(pluginId);
    this.grantedL2.delete(pluginId);
    this.persist();
  }

  private persist(): void {
    const state: Record<string, PluginPermission[]> = {};
    for (const [id, set] of this.grantedL2) state[id] = [...set];
    this.store.write(state);
  }
}
