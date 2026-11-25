# Kubernetes 系统组件指标

通过系统组件指标可以更好地了解系统组个内部发生的情况。系统组件指标对于构建仪表板和告警特别有用。

Kubernetes 组件以
[Prometheus 格式](https://prometheus.io/docs/instrumenting/exposition_formats/)生成度量值。
这种格式是结构化的纯文本，旨在使人和机器都可以阅读。

## Kubernetes 中组件的指标  {#metrics-in-kubernetes}

在大多数情况下，可以通过 HTTP 服务器的 `/metrics` 端点来获取组件的度量值。
对于那些默认情况下不暴露端点的组件，可以使用 `--bind-address` 参数来启用。

这些组件的示例：

* kube-controller-manager
* kube-proxy
* kube-apiserver
* kube-scheduler
* kubelet

在生产环境中，你可能需要配置
[Prometheus 服务器](https://prometheus.io/)或某些其他指标搜集器以定期收集这些指标，
并使它们在某种时间序列数据库中可用。

请注意，kubelet 还会在 `/metrics/cadvisor`、
`/metrics/resource` 和 `/metrics/probes` 端点中公开度量值。这些度量值的生命周期各不相同。

如果你的集群使用了 RBAC，
则读取指标需要通过基于用户、组或 ServiceAccount 的鉴权，要求具有允许访问
`/metrics` 的 ClusterRole。例如：

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: prometheus
rules:
  - nonResourceURLs:
      - "/metrics"
    verbs:
      - get
```

## 指标生命周期  {#metric-lifecycle}

Alpha 指标 → Beta 指标 → 稳定的指标 → 弃用的指标 → 隐藏的指标 → 删除的指标

Alpha 指标没有稳定性保证。这些指标可以随时被修改或者删除。

Beta 指标相比其稳定版本，所遵循的 API 协议更宽松。
在指标的 Beta 阶段生命周期内，其现有的标签不能被移除，但可以新增标签。

稳定的指标可以保证不会改变。这意味着：

* 稳定的、不包含已弃用（deprecated）签名的指标不会被删除或重命名
* 稳定的指标的类型不会被更改

已弃用的指标最终将被删除，不过仍然可用。
这类指标包含注解，标明其是在哪个版本被弃用的。

例如：

* 被弃用之前：

  ```
  # HELP some_counter this counts things
  # TYPE some_counter counter
  some_counter 0
  ```

* 被弃用之后：

  ```
  # HELP some_counter (Deprecated since 1.15.0) this counts things
  # TYPE some_counter counter
  some_counter 0
  ```

隐藏的指标不会再被发布以供抓取，但仍然可用。
弃用的指标会根据其稳定性级别在一段时间后成为隐藏的指标。

* **STABLE** 指标在弃用后至少 3 个发行版或 9 个月（以较长者为准）后变为隐藏。
* **BETA** 指标在弃用后至少 1 个发行版或 4 个月（以较长者为准）后变为隐藏。
* **ALPHA** 指标可以在其被弃用的同一发行版内就被隐藏或移除。

要使用某个隐藏的指标，你必须先启用此指标。
更多细节请参阅[显示隐藏指标](#show-hidden-metrics)一节。

删除的指标不再被发布，亦无法使用。

## 显示隐藏指标   {#show-hidden-metrics}

如上所述，管理员可以通过设置可执行文件的命令行参数来启用隐藏指标，
如果管理员错过了上一版本中已经弃用的指标的迁移，则可以把这个用作管理员的逃生门。

`show-hidden-metrics-for-version` 参数接受版本号作为取值，
版本号给出你希望显示该发行版本中已弃用的指标。
版本表示为 `x.y`，其中 `x` 是主要版本，`y` 是次要版本。补丁程序版本不是必须的，
即使指标可能会在补丁程序发行版中弃用，原因是指标弃用策略规定仅针对次要版本。

此参数的取值只能使用前一个次要版本。如果你想显示前一发行版中隐藏的所有指标，你可以将
`show-hidden-metrics-for-version` 参数设置为前一个版本。
不允许使用过旧的版本，因为那样会违反指标弃用策略。

例如，假设指标 `A` 在 `1.29` 中被弃用。指标 `A` 在哪个版本变为隐藏取决于其稳定性级别：

* 如果指标 `A` 是 **ALPHA** 指标，它可能会在 `1.29` 中被隐藏。
* 如果指标 `A` 是 **BETA** 指标，它最早会在 `1.30` 中被隐藏。如果你要升级到 `1.30`
  且仍然需要 `A`，你必须使用命令行参数 `--show-hidden-metrics-for-version=1.29`。
* 如果指标 `A` 是 **STABLE（稳定）**版本，它最早会在 `1.32` 中被隐藏。如果你要升级到 `1.32`
  且仍然需要 `A`，你必须使用命令行参数 `--show-hidden-metrics-for-version=1.31`。

## 组件指标  {#component-metrics}

### kube-controller-manager 指标  {#kube-controller-manager-metrics}

控制器管理器指标可提供有关控制器管理器性能和运行状况的重要洞察。
这些指标包括通用的 Go 语言运行时指标（例如 go_routine 数量）和控制器特定的度量指标，
例如可用于评估集群运行状况的 etcd 请求延迟或云提供商（AWS、GCE、OpenStack）的 API 延迟等。

从 Kubernetes 1.7 版本开始，详细的云提供商指标可用于 GCE、AWS、Vsphere 和 OpenStack 的存储操作。
这些指标可用于监控持久卷操作的运行状况。

比如，对于 GCE，这些指标称为：

```
cloudprovider_gce_api_request_duration_seconds { request = "instance_list"}
cloudprovider_gce_api_request_duration_seconds { request = "disk_insert"}
cloudprovider_gce_api_request_duration_seconds { request = "disk_delete"}
cloudprovider_gce_api_request_duration_seconds { request = "attach_disk"}
cloudprovider_gce_api_request_duration_seconds { request = "detach_disk"}
cloudprovider_gce_api_request_duration_seconds { request = "list_disk"}
```

### kube-scheduler 指标   {#kube-scheduler-metrics}

功能状态：Kubernetes v1.21，beta。

调度器会暴露一些可选的指标，报告所有运行中 Pod 所请求的资源和期望的限制值。
这些指标可用来构造容量规划监控面板、访问当前或历史的调度限制值、
快速发现因为缺少资源而无法被调度的负载，或者将 Pod 的实际资源用量与其请求值进行比较。

kube-scheduler 组件能够辩识各个 Pod
所配置的资源[请求和限制](/zh-cn/docs/concepts/configuration/manage-resources-containers/)。
在 Pod 的资源请求值或者限制值非零时，kube-scheduler 会以度量值时间序列的形式生成报告。
该时间序列值包含以下标签：

- 名字空间
- Pod 名称
- Pod 调度所处节点，或者当 Pod 未被调度时用空字符串表示
- 优先级
- 为 Pod 所指派的调度器
- 资源的名称（例如，`cpu`）
- 资源的单位，如果知道的话（例如，`cores`）

一旦 Pod 进入完成状态（其 `restartPolicy` 为 `Never` 或 `OnFailure`，且其处于
`Succeeded` 或 `Failed` Pod 阶段，或者已经被删除且所有容器都具有终止状态），
该时间序列停止报告，因为调度器现在可以调度其它 Pod 来执行。
这两个指标称作 `kube_pod_resource_request` 和 `kube_pod_resource_limit`。

这些指标通过 HTTP 端点 `/metrics/resources` 公开出来。
访问 `/metrics/resources` 端点需要鉴权，通常通过对
`/metrics/resources` 非资源 URL 的 `get` 访问授予访问权限。  

在 Kubernetes 1.21 中，你必须使用 `--show-hidden-metrics-for-version=1.20`
参数来公开 Alpha 级稳定性的指标。

### kubelet 压力阻塞信息（PSI）指标  {#kubelet-pressure-stall-information-psi-metrics}

功能状态：KubeletPSI，Kubernetes 1.36，stable；首次引入于 1.33。默认启用。门控值已锁定。

当内核已启用 PSI（v4.20 或更高版本）时，kubelet 以基于 CPU、内存和 I/O 的使用情况收集 Linux
内核的[压力阻塞信息（PSI）](https://docs.kernel.org/accounting/psi.html)。
此信息是在节点、Pod 和容器级别进行收集的。

**Prometheus 指标**：通过 `/metrics/cadvisor` 端点以累积计数器（总量）的形式暴露，
表示阻塞总时长（单位为秒）。这些指标在此端点暴露为以下名称：

```
container_pressure_cpu_stalled_seconds_total
container_pressure_cpu_waiting_seconds_total
container_pressure_memory_stalled_seconds_total
container_pressure_memory_waiting_seconds_total
container_pressure_io_stalled_seconds_total
container_pressure_io_waiting_seconds_total
```

**Summary API**：通过 `/stats/summary` 端点以 JSON 格式提供数据，
同时包含累积值（`totals`）和滑动平均值（`avg10`、`avg60`、`avg300`）。
这些平均值表示在对应的 10 秒、60 秒和 5 分钟时间窗口内，任务在某一资源上发生停滞的时间占比（百分比）。

这些指标也可以通过节点上的 `/proc/pressure/` 目录中的相应文件（cpu、memory 和 io）原生导出，格式如下：

```
some avg10=0.00 avg60=0.00 avg300=0.00 total=0
full avg10=0.00 avg60=0.00 avg300=0.00 total=0
```

如何将这些指标结合起来理解？例如，以下命令是来自 Summary API 的查询：

```shell
kubectl get --raw "/api/v1/nodes/$(kubectl get nodes -o jsonpath='{.items[0].metadata.name}')/proxy/stats/summary" | jq '.pods[].containers[] | select(.name=="<CONTAINER_NAME>") | {name, cpu: .cpu.psi, memory: .memory.psi, io: .io.psi}'
```

此查询会以如下 JSON 格式返回信息：

```json
{
  "name": "<CONTAINER_NAME>",
  "cpu": {
    "full": {
      "total": 0,
      "avg10": 0,
      "avg60": 0,
      "avg300": 0
    },
    "some": {
      "total": 35232438,
      "avg10": 0.74,
      "avg60": 0.52,
      "avg300": 0.21,
    },  
  },
  "memory": {
    "full": {
      "total": 539105,
      "avg10": 0,
      "avg60": 0,
      "avg300": 0
    },
    "some": {
      "total": 658164,
      "avg10": 0.01,
      "avg60": 0.01,
      "avg300": 0.00,
    },
    }
  },
  "io": {
    "full": {
      "total": 33190987,
      "avg10": 0.31,
      "avg60": 0.22,
      "avg300": 0.05,
    },
    "some": {
      "total": 40809937,
      "avg10": 0.52,
      "avg60": 0.45,
      "avg300": 0.12,
    }
  }
}
```

这是一个简单的突发场景示例。cpu.some 的 `avg10` 值为 `0.74`，表示在过去 10 秒内，
此容器中至少有一个任务有 0.74% 的时间处于 CPU 等待状态（即 0.0074 秒或 74 毫秒）。
由于同一资源上 `avg10`（0.74）显著高于 `avg300`（0.21），
这表明这是一次近期的资源争用激增，而不是长期持续的瓶颈。
如果持续监控并且 `avg300` 指标也开始上升，就可以判断为一个更严重、持续存在的问题。

此外，请注意在这个示例中，`cpu.some` 显示存在压力，而 `cpu.full` 仍然为 0.00。
这说明虽然有部分进程在等待 CPU 时间而被延迟，但整个容器仍然在继续推进。
如果 `full` 出现非零值，则表示所有非空闲任务在同一时间都发生了阻塞，这是一个更严重的问题。
虽然不如平均值直观，`total` 值（35232438）表示累计的停滞时间（单位为微秒），
它可以帮助检测那些在平均值中不易体现的延迟突发情况。同时，这些数据也非常适合用于像
Prometheus 这样的监控系统，以便在特定时间窗口内计算精确的增长速率。
最后需要注意的是，当观察到较高的 I/O 压力而内存压力较低时，通常意味着应用是在等待磁盘吞吐，
而不是由于可用内存不足导致的问题。此时节点的内存并未过度分配，应进一步从磁盘使用情况入手进行诊断。

PSI 指标为在各个层级（每个 cgroup）实时监控资源争用提供了一种更强大的方式，使得可以在整个系统范围内动态地处理工作负载。
你可以在[了解 PSI 指标](/zh-cn/docs/reference/instrumentation/understand-psi-metrics/)中了解更多信息。

#### 要求

启用压力阻塞信息需满足以下条件：

- [Linux 内核版本为 4.20 或更高](/zh-cn/docs/reference/node/kernel-version-requirements#requirements-psi)
- [CGroup v2](/zh-cn/docs/concepts/architecture/cgroups)

## 禁用指标 {#disabling-metrics}

你可以通过命令行参数 `--disabled-metrics` 来关闭某指标。
在例如某指标会带来性能问题的情况下，这一操作可能是有用的。
参数值是一组被禁用的指标（例如：`--disabled-metrics=metric1,metric2`）。

## 指标顺序性保证    {#metric-cardinality-enforcement}

具有无限维度的指标可能会在其监控的组件中引起内存问题。
为了限制资源使用，你可以使用 `--allow-metric-labels` 命令行选项来为指标动态配置允许的标签值列表。

在 Alpha 阶段，此选项只能接受一组映射值作为可以使用的指标标签。
每个映射值的格式为`<指标名称>,<标签名称>=<可用标签列表>`，其中
`<可用标签列表>` 是一个用逗号分隔的、可接受的标签名的列表。

最终的格式看起来会是这样：

```
--allow-metric-labels <指标名称>,<标签名称>='<可用值1>,<可用值2>...', <指标名称2>,<标签名称>='<可用值1>, <可用值2>...', ...
```

下面是一个例子：

```none
--allow-metric-labels number_count_metric,odd_number='1,3,5', number_count_metric,even_number='2,4,6', date_gauge_metric,weekend='Saturday,Sunday'
```

除了从 CLI 中指定之外，还可以在配置文件中完成此操作。
你可以使用组件的 `--allow-metric-labels-manifest` 命令行参数指定该配置文件的路径。
以下是该配置文件的内容示例：

```yaml
"metric1,label2": "v1,v2,v3"
"metric2,label1": "v1,v2,v3"
```

此外，`cardinality_enforcement_unexpected_categorizations_total`
元指标记录基数执行期间意外分类的计数，
即每当遇到不在允许列表约束中的标签值时进行计数。

## ## 接下来

* 阅读有关指标的
  [Prometheus 文本格式](https://github.com/prometheus/docs/blob/main/docs/instrumenting/exposition_formats.md#text-based-format)
* 参阅
  [Kubernetes 稳定指标](/zh-cn/docs/reference/config-api/instrumentation/metrics/#list-of-stable-kubernetes-metrics)
* 阅读有关
  [Kubernetes 弃用策略](/zh-cn/docs/reference/using-api/deprecation-policy/#deprecating-a-feature-or-behavior)
