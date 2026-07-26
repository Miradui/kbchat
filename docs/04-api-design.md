# API 设计

统一前缀：

```text
/api/v1
```

除登录接口外，所有接口必须携带：

```text
Authorization: Bearer <token>
```

## 通用错误响应

```json
{
  "code": "ERROR_CODE",
  "message": "用户可读错误信息",
  "details": {}
}
```

## Auth

### POST /auth/login

请求：

```json
{
  "username": "admin",
  "password": "123456"
}
```

响应：

```json
{
  "token": "jwt_token",
  "user": {
    "id": "uuid",
    "username": "admin",
    "displayName": "Admin",
    "avatarUrl": "https://example.com/avatar.png"
  }
}
```

### GET /auth/me

响应：

```json
{
  "id": "uuid",
  "username": "admin",
  "displayName": "Admin",
  "avatarUrl": "https://example.com/avatar.png",
  "role": "user"
}
```

### POST /auth/logout

MVP 可由前端删除 token。后端接口返回成功即可。

## Users

### GET /users/search

搜索用户，用于知识库成员选择器。查询参数：

```text
q=关键词
limit=20
```

按 `username` 和 `displayName` 做大小写不敏感匹配，最多返回 50 条。

```json
{
  "items": [
    {
      "id": "user_uuid",
      "username": "alice",
      "displayName": "Alice",
      "avatarUrl": ""
    }
  ]
}
```

## Knowledge Bases

### GET /knowledge-base-categories

返回当前用户的知识库分类树。

### POST /knowledge-base-categories

请求：

```json
{
  "name": "产品文档",
  "parentId": null,
  "sortOrder": 10
}
```

### PUT /knowledge-base-categories/:id

可更新分类名称、父分类和排序。父分类必须属于当前用户。

### POST /knowledge-base-categories/reorder

一次性保存当前用户完整分类树的父子关系和排序，适用于拖拽后整棵树落库。当前接口采用 all-or-nothing 语义，要求提交当前用户的完整分类集合。

```json
{
  "items": [
    {
      "id": "category_uuid_a",
      "parentId": null,
      "sortOrder": 10
    },
    {
      "id": "category_uuid_b",
      "parentId": "category_uuid_a",
      "sortOrder": 20
    }
  ]
}
```

```json
{
  "processedCount": 2
}
```

### DELETE /knowledge-base-categories/:id

仅允许删除空分类。分类下存在子分类或知识库时返回 `CATEGORY_NOT_EMPTY`。

### POST /knowledge-bases

请求：

```json
{
  "name": "产品知识库",
  "description": "产品文档、FAQ、售前资料",
  "categoryId": "category_uuid",
  "visibility": "private"
}
```

响应：

```json
{
  "id": "uuid",
  "name": "产品知识库",
  "description": "产品文档、FAQ、售前资料",
  "categoryId": "category_uuid",
  "visibility": "private",
  "retrievalConfig": {
    "vectorTopN": 30,
    "rerankTopK": 5,
    "scoreThreshold": 0.3,
    "enableRerank": true
  },
  "updatedBy": {
    "id": "uuid",
    "username": "admin",
    "displayName": "Admin",
    "avatarUrl": "https://example.com/avatar.png"
  },
  "createdAt": "2026-06-08T00:00:00Z"
}
```

### GET /knowledge-bases

只返回当前用户拥有的知识库。支持：

```text
q
categoryId
visibility=private|public
scope=all|created|managed|favorite|recent
sort=updatedAt_desc|createdAt_desc|name_asc
page
pageSize
```

响应包含分页字段，并为每条知识库补充：

```text
documentCount
viewCount
questionCount
isFavorite
lastViewedAt
updatedBy
```

当前阶段 `created` 和 `managed` 都等价于当前用户拥有的知识库；`visibility` 只用于展示，不改变 owner 权限。

### GET /knowledge-bases/workspace-preference

返回当前用户的知识库工作台视图偏好。若用户尚未保存过偏好，则返回默认值。

```json
{
  "viewMode": "table",
  "scope": "all",
  "sort": "updatedAt_desc",
  "visibility": "all",
  "expandedCategoryIds": []
}
```

### PUT /knowledge-bases/workspace-preference

覆盖保存当前用户的知识库工作台视图偏好。

```json
{
  "viewMode": "card",
  "scope": "favorite",
  "sort": "name_asc",
  "visibility": "public",
  "expandedCategoryIds": ["category_uuid_a", "category_uuid_b"]
}
```

### GET /knowledge-bases/stats

查询参数：

```text
period=month|day
```

返回知识库数、文档数、浏览量和问答数，以及相对上一周期变化比例。上一周期值为 0 时 `changeRatio` 返回 `null`，前端应展示“本月新增”或“暂无可比数据”，不得显示为 100%。

### POST /knowledge-bases/:id/favorite

收藏当前用户拥有的知识库，幂等。

### DELETE /knowledge-bases/:id/favorite

取消收藏当前用户拥有的知识库，幂等。

### POST /knowledge-bases/:id/view

记录一次知识库浏览事件，用于最近浏览和浏览量统计。

### POST /knowledge-bases/batch-favorite

批量收藏或取消收藏当前用户拥有的知识库。当前阶段采用 all-or-nothing 语义，只要有任一知识库不属于当前用户，整个请求失败且不产生部分变更。

```json
{
  "knowledgeBaseIds": ["uuid_a", "uuid_b"],
  "favorite": true
}
```

```json
{
  "processedCount": 2
}
```

### POST /knowledge-bases/batch-move-category

批量移动知识库分类。`categoryId` 可为 `null`，表示移出分类。目标分类必须属于当前用户。

```json
{
  "knowledgeBaseIds": ["uuid_a", "uuid_b"],
  "categoryId": "category_uuid"
}
```

### POST /knowledge-bases/batch-delete

批量软删除当前用户拥有的知识库，采用 all-or-nothing 语义。

```json
{
  "knowledgeBaseIds": ["uuid_a", "uuid_b"]
}
```

### POST /knowledge-bases/batch-restore

批量恢复当前用户已删除的知识库，采用 all-or-nothing 语义。

```json
{
  "knowledgeBaseIds": ["uuid_a", "uuid_b"]
}
```

### GET /knowledge-bases/:id/permissions

返回当前知识库的真实成员权限视图。`owner` 始终来自 `knowledge_bases.owner_id`，并固定出现在 `managers[0]`，成员表只保存 `manager` / `member`。

```json
{
  "knowledgeBaseId": "uuid",
  "visibility": "private",
  "owner": {
    "id": "uuid",
    "username": "admin",
    "displayName": "Admin",
    "avatarUrl": "https://example.com/avatar.png"
  },
  "managers": [
    {
      "id": "uuid",
      "username": "admin",
      "displayName": "Admin",
      "avatarUrl": "https://example.com/avatar.png",
      "role": "owner"
    },
    {
      "id": "manager_uuid",
      "username": "manager",
      "displayName": "Manager",
      "avatarUrl": "",
      "role": "manager"
    }
  ],
  "members": [
    {
      "id": "member_uuid",
      "username": "member",
      "displayName": "Member",
      "avatarUrl": "",
      "role": "member"
    }
  ]
}
```

### PUT /knowledge-bases/:id/permissions

允许 owner 或 manager 更新展示用 `visibility`。`visibility` 仍不改变知识库主数据访问控制。

```json
{
  "visibility": "public"
}
```

### POST /knowledge-bases/:id/members

新增或覆盖知识库成员角色。当前允许 owner 或 manager 管理成员；owner 不能通过成员接口新增、降级或删除。

```json
{
  "userId": "user_uuid",
  "role": "manager"
}
```

`role` 支持：

```text
manager
member
```

### PUT /knowledge-bases/:id/members/:userId

更新成员角色。不能更新 owner。

```json
{
  "role": "member"
}
```

### DELETE /knowledge-bases/:id/members/:userId

删除成员。不能删除 owner。

### GET /knowledge-bases/:id

必须校验 `owner_id`。

### PUT /knowledge-bases/:id

允许更新：

```json
{
  "name": "新名称",
  "description": "新描述",
  "retrievalConfig": {
    "vectorTopN": 30,
    "rerankTopK": 5,
    "scoreThreshold": 0.3,
    "enableRerank": true
  }
}
```

### DELETE /knowledge-bases/:id

必须校验 `owner_id`。

## Documents

### GET /documents

跨当前用户拥有的知识库列出文档。支持：

```text
q
knowledgeBaseId
status
fileType
sort=updatedAt_desc|createdAt_desc|filename_asc
page
pageSize
```

响应项包含 `knowledgeBaseId` 和 `knowledgeBaseName`。

文档列表和详情响应都会补充处理进度字段，字段来自 `documents.status` 和最新 `document_jobs` 任务，不返回精细伪造进度：

```json
{
  "jobStatus": "pending|running|failed|completed",
  "progress": 75,
  "stage": "uploaded|parsing|chunking|embedding|completed|failed",
  "retryCount": 1,
  "maxRetries": 3,
  "nextRetryAt": "2026-06-08T00:00:00Z"
}
```

`nextRetryAt` 无重试计划时为 `null`。稳定进度映射为 `uploaded=0`、`parsing=25`、`chunking=50`、`embedding=75`、`completed=100`、`failed=0`。失败状态以 `status=failed` 和 `stage=failed` 单独表达，不得伪装为已完成进度。

`errorMessage` 只返回用户可读的业务提示。模型配置、网络、文件系统等原始技术错误保留在服务端日志和内部任务记录中，不得通过公开 DTO 返回。

### POST /documents/batch-delete

批量软删除当前用户拥有的文档，采用 all-or-nothing 语义。

```json
{
  "documentIds": ["uuid_a", "uuid_b"]
}
```

```json
{
  "processedCount": 2
}
```

### POST /documents/batch-restore

批量恢复当前用户已删除的文档，采用 all-or-nothing 语义。

```json
{
  "documentIds": ["uuid_a", "uuid_b"]
}
```

### POST /documents/batch-reprocess

批量重处理当前用户拥有的文档。服务端会清理原有 chunks，并重新创建 `process_document` 任务。

```json
{
  "documentIds": ["uuid_a", "uuid_b"]
}
```

### POST /documents

全局导入文档。请求为 multipart/form-data：

```text
field: knowledgeBaseId
field: file
```

内部复用知识库文档上传流程，仍必须校验目标知识库 owner。

### POST /knowledge-bases/:kbId/documents

请求：

```text
Content-Type: multipart/form-data
field: file
```

响应：

```json
{
  "id": "document_uuid",
  "knowledgeBaseId": "kb_uuid",
  "filename": "manual.pdf",
  "fileType": "pdf",
  "fileSize": 102400,
  "status": "uploaded"
}
```

上传成功后必须创建文档处理任务。

### GET /knowledge-bases/:kbId/documents

响应：

```json
{
  "items": [
    {
      "id": "uuid",
      "filename": "manual.pdf",
      "fileType": "pdf",
      "fileSize": 102400,
      "status": "completed",
      "errorMessage": null,
      "createdAt": "2026-06-08T00:00:00Z"
    }
  ]
}
```

### GET /documents/:id

必须通过 document 所属 knowledge_base 校验 owner。

### GET /documents/:id/download

下载原始上传文件。必须通过 document 所属 knowledge_base 校验 owner。响应为文件流，设置：

```text
Content-Type: 按文件类型推断
Content-Disposition: attachment
```

本地文件不存在时返回 `DOCUMENT_FILE_NOT_FOUND`。

### GET /documents/:id/preview

预览原始上传文件。必须通过 document 所属 knowledge_base 校验 owner。

`txt` / `md` 返回文本内容；`pdf` 和其他文件返回文件预览元信息，前端可使用 `downloadUrl` 打开浏览器/PDF 预览。文本预览当前限制为 1MB，超出返回 `FILE_TOO_LARGE_FOR_PREVIEW`。

```json
{
  "id": "document_uuid",
  "filename": "manual.md",
  "fileType": "md",
  "contentType": "text/markdown; charset=utf-8",
  "kind": "text",
  "content": "# Manual\ncontent",
  "downloadUrl": "/api/v1/documents/document_uuid/download"
}
```

```json
{
  "id": "document_uuid",
  "filename": "manual.pdf",
  "fileType": "pdf",
  "contentType": "application/pdf",
  "kind": "file",
  "downloadUrl": "/api/v1/documents/document_uuid/download"
}
```

### DELETE /documents/:id

软删除文档，默认列表、搜索和检索不再返回该文档。

### POST /documents/:id/reprocess

清理旧 chunks，重新创建处理任务。

### GET /documents/:id/chunks

支持查询参数：

```text
page=1
pageSize=20
q=关键词
chunkId=chunk_uuid
```

`q` 对 chunk `content` 做大小写不敏感匹配。

`chunkId` 可选。提供时，只返回路径参数所指定文档内对应 UUID 的 chunk；UUID
格式不合法返回 `VALIDATION_ERROR`，chunk 不存在或属于其他文档时返回空分页结果。
该查询仍通过文档所属知识库的 `owner_id` 校验所有权，无权访问时返回
`DOCUMENT_NOT_FOUND`。`chunkId` 与 `q` 同时提供时，两项条件同时生效。

响应：

```json
{
  "items": [
    {
      "id": "chunk_uuid",
      "chunkIndex": 0,
      "content": "文档片段内容",
      "tokenCount": 320,
      "pageNumber": 3,
      "metadata": {}
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20
}
```

## Search

### GET /search

关键词搜索当前用户拥有的知识库、文档和 chunk 内容。

查询参数：

```text
q=关键词
type=all|knowledgeBase|document|chunk
page=1
pageSize=20
```

`type` 默认 `all`，`page` 默认 `1`，`pageSize` 默认 `20` 且最大为 `100`。空白关键词或非法类型返回 `VALIDATION_ERROR`。

响应：

```json
{
  "items": [
    {
      "type": "knowledgeBase|document|chunk",
      "id": "uuid",
      "knowledgeBaseId": "uuid",
      "knowledgeBaseName": "产品知识库",
      "documentId": "uuid",
      "filename": "manual.pdf",
      "title": "manual.pdf",
      "snippet": "匹配摘要"
    }
  ],
  "total": 123,
  "page": 1,
  "pageSize": 20
}
```

`total` 是当前 `type` 筛选下的总命中数。`type=all` 时，知识库和文档按更新时间、chunk 按创建时间排序，并以 ID 作为稳定次序键，再按知识库、文档、chunk 轮转输出，避免单一类型占满分页。越界页返回空 `items`，但保留真实 `total/page/pageSize`。该接口为关键词搜索；语义检索仍使用知识库内 `POST /knowledge-bases/:kbId/search`。

### POST /knowledge-bases/:kbId/search

请求：

```json
{
  "query": "如何申请报销？",
  "vectorTopN": 30,
  "rerankTopK": 5,
  "enableRerank": true,
  "debug": false
}
```

响应：

```json
{
  "items": [
    {
      "chunkId": "uuid",
      "documentId": "uuid",
      "filename": "财务制度.pdf",
      "content": "相关片段",
      "pageNumber": 4,
      "vectorScore": 0.78,
      "rerankScore": 0.91
    }
  ],
  "rerankFallback": null
}
```

结果必须按 `rerankScore` 降序排列。若关闭 Rerank，`rerankScore` 可为空，结果按向量召回顺序截断到 `rerankTopK`。

`debug` 默认为 `false`。当 `debug=true` 时，响应增加 `debug`，用于检索调试面板；普通响应不包含该字段，避免响应体过大。

```json
{
  "debug": {
    "query": "如何申请报销？",
    "vectorStage": {
      "status": "completed",
      "items": [
        {
          "chunkId": "uuid",
          "documentId": "uuid",
          "filename": "财务制度.pdf",
          "pageNumber": 4,
          "content": "相关片段",
          "vectorScore": 0.78,
          "rank": 1
        }
      ]
    },
    "rerankStage": {
      "status": "completed|disabled|fallback",
      "input": [{ "chunkId": "uuid", "rank": 1 }],
      "output": [{ "chunkId": "uuid", "rerankScore": 0.91, "rank": 1 }]
    },
    "finalStage": {
      "items": [{ "chunkId": "uuid", "vectorScore": 0.78, "rerankScore": 0.91, "rank": 1 }]
    },
    "rerankFallback": null
  }
}
```

默认 `RERANK_FAILURE_MODE=strict`，Rerank 失败返回：

```json
{
  "code": "RERANK_FAILED",
  "message": "retrieval rerank failed",
  "details": {}
}
```

若配置 `RERANK_FAILURE_MODE=fallback`，Rerank 失败时保留向量召回排序，不伪造 `rerankScore`，并在响应中标记：

```json
{
  "items": [
    {
      "chunkId": "uuid",
      "documentId": "uuid",
      "filename": "财务制度.pdf",
      "content": "相关片段",
      "pageNumber": 4,
      "vectorScore": 0.78,
      "rerankScore": null
    }
  ],
  "rerankFallback": {
    "used": true,
    "reason": "rerank failed: provider unavailable"
  }
}
```

## Chat

### POST /chat/sessions

请求：

```json
{
  "knowledgeBaseId": "kb_uuid",
  "title": "报销制度咨询"
}
```

`title` 可为空。为空时先创建默认标题，首轮 `POST /chat/sessions/:id/messages` 完成后由独立 `TITLE_*` AI API 根据用户问题和助手回答总结会话名称，不复用 Chat Provider。

### GET /chat/sessions

只返回当前用户会话，并要求关联知识库仍存在且归当前用户所有。

### GET /chat/sessions/:id

返回当前用户的单个会话。必须校验 session 属于当前用户，且知识库属于当前用户。

```json
{
  "id": "session_uuid",
  "knowledgeBaseId": "kb_uuid",
  "title": "报销制度咨询",
  "createdAt": "2026-06-08T00:00:00Z",
  "updatedAt": "2026-06-08T00:00:00Z",
  "archivedAt": null
}
```

### PUT /chat/sessions/:id

当前仅支持修改标题。

```json
{
  "title": "新的会话标题"
}
```

### DELETE /chat/sessions/:id

硬删除当前用户会话，并级联删除消息。必须校验 session 属于当前用户，且知识库属于当前用户。

### POST /chat/sessions/:id/archive

归档当前用户会话。必须校验 session 属于当前用户，且知识库属于当前用户。归档后默认 `GET /chat/sessions` 不再返回该会话，但 `GET /chat/sessions/:id` 仍可查看详情并返回 `archivedAt`。该接口幂等。

成功响应为 `200 OK`，返回归档后的会话；重复归档返回同一个 `archivedAt`：

```json
{
  "id": "session_uuid",
  "knowledgeBaseId": "kb_uuid",
  "title": "报销制度咨询",
  "createdAt": "2026-06-08T00:00:00Z",
  "updatedAt": "2026-06-08T01:00:00Z",
  "archivedAt": "2026-06-08T01:00:00Z"
}
```

### GET /chat/sessions/:id/messages

必须校验 session 属于当前用户，且知识库属于当前用户。

消息项包含 `clientRequestId`；历史消息或 regenerate 产生的 assistant 消息可为 `null`。客户端用该字段确定性核对发送结果，不得按消息数量或文本相等推测。

### POST /chat/sessions/:id/messages

聊天接口必须读取当前会话最近历史消息。服务端会先调用 Chat Provider 做意图分类，模型必须返回 `intent` 和 `standaloneQuery`，程序再根据分类结果执行路由。

意图分类输出：

```json
{
  "intent": "conversation",
  "standaloneQuery": "",
  "reason": "用户询问对话历史"
}
```

如果模型判断用户问题只涉及对话本身，例如问候、询问上一句话、刚才说了什么或聊天进度，服务端应跳过知识库检索，直接基于历史对话回答，并返回空 citations。

如果模型判断用户问题需要知识库事实依据，服务端使用 `standaloneQuery` 执行向量召回、Rerank 和最终回答。分类结果解析失败时，默认按知识库问题处理，并使用原始问题作为 `standaloneQuery`。

请求：

```json
{
  "content": "差旅报销需要哪些材料？",
  "clientRequestId": "4c6b6701-c6dd-4804-9f95-826df9ccff91"
}
```

响应：

```json
{
  "clientRequestId": "4c6b6701-c6dd-4804-9f95-826df9ccff91",
  "userMessage": {
    "id": "user_message_uuid",
    "sessionId": "session_uuid",
    "clientRequestId": "4c6b6701-c6dd-4804-9f95-826df9ccff91",
    "role": "user",
    "content": "差旅报销需要哪些材料？",
    "citations": [],
    "createdAt": "2026-07-26T10:00:00Z"
  },
  "assistantMessage": {
    "id": "assistant_message_uuid",
    "sessionId": "session_uuid",
    "clientRequestId": "4c6b6701-c6dd-4804-9f95-826df9ccff91",
    "role": "assistant",
    "content": "差旅报销通常需要提交发票、行程单和审批单。",
    "citations": [],
    "createdAt": "2026-07-26T10:00:01Z"
  },
  "answer": "差旅报销通常需要提交发票、行程单和审批单。",
  "citations": [
    {
      "documentId": "uuid",
      "chunkId": "uuid",
      "filename": "财务制度.pdf",
      "pageNumber": 6,
      "content": "差旅报销需提供...",
      "vectorScore": 0.76,
      "rerankScore": 0.93
    }
  ],
  "rerankFallback": null
}
```

`clientRequestId` 必须是 UUID，幂等作用域为当前 session。同一 session 内重复提交相同 `clientRequestId` 和相同 `content` 时，服务端只持久化一对 user/assistant 消息，并始终返回这对消息；已存在完整消息对的后续请求不会再次调用模型。同一 ID 对应不同内容时返回 `409 IDEMPOTENCY_KEY_REUSED`。Provider 或事务在消息落库前失败时，客户端可复用原 ID 重试。两个同时到达且都早于首次落库的请求可能各自调用一次 Provider，但唯一约束会阻止重复消息落库；若业务要求 Provider 调用也全局至多一次，需要另行引入持久化请求状态与并发协调机制。

当聊天知识库检索发生 Rerank fallback 时，响应显式返回：

```json
{
  "rerankFallback": {
    "used": true,
    "reason": "rerank failed: provider unavailable"
  }
}
```

strict 模式下 Rerank 失败仍返回 `RERANK_FAILED`，不调用最终回答 Chat Provider，不保存伪造 assistant 消息。

### POST /chat/sessions/:sessionId/messages/:messageId/regenerate

重新生成指定 assistant 消息。必须校验 session 属于当前用户，且 session 所属知识库属于当前用户。

MVP 语义：

1. 只能 regenerate `assistant` 消息；传入 user 消息返回 `VALIDATION_ERROR`。
2. 服务端找到该 assistant 消息之前最近一条 user 消息。
3. 使用这条 user 消息重新执行意图分类、检索、Rerank、Prompt 和 Chat Provider。
4. 新增一条 assistant 消息，不覆盖、不删除旧 assistant 消息。
5. citations 只来自本次重新检索且进入 prompt 的 chunks，不复用旧 citations。

响应：

```json
{
  "message": {
    "id": "new_assistant_message_uuid",
    "sessionId": "session_uuid",
    "role": "assistant",
    "content": "重新生成的回答",
    "citations": [],
    "createdAt": "2026-06-08T00:00:00Z"
  },
  "rerankFallback": null
}
```

多轮上下文规则：

1. 默认使用最近 `CHAT_HISTORY_LIMIT=10` 条 `user` / `assistant` 消息。
2. 历史消息用于意图分类、独立检索问题改写，以及理解追问、省略和代词。
3. 回答事实依据仍只能来自本轮检索并进入 Prompt 的 chunks。
4. citations 只返回本轮 chunks，不返回历史消息来源。
5. 会话类问题的 `citations` 必须为空，不能附带无关知识库片段。

## AI 开发约束

1. API 字段使用 camelCase。
2. 数据库字段使用 snake_case。
3. 任何知识库相关接口必须做 owner 权限校验。
4. citations 只能来自最终进入 Prompt 的 rerank chunks。
5. 不要返回未授权资源是存在还是不存在的敏感细节；可统一返回 `RESOURCE_NOT_FOUND` 或 `FORBIDDEN`。

## P1 标签扩展

### GET /knowledge-base-tags

返回当前用户的标签列表。

### POST /knowledge-base-tags

```json
{
  "name": "product"
}
```

### PUT /knowledge-base-tags/:id

```json
{
  "name": "manual"
}
```

### DELETE /knowledge-base-tags/:id

删除时若仍被知识库引用，返回 `TAG_NOT_EMPTY`。

### 知识库标签字段

- `POST /knowledge-bases` 和 `PUT /knowledge-bases/:id` 支持 `tagIds: string[]`
- `GET /knowledge-bases` 支持 `tagIds=uuid,uuid`
- `GET /knowledge-bases` 和 `GET /knowledge-bases/:id` 返回 `tags`

```json
{
  "tagIds": ["tag_uuid_1", "tag_uuid_2"]
}
```

```json
{
  "tags": [
    {
      "id": "tag_uuid_1",
      "name": "product"
    }
  ]
}
```

## P1 回收站扩展

### GET /knowledge-bases/recycle-bin

返回当前用户已删除知识库列表。

### POST /knowledge-bases/:id/restore

恢复当前用户已删除知识库。

### DELETE /knowledge-bases/recycle-bin/:id

永久删除当前用户 owner 的、已在回收站中的知识库，并清理关联文档、chunks、chat sessions、成员、收藏、浏览和标签绑定。

### POST /knowledge-bases/recycle-bin/empty

清空当前用户 owner 的知识库回收站，采用 all-or-nothing 语义。

### GET /documents/recycle-bin

返回当前用户已删除文档列表。

### POST /documents/:id/restore

恢复当前用户已删除文档。

### DELETE /documents/recycle-bin/:id

永久删除当前用户 owner 的、已在回收站中的文档，并清理 chunks 和处理任务。

### POST /documents/recycle-bin/empty

清空当前用户 owner 的文档回收站，采用 all-or-nothing 语义。

## P1 权限设置扩展

- 新增 `GET /knowledge-bases/:id/permissions`
- 新增 `PUT /knowledge-bases/:id/permissions`
- 新增 `GET /users/search`
- 新增 `POST /knowledge-bases/:id/members`
- 新增 `PUT /knowledge-bases/:id/members/:userId`
- 新增 `DELETE /knowledge-bases/:id/members/:userId`
- `owner` 始终来自 `knowledge_bases.owner_id`，成员表只保存 `manager` / `member`
- owner 和 manager 可管理成员；owner 不能被删除或降级

## P1 批量操作兼容扩展

- 新增 `POST /knowledge-bases/batch-favorite`
- 新增 `POST /knowledge-bases/batch-move-category`
- 新增 `POST /knowledge-bases/batch-delete`
- 新增 `POST /knowledge-bases/batch-restore`
- 新增 `POST /documents/batch-delete`
- 新增 `POST /documents/batch-restore`
- 新增 `POST /documents/batch-reprocess`
- 新增 `POST /knowledge-base-categories/reorder`
- 新增 `GET /knowledge-bases/workspace-preference`
- 新增 `PUT /knowledge-bases/workspace-preference`
- 当前批量接口仅覆盖知识库工作台主操作，且全部按 owner 维度校验
- 当前批量接口采用 all-or-nothing 语义，不返回部分成功结果
