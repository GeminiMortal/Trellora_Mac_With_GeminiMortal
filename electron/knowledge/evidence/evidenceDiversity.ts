/**
 * MMR (Maximal Marginal Relevance) diversity selection for evidence candidates.
 * 证据候选的 MMR（最大边际相关性）多样性选择。
 */

/** MMR relevance weight λ; 1-λ is the redundancy penalty (λ=0.7 favors relevance, inspired by WeKnora). MMR 相关性权重 λ；1-λ 为冗余惩罚（借鉴 WeKnora 多样性选择，λ=0.7 偏相关性）。 */
export const MMR_LAMBDA = 0.7;
/** Text sampling cap for bigram set computation, bounding the character pair set size. 相似度计算的文本采样上限，控制二元组集合规模。 */
const MMR_TEXT_SAMPLE_CHARS = 800;

/**
 * A candidate item for MMR diversity selection.
 * MMR 多样性选择的候选条目。
 */
export interface DiversityCandidate {
  /** Stable candidate identifier; used only for assertions and debugging. 稳定的候选标识；仅用于断言与调试。 */
  key: string;
  /** Final score before MMR (input sorted descending by this value is treated as the relevance order). 进入 MMR 前的最终分（已按降序排列的输入视为相关性序）。 */
  finalScore: number;
  /** Body text used for redundancy calculation. 用于冗余度计算的正文。 */
  text: string;
}

/**
 * Outcome of a diversity selection pass.
 * 多样性选择遍历的结果。
 */
export interface DiversitySelectionOutcome<T> {
  selected: T[];
  /** Number of candidates dropped due to redundancy suppression. 因冗余被抑制而未入选的候选数。 */
  dropped: number;
}

/**
 * Compute the character bigram set from text. Chinese text uses code-point sliding window;
 * short text degenerates to a single-element set.
 * 计算文本的字符二元组集合。中文正文按 code point 滑窗，短文本退化为整串单元素。
 *
 * @param text - Input text / 输入文本
 * @returns Set of character bigrams / 字符二元组集合
 */
function bigramSet(text: string): Set<string> {
  const sample = [...text.replace(/\s+/g, '')].slice(0, MMR_TEXT_SAMPLE_CHARS);
  const grams = new Set<string>();
  if (sample.length === 0) return grams;
  if (sample.length === 1) {
    grams.add(sample[0]);
    return grams;
  }
  for (let index = 0; index < sample.length - 1; index += 1) grams.add(sample[index] + sample[index + 1]);
  return grams;
}

/**
 * Compute the Jaccard similarity coefficient between two bigram sets.
 * 计算两个二元组集合之间的 Jaccard 相似度系数。
 *
 * @param first - First set / 第一个集合
 * @param second - Second set / 第二个集合
 * @returns Jaccard similarity in [0, 1] / [0, 1] 区间的 Jaccard 相似度
 */
function jaccard(first: Set<string>, second: Set<string>): number {
  if (first.size === 0 || second.size === 0) return 0;
  let intersection = 0;
  for (const gram of first) if (second.has(gram)) intersection += 1;
  const union = first.size + second.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Greedy MMR diversity selection: mmr = λ·relevance - (1-λ)·maxJaccard(candidate, selected).
 * Input must be sorted by finalScore descending; the first item is always selected,
 * subsequent items balance relevance against redundancy.
 * Empty-text candidates incur no redundancy penalty (jaccard=0), compatible with legacy behavior.
 *
 * 贪心 MMR 多样性选择：mmr = λ·relevance - (1-λ)·maxJaccard(候选, 已选)。
 * 输入必须已按 finalScore 降序；首位直接入选，后续在相关性与冗余间权衡。
 * 空文本候选不参与冗余惩罚（jaccard=0），与旧行为兼容。
 *
 * @param candidates - Pre-sorted candidate array / 预排序的候选数组
 * @param topK - Maximum number of items to select / 最大选取数量
 * @param lambda - MMR trade-off parameter (default MMR_LAMBDA) / MMR 权衡参数（默认 MMR_LAMBDA）
 * @returns Selection outcome with selected items and drop count / 选择结果，含选中条目和丢弃计数
 */
export function selectDiverseTopK<T extends DiversityCandidate>(candidates: T[], topK: number, lambda: number = MMR_LAMBDA): DiversitySelectionOutcome<T> {
  const k = Math.max(0, Math.floor(topK));
  if (k === 0 || candidates.length === 0) return { selected: [], dropped: candidates.length };
  const ordered = [...candidates].sort((first, second) => second.finalScore - first.finalScore);
  const maximum = Math.max(...ordered.map((candidate) => candidate.finalScore), 0);
  const relevanceOf = (candidate: T): number => (maximum > 0 ? candidate.finalScore / maximum : 0);
  const grams = new Map<string, Set<string>>();
  const gramsOf = (candidate: T): Set<string> => {
    const cached = grams.get(candidate.key);
    if (cached) return cached;
    const computed = bigramSet(candidate.text);
    grams.set(candidate.key, computed);
    return computed;
  };
  const selected: T[] = [ordered[0]];
  const selectedGrams: Set<string>[] = [gramsOf(ordered[0])];
  const pool = ordered.slice(1);
  while (selected.length < k && pool.length > 0) {
    let bestIndex = 0;
    let bestMmr = Number.NEGATIVE_INFINITY;
    pool.forEach((candidate, index) => {
      const candidateGrams = gramsOf(candidate);
      let redundancy = 0;
      for (const existing of selectedGrams) redundancy = Math.max(redundancy, jaccard(candidateGrams, existing));
      const mmr = lambda * relevanceOf(candidate) - (1 - lambda) * redundancy;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIndex = index;
      }
    });
    const chosen = pool[bestIndex];
    selected.push(chosen);
    selectedGrams.push(gramsOf(chosen));
    pool.splice(bestIndex, 1);
  }
  return { selected, dropped: ordered.length - selected.length };
}
