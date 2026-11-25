# 性能与回答质量基准

这套工具把固定语料、API测量、失败证据和内容审核放在同一运行目录，支持比较两次代码版本。使用Python标准库和独立Docker Compose项目，应用仍是仓库现有Go后端。

要求Python 3.9+、本机Docker及Compose v2。所有命令在仓库根目录执行；Windows上的Python命令可能为python。只接受本机Docker上下文；数据库和Redis不映射宿主端口，API动态绑定127.0.0.1。首次运行需要构建后端镜像和下载基础镜像。

## 快速验证

```bash
python3 -m unittest discover -s benchmarks/tests -v
python3 -m benchmarks smoke --run output/benchmarks/smoke-001
```

smoke创建全新数据库，执行迁移和向量维度初始化，创建管理员，真实执行解析、切片、入库与HTTP流程；模型使用本地确定性替身。运行检索、质量请求、流式并发和100条合成向量负载，结束时仅删除自己创建的容器和卷，保留报告。

替身只验证协议和测量流程，报告标记fixture，不能用其回答或延迟宣称真实模型质量。CI执行同一入口，不需要真实密钥。

## 真实模型运行

先从示例创建本地模型配置，填写当前模型：

```bash
mkdir -p output
cp benchmarks/models.env.example output/benchmarks-models.env
chmod 600 output/benchmarks-models.env
```

文件只接受Chat、Embedding、Rerank的URL、密钥、模型及Embedding维度共十项；不自动读取根.env或继承应用环境。主机上的Ollama/Reranker地址使用host.docker.internal，并确认服务允许Docker主机网关访问。远端模型会产生真实调用和费用。

```bash
python3 -m benchmarks init --run output/benchmarks/baseline --profile real --models-env output/benchmarks-models.env --max-model-requests 1000
python3 -m benchmarks up --run output/benchmarks/baseline
python3 -m benchmarks seed --run output/benchmarks/baseline
python3 -m benchmarks run --run output/benchmarks/baseline --suite retrieval
python3 -m benchmarks run --run output/benchmarks/baseline --suite quality
python3 -m benchmarks run --run output/benchmarks/baseline --suite stream --case-ids E01,E02,P01,P03,T01 --requests 20 --concurrency 1,2,4 --rounds 2
python3 -m benchmarks report --run output/benchmarks/baseline
python3 -m benchmarks down --run output/benchmarks/baseline
```

先用少量问题联调，可在retrieval/quality命令加 `--case-ids E01,P03,T01`。每个cohort的题目和参数首次创建后冻结；改变子集或参数请新建run。

`--max-model-requests` 限制可能调用模型的顶层请求数，持久化且并发安全；导入、搜索、预热、问答都会预留一次。它不是Provider调用数或token金额：一次问答可能分类后再回答，一份文档可能多批Embedding。预算耗尽保留失败，既有失败和未知请求不会自动再生成。独立测试环境限流设为10,000/min，应用默认值不变。

## 四类测量

| suite | 内容 | 解释 |
| --- | --- | --- |
| retrieval | 原问句的纯向量、混合、混合+精排及默认阈值；TopN30/TopK5 | 排名三组阈值0；standard阈值0.3，预热query embedding；不等同聊天改写后的查询 |
| quality | 每题独立会话、SSE回答及引用 | 自动检查仅测来源编号与依据锚点，内容质量另行审核 |
| stream | 按并发、轮次发送固定问题，奇偶轮反向安排并发档 | 首字含意图分类、检索、模型等待；每次独立会话与请求ID |
| load | 文档列表、向量检索；随机归一化向量和16个预热查询 | 关闭关键词/精排，不代表语义质量或HNSW索引召回率 |

容量测试示例：

```bash
python3 -m benchmarks init --run output/benchmarks/capacity --profile fixture --max-model-requests 10000
python3 -m benchmarks up --run output/benchmarks/capacity
python3 -m benchmarks seed --run output/benchmarks/capacity
python3 -m benchmarks run --run output/benchmarks/capacity --suite load --vectors 1000,10000 --requests 1000 --concurrency 1,4,16
python3 -m benchmarks down --run output/benchmarks/capacity
```

真实向量维度性能使用real模式；fixture为64维，不能与1024维直接比较。容量数据直接写入独立库，文档仅有元数据，不代表文件解析或Embedding吞吐。每种规模独立一个库，所选规模先全部入库；报告记录累计规模。向量元素总数上限2500万，最大并发64、请求总时限600秒、最多10轮。

单次 `totalMs` 从HTTP发送到响应终止，首字为首个非空delta。每请求新建连接，不含浏览器、TLS、代理。P50/P95/P99线性插值，仅统计有效成功时延，另列失败、未知与未运行。done-only重放的首字时延为空，不填0。

`driverCompletedRps` 包含空会话创建、预算/结果落盘及Python调度，不是服务器最大QPS。持续心跳不能延长总时限；HTTP200不代表流式成功，须有结构和ID正确的done。

## 中断与恢复

每次操作有独占锁，每样本先保存in_flight和请求ID，结束后原子写入结果。异常退出后：

```bash
python3 -m benchmarks unlock --run output/benchmarks/baseline
python3 -m benchmarks up --run output/benchmarks/baseline
python3 -m benchmarks reconcile --run output/benchmarks/baseline
python3 -m benchmarks run --run output/benchmarks/baseline --suite quality
```

仅在异常退出留下锁时unlock；原PID仍存在会拒绝。up校验源码、脚本、语料和运行镜像；改变输入须新run。正常down保留卷。初始化迁移、维度和归属标记在同一数据库事务内，丢失提交回执可读取标记确认。

重复run只补没有记录的样本。失败保留；未知样本按原session/clientRequestId只读对账，找到已提交消息可恢复答案，时延仍为空。查空不证明原请求停止，也不会自动付费重发。新尝试应建新run。

run命令在所选suite存在失败、未确认或未运行样本时返回退出码1，同时保留报告；完成全部请求不表示内容审核通过。report可在服务停止后离线生成。

资源身份不符即停止。down重新核对专用标签、确定名称和挂载卷，拒绝复用或删除外部资源。彻底清理：

```bash
python3 -m benchmarks down --run output/benchmarks/baseline --remove-volumes
```

删除卷后run不可恢复；报告及原始样本继续保留。

## 内容审核

自带6篇虚构文档和48题，覆盖跨篇组合、条件、边界值、缺资料和误导前提。证据锚点在初始化时与原文核对。自有语料可复制datasets/demo，修改dataset.json、cases.json及Markdown，通过 `init --dataset 路径` 冻结到run。

```bash
python3 -m benchmarks review --run output/benchmarks/baseline
```

编辑review-template.json，填写reviewer、method、事实正确、完整性、引用支持、说明及pass/partial/fail。缺资料题还须填写missingInformationHandled，通过时必须为true。answerHash绑定实际答案；参考事实不会进入回答Prompt，也没有自动LLM裁判。

```bash
python3 -m benchmarks review --run output/benchmarks/baseline --import output/benchmarks/baseline/review-template.json
```

标签按版本归档。未审核显示pending，不把answered计为正确。检索每模式分别列计划正例、成功正例、完整依据；后一步失败不删除前面成功结果。题集结果不能代替真实用户盲评或总体准确率。

## 手动 RAG Evals

`evals` 对已有运行的原始检索结果、答案和引用离线重算，输出 `evals.json` 与 `evals.md`。不启动 Docker、后端或模型，不读取模型密钥。纯检索评分只需 Python；包含成功 quality 样本时还需 **Node 22.18+** 和已安装的前端依赖（在 `frontend` 目录运行 `npm ci`），直接复用应用的 Markdown 解析器和引用插件，无需构建前端或新增依赖。它与上面的 `run --suite retrieval/quality` 配合使用；新运行仍按“真实模型运行”章节显式创建与执行。

```bash
python3 -m benchmarks evals --run output/benchmarks/baseline
python3 -m benchmarks evals --run output/benchmarks/candidate --baseline output/benchmarks/baseline
```

这是手动分析工具，**不设置 CI 门禁、质量阈值或质量失败退出码**。报告成功生成时退出 0，包括低分、请求失败、未运行、待审核和不可比较；输入损坏、语料被改动或审核标签过期时退出 1。报告的 `complete` 仅表示计划样本都有可评分响应；未确认、未运行、请求失败或无效响应显示 `incomplete`，不等于质量通过/失败。

| 指标 | 口径 |
| --- | --- |
| requestSuccessRate | 有可评分响应的请求数 / 计划请求数 |
| completeEvidenceRate | 覆盖全部依据单元的正例数 / 计划正例数 |
| evidenceUnitRecall | 覆盖的依据单元数 / 计划依据单元数；一个单元的全部锚点都须命中 |
| documentRecall / documentMRR | 各正例的目标文档召回比例 / 首个目标文档排名倒数，再除以计划正例数 |
| sourceIndexValidityRate | 正文所有 `[source: N]` 均为合法编号的回答数 / 计划问题数；无标注也满足此项，须结合下一项 |
| inlineCitationRate | 正文带来源标注的正例数 / 计划正例数 |
| citedEvidenceRate | 正文实际标注的片段覆盖全部依据的正例数 / 计划正例数 |
| semanticPassRate | 只在 real 模式且全部计划回答均有有效审核时计算严格 pass 比例；否则为空 |
| missingInformationHandledRate | 只在 real 模式且全部缺资料题均有有效审核时，计算明确正确处理缺资料的比例 |

检索按各模式的 TopK 评分，vector/hybrid/reranked/standard 分开汇总，不混成一个分数。回答依据覆盖使用返回的全部 citations，正文引用覆盖只使用实际标注的片段；锚点按现有规则忽略空白和大小写，文档 ID 必须匹配。失败/未知/未运行/无效样本保留在计划分母并得 0 分；缺资料题的依据覆盖不适用，不据 `answerStatus` 或拒答关键词自动判断正确。报告还保留分组、题型、逐题问题、Rerank fallback 数和缺失元数据数量。

引用解析与产品一致：支持大小写、空白、`[source: 1, 2]` 及组内去重；超20项、非法或越界的整组不计入正文引用。Markdown 行内/块代码、已有链接、图片和 HTML 中的字面标记不计分；按实际渲染树只检查已引用脚注，未引用的脚注定义不计分。评分身份包含适配器、产品引用插件和前端锁文件，避免规则更新后沿用旧评分身份。

事实正确、完整性、引用支持与缺资料处理仍通过前述 `review` 流程核对；`answerHash` 绑定当前答案和 citations，旧标签拒绝重用。fixture 即使有人工标签也不生成模型语义率。参考事实不发送给回答模型，也不以关键词命中冒充事实正确。

可选 `--baseline` 同时离线重评两个运行，核对语料、模型、测量脚本、题目计划、配置和评分器身份；只输出兼容指标的“候选减基线”差值，语义未审核的差值为空。两次运行的状态不完整或输入不兼容时保留原因，不输出可能误导的差值。允许应用源码和运行时文档 UUID 变化；对比不证明因果，也不比较性能或代替下节既有性能 `compare`。

每次报告记录评分器文件 SHA-256、实际读取输入的规范化 JSON SHA-256 和原运行提交。支持用当前评分器重评历史运行，不要求历史应用代码等于当前工作区；它仍只反映历史样本。需要保留原运行目录中的 `manifest.json`、冻结 `dataset.json`、`state.json` 文档映射、相关 cohort 计划/样本及可选 `review.json`；现有 export 包不含 state，不能直接用于重评。报告不含答案正文，原始样本继续留在运行目录。重复执行覆盖本次派生的 evals 文件，不改原始样本或原 benchmark 报告。

验证评分器：`python3 -m unittest discover -s benchmarks/tests -p test_evals.py -v`。评分单元测试使用固定解析结果；两项 Markdown/CLI 集成测试实际使用产品解析器，缺 Node 或前端依赖时明确跳过。CI 配置和既有 smoke 保持原样，不运行模型 evals 或据质量分数拦截合并。

## 基线比较与分享

代码优化后新建run，保持模型、语料、资源、工作负载、缓存策略和测量脚本一致：

```bash
python3 -m benchmarks compare output/benchmarks/baseline output/benchmarks/candidate --max-regression 0.20
```

比较检查题目顺序和次数、配置、模型维度、数据库/Redis镜像、主机资源及脚本身份；允许后端代码/镜像变化。不兼容、缺样本或质量待审核退出2；兼容但P95/首字P95回退超阈值、错误增加或审核完整率下降退出3；通过退出0。数值变化不自动证明因果，模型波动需重复验证。

```bash
python3 -m benchmarks export --run output/benchmarks/baseline --output output/benchmarks/baseline-evidence.zip
```

导出白名单包含manifest、冻结语料、样本、报告、审核；排除private目录、凭据及容器日志，并检测配置中的长密钥。自有语料及回答可能敏感，分享范围由操作者确认。

## 检查与局限

单元测试覆盖SSE截断、畸形done、错ID、error后done、心跳总超时、参数、逐样本恢复、输入身份、资源归属、缓存增量、质量门禁和全失败报告。CI同时跑独立容器smoke，无真实模型费用。

当前不含自动调参、open-loop到达率压测、长期稳定性、自动事实裁判、业务数据集或MinIO/OCR质量评测。历史临时脚本留在本地output；新run不导入历史通过结论。历史基线见[验证记录](../docs/14-verification.md#bench-rag-001性能与回答质量基线2026-11-21)。
