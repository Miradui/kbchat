# 开发里程碑

## Milestone 1：基础工程

交付：

1. Gin 后端工程。
2. React 前端工程。
3. Docker Compose：PostgreSQL、pgvector、Redis。
4. 配置加载。
5. 数据库连接。
6. Redis 连接。
7. 健康检查接口。

验收：

```text
后端可启动
前端可启动
PostgreSQL 可连接
Redis 可连接
健康检查返回成功
```

## Milestone 2：登录与鉴权

交付：

1. users 表。
2. 登录接口。
3. JWT 生成和校验。
4. 当前用户接口。
5. 前端登录页。

验收：

```text
正确账号密码可登录
错误密码登录失败
未登录访问受保护接口失败
前端能保存 token 并进入系统
```

## Milestone 3：知识库管理

交付：

1. knowledge_bases 表。
2. 知识库 CRUD API。
3. owner 权限校验。
4. 前端知识库列表、创建、编辑、删除。

验收：

```text
用户只能看到自己的知识库
用户可以创建、查看、编辑、删除自己的知识库
```

## Milestone 4：文档上传与处理状态

交付：

1. documents 表。
2. document_jobs 表。
3. 文件上传 API。
4. 本地 uploads / MinIO S3 存储。
5. 文档列表、详情、删除。
6. 文档状态展示。

验收：

```text
用户可以上传 txt、md、pdf
上传后创建 document 和 document_job
前端能看到 uploaded、failed 等状态
```

## Milestone 5：文档解析、切片、Embedding

交付：

1. 文档 worker。
2. txt、md、pdf 解析。
3. 文本切片器。
4. EmbeddingProvider 接口。
5. OpenAI-compatible Embedding 实现。
6. document_chunks 写入。

验收：

```text
上传文档后自动处理
处理完成后生成 chunks
chunks 包含 vector(1536) embedding
文档状态变为 completed 或 failed
```

## Milestone 6：向量检索与 Rerank

交付：

1. Query Embedding。
2. pgvector TopN 检索。
3. RerankProvider 接口。
4. OpenAI-compatible 或兼容 Rerank 实现。
5. search API。

验收：

```text
检索只返回当前知识库 chunks
返回 vectorScore 和 rerankScore
最终结果按 rerankScore 排序
默认 vectorTopN=30
默认 rerankTopK=5
```

## Milestone 7：聊天问答与引用来源

交付：

1. chat_sessions 表。
2. chat_messages 表。
3. 会话 API。
4. 消息 API。
5. ChatProvider 接口。
6. RAG Prompt 组装。
7. citations 返回和保存。
8. 前端聊天页。

验收：

```text
用户可以创建会话并提问
系统基于 rerank chunks 生成回答
assistant 消息保存 answer 和 citations
citations 只来自最终 Prompt chunks
```

## Milestone 8：MVP 收尾

交付：

1. 统一错误响应。
2. 基础日志。
3. README。
4. 基础测试。
5. Docker Compose 启动文档。

验收：

```text
新环境可按 README 启动
核心链路可完整演示
错误响应格式一致
```

## AI 开发约束

1. 必须按里程碑顺序推进。
2. 每个里程碑只实现当前范围。
3. 未通过当前里程碑验收，不进入下一里程碑。
4. 不要在早期里程碑提前实现复杂生产能力。
