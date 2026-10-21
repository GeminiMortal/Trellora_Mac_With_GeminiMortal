# Trellora Code Architecture and Built-in Capabilities

[简体中文](architecture.md) · **English** · [Product README](../README.en.md)

This document describes the working tree inspected on 2026-10-20. Repository-relative links lead to implementation; Mermaid diagrams render on GitHub. Current implementation takes precedence over older design assumptions. Memory changes follow the [memory domain contract](Trellora-2.0-WeKnora记忆架构严格对齐改造方案.md).

## Contents

- [Overall architecture and process boundaries](#overall-architecture-and-process-boundaries)
- [Directories and responsibilities](#directories-and-responsibilities)
- [UI and IPC](#ui-and-ipc)
- [Note editing and saving](#note-editing-and-saving)
- [Standalone documents](#standalone-documents)
- [Materials and document pipeline](#materials-and-document-pipeline)
- [Keyword semantic retrieval and vector generations](#keyword-semantic-retrieval-and-vector-generations)
- [Model gateway and AI Agents](#model-gateway-and-ai-agents)
- [History working memory and long-term memory](#history-working-memory-and-long-term-memory)
- [Wiki workspace](#wiki-workspace)
- [Schedule workspace](#schedule-workspace)
- [Terminal workspace](#terminal-workspace)
- [Materials graph and Map](#materials-graph-and-map)
- [Built-in skills and web capabilities](#built-in-skills-and-web-capabilities)
- [Data layout and recovery](#data-layout-and-recovery)
- [Themes language and onboarding](#themes-language-and-onboarding)
- [Development build and validation](#development-build-and-validation)
- [Extension and reading guide](#extension-and-reading-guide)

## Overall architecture and process boundaries

Trellora is a **local-first Electron desktop application**. Its primary target is macOS (Apple Silicon arm64); Windows x64 support has been added (platform-keyed sqlite-vec loading for darwin-arm64/windows-x64, cross-platform Python Worker and terminal detection, and a `build:win` packaging chain). React owns interaction; Electron owns filesystem/database access; Node Workers and a Python Sidecar perform isolated computation. Core operation requires no separate web backend, Redis, PostgreSQL, or external vector database.

```mermaid
flowchart TB
  subgraph Renderer["Renderer"]
    APP["Application / App / NavRail"]
    EDIT["Tiptap / CodeMirror / Markdown"]
    VIEWS["Assistant / Materials / Wiki / Map / Settings"]
    APP --> EDIT
    APP --> VIEWS
  end
  IPC["window.electronAPI<br/>preload.ts + electron.d.ts + shared"]
  subgraph Main["Electron main process"]
    LIFE["Lifecycle / Permissions / Configuration / Keys"]
    NOTE["Notes and standalone documents"]
    PIPE["PipelineOrchestrator"]
    AI["Retrieval / Model calls / Agents / Memory"]
    RESTORE["Backup / Restore / Relocation"]
  end
  subgraph Workers["Isolated computation"]
    INDEX["Note index Node Worker"]
    DOCX["Mammoth Node Worker"]
    PY["Python NDJSON Worker<br/>Structure / Chunks / Keywords / Graphs"]
  end
  FS["Markdown / Original documents / Stage JSONL"]
  DB["SQLite / FTS5 / sqlite-vec"]
  SERVICE["Configured and authorized services<br/>Ollama / Models / Vectors / Search / MinerU"]
  Renderer --> IPC --> Main
  NOTE --> FS
  NOTE --> INDEX
  PIPE --> DOCX
  PIPE --> PY
  PIPE --> FS
  PIPE --> DB
  AI --> DB
  AI --> SERVICE
  PIPE --> SERVICE
  RESTORE --> FS
  RESTORE --> DB
```

| Unit | Responsibility | Boundary |
| --- | --- | --- |
| Renderer | Status, editing, actions, diagrams, conversations | No arbitrary filesystem access, Python spawning, service keys |
| Preload | Named methods/events through `contextBridge` | No general `fs`, `spawn`, unrestricted IPC |
| Main | Files, databases, models, queues, sessions, recovery | Validates operations; UI controls do not replace access checks |
| Node Workers | DOCX parsing and note-index computation | Return results under main-process coordination |
| Python Sidecar | Lines, signals, structure, chunks, keywords, entity postprocessing, graph assembly | Authorized inputs/outputs; no application SQLite writes or original modification |
| External services | Generation, embedding, rerank, search, PDF parsing | Network/content depend on capability and consent |

[electron/main.ts](../electron/main.ts) creates windows with `nodeIntegration: false`, `contextIsolation: true`, and source-checked IPC. Worker spawning uses argument arrays with `shell: false`. These isolate permissions/responsibilities, without providing a general sandbox for arbitrary untrusted code.

## Directories and responsibilities

| Location | Responsibility |
| --- | --- |
| [main.tsx](../src/main.tsx), [Application.tsx](../src/Application.tsx) | React entry, theme, environment |
| [App.tsx](../src/App.tsx) | Workspace, navigation, library switching, current note |
| [src/components/](../src/components/) | All product views and recovery UI |
| [src/editor/](../src/editor/) | Tiptap extensions, code/math nodes, paste/input, selection coordinates |
| [src/components/wiki/](../src/components/wiki/) | State, layout, tasks, data sources |
| [src/i18n/](../src/i18n/) | Chinese keys, English mappings, language subscriptions |
| [main.ts](../electron/main.ts), [preload.ts](../electron/preload.ts) | Lifecycle, assembly, handlers, bridge |
| [electron/documents/](../electron/documents/) | Standalone sessions, codecs, queue, resources, AI, recovery |
| [electron/knowledge/](../electron/knowledge/) | Indexes, retrieval, model protocols, Agents, context, memory |
| [electron/pipeline/](../electron/pipeline/) | Stages, artifacts, vector/graph projections |
| [electron/wiki/](../electron/wiki/) | Source scopes, tools, derived nodes, AI content, import |
| [electron/schedule/](../electron/schedule/) | Schedule items, recurrence, reminders, course import |
| [electron/terminal/](../electron/terminal/) | Terminal sessions, PTY host process, shell detection |
| [electron/websearch/](../electron/websearch/) | Providers and web fetching |
| [electron/backup/](../electron/backup/) | Snapshots, archives, restore, maintenance pause |
| [shared/](../shared/) | Cross-process contracts, defaults, limits |
| [pipeline_worker/](../pipeline-python/pipeline_worker/) | NDJSON and Python stages |
| [builtin-skills/](../build/builtin-skills/) | Packaged definitions/templates |
| [scripts/](../scripts/), [verification/](verification/) | Builds, focused checks, Electron/package evidence |
| [plugins/](../plugins/), [electron/plugins/](../electron/plugins/) | Plugin SDK, manifest, examples (experimental); host, loading, tiered permissions |

Much of the assembly and IPC remains in `main.ts`/`App.tsx`; follow calls into domain modules rather than treating component names as the complete architecture.

## UI and IPC

[NavRail.tsx](../src/components/navigation/NavRail.tsx) defines the primary entries — assistant, notes, materials, Wiki, map, schedule, and terminal — plus open, libraries, and settings at the bottom; [SettingsPanel.tsx](../src/components/settings/SettingsPanel.tsx) defines eleven settings sections. See the [README](../README.en.md#menus-and-screenshots) for user-facing details.

The chain is **React → `window.electronAPI` → preload `ipcRenderer.invoke` → main handler → domain service → files/database/Worker → result/event → UI**. Types live in [electron.d.ts](../src/electron.d.ts) and `shared/`.

| Domain | Bridge examples | Main-process work |
| --- | --- | --- |
| Libraries | `listLibraries`, `createLibrary`, `activateLibrary`, `removeLibrary` | Registration, paths, availability |
| Materials | `createMaterialsLibrary`, `listMaterialsDocuments`, `importMaterialsDocuments` | Manifests, imports, scope |
| Pipeline | `startMaterialsPipeline`, `cancelMaterialsPipeline`, `getMaterialsPipelineStatus` | Queue, cancellation, actual state |
| Wiki | `getWikiDocumentOutline`, `addWikiDerivedNode`, `reorderWikiSiblingNodes` | Structure, nodes, ordering |
| Documents | `openDocumentRequest`, `updateDocumentDraft`, `saveDocument`, `joinDocumentLibrary` | Bound sessions, versions, writes |
| Schedule | `listScheduleOccurrences`, `createScheduleItem`, `scheduleImportPreviewCsv`, `revertScheduleImport` | Recurrence expansion, items/reminders, import batches |
| Terminal | `createTerminal`, `resizeTerminal`, `killTerminal`, `writeTerminal` (events `onTerminalData`/`onTerminalExit`) | PTY sessions, data relay, exit notifications |
| Settings | `getAppPreferences`, `saveAppPreferences` | Normalization/persistence |
| Onboarding | `getOnboardingState`, `saveOnboardingState`, `importOnboardingSample` | Progress, samples, practice |
| Relocation | `startWorkspaceMigration` and related methods | Preview, journal, switching |

The engineering contract's `pipeline:*` names are proposals; current channels include `start-materials-pipeline`. Integrate against actual bridge/type definitions.

## Note editing and saving

### Editors and Markdown

[Editor.tsx](../src/components/editor/Editor.tsx) integrates Tiptap/ProseMirror; CodeMirror handles source mode; [MarkdownPreview.tsx](../src/components/markdown/MarkdownPreview.tsx) handles preview. Parsing/rendering includes [markdown.ts](../src/utils/markdown/markdown.ts), [preview.ts](../src/utils/ui/preview.ts), [MarkdownContent.tsx](../src/components/markdown/MarkdownContent.tsx).

Built-in content includes headings, lists, tasks, tables, images, links, code, math, Mermaid, Wiki links. Extensions handle code/formulas/Markdown input/paste; DOMPurify sanitizes output. Mode switching converts between Markdown and the editor model; fidelity requires the dedicated checks.

[EditorWordCount.tsx](../src/components/editor/EditorWordCount.tsx) displays counts, [EditorZoomControl.tsx](../src/components/editor/EditorZoomControl.tsx) controls zoom, [editorPreferences.ts](../shared/editorPreferences.ts) centralizes typography, spacing, paste, selection, writing modes.

### Durable writes and projections

```mermaid
sequenceDiagram
  participant U as User
  participant E as Editor / App
  participant P as Preload
  participant S as Main save service
  participant F as Markdown file
  participant I as Index / Backup
  U->>E: Edit
  E->>E: Track draft and revision
  E->>P: Autosave or explicit save
  P->>S: Path, version, content
  S->>S: Validate path, disk, request
  S->>F: Atomic text write
  F-->>S: Result
  S-->>P: Receipt
  P-->>E: Save status
  S->>I: Projection and backup maintenance
```

[noteSaveService.ts](../electron/note/noteSaveService.ts), [atomicTextWrite.ts](../electron/atomicTextWrite.ts), [noteCloseCoordinator.ts](../electron/note/noteCloseCoordinator.ts) coordinate saving/closing/recovery; [noteBackups.ts](../electron/note/noteBackups.ts) maintains backups; [noteIndex.ts](../electron/note/noteIndex.ts) and [indexCoordinator.ts](../electron/knowledge/index/indexCoordinator.ts) update indexes.

A durable write and successful indexing are separate outcomes. An index error must not imply the original was unsaved. Switching, delayed saves, external changes, closing require revision/draft coordination so late results cannot overwrite newer content.

### Selection AI

[SelectionActionOverlay.tsx](../src/components/selection/SelectionActionOverlay.tsx) calls [selectionEditCoordinator.ts](../electron/knowledge/selection/selectionEditCoordinator.ts) and [selectionExpansionCoordinator.ts](../electron/knowledge/selection/selectionExpansionCoordinator.ts). Permitted note/material/web evidence supports proposals; application validates the current document/selection.

[selectionExpansionPolicy.ts](../shared/selectionExpansionPolicy.ts) sets default target `1.8×` meaningful characters, full-note threshold `12,000`, target ceiling `40,000`. Targets are not model-output guarantees; quality/range checks remain necessary.

## Standalone documents

[ExternalDocumentWorkspace.tsx](../src/components/externalDocument/ExternalDocumentWorkspace.tsx) uses [DocumentSessionService](../electron/documents/documentSessionService.ts), separately from library saving. Registered library files route back to Notes.

| Module | Capability |
| --- | --- |
| [openRequestRouter.ts](../electron/documents/openRequestRouter.ts) | Picker, arguments, drops, queue |
| [textCodec.ts](../electron/documents/textCodec.ts) | Encoding, BOM, newline, decoding |
| [documentSessionService.ts](../electron/documents/documentSessionService.ts) | Bound sessions, disk versions, drafts, save/as, refresh, close, join |
| [externalRecoveryStore.ts](../electron/documents/externalRecoveryStore.ts) | Unsaved drafts/recovery |
| [documentResourceService.ts](../electron/documents/documentResourceService.ts) | Authorized roots, images, manifests, copies |
| [documentAiService.ts](../electron/documents/documentAiService.ts) | AI, cancellation, revision-checked apply |

Drafts save automatically; originals save explicitly. Writes check disk hashes, revisions, paths; restoring drafts does not directly overwrite disk. Joining copies content/permitted assets. Protected application data, backups, materials originals cannot bypass dedicated workflows through this editor.

## Materials and document pipeline

### Registration

[materialsLibrary.ts](../electron/library/materialsLibrary.ts) handles registrations, manifests, IDs, types, hashes; [MaterialsView.tsx](../src/components/materials/MaterialsView.tsx) lists/previews; [MaterialsPipelineView.tsx](../src/components/pipeline/MaterialsPipelineView.tsx) exposes config/status/artifacts. Stages read originals and write separate artifacts; SQLite stores projections, not all large stage files.

### Stages

```mermaid
flowchart LR
  SOURCE["Original"] --> ROUTE{"Type"}
  ROUTE -->|Text| DIRECT["Electron parser"]
  ROUTE -->|DOCX| MAM["Mammoth Worker"]
  ROUTE -->|PDF| MINER["MinerU cloud<br/>Upload consent"]
  DIRECT --> PARSE["01 parse"]
  MAM --> PARSE
  MINER --> PARSE
  PARSE --> LINES["02 lines"] --> SIGNALS["03 signals"]
  SIGNALS --> AMB["04 ambiguity<br/>Optional LLM"] --> TREE["05 tree"]
  TREE --> CHUNKS["06 chunks"] --> KW["07 keywords"]
  KW --> VEC["08 vectors<br/>Embedding"] --> ENT["09 entities<br/>Optional enrichment"]
  KW --> FTS["FTS5 projection"]
  VEC --> VDB["sqlite-vec projection"]
  ENT --> GRAPH["Library graph"]
```

This is execution order/major outputs, not a claim that each stage reads only its preceding directory. Disabled/unconfigured optional capabilities skip or wait.

| Stage | Execution | Content |
| --- | --- | --- |
| `parse` | Electron/Mammoth/MinerU | Markdown, blocks, line layout, report |
| `lines` | Python | Logical lines |
| `signals` | Python | Structural rules/signals |
| `ambiguity` | Electron LLM coordination | Configured ambiguity handling; rule fallback |
| `tree` | Python | Chapter/body tree |
| `chunks` | Python and controlled Electron LLM | Parent/child structure, recursive, fixed, semantic, LLM strategies |
| `keywords` | Python → Electron | Jieba, keywords, FTS projection |
| `vectors` | Electron | Bound embeddings/chunk vectors |
| `entities` | Electron LLM + Python | Optional entities/relationships, graph inputs |
| Library `graph` | Python → Electron | Assembly/Leiden/projection; outside document stage enum |

[PipelineOrchestrator](../electron/pipeline/pipelineOrchestrator.ts) owns queues, active jobs, cancel/retry, startup recovery, maintenance pause, graph rebuilds. [routes.ts](../electron/pipeline/routes.ts) selects parsing; [mammothStage.ts](../electron/pipeline/mammothStage.ts)/[mammothWorker.ts](../electron/pipeline/mammothWorker.ts) handle DOCX.

### Worker protocol

[pythonWorkerClient.ts](../electron/pipeline/pythonWorkerClient.ts) centralizes spawning. Development prefers `.venv/bin/python -m pipeline_worker`; packaged execution uses `resources/pipeline-runtime/python-worker -E -m pipeline_worker`. Hello validates protocol, engine, capabilities.

```json
{"id":"request-1","method":"hello","params":{"protocolVersion":1}}
{"id":"request-2","method":"runStage","params":{"jobId":"job-1","stage":"lines","inputPath":"...","outputDir":"...","options":{}}}
{"id":"request-3","method":"cancel","params":{"jobId":"job-1"}}
{"id":"request-4","method":"shutdown","params":{}}
```

Stdout is NDJSON, stderr is logs. IDs/jobs/stages associate results. [worker.py](../pipeline-python/pipeline_worker/worker.py) dispatches stages/search tokenization. Electron results include `artifactManifest` and counts. Graceful shutdown has bounded waiting; clients/orchestration manage cancel, limits, timeout, failure recovery.

Current generic `runStage` timeout is **6 hours**; tokenization **15 seconds**, cancel **10 seconds**, hello **15 seconds**. Do not interpret the timeout requirement as a universally short timeout. LLM stages have separate budgets/timeouts.

### Artifacts and state

[pathLayout.ts](../electron/pipeline/pathLayout.ts) defines actual layout:

```text
<materials-library>/.menghan-meta/pipeline/
  <documentId>/<sourceContentHash>/<pipelineFingerprint>/
    00-source/source.json
    01-parse/
    02-lines/
    03-signals/
    04-ambiguity/
    05-tree/
    06-chunks/
    07-keywords/
    08-vectors/
    09-entities/
    checkpoints/
    pipeline-manifest.json
```

Keys include source, config, engine/protocol, upstream versions. [artifactStore.ts](../electron/pipeline/artifactStore.ts) validates/commits temporary artifacts. Changed sources/config invalidate relevant projections.

[types.ts](../electron/pipeline/types.ts) defines `IDLE`, `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED_RETRYABLE`, `FAILED`, `WAITING_CONFIG`, `SKIPPED`, `CANCELLED`, `INTERRUPTED`. UI reads main state; FTS status comes from actual SQLite projection, not only stage files.

## Keyword semantic retrieval and vector generations

| Entry | Implementation/purpose |
| --- | --- |
| Note keyword search | MiniSearch/local note index; model-free titles/paths/text |
| Current-note tools | [currentNoteTools.ts](../electron/knowledge/currentNote/currentNoteTools.ts), [currentNoteLexicalIndex.ts](../electron/knowledge/currentNote/currentNoteLexicalIndex.ts); saved snapshots/sections |
| Note knowledge | [indexCoordinator.ts](../electron/knowledge/index/indexCoordinator.ts), [metaDatabase.ts](../electron/knowledge/index/metaDatabase.ts); chunks, metadata, vectors |
| Materials hybrid | [materialChunkSearch.ts](../electron/pipeline/materialChunkSearch.ts); FTS/lexical and vectors, configured combination/rerank |
| Graph | Entities/communities traced to source chunks |
| History/memory | Separate data/scopes/limits, not interchangeable document evidence |

Materials use **child matches with parent context**. Missing/stale/failing indexes require independent capability decisions. No guarantee exists that every question has evidence; citations must use actual results.

[materialEmbeddingProfile.ts](../electron/pipeline/materialEmbeddingProfile.ts) binds profiles; [materialEmbeddingAdapters.ts](../electron/pipeline/materialEmbeddingAdapters.ts) makes calls; [materialVectorCoordinator.ts](../electron/pipeline/materialVectorCoordinator.ts) coordinates tasks. Vector identity depends on model, endpoint, parameters, preprocessing—not only dimension. Queries must match the indexed profile.

```mermaid
flowchart LR
  A["Active A"] --> B["Build B with new profile"]
  B --> CHECK{"Validate identity/integrity"}
  CHECK -->|Pass| ACTIVE["Activate B; retain A"]
  CHECK -->|Fail or interrupted| KEEP["Keep A / Recover"]
  ACTIVE --> ROLLBACK["Optional rollback to A"]
```

See [materialVectorGenerationService.ts](../electron/pipeline/materialVectorGenerationService.ts), [materialVectorGenerationStore.ts](../electron/pipeline/materialVectorGenerationStore.ts), [materialVectorGenerations.ts](../shared/materialVectorGenerations.ts). This mechanism applies to materials vectors, not automatically every store.

## Model gateway and AI Agents

### Model adapters

[aiProvider.ts](../electron/knowledge/ai/aiProvider.ts), [modelHub.ts](../electron/knowledge/ai/modelHub.ts), [modelConfigurationService.ts](../electron/knowledge/ai/modelConfigurationService.ts) manage profiles, selection, persistence, impacts. Provider, endpoint, protocol, model are separate fields.

| Protocol | Transport |
| --- | --- |
| Ollama Chat | [ollamaClient.ts](../electron/knowledge/ai/ollamaClient.ts) |
| OpenAI Chat Completions | [openAiCompletionsTransport.ts](../electron/knowledge/ai/openAiCompletionsTransport.ts) |
| OpenAI Responses | [openAiResponsesTransport.ts](../electron/knowledge/ai/openAiResponsesTransport.ts) |
| Anthropic Messages | [anthropicMessagesTransport.ts](../electron/knowledge/ai/anthropicMessagesTransport.ts) |
| Google GenerateContent | [googleGenerateContentTransport.ts](../electron/knowledge/ai/googleGenerateContentTransport.ts) |

[aiGenerationTransport.ts](../electron/knowledge/ai/aiGenerationTransport.ts) handles requests/streaming. Generation, embedding, rerank are separate. Provider integration does not imply every model supports tools, images, or thinking. Capabilities and [modelCallCoordinator.ts](../electron/knowledge/ai/modelCallCoordinator.ts) govern context/output budgets.

### Three routes

- **Open chat:** Question, attachments, applicable history; optional web tools through [chatWebAgentTurn.ts](../electron/knowledge/agent/chatWebAgentTurn.ts).
- **Current note:** Saved snapshots/body/chapters/neighbors; direct and tool routes including [currentNoteAgentGraph.ts](../electron/knowledge/currentNote/currentNoteAgentGraph.ts).
- **Knowledge base:** Selected materials library, retrieval/source reading/graph/applicable web tools through [knowledgeAgentTurn.ts](../electron/knowledge/agent/knowledgeAgentTurn.ts).

### Tool execution

```mermaid
flowchart TB
  Q["Question + Scope + Session"] --> CONTEXT["Context/budget preparation"]
  CONTEXT --> MODEL["Model call"]
  MODEL --> DECIDE{"Tools or answer"}
  DECIDE -->|Tools| VALIDATE["Arguments, capability, scope, budget checks"]
  VALIDATE --> TOOL["Registered tool execution"]
  TOOL --> EVIDENCE["Archive sources; limit visible observations"]
  EVIDENCE --> MODEL
  DECIDE -->|Answer| FINAL["Answer policy, citations, streaming"]
  FINAL --> SAVE["Persist outcome/history/memory sources"]
  MODEL -->|Cancel or exhausted| STOP["Terminate with actual status"]
```

[reactEngine.ts](../electron/knowledge/reactAgent/reactEngine.ts) implements budgeted ReAct; [toolRegistry.ts](../electron/knowledge/reactAgent/toolRegistry.ts) handles registration/signatures. Counters track rounds, model/tool calls, maintenance, stop reasons; duplicate actions are constrained.

Several execution models coexist; a `Graph` filename does not itself imply LangGraph:

| Entry | Implementation | Built-in tasks |
| --- | --- | --- |
| [agentGraph.ts](../electron/knowledge/agent/agentGraph.ts) | LangGraph `Annotation`/`StateGraph`, supervisor dispatch | Summaries, tags, note analysis, answers, learning plans, organization proposals |
| [currentNoteAgentGraph.ts](../electron/knowledge/currentNote/currentNoteAgentGraph.ts) | Custom plans/actions/evidence/budget control | Chapter search, selective reading, evidence synthesis, answers |
| [libraryPlanAgentGraph.ts](../electron/knowledge/library/libraryPlanAgentGraph.ts) | Custom library snapshots/structured actions/plans | Note-library lookup, section reading, organization reasoning |
| [reactEngine.ts](../electron/knowledge/reactAgent/reactEngine.ts) | Bounded ReAct with route-supplied tools/policies | Materials questions, applicable web/Wiki tools |

ReAct defaults are **6 iterations, 8 model calls, 10 tool calls, 1 empty-response retry**, and **2 repeated-content rounds** before a break. Callers can override them; maintenance summaries have additional budgets. See [reactEngineTypes.ts](../electron/knowledge/reactAgent/reactEngineTypes.ts). These constrain execution rather than guarantee answer accuracy.

Knowledge tools include `knowledge_search`, `grep_chunks`, `list_knowledge_chunks`, `get_document_info`, `graph_local_search`, `graph_global_search`, `web_search`, web fetching, `read_skill`, `search_conversations`, `search_memory`. Availability follows [toolCapabilityCatalog.ts](../electron/knowledge/model/toolCapabilityCatalog.ts), scope, capabilities, configuration.

[assistantCitationGuard.ts](../electron/knowledge/assistant/assistantCitationGuard.ts) constrains citations; [assistantNote.ts](../electron/assistant/assistantNote.ts) saves answers as notes. Tool names proposed by models do not grant arbitrary filesystem/cross-library access; contexts and services enforce scope.

## History working memory and long-term memory

### Separate responsibilities

```mermaid
flowchart TB
  TURN["User message and actual result"] --> HISTORY["History: turns/status"]
  HISTORY --> WORK["Working memory: context/summaries"]
  HISTORY --> SEARCH["Conversation search"]
  TURN --> EXTRACT["Manual / Explicit / Optional extraction"]
  EXTRACT --> LONG["Long-term facts/preferences/tasks"]
  LONG --> RECALL["Resident/situational recall"]
  WORK --> CALL["Current model context"]
  SEARCH --> CALL
  RECALL --> CALL
  DOC["Current document evidence"] --> CALL
```

| Capability | Responsibility | Source |
| --- | --- | --- |
| History | Sessions/messages/turns/tools/complete or aborted status | [qaMemoryDatabase.ts](../electron/knowledge/qa/qaMemoryDatabase.ts), [qaMemoryRepository.ts](../electron/knowledge/qa/qaMemoryRepository.ts) |
| Working memory | Recent history, summaries, observations within a model window | [qaMemoryOrchestrator.ts](../electron/knowledge/qa/qaMemoryOrchestrator.ts), [qaCanonicalHistory.ts](../electron/knowledge/qa/qaCanonicalHistory.ts), [toolResultBudget.ts](../electron/knowledge/reactAgent/toolResultBudget.ts) |
| Conversation search | Relevant earlier Q&A with scopes/limits | [searchConversationsTool.ts](../electron/knowledge/knowledgeTools/searchConversationsTool.ts) |
| Long-term memory | Independent profile/preference/fact/task/interest items | [memory/](../electron/knowledge/memory/), [searchMemoryTool.ts](../electron/knowledge/knowledgeTools/searchMemoryTool.ts) |

The unified workspace database is `ConversationMemory/qa-memory.db`, schema **11**. Legacy library conversations/compatibility repositories remain; the new store does not authorize deleting old data or prove all legacy stores disappeared.

### Writes and review

Memory defaults to disabled, write mode `explicit_only`. Enabled memory supports manual and explicit remember actions; extraction requires `auto`. Kinds: `profile`, `preference`, `fact`, `task`, `interest`. Origins: `explicit`, `extracted`, `manual`. States: `active`, `pending`, `superseded`, `archived`.

[MemoryExplicitSaveService](../electron/knowledge/memory/memoryExplicitSaveService.ts) handles explicit writes. [memoryExtractionScheduler.ts](../electron/knowledge/memory/memoryExtractionScheduler.ts)/[memoryExtractionService.ts](../electron/knowledge/memory/memoryExtractionService.ts) extract asynchronously; [memoryConsolidationService.ts](../electron/knowledge/memory/memoryConsolidationService.ts) organizes items.

[memoryWritePolicy.ts](../electron/knowledge/memory/memoryWritePolicy.ts) includes proposals/protection. Changes needing review do not overwrite protected items merely because a model proposed them. [MemoryProposalReviewDialog.tsx](../src/components/settings/MemoryProposalReviewDialog.tsx) shows reviews. Receipts distinguish saved/pending/failed; a model's claim is not proof of persistence.

### Recall, sources, isolation

[memoryRecallService.ts](../electron/knowledge/memory/memoryRecallService.ts) performs resident/situational recall; [memoryConditioningService.ts](../electron/knowledge/memory/memoryConditioningService.ts) applies bounded retrieval adjustments; [memoryPrompt.ts](../electron/knowledge/memory/memoryPrompt.ts) renders memory blocks. These guide style/preferences without replacing document evidence or granting additional tool access.

[memoryCitations.ts](../shared/memoryCitations.ts) retains item/source-conversation identities. Deleted sources and failures need truthful state. Scopes distinguish chat/knowledge/current-note/user/workspace; shared storage does not establish isolation—repository queries/tool contexts must enforce it.

### Contracts and runtime

[memoryConstants.ts](../electron/knowledge/memory/memoryConstants.ts) centralizes numbers:

| Item | Default / limit |
| --- | --- |
| Memory | Disabled; `explicit_only`; 200 items |
| Extraction | 90-second delay; 300-second minimum interval |
| Item | 300 Unicode code points; importance 1–5 |
| Conversation search | Default 5/max 8; question/answer previews 400 code points each |
| Situational recall | Up to 5 items; situational block 600, resident block 900 code points |
| Summary | Trigger above 50%; target 30%; atomic pruning above 80% |
| Tool result | 20% of window, bounded to 8,192–32,768 tokens |

Effective behavior depends on model window, route, mode. The `200,000`-token fallback does not imply every model has that capacity.

[assistantReleaseDefaults.ts](../shared/assistantReleaseDefaults.ts) sets memory projection to `canonical` across four inherited routes; unified/adaptive context modes remain `observe`. **Canonical memory cutover and enforced context budgeting are separate states.** Do not claim universal `enforce`. Engineering modes are centrally normalized rather than ordinary user switches.

## Wiki workspace

[wikiOutline.ts](../electron/wiki/wikiOutline.ts) reads materials structure/source blocks/line layout; [wikiLayout.ts](../src/components/wiki/data/wikiLayout.ts) lays out nodes; [WikiMapCanvas.tsx](../src/components/wiki/WikiMapCanvas.tsx) uses React Flow.

```mermaid
flowchart LR
  PARSE["Parse artifacts"] --> TREE["Structure tree"] --> OUTLINE["WikiDocumentOutline"]
  OUTLINE --> MAP["Outline/canvas"]
  OUTLINE --> SCOPE["Node/Subtree/Document scope"]
  SCOPE --> AGENT["Wiki Agent/tools"]
  AGENT --> DERIVED["Derived nodes/AI content"]
  DERIVED --> MAP
  PARSE --> IMPORT["Copy into note library"]
```

| Capability | Source |
| --- | --- |
| Outline/select/collapse/zoom/order | [WikiView.tsx](../src/components/wiki/WikiView.tsx), [wikiViewState.ts](../src/components/wiki/data/wikiViewState.ts), [wikiElectronDataSource.ts](../src/components/wiki/data/wikiElectronDataSource.ts) |
| Guided/automatic/full generation/node analysis/retries | UI/data-source tasks/events |
| Node/cross-chapter scope | [wikiNodeScope.ts](../electron/wiki/wikiNodeScope.ts), [wikiScopePolicy.ts](../electron/wiki/wikiScopePolicy.ts) |
| Rewrite/retrieval/source sufficiency | [wikiQueryRewrite.ts](../electron/wiki/wikiQueryRewrite.ts), [wikiRetrievalCycle.ts](../electron/wiki/wikiRetrievalCycle.ts), [wikiDirectEvidenceGate.ts](../electron/wiki/wikiDirectEvidenceGate.ts) |
| Analysis | [wikiNodeAgentTurn.ts](../electron/wiki/wikiNodeAgentTurn.ts), [wikiTools/](../electron/wiki/wikiTools/) |
| Derived/AI content | [wikiDerivedNodes.ts](../electron/wiki/wikiDerivedNodes.ts), [wikiAiMemories.ts](../electron/wiki/wikiAiMemories.ts) |
| Note import | [wikiNoteImport.ts](../electron/wiki/wikiNoteImport.ts), copies Markdown/supported images |

Source/derived nodes are distinguished. Generated content persists under `.menghan-meta/wiki/` with hashes to detect stale sources. Wiki AI content is document learning output, separate from workspace long-term memory. Structure browsing requires no model; generation does. Source/generated output remain separate.

## Schedule workspace

The schedule stores events, todos, and course timetables in a calendar scoped to the workspace. [ScheduleView.tsx](../src/components/schedule/ScheduleView.tsx) provides year/month/week/day views, event/todo creation, categories and colors, jump-to-today, and navigation; [ScheduleSidebar.tsx](../src/components/schedule/ScheduleSidebar.tsx) and the todo panel sit alongside.

The data contract lives in [shared/schedule.ts](../shared/schedule.ts): item kinds are `event`, `todo`, and `course`; recurrence supports daily/weekly/monthly and odd/even-week patterns (`weekly_pattern`) with intervals, weekday sets, end dates, and excluded dates. Expansion happens in [scheduleRecurrence.ts](../electron/schedule/scheduleRecurrence.ts); per-occurrence edits are stored as overrides instead of rewriting the item.

| Module | Responsibility |
| --- | --- |
| [scheduleService.ts](../electron/schedule/scheduleService.ts) | Item/reminder CRUD, recurrence expansion, overrides |
| [scheduleDatabase.ts](../electron/schedule/scheduleDatabase.ts) | Workspace `.menghan-meta/schedule/schedule.db` (SQLite, WAL) |
| [scheduleReminderService.ts](../electron/schedule/scheduleReminderService.ts) | Reminder scheduling, system notifications, power-event recovery |
| [import/](../electron/schedule/import/) | CSV/Excel course parsing (GBK fallback) and AI-assisted import (image/URL/text; needs a model) |

Course imports are recorded in batches and can be reverted as a whole (`schedule:revert-import`). AI parsing runs only when the user explicitly picks that source; local CSV/Excel parsing needs no model. Schedule data belongs to the workspace and is covered by full workspace backups.

## Terminal workspace

The terminal embeds an interactive shell inside the app. [TerminalView.tsx](../src/components/terminal/TerminalView.tsx) is the full multi-tab view in the main navigation; `Ctrl+\`` toggles the bottom [TerminalPanel.tsx](../src/components/terminal/TerminalPanel.tsx) from any view. Both share the same sessions, held at the app root by [useTerminalSessions.tsx](../src/components/terminal/useTerminalSessions.tsx), so switching views does not kill processes.

```text
Renderer (@xterm/xterm)
    ⇅ preload terminal:* channels
TerminalService (Electron main)
    ⇅ fork + NDJSON messages
TerminalHost (separate Node process, node-pty)
    ⇅ PTY
user-selected shell
```

[terminalService.ts](../electron/terminal/terminalService.ts) lazily starts and reuses a single [terminalHost.ts](../electron/terminal/terminalHost.ts) child process; the host creates PTY sessions with `node-pty` and fixes the double-unpacked `app.asar.unpacked` helperPath bug in packaged builds. Shell selection is platform-keyed: macOS tries `$SHELL`, `/bin/zsh`, `/bin/bash` in order; Windows offers PowerShell, CMD, Git Bash, and WSL when present. `terminal:write` uses a direct `ipcMain.on` path so keystrokes bypass the maintenance barrier; every other channel still requires the internal-renderer origin. Sessions are cleaned up on app exit without leaving background processes.

## Materials graph and Map

Optional enrichment extracts entities/relationships, assembles graphs in Python, runs Leiden, and projects results into SQLite.

```mermaid
flowchart TB
  C["Source chunks"] --> E["Optional LLM entities/relationships"]
  E --> P["Python normalization/assembly"]
  P --> L["Leiden communities"]
  P --> PROJ["SQLite graph projection"]
  L --> PROJ
  PROJ --> MAP["Community/Entity Map"]
  PROJ --> LOCAL["Local entity retrieval"]
  L --> SUMMARY["Optional summaries"]
  SUMMARY --> GLOBAL["Global retrieval"]
  LOCAL --> RAW["Original evidence"]
  GLOBAL --> RAW
```

See [entities_stage.py](../pipeline-python/pipeline_worker/entities_stage.py), [graph_stage.py](../pipeline-python/pipeline_worker/graph_stage.py), [graph_leiden.py](../pipeline-python/pipeline_worker/graph_leiden.py), [libraryGraphStore.ts](../electron/pipeline/libraryGraphStore.ts), [graphProjection.ts](../electron/pipeline/graphProjection.ts), [graphVectorIndex.ts](../electron/pipeline/graphVectorIndex.ts), [communitySummaries.ts](../electron/pipeline/communitySummaries.ts).

`graphKey` includes entity-stage keys, Leiden config, schema, related inputs; artifacts use `.menghan-meta/graph/<graphKey>/`. Defaults: resolution `1.0`, maxDepth `4`, minSplitSize `3`, seed `42`.

[LibraryGraphView.tsx](../src/components/library/LibraryGraphView.tsx) renders Map; [graphLocalSearch.ts](../electron/pipeline/graphLocalSearch.ts)/[graphGlobalSearch.ts](../electron/pipeline/graphGlobalSearch.ts) retrieve. Summaries support broad understanding, not original citations. Missing projections return capability feedback and ordinary search alternatives.

Development `graphify-out/` is separate: Graphify assists source navigation, without participating in product runtime or user-material processing.

## Built-in skills and web capabilities

### Packaged skills

| Directory | Purpose |
| --- | --- |
| [builtin-knowledge](../build/builtin-skills/builtin-knowledge/SKILL.md) | Evidence-based questions within selected notes, with gaps |
| [builtin-learning](../build/builtin-skills/builtin-learning/SKILL.md) | Progressive learning plans from goals/existing notes |
| [builtin-organize](../build/builtin-skills/builtin-organize/SKILL.md) | Conservative organization proposals with explicit scope |
| [generate-study-doc](../build/builtin-skills/generate-study-doc/SKILL.md) | Read specified documents and use study templates |
| [generate-experiment-report](../build/builtin-skills/generate-experiment-report/SKILL.md) | Reports grounded in recorded experiments/data, marking gaps |

[assistantSkills.ts](../electron/knowledge/assistant/assistantSkills.ts), [skillDirectoryLoader.ts](../electron/knowledge/skill/skillDirectoryLoader.ts), [skillDefinitionResolver.ts](../electron/knowledge/skill/skillDefinitionResolver.ts), [skillImportService.ts](../electron/knowledge/skill/skillImportService.ts) load/resolve/import; [readSkillTool.ts](../electron/knowledge/knowledgeTools/readSkillTool.ts) reads resources.

[aiSkillWorkspace.ts](../electron/knowledge/skill/aiSkillWorkspace.ts) synchronizes workspace `AI-Skill/`. Definitions structure prompts/templates; registration/scope still enforce authority. Skills are not arbitrary code plugins or local-shell authorization.

### Web integration

[webSearchProviders.ts](../electron/websearch/webSearchProviders.ts) registers Zhipu, DuckDuckGo, SearXNG, Tavily, Baidu, with provider configuration/credential checks. Search/fetch tools report missing capabilities. Links use an embedded view or system browser; external pages have a separate preload without the main file bridge. Web/local evidence retains separate source identity.

## Data layout and recovery

```text
<workspace>/
  .menghan-workspace/          Management data
  knowledge-base/             Workspace-owned materials
  ConversationMemory/
    qa-memory.db              History, memory, related metadata
  AI-Skill/                   Managed skills
  .menghan-meta/
    schedule/                 Schedule database (schedule.db: events, todos, courses, reminders)

<note-library>/
  *.md / folders / assets     User files
  .menghan-meta/
    index.db                  Knowledge index/metadata
    wiki/                     Applicable Wiki artifacts
  .menghan-backups/            Note backups

<materials-library>/
  documents/                  New-library originals
  .menghan-meta/
    pipeline/                 Stages
    graph/                    Library graphs
    ...                       Manifests/indexes/config

<Electron userData>/
  config.json                 Settings/registrations; encrypted key fields
  external-documents/         Recovery drafts/private resources
  logs/                       Diagnostics
```

Exact/legacy files follow creation modules. External libraries may be outside the workspace; backup does not automatically include arbitrary disk files. Historical names remain compatible.

### Backup/restore

`noteBackups.ts` manages note backups. [workspaceBackupService.ts](../electron/backup/workspaceBackupService.ts)/[snapshot.ts](../electron/backup/snapshot.ts) create complete snapshots; [archive.ts](../electron/backup/archive.ts) archives; [workspaceRestoreService.ts](../electron/backup/workspaceRestoreService.ts)/[physicalRestore.ts](../electron/backup/physicalRestore.ts) restore.

Backups include mappings, hashes, consistent snapshots, selected associated libraries. [maintenance.ts](../electron/backup/maintenance.ts)/[restorePause.ts](../electron/backup/restorePause.ts) pause competing work. Keys are not exported as portable plaintext.

### Relocation

[workspaceMigrationService.ts](../electron/workspace/workspaceMigrationService.ts)/[workspaceMigrationWorker.ts](../electron/workspace/workspaceMigrationWorker.ts) relocate workspace-owned data. [WorkspaceMigrationDialog.tsx](../src/components/settings/WorkspaceMigrationDialog.tsx) blocks unrelated actions and shows recovery choices.

Preview precedes copy/map; validation precedes publication/UI refresh. Originals stay; external libraries keep locations. Journals allow resume or retaining the original root; [dataRootLocks.ts](../electron/dataRootLocks.ts) handles ownership. Updating only a configured path would omit drafts, sessions, attachments, skills, associations.

## Themes language and onboarding

- **Themes:** [lightColorSchemes.ts](../shared/lightColorSchemes.ts), [theme.ts](../src/utils/ui/theme.ts), `Application.tsx` manage five palettes, system/light/dark, density, persistence, shared startup appearance.
- **Language:** [i18n/index.ts](../src/i18n/index.ts) implements subscribed `t()`/`useI18n()`, Chinese keys/English mapping, fallback text. It does not translate user documents or recreate editors.
- **Onboarding:** [OnboardingGuide.tsx](../src/components/onboarding/OnboardingGuide.tsx)/[electron/onboarding/](../electron/onboarding/) implement menus → AI → first question, states `pending`/`skipped`/`completed`. Existing models permit direct practice; connection and real-answer completion are separate.
- **Diagnostics:** [CapabilityPanel.tsx](../src/components/settings/CapabilityPanel.tsx), settings/logs distinguish configured, connected, actual-call, packaged acceptance.

## Development build and validation

### Development

[package.json](../package.json) defines Vite/Electron dev and esbuild entries for main/preload, index, Mammoth, migration, PDF Workers.

```powershell
pnpm install
pnpm run rebuild:native
pnpm dev
```

`better-sqlite3` must match Electron ABI; system Node loading does not prove compatibility. Native-store checks use the provided Electron Node launchers. Python `.venv` and release `.deps` serve separate purposes.

### Packaging

```bash
python3 -m pip install -r pipeline-python/requirements.txt --target pipeline-python/.deps
pnpm build
pnpm run release:manifest
```

[build-pipeline-runtime.mjs](../scripts/build/build-pipeline-runtime.mjs) assembles CPython/stdlib/Worker/Jieba/graph dependencies, validates hello, writes manifest. It requires a CPython installation, not just a venv, and accepts `MENGHAN_PIPELINE_PYTHON`.

electron-builder carries runtime/skills via `extraResources`, native SQLite/sqlite-vec and applicable Workers via `asarUnpack`. [build-mac-packages.mjs](../scripts/build/build-mac-packages.mjs) creates DMG/ZIP; Mac uses `icon.icns` as the app icon. Actual manifests establish signing status.

| Validation | Commands/evidence | Establishes |
| --- | --- | --- |
| Static | `pnpm exec tsc -b`, `pnpm lint` | Types/rules/basic contracts |
| Focused | `verify:markdown`, `verify:ai-provider`, `verify:wiki-workspace`, etc. | Fixture behavior/boundaries |
| Python | `.venv/bin/python -m unittest discover -s pipeline-python/tests -v` | Stage algorithms/protocol |
| Electron | `verify:*electron`, `docs/verification/` | Main/preload/UI/event/file interaction |
| Real services | Applicable `--real`/real-model scripts | Specified configuration/route calls |
| Packaged/clean macOS | Distribution/Open With records | Runtime/native dependencies/install/launch/associations |

The self-captured demo screenshots used an isolated current-source Electron build, local Markdown pipeline, and all eight menus. That capture session did not exercise remote models, MinerU, graph enrichment, or clean-machine acceptance. The README also includes actual-use screenshots supplied by the user; [showcase assets](assets/README.md) records the two groups separately. Screenshots do not prove every feature end to end.

## Extension and reading guide

| Extension | Entry points | Contract |
| --- | --- | --- |
| UI/IPC | Component → preload → types/shared → main | Named methods, origin checks, real status |
| Model | Profiles/hub/transport/capabilities | No renderer keys; protocol/model distinction |
| Search | Websearch adapters/registry | Config, credentials, attribution |
| Stage | Orchestrator/types/keys/Worker/artifacts | No source modification/Python application DB writes |
| Agent tool | Registry/catalog/scoped context | Arguments, scope, budget, cancel, evidence |
| Skill | Definitions/templates/loader/scope | No authority expansion |
| Memory | Main contract/constants/repositories/routes | One WK-M phase; scope/review/failure receipts |
| Save/recovery | Document/backup/migration services | Preserve drafts, external libraries, assets, content |

Read `NavRail.tsx`/`App.tsx`, trace preload/main handlers, then domain modules/checks. Older proposals alone do not establish completion. See [AGENTS.md](../AGENTS.md), [distribution/recovery](桌面分发与备份恢复使用说明.md), and [README](../README.en.md).
