/**
 * Deterministic context admission logic that filters materials based on active
 * phases, selected Skills, and requested attachments without reading files or
 * executing tools.
 * 确定性上下文准入逻辑，根据活跃阶段、已选 Skill 和请求附件过滤材料，不读取文件或执行工具。
 */
import { estimateTokenCount } from '../model/tokenEstimator.ts';
import type {
  ContextAdmissionDiagnostics,
  ContextEnvelope,
  ContextMaterial,
  ContextOmission,
} from './contextRuntimeTypes.ts';

/**
 * Input specifying which phases, Skills, and attachments are currently active,
 * used to decide which deferred materials should be admitted.
 * 指定当前活跃的阶段、Skill 和附件的输入，用于决定哪些延迟材料应被准入。
 */
export interface LazyContextAdmissionInput {
  activePhases?: readonly string[];
  selectedSkillIds?: readonly string[];
  requestedAttachmentIds?: readonly string[];
}

/**
 * Result of lazy admission: a filtered envelope with only admitted materials,
 * the list of omitted materials, and admission diagnostics.
 * 混入准结果：仅包含已准入材料的过滤信封、被省略材料列表和准入诊断。
 */
export interface LazyContextAdmissionResult {
  envelope: ContextEnvelope;
  omissions: ContextOmission[];
  diagnostics: ContextAdmissionDiagnostics;
}

/**
 * Deterministic admission only; it does not read files, execute tools, or select Skills.
 * 仅执行确定性准入；不读取文件、不执行工具、不选择 Skill。
 */
export class LazyContextLoader {
  /**
   * Filters the envelope's materials by admission policy. Materials without an
   * admission gate are always admitted; gated materials are admitted only when
   * their activation condition is met.
   * 按准入策略过滤信封材料。无准入门控的材料始终准入；有门控的材料仅在激活条件满足时准入。
   *
   * @param envelope - The context envelope to filter / 需要过滤的上下文信封
   * @param input - Active phases, Skills, and attachments / 活跃阶段、Skill 和附件
   * @returns Filtered envelope, omissions, and admission diagnostics / 过滤后的信封、遗漏项和准入诊断
   */
  admit(envelope: ContextEnvelope, input: LazyContextAdmissionInput = {}): LazyContextAdmissionResult {
    const activePhases = new Set(input.activePhases ?? []);
    const selectedSkills = new Set(input.selectedSkillIds ?? []);
    const requestedAttachments = new Set(input.requestedAttachmentIds ?? []);
    const admitted: ContextMaterial[] = [];
    const omissions: ContextOmission[] = [];
    const activationReasons = new Set<string>();
    const diagnostics: ContextAdmissionDiagnostics = {
      candidateMaterials: envelope.materials.length,
      admittedMaterials: 0,
      deferredMaterials: 0,
      toolCatalogTokens: 0,
      activeToolDefinitionTokens: 0,
      skillDescriptionTokens: 0,
      selectedSkillBodyTokens: 0,
      attachmentMetadataTokens: 0,
      attachmentContentTokens: 0,
      activationReasons: [],
    };

    for (const material of envelope.materials) {
      const admission = material.admission;
      if (!admission || shouldAdmit(admission, activePhases, selectedSkills, requestedAttachments)) {
        admitted.push(copyMaterial(material));
        if (admission) {
          activationReasons.add(admission.activationReason);
          addAdmissionTokens(diagnostics, admission.kind, estimateTokenCount(material.content));
        }
        continue;
      }
      diagnostics.deferredMaterials += 1;
      omissions.push({
        materialId: material.id,
        reason: 'policy',
        estimatedTokens: estimateTokenCount(material.content),
        detail: `按需准入：${admission.kind} 尚未激活。`,
      });
    }
    diagnostics.admittedMaterials = admitted.length;
    diagnostics.activationReasons = [...activationReasons].sort();
    return { envelope: { ...envelope, materials: admitted }, omissions, diagnostics };
  }
}

// Determines whether a gated material should be admitted based on its kind and
// the current active phases, selected Skills, or requested attachments.
// 根据材料类型和当前活跃阶段、已选 Skill 或请求附件，判断有门控的材料是否应被准入。
function shouldAdmit(
  admission: NonNullable<ContextMaterial['admission']>,
  activePhases: ReadonlySet<string>,
  selectedSkills: ReadonlySet<string>,
  requestedAttachments: ReadonlySet<string>,
): boolean {
  if (admission.activeByDefault) return true;
  if (admission.kind === 'tool-definition') return Boolean(admission.phase && activePhases.has(admission.phase));
  if (admission.kind === 'skill-body') return selectedSkills.has(admission.key);
  if (admission.kind === 'attachment-content') return requestedAttachments.has(admission.key);
  return false;
}

// Accumulates admitted material token counts into the appropriate diagnostics bucket
// based on the admission kind (tool-catalog, tool-definition, skill-body, etc.).
// 根据准入类型（tool-catalog、tool-definition、skill-body 等）将已准入材料的 token 计数累加到对应的诊断桶中。
function addAdmissionTokens(diagnostics: ContextAdmissionDiagnostics, kind: NonNullable<ContextMaterial['admission']>['kind'], tokens: number): void {
  if (kind === 'tool-catalog') diagnostics.toolCatalogTokens += tokens;
  else if (kind === 'tool-definition') diagnostics.activeToolDefinitionTokens += tokens;
  else if (kind === 'skill-description') diagnostics.skillDescriptionTokens += tokens;
  else if (kind === 'skill-body') diagnostics.selectedSkillBodyTokens += tokens;
  else if (kind === 'attachment-metadata') diagnostics.attachmentMetadataTokens += tokens;
  else diagnostics.attachmentContentTokens += tokens;
}

// Deep-copies a ContextMaterial to prevent mutation of the original envelope's data.
// 深拷贝 ContextMaterial，防止修改原始信封的数据。
function copyMaterial(material: ContextMaterial): ContextMaterial {
  return {
    ...material,
    source: { ...material.source },
    ...(material.tokenBudget ? { tokenBudget: { ...material.tokenBudget } } : {}),
    ...(material.admission ? { admission: { ...material.admission } } : {}),
    ...(material.lifecycle ? { lifecycle: { ...material.lifecycle } } : {}),
    ...(material.provenance ? {
      provenance: {
        ...material.provenance,
        ...(material.provenance.turnSeqs ? { turnSeqs: [...material.provenance.turnSeqs] } : {}),
        ...(material.provenance.sourceIds ? { sourceIds: [...material.provenance.sourceIds] } : {}),
        ...(material.provenance.goalIds ? { goalIds: [...material.provenance.goalIds] } : {}),
        ...(material.provenance.requirementIds ? { requirementIds: [...material.provenance.requirementIds] } : {}),
        ...(material.provenance.evidenceIds ? { evidenceIds: [...material.provenance.evidenceIds] } : {}),
      },
    } : {}),
    cache: { ...material.cache },
  } as ContextMaterial;
}
