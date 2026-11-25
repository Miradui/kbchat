# Kubernetes 官方中文文档评测集

200 篇真实官方文档、200 道中文问题，共享一个知识库。来源固定为
[kubernetes/website@1ad3951](https://github.com/kubernetes/website/tree/1ad3951a91f073a5ac0037ede662bebdc054774b)，
提交时间 2026-11-25；这是项目当时 main 的文档快照，站点配置标记 v1.37，包含发展中特性，不能当作所有已发布版本的通用行为。

原文由 Kubernetes 文档贡献者维护，按 **CC BY 4.0** 分发，完整许可见 LICENSE.txt。
每篇来源 URL、提交、原始及清洗后 SHA-256、字节数、所引用示例与配置依赖均嵌在 dataset.json，随 benchmark 冻结。
本项目仅作文字抽取、Hugo 模板展开及问题标注；这些修改不代表上游认可本评测。

清洗删除 front matter 和英文 HTML 注释，保留标题、中文段落、表格及代码；展开同提交的示例、include、词汇定义与版本变量。
注释/警告和第三方归属责任声明保留内容；特性状态读取同提交英文feature-gate阶段数据，保留版本、默认值及锁定/移除状态。
图片保留文字说明但不做视觉识别，网页目录/交互控件明确标为省略。
遇到未支持模板或缺失依赖的页面不进入候选，不静默猜测其内容。200篇来自162篇 concepts 与38篇 tasks，未人为重复文档扩充数量。

题集含160道有依据题和40道缺资料题；29题需两份以上文档。
150道dev用于开发评估，50道test保留网络与存储主题，正例依据文档不跨两组。
这是**主题保留集**，不是随机同分布划分；两组难度与主题不同，分数不直接作同条件优劣比较。
100篇文档有直接gold依据，其余100篇提供真实相似主题干扰；两阶段均检索完整200篇。
问题家族由familyId记录，不跨split；仍可能存在不同来源对共同概念的介绍，不能声称语义完全无重叠。

问题和参考事实由AI读取固定资料后起草，并经过独立来源核对；不是人工专家标注集。
缺资料题主要考察现场配置、未给出的参数及未承诺的性能保证；每题negativeCheck保留起草时的全库检查记录，部分记录的hash/匹配数对应清洗修正前版本。
最终清洗版本另行重扫，证据为本地 `output/evals-scale-20261125/final-negative-scan.json`，与最终数据身份绑定；不把旧注记当成最终hash。
它们衡量“信息不足时不编造”，不代表任意复杂不可回答问题或对抗注入覆盖。
官方文档可能出现在模型预训练中，因此必须同时衡量检索、实际引用和依据支持，不能把答案似乎正确当成检索成功。

运行（仓库根目录）使用现有 `init --dataset benchmarks/datasets/kubernetes-zh-200`；
大语料导入可指定 `seed --timeout 3600`，执行题目用 `run --suite retrieval|quality --split dev|test`。
每个split使用独立run，题目计划首次运行后冻结。保留集只在候选规则固定后运行；读过其结果再调参时，应创建新的保留版本。
不接入质量CI门禁。

离线重建清洗语料：准备固定提交的干净上游checkout，包含content/zh-cn/docs、content/zh-cn/includes、
content/zh-cn/examples、content/en/examples、content/en/docs/reference/command-line-tools-reference/feature-gates、
i18n/zh-cn/zh-cn.toml、hugo.toml和LICENSE；随后执行：

```bash
python3 -m benchmarks.build_kubernetes --source <上游checkout> --output <新目录> --selection benchmarks/datasets/kubernetes-zh-200/selection.json
```

`cases.json` 是独立策划的问题清单，不由构建器按段落自动生成；不得把生成的问题和答案加入被检索文档。
验证使用 `python3 -m unittest discover -s benchmarks/tests -v`。本数据集是否已完成真实模型运行及实际切片数，以相应run报告为准。

2026-11-25–26真实模型基线已完成：全部200篇生成2,374切片，200题按冻结split运行；结果与适用范围见 [EVALS-SCALE-003](../../../docs/14-verification.md#evals-scale-003官方200文档与200题基线2026-11-2526)。
