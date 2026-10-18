# 注释规范 / Comment Convention

## 格式 / Format

所有注释采用中英双语，英文在上，中文在下。
All comments are bilingual: English first, Chinese second.

## 模块注释 / Module Comments
```typescript
/**
 * Module: xxx
 * Provides xxx functionality for xxx.
 * 模块：xxx
 * 为 xxx 提供 xxx 功能。
 */
```

## 函数/方法注释 / Function/Method Comments
```typescript
/**
 * Brief description in English.
 * 简要中文描述。
 *
 * @param name - Description / 描述
 * @returns Description / 描述
 */
```

## 接口/类型注释 / Interface/Type Comments
```typescript
/** Description / 描述 */
export interface Foo {
  /** Field description / 字段描述 */
  bar: string;
}
```

## 复杂逻辑 / Complex Logic
```typescript
// Why this approach is used / 为什么采用这种方式
```

## 常量 / Constants
```typescript
/** Description / 描述 */
export const FOO = 123;
```
