# 错误码规范

## 统一错误响应

所有 API 错误必须返回：

```json
{
  "code": "ERROR_CODE",
  "message": "用户可读错误信息",
  "details": {}
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `code` | 稳定错误码，前端用于判断错误类型 |
| `message` | 用户可读错误信息 |
| `details` | 调试信息或字段错误，不能包含密钥 |

## 基础错误码

| HTTP | code | message |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | 请先登录 |
| 403 | `FORBIDDEN` | 无权限访问该资源 |
| 403 | `SYSTEM_ADMIN_REQUIRED` | 此操作需要系统管理员权限 |
| 400 | `VALIDATION_ERROR` | 请求参数不合法 |
| 404 | `RESOURCE_NOT_FOUND` | 资源不存在 |
| 429 | `RATE_LIMITED` | 请求过于频繁，请稍后重试 |
| 503 | `RATE_LIMIT_UNAVAILABLE` | 请求频率校验暂时不可用，请稍后重试 |
| 500 | `INTERNAL_ERROR` | 系统内部错误 |

## 业务错误码

| HTTP | code | message |
| --- | --- | --- |
| 404 | `KNOWLEDGE_BASE_NOT_FOUND` | 知识库不存在 |
| 404 | `DOCUMENT_NOT_FOUND` | 文档不存在 |
| 404 | `DOCUMENT_FILE_NOT_FOUND` | 文档原始文件不存在 |
| 400 | `DOCUMENT_TYPE_UNSUPPORTED` | 不支持的文档类型 |
| 400 | `DOCUMENT_PREVIEW_FAILED` | 文档内容无法解析，无法在线预览 |
| 403 | `SYSTEM_ADMIN_REQUIRED` | 需要系统管理员权限 |
| 409 | `LAST_ADMIN_REQUIRED` | 不能撤销最后一位系统管理员 |
| 400 | `ADMIN_SELF_MUTATION` | 不能禁用或降级自己的管理员账号 |
| 409 | `USERNAME_EXISTS` | 用户名已存在 |
| 503 | `AUTH_UNAVAILABLE` | 身份校验暂时不可用，请稍后重试 |
| 400 | `FILE_TOO_LARGE_FOR_PREVIEW` | 文档过大，无法在线预览 |
| 409 | `DOCUMENT_DUPLICATE_CONTENT` | 知识库中已存在内容相同的文档 |
| 409 | `DOCUMENT_ALREADY_SUPERSEDED` | 该文档已被替换，请替换最新版本 |
| 500 | `DOCUMENT_UPLOAD_FAILED` | 文档上传失败 |
| 500 | `DOCUMENT_PROCESS_FAILED` | 文档处理失败 |
| 404 | `CATEGORY_NOT_FOUND` | 分类不存在 |
| 409 | `CATEGORY_NOT_EMPTY` | 分类仍包含子分类或知识库 |
| 404 | `TAG_NOT_FOUND` | 标签不存在 |
| 409 | `TAG_NOT_EMPTY` | 标签仍被知识库引用 |
| 404 | `USER_NOT_FOUND` | 用户不存在 |
| 400 | `AVATAR_TOO_LARGE` | 头像图片不能超过 2 MB |
| 400 | `INVALID_AVATAR` | 请选择有效的 PNG 或 JPG 图片，长宽均不能超过 4096 像素 |
| 404 | `AVATAR_NOT_FOUND` | 头像不存在或已更新 |
| 409 | `AVATAR_CHANGED` | 头像已更新，请刷新账户资料后重试 |
| 404 | `MEMBER_NOT_FOUND` | 知识库成员不存在 |
| 400 | `OWNER_MEMBER_IMMUTABLE` | 所有者成员权限不能通过成员接口修改 |
| 400 | `INVALID_MEMBER_ROLE` | 成员角色不合法 |
| 400 | `INVALID_VISIBILITY` | 知识库可见性不合法 |
| 400 | `INVALID_WORKSPACE_VIEW_MODE` | 工作台视图模式不合法 |
| 400 | `INVALID_WORKSPACE_SCOPE` | 工作台范围不合法 |
| 400 | `INVALID_WORKSPACE_SORT` | 工作台排序不合法 |
| 400 | `INVALID_WORKSPACE_VISIBILITY` | 工作台可见性筛选不合法 |
| 500 | `EMBEDDING_FAILED` | 向量生成失败 |
| 500 | `RERANK_FAILED` | 检索精排失败 |
| 500 | `CHAT_COMPLETION_FAILED` | 生成回答失败 |
| 500 | `CHAT_RESULT_UNCONFIRMED` | 回答结果需要重新确认 |
| 409 | `IDEMPOTENCY_KEY_REUSED` | 同一幂等键已用于不同的聊天内容 |
| 409 | `CHAT_MESSAGE_CHANGED` | 编辑消息生成期间会话已被其他请求修改，请刷新后重试 |
| 400 | `EXPORT_TOO_LARGE` | 搜索结果过多，请缩小范围后再导出 |

`RATE_LIMITED` 必须同时设置整数秒 `Retry-After` 响应头，并在 `details.retryAfter` 返回相同值。`RATE_LIMIT_UNAVAILABLE` 只用于 Redis 故障且限流失败策略为 `closed` 的情况，不得设置 `Retry-After`，也不得计入真实限流触发次数。

## 字段校验错误示例

```json
{
  "code": "VALIDATION_ERROR",
  "message": "请求参数不合法",
  "details": {
    "name": "知识库名称不能为空"
  }
}
```

## 鉴权错误示例

```json
{
  "code": "UNAUTHORIZED",
  "message": "请先登录",
  "details": {}
}
```

## 权限不足示例

系统诊断使用系统角色检查；非管理员返回 `403 SYSTEM_ADMIN_REQUIRED`，`details` 为 `{}`。角色查询失败默认拒绝并返回脱敏的 `500 INTERNAL_ERROR`；失效登录或账号已删除、已禁用返回 `401 UNAUTHORIZED`。认证中间件查询账号状态本身失败时同样拒绝而不放行，但返回 `503 AUTH_UNAVAILABLE` 而非 401：token 可能仍然有效，客户端不应因数据库瞬时故障丢弃它。该错误不使用下述知识库成员能力字段。

`/admin/users` 沿用同一套系统角色判定；`USERNAME_EXISTS` 按大小写不敏感判重（`Admin` 与 `admin` 视为同名），`ADMIN_SELF_MUTATION` 也覆盖管理员重置自己密码的情况，`LAST_ADMIN_REQUIRED` 同时覆盖降级和禁用两条路径。

知识库相关接口在「能到达资源、但角色不够」时返回 403：

```json
{
  "code": "FORBIDDEN",
  "message": "只有编辑者及以上可以修改知识库内容",
  "details": {
    "role": "viewer",
    "capability": "content.write",
    "requiredRole": "editor"
  }
}
```

`code` 恒为 `FORBIDDEN`，`message` 按缺失的能力换措辞——「无权限访问该资源」这一句让用户
无法判断该去申请更高角色还是就此放弃。`details` 三个字段都不敏感：调用者在成员名单里
本来就看得到自己的角色。

| 字段 | 说明 |
| --- | --- |
| `role` | 调用者当前角色：`viewer` / `editor` / `manager` / `owner` |
| `capability` | 被拒绝的能力，取值见 `docs/04-api-design.md` 的能力矩阵 |
| `requiredRole` | 该能力要求的最低角色 |

### 什么时候不是 403 而是 404

| 情况 | 结果 |
| --- | --- |
| 非 owner 且非成员 | 404 |
| 知识库已软删除 | 404 |
| 成员身份已被撤销 | 404 |
| 请求的是别人的会话 | 404 |
| 是成员但角色不够 | 403 |

没有任何立场时一律 404。返回 403 等于确认这个 id 存在，会把资源是否存在泄露给无关用户；
403 只在调用者确实能到达资源、仅仅角色不够时出现。

404 的 `code` 按**调用方问的那个资源**命名，即使拒绝来自它所属的知识库：

| 请求的 id | code |
| --- | --- |
| 文档 | `DOCUMENT_NOT_FOUND` |
| 会话 | `RESOURCE_NOT_FOUND` |
| 知识库 | `KNOWLEDGE_BASE_NOT_FOUND` |

用知识库的错误码回答一个文档请求，会让调用方以为自己传错了文档 id。
`internal/service/access_contract_test.go` 逐接口锁住这份对应关系，
`internal/router/access_status_test.go` 锁住它们在 HTTP 上的形状。

## 文档处理错误示例

```json
{
  "code": "DOCUMENT_PROCESS_FAILED",
  "message": "文档处理失败",
  "details": {
    "documentId": "uuid"
  }
}
```

## 重复内容冲突示例

```json
{
  "code": "DOCUMENT_DUPLICATE_CONTENT",
  "message": "知识库中已存在内容相同的文档",
  "details": {
    "existingDocumentId": "uuid",
    "existingFilename": "policy.md",
    "existingStatus": "completed",
    "existingUploadedAt": "2026-06-08T00:00:00Z"
  }
}
```

409 而不是 400：请求本身合法，服务端只是基于知识库当前状态拒绝，带上 `allowDuplicate=true`
的同一请求会成功。`details` 点名冲突文档，因为客户端要据此让用户选择替换还是保留两份；
`storagePath` 不出现在 `details` 里，那是部署拓扑。

## 文档处理错误分类

`documents.errorCode` 是与 HTTP 错误码无关的另一套封闭集合，描述的是异步处理失败的原因而不是
请求的结果。取值与含义见 `docs/04-api-design.md` 的 `GET /documents`。两条约束：

1. 未识别的失败归 `internal`，不猜具体原因。错误的具体分类会让用户去修错的地方，比承认服务端
   不知道更糟。
2. 解析器和 Provider 的原始错误文本只进服务端日志和任务记录，不进 `errorCode` 也不进
   `errorMessage`。分类给用户，原文给日志。

## 回归评测错误

| Code | HTTP 状态 | 含义 |
| --- | --- | --- |
| `EVALUATION_LIMIT` | 409 | 同库已达 200 题或已有 3 个 queued/running 运行 |
| `EVALUATION_REQUEST_CONFLICT` | 409 | 同一用户、知识库、请求编号被用于不同规范化请求 |
| `EVALUATION_FAILED` | 每题结果字段 | 无可用稳定业务码的评测调用错误，使用通用用户消息 |

题目、检索参数和反馈详情不合法仍用 `VALIDATION_ERROR`。评测中已知的 Provider 业务错误沿用
`EMBEDDING_FAILED`、`RERANK_FAILED` 等稳定错误码，只写入该题 `errorCode/errorMessage`；
该题的 `rulePassed=null`，与规则未通过区分。运行级中断以 status=failed 与 errorMessage 表达，
外部调用不会因进程失联自动重放。

## AI 开发约束

1. 不要返回 Go panic、SQL 错误或模型原始错误给前端。
2. 不要在 `details` 中包含 API Key、数据库连接串、文件绝对路径。
3. 前端必须优先展示 `message`。
4. 业务代码必须使用稳定 `code`，不要用动态字符串作为错误码。
5. 401 和 403 必须区分：未登录是 401，无权限是 403。
6. 403 和 404 必须按上文「什么时候不是 403 而是 404」区分：没有立场用 404，角色不够用 403。
   不要为了「信息更清楚」把无立场的情况改成 403。
7. 知识库能力不足的 403 `FORBIDDEN`，其 `details` 必须带 `role`、`capability`、`requiredRole`，由
   `authz.ForbiddenCapability` 统一构造，不要在各处手写。
