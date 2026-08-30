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
| 400 | `VALIDATION_ERROR` | 请求参数不合法 |
| 404 | `RESOURCE_NOT_FOUND` | 资源不存在 |
| 500 | `INTERNAL_ERROR` | 系统内部错误 |

## 业务错误码

| HTTP | code | message |
| --- | --- | --- |
| 404 | `KNOWLEDGE_BASE_NOT_FOUND` | 知识库不存在 |
| 404 | `DOCUMENT_NOT_FOUND` | 文档不存在 |
| 404 | `DOCUMENT_FILE_NOT_FOUND` | 文档原始文件不存在 |
| 400 | `DOCUMENT_TYPE_UNSUPPORTED` | 不支持的文档类型 |
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

## AI 开发约束

1. 不要返回 Go panic、SQL 错误或模型原始错误给前端。
2. 不要在 `details` 中包含 API Key、数据库连接串、文件绝对路径。
3. 前端必须优先展示 `message`。
4. 业务代码必须使用稳定 `code`，不要用动态字符串作为错误码。
5. 401 和 403 必须区分：未登录是 401，无权限是 403。

