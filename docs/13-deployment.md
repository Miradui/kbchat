# 部署运维

当前源码的迁移要求见 [数据库设计](03-database-design.md)，并与实际SQL和启动检查核对。本页面向Linux单机部署：Nginx提供静态前端并代理Go后端，后端连接PostgreSQL/pgvector、Redis、本地/MinIO存储及模型服务。文档worker保持单实例。

Docker完整单实例部署使用 [compose.production.yml](../deploy/compose.production.yml) 和 [发布脚本](../deploy/release.sh)，安装、升级及备份恢复步骤见 [Docker发布说明](../deploy/RELEASE.md)。下文保留Linux原生systemd部署方式。开发用 `deploy/docker-compose.yml` 提供PostgreSQL/Redis及可选observability profile（Collector/Jaeger/Prometheus/Grafana）；TLS入口由实际环境配置。当前环境是否已升级须现场核实，不能用旧PID或迁移记录判断。

| 任务 | 入口 |
| --- | --- |
| 首次运行 | 根目录 [README](../README.md) |
| 配置与默认值 | [环境配置](08-env-config.md) 与 [`.env.example`](../.env.example) |
| 数据库初始化/升级 | [第7节](#7-数据库初始化和升级) |
| 常规发布 | [第11节](#11-日常发布流程) |
| 备份恢复 | [第12节](#12-备份和恢复) |
| 发布验收 | [验证清单](14-verification.md#候选版本发布清单) |
| Trace、指标和告警 | [可观测性](38-observability.md) |

## 1. 部署边界

当前版本具备以下部署特征：

1. 后端是单体进程，HTTP API 和文档处理 worker 在同一个进程中运行。
2. 原文件存于本地目录或私有MinIO；两者均须持久化并定期备份，历史本地路径不自动迁移。
3. 前端生产构建输出到 `frontend/dist`，仓库不提交该目录。
4. 前端默认请求同源 `/api/v1`，推荐通过 Nginx 同源反代。
5. 项目支持显式 CORS 来源白名单；优先同域反向代理，跨域时按 `CORS_ALLOWED_ORIGINS` 配置实际前端来源。
6. migration runner没有版本台账；全新库可全量执行，已有库只能按部署记录选择未应用文件。
7. `/healthz`及`/api/v1/healthz`始终返回HTTP 200，同时在响应体汇总已配置的数据库、Redis、存储状态；不探测模型，不能只据200判断就绪。

由于内置 worker 的任务领取约束，在没有额外验证前，生产环境只运行一个 backend 实例。MinIO 解决共享文件存储问题，但不改变 worker 的单实例约束。

## 2. 环境要求

推荐环境：

| 组件 | 要求 |
| --- | --- |
| 操作系统 | Linux x86_64，例如 Ubuntu 24.04 LTS |
| Go | 1.25，与 `backend/go.mod` 一致 |
| Node.js | 22.12或更高的受支持版本；CI使用Node 22 |
| Docker | Docker Engine 26+ 与 Compose 2.24.4+ |
| PostgreSQL | PostgreSQL 15 或 16，安装 pgvector 扩展：HNSW 需要 ≥ 0.5.0，建议 ≥ 0.8.0（支持迭代索引扫描）。低于 0.8.0 时服务仍能返回完整结果，但依赖精确检索回退，知识库较大时检索变慢；`go run ./cmd/doctor` 与诊断页会显示版本。自建或托管数据库须自行核对版本，Compose 镜像 `pgvector/pgvector:pg16` 随拉取时间变化 |
| Redis | Redis 7 |
| Web Server | Nginx 1.24+ |

服务器还需要能够通过 HTTPS 访问配置的 Chat、Embedding 和 Rerank Provider。

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

以 [`.env.example`](../.env.example) 为唯一完整模板，保存为 `/etc/rag/rag.env`，按实际环境设置下列生产项。其他默认值及模型/存储约束见 [环境配置](08-env-config.md)，不要另维护一份不同步的完整变量清单。

| 配置 | 生产要求 |
| --- | --- |
| `APP_ENV` | `production` |
| `DATABASE_URL` | 独立数据库凭据；特殊字符URL编码，远端连接使用服务商要求的TLS配置 |
| `JWT_SECRET` | 至少32字节的安全随机密钥，替换示例值 |
| `REDIS_ADDR` / `REDIS_PASSWORD` | 实际地址与密码；固定窗口限流和Embedding缓存共用客户端 |
| `TRUSTED_PROXY_CIDRS` | 同机Nginx通常为`127.0.0.1/32,::1/128`；按真实代理链配置，不能信任全部网段 |
| `CHAT_*` / `EMBEDDING_*` / `RERANK_*` | 实际模型端点、凭据与模型；标准RAG启用Rerank，默认strict失败策略 |
| `STORAGE_PROVIDER` | `local`或`minio`；MinIO保持私有，历史本地文件仍需保留 |
| `UPLOAD_DIR` | 例如`/var/lib/rag/uploads`，独立持久目录 |
| `RAG_ALLOW_AUTOMIGRATE` | 保持false；生产禁止GORM自动建表 |

环境文件权限：

```bash
sudo chown root:rag /etc/rag/rag.env
sudo chmod 0640 /etc/rag/rag.env
```

- 项目目录不保留开发 `.env`。`godotenv.Load`只补齐未设置变量，systemd/进程环境优先。
- MinIO endpoint显式scheme优先于`MINIO_USE_SSL`，生产使用HTTPS。bucket须私有；backend检查bucket policy并在发现policy时拒绝启动，凭据需可读取policy及必要对象权限。bucket不存在时会尝试创建。
- 本地文件不会自动搬迁到MinIO；确认迁移与恢复完成前不能删除旧上传目录。
- Embedding模型或维度变更必须遵循下文重建流程，不能只改配置。
- `RATE_LIMIT_FAILURE_MODE=open`在Redis故障时放行业务并记录warning；`closed`令受限接口返回503。Embedding缓存始终降级到Provider。
- 暂时显式关闭Rerank时，分数为空且结果必须保持未精排语义；这不是标准RAG质量验收。

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

生产及默认启动调用只读 `database.EnsureSchema`，缺失结构由显式SQL迁移补齐；只有非production且 `RAG_ALLOW_AUTOMIGRATE=true` 才允许可丢弃开发库创建缺表。GORM建表不等同于SQL迁移，不能用该开关补生产迁移。

### 7.3 已有数据库

根据 [当前迁移要求](03-database-design.md) 与目标库的实际记录逐文件补齐，不根据旧交接猜测当前版本；同编号文件以完整文件名为准。

| 迁移范围 | 关键内容与额外操作 |
| --- | --- |
| 001–022 | 初始模型、权限/回收站、质量与头像等历史结构 |
| 023 | UTC/timestamptz；保持旧值按UTC读取的含义，不自动纠正历史时差 |
| 024 | tsvector/GIN/HNSW；迁移后执行关键词回填，可按数据量放宽超时 |
| 025–029 | 账号状态/用量/回答配置及向量来源；旧向量来源保持未知 |
| 030–033 | 多库关联、自动范围、PDF页摘要、历史分页索引 |
| 034–039 | 收藏、版本链索引、分支、模板、来源路径及表格错误码 |
| 040–043 | 上传凭据、表格设置、版本策略、PDF快照与OCR错误码；不自动重处理旧PDF |
| 044–047 | 指定文档范围、OCR校对基线、私人评测与问题跟进 |
| 048 | `general`意图约束；缺少时启动拒绝 |
| 049_document_job_traceparent | 保存文档任务父Trace上下文；缺列时启动拒绝 |
| 049_retire_personal_chat_features | 退役个人模板表与分支请求编号，保留历史会话、来源、收藏和模型费用 |

当前dev有两份独立049迁移，沿用各分支已使用的完整文件名，runner不会按数字去重。按目标库记录分别补齐：只应用到047时先执行048；已执行退役049的本机库仍需追踪049，已执行追踪049的旧监控库仍需退役049。仅运行缺失项，备份并停止旧写入者后执行：

```bash
./bin/rag-migrate -migration 048_chat_message_general_intent.sql
./bin/rag-migrate -migration 049_document_job_traceparent.sql
./bin/rag-migrate -migration 049_retire_personal_chat_features.sql
```

退役049会删除个人提问模板正文，回退须恢复对应备份及原结构；它不删除历史分支消息、来源链接、收藏备注或标题费用记录。

先备份并停止旧写入者，再迁移并启动匹配的前后端。迁移不会自动重建向量或回填OCR/旧来源，确需重处理时单独执行。不要用AutoMigrate补迁移：它可能创建缺少CHECK/外键的表，使后续`CREATE TABLE IF NOT EXISTS`跳过真实结构。当前发布要求检查以迁移与实际启动入口为准。

`-migration`只接受`migrations/`中的完整文件名，不接受路径；单文件在一个事务中执行，但不会检查前置迁移，必须保留部署台账。

升级到 `timestamptz` 时，确认 001–022 已执行，备份数据库并停止旧版 backend 和 worker，再执行：

```bash
./bin/rag-migrate -migration 023_timestamps_with_time_zone.sql
```

023 仅处理连接 `current_schema()` 下已知业务表的无时区时间列，按表合并 `ALTER COLUMN`，使用 `AT TIME ZONE 'UTC'` 保持现有时间含义；已是 `timestamptz` 的列跳过，可重复执行。这是类型升级，不自动修正历史时间偏差。迁移需要表锁，宜安排维护窗口；单文件事务失败会回滚，命令当前总超时为 30 秒，大库应提前评估耗时。

核对记录数、时间值、默认值和索引后启动匹配的backend。时间字段校验发现旧时间列会报错并提示023，不会代替这次类型迁移；生产和默认启动仅做只读校验，不创建缺表。其他schema或环境须按自己的连接配置与迁移记录分别升级。

尚未完成混合检索迁移024时，确认001–023已执行，在维护窗口内执行：

```bash
./bin/rag-migrate -migration 024_hybrid_search.sql -timeout 30m
./bin/rag-reindex-keywords
```

024 为 `document_chunks` 增加 `search_vector tsvector` 列与 GIN 索引，并用 HNSW 索引替换 ivfflat 向量索引，可重复执行。构建 HNSW 索引会读取整张表，`-timeout` 应按数据量放宽（默认 30 秒只适合空库或小库），并可为会话提高 `maintenance_work_mem`。迁移完成后 `rag-reindex-keywords` 按主键分批回填已有 chunk 的关键词索引，每批独立提交，可中断后重跑；回填期间旧 chunk 继续参与向量召回，只是暂不参与关键词召回。新版 backend 可在回填进行时启动。`-batch` 控制每批数量（默认 200），`-timeout` 默认 1 小时。

### 7.4 初始化系统管理员

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

后端收到 SIGTERM/SIGINT 后停止接收新请求，取消文档、清理和评测 worker，并最多用 25 秒等待 HTTP 请求与 worker 收尾；超时关闭连接。`TimeoutStopSec=30` 留出进程退出余量。请求头读取上限为 5 秒、空闲连接上限为 60 秒；SSE 不使用覆盖整个响应的 `WriteTimeout`。停机时尚未完成的流必须按未确认结果处理。

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
        proxy_buffering off;
        proxy_cache off;
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
{"env":"production","status":"ok","dependencies":{"database":"ok","redis":"ok","storage":"ok"}}
```

HTTP 200表示进程仍能响应；依赖异常时仍返回200，必须查看`status`和`dependencies`。未配置的依赖可省略。受保护的管理员诊断提供更多原因与队列状态；模型Provider仍需真实入库、检索和问答验证。

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

1. 在独立构建目录完成同一候选的后端test/vet/build、前端npm ci/lint/typecheck:test/test/build，并确认适用CI在该目标提交结束且通过。当前CI提供一次性PostgreSQL/pgvector并验证完整迁移与启动断言；业务部署库仍须独立核对，入口和证据边界见 [验证文档](14-verification.md#postgresql-与-minio)。
2. 安排单实例维护窗口，按下一节停止后端并完成数据库、对象文件、历史本地文件的一致性备份。
3. 保持后端停止，发布匹配的前后端构建，并审查、执行本次新增 migration。
4. 运行 doctor，启动 `rag-backend`，执行健康检查与完整业务冒烟，再恢复用户访问。
5. 失败时保持维护状态；涉及 schema 变更的回退须使用匹配的备份与旧程序版本，不能只替换二进制。

当前后端是单实例部署，重启期间会有短暂不可用。不要在未验证任务领取语义和共享上传存储前横向扩容 backend。

## 12. 备份和恢复

至少备份：

- PostgreSQL 数据库。
- MinIO 的 `rag-documents` bucket；仍有历史本地路径时同时备份 `/var/lib/rag/uploads`。
- `/etc/rag/rag.env` 的加密副本。

单实例必须先停止所有写入者，包括 HTTP 后端及其文档、清理、评测 worker；暂停外部导入、迁移和直接存储写入。数据库与文件在整个备份期间均保持静止。下面示例假设本指南的唯一 systemd 后端，操作者有 `/var/backups/rag` 写权限；若有其他进程，先确认全部停止。每次使用全新目录，不复用历史镜像：

```bash
set -euo pipefail
sudo systemctl stop rag-backend
test "$(systemctl show rag-backend --property=ActiveState --value)" = inactive
test "$(systemctl show rag-backend --property=MainPID --value)" = 0
backup_dir="$(mktemp -d /var/backups/rag/backup-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX)"
docker exec rag-postgres pg_dump -U rag -d rag -Fc > "$backup_dir/database.dump"
mc mirror production/rag-documents "$backup_dir/rag-documents"
# 仅在仍有历史本地文件时执行：
tar -C /var/lib/rag -czf "$backup_dir/uploads.tar.gz" uploads
```

文件复制成功后，按运维密钥管理流程保存配置的加密副本，记录程序版本、migration 版本、bucket、时间和各备份文件校验和。检查 `pg_restore --list`、归档可读性及对象清单后，才能标记这组备份完成。任何步骤失败都保留为未完成备份，后端继续停止，不能将其作为可恢复版本。全部完成后才可继续发布，或在不升级时启动原后端。不要设置失败后自动重启写入者的 shell trap。

恢复演练在独立目标进行：保持目标后端停止，将同一组数据库、MinIO 文件、历史本地文件及配置恢复到匹配的程序版本；不要混用不同批次。确认 schema/doctor 通过、数据库内文件引用能读取，并以隔离账号验证登录、文档预览/下载、检索和引用后，才开放写入。记录缺失文件、校验结果与演练时间；仅列出备份文件不等于恢复成功。Redis 缓存不作为权威备份，浏览器本地草稿不在服务器备份内。

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

前后端Dockerfile及完整单实例Compose、显式迁移和备份恢复脚本已提供；自动TLS、迁移版本台账、自动发布/回滚及多实例任务租约仍未交付。缺口与启动条件集中见 [有效待办](15-backlog.md)，发布判断见 [验证清单](14-verification.md#候选版本发布清单)。

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

当前 document worker 仍要求单实例。部署多实例或重叠滚动发布之前必须完成 任务租约与 fencing；共享文件需要 MinIO，诊断指标仍按进程统计，Redis 故障默认放行。

## OCR工具与历史文档

OCR 默认为关闭。Linux/Debian 可由部署管理员安装 `poppler-utils tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-eng`；Windows 使用受信任的 Poppler/Tesseract 5 发行包，并设置可执行文件与 tessdata 的绝对路径。原生工具运行在后端机器，需具备读上传临时副本和创建临时图像的权限。确认 `pdftoppm -v`、`tesseract --version` 和 `tesseract --list-langs` 正常，且包含所配置语言；便携安装为最后一条补充 `--tessdata-dir <语言目录>`。随后启用 `PDF_OCR_ENABLED=true` 并启动单实例新版服务，完整参数见环境配置文档。

OCR 工具不随 Go 可执行文件或当前容器镜像内置；需要在自定义运行镜像中安装上述系统包，或者部署到已安装工具的机器。修改路径或安装依赖不要求修改业务数据；重新处理失败文档即可重试。部署 OCR 语言包与资源预算由管理员控制，上传者不能指定任意命令、路径或额外参数。图片内包含少量可提取文字的混合页不会强制 OCR，不保证复杂版面、手写内容或低清扫描的识别率。

## 可观测性部署

Compose的observability profile提供Collector/Jaeger/Prometheus/Grafana，端口仅绑定回环地址；默认启动数据库/Redis不会启动观测栈。启动命令、配置、查询和验证统一见 [可观测性](38-observability.md)。合并代码不等于已更新正在运行的后端或数据库，升级前须补齐任务traceparent迁移，随后部署匹配程序。
