# 前端规范

前端使用 React，目标是企业后台风格的知识库管理和聊天问答系统。MVP 不做营销首页。

## 页面清单

```text
/login
/knowledge-bases
/knowledge-bases/:id
/knowledge-bases/:id/documents
/chat/:sessionId
```

## 登录页

功能：

1. 用户名输入。
2. 密码输入。
3. 登录按钮。
4. 登录失败错误提示。

验收：

```text
登录成功后保存 token
跳转到知识库列表页
登录失败显示后端 message
```

## 知识库列表页

功能：

1. 展示当前用户知识库。
2. 创建知识库。
3. 编辑知识库。
4. 删除知识库。
5. 进入知识库详情。

验收：

```text
只展示当前用户知识库
创建后列表刷新
删除前需要确认
```

## 知识库详情页

功能：

1. 展示知识库名称和描述。
2. 展示 retrievalConfig。
3. 入口到文档管理。
4. 入口到聊天问答。

默认 retrievalConfig：

```json
{
  "vectorTopN": 30,
  "rerankTopK": 5,
  "scoreThreshold": 0.3,
  "enableRerank": true
}
```

## 文档管理页

功能：

1. 上传 `txt`、`md`、`pdf`。
2. 展示文档列表。
3. 展示文件类型、大小、状态、错误信息。
4. 删除文档。
5. 重新处理文档。

状态展示：

```text
uploaded
parsing
chunking
embedding
completed
failed
```

轮询规则：

1. 存在未完成文档时，每 3 秒刷新文档列表。
2. 所有文档为 `completed` 或 `failed` 后停止轮询。

## 聊天问答页

功能：

1. 会话列表。
2. 消息列表。
3. 问题输入框。
4. 发送按钮。
5. assistant 回答展示。
6. citations 展示。

citations 必须展示：

```text
filename
pageNumber
content
vectorScore
rerankScore
```

无引用时展示：

```text
当前知识库中未找到足够依据。
```

## API 状态管理

1. token 保存在 token store。
2. API 请求统一注入 `Authorization: Bearer <token>`。
3. 401 时清理 token 并跳转登录页。
4. 错误提示展示后端 `message`。
5. 请求和响应类型应放在 `src/types` 或 API 模块附近。

## UI 风格

1. 企业后台风格。
2. 信息密度适中。
3. 不做营销首页。
4. 不使用大面积装饰性 hero。
5. 聊天页优先保证阅读和引用追溯效率。

## AI 开发约束

1. 不要把全部页面写在 `App.tsx`。
2. 不要在多个 API 调用处重复写 token 注入逻辑。
3. 不要隐藏 citations。
4. 不要只展示回答不展示来源。
5. 不要用前端伪造文档状态或检索分数。

