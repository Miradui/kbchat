# Docker / Compose 发布

此部署运行一个后端（包含worker）、Nginx生产前端、PostgreSQL/pgvector和Redis。默认仅将前端绑定到 `127.0.0.1:8088`；数据库/Redis及后端没有宿主端口。支持Linux amd64和arm64按目标机器构建。使用Docker Compose 2.24.4+、Bash、OpenSSL，以及sha256sum（Linux coreutils）或shasum（macOS）；构建需访问Docker Hub、Go模块和npm注册表。

## 首次安装

在解压后的项目根目录执行：

```bash
cp deploy/.env.production.example deploy/.env.production
chmod 600 deploy/.env.production
# 分别生成POSTGRES_PASSWORD、REDIS_PASSWORD、JWT_SECRET并填入配置文件：
openssl rand -hex 32
```

填写Chat、Embedding、Rerank的地址/密钥/模型和Embedding维度。数据库密码使用上面生成的hex值，避免连接URL特殊字符；设置独立的 `BOOTSTRAP_ADMIN_PASSWORD`。不要使用开发账号默认密码。服务端访问模型时，`127.0.0.1`指容器自身，不能填写宿主机回环地址；使用容器可访问的模型网关。Docker Desktop/OrbStack可使用 `host.docker.internal`，Linux需配置网关或实际主机地址。

```bash
./deploy/release.sh build
./deploy/release.sh init
./deploy/release.sh admin admin
./deploy/release.sh start
./deploy/release.sh status
```

`init`只接受空库，按完整文件名执行所有SQL；非1536维只在新建空库上调整向量列/HNSW，1–2000维。已有库重跑init会被拒绝。`admin`需显式新账号和密码，之后从env中移除 `BOOTSTRAP_ADMIN_PASSWORD`。只有 `init`/`migrate` 命令执行迁移，正常启动只读校验schema。访问 `http://127.0.0.1:8088`；HTTP探针还检查响应体的依赖状态。

`COMPOSE_PROJECT_NAME`决定数据卷归属，升级时必须保持不变。`KBCHAT_VERSION`给镜像标记版本；不同安装实例应使用不重叠的 `KBCHAT_SUBNET`/`KBCHAT_DYNAMIC_RANGE`/`KBCHAT_PROXY_IP`（固定代理IP必须在动态地址池之外）。后端只信任指定Nginx IP，Nginx覆盖客户端可伪造的转发头。使用固定 `/app/uploads` 卷路径，非root后端启动；生产不使用相对上传目录或挂载开发目录。

## 外部访问与TLS

默认入口供本机验证或由受控TLS入口转发。正式提供给用户时，使用现有网关/Nginx/Caddy配置域名和HTTPS，并相应更新CORS。不得直接将无TLS的开发入口作为公网登录入口。

若另有反向代理转发到本Compose，当前Nginx默认按连接来源限流：需在 `frontend/nginx.conf` 中仅对实际可信网关配置 `set_real_ip_from` 与 `real_ip_header X-Forwarded-For`，然后重建前端；不要信任任意客户端提供的转发头。直接向内网开放HTTP时可设置 `KBCHAT_BIND` 为指定内网IP，按实际风险部署。TLS证书、域名及外部网关由目标环境提供，不包含默认自签证书或自动公网暴露。

## 升级

先记录当前镜像ID/版本，保留旧镜像，并准备新版本源文件。停止全部旧后端写入者后，创建同一停写窗口的备份；保持单实例，禁止滚动重叠或scale backend。

```bash
./deploy/release.sh stop
./deploy/release.sh backup /secure-backups/kbchat-20261120
# 切换到新发布包，保留同一env、项目名、网络和具名卷；修改KBCHAT_VERSION。
./deploy/release.sh build
# 仅补齐目标库未执行的完整文件名，示例：
./deploy/release.sh migrate 049_document_job_traceparent.sql
# 若退役迁移尚未执行，审阅其删除个人模板正文的影响后再执行：
# ./deploy/release.sh migrate 049_retire_personal_chat_features.sql
./deploy/release.sh doctor
./deploy/release.sh start
```

最高编号049包含两份不同迁移；不能用“执行过049”代替完整文件记录。runner尚无迁移版本表，维护部署台账。禁止对已有库重放全部SQL；历史002会改变向量维度，049退役迁移会删除个人模板表。Embedding模型/维度切换不是普通启动配置变更，需按部署规范重建向量。

## 备份与恢复

`backup`要求后端已停止，保存数据库自定义格式dump、上传文件归档、env、Compose配置和镜像信息及SHA-256。目录权限由umask 077限制；env含密钥，应加密转存并限制访问。备份结束保持停止，由操作者明确start；失败时不会自动重新开放写入。

`restore`只接受空数据库和空上传卷，并核验备份校验和。使用**新的Compose项目和独立网络/端口**建立恢复目标；不要指向当前业务项目。准备与备份匹配的镜像及模型配置，然后：

```bash
KBCHAT_ENV_FILE=/secure-config/restore.env ./deploy/release.sh restore /secure-backups/kbchat-20261120
KBCHAT_ENV_FILE=/secure-config/restore.env ./deploy/release.sh start
```

验收登录、文档预览/下载、检索与引用之后再决定是否切流量。回退需要匹配程序、schema和文件备份，不能仅把程序换旧。脚本不会删除数据卷。若使用MinIO，backup脚本会拒绝不完整备份，需遵守 `docs/13-deployment.md` 的数据库/对象/历史文件一致性备份步骤。

## 运行配置

- 后端停止预算35秒，应用HTTP/worker收尾最多25秒，遥测刷新最多3秒。
- 默认本地存储；MinIO可通过env增加 `MINIO_*`，bucket保持私有。卷仍用于历史文件。
- 镜像包含Poppler、Tesseract及英文/简体中文数据；OCR默认关闭，按语料需要设置 `PDF_OCR_ENABLED=true`。
- 上传单文件50MiB，Nginx请求上限51MiB。SSE关闭响应缓冲，读取空闲超时300秒；外层网关也应关闭缓冲并设置匹配超时。
- 内置监控按需启动：`KBCHAT_OBSERVABILITY=true ./deploy/release.sh start`，后端自动使用Compose内部Collector。Grafana/Prometheus/Jaeger仅绑定本机3000/9090/16686，可在env中用GRAFANA_PORT/PROMETHEUS_PORT/JAEGER_PORT改端口；后续使用同一标志执行命令。Grafana匿名只读，Prometheus保留7天，Jaeger为内存存储。改变Jaeger端口时同步datasource的exemplar跳转URL。不要将监控入口暴露到公网。
- 也可使用外部监控：不加上述标志，在env设置容器可达的两个 `OTEL_EXPORTER_OTLP_*_ENDPOINT` 完整URL，参考 `docs/38-observability.md`。
- 修改env后先stop再start；不会自动迁移。`status`看容器状态，`doctor`检查DB/Redis/向量维度；模型可用性还需真实入库问答。

## 验证与限制

`deploy/smoke-compose.sh`使用随机秘密、一次性项目和独立卷验证构建、完整初始化、重复初始化拒绝、管理员登录、SPA路由、健康、重启和doctor；结束删除它自己的测试卷，不能用于业务项目。GitHub CI在Linux amd64运行此检查。

发布验收证据见 `docs/14-verification.md` 的REL-COMPOSE-001。当前版本仍限定单实例；团队问题交接、多租户、SSO、跨实例worker租约、自动TLS和自动发布/回滚不在本版本范围。
