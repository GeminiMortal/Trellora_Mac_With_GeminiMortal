/**
 * Normalization of model-written memory-save acknowledgements into neutral wording.
 * 将模型写出的记忆保存确认语句规范化为中性措辞。
 */

/**
 * Normalize common model-written save acknowledgements so only application receipts assert persistence.
 * 规范化模型常见的保存确认语句；只有应用回执才能断言记忆已持久化。
 *
 * @param answer - Raw assistant answer text / 助手原始回答文本
 * @returns Answer with save claims replaced by neutral wording / 将保存断言替换为中性措辞后的回答
 */
export function normalizeMemorySaveClaims(answer: string): string {
  // Track open/close code fences so fenced blocks are left untouched.
  // 跟踪代码围栏开合状态，围栏内的内容保持不变。
  let fence: string | undefined;
  return answer.split('\n').map(line => {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) { fence = fence ? undefined : marker[0]; return line; }
    if (fence || /^\s*>/u.test(line)) return line;
    // Examples, quoted user text and code are data, not an acknowledgement by the assistant.
    // 示例、用户引用文本和代码属于数据，不算助手的确认。
    return line.split(/(`+[^`]*`+|“[^”]*”|‘[^’]*’|「[^」]*」|"[^"]*")/gu).map((part, index) => index % 2 ? part : part
      .replace(/(?:我)?(?:已经|已)(?:成功)?(?:更新(?:了)?(?:您|你|我)?的?(?:身份背景|身份信息|身份|个人画像|用户画像|长期记忆)|(?:永久)?记住(?:了)?|保存(?:了)?(?:到|至|进)(?:您|你)?的?长期记忆)/gu,
        '本轮按你的最新陈述回答；长期记忆的保存状态以应用回执为准')
      .replace(/\bI(?:'ve| have) (?:permanently remembered|saved (?:this|that|it) (?:to|in) (?:your |my )?long[- ]term memory|updated your (?:profile|identity))\b/giu,
        'I will use your latest statement for this reply; the application receipt shows the memory save status'))
      .join('');
  }).join('\n');
}
