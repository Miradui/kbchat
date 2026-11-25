# 加固指南 - 调度器配置

Kubernetes 调度器是控制平面的关键组件之一。

本文介绍如何提升调度器的安全态势。

一个配置不当的调度器可能带来安全隐患。
这样的调度器可以将目标设为特定节点，并驱逐正在共享节点及其资源的工作负载或应用。
攻击者可以借此实施
[Yo-Yo 攻击](https://arxiv.org/abs/2105.00542)：即针对易受攻击的自动扩缩器发起攻击。

## kube-scheduler 配置   {#kube-scheduler-configuration}

### 调度器身份认证与鉴权命令行选项   {#scheduler-authentication-authorization-command-line-options}

在设置身份认证配置时，应确保 kube-scheduler 的身份认证配置与 kube-apiserver
的身份认证配置保持一致。如果任一请求缺少身份认证头，
则应[通过 kube-apiserver 进行身份认证以保证集群内的所有身份认证一致](/zh-cn/docs/tasks/extend-kubernetes/configure-aggregation-layer/#original-request-username-and-group)。

- `authentication-kubeconfig`：确保提供正确的 kubeconfig 文件，使调度器能从 API
  服务器获取身份认证配置选项。这个 kubeconfig 文件应设置严格的文件权限以确保安全。
- `authentication-tolerate-lookup-failure`：设置为 `false`，确保调度器**始终**从
  API 服务器查找其身份认证配置。
- `authentication-skip-lookup`：设置为 `false`，确保调度器**始终**从 API 服务器查找其身份认证配置。
- `authorization-always-allow-paths`：这些路径应返回适用于匿名鉴权的数据。
  默认值为 `/healthz,/readyz,/livez`。

- `profiling`：设置为 `false` 以禁用性能分析端点。性能分析端点可用于调试，
  但在生产环境中启用会带来拒绝服务（DoS）或信息泄露风险。`--profiling` 参数已被弃用，现在可通过
  [KubeScheduler DebuggingConfiguration](/zh-cn/docs/reference/config-api/kube-scheduler-config.v1/#DebuggingConfiguration)
  提供。在 kube-scheduler 配置中，将 `enableProfiling` 设置为 `false` 即可禁用性能分析。
- `requestheader-client-ca-file`：避免使用此参数。

### 调度器网络命令行选项   {#scheduler-networking-command-line-options}

- `bind-address`：在大多数情况下，kube-scheduler 不需要被外部访问。
  将绑定地址设置为 `localhost` 是一种安全的做法。
- `permit-address-sharing`：设置为 `false` 以禁用通过 `SO_REUSEADDR` 的连接共享。
  `SO_REUSEADDR` 可能导致重复使用处于 `TIME_WAIT` 状态的已终止的连接。
- `permit-port-sharing`：默认为 `false`。除非你非常了解相关的安全影响，否则建议使用默认值。

### 调度器 TLS 命令行选项    {#scheduler-tls-command-line-options}

- `tls-cipher-suites`：始终提供一组首选的加密套件。这能确保加密时绝不会使用不安全的加密套件。

## 自定义调度器的调度配置   {#scheduling-configurations-for-custom-schedulers}

在基于 Kubernetes 调度代码使用自定义调度器时，
集群管理员需谨慎使用 `queueSort`、`prefilter`、`filter` 和 `permit`
[扩展点](/zh-cn/docs/reference/scheduling/config/#extension-points)。
这些扩展点控制调度过程的不同阶段，配置错误可能会影响 kube-scheduler 在集群中的行为。

### 关键注意事项   {#key-considerations}

- 同一时间只能启用一个使用 `queueSort` 扩展点的插件。任何使用 `queueSort` 的插件都应经过严格审查。
- 实现 `prefilter` 或 `filter` 扩展点的插件可能会将所有节点标记为不可调度。这可能导致新 Pod 无法被调度。
- 实现 `permit` 扩展点的插件可能会阻止或延迟 Pod 的绑定。此类插件应由集群管理员彻底审查。

如果你使用的是非[默认插件](/zh-cn/docs/reference/scheduling/config/#scheduling-plugins)，
考虑按以下方式禁用 `queueSort`、`filter` 和 `permit` 扩展点：

```yaml
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
  - schedulerName: my-scheduler
    plugins:
      # 禁用不同扩展点的特定插件
      # 你可以使用 "*" 禁用某个扩展点下的所有插件
      queueSort:
        disabled:
        - name: "*"             # 禁用所有 queueSort 插件
      # - name: "PrioritySort"  # 禁用特定 queueSort 插件
      filter:
        disabled:
        - name: "*"                 # 禁用所有 filter 插件
      # - name: "NodeResourcesFit"  # 禁用特定 filter 插件
      permit:
        disabled:
        - name: "*"               # 禁用所有 permit 插件
      # - name: "TaintToleration" # 禁用特定 permit 插件
```

这会创建一个调度器配置文件 `my-scheduler`。每当 Pod 的 `.spec` 中未设置 `.spec.schedulerName` 时，
kube-scheduler 会使用主要配置和默认插件运行该 Pod。如果你定义的 Pod 将 `.spec.schedulerName` 设置为
`my-scheduler`，kube-scheduler 会运行但使用自定义配置；在该自定义配置中，
`queueSort`、`filter` 和 `permit` 这几个扩展点被禁用。
如果你使用这个 KubeSchedulerConfiguration，但未运行任何自定义调度器，
然后你定义一个 Pod，其 `.spec.schedulerName` 设置为 `nonexistent-scheduler`
（或任何其他在你的集群中不存在的调度器名称），那么 Pod 将不会生成任何事件。

## 不允许为节点添加标签   {#disallow-labeling-nodes}

集群管理员应确保集群用户无法为节点添加标签。
恶意行为者可能会使用 `nodeSelector` 将工作负载调度到那些本不应运行这些工作负载的节点上。
