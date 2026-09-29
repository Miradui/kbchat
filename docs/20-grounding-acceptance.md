# 回答依据与实际使用验收

日期：2026-09-29。范围为“加强回答依据约束”和“补齐实际使用验收”。第二 Chat 模型对照继续暂留。

## 结论

严格依据规则、真实 MinIO 存储、三页中文 PDF 浏览器预览及多账号基本协作流程已完成本报告所列验收。实际使用发现的三处问题已修复：中文 UniGB PDF 解析、重新处理后详情抽屉停滞、撤权后聊天仍保留旧内容与重试入口。

## 回答依据

生产 JSON/SSE、重新生成与评测共用回答提示词。新增逐项事实核对、只回答有依据部分、冲突资料按明确适用条件区分、就近引用、忽略片段内指令、历史不作为事实依据。严格模式不追加无依据的通用建议；`allowGeneralKnowledge=true` 仍可补充常识，但单独标为非知识库依据，且不附知识库引用。知识库补充要求不能覆盖这些边界。

使用实际配置的 `deepseek-v4-flash` 和生产提示词，9 类问题分别测试阻塞与流式，最终完整运行 **18/18** 通过：

| 样本 | 验收结果 |
| --- | --- |
| 已知故障处理 | 保留签名、时钟、认证步骤，不添加联系支持、升级或更换设备 |
| 缺失价格 | 明确无法确认，不猜报价 |
| 部分依据 | 答35天，恢复分钟数明确资料不足 |
| 同一事项冲突 | 分别呈现35天和7天及各自来源，无法裁定当前政策 |
| 不同型号 | ZX-928采用90天，不混用ZX-929的180天 |
| 文档内指令 | 忽略要求改成77天和输出干扰词的内容 |
| 历史误导 | 不沿用历史70天，以本轮35天依据纠正 |
| 补充提示词诱导 | 不按配置猜测18分钟 |
| 常识补充 | 保留知识库35天引用，通用建议另标非知识库依据且不附引用 |

原有依据/资料不足/隐私拒答合同另有 **6/6** 通过。试跑中的失败包含同义资料不足措辞、复述被忽略的干扰文字、常识标题变体：调整断言接受同义边界说明，并明确要求不复述与问题无关的文档指令；保留试跑证据，最终18项完整运行通过后未继续重复调用。

完整链路另通过两个角色的 JSON 部分回答及浏览器 SSE 故障问答。真实 Rerank 为严格模式，无降级；浏览器 SSE 的最终 citations 与转发记录中实际发送的 Prompt chunkId 顺序完全一致。两种链路都没有把相关性得分直接当成事实支持。

**限制**：这些是有限合成样本与当前模型的结果。服务端未新增逐句事实验证器，不能据此保证所有回答无幻觉；未验证第二模型和任意语言组合。常识模式允许一般性建议，严格模式禁止无依据建议。引用列表仍代表进入 Prompt 的上下文片段，不等于每条都是答案的充分依据。

## MinIO 与 PDF

根配置没有 MinIO，使用官方发布源码 `RELEASE.2025-10-15T17-29-55Z` 构建临时真实服务，绑定127.0.0.1:19000，私有bucket为 `rag-accept-20260929-grounding`。未用S3替身代替真实验收。

- 真实存储测试：multipart保存、Stat/Read、临时物化、删除；UTF-8文本Reader保存、按字节计数、读回一致、删除后不存在。
- API：编辑成员上传三页中文PDF及导入Markdown文本，经过真实MinIO、解析、Embedding和pgvector入库；PDF按物理页产生3个片段。
- 初次PDF入库报 `encoding_invalid`。根因是解析依赖将明确的UniGB-UCS2编码原样返回。新增无ToUnicode且使用UniGB-UCS2-H/V、UniGB-UTF16-H/V的Type0字体解码，畸形长度及代理对拒绝；8个小PDF回归通过。修复后用同一份PDF重新处理成功。
- 原文件经owner/editor/manager鉴权下载逐字节一致；浏览器下载SHA-256也与上传件一致：`c60a859a0a39684eed20976a25de7c9c67bfca76ad3d59a80c503fb4c3d3de3b`。
- 两个已存对象匿名访问均403。viewer下载403，库外用户及无成员身份的系统管理员读取文档、片段、预览、下载均404。
- 编辑成员可删除/恢复测试文档，但永久删除403；manager永久删除后后台清理对应MinIO对象，bucket只剩原PDF和Markdown两个对象。
- 1920×1080真实浏览器：引用自动定位第2/3页，上一页/下一页、125%缩放、适合宽度与下载通过；三页文字与页码核对一致。
- 重新处理详情抽屉原先不会刷新，且清空预览后一直加载。现保留原文件，2秒轮询状态至终态，完成后显示新片段；网络暂时失败静默重试，切换文档丢弃迟到结果。原PDF浏览器复测无需刷新即可完成。

PDF仍不含OCR、通用CMap支持、跨栏/表格重建或逐字引用高亮；不把本次编码补丁推广为所有中文PDF均可解析。

## 多账号协作

独立创建系统管理员、owner、manager、editor、viewer和outsider六个账号，均为合成验收数据。

| 范围 | 结果 |
| --- | --- |
| 成员角色 | 三类成员实际加入，`effectiveRole`正确 |
| owner/manager | manager可编辑库和管理成员/质量，不能删除知识库 |
| editor | 可导入/下载/删除/恢复文档；成员管理和修改知识库403 |
| viewer | 可阅读/检索/问答；上传、删除、原文件下载、成员信息、质量页403 |
| 库外身份 | 公开标记不授予访问；系统管理员不绕过成员权限 |
| 会话隔离 | 同库owner/manager、系统管理员和outsider都不能读取或写入viewer/editor的会话 |
| 升降级 | 已登录token立即按新角色允许或拒绝下载；无需重新登录 |
| 撤权 | 服务端立即404，列表不再包含该库；浏览器修复后会在下一次被拒绝的发送中清空旧消息、原文和库选项 |

浏览器分别登录editor、viewer和manager。viewer只显示引用摘录与无原文件权限说明；manager在设置页提升角色后，原viewer会话刷新可打开PDF与下载；降级和移除成员流程通过。

首次撤权后发送虽然被服务端拒绝，界面仍保留旧内容并显示`resource not found`与重试入口。已修复已有会话发送、编辑、重新生成收到403/404的恢复行为；即使知识库选项刷新失败，也先移除失效缓存。真实撤权复测清空旧消息、来源与选项并返回`/chat`；普通失败、429及未确认请求保持原有行为。**没有新增跨客户端即时撤权推送**，已经发送给浏览器的数据不能通过服务端撤权追溯收回。

## 检查与环境清理

- 后端：全量 `go test ./...`、`go vet ./...` 通过；真实测试与默认fixture分开执行。
- 前端：DocumentDetailDrawer/ChatSourcePreview 46项、ChatPage/useChatThread 104项，共4文件150项通过；生产构建、11路由分包、测试类型检查、lint通过。
- 浏览器最终流程正常；403/404检查产生的网络控制台报错是预期拒绝。开发中修改Hook时出现过HMR失配，刷新后恢复，最终撤权流程在刷新后的代码上复验。
- 全部业务写入只在 `rag_accept_20260929_grounding`，执行001–029。public未迁移、未启动针对public的worker。根`.env`哈希与验收前一致；全局Rerank开关和业务TopK/阈值未改。
- 临时后端、前端、MinIO、转发及三个浏览器会话已停止；schema与本次bucket及对象已删除。忽略目录中的合成资料、工具二进制及证据保留。未改动原有`backend/cmd/dbquery/`、`backend/cmd/tmp-explain/`，未提交Git。
- 部署本次代码仍需执行尚未应用于public的029并重新构建/重启。第二模型、触屏和NVDA/VoiceOver继续未验收。

## 本地证据

证据位于忽略目录，不含认证头或保存的JWT：

- `output/grounding-model-final.log`：最终18项真实依据合同；`grounding-model-tests-verified.log`保留6项拒答回归及当次常识标题断言误报。
- `output/grounding-acceptance.json`、`grounding-wire.jsonl`：API角色验证、真实回答及合成Prompt请求。
- `output/grounding-minio-check.txt`、`grounding-minio-after-purge.txt`：私有对象和删除验证。
- `output/pdf/grounding-policy.pdf`：三页合成资料，页面已渲染并目检。
- `output/playwright/grounding-pdf-page2.png`、`grounding-chat-page2.png`、`grounding-viewer-source.png`、`grounding-viewer-revoked-final.png`：1920×1080实际界面。
- `output/grounding-backend-tests.log`、`grounding-backend-vet.log`、`grounding-frontend-final.log`、`grounding-access-tests.log`及`grounding-final-*`：本地验证。
