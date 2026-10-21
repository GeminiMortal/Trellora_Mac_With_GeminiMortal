/**
 * Plugin manifest parser and validator.
 * 插件清单解析与校验。
 *
 * Mirrors the checks in scripts/validate-plugin-manifest.mjs so the host
 * rejects the same malformed manifests at runtime.
 *
 * 与 scripts/validate-plugin-manifest.mjs 同构，宿主在运行时拒绝同一类非法清单。
 */

import type { PluginActivationEvent, PluginManifest, PluginPermission } from './pluginTypes.ts';

const PERMISSIONS: readonly PluginPermission[] = [
  'pipeline:parse', 'ai:provider', 'ui:command', 'data:source', 'schedule:write',
  'system:file', 'system:network', 'system:subprocess',
];
const ACTIVATION_EVENTS: readonly PluginActivationEvent[] = [
  'onStartup', 'onParseRequest', 'onAiRequest', 'onUiCommand', '*',
];

const ID_RE = /^[a-z0-9]+(\.[a-z0-9-]+)*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;
const MAIN_RE = /^[^/\\].*\.(js|mjs|cjs)$/;

/**
 * Parses and validates a plugin.json object. Throws on the first structural
 * violation; returns a normalized manifest.
 * 解析并校验 plugin.json 对象。结构性违规时抛错；返回规范化的清单。
 */
export function parsePluginManifest(raw: unknown): PluginManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('plugin.json 必须是 JSON 对象。');
  }
  const value = raw as Record<string, unknown>;

  const id = requireString(value, 'id');
  if (!ID_RE.test(id)) throw new Error(`plugin.json id 不合法：${id}（须为反向 DNS，如 com.example.my-plugin）。`);
  if (id.length < 3 || id.length > 128) throw new Error('plugin.json id 长度须在 3-128 之间。');

  const name = requireString(value, 'name');
  if (name.length < 1 || name.length > 64) throw new Error('plugin.json name 长度须在 1-64 之间。');

  const version = requireString(value, 'version');
  if (!VERSION_RE.test(version)) throw new Error(`plugin.json version 不合法：${version}（须为 semver，如 1.0.0）。`);

  const main = requireString(value, 'main');
  if (!MAIN_RE.test(main)) throw new Error(`plugin.json main 不合法：${main}（须为相对路径的 .js/.mjs/.cjs 文件，禁止绝对路径）。`);
  if (main.length > 256) throw new Error('plugin.json main 长度不得超过 256。');

  const engine = value.engine;
  if (!engine || typeof engine !== 'object' || Array.isArray(engine)) throw new Error('plugin.json engine 必须是对象。');
  const trelloraRange = (engine as Record<string, unknown>).trellora;
  if (typeof trelloraRange !== 'string' || trelloraRange.length < 1 || trelloraRange.length > 64) {
    throw new Error('plugin.json engine.trellora 必须是 1-64 字符的 semver range 字符串。');
  }

  const permissions = requireArray(value, 'permissions');
  const seenPermissions = new Set<PluginPermission>();
  for (const p of permissions) {
    if (typeof p !== 'string' || !PERMISSIONS.includes(p as PluginPermission)) {
      throw new Error(`plugin.json permissions 含未知项：${String(p)}。`);
    }
    if (seenPermissions.has(p as PluginPermission)) throw new Error(`plugin.json permissions 重复：${p}。`);
    seenPermissions.add(p as PluginPermission);
  }

  const activation = requireArray(value, 'activation');
  const seenActivation = new Set<PluginActivationEvent>();
  for (const e of activation) {
    if (typeof e !== 'string' || !ACTIVATION_EVENTS.includes(e as PluginActivationEvent)) {
      throw new Error(`plugin.json activation 含未知项：${String(e)}。`);
    }
    if (seenActivation.has(e as PluginActivationEvent)) throw new Error(`plugin.json activation 重复：${e}。`);
    seenActivation.add(e as PluginActivationEvent);
  }

  // Reject unknown top-level keys (matches the schema's additionalProperties: false).
  // 拒绝未知顶层键（与 schema 的 additionalProperties: false 对应）。
  const known = new Set(['id', 'name', 'version', 'description', 'author', 'license', 'main', 'engine', 'permissions', 'activation', 'contributes']);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) throw new Error(`plugin.json 含未知字段：${key}。`);
  }

  return {
    id,
    name,
    version,
    description: optionalString(value, 'description', 512),
    author: optionalString(value, 'author', 128),
    license: optionalString(value, 'license', 64),
    main,
    engine: { trellora: trelloraRange },
    permissions: permissions as PluginPermission[],
    activation: activation as PluginActivationEvent[],
    contributes: value.contributes as PluginManifest['contributes'],
  };
}

function requireString(value: Record<string, unknown>, key: string): string {
  const v = value[key];
  if (typeof v !== 'string') throw new Error(`plugin.json ${key} 必须是字符串。`);
  return v;
}

function optionalString(value: Record<string, unknown>, key: string, maxLen: number): string | undefined {
  const v = value[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new Error(`plugin.json ${key} 必须是字符串。`);
  if (v.length > maxLen) throw new Error(`plugin.json ${key} 长度不得超过 ${maxLen}。`);
  return v;
}

function requireArray(value: Record<string, unknown>, key: string): unknown[] {
  const v = value[key];
  if (!Array.isArray(v)) throw new Error(`plugin.json ${key} 必须是数组。`);
  return v;
}
