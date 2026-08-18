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

密码字段不做 trim，只有真正的空字符串才视为未填写；非空密码在认证前按
UTF-8 编码检查 `account.maxPasswordBytes`，当前上限为 72 字节。

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

### PUT /auth/me

更新当前用户资料。只接受这两个展示字段：`username` 和 `role` 属于身份，不能通过该接口修改。

```json
{
  "displayName": "Admin",
  "avatarUrl": "https://example.com/avatar.png"
}
```

- `displayName` 必填，两端空白会被去除，长度按 **Unicode 码点（Go rune）** 计，上限见 `GET /system/capabilities` 的 `account.maxDisplayNameLength`
- `avatarUrl` 可为空字符串表示清除。非空时只接受 `http://`、`https://` 绝对地址，或以单个 `/` 开头的站内相对路径；`javascript:`、`data:` 以及 `//host` 协议相对地址一律返回 `VALIDATION_ERROR`。长度同样按 Unicode 码点计数

响应与 `GET /auth/me` 相同。

### POST /auth/change-password

```json
{
  "currentPassword": "old-secret",
  "newPassword": "new-secret"
}
```

成功返回 `204 No Content`。

- 即使已登录也必须提供 `currentPassword`：仅凭泄露的 token 不足以顶掉账号密码。校验失败返回 `INVALID_CURRENT_PASSWORD`
- `newPassword` 的最小长度按 Unicode 码点（Go rune）计，见 `account.minPasswordLength`
- bcrypt 最多接受 72 个字节，因此新密码的 UTF-8 编码长度不得超过 `account.maxPasswordBytes`；超限返回 `400 VALIDATION_ERROR`，不会进入 bcrypt 后变成 500
- 新密码与当前密码相同返回 `PASSWORD_UNCHANGED`
- 两个并发改密请求即使都携带同一个旧密码，也只有最先完成条件更新的请求成功；后续请求因旧密码哈希已变化返回 `INVALID_CURRENT_PASSWORD`
- **改密不会吊销已签发的 token**：当前没有服务端会话存储，旧 token 会一直有效到自然过期

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

## System

### GET /system/capabilities

返回前端需要遵守的服务端限制，避免前端复刻常量后与服务端配置脱钩。需要登录。

```json
{
  "rerankEnabled": false,
  "upload": {
    "maxFileBytes": 52428800,
    "allowedExtensions": ["txt", "md", "pdf"]
  },
  "retrieval": {
    "maxVectorTopN": 100,
    "maxRerankTopK": 20
  },
  "account": {
    "minPasswordLength": 8,
    "maxPasswordBytes": 72,
    "maxDisplayNameLength": 128,
    "maxAvatarUrlLength": 512
  }
}
```

各字段与请求路径实际执行的限制同源：

- `rerankEnabled` 来自 `RERANK_ENABLED`
- `upload.maxFileBytes` 来自 `MAX_UPLOAD_SIZE_MB`
- `upload.allowedExtensions` 就是文档上传校验使用的白名单
- `retrieval.*` 就是检索服务对 `vectorTopN` / `rerankTopK` 的硬上限
- `account.minPasswordLength`、`account.maxDisplayNameLength` 与 `account.maxAvatarUrlLength` 按 Unicode 码点（Go rune）计；前端不能用 JavaScript `string.length` 或 HTML `maxLength` 代替
- `account.maxPasswordBytes` 是密码 UTF-8 编码后的字节上限，与 bcrypt 的 72 字节硬限制同源；前端不能用 JavaScript `string.length` 或 HTML `maxLength` 代替

该接口只读，不反映单个知识库的 `retrievalConfig`。

## Activities

### GET /activities

工作台时间线。查询参数 `limit`，默认 `20`，最大 `100`（超出按上限截断，不报错）。按时间倒序返回当前用户自己的事件。

```json
{
  "items": [
    {
      "id": "uuid",
      "action": "document.deleted",
      "resourceType": "knowledgeBase|document|chatSession|member",
      "resourceId": "uuid",
      "resourceName": "manual.pdf",
      "knowledgeBaseId": "uuid",
      "knowledgeBaseName": "产品知识库",
      "createdAt": "2026-08-09T10:00:00Z"
    }
  ]
}
```

`action` 是一个封闭集合，前端据此渲染文案：

```text
knowledgeBase.created / knowledgeBase.deleted / knowledgeBase.restored
document.uploaded / document.deleted / document.restored / document.moved / document.cancelled
member.added / member.roleChanged / member.removed
chatSession.deleted / chatSession.restored
```

设计要点：

- **`resourceName` 与 `knowledgeBaseName` 随事件一起存下来，不在读取时反查**。删除事件恰恰是在资源已经不存在时最需要可读，所以这张表刻意不对资源表建外键
- 这正是前端合并三个列表做不到的部分：删除、恢复、成员变更都没有可供合并的行
- **记录是尽力而为的**：写入失败不会让触发它的操作失败。时间线是便利视图，不是审计日志，丢一条记录远好过让用户已经确认的删除操作报错
- 表结构见 `backend/migrations/012_activities.sql`

## Home

### GET /home/summary

工作台首页所需的全部聚合数据，一次返回。查询参数 `period=month|day`（默认 `month`，仅作用于 `stats`）。

```json
{
  "period": "month",
  "stats": { "period": "month", "knowledgeBases": {}, "documents": {}, "views": {}, "questions": {} },
  "knowledgeBases": [],
  "knowledgeBaseTotal": 42,
  "documents": [],
  "documentTotal": 128,
  "failedDocuments": [],
  "failedDocumentTotal": 3,
  "sessions": [],
  "sessionTotal": 17
}
```

- 每个列表的条数由**服务端**决定（`service.HomeSummaryItemLimit`，当前为 5），前端不再靠 `pageSize` 猜
- 每个列表都配一个未截断的 `*Total`，因此「最近 5 条 / 共 42 条」不需要第二次请求
- 各列表元素结构分别与 `GET /knowledge-bases`、`GET /documents`、`GET /chat/sessions` 的列表项一致
- 该接口只做聚合，复用上述各资源的 service：归属校验和软删除过滤规则仍然只有一份

## Knowledge Bases

### GET /knowledge-base-categories

返回当前用户的知识库分类树。每个节点带两个计数：

```json
{
  "items": [
    {
      "id": "category_uuid_a",
      "parentId": null,
      "name": "产品文档",
      "sortOrder": 10,
      "directCount": 2,
      "totalCount": 5,
      "children": []
    }
  ]
}
```

- `directCount`：直接挂在该分类下的知识库数量
- `totalCount`：`directCount` 加上所有子孙分类的 `directCount`

两者都不含已软删除的知识库，也不含未分类（`categoryId=null`）的知识库。这两个字段仅由本接口返回；`POST` / `PUT` 返回的单节点不含子树，因此不带这两个字段。

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
completedDocumentCount
processingDocumentCount
failedDocumentCount
viewCount
questionCount
isFavorite
lastViewedAt
updatedBy
```

三个文档状态计数字段只出现在列表项中，并且只统计未软删除文档：

- `completedDocumentCount`：状态为 `completed` 的文档数。
- `processingDocumentCount`：状态为 `uploaded`、`parsing`、`chunking` 或 `embedding` 的文档数。
- `failedDocumentCount`：状态为 `failed` 的文档数。

知识库创建、详情和更新响应不返回上述列表聚合字段。

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

### GET /knowledge-bases/:id/stats

查询参数：

```text
period=month|day
```

单个知识库的趋势。响应结构与全局统计一致，但**没有 `knowledgeBases` 指标** —— 单个知识库的知识库数恒为 0 或 1，没有趋势含义。

```json
{
  "knowledgeBaseId": "uuid",
  "period": "month",
  "documents": { "value": 12, "changeRatio": 0.2 },
  "views": { "value": 34, "changeRatio": null },
  "questions": { "value": 8, "changeRatio": -0.1 }
}
```

统计口径与全局统计相同（排除软删除的文档与会话，浏览量和问答数只算当前用户），只是把范围收窄到这一个知识库。非当前用户 owner 的知识库返回 `KNOWLEDGE_BASE_NOT_FOUND`。

**这些聚合刻意不放进 `GET /knowledge-bases/:id`**：知识库的 create / update / detail 响应不返回 list-only 聚合字段，需要趋势数据就单独请求本接口。

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

### POST /knowledge-bases/batch-tag

批量给知识库打标签，与其他批量接口一样是 all-or-nothing：知识库和标签都必须属于当前用户，混入任何一个不属于自己的资源则整批失败且不产生部分变更。

```json
{
  "knowledgeBaseIds": ["uuid_a", "uuid_b"],
  "tagIds": ["tag_uuid"],
  "mode": "add"
}
```

- `mode` 取 `add` | `remove` | `replace`，缺省为 `add`；其他值返回 `INVALID_BATCH_TAG_MODE`
- `add` 幂等：已绑定的标签重复提交不会报错
- `remove` 只解绑给定标签，不影响其他标签
- `replace` 先清空这些知识库的全部标签再写入 `tagIds`
- **只有 `replace` 接受空 `tagIds`**，语义是清空标签；`add` / `remove` 传空返回 `VALIDATION_ERROR`，因为那只会静默地什么都不做
- 绑定变更与这些知识库的 `updatedAt` / `updatedBy` 在同一个事务内完成

响应与其他批量接口一致：`{ "processedCount": 2 }`。

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
  "jobStatus": "pending|running|failed|completed|cancelled",
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

批量重处理当前用户拥有的文档，采用 all-or-nothing 语义。旧 chunks 会保留到全部新 Embedding 成功并在事务中完成替换；排队或处理失败不得提前删除旧索引。

同一文档仍处于 `uploaded|parsing|chunking|embedding` 且已有 `pending|running` 的 `process_document` 任务时复用现有任务。若文档已进入 `completed|failed`、但旧 running job 尚在收尾，则创建一个 pending 后继任务；worker 必须等待同文档 running 前驱结束后再领取后继任务。

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

上传传输进度由前端通过 `XMLHttpRequest.upload.onprogress` 的 `loaded / total`
字节计算真实百分比；接口本身不新增进度字段。传输达到 100% 只表示 multipart
请求体上传完成，后续解析、切片和 Embedding 仍以文档的 `status`、`jobStatus`、
`progress`、`stage` 为准。

### GET /knowledge-bases/:kbId/documents

`GET /documents` 的知识库限定视图。查询参数与响应结构与 `GET /documents` 完全一致，唯一区别是 `knowledgeBaseId` 来自路径而不是 query，请求里再传 `knowledgeBaseId` 会被路径值覆盖。

查询参数：`q`、`status`、`fileType`、`sort`、`page`、`pageSize`（默认 `page=1`、`pageSize=20`，上限 100）。

```json
{
  "items": [
    {
      "id": "uuid",
      "knowledgeBaseId": "kb_uuid",
      "knowledgeBaseName": "产品文档库",
      "filename": "manual.pdf",
      "fileType": "pdf",
      "fileSize": 102400,
      "status": "completed",
      "errorMessage": null,
      "jobStatus": "completed",
      "progress": 100,
      "stage": "completed",
      "retryCount": 0,
      "maxRetries": 3,
      "nextRetryAt": null,
      "createdAt": "2026-06-08T00:00:00Z",
      "updatedAt": "2026-06-08T00:00:00Z"
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20
}
```

不属于当前用户的知识库返回 `KNOWLEDGE_BASE_NOT_FOUND`，不会返回空列表。

**兼容性变更**：该接口此前不接受任何查询参数，一次返回该知识库的全部文档且响应只有 `items`。现在它默认分页，并返回 `total` / `page` / `pageSize` 以及 `knowledgeBaseName` 和任务进度字段。需要全部文档的调用方必须显式翻页。

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

### PUT /documents/:id

重命名文档，或把文档移动到另一个知识库。两个字段都可选，省略哪个就不改哪个；两个都省略是空操作，返回当前状态。

```json
{
  "filename": "季度报告.pdf",
  "knowledgeBaseId": "target_kb_uuid"
}
```

响应与 `GET /documents/:id` 相同。

**重命名**

- 两端空白会被去除，长度按 rune 计，上限 255（`documents.filename` 列宽）
- 文件名不能包含 `/` 或 `\`
- **扩展名不能改**：`fileType` 是上传时按扩展名确定的，并决定重处理时选哪个 parser。把 `.pdf` 改成 `.txt` 会让 parser 去按文本读一个真正的 PDF。违反时返回 `DOCUMENT_EXTENSION_IMMUTABLE`

**移动**

- 目标知识库必须属于当前用户，否则返回 `KNOWLEDGE_BASE_NOT_FOUND`
- 文档的 chunks 会**在同一个事务里**一起迁移 `knowledge_base_id`。`document_chunks` 上的复合外键 `(document_id, knowledge_base_id)` 让两侧不可分割：单独改任何一侧都会违反约束，因此 `011_document_chunk_kb_move.sql` 把该约束改为 `DEFERRABLE INITIALLY IMMEDIATE`，只有移动事务会 `SET CONSTRAINTS ... DEFERRED`
- **文档存在 pending 或 running 的处理任务时拒绝移动**，返回 `DOCUMENT_JOB_ACTIVE`（409）。已领取的 processor 会按它启动时读到的知识库写入 chunks，中途移动会让它把 chunks 写进旧知识库
- 重命名不受此限制：processor 不读文件名
- 移动会同时 touch 源知识库和目标知识库的 `updatedAt` / `updatedBy`

### POST /documents/:id/cancel

取消文档的处理任务。响应与 `GET /documents/:id` 相同。

- 只能取消 `pending` 或 `running` 的任务；没有可取消的任务时返回 `DOCUMENT_JOB_NOT_CANCELLABLE`（409）
- 取消后 `jobStatus` 为 `cancelled`，文档 `status` 为 `failed`，`errorMessage` 为「文档处理已取消。」。`failed` 与 `cancelled` 的区别只体现在 `jobStatus` 上
- **已完成的 Embedding 批次不回滚**。processor 在批次前后检查 context 与 job 状态；取消已生效时停止后续 Provider 调用
- 新 chunks 的发布、文档 `completed` 与 job `completed` 在同一个事务内完成，并与取消共享 document 行锁。取消先提交时发布返回 `ErrDocumentJobCancelled`、旧 chunks 保持不变；发布先提交时 job 已完成，后续取消返回 `DOCUMENT_JOB_NOT_CANCELLABLE`
- 阶段状态写入也在同一 document/job guard 下执行；任务不再 `running` 时写入被拒绝，processor 随即中止。worker 随后的 `CompleteJob` 对已经原子发布的 completed job 幂等，但不会覆盖 cancelled/failed 状态
- 被取消的文档可以照常 `POST /documents/:id/reprocess` 重新排队

### DELETE /documents/:id

软删除文档，默认列表、搜索和检索不再返回该文档。

### POST /documents/:id/reprocess

安全排队重处理任务。旧 chunks 会保留到新 Embedding 全部成功并事务替换；活动任务复用和 worker 收尾窗口的后继任务语义与批量接口一致。

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
      "snippet": "匹配摘要",
      "highlights": [
        { "field": "snippet", "start": 3, "end": 5 }
      ]
    }
  ],
  "total": 123,
  "page": 1,
  "pageSize": 20
}
```

`total` 是当前 `type` 筛选下的总命中数。`type=all` 时，知识库和文档按更新时间、chunk 按创建时间排序，并以 ID 作为稳定次序键，再按知识库、文档、chunk 轮转输出，避免单一类型占满分页。越界页返回空 `items`，但保留真实 `total/page/pageSize`。该接口为关键词搜索；语义检索仍使用知识库内 `POST /knowledge-bases/:kbId/search`。

**highlights 的偏移量口径**

`highlights` 标记命中在结果字段内的位置，`field` 取 `title` 或 `snippet`；没有命中位置时为 `null`。

- **`start` / `end` 一律是 UTF-16 code unit 偏移量**，也就是 JavaScript 字符串下标，前端可以直接 `text.slice(start, end)` 取出命中文本
- **不是** UTF-8 字节偏移，**也不是** 码点（rune）下标。三者在纯 ASCII 下相同，一旦出现中文就会分叉：`"本季度退货政策"` 里 `退货` 的字节偏移是 `9..15`，码点下标是 `3..5`，UTF-16 是 `3..5`；emoji 等增补平面字符占 2 个 code unit，此时码点下标与 UTF-16 也不再相同。口径选错会静默错位
- 命中判定与 SQL 的 `LOWER(...) LIKE '%q%'` 同源：大小写不敏感的子串匹配，逐字符折叠，不做分词
- 同一字段内的多次命中都会返回，互不重叠；单字段最多返回 50 个区间，避免单字符关键词在长 chunk 上产生上千个区间

前端因此不再需要自己做子串匹配（原 `SearchPage.tsx` 的 `highlight()` 已删除）。

### GET /search/export

按当前用户权限导出关键词搜索结果，只使用与 `GET /search` 相同的 `q` 和
`type`：

```text
GET /search/export?q=退货&type=document
```

`type` 缺省为 `all`；空白 `q` 或非法 `type` 返回 `VALIDATION_ERROR`。导出全部
匹配项，不接收分页参数。结果总数不超过 5000 条（含 5000）时允许导出；从
5001 条起返回 `400 EXPORT_TOO_LARGE`。

成功响应为带 UTF-8 BOM 的 CSV：

```text
Content-Type: text/csv; charset=utf-8
Content-Disposition: attachment; filename="search-results.csv"
```

表头固定为：

```text
类型,知识库,标题,摘要,知识库ID,文档ID,结果ID
```

### GET /search/suggest

命令面板（⌘K）用的轻量建议。只搜索**标题级别**内容：知识库名称和文档文件名，不检索 chunk 内容，也不构造摘要 —— 这正是它比 `GET /search` 便宜的原因。

查询参数：

```text
q=关键词
limit=10
```

`limit` 默认 `10`，最大 `20`（超出按上限截断，不报错）。空白关键词返回 `VALIDATION_ERROR`。

```json
{
  "items": [
    {
      "type": "knowledgeBase|document",
      "id": "uuid",
      "knowledgeBaseId": "uuid",
      "knowledgeBaseName": "产品知识库",
      "documentId": "uuid",
      "title": "manual.pdf"
    }
  ]
}
```

知识库在前、文档在后，各自按更新时间倒序。由于不检索 chunk 内容，命令面板应始终保留「在搜索页查看全部结果」的入口。

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

未传 `vectorTopN`、`rerankTopK` 或 `enableRerank` 时，使用当前知识库持久化的 `retrievalConfig`；环境变量仅作为知识库配置缺失时的默认值。服务端限制 `vectorTopN<=100`、`rerankTopK<=20`，并保证 `rerankTopK<=vectorTopN`。

最终结果必须应用知识库 `scoreThreshold`：Rerank 成功时使用 `rerankScore` 判断，Rerank 关闭或 fallback 时使用 `vectorScore` 判断。未达到阈值的 chunk 不得进入 `items`、Prompt 或 citations。

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
    "reason": "provider_unavailable"
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

查询参数：

```text
GET /chat/sessions?knowledgeBaseId=&archived=false&q=&page=1&pageSize=20
```

- `knowledgeBaseId`：限定某个知识库，缺省返回全部
- `archived`：`false`（默认）只返回未归档会话，`true` 只返回已归档会话；不支持一次返回两者
- `q`：按会话标题模糊匹配，不检索消息内容（消息内容检索走 `GET /search`）
- `page` / `pageSize`：默认 `1` / `20`，`pageSize` 上限 100

响应按 `updatedAt` 倒序：

```json
{
  "items": [
    {
      "id": "session_uuid",
      "knowledgeBaseId": "kb_uuid",
      "knowledgeBaseName": "产品文档库",
      "title": "报销制度咨询",
      "messageCount": 12,
      "lastMessagePreview": "退货政策规定 30 天内…",
      "createdAt": "2026-06-08T00:00:00Z",
      "updatedAt": "2026-06-08T00:00:00Z",
      "archivedAt": null
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20
}
```

`knowledgeBaseName`、`messageCount`、`lastMessagePreview` 仅由本接口返回；单会话响应（create / get / rename / archive / unarchive）不做 join 与聚合，因此不带这三个字段。

`messageCount` 统计 user 与 assistant 全部消息。`lastMessagePreview` 取最新一条消息内容，服务端按字符截断到 120 个字符并追加省略号。

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

### GET /chat/sessions/:id/export

导出当前用户可见的单个会话。必须校验 session 属于当前用户，且关联知识库仍
存在、未删除并属于当前用户；软删除会话返回 `RESOURCE_NOT_FOUND`，归档会话
仍可导出。

```text
Content-Type: text/markdown; charset=utf-8
Content-Disposition: attachment; filename="chat-<sessionId>.md"
```

Markdown 按消息创建时间升序包含会话标题、`知识库：<名称>`、全部用户/助手
消息，以及 assistant 消息中已保存的 citations。来源段使用 `### 来源`，每条
来源包含文件名、可选页码和缩进正文。

### PUT /chat/sessions/:id

当前仅支持修改标题。

```json
{
  "title": "新的会话标题"
}
```

### DELETE /chat/sessions/:id

**软删除**当前用户会话，会话进入聊天回收站。必须校验 session 属于当前用户，且知识库属于当前用户。

**消息会保留**：恢复后应该拿回原来的对话，一个没有历史的会话与新建会话无法区分。消息只在永久删除时才清理。

### GET /chat/sessions/recycle-bin

分页列出当前用户已删除的会话，响应结构与知识库、文档回收站一致，`resourceType` 为 `chatSession`，`name` 为会话标题：

```json
{
  "items": [
    {
      "resourceType": "chatSession",
      "id": "session_uuid",
      "name": "退货政策",
      "knowledgeBaseId": "kb_uuid",
      "knowledgeBaseName": "产品知识库",
      "deletedAt": "2026-08-09T10:00:00Z"
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20
}
```

与另外两个回收站一样，会话所属知识库必须仍存在且属于当前用户；知识库本身被删除时，其会话不在这里单独提供恢复（恢复知识库即可）。

### POST /chat/sessions/:id/restore

从回收站恢复会话，连同全部消息。会话不在回收站中（未删除或不属于当前用户）时返回 `RESOURCE_NOT_FOUND`。

恢复与永久删除/清空回收站通过会话行锁串行化：恢复先提交时，后续清空不会再选中该会话；永久删除或清空先提交时，等待中的恢复返回 `RESOURCE_NOT_FOUND`，不会出现恢复成功后会话和消息又被删除。

### DELETE /chat/sessions/recycle-bin/:id

永久删除一个已删除会话及其全部消息，不可恢复。

### POST /chat/sessions/recycle-bin/empty

清空当前用户**当前可见的**聊天回收站，采用 all-or-nothing 语义。范围与
`GET /chat/sessions/recycle-bin` 完全一致：session 属于当前用户、关联知识库仍未删除，且
`knowledge_bases.owner_id` 仍是当前用户。位于已删除知识库下的隐藏会话不会被提前永久删除；恢复知识库后它们会重新出现在聊天回收站。

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

### POST /chat/sessions/:id/unarchive

归档的反向操作，把会话放回默认列表。必须校验 session 属于当前用户，且知识库属于当前用户。该接口幂等：对未归档会话调用直接返回当前会话。

成功响应为 `200 OK`，`archivedAt` 为 `null`：

```json
{
  "id": "session_uuid",
  "knowledgeBaseId": "kb_uuid",
  "title": "报销制度咨询",
  "createdAt": "2026-06-08T00:00:00Z",
  "updatedAt": "2026-06-08T02:00:00Z",
  "archivedAt": null
}
```

### GET /chat/sessions/:id/messages

必须校验 session 属于当前用户，且知识库属于当前用户。

消息项包含 `clientRequestId`；历史消息或 regenerate 产生的 assistant 消息可为 `null`。客户端用该字段确定性核对发送结果，不得按消息数量或文本相等推测。

每条消息都固定返回 `feedback`。未评价消息和 user 消息为 `null`；已评价的
assistant 消息为 `{ "messageId", "rating", "updatedAt" }`。消息列表、阻塞发送、
流式 `done` 和 regenerate 返回的消息均使用同一结构。

### POST /chat/messages/:messageId/feedback

为当前用户可见的 assistant 回答保存评价：

```json
{
  "rating": "positive"
}
```

`rating` 只接受 `positive` 或 `negative`。user 消息返回 `VALIDATION_ERROR`；消息、
会话或知识库不属于当前用户，或者会话/知识库已软删除时返回
`RESOURCE_NOT_FOUND`。重复提交会覆盖原评价并刷新时间。

```json
{
  "messageId": "assistant_message_uuid",
  "rating": "positive",
  "updatedAt": "2026-08-12T10:00:00Z"
}
```

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
    "feedback": null,
    "createdAt": "2026-07-26T10:00:00Z"
  },
  "assistantMessage": {
    "id": "assistant_message_uuid",
    "sessionId": "session_uuid",
    "clientRequestId": "4c6b6701-c6dd-4804-9f95-826df9ccff91",
    "role": "assistant",
    "content": "差旅报销通常需要提交发票、行程单和审批单。",
    "citations": [],
    "feedback": null,
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
    "reason": "provider_unavailable"
  }
}
```

strict 模式下 Rerank 失败仍返回 `RERANK_FAILED`，不调用最终回答 Chat Provider，不保存伪造 assistant 消息。

### POST /chat/sessions/:id/messages/stream

`POST /chat/sessions/:id/messages` 的流式版本。请求体完全相同，`done` 事件的 payload 与阻塞版响应体逐字段一致，因此前端可以复用同一套结果处理。

响应为 `text/event-stream`，事件格式为标准 SSE（`event:` 行 + 单行 JSON 的 `data:` 行 + 空行分隔）：

```text
event: citations
data: {"citations":[...]}

event: delta
data: {"text":"差旅报销"}

event: delta
data: {"text":"通常需要"}

event: done
data: { …与阻塞接口相同的响应体… }
```

**事件顺序是 `citations` → `delta`* → `done`**，而不是缺口文档最初建议的 `delta` → `citations` → `done`。原因是物理上的：citations 来自进入 prompt 的 chunks，是生成的**输入**而非产物，检索一结束就已经确定。把它压到最后只是把服务端已经掌握的信息扣住不发，而先发它能让前端在首个 token 之前就把来源渲染出来，并明确区分「还在检索」和「已在生成」两个阶段。

- `citations` 恰好发送一次。conversation 意图不检索，此时发送空数组而不是不发 —— 「这个回答没有来源」同样是客户端需要的信息
- 知识库中无足够依据时，那句固定的拒答文本也会作为 delta 发出，客户端不会一直等到 `done` 才看到内容
- 若 Chat Provider 不支持流式，服务端回落到阻塞调用，并把整段回答作为**单个 delta** 发出。端点行为不变，只是没有逐字效果

**错误处理分两个阶段**，这是整个设计的关键分界：

- **首个事件发出之前**的失败仍然是普通 HTTP 错误（JSON body）：401、404、参数校验、`409 IDEMPOTENCY_KEY_REUSED` 都在这里返回。幂等检查刻意放在任何输出之前，就是为了保住这条路径
- **首个事件发出之后**响应已经锁定为 200，失败只能作为 `error` 事件送出：

```text
event: error
data: {"status":500,"code":"CHAT_COMPLETION_FAILED","message":"回答生成失败，请稍后重试","details":{}}
```

其中 `code` / `message` 与 JSON 错误走同一套映射（`handler.errorPayload`），前端按 `code` 分类的逻辑无需分叉。

**中断语义（必须理解这一条）**

**生成全部完成之前不写库。** 因此：

- 流在中途断开 —— 客户端掉线、Provider 出错、进程重启 —— **不会留下任何痕迹**，不存在半条 assistant 消息
- 客户端按同一 `clientRequestId` 到消息列表里对账：查不到就说明没落库，可以安全地用**同一个 ID** 重发
- 反之，如果连接是在服务端已提交之后、`done` 送达之前断的，对账会查到那对消息，客户端直接采用，不会重发
- 选择丢弃而不是落一条部分消息，是因为被截断的回答会进入历史，之后每一轮都会把它当成上下文读进去

因此 `done` 事件是唯一的成功信号。流在没有 `done` 的情况下结束，客户端必须按「结果未知」处理，不能当作成功。

幂等保证与阻塞接口共用同一套机制，没有第二条路径：

- 仍然由 `chat_messages` 上的部分唯一索引 `(session_id, client_request_id, role)` 兜底
- 同键同内容的重放直接回放已存的消息对，**完全不调用 Provider**，且只发 `citations` + `done`
- 并发的同键请求中落败的一方会采用胜出者已写入的消息对，因此「至多一条 assistant 消息」在并发下同样成立
- 如果并发落败方已经流出了与胜出者不同的 delta/citations，则不能再用胜出者内容发送一个自相矛盾的 `done`。服务端改发 `CHAT_RESULT_UNCONFIRMED` error 事件，客户端按原 `clientRequestId` 对账并采用已提交的胜出者消息对

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
    "feedback": null,
    "createdAt": "2026-06-08T00:00:00Z"
  },
  "rerankFallback": null
}
```

### PUT /chat/sessions/:sessionId/messages/:messageId/edit

编辑一条当前用户发送的消息并重新生成回答。编辑不会保留版本历史：目标用户消息保留原 ID，目标之后的旧消息会被删除，然后写入新的 assistant 消息。模型生成在替换事务之前执行，失败时原会话保持不变。

请求：

```json
{
  "content": "编辑后的问题",
  "clientRequestId": "uuid"
}
```

响应与 `POST /chat/sessions/:sessionId/messages` 相同（`SendChatMessageResponse`）。同一 `clientRequestId` 的重试会返回已提交的 user/assistant 消息，不会再次调用模型。

编辑事务会锁定会话并校验目标消息及其尾部仍与生成前快照一致；若其他请求在此期间写入或编辑会话，返回 `409 CHAT_MESSAGE_CHANGED`，不删除并发请求已经成功写入的数据。

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

返回当前用户的标签列表，每项带使用量：

```json
{
  "items": [
    {
      "id": "tag_uuid_1",
      "name": "product",
      "knowledgeBaseCount": 2,
      "createdAt": "2026-08-09T10:00:00Z",
      "updatedAt": "2026-08-09T10:00:00Z"
    }
  ]
}
```

`knowledgeBaseCount` 统计当前用户名下引用该标签的知识库数量，**包含回收站中的知识库**。这样它与 `DELETE` 的 `TAG_NOT_EMPTY` 判定口径一致：计数大于 0 就一定删不掉。

`POST` 返回的新标签 `knowledgeBaseCount` 固定为 `0`；`PUT` 返回改名后的实际计数。知识库负载里内嵌的 `tags` 摘要不带该字段。

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
