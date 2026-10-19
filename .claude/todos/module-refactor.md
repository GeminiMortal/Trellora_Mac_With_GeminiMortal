# 模块化重构待办事项

## 移动文件
- [x] search/ 模块：directLoadSmallDocuments, graphChunkExpansion, hybridRetrievalFusion, knowledgeBaseRag, rerankAdapters
- [x] context/ 模块：projectContextAdapter, promptSegmentContextAdapter, knowledgeMemoryEnvelope
- [x] skill/ 模块：aiSkillWorkspace
- [x] tools/ 模块：knowledgeBaseImageResolver, tagSuggestion, markdownAst
- [x] index/ 模块：metaDatabase
- [x] 保留根目录：types.ts

## 更新导入路径
- [x] 更新被移动文件的内部导入
- [x] 更新引用被移动文件的外部导入
- [x] 修复构建错误

## 验证
- [x] TypeScript 编译检查
- [x] 应用构建成功
- [ ] 测试验证
