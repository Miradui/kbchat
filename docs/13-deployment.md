# 生产部署指南

本文档描述当前仓库可实际执行的单机生产部署方案：

```text
Browser
  -> Nginx (80/443)
     -> /            frontend/dist
     -> /api/*       Gin backend :8080
                         -> PostgreSQL + pgvector
                         -> Redis
                         -> Local upload directory
                         -> Chat / Title / Embedding / Rerank providers
```

当前 `deploy/docker-compose.yml` 只包含 PostgreSQL 和 Redis，不包含 backend、frontend、Nginx 或 TLS。本文采用 Docker Compose 运行基础设施，systemd 运行 Go 后端，Nginx 托管前端静态文件并反向代理 API。

## 1. 部署边界

当前版本具备以下部署特征：

1. 后端是单体进程，HTTP API 和文档处理 worker 在同一个进程中运行。
2. 上传文件保存在本地目录，必须持久化并定期备份。
3. 前端生产构建输出到 `frontend/dist`，仓库不提交该目录。
4. 前端默认请求同源 `/api/v1`，推荐通过 Nginx 同源反代。
5. 项目当前没有 CORS 中间件，不推荐将前端和 API 部署到不同域名。
6. 当前 migration runner 没有迁移版本表，只适合全新数据库首次执行全部迁移。
7. `/healthz` 只检查 HTTP 进程存活，不检查数据库、Redis 或模型 Provider。

由于内置 worker 的任务领取约束，在没有额外验证前，生产环境只运行一个 backend 实例。MinIO 解决共享文件存储问题，但不改变 worker 的单实例约束。

## 2. 环境要求

推荐环境：

| 组件 | 要求 |
| --- | --- |
| 操作系统 | Linux x86_64，例如 Ubuntu 24.04 LTS |
| Go | 1.25，与 `backend/go.mod` 一致 |
| Node.js | 20 或更高版本 |
| Docker | Docker Engine 26+ 与 Compose 2.24.4+ |
| PostgreSQL | PostgreSQL 15 或 16，安装 pgvector 扩展：HNSW 需要 ≥ 0.5.0，建议 ≥ 0.8.0（支持迭代索引扫描）。低于 0.8.0 时服务仍能返回完整结果，但依赖精确检索回退，知识库较大时检索变慢；`go run ./cmd/doctor` 与诊断页会显示版本。自建或托管数据库须自行核对版本，Compose 镜像 `pgvector/pgvector:pg16` 随拉取时间变化 |
| Redis | Redis 7 |
| Web Server | Nginx 1.24+ |

服务器还需要能够通过 HTTPS 访问配置的 Chat、Title、Embedding 和 Rerank Provider。

建议至少准备：

- 2 vCPU、4 GB 内存。
- 足够的 PostgreSQL 数据盘空间。
- 独立的上传文件持久化空间。
- 域名和有效 TLS 证书。

## 3. 目录规划

以下示例使用这些路径：

```text
/opt/rag/app                 项目代码和构建产物
/etc/rag/rag.env             生产环境变量
/var/lib/rag/uploads         上传文件
```

创建运行用户和目录：

```bash
sudo useradd --system --home /opt/rag --shell /usr/sbin/nologin rag
sudo install -d -o rag -g rag /opt/rag/app
sudo install -d -o root -g rag -m 0750 /etc/rag
sudo install -d -o rag -g rag -m 0750 /var/lib/rag/uploads
```

将项目发布到 `/opt/rag/app`。不要把本地 `.env`、`backend/uploads`、`backend/logs` 或 `frontend/node_modules` 复制到服务器。

## 4. 生产环境变量

创建 `/etc/rag/rag.env`，权限设为 `0640`，所有示例值都必须替换：

```env
APP_ENV=production
SERVER_PORT=8080

DATABASE_URL=postgres://rag:replace-with-db-password@127.0.0.1:5432/rag?sslmode=disable
REDIS_ADDR=127.0.0.1:6379
REDIS_PASSWORD=replace-with-redis-password
REDIS_DB=0
RATE_LIMIT_ENABLED=true
RATE_LIMIT_LOGIN_PER_MINUTE=10
RATE_LIMIT_CHAT_PER_MINUTE=30
RATE_LIMIT_FAILURE_MODE=open
TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128
EMBEDDING_CACHE_TTL=24h

JWT_SECRET=replace-with-at-least-32-random-bytes
JWT_EXPIRES_IN=24h

MODEL_PROVIDER=openai_compatible

CHAT_BASE_URL=https://provider.example.com/v1
CHAT_API_KEY=replace-with-chat-api-key
CHAT_MODEL=replace-with-chat-model

TITLE_BASE_URL=https://provider.example.com/v1
TITLE_API_KEY=replace-with-title-api-key
TITLE_MODEL=replace-with-title-model

EMBEDDING_BASE_URL=https://provider.example.com/v1
EMBEDDING_API_KEY=replace-with-embedding-api-key
EMBEDDING_MODEL=replace-with-embedding-model
EMBEDDING_DIMENSION=1536

RERANK_ENABLED=true
RERANK_BASE_URL=https://provider.example.com/v1
RERANK_API_KEY=replace-with-rerank-api-key
RERANK_MODEL=replace-with-rerank-model
RERANK_FAILURE_MODE=strict

STORAGE_PROVIDER=minio
UPLOAD_DIR=/var/lib/rag/uploads
MINIO_ENDPOINT=https://minio.example.com
MINIO_ACCESS_KEY=replace-with-minio-access-key
MINIO_SECRET_KEY=replace-with-minio-secret-key
MINIO_BUCKET=rag-documents
MINIO_REGION=
MINIO_USE_SSL=true
MAX_UPLOAD_SIZE_MB=50

VECTOR_TOP_N=30
RERANK_TOP_K=5
SCORE_THRESHOLD=0.3
CHAT_HISTORY_LIMIT=10

WORKER_CONCURRENCY=2
WORKER_MAX_RETRIES=3
WORKER_RETRY_DELAY=10s
```

设置权限：

```bash
sudo chown root:rag /etc/rag/rag.env
sudo chmod 0640 /etc/rag/rag.env
```

注意事项：

- 数据库密码包含特殊字符时，必须在 `DATABASE_URL` 中进行 URL 编码。
- MinIO bucket 必须保持私有，不需要为浏览器设置公开读权限；下载和预览由 backend 代理。backend 会读取 bucket policy，发现任何 bucket policy 时拒绝启动，避免匿名访问绕过 JWT 与 owner 校验。
- endpoint 显式写 `http://` 或 `https://` 时，其 scheme 优先于 `MINIO_USE_SSL`。生产环境应使用 HTTPS。
- backend 启动时会检查 bucket，并在不存在时自动创建；endpoint、凭据或权限错误会阻止启动。若由运维预建 bucket，凭据除对象读、写、删除和统计权限外还必须能够读取 bucket policy。
- 切换前的本地文件不会自动搬迁到 MinIO，backend 会继续通过 `UPLOAD_DIR` 读取这些历史路径；确认完成迁移前不要删除旧上传目录。
- 使用云数据库时应按服务商要求设置 `sslmode=require` 或更严格模式。
- `EMBEDDING_DIMENSION` 必须保持为 `1536`，除非已经执行对应 schema migration 并重建全部 embedding。
- `RERANK_FAILURE_MODE=strict` 会在 Rerank Provider 失败时终止本次检索；`fallback` 会降级为 vector topK。
- 如果暂时没有 Rerank Provider，可以显式设置 `RERANK_ENABLED=false`，但检索质量会下降且 `rerankScore` 为空。
- 同机 Nginx 反代时只信任 loopback CIDR。若 Nginx 与 backend 分属容器或主机，应把 `TRUSTED_PROXY_CIDRS` 改成 backend 实际看到的代理网段；不要为省事信任 `0.0.0.0/0` 或 `::/0`。
- `RATE_LIMIT_FAILURE_MODE=open` 在 Redis 故障时保持业务可用并写 warning；安全要求优先的部署可改为 `closed`，此时登录和回答生成接口返回 503。query embedding 缓存始终自动降级到 Provider。
- 生产服务器的项目目录中不要保留 `.env`。配置加载器会用项目内 `.env` 覆盖进程环境变量。

## 5. 启动 PostgreSQL 和 Redis

### 5.1 推荐方式

生产环境优先使用托管 PostgreSQL、托管 Redis，或者单独维护的数据库服务。PostgreSQL 账号必须能够执行：

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### 5.2 使用仓库 Compose

仓库 Compose 可用于单机或内网部署：

```bash
cd /opt/rag/app
docker compose -f deploy/docker-compose.yml config
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml ps
```

现有 Compose 使用固定的开发账号 `rag/rag`，并把 `5432`、`6379` 暴露到全部宿主机网卡。正式上线前必须完成以下加固：

1. 替换 PostgreSQL 默认密码。
2. 为 Redis 设置密码，并同步设置 `REDIS_PASSWORD`。
3. 将端口绑定限制为 `127.0.0.1`，或通过防火墙禁止公网访问。
4. 保留 `rag_postgres_data` 和 `rag_redis_data` 数据卷。

不要直接把未加固的当前 Compose 暴露到公网。

如果使用自托管 Redis，应在部署主机创建一个未提交的 Compose override，例如 `deploy/docker-compose.prod.yml`：

```yaml
services:
  postgres:
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}
    ports: !override
      - "127.0.0.1:5432:5432"
  redis:
    command: ["redis-server", "--appendonly", "yes", "--requirepass", "${REDIS_PASSWORD:?set REDIS_PASSWORD}"]
    ports: !override
      - "127.0.0.1:6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "${REDIS_PASSWORD}", "ping"]
```

用 override 启动时，`DATABASE_URL` 中的用户名仍为当前 Compose 创建的 `rag`，密码应与 `POSTGRES_PASSWORD` 一致：

```bash
export POSTGRES_PASSWORD='replace-with-db-password'
export REDIS_PASSWORD='replace-with-redis-password'
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.prod.yml up -d
```

如果改用其他 PostgreSQL 用户名，必须同时修改 Compose 的 `POSTGRES_USER`、healthcheck、`DATABASE_URL` 和备份命令。

## 6. 构建应用

### 6.1 构建后端

```bash
cd /opt/rag/app/backend
go test ./...
mkdir -p bin
go build -trimpath -o bin/rag-server ./cmd/server
go build -trimpath -o bin/rag-doctor ./cmd/doctor
go build -trimpath -o bin/rag-migrate ./cmd/migrate
go build -trimpath -o bin/rag-seed ./cmd/seed
go build -trimpath -o bin/rag-bootstrap-admin ./cmd/bootstrap-admin
go build -trimpath -o bin/rag-reindex-keywords ./cmd/reindex-keywords
```

### 6.2 构建前端

同源部署使用 `/api/v1`：

```bash
cd /opt/rag/app/frontend
npm ci
VITE_API_BASE_URL=/api/v1 npm run build
```

构建完成后应存在：

```text
/opt/rag/app/frontend/dist/index.html
/opt/rag/app/frontend/dist/assets/
```

`VITE_API_BASE_URL` 是构建时变量。修改后必须重新执行前端构建。

## 7. 数据库初始化和升级

执行运维命令时，先加载环境变量：

```bash
set -a
. /etc/rag/rag.env
set +a
cd /opt/rag/app/backend
```

环境文件中的值需要符合 shell 语法；包含空格或特殊字符的值应正确加引号。

### 7.1 连接检查

```bash
./bin/rag-doctor
```

`rag-doctor` 会同时检查 PostgreSQL 和 Redis。任一依赖连接失败都会返回非零状态。

### 7.2 全新数据库

仅对全新数据库执行：

```bash
./bin/rag-migrate
```

该命令会按文件名顺序执行 `backend/migrations/*.sql`。

另外，当前 `cmd/server` 启动时仍会调用 GORM `AutoMigrate`。因此生产数据库账号暂时仍需要创建 `vector` 扩展和缺失表的 DDL 权限；数据库迁移与应用启动期 DDL 尚未解耦。后续如果收紧为 DML-only 账号，需要先修改后端启动流程并补充 migration 权限验证。

### 7.3 已有数据库

当前 migration runner 不记录已经执行的 migration，并且部分 migration 不能重复执行。已有数据库不要直接运行不带参数的 `rag-migrate`。

升级时应：

1. 先备份 PostgreSQL。
2. 记录生产环境最后执行的 migration 文件名。
3. 审查新版本中新增的 migration。
4. 只按文件名顺序执行尚未应用的文件。

使用 `-migration` 精确指定已审核的单个文件。该参数只接受 `migrations/` 目录中的文件名，不接受路径；单文件会在一个数据库事务中执行：

```bash
./bin/rag-migrate -migration 014_chat_message_feedback.sql
```

指定单文件不会检查它的前置 migration 是否已经执行。在补齐正式的 schema migration 版本表之前，仍需按顺序逐个执行，且部署记录必须明确保存已执行到哪个 migration。

升级到 `timestamptz` 时，确认 001–022 已执行，备份数据库并停止旧版 backend 和 worker，再执行：

```bash
./bin/rag-migrate -migration 023_timestamps_with_time_zone.sql
```

023 仅处理连接 `current_schema()` 下已知业务表的无时区时间列，按表合并 `ALTER COLUMN`，使用 `AT TIME ZONE 'UTC'` 保持现有时间含义；已是 `timestamptz` 的列跳过，可重复执行。这是类型升级，不自动修正历史时间偏差。迁移需要表锁，宜安排维护窗口；单文件事务失败会回滚，命令当前总超时为 30 秒，大库应提前评估耗时。

核对记录数、时间值、默认值和索引后启动新版 backend。新版启动检查发现旧时间列会报错并提示 023；`AutoMigrate` 只创建缺失表，不会代替这次类型迁移。其他 schema 或环境须按自己的连接配置与迁移记录分别升级。

升级到混合检索（迁移 024）时，确认 001–023 已执行，在维护窗口内执行：

```bash
./bin/rag-migrate -migration 024_hybrid_search.sql -timeout 30m
./bin/rag-reindex-keywords
```

024 为 `document_chunks` 增加 `search_vector tsvector` 列与 GIN 索引，并用 HNSW 索引替换 ivfflat 向量索引，可重复执行。构建 HNSW 索引会读取整张表，`-timeout` 应按数据量放宽（默认 30 秒只适合空库或小库），并可为会话提高 `maintenance_work_mem`。迁移完成后 `rag-reindex-keywords` 按主键分批回填已有 chunk 的关键词索引，每批独立提交，可中断后重跑；回填期间旧 chunk 继续参与向量召回，只是暂不参与关键词召回。新版 backend 可在回填进行时启动。`-batch` 控制每批数量（默认 200），`-timeout` 默认 1 小时。

### 7.4 初始化系统管理员

升级到 2026-09-20 之后的版本还需依次执行 025–029：

```bash
for m in 025_user_status_and_admin.sql 026_model_usage_records.sql 027_kb_answer_config.sql 028_evaluation_answer_config.sql 029_document_embedding_identity.sql; do ./bin/rag-migrate -migration $m; done
```

025 为 `users` 增加状态与最近登录时间；026 新建 `model_usage_records`；027 为 `knowledge_bases` 增加 `answer_config`；028 为 `evaluation_runs` 增加 `answer_config` 快照。029 增加文档向量来源，存量值保持未知。这些迁移都是 `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`，可重复执行，耗时与表锁都很短。新版 backend 启动时会检查 024–029 对应的列与表，缺失时直接报错并指出需要的迁移文件。

先执行数据库迁移，再通过 CLI 指定首位系统管理员。新部署可直接创建账号，密码至少 8 个字符、最多 72 个 UTF-8 字节：

```bash
BOOTSTRAP_ADMIN_PASSWORD='replace-with-strong-password' \
BOOTSTRAP_ADMIN_DISPLAY_NAME='Administrator' \
./bin/rag-bootstrap-admin -username admin -create
```

已有账号的环境使用提升命令，保留原有 ID、密码和资料：

```bash
./bin/rag-bootstrap-admin -username admin
```

将 `admin` 替换为操作者明确选定的用户名。同一管理员重复执行返回 `unchanged`；已有其他管理员则拒绝给第二个账号授予权限。`-create` 不覆盖现有普通用户；缺少该选项时不自动创建账号。并发初始化通过数据库事务锁保证只有首位成功。日志只记录用户名与动作，不记录密码。

`rag-seed` 只创建普通系统用户，默认名字 `admin` 不代表管理员身份。初始化命令没有默认用户名、默认密码或公开 HTTP 入口；它也不代替 SQL 迁移。诊断接口只允许数据库中当前 `role=admin` 的账号，知识库成员 `manager` 和拥有者仍是独立权限。新 token 携带角色快照，既有 token 按数据库当前角色判定，无需通过重新登录才能生效。

## 8. 使用 systemd 运行后端

创建 `/etc/systemd/system/rag-backend.service`：

```ini
[Unit]
Description=kbchat Backend
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=rag
Group=rag
WorkingDirectory=/opt/rag/app/backend
EnvironmentFile=/etc/rag/rag.env
ExecStart=/opt/rag/app/backend/bin/rag-server
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/rag/uploads

[Install]
WantedBy=multi-user.target
```

加载并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now rag-backend
sudo systemctl status rag-backend
sudo journalctl -u rag-backend -n 100 --no-pager
```

后端默认监听 `0.0.0.0:8080`。应通过防火墙限制 8080 只允许本机或可信网络访问。

## 9. 配置 Nginx

创建 `/etc/nginx/sites-available/rag`：

```nginx
server {
    listen 80;
    server_name rag.example.com;

    root /opt/rag/app/frontend/dist;
    index index.html;

    client_max_body_size 50m;

    location /api/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 10s;
        proxy_read_timeout 120s;
    }

    location = /healthz {
        proxy_pass http://127.0.0.1:8080/healthz;
        proxy_set_header Host $host;
    }

    location /assets/ {
        try_files $uri =404;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache";
    }
}
```

启用配置：

```bash
sudo ln -s /etc/nginx/sites-available/rag /etc/nginx/sites-enabled/rag
sudo nginx -t
sudo systemctl reload nginx
```

随后使用组织现有的证书平台或 Certbot 配置 HTTPS，并将 HTTP 重定向到 HTTPS。

`try_files $uri $uri/ /index.html` 是 React Router 刷新非根路径时必需的 SPA fallback。

如果调整 `MAX_UPLOAD_SIZE_MB`，同时调整 Nginx 的 `client_max_body_size`。

登录 IP 限流依赖 `X-Forwarded-For` 与 `TRUSTED_PROXY_CIDRS` 同时正确。上面的配置适用于 Nginx 与 backend 同机、Nginx 直连 `127.0.0.1:8080`；若中间还有负载均衡器，逐跳核对代理链和可信网段。

## 10. 上线验证

### 10.1 基础设施

```bash
cd /opt/rag/app
docker compose -f deploy/docker-compose.yml ps

cd backend
set -a
. /etc/rag/rag.env
set +a
./bin/rag-doctor
```

### 10.2 后端存活

```bash
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS https://rag.example.com/api/v1/healthz
```

预期响应：

```json
{"env":"production","status":"ok"}
```

此响应只能证明 HTTP 进程存活。数据库和 Redis 就绪状态以 `rag-doctor` 为准，模型 Provider 需要通过真实 embedding、搜索和聊天流程验证。

### 10.3 前端和业务冒烟

至少验证：

1. 访问登录页并成功登录。
2. 新建知识库。
3. 上传一个小型 txt 或 md 文件。
4. 等待文档状态进入 `completed`。
5. 执行知识库语义搜索。
6. 发起一次聊天，确认回答和 citations 正常。
7. 启用 Rerank 时，确认未出现非预期的 `rerankFallback`。
8. 直接刷新 `/knowledge-bases`、`/documents`、`/chat`，确认没有 Nginx 404。
9. 在隔离的验收 IP 连续提交 11 次错误登录，第 11 次确认返回 429 且带 `Retry-After`；等待窗口结束后确认可重新请求。
10. 对同一个问题执行两次检索，再以系统管理员打开诊断页，确认 query embedding cache 的命中数增加且第二次没有新增 Embedding Provider 成功计数。

## 11. 日常发布流程

推荐顺序：

1. 备份 PostgreSQL 和上传目录。
2. 发布新代码到服务器。
3. 执行 `go test ./...` 和 `npm ci && npm run build`。
4. 审查并执行本次新增 migration。
5. 构建新的后端二进制。
6. 执行 `sudo systemctl restart rag-backend`。
7. 执行健康检查和完整业务冒烟。

当前后端是单实例部署，重启期间会有短暂不可用。不要在未验证任务领取语义和共享上传存储前横向扩容 backend。

## 12. 备份和恢复

至少备份：

- PostgreSQL 数据库。
- MinIO 的 `rag-documents` bucket；仍有历史本地路径时同时备份 `/var/lib/rag/uploads`。
- `/etc/rag/rag.env` 的加密副本。

使用 Compose PostgreSQL 时可以执行：

```bash
docker exec rag-postgres pg_dump -U rag -d rag -Fc > rag-$(date +%F-%H%M).dump
mc mirror --overwrite production/rag-documents ./rag-documents-backup
# 仅在仍有历史本地文件时执行：
tar -C /var/lib/rag -czf rag-uploads-$(date +%F-%H%M).tar.gz uploads
```

恢复数据库前应停止 backend，避免 worker 在恢复期间继续处理任务。数据库 schema 回滚不保证向后兼容；涉及 migration 的版本回退优先恢复配套数据库备份。

## 13. 常见问题

### PostgreSQL 密码认证失败

检查 `DATABASE_URL` 的用户名、密码、端口和数据库名。Docker 数据卷已经初始化后，仅修改 Compose 的 `POSTGRES_PASSWORD` 不会修改数据库内现有用户密码。

### 无法创建 vector 扩展

确认 PostgreSQL 已安装 pgvector，并且 migration 使用的数据库账号有创建扩展的权限。托管数据库可能要求通过控制台预先启用扩展。

### 后端已启动但文档处理失败

检查：

- `STORAGE_PROVIDER=local` 时检查 `UPLOAD_DIR` 是否存在且对 `rag` 用户可写；`minio` 时检查 endpoint、bucket 权限和网络连通性。若数据库中仍有历史本地路径，MinIO 模式也必须保留可读的 `UPLOAD_DIR`。
- Embedding Provider 地址、Key、模型和维度是否正确。
- `journalctl -u rag-backend` 中的 worker 日志。

### 前端能打开但 API 请求失败

检查前端是否用 `VITE_API_BASE_URL=/api/v1` 重新构建，并确认 Nginx `/api/` 正确代理到 `127.0.0.1:8080`。

### 刷新前端子路由返回 404

确认 Nginx `location /` 包含：

```nginx
try_files $uri $uri/ /index.html;
```

### 上传返回 413

同时检查 `MAX_UPLOAD_SIZE_MB` 和 Nginx `client_max_body_size`。

### Rerank 请求失败

确认 Provider 实现的是 OpenAI-compatible `/rerank` 接口，并返回 `results[].index` 以及 `relevance_score` 或 `score`。根据业务要求选择 `RERANK_FAILURE_MODE=strict` 或 `fallback`。

### 登录或聊天返回 RATE_LIMIT_UNAVAILABLE

这表示 `RATE_LIMIT_FAILURE_MODE=closed` 且 Redis 计数不可用。检查 `REDIS_ADDR`、认证、网络和 Redis 日志；恢复后无需清理 PostgreSQL。需要优先恢复业务时可临时切换为 `open` 并重启 backend，同时保留 warning 告警。

## 14. 安全检查清单

- [ ] PostgreSQL 和 Redis 未暴露到公网。
- [ ] Compose 默认密码已替换。
- [ ] Redis 已启用认证，且 `REDIS_PASSWORD` 已配置。
- [ ] `TRUSTED_PROXY_CIDRS` 只包含实际反向代理地址，未信任公网全网段。
- [ ] `JWT_SECRET` 使用足够长的随机值。
- [ ] 未使用默认 seed 密码。
- [ ] `/etc/rag/rag.env` 权限为 `0640` 或更严格。
- [ ] API 和前端只通过 HTTPS 对外提供。
- [ ] 上传目录不可由 Nginx 直接浏览。
- [ ] 数据库和上传目录已有自动备份及恢复演练。
- [ ] Provider API Key 未出现在日志、仓库或构建产物中。
- [ ] 防火墙只开放 80、443 和必要的运维端口。

## 15. 生产部署待补齐事项

以下生产部署配套尚未实现或完成验证：

- backend、frontend 的 Dockerfile。
- 完整生产 Docker Compose。
- Nginx/Caddy 配置文件和自动 TLS。
- migration 版本跟踪表。
- 依赖就绪探针。
- 多实例任务领取与共享上传存储的部署验证；本地 / 私有 MinIO 存储已实现。
- 自动化发布、滚动升级和一键回滚。

在这些能力补齐前，不应宣称当前仓库支持完整的一键容器化生产部署。

## Embedding 模型切换与重建

升级前执行 `go run ./cmd/migrate -migration 029_document_embedding_identity.sql`。迁移可重复执行，只增加两个可空列，不改存量向量。新版 server 在启动 worker 前验证向量列维度，doctor 同样报告不匹配。

在 backend 目录执行：

```powershell
go run ./cmd/reembed -dry-run
go run ./cmd/reembed -kb <知识库UUID> -dry-run -batch 100
go run ./cmd/reembed -batch 100
go run ./cmd/reembed -only-mismatched=false -batch 100
```

`-kb` 缺省扫描全部知识库；`-batch` 为 1–1000，默认 100。默认只选择来源未知或模型/维度不匹配的文档（含仍可检索的历史版本），跳过已删除知识库、已删除文档和已有 pending/running 处理任务。`-dry-run` 不迁移、不写库；正常模式在文档锁内复查条件，再通过现有重处理队列排队。CLI 输出 selected/queued；它不等待 worker 完成。重复执行会跳过活动任务和已经匹配的文档。通过诊断与文档状态确认完成和失败项。

同维度换模型：暂停对外检索，修改模型配置，启动单个 worker，先 dry-run 后执行 reembed；完成后确认未知/不匹配归零并用样例问答复验再开放。若重建期间继续查询，新旧向量混用会降低质量。只改配置不会自动重建。

改维度：备份数据库和源文件、停止写入与检索，准备针对实际目标维度的 SQL 迁移。先移除 HNSW 索引，清空旧向量（旧维度不能直接当作新维度向量），把列类型改为 `vector(目标维度)`，重建 `vector_cosine_ops` HNSW 索引并更新配置；经 doctor 校验后执行 `reembed -only-mismatched=false`，全部完成并验证后再开放。该维护操作应作为单独的部署变更审核，不能用 029 代替。重处理会更换 chunk ID；旧 citations 保留内容/页码/偏移，但其 chunkId 跳转可能失效。

当前 document worker 仍要求单实例。部署多实例或重叠滚动发布之前必须完成 P14 租约与 fencing；共享文件需要 MinIO，诊断指标仍按进程统计，Redis 故障默认放行。


## 多库会话发布（迁移 030）

新版服务启动前，在已有 029 的基础上执行 `go run ./cmd/migrate -migration 030_chat_session_knowledge_bases.sql`（backend目录）；已有数据库按7.3逐项升级，不使用不带参数的迁移命令。迁移可重复执行；旧会话继续单库，已有文档无需重新 Embedding。必须同时发布支持新响应字段的前端与后端；旧后端只校验首选库，创建跨库会话后不能降级运行旧后端。

最初多库验收仅在隔离 schema 执行001–030；用户随后于2026-09-29授权更新当前数据库，postgres/public 已执行029/030/031。根 `.env` 保持原值，尤其 `RERANK_ENABLED=false`；标准精排需要部署者启用真实 Rerank 配置。所有库继续共享 Embedding，禁止直接切模型而保留不同空间的旧向量。多库不改变单实例 worker 限制。


## 自动检索发布（迁移 031）

在 030 基础上执行 `031_chat_automatic_scope.sql`（入口 `cd backend; go run ./cmd/migrate -migration 031_chat_automatic_scope.sql`），同时发布前后端。迁移可重复执行，现有会话保持 manual，新建无范围会话默认 auto；不重建向量。自动会话必须由支持每轮授权与历史依赖累计的后端处理，不能降级到不识别 scope_mode 的版本。

代码验证使用本地 fixture。用户随后授权更新当前数据库，已于2026-09-29对配置中的 postgres/public 执行029/030/031；所需表、字段、默认值和约束及启动结构检查通过，15个旧会话全部保持manual，业务行数不变。根 `.env` 未修改，本次未重启后端或启动worker；应用需运行对应新版前后端。Rerank 继续受全局开关控制；不要把关闭状态的结果标为已精排。

## PDF 页提取摘要发布（迁移 032）

发布本次后端前执行 `cd backend; go run ./cmd/migrate -migration 032_document_pdf_text_summary.sql`，再发布对应前后端。迁移添加可空的 `documents.pdf_text_summary JSONB`，可重复执行；新后端启动会检查该列存在。文档统计接口无需额外索引或数据回填。

旧文档摘要保持未知，不自动解析或调用模型；后续新上传或用户主动重处理会写入摘要。重处理沿用现有切片/Embedding 流程及成本，本次迁移不会自行排队。2026-10-08 已在隔离 PostgreSQL schema 验证 032、完整新环境迁移和真实文档流程；当前业务 public **尚未执行 032**，不能将测试环境迁移视为业务环境已升级。根 `.env` 和模型配置保持原值，单实例与任务租约暂缓的边界不变。

## 聊天历史分页发布（迁移 033）

先补齐上方 032，再执行 `cd backend; go run ./cmd/migrate -migration 033_chat_message_history_index.sql`，发布对应前后端。033 为 `chat_messages(session_id, created_at, id)` 增加可重复执行的普通复合索引，不修改消息或向量、不调用模型；普通建索引会影响并发写入，大表应安排维护窗口。后端不带分页参数仍兼容旧全量协议，新前端配套使用分页元数据；部署后检查最新页、向上加载、全文查找和导出。

2026-10-08 已在隔离 PostgreSQL schema 验证完整 001–033（含两个 010，共 34 个 SQL 文件）、033 重复执行及真实游标读取。业务 public **尚未执行 032/033**，032 列仍是新版后端启动前提；033 索引不在启动结构必需检查中。详见 [分页与真实 PDF 验收](26-chat-history-and-real-pdf-acceptance.md)。
