# API 设计

统一前缀：

```text
/api/v1
```

除登录接口外，所有接口必须携带：

```text
Authorization: Bearer <token>
```

## 时间格式

时间字段使用 RFC 3339，包含 `Z` 或明确的时区偏移。数据库使用 `timestamptz` 保存时刻，应用会话时区为 UTC；前端按浏览器时区格式化，不额外手动加减小时。例如 `2026-09-14T14:22:13Z` 在北京时间显示为 `2026-09-14 22:22:13`。迁移 023 保持旧时间当前按 UTC 读取时的含义，API 字段和格式不变。

历史记录未做批量校正；修复后的新增时间及后续写入的更新时间遵循此约定，详见[数据库时间约定](03-database-design.md#时间约定)。

## 通用错误响应

```json
{
  "code": "ERROR_CODE",
  "message": "用户可读错误信息",
  "details": {}
}
```

限流响应沿用同一结构。真正超过窗口限额时返回 `429 RATE_LIMITED`，HTTP
`Retry-After` 与 `details.retryAfter` 都是向上取整后的剩余秒数：

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 42
Content-Type: application/json

{"code":"RATE_LIMITED","message":"请求过于频繁，请稍后重试","details":{"retryAfter":42}}
```

Redis 故障且 `RATE_LIMIT_FAILURE_MODE=closed` 时返回 `503 RATE_LIMIT_UNAVAILABLE`；这不是一次真实超限，不设置 `Retry-After`。`open` 模式放行并记录 warning。

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

登录按客户端 IP 使用一分钟固定窗口限流，默认每分钟 10 次，成功与失败请求都会计数。只有直连来源属于 `TRUSTED_PROXY_CIDRS` 时才读取 `X-Forwarded-For`；其余请求始终使用 TCP 对端地址，避免伪造代理头绕过限流。

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
- `avatarUrl` 省略或为 `null` 时保留当前头像；显式空字符串清除头像和缩略图。非空时兼容 `http://`、`https://` 绝对地址，或以单个 `/` 开头的站内相对路径；`javascript:`、`data:` 以及 `//host` 协议相对地址返回 `VALIDATION_ERROR`。长度同样按 Unicode 码点计数
- `/api/v1/users/:id/avatar?v=...` 托管头像地址必须属于当前账户、使用合法版本 UUID；过期版本返回 `409 AVATAR_CHANGED`，名称和头像均不更新，避免旧表单覆盖新上传

响应与 `GET /auth/me` 相同。

### POST /auth/me/avatar

上传当前账户头像，使用 `multipart/form-data` 的 `file` 字段。接受 PNG/JPEG，文件不超过 2 MiB，
长宽均不超过 4096 像素；以后端实际解码格式为准，不信任扩展名或上传 Content-Type。
服务端居中裁成 256×256 并重新编码为 PNG，仅保留缩略图，原始文件及元数据不保存。

成功返回 `200` 及更新后的 `UserResponse`，`avatarUrl` 形如：

```text
/api/v1/users/<user UUID>/avatar?v=<version UUID>
```

每位用户只保留一个缩略图；替换图片及用户地址在同一事务中完成，不修改显示名称、密码或角色。
超限返回 `400 AVATAR_TOO_LARGE`，损坏或不支持的图片返回 `400 INVALID_AVATAR`，不影响原头像。

### DELETE /auth/me/avatar

移除当前用户头像及缩略图，成功返回 `200` 和更新后的用户资料。重复移除仍成功。

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

### GET /users/:id/avatar

需要 JWT 鉴权，已登录用户可读取用户头像（与成员及用户搜索中的身份展示一致）。可选查询参数 `v`
指定版本；不存在或版本已替换返回 `404 AVATAR_NOT_FOUND`。
成功返回 `image/png`，附带版本 ETag、`Cache-Control: private, no-cache`、`Vary: Authorization`
和 `X-Content-Type-Options: nosniff`；匹配 `If-None-Match` 时在鉴权后返回 `304`。
浏览器须通过带 Authorization 的请求取得 Blob 后展示；外部头像地址不得附带本站 token。

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

### Admin users

系统管理员专用接口位于 `/admin/users`，全部经过 `RequireSystemAdmin`：未登录返回 `401 UNAUTHORIZED`，已登录但 `users.role != admin` 返回 `403 SYSTEM_ADMIN_REQUIRED`（角色以数据库为准，不信任 JWT 中的 role 声明）。禁用账号的 JWT 在下一次任何请求时被认证中间件拒绝（`401 UNAUTHORIZED`）；账号状态查询失败时中间件拒绝而不是放行，返回 `503 AUTH_UNAVAILABLE`。所有变更写入 `activities`，`action` 前缀 `admin.user.*`，`resourceType=user`。

用户对象：

```json
{
  "id": "user_uuid",
  "username": "alice",
  "displayName": "Alice",
  "avatarUrl": "",
  "role": "user",
  "status": "active",
  "lastLoginAt": "2026-09-20T08:00:00Z",
  "createdAt": "2026-09-01T00:00:00Z"
}
```

`role` 取 `user` / `admin`，`status` 取 `active` / `disabled`。密码散列永不返回。

#### GET /admin/users

```text
q=关键词            按 username / displayName 大小写不敏感模糊匹配
status=active|disabled
role=user|admin
page=1
pageSize=20         最大 100
```

```json
{
  "items": [ { "id": "user_uuid", "username": "alice", "...": "..." } ],
  "total": 42,
  "page": 1,
  "pageSize": 20
}
```

按创建时间倒序。

#### POST /admin/users

```json
{
  "username": "alice",
  "displayName": "Alice",
  "password": "optional-initial-password"
}
```

- `username` 必填，须匹配 `^[A-Za-z0-9._@-]{3,64}$`（不含空白），大小写按输入保存，但唯一性按大小写不敏感判定：已有 `alice` 时 `Alice` 返回 `409 USERNAME_EXISTS`。
- `displayName` 可选，留空时使用用户名，最长 128 个码点。
- `password` 可选。省略时服务端生成 14 位随机密码；指定时按与 `bootstrap-admin` 及改密相同的规则校验（最少 8 个字符、最多 72 个 UTF-8 字节），不合法时 `400 VALIDATION_ERROR`，`details` 键为 `password`。

响应 `201`：

```json
{
  "user": { "id": "user_uuid", "username": "alice", "role": "user", "status": "active", "...": "..." },
  "initialPassword": "Xk3#..."
}
```

`initialPassword` 无论是生成的还是管理员指定的都只在这次响应中返回一次。新用户 `role=user`、`status=active`、`created_by` 为操作者。

#### PUT /admin/users/:id

```json
{ "displayName": "Alice Liddell", "status": "disabled" }
```

两个字段都必填。`status=disabled` 时：目标是操作者自己返回 `400 ADMIN_SELF_MUTATION`；目标是当前唯一的启用管理员返回 `409 LAST_ADMIN_REQUIRED`。响应 `200` 返回用户对象。

#### POST /admin/users/:id/reset-password

无请求体。生成新密码并使旧密码立即失效，响应 `200`：

```json
{ "user": { "...": "..." }, "password": "new-one-time-password" }
```

操作者不能重置自己的密码（`400 ADMIN_SELF_MUTATION`），自己的密码通过 `POST /auth/change-password` 修改。

#### PUT /admin/users/:id/role

```json
{ "role": "admin" }
```

`user` ↔ `admin`。操作者不能修改自己的角色（`400 ADMIN_SELF_MUTATION`）；把当前唯一的启用管理员降为 `user` 返回 `409 LAST_ADMIN_REQUIRED`。判定「唯一」时只计 `status=active` 的管理员且排除目标本人，因此降级一个已禁用的管理员总是允许。响应 `200` 返回用户对象。

#### 错误码

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | 用户名格式、显示名长度、`password` 长度、`status` / `role` 取值、`id` 非 UUID |
| 400 | `ADMIN_SELF_MUTATION` | 禁用、降级或重置自己的密码 |
| 403 | `SYSTEM_ADMIN_REQUIRED` | 调用者不是系统管理员 |
| 404 | `USER_NOT_FOUND` | 目标用户不存在 |
| 409 | `USERNAME_EXISTS` | 用户名（忽略大小写）已存在 |
| 409 | `LAST_ADMIN_REQUIRED` | 会移除最后一位启用管理员 |

### GET /chat/quality/usage

范围与质量页其他接口一致：不传 `knowledgeBaseId` 时汇总调用者拥有或以 manager 身份可读质量数据的全部知识库；传入时须对该知识库具备 `quality.read`，否则 403 / 404；系统管理员（`users.role=admin`）看到全部知识库。`from` / `to` 使用 RFC3339，默认最近 7 天（滚动 168 小时）；`groupBy` 为 `day`、`knowledgeBase`、`user`、`model` 或 `purpose`，其他值返回 `VALIDATION_ERROR`。

```json
{
  "from": "2026-09-14T00:00:00Z",
  "to": "2026-09-21T00:00:00Z",
  "groupBy": "day",
  "items": [
    { "groupKey": "2026-09-20", "groupLabel": "", "promptTokens": 1200, "completionTokens": 300, "totalTokens": 1500, "calls": 12, "estimatedCost": null }
  ],
  "totalPromptTokens": 1200,
  "totalCompletionTokens": 300,
  "totalTokens": 1500,
  "pricingConfigured": true,
  "estimatedCost": 0.00096,
  "unpricedModels": []
}
```

`groupKey` 按日为 UTC 的 `YYYY-MM-DD`，按知识库 / 用户为 UUID 且 `groupLabel` 为名称或显示名，按模型为请求时使用的模型名（全局配置或知识库覆盖的模型，不是服务商响应里回显的别名），按用途为 `intent` / `answer` / `title` / `evaluation`。`estimatedCost` 只在 `groupBy=model` 且该模型在 `MODEL_PRICING` 中有价格时按行给出；顶层 `estimatedCost` 为所有有价格模型的合计，`unpricedModels` 列出范围内没有价格的模型，`pricingConfigured=false` 时两者均为空值。Provider 未返回 usage 时 token 字段保持空值并不会估算。

### GET /system/capabilities

返回前端需要遵守的服务端限制，避免前端复刻常量后与服务端配置脱钩。需要登录。

```json
{
  "rerankEnabled": false,
  "keywordSearchEnabled": true,
  "upload": {
    "maxFileBytes": 52428800,
    "allowedExtensions": ["txt", "md", "pdf", "docx", "xlsx", "csv"]
  },
  "retrieval": {
    "maxVectorTopN": 100,
    "maxRerankTopK": 20
  },
  "account": {
    "minPasswordLength": 8,
    "maxPasswordBytes": 72,
    "maxDisplayNameLength": 128,
    "maxAvatarUrlLength": 512,
    "maxAvatarBytes": 2097152,
    "avatarSize": 256,
    "avatarContentTypes": ["image/png", "image/jpeg"]
  }
}
```

各字段与请求路径实际执行的限制同源：

- `rerankEnabled` 来自 `RERANK_ENABLED`
- `keywordSearchEnabled` 来自 `KEYWORD_SEARCH_ENABLED`，为 `false` 时知识库的 `enableKeyword` 会保存但不生效
- `chatModels` 来自 `CHAT_ALLOWED_MODELS`，是知识库 `answerConfig.model` 唯一可选的值；为空数组时不开放模型覆盖
- `upload.maxFileBytes` 来自 `MAX_UPLOAD_SIZE_MB`
- `upload.allowedExtensions` 就是文档上传校验使用的白名单
- `retrieval.*` 就是检索服务对 `vectorTopN` / `rerankTopK` 的硬上限
- `account.minPasswordLength`、`account.maxDisplayNameLength` 与 `account.maxAvatarUrlLength` 按 Unicode 码点（Go rune）计；前端不能用 JavaScript `string.length` 或 HTML `maxLength` 代替
- `account.maxPasswordBytes` 是密码 UTF-8 编码后的字节上限，与 bcrypt 的 72 字节硬限制同源；前端不能用 JavaScript `string.length` 或 HTML `maxLength` 代替
- `account.maxAvatarBytes`、`account.avatarSize`、`account.avatarContentTypes` 是头像上传字节上限、标准边长和支持格式

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
      "resourceType": "knowledgeBase|document|chatSession|member|user",
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
admin.user.created / admin.user.updated / admin.user.disabled / admin.user.enabled
admin.user.passwordReset / admin.user.roleChanged
kb.ownership_transferred
```

`admin.user.*` 只由系统管理员在 `/admin/users` 上的操作写入，`resourceType=user`、`resourceName` 为目标用户名，没有 `knowledgeBaseId`。

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

## 权限与能力矩阵

访问控制的判定单位是**能力**，不是接口。每个知识库相关接口声明它需要哪个能力，
调用者在该知识库上的角色决定是否放行。角色有四个，成员表只能保存前三个：

| 角色 | 来源 |
| --- | --- |
| `viewer` | `knowledge_base_members.role` |
| `editor` | `knowledge_base_members.role` |
| `manager` | `knowledge_base_members.role` |
| `owner` | `knowledge_bases.owner_id`，不是成员行 |

角色是升级关系：`viewer < editor < manager < owner`，上位角色拥有下位角色的全部能力。

| 能力 | 含义 | viewer | editor | manager | owner |
| --- | --- | --- | --- | --- | --- |
| `kb.read` | 读取知识库详情、统计、收藏、浏览记录 | ✓ | ✓ | ✓ | ✓ |
| `kb.search` | 检索该知识库，含全局搜索命中 | ✓ | ✓ | ✓ | ✓ |
| `kb.write` | 修改名称、描述、分类、标签、visibility | | | ✓ | ✓ |
| `kb.delete` | 软删除与恢复知识库 | | | | ✓ |
| `kb.transfer` | 转移知识库所有权 | | | | ✓ |
| `document.read` | 文档列表、详情、预览、分块 | ✓ | ✓ | ✓ | ✓ |
| `document.download` | 下载原始上传文件 | | ✓ | ✓ | ✓ |
| `content.write` | 上传、替换、改元数据、重新处理、软删除与恢复 | | ✓ | ✓ | ✓ |
| `content.purge` | 永久删除（单个与批量） | | | ✓ | ✓ |
| `chat.use` | 创建会话与提问 | ✓ | ✓ | ✓ | ✓ |
| `chat.export` | 导出会话记录 | ✓ | ✓ | ✓ | ✓ |
| `feedback.write` | 对收到的回答评分 | ✓ | ✓ | ✓ | ✓ |
| `quality.read` | 问答质量运营数据 | | | ✓ | ✓ |
| `members.read` | 读取成员名单 | | | ✓ | ✓ |
| `members.write` | 增删改成员 | | | ✓ | ✓ |

矩阵的唯一定义在 `backend/internal/access/capability.go` 的 `minRole`。这张表由该
map 生成，改代码不改表就会与实现不一致；`internal/access/capability_test.go` 锁住
每一格，`internal/service/access_contract_test.go` 按接口逐个断言。

**系统管理员不在这张表里。** `users.role=admin` 只解锁 `/system/diagnostics` 与
`/admin/users` 这类系统级接口（由 `RequireSystemAdmin` 判定，`403 SYSTEM_ADMIN_REQUIRED`），
不会给管理员任何一个知识库上的能力：管理员访问别人的私有知识库、文档或会话时，和普通
外人一样得到 404。两套判定互不叠加，`internal/router/admin_users_route_test.go` 与
`system_diagnostics_route_test.go` 锁住这一边界。

### 为什么几个能力放在看起来偏高的位置

- `document.download` 归 editor，不是 viewer。分界不是「能否看到内容」——viewer 通过
  分块和引用已经读到了正文。原始文件带着索引里没有的东西：修订记录、批注、嵌入对象、
  作者信息。
- `quality.read` 归 manager。这份数据聚合的是**别人**问了什么、怎么评分的，比编辑内容
  更进一步，暴露的是同事的使用情况。
- `content.purge` 归 manager 而不是 owner。永久删除不可逆，但只让 owner 能清空回收站
  就废掉了委派的意义。整个知识库的删除仍然是 owner 独有的 `kb.delete`。
- `kb.delete` 只归 owner。删掉容器和整理容器里的东西不是同一件事，被委派管理某个知识库
  的人不应该能把这个知识库本身移除。

### effectiveRole 与 capabilities

知识库响应带上调用者自己的位置：

```json
{
  "id": "uuid",
  "name": "制度库",
  "effectiveRole": "editor",
  "capabilities": ["kb.read", "kb.search", "document.read", "document.download", "content.write", "chat.use", "chat.export", "feedback.write"]
}
```

`capabilities` 是 `effectiveRole` 在上表中的那一行，顺序与 `access.Capabilities` 一致。
两个字段只用于前端隐藏按钮，不是授权依据：服务端每个请求都会重新判定，所以前端漏判只会
出现一个点了报 403 的按钮，不会放开任何权限。

`capabilities` 为空数组表示无任何能力，不会是 `null`——客户端不必区分「空」和「未知」。

### 404 与 403 的口径

| 情况 | 状态码 |
| --- | --- |
| 不是 owner 也不是成员 | 404 |
| 知识库已软删除 | 404 |
| 成员身份已被撤销 | 404 |
| 是成员但角色不够 | 403 |

没有任何立场时一律 404：返回 403 等于确认这个 id 存在，会把资源是否存在泄露给无关用户。
只有能到达资源、仅仅是角色不够时才返回 403，此时 `details` 点名缺什么：

```json
{
  "code": "FORBIDDEN",
  "message": "当前角色无权执行该操作",
  "details": {
    "role": "viewer",
    "capability": "content.write",
    "requiredRole": "editor"
  }
}
```

404 的错误码按**调用方问的那个资源**命名，即使拒绝来自它所属的知识库：文档 id 回
`DOCUMENT_NOT_FOUND`，会话 id 回 `RESOURCE_NOT_FOUND`，知识库 id 回
`KNOWLEDGE_BASE_NOT_FOUND`。用知识库的错误码回答一个文档请求，会让调用方以为自己
传错了 id。

### 会话的两道判定

会话接口先按 `chat_sessions.user_id` 过滤，再检查知识库上的 `chat.use`。两道判定都会
产出 404，但由不同输入触发：别人的会话 id 在第一道就被挡住，自己的会话在所属知识库不再
可达时（成员被撤销、知识库被删除）由第二道挡住。

### 列表接口

跨知识库的列表（文档、搜索、聊天回收站、质量运营）无法逐行判定，可达性写在查询里：
`owner_id = 当前用户 OR 存在角色满足该能力的成员行`。角色集合由
`access.MemberRolesWith(capability)` 给出，不在 SQL 里另写一份。

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

知识库创建/更新请求支持可选顶层 `documentVersionPolicy: "all" | "current"`，详情与列表均返回该字段；默认 `all`，更新时省略则保留原值，非法值返回 `VALIDATION_ERROR`。修改仍需 `kb.write`（manager/owner）。`current` 在本库参与的单库、多库、自动问答、检索调试和评测中，仅召回同库替换链内最新有已发布片段的可用版本。新版未发布、首次处理失败或取消时使用旧快照；再次处理失败不撤销已有快照。变更不重建向量，不修改历史会话、引用、文档或版本对比权限。

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
    "enableRerank": true,
    "enableKeyword": true
  },
  "answerConfig": {
    "systemPromptAddition": "",
    "answerLanguage": "auto",
    "allowGeneralKnowledge": false,
    "model": "",
    "temperature": null
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

`scope` 的三种可达范围：

- `created`：`owner_id` 是当前用户，与成员身份无关。
- `managed`：owner 或角色为 `manager` 的成员。owner 计入其中——一个把创建者排除在外的
  「我管理的」列表读起来像 bug，不像筛选。
- 其余（`all`、`favorite`、`recent`）：owner 或任意角色的成员。

`visibility` 只用于展示，不参与访问控制：`public` 不会让非成员读到知识库。

列表项带 `effectiveRole` 与 `capabilities`，含义见「权限与能力矩阵」。

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

需要 `kb.read`。统计口径与全局统计相同（排除软删除的文档与会话，浏览量和问答数只算当前用户），只是把范围收窄到这一个知识库。无立场时返回 `KNOWLEDGE_BASE_NOT_FOUND`。

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

需要 `members.read`。返回当前知识库的真实成员权限视图。`owner` 始终来自
`knowledge_bases.owner_id`，并固定出现在 `managers[0]`，成员表只保存
`viewer` / `editor` / `manager`。

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
      "role": "viewer"
    }
  ]
}
```

`managers` 是 owner 与 manager，`members` 是 editor 与 viewer；分组只为展示，
真实判定看每个人的 `role`。

### PUT /knowledge-bases/:id/permissions

需要 `kb.write`（manager 起）。更新展示用 `visibility`。`visibility` 不参与访问控制：
`public` 不会让非成员读到知识库，只影响列表里的标记与筛选。

```json
{
  "visibility": "public"
}
```

### POST /knowledge-bases/:id/members

需要 `members.write`（manager 起）。新增或覆盖知识库成员角色。owner 不能通过成员接口
新增、降级或删除。

```json
{
  "userId": "user_uuid",
  "role": "editor"
}
```

`role` 支持：

```text
viewer
editor
manager
```

`owner` 不可授予：它来自 `knowledge_bases.owner_id`，不是成员表里的一行。传 `owner`
返回 400 `OWNER_MEMBER_IMMUTABLE`，其它非法值返回 400 `INVALID_MEMBER_ROLE`。
旧值 `member` 已不再接受：migration 020 把这些行改写为 `viewer`。

### PUT /knowledge-bases/:id/members/:userId

需要 `members.write`。更新成员角色，取值同上。不能更新 owner。

```json
{
  "role": "viewer"
}
```

### DELETE /knowledge-bases/:id/members/:userId

需要 `members.write`。删除成员。不能删除 owner。

### GET /knowledge-bases/:id

需要 `kb.read`。

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
    "enableRerank": true,
    "enableKeyword": true
  }
}
```

### DELETE /knowledge-bases/:id

需要 `kb.delete`（owner 独有）。

## Documents

### GET /documents

`status=processing` 汇总 `uploaded`、`parsing`、`chunking`、`embedding` 四种状态，
由服务端筛选并计算 `total`，可与知识库、关键词、类型及分页组合使用。
该值仅用于查询，响应的 `status` 仍为文档的具体阶段；具体阶段筛选继续可用。
知识库内的 `GET /knowledge-bases/:kbId/documents` 同样支持此查询别名。

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

文档列表和详情响应都会补充处理进度字段。`progress` 来自最新 `document_jobs.progress` 的持久化真实值；没有该值的旧后端客户端才按 `documents.status` 使用兼容阶段进度：

```json
{
  "jobStatus": "pending|running|failed|completed|cancelled",
  "progress": 83,
  "stage": "uploaded|parsing|chunking|embedding|completed|failed",
  "retryCount": 1,
  "maxRetries": 3,
  "nextRetryAt": "2026-06-08T00:00:00Z"
}
```

`nextRetryAt` 无重试计划时为 `null`。新任务从 `0` 开始；解析为 `10`，切分为 `30`，Embedding 从 `50` 开始，按已完成批次推进到最多 `95`，发布成功为 `100`。取消仍返回 `status=failed`，但 `jobStatus=cancelled`，前端必须显示“已取消”而非“失败”。失败任务保留最后一次已持久化进度，不得伪装为已完成进度。

`errorMessage` 只返回用户可读的业务提示。模型配置、网络、文件系统等原始技术错误保留在服务端日志和内部任务记录中，不得通过公开 DTO 返回。

文档列表和详情响应还包含错误分类、版本关系与过期提示字段：

```json
{
  "errorCode": "empty_content",
  "supersededById": null,
  "supersededAt": null,
  "isStale": false,
  "staleAfterDays": 180
}
```

`errorCode` 是封闭集合，与 `backend/migrations/039_table_error_code.sql`
的 CHECK 约束一一对应：

| 值 | 含义 |
| --- | --- |
| `unsupported_type` | 格式不受支持。集合内保留但处理阶段不会产生：上传校验先返回 400 |
| `corrupt_file` | 容器本身无法解析（截断的 PDF 等） |
| `encoding_invalid` | 文本编码不是合法 UTF-8 |
| `empty_content` | 解析成功但没有可提取文字或数据行（如纯图片 PDF、空表或仅含表头） |
| `table_limit_exceeded` | 表格数据、行列数或 XLSX 展开内容超出解析限制 |
| `embedding_failed` | 向量化调用失败，文件本身无问题 |
| `storage_failed` | 读取对象存储失败 |
| `cancelled` | 任务被取消 |
| `internal` | 未识别的错误。**不猜具体原因**：错误的具体分类会让用户去修错的地方 |

未失败的文档不返回 `errorCode`（`omitempty`）；019 之前记录的失败也没有该字段，客户端必须
能回落到中性文案。

`corrupt_file`、`encoding_invalid`、`empty_content`、`table_limit_exceeded` 以及对象已不存在的 `storage_failed` 是确定性失败，后台任务首次失败即终止，不消耗重试次数；其余失败按 worker 的重试次数与间隔重试，只在最终失败时写入 `errorCode`。

`isStale` 只是展示提示，不是判断：文档超过 `staleAfterDays` 没有更新即为 true。它**不影响
检索**，过期文档照常被检索和引用。`staleAfterDays` 回显服务端阈值（`STALE_DOCUMENT_AFTER_DAYS`，
默认 180），`0` 表示该提示在服务端关闭。

`supersededById` 非空表示这一行是历史版本，已被该 id 的文档取代。

### GET /documents/counts

返回当前用户具有 `document.read` 权限的文档状态统计，复用文档列表的所有者/成员、软删除、关键词和文件类型过滤；系统管理员身份及知识库公开标记不会扩大可读范围。

支持 `q`、`knowledgeBaseId`、`fileType`。`q` 匹配文件名或知识库名称，与列表一致；非法知识库 ID 返回 400。指定不可访问或不存在的知识库时返回全零，保持全局列表的过滤语义。`status`、排序及分页不影响统计，供状态筛选按钮展示所有桶。

```json
{ "total": 12, "completed": 6, "processing": 4, "failed": 2 }
```

四个数字由一次条件聚合查询得到，属于同一查询快照；不读取文档条目或任务详情。`processing` 包含 uploaded/parsing/chunking/embedding，`failed` 包含状态为 failed 的取消任务；空结果各项为 0。列表与统计仍是两个独立请求，统计加载失败不能把未知数量显示为 0。

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

内部复用知识库文档上传流程，仍需要目标知识库的 `content.write`。

支持 `allowDuplicate` 表单字段，语义与 `POST /knowledge-bases/:kbId/documents` 一致。

文件上传、全局上传、文本创建与版本替换均支持可选 `requestId`（非零 UUID；multipart 字段，文本创建使用 JSON 字段）。迁移 040 以 `(userId, knowledgeBaseId, requestId)` 唯一记录已提交结果；文件字节哈希、名称、大小、来源路径、重复选择与替换目标共同构成请求指纹。同一请求重放返回同一文档及当前处理状态（201），不重复创建文件或任务；同一 ID 改变内容/选项返回 `409 DOCUMENT_UPLOAD_REQUEST_CONFLICT`。先前文档已删除、移动或不可访问时返回 `409 DOCUMENT_UPLOAD_RESULT_UNAVAILABLE`，凭据保留，禁止复活文件。未传 ID 的旧客户端保持原接口兼容，但无法按请求核对。

### GET /knowledge-bases/:kbId/document-uploads/:requestId

需当前 `content.write`，只查询调用者自己的凭据。返回 `{ "status": "committed", "document": DocumentResponse }`、`{ "status": "notFound" }` 或 `{ "status": "unavailable" }`。`notFound` 仅说明此刻无已提交凭据，原请求可能仍在处理；客户端必须复用同一 ID 重试，服务端唯一键和事务负责消除并发重复。`unavailable` 表示曾提交但结果现不可访问，不允许把它当作未上传。核对是只读操作，任务和文档不会因此改变。

### POST /knowledge-bases/:kbId/documents

XLSX/CSV 可额外提交 `tableImport` JSON 表单字段，例如 `{"sheets":[{"name":"销售","headerRow":3,"columns":[1,4]}]}`。只导入列出的工作表；CSV 使用空名称 `""` 且只能有一项。`headerRow=0` 表示首个非空记录，正数为物理行号，不能指向空行或多行 CSV 记录的中间；省略 `columns` 表示全部列，显式数组必须非空、无重复，列号为原文件 1–256。最多 32 张表，工作表不得重复。服务端验证实际工作表/表头/列存在，规范化顺序后持久化并纳入请求指纹；不配置保持既有默认。替换接口使用相同选项，返回文档详情中的 `tableImport`。非法设置返回 `400 DOCUMENT_TABLE_IMPORT_INVALID`。

### POST /knowledge-bases/:kbId/document-import-preview

需 `content.write`，multipart `file` 只接受 XLSX/UTF-8 CSV。只读检查文件，不保存对象、文档、任务或调用模型。返回 `sheets[]`：`name`、`suggestedHeaderRow`、`columnCount`、`lastRow`、`rows[{rowStart,rowEnd,values}]`、`truncated`。每表最多 20 个非空记录、每格最多 80 字、每表约 64 KiB 预览文本；原始物理行号保留。预览截断不影响实际导入，实际导入仍完整校验所选内容和解析上限。

### 文件上传请求与响应

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

**重复内容检测**。上传按 SHA-256 内容哈希在同一知识库内查重，命中时返回 409：

```json
{
  "error": {
    "code": "DOCUMENT_DUPLICATE_CONTENT",
    "message": "知识库中已存在内容相同的文档",
    "details": {
      "existingDocumentId": "document_uuid",
      "existingFilename": "policy.md",
      "existingStatus": "completed",
      "existingUploadedAt": "2026-06-08T00:00:00Z"
    }
  }
}
```

按内容哈希而不是文件名：改名重传是最常见的重复情形，按名字查重会漏掉它；同名但内容不同是
正常的版本更新，按名字查重会误报。

409 而不是 400：请求本身是合法的，服务端只是基于知识库当前状态拒绝，同一个请求带上
`allowDuplicate` 就会成功。`details` 点名冲突文档而不只是报告"存在重复"，因为客户端要据此
让用户选择替换还是保留两份。**`storagePath` 不出现在 `details` 里**：那是部署拓扑，渲染
对话框不需要它。

用户选择保留两份时，重传同一文件并带上表单字段：

```text
field: allowDuplicate=true
```

只有字面量 `true` 生效，其他值按默认处理（拒绝）。选择替换时改用
`POST /documents/:id/replace`。服务端不会自动替换：用户可能只是重复点了上传，静默替换会在
没有确认的情况下让旧文档的 chunk 消失。

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

需要所属知识库的 `document.read`。

文档详情及单文档创建/重处理响应新增可空的 `pdfTextSummary`：

```json
{ "pdfTextSummary": { "totalPages": 4, "textPages": 2, "pagesWithoutText": [2, 3] } }
```

记录最近一次成功 PDF 解析的总页数、提取到文字的页数和未提取文字的物理页码（从 1 开始，升序）。所有页均有文字时数组为空。非 PDF、历史文档无记录、解析未完成或摘要无效时为 `null`；列表不返回此字段。只读成员可读取摘要，原文件下载仍要求 `document.download`。

新重处理任务排队后立即返回 `pdfTextSummary=null`；本次解析完成后刷新。解析结果在切片/Embedding 前保存，即使全空 PDF 报 `empty_content` 或后续 Embedding 失败，也可展示已知页信息。不将未提取到文字等同于扫描件、损坏或已完成 OCR。

### GET /documents/:id/download

下载原始上传文件。需要所属知识库的 `document.download`（editor 起）。响应为文件流，设置：

```text
Content-Type: 按文件类型推断
Content-Disposition: attachment
```

存储对象不存在时返回 `DOCUMENT_FILE_NOT_FOUND`。

### GET /documents/:id/preview

预览原始上传文件。需要所属知识库的 `document.read`。

`txt` / `md` / `docx` / `xlsx` / `csv` 返回文本内容；`pdf` 返回文件预览元信息，前端可使用 `downloadUrl` 打开浏览器/PDF 预览。DOCX 内容是解析后的 Markdown 形态纯文本，不还原版式；文本预览的输入文件及解析文本各限制为 1 MiB，超出返回 `FILE_TOO_LARGE_FOR_PREVIEW`。表格额外返回 `tableRows`，见下文「表格来源与相对路径」。
DOCX 包损坏或加密导致解析失败时返回 `DOCUMENT_PREVIEW_FAILED`；上传处理任务则记录 `corrupt_file` 错误码。

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

### POST /documents/:id/replace

用新文件替换已有文档，并留下版本链。请求为 multipart/form-data：

```text
field: file
```

成功返回 **201** 和新文档（结构与 `GET /documents/:id` 相同）：替换产生的是一个有自己 id 的
新文档，客户端必须跟着新 id 看处理进度。新文档继承原文档的 `knowledgeBaseId`，文件类型与
大小按新文件计算。

替换是"新建一份 + 归档旧的"，不是原地覆盖。原地覆盖会让一次失败的重新解析毁掉本来可用的
文档：旧 chunk 已删、新 chunk 没建出来，知识库直接少一块内容。新文档走完整处理流程。
创建文档、处理任务、标记旧版（`supersededById` / `supersededAt`）和上传凭据在同一事务完成。并发替换只允许一个成功，失败者不留下额外新版。旧文档保留，可追溯，
它的 chunk 也不会被这个接口删除。

版本链只有一层活动版本：已经被替换过的文档再次替换返回 409 `DOCUMENT_ALREADY_SUPERSEDED`，
客户端应改为替换最新版本。

替换不做重复内容检测——用户已经明确表达了替换意图。

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
该查询按文档所属知识库的 `document.read` 判定，无权访问时返回
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

`total` 是当前 `type` 筛选下的总命中数。`type=all` 时，知识库和文档按更新时间、chunk 按创建时间排序，并以 ID 作为稳定次序键，再按知识库、文档、chunk 轮转输出，避免单一类型占满分页。越界页返回空 `items`，但保留真实 `total/page/pageSize`。该接口为关键词搜索；语义检索使用单库 `POST /knowledge-bases/:kbId/search` 或多库 `POST /knowledge-bases/search`。

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
  "enableKeyword": true,
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
      "keywordScore": 0.42,
      "rerankScore": 0.91,
      "startOffset": 1024,
      "endOffset": 1310
    }
  ],
  "rerankFallback": null
}
```

`startOffset` / `endOffset` 是该 chunk 主来源正文（不含标题前缀与 overlap）在规范化 segment 内的 UTF-8 字节区间：去掉开头 BOM，`\r\n` 与 `\r` 统一为 `\n`；PDF 为页内偏移。chunk 没有可用偏移时为 `null`。

结果必须按 `rerankScore` 降序排列。若关闭 Rerank，`rerankScore` 可为空，结果按进入精排的候选顺序截断到 `rerankTopK`。

`keywordScore` 是关键词召回阶段的 `ts_rank_cd` 归一化分（0–1）；关键词召回未返回该 chunk 或未启用时为 `null`。仅由关键词召回找到的 chunk `vectorScore` 为 `0`。

未传 `vectorTopN`、`rerankTopK`、`enableRerank` 或 `enableKeyword` 时，使用当前知识库持久化的 `retrievalConfig`；环境变量仅作为知识库配置缺失时的默认值。`KEYWORD_SEARCH_ENABLED=false` 时无论知识库或请求如何设置都不执行关键词召回，与 `RERANK_ENABLED` 的全局开关语义一致。服务端限制 `vectorTopN<=100`、`rerankTopK<=20`，并保证 `rerankTopK<=vectorTopN`；关键词召回同样最多取 `vectorTopN` 条，融合后再截断到 `vectorTopN`。

可选 `scoreThreshold` 为 0–1 的数值，包含显式的 0；省略或 null 使用知识库配置。覆盖值只作用于当前请求，不修改知识库；越界返回 `VALIDATION_ERROR`。

最终结果必须应用本次生效的 `scoreThreshold`：Rerank 成功时使用 `rerankScore` 判断；Rerank 关闭或 fallback 时，关键词召回关闭使用 `vectorScore` 判断，关键词召回开启使用融合分 `fusionScore` 判断（见 [RAG 规范](05-rag-pipeline.md)“混合召回与融合”）。未达到阈值的 chunk 不得进入 `items`、Prompt 或 citations。

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
    "keywordStage": {
      "status": "completed|disabled",
      "items": [
        {
          "chunkId": "uuid",
          "documentId": "uuid",
          "filename": "财务制度.pdf",
          "pageNumber": 4,
          "content": "相关片段",
          "keywordScore": 0.42,
          "rank": 1
        }
      ]
    },
    "fusionStage": {
      "status": "completed|skipped",
      "items": [
        {
          "chunkId": "uuid",
          "pageNumber": 4,
          "vectorRank": 1,
          "keywordRank": 1,
          "fusionScore": 1,
          "vectorScore": 0.78,
          "keywordScore": 0.42,
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
      "items": [{ "chunkId": "uuid", "vectorScore": 0.78, "keywordScore": 0.42, "fusionScore": 1, "rerankScore": 0.91, "rank": 1 }]
    },
    "rerankFallback": null
  }
}
```

`vectorStage.exactFallback` 为 true 表示近似索引扫描返回的候选少于 `vectorTopN` 且知识库还有更多可检索片段，本次已改用精确检索，`items` 是精确结果；未回退时省略该字段。`keywordStage` 是关键词召回的原始结果，按 `keywordScore` 降序；关键词召回未启用时 `status=disabled` 且 `items=[]`。`fusionStage` 是两路召回的 RRF 融合结果，即精排的输入；`vectorRank` / `keywordRank` 为该 chunk 在各自召回列表中的 1-based 名次，缺席一路为 `null`。关键词召回未启用时 `status=skipped`，`items` 与 `vectorStage` 顺序一致且 `fusionScore=0`。`finalStage` 的 `keywordScore` 与 `fusionScore` 在对应阶段没有分数时为 `null`。

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

## 多知识库语义检索

`POST /knowledge-bases/search` 接收 `knowledgeBaseIds`（1–5 个不重复 UUID）以及单库 SearchRequest 的全部字段。所有库逐一检查 `kb.search`，任一库不可访问则整个请求失败，鉴权全部完成后才调用模型。`GET /search` 仍是关键词全局搜索。

```json
{"knowledgeBaseIds":["kb_a_uuid","kb_b_uuid"],"query":"两个库中的规定分别是什么？","debug":true}
```

只选一个库沿用单库设置；多个库使用系统检索默认值，显式请求字段可覆盖，仍服从全局 Rerank/关键词开关与上限。每库召回向量和关键词后在库内融合，各库轮流提供候选，空库不占名额；总候选最多 `max(vectorTopN, 库数)`，再统一 Rerank、阈值过滤和 TopK。统一 Embedding，查询只向量化一次。精排失败策略沿用 strict/fallback；任何库关键词失败时全体改用向量候选，避免混用分数尺度。

返回原 SearchResponse，每个 `items` 增加 `knowledgeBaseId`、`knowledgeBaseName`。debug 的召回阶段包含各库原始候选，精排/最终阶段对应合并后的全局列表。单库接口也返回来源库字段。

## Chat

### 自动检索与手动多库会话合同（迁移 030/031）

创建增加 `scopeMode: "auto" | "manual"`。不传范围和模式（例如 `{}`）默认自动；`{"scopeMode":"auto"}` 每轮检索调用者当前拥有或具备 `chat.use` 的全部未删除知识库，支持根据问题使用不同库、后续新建/新授权的库，不受手动 5 库上限或前端列表分页限制。没有可提问库时返回 400 `VALIDATION_ERROR`。自动模式同时传入非空库 ID、未知模式均返回 400。

手动模式支持 `knowledgeBaseIds`（1–5 个不重复 UUID）；旧 `knowledgeBaseId` 继续支持。只传库 ID 时推断为 manual；明确 manual 却不传库 ID 返回 400。两个字段同时提供时，单值必须等于数组首项。逐库要求 `chat.use`，不跳过无权限库。手动范围和会话模式创建后固定，改为另一种模式/手动范围需新建对话；自动模式的本轮来源可随问题变化。

所有创建、详情、列表、重命名、归档/取消归档、恢复响应包含 `scopeMode`、`knowledgeBaseIds` 和 `knowledgeBases: [{id,name}]`。旧 `knowledgeBaseId` 保留为首选库，负责用量归属；其余库按 ID 排序返回，不具有优先回答意义。自动会话为兼容现有外键和用量模型，在创建时从可访问库中按创建时间降序、ID 升序选一个首选库；该库也是会话生命周期依赖，但不限定检索范围。自动模式的 `knowledgeBaseIds` 表示首选库与历次送入回答 Prompt 的来源库累计集合，不是本轮检索范围；本轮来源以消息 citations 为准。

自动检索在输出引用或调用回答模型前，将本轮进入 Prompt 的来源库去重追加到附加关联表，先检查当前权限。关联只增加、不因换库、编辑或重生成移除；中断/失败的生成可能留下保守的访问依赖。未进入 Prompt 且非首选库的已扫描库不成为历史依赖。单库质量/缺口视图也排除只有一个关联库的自动会话。

所有会话操作同时检查 `user_id` 和每个关联库所需能力。任一库撤权或软删除，整段会话从列表/回收站隐藏，详情、消息、发送（JSON/SSE）、反馈、编辑、重新生成和导出不可访问；会话 ID 入口统一 404 `RESOURCE_NOT_FOUND`。恢复权限/知识库后原会话可重新访问。永久删除任一关联库会删除整段跨库会话及消息，不缩小范围后保留旧历史。系统管理员不绕过这些规则。

自动模式（即使当前仅一个库）和手动跨库问答使用系统检索参数、默认 Chat 模型和严格依据规则（自动语言、禁止常识补充），不合并单库提示词、模型或阈值。手动单库问答继续沿用该库配置。统一精排后的片段是唯一引用来源；citations 增加 `knowledgeBaseId`、`knowledgeBaseName`，旧历史引用可缺失。导出列出全部库和引用所属库；同名文档按库、文档 ID、片段 ID 区分。

跨库 intent/answer/title 用量只计入首选库一次，用户/模型/用途统计不重复；不是每库成本分摊。单库质量概览、负反馈列表、知识缺口和从缺口保存评测的入口排除跨库会话，避免向单库管理者暴露其他库资料。评测运行仍以单库为单位。跨库会话活动使用通用名称“跨库会话”，不把问题生成的标题复制到活动记录。


### POST /chat/sessions

请求：

```json
{
  "knowledgeBaseId": "kb_uuid",
  "title": "报销制度咨询"
}
```

`title` 可为空，初始显示“新会话”。首次问题通过普通或流式接口保存后，先以问题正文的简短摘要命名，再由独立 `TITLE_*` AI API 仅根据首次提问提炼标题，不使用助手回答、不复用 Chat Provider。摘要合并空白，超长内容截取前 29 个字符并附省略号；标题模型最多等待 5 秒，失败或取消保留摘要。已保存的检索失败记录遵循相同规则，未保存的请求不命名。

已有自定义名称、后续提问、重试已完成的请求、重新生成和编辑消息均不触发命名。自动写入会检查名称和更新时间，模型运行期间的手动重命名优先。发送完成后，客户端重新读取会话列表以获得 `title` 和 `updatedAt`。

### GET /chat/sessions

只返回当前用户会话，并要求全部关联知识库仍存在且当前用户具有 `chat.use`。

查询参数：

```text
GET /chat/sessions?knowledgeBaseId=&archived=false&q=&page=1&pageSize=20
```

- `knowledgeBaseId`：筛选范围包含该库的会话（含作为附加库的跨库会话），缺省返回全部
- `archived`：`false`（默认）只返回未归档会话，`true` 只返回已归档会话；不支持一次返回两者
- `q`：按会话标题模糊匹配，不检索消息内容（消息内容检索走 `GET /chat/messages/search`）
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

返回当前用户的单个会话。必须校验 session 属于当前用户，且对每个关联知识库均具有 `chat.use`。

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

**软删除**当前用户会话，会话进入聊天回收站。必须校验 session 属于当前用户，且对每个关联知识库均具有 `chat.use`。

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

归档当前用户会话。必须校验 session 属于当前用户，且对每个关联知识库均具有 `chat.use`。归档后默认 `GET /chat/sessions` 不再返回该会话，但 `GET /chat/sessions/:id` 仍可查看详情并返回 `archivedAt`。该接口幂等。

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

归档的反向操作，把会话放回默认列表。必须校验 session 属于当前用户，且对每个关联知识库均具有 `chat.use`。该接口幂等：对未归档会话调用直接返回当前会话。

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

必须校验 session 属于当前用户，且对每个关联知识库均具有 `chat.use`。

不带分页参数时兼容返回完整历史 `{items}`。携带下表任一参数时启用游标分页，消息按 `(createdAt, id)` 升序返回；默认读取最新一页，也可直接读取指定消息附近的窗口。

| 参数 | 约定 |
| --- | --- |
| `limit` | 1–100 的整数，分页时默认 50；显式空值、非整数和越界值返回 400 `VALIDATION_ERROR`。这是消息数软上限，页首会向前扩展到所属 user 问题，保留该轮全部回答版本；旧数据开头的孤立 assistant 组也保持完整。 |
| `before` | 上一页的 `nextCursor`，读取游标之前的消息，不包含游标消息。 |
| `after` | 上一页的 `newerCursor`，向后读取，不包含游标消息；页尾扩展到该轮全部回答版本。 |
| `around` | 当前会话内目标消息 UUID，读取目标前后合计约 `limit` 条，再把窗口两端扩展到完整问题/回答版本组。目标不存在或属于其他会话时返回 404 `CHAT_MESSAGE_NOT_FOUND`；会话本身无权访问时仍返回 `RESOURCE_NOT_FOUND`。 |
| `since` | 从已加载最早消息的游标开始刷新到当前末尾，包含游标消息，不截断到 `limit`；与 `before` 互斥。用于发送、编辑等操作后的已加载范围刷新。 |
| `revision` | 最新消息 ID，向前或向后续页时应回传上一响应的值。若会话末尾已变化，返回 409 `CHAT_MESSAGE_CHANGED`，客户端重新加载会话。 |

`before`、`after`、`around`、`since` 互斥。向前、向后续页均应回传 `revision`；`around` 是重新定位，可省略 revision 读取当前版本。

分页响应为 `{items, hasMore?, nextCursor?, hasNewer?, newerCursor?, revision?}`：`hasMore` / `hasNewer` 分别表示窗口前/后仍有消息，缺省等同 `false`。非空页始终返回窗口首尾游标 `nextCursor` / `newerCursor`，首游标也供 `since` 刷新；空历史省略游标和 revision。游标是不透明的 Base64URL 值，绑定会话，客户端应原样回传；格式不合法或属于其他会话返回 400。`since` / `after` 对应的消息已被编辑删除时返回 409；读取期间检测到末尾变化也返回 409。

每次分页、范围刷新和全量读取均重新执行相同权限检查；知识库成员身份不能赋予读取其他用户会话的权限。分页只限制历史展示读取，不改变模型上下文预算、发送幂等规则或全量 Markdown 导出。前端搜索和深链接使用局部窗口；跨刷新未知写操作对账仍按需全量读取。

消息项包含 `clientRequestId`；历史消息或 regenerate 产生的 assistant 消息可为 `null`。客户端用该字段确定性核对发送结果，不得按消息数量或文本相等推测。

每条消息都固定返回 `feedback`。未评价消息和 user 消息为 `null`；已评价的
assistant 消息为 `{ "messageId", "rating", "reason", "comment", "updatedAt" }`。消息列表、阻塞发送、
流式 `done` 和 regenerate 返回的消息均使用同一结构。

### GET /chat/messages/search

关键词搜索当前用户全部可访问的提问与回答，包括已归档会话和历史回答版本，每条消息只返回一个命中。已软删除会话、已删除/撤权的任一依赖知识库，以及其他用户的会话均不可见；计数和结果使用同一权限条件，系统管理员也不能读取他人的消息。

| 参数 | 说明 |
| --- | --- |
| `q` | 必填，去掉首尾空白后 1–200 字符。正文子串匹配，不区分大小写，`%`、`_`、`!` 等按字面处理，不是正则或语义检索。 |
| `sessionId` | 可选 UUID，仅搜索该会话；逐库检查 `chat.use` 及 `user_id`，不可访问返回 404 `RESOURCE_NOT_FOUND`。 |
| `page` | 默认 1，整数范围 1–1000000。 |
| `pageSize` | 默认 20，整数范围 1–100。 |

返回 `{items, total, page, pageSize}`。每项包含 `messageId`、`sessionId`、`sessionTitle`、`archivedAt`（未归档为 null）、`role`、`createdAt` 和 `excerpt: {before, match, after}`。摘录只围绕正文首次命中，保留原大小写，前后最多 40/80 字符，截断处加省略号；三个字段均为纯文本，客户端不得作为 HTML 注入。数据库语言排序规则与应用 Unicode 转换存在差异时可返回无高亮的短摘录。不会返回整条长正文或引用元数据。

跨会话按消息 `(createdAt, messageId)` 倒序；指定会话时按相同键升序，供上一条/下一条查找使用。越界页保留总数并返回空数组。结果不是持久快照；点击命中后通过该会话 `messages?around=<messageId>&limit=50` 重新读取上下文与权限，已删除的消息局部提示，不把它误当作整段会话撤权。

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
  "reason": "",
  "comment": "",
  "updatedAt": "2026-08-12T10:00:00Z"
}
```

差评可追加 `reason` 和 `comment`，例如：

```json
{ "rating": "negative", "reason": "missing_evidence", "comment": "缺少退货政策的引用依据。" }
```

`reason` 允许空值（兼容旧客户端）、`inaccurate`（不准确）、`missing_evidence`（缺少依据）、
`irrelevant`（答非所问）、`incomplete`（不完整）、`other`（其他）；`comment` 去除首尾空白后最多 1000 字。
未知原因或超长说明返回 `VALIDATION_ERROR`。好评清空原因与说明。负反馈列表也返回这两个字段；
修改反馈沿用当前用户会话所有权与 `feedback.write` 检查。

### POST /chat/sessions/:id/messages

本接口、流式版本和 regenerate 共用按当前用户 ID 的一分钟固定窗口，默认合计每分钟 30 次。鉴权先于用户限流，因此无效 token 仍返回 401；超限响应遵循上面的 `429 RATE_LIMITED` 契约。

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
    "answerStatus": "answered",
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
      "rerankScore": 0.93,
      "startOffset": 2048,
      "endOffset": 2210
    }
  ],
  "rerankFallback": null
}
```

citation 的 `startOffset` / `endOffset` 与检索结果同义，随消息持久化；2026-09-26 之前保存的 citation 没有这两个字段（省略），客户端须能回退到按内容匹配。

`answerStatus` 是封闭集合，值域由 migration 019 的 CHECK 约束固定：

| 值 | 含义 | 用户该做什么 |
| --- | --- | --- |
| `answered` | 正常回答 | — |
| `no_basis` | 知识型提问，检索成功但没有命中，用固定拒答文案 | 补充相关文档 |
| `retrieval_failed` | 检索本身失败（向量化失败、DB 失败） | 稍后重试；与知识库资料无关 |
| `model_refused` | 有引用但模型仍然拒答 | 与知识库资料是否齐全无关 |

user 消息恒为 `null`。**019 之前的 assistant 消息也是 `null`**：客户端必须把 `null` 当作
「未知」而不是 `answered`，否则会静默地把历史回答重新标注一遍。历史数据不回填，理由见
`GET /chat/quality/knowledge-gaps`。

`model_refused` 依赖模型遵从 system prompt 里的固定标记：识别不到标记就算 `answered`。这是
故意的取舍——启发式会把「根据资料，X 不适用于 Y」这种正常回答误判成拒答，宁可少报不可误报。
因此这一类**天然偏少报**，计数是下限而不是真实值。

`retrieval_failed` 是本阶段新增的行为：这种情况此前直接冒泡成 HTTP 错误，会话里什么都不留，
用户刷新后连自己问过什么都看不到。现在先写一条带用户可读文案的 assistant 消息，再返回错误。

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

**事件顺序是 `citations` → `delta`* → `done`**。citations 来自进入 Prompt 的 chunks，在检索结束时已经确定；先发送来源，再发送正文，可让前端在首个 token 到达前展示依据，并区分检索与生成阶段。

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

## Chat 质量运营

三个接口共用同一套范围规则：只统计当前用户自己的会话，会话和知识库都必须未软删除，
且只统计 `role = 'assistant'` 的消息。`period` 只接受 `day` 或 `month`（默认
`month`），`day` 指今天零点至现在，`month` 指本月一号零点至现在。可选
`knowledgeBaseId` 必须属于当前用户，否则返回 `KNOWLEDGE_BASE_NOT_FOUND`。

### 意图与检索式落库

从 migration 018 起，assistant 消息保存三个新列：

- `intent`：`conversation` 或 `knowledge_base`，即本轮意图分类结果。
- `retrieval_query`：知识型提问实际使用的检索式（改写后的独立问题）。会话类回答不写。
- `retrieval_query_norm`：`retrieval_query` 归一化后的聚类键（小写、去标点、去空白）。

018 不回填历史数据：迁移前的回答无法判断当时的意图，写入任何值都是编造。因此历史行
`intent` 为 `NULL`，被所有按意图口径统计的指标排除，并单独通过
`unclassifiedAnswerCount` 披露。

### GET /chat/quality/overview

```json
{
  "period": "month",
  "startAt": "2026-08-01T00:00:00Z",
  "endAt": "2026-08-30T10:00:00Z",
  "answerCount": 120,
  "feedbackCount": 40,
  "positiveFeedbackCount": 30,
  "negativeFeedbackCount": 10,
  "knowledgeAnswerCount": 90,
  "withoutCitationsCount": 12,
  "unclassifiedAnswerCount": 8,
  "feedbackCoverage": 0.33,
  "positiveRate": 0.75,
  "withoutCitationsRate": 0.13
}
```

口径：

- `answerCount`：范围内全部 assistant 回答，不区分意图。
- `feedbackCoverage` = `feedbackCount / answerCount`，`positiveRate` =
  `positiveFeedbackCount / feedbackCount`，分母为 0 时返回 0。
- `knowledgeAnswerCount`：`intent = 'knowledge_base'` 的回答数。
- `withoutCitationsCount`：`intent = 'knowledge_base'` 且 citations 为空
  （`''`、`null`、`[]` 三种落库形态都算空）的回答数。
- `withoutCitationsRate` = `withoutCitationsCount / knowledgeAnswerCount`，分母为 0 时返回 0。
- `unclassifiedAnswerCount`：`intent IS NULL` 的回答数。这些行不计入
  `knowledgeAnswerCount`、`withoutCitationsCount` 和 `withoutCitationsRate`。

**兼容性变更**：`withoutCitationsCount` 之前统计所有 citations 为空的回答，包含会话类
回答。会话类回答按设计就没有引用（见上文多轮上下文规则第 5 条），把它们算成引用缺口是
错的，所以该字段现在要求 `intent = 'knowledge_base'`。对同一批数据，新值通常低于旧值。

### GET /chat/quality/negative-feedback

按最近评价时间倒序返回负反馈回答，保留原问题、回答、引用和 rerank 降级证据。

查询参数：`period`、`knowledgeBaseId`、`hasCitations`、`page`（默认 1）、
`pageSize`（默认 20，上限 100）。`hasCitations` 只接受 `true` 或 `false`，其他值返回
`VALIDATION_ERROR`；不传表示不按引用过滤。这里的 `hasCitations=false` 不看 `intent`，
它筛的是「这条负反馈有没有证据可查」，与概览的引用缺口口径无关。

```json
{
  "items": [
    {
      "messageId": "assistant_message_uuid",
      "sessionId": "session_uuid",
      "sessionTitle": "退货政策",
      "knowledgeBaseId": "kb_uuid",
      "knowledgeBaseName": "产品知识库",
      "question": "如何退货？",
      "answer": "请在三十天内申请。",
      "citations": [],
      "rerankFallback": { "used": true, "reason": "provider timeout" },
      "createdAt": "2026-08-10T00:00:00Z",
      "feedbackUpdatedAt": "2026-08-11T00:00:00Z"
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20
}
```

`question` 优先按 `clientRequestId` 配对同一轮的 user 消息，配不上时回退到时间上最近的
前一条 user 消息，都找不到时返回空字符串。

### GET /chat/quality/knowledge-gaps

返回知识库回答不好的问题，供运营决定补哪些资料。

查询参数：`period`、`knowledgeBaseId`、`category`、`page`（默认 1）、`pageSize`
（默认 20，上限 100）。`category` 只接受 `no_citations`、`retrieval_failed`、
`model_refused`、`repeated_rewrite`，或不传（等于四类合并）。传入其他值返回
`VALIDATION_ERROR`，不会退化成「全部」——把未知筛选条件当成全部，会让调用方看到一个并非
自己请求的列表。

四个类别，第二、三类来自 `chat_messages.answer_status`（migration 019），第一类按引用判定，第四类是聚类：

1. `no_citations`：知识型回答（`intent = 'knowledge_base'`）且 citations 为空，`answer_status`
   不是 `retrieval_failed` / `model_refused`（包括 `no_basis`、019 之前没有状态的行）。即检索
   没有命中、用了固定拒答文案，或检索命中却没有进入回答的引用。**补文档能解决。**
2. `retrieval_failed`：`answer_status = 'retrieval_failed'`，检索本身失败（向量化失败、DB
   失败）。**补文档解决不了**，要查的是服务状态，所以必须和上一类分开。
3. `model_refused`：`answer_status = 'model_refused'`，有引用但模型仍然拒答。同样与知识库
   资料是否齐全无关。
4. `repeated_rewrite`：同一会话内 `retrieval_query_norm` 相同的回答被分到一组，组内
   条数 >= 2 才算一个缺口。归一化会去掉大小写、标点和空白，所以「退货 政策」和
   「退货政策」属于同一组（中文分词空格不稳定，保留空白会把同一个问题拆成两组）。

不传 `category` 时四类**顺序拼接**返回，不按时间交错：前三类是单条回答，第四类是聚类，
不是可比较的单位，按时间混排会让分页里出现语义不一致的相邻行。

`answer_status` 是 019 之后才写入的，**019 之前的行没有状态**。这些行留在 `no_citations`
里，所以 `retrievalFailedTotal` / `modelRefusedTotal` 为 0 只表示「尚未观察到」，不表示
「从未发生」。历史数据不回填：无法从已有列推断当时到底是检索失败还是没有命中，猜出来的
分类比空着更糟。

`repeated_rewrite` 只统计 `client_request_id IS NOT NULL` 的回答，即排除 regenerate：
只有发送路径会写 `client_request_id`，为空说明用户是在同一个问题上要求重新生成，而不是
换了说法再问。把重新生成算成改写，会把「我想要更好的回答」误报成「知识库答不上来」。

```json
{
  "items": [
    {
      "category": "no_citations",
      "messageId": "assistant_message_uuid",
      "sessionId": "session_uuid",
      "sessionTitle": "退货政策",
      "knowledgeBaseId": "kb_uuid",
      "knowledgeBaseName": "产品知识库",
      "question": "支持跨境退货吗？",
      "retrievalQuery": "跨境退货",
      "occurrenceCount": 1,
      "ungroundedCount": 1,
      "firstSeenAt": "2026-08-12T00:00:00Z",
      "lastSeenAt": "2026-08-12T00:00:00Z"
    },
    {
      "category": "repeated_rewrite",
      "messageId": null,
      "sessionId": "session_uuid",
      "sessionTitle": "发票问题",
      "knowledgeBaseId": "kb_uuid",
      "knowledgeBaseName": "产品知识库",
      "question": "发票要求",
      "retrievalQuery": "发票要求",
      "occurrenceCount": 3,
      "ungroundedCount": 2,
      "firstSeenAt": "2026-08-13T00:00:00Z",
      "lastSeenAt": "2026-08-14T00:00:00Z"
    }
  ],
  "total": 2,
  "page": 1,
  "pageSize": 20,
  "noCitationsTotal": 1,
  "retrievalFailedTotal": 0,
  "modelRefusedTotal": 0,
  "repeatedRewriteTotal": 1
}
```

字段说明：

- `messageId`：`no_citations` 为具体回答 ID；`repeated_rewrite` 是聚类，跨多条回答，
  固定为 `null`。前端需要用「会话 + 归一化问题」而不是 `messageId` 作为列表 key。
- `question`：`no_citations` 用同一轮的用户原问题（解析规则同负反馈接口）；
  `repeated_rewrite` 用组内 `MIN(retrieval_query)`。组内成员归一化后相同，彼此只差
  大小写、标点和空白，取任意一条都能代表，`MIN` 只是让结果确定。
- `occurrenceCount`：`no_citations` 恒为 1；`repeated_rewrite` 为组内回答条数。
- `ungroundedCount`：其中 citations 为空的条数。
- `messageId`：`retrieval_failed` 与 `model_refused` 同 `no_citations`，是具体回答 ID。
- `occurrenceCount`：`retrieval_failed` 与 `model_refused` 同 `no_citations`，恒为 1。
- `noCitationsTotal` / `retrievalFailedTotal` / `modelRefusedTotal` /
  `repeatedRewriteTotal`：无论请求哪个 `category` 都返回，方便调用方标注筛选器而不必再发
  一次请求。后两个计数只覆盖 019 之后的数据，见上文。

排序与分页：`no_citations` 按 `created_at DESC, id DESC`；`repeated_rewrite` 按
`last_seen_at DESC, session_id DESC, retrieval_query_norm ASC`。两者都以完整的组键或
主键收尾，保证是全序——同一次请求写入的多条回答可能共享时间戳，只按时间排序会让相邻
两页重复或漏掉数据。不传 `category` 时，响应是两个列表的拼接（先 `no_citations`），
分页在拼接后的序列上进行。

未分类（`intent IS NULL`）的历史回答不会出现在任何类别中。

## 回答质量回归评测

以下路径均在 `/api/v1` 下。每个接口校验知识库的 `quality.read` 权限；创建运行与执行每道题还校验
`chat.use`。资源 id 必须属于路径中的知识库，无权限访问的知识库和跨库资源不返回内容。

### 测试问题集

| 方法与路径 | 行为 |
| --- | --- |
| `GET /knowledge-bases/:id/evaluation-cases` | 返回 `{ "items": [...] }`，按创建时间倒序，最多 200 题 |
| `POST /knowledge-bases/:id/evaluation-cases` | 创建问题，返回 201 与问题对象 |
| `PUT /knowledge-bases/:id/evaluation-cases/:caseId` | 替换问题和规则，返回 200 与问题对象 |
| `DELETE /knowledge-bases/:id/evaluation-cases/:caseId` | 删除问题，返回 204；历史运行快照保留 |

创建和修改请求：

```json
{
  "question": "未拆封产品签收后几天内可退货，需要提供什么？",
  "expectedAnswer": "签收后 7 天内，提供订单号。",
  "requiredKeywords": ["7", "订单号"],
  "requireCitation": true
}
```

返回对象追加 `id`、`knowledgeBaseId`、`createdAt`、`updatedAt`。问题去首尾空白后为 1–4000 字，
参考答案最多 8000 字；关键词最多 20 个，每个去首尾空白后为 1–100 字，忽略大小写去重。
省略关键词视为空数组，省略 `requireCitation` 为 false。参考答案只用于人工核对。
每个知识库最多 200 题；超过上限返回 409 `EVALUATION_LIMIT`。编辑不能改变问题所属知识库。

### 评测运行

| 方法与路径 | 行为 |
| --- | --- |
| `POST /knowledge-bases/:id/evaluation-runs` | 异步创建，返回 202 与完整运行对象；重试返回同一运行 |
| `GET /knowledge-bases/:id/evaluation-runs` | 返回 `{ "items": [...] }`，最近 50 次摘要，省略 cases/results |
| `GET /knowledge-bases/:id/evaluation-runs/:runId` | 返回运行详情、问题快照和已完成题目的结果 |
| `POST /knowledge-bases/:id/evaluation-runs/:runId/cancel` | 返回 200 与当前状态；重复取消或已结束运行保持原状态 |

创建请求：

```json
{
  "clientRequestId": "00000000-0000-4000-8000-000000000001",
  "name": "基准配置",
  "caseIds": ["00000000-0000-4000-8000-000000000002"],
  "config": { "vectorTopN": 30, "rerankTopK": 5, "scoreThreshold": 0.3, "enableRerank": true, "enableKeyword": true }
}
```

`clientRequestId` 必须是非零 UUID，同一知识库、用户、请求编号下，规范化后的名称、题目 id 集合、
配置相同则返回原运行；不同则返回 409 `EVALUATION_REQUEST_CONFLICT`。空名称默认「回归评测」，最长 80 字。
题目 id 不可重复，每次 1–20 题，必须全部属于当前知识库。配置要求 `vectorTopN` 为 1–100、
`rerankTopK` 为 1–20 且不大于召回数量、`scoreThreshold` 为 0–1。
同库同时最多 3 个 queued/running 运行，超过返回 409 `EVALUATION_LIMIT`。
问题和配置在创建时保存快照，后续修改或删除测试问题不会改变已创建的运行。

运行对象字段：

| 字段 | 含义 |
| --- | --- |
| `id`, `knowledgeBaseId`, `clientRequestId`, `name` | 标识和运行名称 |
| `status` | queued / running / completed / failed / cancelled |
| `config` | 请求的检索配置快照，不修改知识库默认配置 |
| `answerConfig` | 创建时知识库 `answerConfig` 的快照；之后修改知识库不影响该运行，对比页据此展示配置差异 |
| `runtime` | `chatModel`、`embeddingModel`、`rerankModel`、`effectiveRerank`；执行前模型字段为空 |
| `cases` | 详情包含完整问题快照，含 question、expectedAnswer、requiredKeywords、requireCitation |
| `results` | 详情中的已完成题目结果；尚无结果时可省略 |
| `total`, `completedCount` | 总题数、已有结果数；已有结果数包含调用失败 |
| `errorMessage` | 运行级中断原因；正常运行为空 |
| `createdAt`, `startedAt`, `finishedAt` | 创建、开始、结束时间；尚未开始/结束时为 null |

每题结果包含 `caseId`、`answer`、`answerStatus`、`citations`、`rerankFallback`、`durationMs`、
`rulePassed`、`missingKeywords`、`errorCode`、`errorMessage`。`answerStatus` 与聊天共用状态，
引用只能来自本次检索进入 Prompt 的片段；失败时 `answerStatus`、`rulePassed` 为 null，答案为空，引用为空数组。

- 配置了规则时，关键词按不区分大小写的字面子串检查，缺少的词写入 `missingKeywords`。
  所有关键词满足、要求引用时存在引用且 `answerStatus=answered`，才返回 `rulePassed=true`。
- 无关键词也不要求引用时，`rulePassed=null`，交由人工核对；参考答案不参与自动评分。
- Provider 失败保留稳定的 `errorCode` 和用户消息，`rulePassed=null`，不得计作规则未通过。
  一次运行的 `completed` 表示每题均尝试完成，可能仍有题目调用失败。
- 后台按题顺序执行，每题总超时 90 秒；每 5 秒续租/检查取消。取消保留已完成结果，停止后续问题，
  迟到结果不能覆盖取消状态。失联超过 2 分钟的 running 运行标记 failed，不自动重放外部调用。
- 评测复用聊天生成流程，但不创建会话、消息或影响聊天质量统计。运行使用当时的知识库内容，
  不冻结文档版本；历史结果和来源标识按运行保存。
- 配置对比在客户端进行，只统计同一 caseId 且问题、参考答案、关键词规则、引用要求相同的共同样本。
  规则通过、含引用回答、调用失败和耗时分别展示，不把规则通过率解释为事实正确率。

评测写请求体上限 128 KiB。格式、字段或 UUID 不合法返回 `VALIDATION_ERROR`；不存在的测试问题/运行返回
`RESOURCE_NOT_FOUND`，不可访问的知识库返回 `KNOWLEDGE_BASE_NOT_FOUND`，可读但角色不足返回 403。
既有环境先执行 `021_quality_evaluations.sql`，再重启服务启用评测 worker。

## 系统诊断

两个接口：`GET /healthz`（含 `/api/v1/healthz`，无需认证）与
`GET /api/v1/system/diagnostics`（需要登录且当前系统角色为 `admin`）。

### 不返回什么

这是接口契约的一部分，不是实现细节：

- 不返回任何密钥、连接串、DSN、Base URL、主机名、端口或 bucket 名。
- 不返回驱动或 Provider 的原始错误文本。所有失败都被压缩成下面的封闭原因集合。
- Provider 只返回模型名，不返回 Base URL：模型名能帮运维定位配置错误，Base URL 属于
  部署拓扑。

原始错误会以 `WARN` 完整写入服务端日志。约束限制的是 HTTP 响应，不是运维自己的日志，
而日志才是真正能读到根因的地方。

封闭原因集合（`reason`、`lastFailureReason`）：

```text
timeout | unreachable | auth_rejected | not_configured | not_found | unavailable
```

前端按代码映射中文文案，未识别的代码回落到中性文案，不回显原始代码。

### GET /healthz

始终返回 `200`，即使依赖不可用。这是存活探针而不是就绪探针：`503` 会让
Kubernetes livenessProbe 重启容器，而重启 API 不会让 Redis 恢复，只会在故障上再叠一层
故障。真实状态放在响应体里。

因为该接口无需认证，响应体只有依赖名和状态，没有 `reason`、没有耗时、没有计数。未配置
的依赖直接省略。

```json
{
  "status": "ok",
  "env": "production",
  "dependencies": { "database": "ok", "redis": "ok", "storage": "ok" }
}
```

### GET /api/v1/system/diagnostics

通过管理员鉴权后，依赖故障仍返回 `200`，调用方通过响应中的 `status` 判断依赖状态。鉴权先于全部诊断探针：无有效登录或账号已删除返回 `401 UNAUTHORIZED`，普通用户及未知系统角色返回 `403 SYSTEM_ADMIN_REQUIRED`，管理员身份查询失败或超过 2 秒返回脱敏的 `500 INTERNAL_ERROR`，不继续执行诊断。

`status` 取所有依赖状态里最差的一个。`not_configured` 不会拉低整体状态；标准部署会配置 Redis，因为限流和 query embedding 缓存都使用它。

```json
{
  "status": "degraded",
  "checkedAt": "2026-08-30T10:00:00Z",
  "env": "production",
  "dependencies": [
    { "name": "database", "status": "ok", "reason": "", "latencyMs": 3 },
    { "name": "redis", "status": "down", "reason": "unreachable", "latencyMs": 2001 },
    { "name": "storage", "status": "not_configured", "reason": "not_configured", "latencyMs": null }
  ],
  "queues": {
    "documents": {
      "pending": 2, "running": 1, "failed": 4, "completed": 30, "cancelled": 0,
      "oldestPendingSeconds": 125, "oldestRunningSeconds": 8,
      "failureWindowHours": 24, "finishedInWindow": 10, "failedInWindow": 2,
      "recentFailureRate": 0.2
    },
    "cleanup": { "backlog": 3, "retrying": 1, "locked": 0, "oldestPendingSeconds": 3600 }
  },
  "providers": [
    {
      "name": "chat", "configured": true, "model": "gpt-4.1-mini", "status": "ok",
      "lastSuccessAt": "2026-08-30T09:59:00Z", "lastFailureAt": null,
      "lastFailureReason": "", "successCount": 128, "failureCount": 0, "recentFailures": 0
    }
  ],
  "latency": [
    { "metric": "retrieval", "count": 128, "sampleCount": 128, "p50Ms": 120, "p95Ms": 300, "maxMs": 800 }
  ],
  "rerankFallbacks": { "provider_unavailable": 4 },
  "rateLimitTriggers": { "login": 3, "chat": 7 },
  "embeddingCache": { "hits": 80, "misses": 20, "errors": 1, "hitRate": 0.8 },
  "vectorSearch": { "pgvectorVersion": "0.5.1", "iterativeScan": false, "exactFallbacks": 2 },
  "metricsSinceRestart": true
}
```

字段口径：

- `dependencies` 只有三项：`database`、`redis`、`storage`。每个探针独立超时 2 秒并并发
  执行。诊断页最有用的时刻恰好是依赖卡住的时刻，所以探针必须快速失败。
- `latencyMs` 是本次探针耗时；未探测的依赖为 `null`。
- 存储探针是只读的，与启动时的 `EnsureReady` 分开：`EnsureReady` 会创建 bucket 并写
  策略，放在 HTTP 处理器后面会让一次带认证的 GET 重建运维故意删掉的 bucket。
- `oldestRunningSeconds` 从 `locked_at` 起算，不从 `created_at` 起算：排队一小时、一秒
  前才开始执行的任务不是卡住的任务。
- `recentFailureRate` 在窗口内没有已完成任务时为 `null`。`null` 与 `0` 是不同的答案，
  前端显示"暂无数据"而不是 0%。
- `failureWindowHours` 固定为 24，按 `updated_at` 统计 `completed` 与 `failed`。
- `rateLimitTriggers` 只统计真正返回 429 的请求，Redis 故障导致的 closed 拒绝不计入；键固定为 `login` / `chat`，未触发的键可缺省。
- `embeddingCache.hitRate = hits / (hits + misses)`；缓存错误单独计数，不进入分母。进程尚未发生缓存查询时为 `null`。
- `vectorSearch.pgvectorVersion` 为数据库中 `vector` 扩展的版本，读取失败或非 PostgreSQL 时为空字符串；`iterativeScan` 在 0.8.0 及以上为 true；`exactFallbacks` 为本进程内向量召回因索引扫描返回不足而改用精确检索的次数（见 RAG 规范“pgvector 查询约束”）。

### Provider 为什么不做探测

`configured` 表示同时配置了 key 和模型名，`status` 与计数来自真实业务流量，而不是探测
请求。

OpenAI 兼容接口里没有免费的 ping。为了检查而发一次 completion，等于每次打开诊断页都
让运维付一次钱，而且测出来的延迟不是真实请求的延迟。所以这里报告的是配置完整性加上真
实调用观察到的健康度。

`recentFailures > 0` 只把 Provider 标成 `degraded` 而不是 `down`：记录器只能看见流量，
既有近期失败又有近期成功的 Provider 是不稳定，完全没有流量的 Provider 是未知，两者都不
足以断言它已经挂了。

`rerank` 即使被关闭也会返回一行（`status: not_configured`）：运维要区分的正是"重排坏
了"和"重排没开"，省掉这一行等于两个问题都不回答。

### 指标是进程内的

`latency`、`rerankFallbacks`、`rateLimitTriggers` 与 `embeddingCache` 都是进程内指标（耗时每项最多保留 512 个样本），服务重启后归零，多实例部署下每个实例各报自己的数据。分位数用 nearest-rank，
`sampleCount` 是实际参与计算的样本数，会小于 `count`。

这是刻意的取舍：把每次检索和生成都写库会给热路径加一次写入，并需要一张随流量无限增长
的表。持久化留给日志。`metricsSinceRestart` 恒为 `true`，留作未来接入持久化存储时不破
坏契约的开关。前端明确写出这一点，而不是暗示它是历史全量数据。

### 系统管理员鉴权与初始化

系统角色取自 `users.role`，仅精确值 `admin` 可访问诊断。知识库 `manager` 或 `owner` 不等同于系统管理员；系统管理员也不能绕过知识库权限与会话归属校验。

登录签发的 JWT 带 `role` 快照，但诊断中间件每次请求查询数据库中的当前角色。因此提升、降权和删除账号立即影响已有 token；旧版不带 `role` 的有效 token 仍可登录，并按数据库角色授权。前端通过当前用户接口控制诊断入口，普通用户直达诊断页面显示权限说明，不请求诊断内容；客户端显示不替代服务端鉴权。

首位管理员仅通过运维 CLI 初始化：`go run ./cmd/bootstrap-admin -username <现有账号>` 保留原密码与资料并提升指定用户。新部署需设置 `BOOTSTRAP_ADMIN_PASSWORD`，再显式加 `-create` 创建账号。已有其他管理员时拒绝初始化，重复指定同一管理员不修改数据；`cmd/seed` 仍只创建普通用户。无公开 HTTP 初始化接口、默认管理员密码或自动授予首位登录者权限。步骤见 [部署指南](13-deployment.md#74-初始化系统管理员)。

`GET /api/v1/system/capabilities` 仍对普通登录用户可用，`/healthz` 及 `/api/v1/healthz` 仍无需登录；密钥、部署拓扑和原始错误的响应保护约束保持适用。

## AI 开发约束

1. API 字段使用 camelCase。
2. 数据库字段使用 snake_case。
3. 任何知识库相关接口必须走能力矩阵判定，不要在 repository 里写 `owner_id = ?`。
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

永久删除当前用户 owner 的、已在回收站中的知识库，并清理关联文档、chunks、chat sessions、成员、收藏、浏览和标签绑定。关联文件对象通过同事务写入的持久化清理任务异步删除；存储临时失败会重试，不影响数据库删除的原子性。

### POST /knowledge-bases/recycle-bin/empty

清空当前用户 owner 的知识库回收站，采用 all-or-nothing 语义。

知识库回收站刻意保持 owner 独有，不走能力矩阵：`kb.delete` 本来就只有 owner，而回收站
是 owner 的私有空间——manager 对躺在里面的知识库应该拿到 404，而不是一个「确认它在那里」
的 403。恢复与批量永久删除同理。

### GET /documents/recycle-bin

返回调用者在有 `content.write` 的知识库下的已删除文档，跨知识库聚合。

### POST /documents/:id/restore

恢复已删除文档。需要所属知识库的 `content.write`。

### DELETE /documents/recycle-bin/:id

永久删除已在回收站中的文档，需要所属知识库的 `content.purge`（manager 起），并清理 chunks 和处理任务。文件对象通过同事务写入的持久化清理任务异步删除。

### POST /documents/recycle-bin/empty

清空调用者有 `content.purge` 的知识库下的文档回收站，数据库删除与全部对象清理任务采用 all-or-nothing 事务语义；对象由后台 worker 删除并在失败时持续重试。

注意列出与清空用的是两个不同能力：editor 看得到自己删掉的文档并能恢复，但清空要 manager。

## P1 权限设置扩展

- 新增 `GET /knowledge-bases/:id/permissions`
- 新增 `PUT /knowledge-bases/:id/permissions`
- 新增 `GET /users/search`
- 新增 `POST /knowledge-bases/:id/members`
- 新增 `PUT /knowledge-bases/:id/members/:userId`
- 新增 `DELETE /knowledge-bases/:id/members/:userId`
- `owner` 始终来自 `knowledge_bases.owner_id`，成员表只保存 `manager` / `member`
- owner 和 manager 可管理成员；owner 不能被删除或降级
- P2 已把成员角色改为 `viewer` / `editor` / `manager`，见「权限与能力矩阵」

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

## P2 首次使用与知识库质量

- 新增 `POST /documents/:id/replace`（201 + 新文档，旧文档标记 `supersededById`）
- `POST /documents` 与 `POST /knowledge-bases/:kbId/documents` 新增 `allowDuplicate` 表单字段
- 内容重复返回 409 `DOCUMENT_DUPLICATE_CONTENT`，`details` 点名冲突文档
- 替换已被替换过的文档返回 409 `DOCUMENT_ALREADY_SUPERSEDED`
- 文档响应新增 `errorCode`、`supersededById`、`supersededAt`、`isStale`、`staleAfterDays`
- 会话消息新增 `answerStatus`，`GET /chat/knowledge-gaps` 的 `category` 扩展到四类
- `errorCode` 与 `answerStatus` 都是封闭集合；`errorCode` 的 CHECK 已由迁移 039 扩充，`answerStatus` 保持迁移 019 的约束

## P2 权限与协作

- 成员角色从 `manager` / `member` 改为 `viewer` / `editor` / `manager`；migration 020
  把既有 `member` 行改写为 `viewer`
- 判定单位从「是不是 owner」改为 14 个能力，矩阵见「权限与能力矩阵」
- 知识库响应新增 `effectiveRole` 与 `capabilities`
- 无立场（非 owner 非成员、知识库已删除、成员已撤销）一律 404；角色不够才 403，
  `details` 带 `role`、`capability`、`requiredRole`
- 404 的错误码按调用方问的资源命名，不按拒绝来源命名
- 下载、导出、质量运营数据、永久删除各自校验独立能力，不再一律等同 owner
- 跨知识库列表的可达性写在查询里，角色集合来自 `access.MemberRolesWith`
- 知识库回收站保持 owner 独有，不走矩阵（回收站是 owner 的私有空间）
- 本阶段不引入组织树、SSO 或通用策略引擎

## 管理员操作记录与知识库转移

`GET /admin/activities` 由 `RequireSystemAdmin` 保护，未登录 401，非管理员 403 `SYSTEM_ADMIN_REQUIRED`。查询 `page=1&pageSize=20`，每页最大 100。返回 `{items,total,page,pageSize}`，只包含 `admin.` 前缀活动，按时间倒序，覆盖所有操作者。每项为 `{id,action,resourceType,resourceId,resourceName,actor:{id,username,displayName},createdAt}`。不公开其他用户的知识库活动。禁用和启用分别记录 `admin.user.disabled`、`admin.user.enabled`；显示名实际变化时才记录 `admin.user.updated`。

`GET /admin/users` 的每项新增 `ownedKnowledgeBaseCount`，包括已软删除的知识库。以下转移接口都接收 `{newOwnerId,keepPreviousOwnerAsManager}`，成功返回 200 `{transferredCount}`：

| 接口 | 权限与范围 |
| --- | --- |
| `POST /knowledge-bases/:id/transfer-ownership` | `kb.transfer`，仅当前所有者，知识库须未删除；无权限成员 403，陌生人或已删除资源 404 |
| `POST /admin/users/:id/transfer-knowledge-bases` | 系统管理员，将该用户所有知识库（含回收站）作为一个原子批次转移 |

新所有者必须存在、启用且与旧所有者不同，否则 400 `TRANSFER_TARGET_INVALID`；管理员入口的原用户不存在返回 404 `USER_NOT_FOUND`。锁内检测到单库所有权或状态已变化返回 409 `OWNERSHIP_CHANGED`。事务按固定顺序锁定用户与知识库行，整个批次成功或回滚。新所有者原成员行移除；`keepPreviousOwnerAsManager=true` 时旧所有者成为 manager，否则移除其成员身份。分类不属于新所有者时清空；标签、收藏、浏览历史、其他成员、文档与会话保持。会话仍须同时满足知识库访问与 `chat_sessions.user_id` 校验。`updated_by_id` 记录操作者；为操作者和新所有者记录 `kb.ownership_transferred`，同一人只记一次。

## 粘贴文本创建文档

`POST /knowledge-bases/:id/documents/text` 要求 `content.write`，请求：

```json
{"title":"设备维护手册","content":"# 维护\n每 90 天检查一次。","format":"md","allowDuplicate":false}
```

`title` trim 后 1–200 个 Unicode 字符；非法文件名字符替换为下划线，再追加扩展名。`format` 仅 `md` / `txt`，缺省 `md`；正文不能全为空白，UTF-8 字节数不超过 `MAX_UPLOAD_SIZE_MB`。非法输入返回 `VALIDATION_ERROR`。正文原始字节参与哈希与存储；与 multipart 上传共享查重、清理预留、文档和任务事务、活动记录与后台处理。成功 201，响应与上传文档相同；重复内容返回 409 `DOCUMENT_DUPLICATE_CONTENT`，`allowDuplicate=true` 可明确保留重复副本。

## Embedding 诊断

`GET /system/diagnostics` 新增 `embedding`：`status`、`model`、`configuredDimension`、`columnDimension`、`totalDocuments`、`unknownDocuments`、`mismatchedDocuments`、`groups`。每个 group 为 `{model,dimension,count}`；未知值为 null。只统计知识库和文档均未删除、状态 completed 的文档，包含仍可检索的历史版本。未知与不匹配分别计数；有任一异常时为 degraded，查询失败为 down，不能把失败解释为零文档。原有管理员权限保持。

## 回答收藏与个人备注

| 方法 / 路径 | 请求与响应 |
| --- | --- |
| `GET /chat/bookmarks` | `q` 可选、最多 200 字；`page` 默认 1、范围 1–1000000，`pageSize` 默认 20、范围 1–100。返回 `{items,total,page,pageSize}`。 |
| `PUT /chat/messages/:messageId/bookmark` | `{note}`，trim 后最多 4000 字，允许空备注；请求体最多 100 KiB。幂等创建/更新，200 返回 `{messageId,note,createdAt,updatedAt}`。 |
| `DELETE /chat/messages/:messageId/bookmark` | 204；在回答仍可访问的前提下重复删除成功。 |

仅收藏本人可访问会话中的 assistant 回答，精确绑定回答版本；提问返回 400 `VALIDATION_ERROR`。没有访问立场、会话已删除或任一依赖撤权返回 404 `RESOURCE_NOT_FOUND`。归档会话包括在结果中；计数与条目共用全部依赖权限条件。`q` 对回答、备注和会话标题做字面关键词搜索，不把 `%/_` 当通配符。

列表条目包含消息搜索字段 `{messageId,sessionId,sessionTitle,archivedAt,role,createdAt,excerpt}` 和 `bookmark`；摘录沿用会话搜索的纯文本及高亮区间格式。消息历史 DTO 额外带可选 `bookmark`，由批量查询加载；无收藏时省略。普通消息查询、个人模板及收藏不跨账号缓存。

## 文档版本文本对比

- `GET /documents/:id/versions` 返回 `{items:[{id,filename,status,createdAt,supersededById}]}`，按时间/ID 升序。仅包含该文档双向替换链中同库、未删除的文档，删除或跨库链接停止遍历；最多 100 个版本。
- `GET /documents/:id/compare?baseId=UUID` 将路径版本作为新版本、`baseId` 作为旧版本。两端均需 `document.read`，且必须来自同一替换链；非法链为 400 `VALIDATION_ERROR`。两个相同 ID 可比较，结果无增删。
- 响应为 `{base,head,addedLines,removedLines,lines}`；每行 `{kind,content,baseLine,headLine}`，`kind=equal|add|remove`，行号从 1 开始，不存在的一侧为 null。文本按字面返回，不包含渲染 HTML。
- 两端必须 completed；原文件各最多 50 MiB、解析文本各最多 1 MiB / 2000 行。比较解析文本，不比较 PDF/DOCX 版式或调用模型概括差异；对象读取后重新验证两端权限。错误列表见 `09-error-codes.md`。

## 对话分支

`POST /chat/sessions/:id/branches`，请求体最多 16 KiB：

```json
{"messageId":"assistant-message-uuid","clientRequestId":"new-request-uuid","title":"可选标题"}
```

201 返回新会话详情，含可选 `branchFromSessionId` / `branchFromMessageId`。标题 trim 后最多 100 字；不填则由来源标题附加“ · 分支”。来源须属于调用者且全部依赖可访问，允许从归档会话创建。只接受 assistant 消息，复制按时间/ID 排序的历史前缀，恰好结束于选中的回答版本；最多 10000 条消息 / 16 MiB 正文、引用和回退元数据。

复制保留内容、引用、意图、检索式和回答状态，继承自动/手动模式及完整依赖；副本使用新 ID，不复制收藏、评价、未确认写入、请求编号或模型用量。来源会话不变。创建、依赖和消息复制在同一事务中，来源行锁使相同请求并发重试返回同一个分支；已存在请求编号用于不同目标或已软删除分支时报 409 `CHAT_BRANCH_REQUEST_CONFLICT`。来源永久删除后分支保留，链接置空；分支始终独立检查自己的知识库依赖。

## 个人提问模板

| 方法 / 路径 | 请求与响应 |
| --- | --- |
| `GET /chat/templates` | 与收藏相同的 `q/page/pageSize`，搜索标题和正文；返回 `{items,total,page,pageSize}`。 |
| `POST /chat/templates` | `{title,body}`，201 返回模板。 |
| `PUT /chat/templates/:templateId` | `{title,body}`，200 返回更新模板。 |
| `DELETE /chat/templates/:templateId` | 204；不存在或非本人模板返回 404。 |

模板响应 `{id,title,body,variables,createdAt,updatedAt}`。标题 trim 后 1–100 字，正文 1–12000 字，请求体最多 100 KiB。变量语法为 `{{变量名}}`，变量名最多 40 个 Unicode 字符，只含字母、数字、下划线或连字符；最多 20 个不同变量，按第一次出现排序，重复变量只列一次，畸形括号返回 400 `VALIDATION_ERROR`。权限仅个人归属，不依附特定知识库；不调用模型或自动发送聊天。前端填值和插入草稿，不新增服务端模板执行接口。

## 表格来源与相对路径

上传能力增加 `.xlsx` 和 `.csv`；`.xls` 不支持。解析与压缩包上限见 [RAG 规范](05-rag-pipeline.md#xlsx--csv-资料解析)。表格向量及引用继续使用现有 pipeline，无统计/公式执行接口。

文档上传、全局上传及替换 multipart 请求可带 `sourcePath`。它只作来源展示，统一 `/` 分隔，最后一段必须等于上传文件名；最多 1024 UTF-8 字节、每段最多 255 字，拒绝绝对路径、冒号、控制字符、空段、`.` 和 `..`。非法值为 400 `VALIDATION_ERROR`。文档详情、列表、回收站、上传和替换响应带可选 `sourcePath`，空值省略；替换只保存本次上传提供的路径。ZIP 不作为后端文档格式上传，由浏览器展开后调用原有逐文件 API，全部文件仍逐项鉴权、查重与排队。

检索条目与引用新增可选 `table`：

```json
{"table":{"sheetName":"库存","rowStart":5,"rowEnd":5,"headerRow":2}}
```

XLSX 使用工作表名和原始行号；CSV 的工作表名为空，行范围是物理文件行（包括引号字段内换行）。表头不会单独成为数据记录。无来源或无效元数据不生成 `table`；行号不由回答模型推断。JSON/SSE、已保存消息及 Markdown 导出均保留来源。

`GET /documents/:id/preview` 对表格返回 `kind=text`、解析文本与 `tableRows`。每项包括上述四个来源字段以及 `[startOffset,endOffset)`，它是响应 `content` 的 UTF-8 字节区间，用于定位完整数据记录。预览输入文件或解析文本大于 1 MiB 时仍报 `FILE_TOO_LARGE_FOR_PREVIEW`；可查看已有引用摘录和来源标签。表格解析失败为 `DOCUMENT_PREVIEW_FAILED`，触及表格解析上限为 `DOCUMENT_TABLE_TOO_LARGE`。XLSX 只读取已保存公式结果；无缓存值为空，前端说明这一限制。
