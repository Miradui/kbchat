# Kubernetes 对象状态的指标

Kubernetes API 中 Kubernetes 对象的状态可以被公开为指标。
一个名为 [kube-state-metrics](https://github.com/kubernetes/kube-state-metrics)
的插件代理可以连接到 Kubernetes API 服务器并公开一个 HTTP 端点，提供集群中各个对象的状态所生成的指标。
此代理公开了关于对象状态的各种信息，如标签和注解、启动和终止时间、对象当前所处的状态或阶段。
例如，针对运行在 Pod 中的容器会创建一个 `kube_pod_container_info` 指标。
其中包括容器的名称、所属的 Pod 的名称、Pod 所在的命名空间、
容器镜像的名称、镜像的 ID、容器规约中的镜像名称、运行中容器的 ID 和用作标签的 Pod ID。

🛇 本条目指向第三方项目或产品，而该项目（产品）不是 Kubernetes 的一部分。[更多信息](#third-party-content-disclaimer)

有能力（例如通过 Prometheus）抓取 kube-state-metrics 端点的外部组件现在可用于实现以下使用场景。

## 示例：使用来自 kube-state-metrics 的指标查询集群状态   {#example-kube-state-metrics-query-1}

通过 kube-state-metrics 生成的系列指标有助于进一步洞察集群，因为这些指标可用于查询。

如果你使用 Prometheus 或其他采用相同查询语言的工具，则以下 PromQL 查询将返回未就绪的 Pod 数：

```
count(kube_pod_status_ready{condition="false"}) by (namespace, pod)
```

## 示例：基于 kube-state-metrics 发出警报   {#example-kube-state-metrics-alert-1}

kube-state-metrics 生成的指标还允许在集群中出现问题时发出警报。

如果你使用 Prometheus 或类似采用相同警报规则语言的工具，若有某些 Pod 处于 `Terminating` 状态超过 5 分钟，将触发以下警报：

```yaml
groups:
- name: Pod state
  rules:
  - alert: PodsBlockedInTerminatingState
    expr: count(kube_pod_deletion_timestamp) by (namespace, pod) * count(kube_pod_status_reason{reason="NodeLost"} == 0) by (namespace, pod) > 0
    for: 5m
    labels:
      severity: page
    annotations:
      summary: Pod {{$labels.namespace}}/{{$labels.pod}} blocked in Terminating state.
```
