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

## AI 开发约束

1. 不要返回 Go panic、SQL 错误或模型原始错误给前端。
2. 不要在 `details` 中包含 API Key、数据库连接串、文件绝对路径。
3. 前端必须优先展示 `message`。
4. 业务代码必须使用稳定 `code`，不要用动态字符串作为错误码。
5. 401 和 403 必须区分：未登录是 401，无权限是 403。

