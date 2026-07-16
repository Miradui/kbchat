# RAG 流程规范

## 文档入库流程

```text
上传文件
-> 保存到本地 uploads
-> 创建 documents 记录
-> 创建 document_jobs 任务
-> worker 开始处理
-> status=parsing
-> 解析文本
-> status=chunking
-> 文本切片
-> status=embedding
-> 生成 Embedding
-> 写入 document_chunks
-> status=completed
```

失败时：

```text
documents.status=failed
documents.error_message=失败原因
document_jobs.status=failed
document_jobs.error_message=失败原因
```

当前 MVP worker 按单服务实例运行。worker 启动时会把上一次进程中断遗留的 `running` 任务恢复为 `pending` 并重新领取，避免服务重启后文档永久卡住。该策略不支持多个服务实例同时共享同一任务表；如需多实例部署，必须改为带租约到期时间和心跳续租的领取协议。

## 文档解析范围

MVP 支持：

```text
txt
md
pdf
```

解析产物按来源格式保留必要边界：

1. TXT 和 Markdown 各产生普通文本 segment；Markdown 语法保持原样，交给切片阶段解释。
2. PDF 按物理页产生 segment，页码从 1 开始；空白页可以跳过，但后续非空页必须保留原物理页码，不能重新编号。
3. 当前 PDF 解析只提取可读取文本，不包含 OCR、版面树、跨栏阅读顺序修复或表格重建。

后续版本支持：

```text
docx
xlsx
pptx
html
```

## 切片规则

MVP 默认：

```text
chunkSize=800 tokens
chunkOverlap=120 tokens
```

当前 MVP 未绑定特定模型 tokenizer，预算估算采用保守启发式：连续 ASCII 每 4 个 rune 约计 1 token，非 ASCII rune（包括 CJK 和 Emoji）按 1 token 计。该估算用于防止长 URL、hash、base64 或连续 Emoji 绕过 chunk 上限；未来接入模型专用 tokenizer 时必须保持相同的最大预算不变量。

所有格式共享 token 预算、稳定 `chunkIndex` 和超长内容的递归拆分，但结构策略按来源格式区分：

```text
1. TXT：按纯文本段落、句子、空白词元和 rune 切分；`#`、列表符号、管道符和代码围栏都按字面正文处理。
2. Markdown：保留标题、段落、列表、表格和代码块；标题层级写入 headingPath，并作为 chunk 内容前缀参与 embedding。
3. PDF：物理页是硬边界，只在页内按段落、句子、空白词元和 rune 切分；chunk 合并和 overlap 均不得跨页。
4. 同一来源边界和标题路径下的小结构块可合并到 chunkSize 以内。
5. 超过 chunkSize 的结构块按优先级递归拆分：段落 -> 句子 -> 空白词元 -> rune 硬切。
6. chunkOverlap 用于同一来源边界内相邻段落切片的尾部上下文补充；列表、表格和代码块不注入普通文本 overlap，避免破坏结构。overlap 不能破坏 chunkIndex 稳定递增。
```

Markdown 单个列表项超过预算时，每个分片重复原列表 marker；单个表格行超过预算时，按 cell 内容拆分并重建相同列数的行，同时重复 header/separator。标题前缀或重复结构包装不得挤掉 chunk 的主来源正文。

每个 chunk 必须保存：

```text
documentId
knowledgeBaseId
chunkIndex
content
tokenCount
pageNumber
metadata
embedding
```

metadata 至少包含：

```text
source=document_processor
fileType
headingPath
structureType
startOffset
endOffset
pageNumber（仅有物理页概念时）
```

`pageNumber` 对 PDF 表示原文件的 1-based 物理页码；TXT、Markdown 等没有物理页概念的格式保持 `null`。PDF 即使跳过空白页也不得压缩页码。

`startOffset` 和 `endOffset` 是 chunk 主来源内容在规范化 segment 内的 UTF-8 byte offset：换行会统一为 `\n`，首尾空白和 BOM 可能被去除。PDF 的 offset 是页内 offset。额外复制的 overlap、Markdown 标题前缀、代码 fence 或表格 header 不扩张该范围。它们不是原文件的精确字节坐标，不可用于在原始二进制文件中直接 seek。

chunk 顺序必须稳定，`chunkIndex` 跨所有 segment 从 0 开始递增。当前 MVP 不做 OCR、通用文档 AST、PDF 版面树、PDF 表格重建、跨页 chunk 或 docx 解析。

Processor 必须先完成全部 Embedding 批次并验证每批返回向量数量，再在单个数据库事务中替换该文档的旧 chunks。任一 Provider 调用或数量校验失败时，不得留下部分新索引，也不得删除原有完整索引。

## 检索流程

```text
用户当前问题
-> 读取当前会话最近历史消息
-> 改写为独立检索问题
-> Query Embedding
-> pgvector TopN 粗召回
-> Rerank 精排
-> TopK chunks
-> Prompt 组装（系统约束 + 最近历史 + 本轮 TopK chunks）
-> Chat Provider
-> assistant answer
-> citations
```

默认参数：

```text
vectorTopN=30
rerankTopK=5
scoreThreshold=0.3
enableRerank=true
chatHistoryLimit=10
```

## 多轮上下文规则

聊天接口必须支持会话上下文。问题类型由 Chat Provider 做意图分类，程序只负责解析分类结果并执行路由。

意图分类必须输出 JSON：

```json
{
  "intent": "conversation",
  "standaloneQuery": "",
  "reason": "用户询问对话历史"
}
```

`intent` 只能是：

1. 会话类问题：问候、询问上一句话、刚才说了什么、聊天记录或对话进度时，直接基于历史对话回答，不执行知识库检索，`citations=[]`。
2. 知识类问题：需要企业知识库事实依据时，历史只用于理解用户当前问题，不得替代知识片段作为事实依据。

标准流程：

```text
当前会话历史消息
+ 用户当前问题
-> Chat Provider 输出 intent 和 standaloneQuery
-> 会话类问题：Chat Provider 基于历史直接回答，citations=[]
-> 知识类问题：
-> 使用 standaloneQuery 执行向量检索和 Rerank
-> 使用最近历史消息 + 本轮 TopK chunks 生成最终回答
```

约束：

1. 默认只读取最近 `CHAT_HISTORY_LIMIT=10` 条 `user` / `assistant` 消息。
2. 空内容、`system` 消息和未知角色不得进入上下文。
3. 意图分类阶段只输出 JSON，不生成答案。
4. 最终回答可以参考历史对话理解代词、省略和追问关系。
5. 最终回答的事实依据只能来自本轮进入 Prompt 的 chunks。
6. citations 只能来自本轮进入 Prompt 的 chunks，不能来自历史 assistant 消息。
7. 会话类问题不应返回知识库 citations，避免把无关 chunks 当作来源。
8. 分类结果解析失败时默认按 `knowledge_base` 处理，并使用原始问题作为 `standaloneQuery`。

## pgvector 查询约束

1. 必须按 `knowledge_base_id` 过滤。
2. 只检索 `documents.status=completed` 的文档 chunks。
3. 召回数量使用 `vectorTopN`。
4. 相似度分数返回为 `vectorScore`。
5. `vectorTopN` 最大为 `100`；最终 `rerankTopK` 最大为 `20`，且不得大于本轮 `vectorTopN`。

## Rerank 约束

1. Rerank 输入只能是向量召回的 TopN chunks。
2. Rerank 输出必须映射回原始 chunk。
3. 最终结果按 `rerankScore` 降序排序。
4. 进入 Prompt 的 chunks 数量为 `rerankTopK`。
5. citations 只能来自进入 Prompt 的 chunks。
6. Rerank 成功时按 `rerankScore >= scoreThreshold` 过滤；关闭或 fallback 时按 `vectorScore >= scoreThreshold` 过滤。

## Rerank Provider 与失败策略

启用 `RERANK_ENABLED=true` 时，后端使用 OpenAI-compatible Rerank Provider；关闭时跳过 Rerank，按向量召回顺序截断到 `rerankTopK`，并保持 `rerankScore=null`。

当前 Provider 请求假设：

```text
POST {RERANK_BASE_URL}/rerank
Authorization: Bearer {RERANK_API_KEY}
Content-Type: application/json
```

请求体：

```json
{
  "model": "rerank-model-name",
  "query": "用户检索问题",
  "documents": ["chunk content 1", "chunk content 2"]
}
```

响应必须包含 `results[].index`，并通过 `results[].relevance_score` 或 `results[].score` 提供分数。`index` 映射回向量召回候选的原始顺序，再由服务端映射成 chunk ID。Provider 超时默认为 60s。

失败策略由 `RERANK_FAILURE_MODE` 控制：

1. `strict`：默认值。Rerank 失败返回 `RERANK_FAILED`，不进入 Chat Provider，不伪造答案或引用。
2. `fallback`：Rerank 失败时保留向量召回顺序，先应用 `scoreThreshold`，再截断到 `rerankTopK`；所有结果 `rerankScore=null`。公共响应只返回稳定原因码 `provider_unavailable`，不得返回 Provider 原始错误文本。fallback 下 citations 仍只能来自最终进入 Prompt 的这些 vector topK chunks。

标准检索默认读取当前知识库持久化的 `retrievalConfig`。搜索 API 显式传入的 TopN、TopK 和启用开关可以覆盖知识库配置；Chat 不传覆盖值，始终复用知识库配置。环境变量只提供缺省值和全局 Provider 开关。

## Prompt 规则

Prompt 必须包含：

```text
系统角色
回答边界
最近历史对话
用户问题
知识片段
输出要求
```

推荐系统约束：

```text
你是企业知识库问答助手。只能基于提供的知识片段回答问题。
可以参考历史对话理解用户当前问题中的代词、省略和上下文。
历史对话不能替代知识片段作为事实依据。
引用来源只能来自本轮提供的知识片段。
如果知识片段不足以回答，请明确说明无法从当前知识库确认。
不要编造事实，不要编造引用来源。
```

知识片段格式：

```text
[source: 1]
documentId: xxx
chunkId: xxx
filename: xxx.pdf
pageNumber: 3
content: ...
```

## 无结果处理

如果没有 chunk 达到阈值，应返回：

```json
{
  "answer": "当前知识库中未找到足够依据回答该问题。",
  "citations": []
}
```

## AI 开发约束

1. 不要跳过 Rerank 直接把向量召回结果给 LLM。
2. 不要把未进入 Prompt 的 chunk 放入 citations。
3. 不要跨知识库检索。
4. 不要在模型失败时伪造回答。
5. Rerank 失败默认返回 `RERANK_FAILED`；只有配置 `RERANK_FAILURE_MODE=fallback` 时才允许降级为 vector topK，并必须显式标记 fallback。
6. 不要把完整无限历史直接塞进 Prompt；必须受 `CHAT_HISTORY_LIMIT` 控制。

## 检索 Debug Payload

`POST /api/v1/knowledge-bases/:id/search` 支持请求字段 `debug`，默认 `false`。关闭时响应体保持普通检索响应，不返回调试字段。

开启 `debug=true` 时，响应增加：

1. `query`：当前检索 query；当前搜索接口没有改写步骤，因此不返回 `rewrittenQuery`。
2. `vectorStage`：pgvector TopN 原始召回 chunks，包含 `chunkId`、`documentId`、`filename`、`pageNumber`、`content`、`vectorScore`、`rank`。
3. `rerankStage`：Rerank 输入和输出映射，包含 `chunkId`、`pageNumber`、`rerankScore`、`rank`；`status` 为 `completed`、`disabled` 或 `fallback`。
4. `finalStage`：最终返回给用户或进入 Prompt 的 chunks，包含 `chunkId`、`pageNumber`、`vectorScore`、`rerankScore`、`rank`。
5. `rerankFallback`：沿用普通响应中的 fallback 语义；未 fallback 时为 `null`。

debug payload 仍然只来自当前用户拥有的知识库。知识库权限校验必须先通过 `knowledge_bases.owner_id`，chunk 检索必须限定当前 knowledge base。

## Chat Rerank Fallback 透传

聊天知识库问答复用标准检索路径。若 `RERANK_FAILURE_MODE=fallback` 且 Rerank 失败，Chat 响应返回 `rerankFallback.used=true` 和原因；citations 来自最终进入 Prompt 的 vector topK chunks，且 `rerankScore=null`。

若未发生 fallback，Chat 响应返回 `rerankFallback=null`。若 `RERANK_FAILURE_MODE=strict` 且 Rerank 失败，仍返回 `RERANK_FAILED`，不调用最终回答 Chat Provider，不保存伪造 assistant 消息。

## Chat Regenerate 规则

`POST /api/v1/chat/sessions/:sessionId/messages/:messageId/regenerate` 只允许重新生成 assistant 消息。服务端找到目标 assistant 消息之前最近一条 user 消息，并用这条 user 消息重新执行完整链路：

```text
前序历史 + 原 user 消息
-> 意图分类和 standaloneQuery 改写
-> 向量召回
-> Rerank 或 fallback
-> Prompt 组装
-> Chat Provider
-> 新 assistant 消息
```

旧 assistant 消息不会被覆盖或删除。新响应的 citations 只能来自本次重新检索进入 Prompt 的 chunks，不能复用旧 assistant 消息保存的 citations。
