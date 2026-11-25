# 节点

Kubernetes 通过将容器放入在节点（Node）
上运行的 Pod 中来执行你的工作负载。
节点可以是一个虚拟机或者物理机器，取决于所在的集群配置。
每个节点包含运行 Pod 所需的服务；
这些节点由控制面负责管理。

通常集群中会有若干个节点；而在一个学习所用或者资源受限的环境中，你的集群中也可能只有一个节点。

节点上的[组件](/zh-cn/docs/concepts/architecture/#node-components)包括
kubelet、
容器运行时以及
kube-proxy。

  

## 管理  {#management}

向 API 服务器添加节点的方式主要有两种：

1. 节点上的 kubelet 向控制面执行自注册；
2. 你（或者别的什么人）手动添加一个 Node 对象。

在你创建了 Node 对象或者节点上的
kubelet 执行了自注册操作之后，控制面会检查新的 Node 对象是否合法。
例如，如果你尝试使用下面的 JSON 对象来创建 Node 对象：

```json
{
  "kind": "Node",
  "apiVersion": "v1",
  "metadata": {
    "name": "10.240.79.157",
    "labels": {
      "name": "my-first-k8s-node"
    }
  }
}
```

Kubernetes 会在内部创建一个 Node 对象作为节点的表示。Kubernetes 检查 kubelet
向 API 服务器注册节点时使用的 `metadata.name` 字段是否匹配。
如果节点是健康的（即所有必要的服务都在运行中），则该节点可以用来运行 Pod。
否则，直到该节点变为健康之前，所有的集群活动都会忽略该节点。

**说明：**

Kubernetes 会一直保存着非法节点对应的对象，并持续检查该节点是否已经变得健康。

你，或者某个控制器必须显式地删除该
Node 对象以停止健康检查操作。

Node 对象的名称必须是合法的
[DNS 子域名](/zh-cn/docs/concepts/overview/working-with-objects/names#dns-subdomain-names)。

### 节点名称唯一性     {#node-name-uniqueness}

节点的[名称](/zh-cn/docs/concepts/overview/working-with-objects/names#names)用来标识 Node 对象。
没有两个 Node 可以同时使用相同的名称。 Kubernetes 还假定名字相同的资源是同一个对象。
就 Node 而言，隐式假定使用相同名称的实例会具有相同的状态（例如网络配置、根磁盘内容）
和类似节点标签这类属性。这可能在节点被更改但其名称未变时导致系统状态不一致。
如果某个 Node 需要被替换或者大量变更，需要从 API 服务器移除现有的 Node 对象，
之后再在更新之后重新将其加入。

### 节点自注册    {#self-registration-of-nodes}

当 kubelet 标志 `--register-node` 为 true（默认）时，它会尝试向 API 服务注册自己。
这是首选模式，被绝大多数发行版选用。

对于自注册模式，kubelet 使用下列参数启动：

- `--kubeconfig` - 用于向 API 服务器执行身份认证所用的凭据的路径。
- `--cloud-provider` - 与某云驱动
  进行通信以读取与自身相关的元数据的方式。
- `--register-node` - 自动向 API 服务器注册。
- `--register-with-taints` - 使用所给的污点列表
  （逗号分隔的 `<key>=<value>:<effect>`）注册节点。当 `register-node` 为 false 时无效。

- `--node-ip` - 可选的以英文逗号隔开的节点 IP 地址列表。你只能为每个地址簇指定一个地址。
  例如在单协议栈 IPv4 集群中，需要将此值设置为 kubelet 应使用的节点 IPv4 地址。
  参阅[配置 IPv4/IPv6 双协议栈](/zh-cn/docs/concepts/services-networking/dual-stack/#configure-ipv4-ipv6-dual-stack)了解运行双协议栈集群的详情。

  如果你未提供这个参数，kubelet 将使用节点默认的 IPv4 地址（如果有）；
  如果节点没有 IPv4 地址，则 kubelet 使用节点的默认 IPv6 地址。

- `--node-labels` - 在集群中注册节点时要添加的标签。
  （参见 [NodeRestriction 准入控制插件](/zh-cn/docs/reference/access-authn-authz/admission-controllers/#noderestriction)所实施的标签限制）。
- `--node-status-update-frequency` - 指定 kubelet 向 API 服务器发送其节点状态的频率。

当 [Node 鉴权模式](/zh-cn/docs/reference/access-authn-authz/node/)和
[NodeRestriction 准入插件](/zh-cn/docs/reference/access-authn-authz/admission-controllers/#noderestriction)被启用后，
仅授权 kubelet 创建/修改自己的 Node 资源。

**说明：**

正如[节点名称唯一性](#node-name-uniqueness)一节所述，当 Node 的配置需要被更新时，
一种好的做法是重新向 API 服务器注册该节点。例如，如果 kubelet 重启时其 `--node-labels`
是新的值集，但同一个 Node 名称已经被使用，则所作变更不会起作用，
因为节点标签是在 Node 注册到 API 服务器时完成（或修改）的。

如果在 kubelet 重启期间 Node 配置发生了变化，已经被调度到某 Node 上的 Pod
可能会出现行为不正常或者出现其他问题，例如，已经运行的 Pod
可能通过污点机制设置了与 Node 上新设置的标签相排斥的规则，也有一些其他 Pod，
本来与此 Pod 之间存在不兼容的问题，也会因为新的标签设置而被调到同一节点。
节点重新注册操作可以确保节点上所有 Pod 都被排空并被正确地重新调度。

### 手动节点管理 {#manual-node-administration}

你可以使用 kubectl
来创建和修改 Node 对象。

如果你希望手动创建节点对象时，请设置 kubelet 标志 `--register-node=false`。

你可以修改 Node 对象（忽略 `--register-node` 设置）。
例如，你可以修改节点上的标签或并标记其为不可调度。

你可以通过在节点上添加一个或多个 `node-role.kubernetes.io/<role>: <role>` 标签，
来为节点设置可选的节点角色。其中，`<role>`
的字符受[标签键名格式](/zh-cn/docs/concepts/overview/working-with-objects/labels/#syntax-and-character-set)规则限制。

Kubernetes 会忽略节点角色标签的值；按照惯例，你可以将其设置为与标签键中的
`<role>` 相同的字符串。

你可以结合使用 Node 上的标签和 Pod 上的选择算符来控制调度。
例如，你可以限制某 Pod 只能在符合要求的节点子集上运行。

如果标记节点为不可调度（unschedulable），将阻止新 Pod 调度到该 Node 之上，
但不会影响任何已经在其上的 Pod。
这是重启节点或者执行其他维护操作之前的一个有用的准备步骤。

要标记一个 Node 为不可调度，执行以下命令：

```shell
kubectl cordon $NODENAME
```

更多细节参考[安全地腾空节点](/zh-cn/docs/tasks/administer-cluster/safely-drain-node/)。

**说明：**

被 DaemonSet
控制器创建的 Pod 能够容忍节点的不可调度属性。
DaemonSet 通常提供节点本地的服务，即使节点上的负载应用已经被腾空，
这些服务也仍需运行在节点之上。

## 节点状态   {#node-status}

一个节点的状态包含以下信息:

* [地址（Addresses）](/zh-cn/docs/reference/node/node-status/#addresses)
* [状况（Condition）](/zh-cn/docs/reference/node/node-status/#condition)
* [容量与可分配（Capacity）](/zh-cn/docs/reference/node/node-status/#capacity)
* [信息（Info）](/zh-cn/docs/reference/node/node-status/#info)

你可以使用 `kubectl` 来查看节点状态和其他细节信息：

```shell
kubectl describe node <节点名称>
```

更多细节参见 [Node 状态](/zh-cn/docs/reference/node/node-status)。

## 节点心跳  {#node-heartbeats}

Kubernetes 节点发送的心跳帮助你的集群确定每个节点的可用性，并在检测到故障时采取行动。

对于节点，有两种形式的心跳：

* 更新节点的 [`.status`](/zh-cn/docs/reference/node/node-status/)
* `kube-node-lease` 名字空间中的
  [Lease（租约）](/zh-cn/docs/concepts/architecture/leases/)对象。
  每个节点都有一个关联的 Lease 对象。

## 节点控制器  {#node-controller}

节点控制器是 Kubernetes 控制面组件，
管理节点的方方面面。

节点控制器在节点的生命周期中扮演多个角色。
第一个是当节点注册时为它分配一个 CIDR 区段（如果启用了 CIDR 分配）。

第二个是保持节点控制器内的节点列表与云服务商所提供的可用机器列表同步。
如果在云环境下运行，只要某节点不健康，节点控制器就会询问云服务是否节点的虚拟机仍可用。
如果不可用，节点控制器会将该节点从它的节点列表删除。

第三个是监控节点的健康状况。节点控制器负责：

- 在节点不可达的情况下，在 Node 的 `.status` 中更新 `Ready` 状况。
  在这种情况下，节点控制器将 NodeReady 状况更新为 `Unknown`。
- 如果节点仍然无法访问：对于不可达节点上的所有 Pod 触发
  [API 发起的逐出](/zh-cn/docs/concepts/scheduling-eviction/api-eviction/)操作。
  默认情况下，节点控制器在将节点标记为 `Unknown` 后等待 5 分钟提交第一个驱逐请求。

默认情况下，节点控制器每 5 秒检查一次节点状态，可以使用 `kube-controller-manager`
组件上的 `--node-monitor-period` 参数来配置周期。

### 逐出速率限制  {#rate-limits-on-eviction}

大部分情况下，节点控制器把逐出速率限制在每秒 `--node-eviction-rate` 个（默认为 0.1）。
这表示它每 10 秒钟内至多从一个节点驱逐 Pod。

当一个可用区域（Availability Zone）中的节点变为不健康时，节点的驱逐行为将发生改变。
节点控制器会同时检查可用区域中不健康（`Ready` 状况为 `Unknown` 或 `False`）
的节点的百分比：

- 如果不健康节点的比例超过 `--unhealthy-zone-threshold`（默认为 0.55），
  驱逐速率将会降低。
- 如果集群较小（意即小于等于 `--large-cluster-size-threshold` 个节点 - 默认为 50），
  驱逐操作将会停止。
- 否则驱逐速率将降为每秒 `--secondary-node-eviction-rate` 个（默认为 0.01）。

在逐个可用区域中实施这些策略的原因是，
当一个可用区域可能从控制面脱离时其它可用区域可能仍然保持连接。
如果你的集群没有跨越云服务商的多个可用区域，那（整个集群）就只有一个可用区域。

跨多个可用区域部署你的节点的一个关键原因是当某个可用区域整体出现故障时，
工作负载可以转移到健康的可用区域。
因此，如果一个可用区域中的所有节点都不健康时，节点控制器会以正常的速率
`--node-eviction-rate` 进行驱逐操作。
在所有的可用区域都不健康（也即集群中没有健康节点）的极端情况下，
节点控制器将假设控制面与节点间的连接出了某些问题，它将停止所有驱逐动作
（如果故障后部分节点重新连接，节点控制器会从剩下不健康或者不可达节点中驱逐 Pod）。

节点控制器还负责驱逐运行在拥有 `NoExecute` 污点的节点上的 Pod，
除非这些 Pod 能够容忍此污点。
节点控制器还负责根据节点故障（例如节点不可访问或没有就绪）
为其添加污点。
这意味着调度器不会将 Pod 调度到不健康的节点上。

## 资源容量跟踪   {#node-capacity}

Node 对象会跟踪节点上资源的容量（例如可用内存和 CPU 数量）。
通过[自注册](#self-registration-of-nodes)机制生成的 Node 对象会在注册期间报告自身容量。
如果你[手动](#manual-node-administration)添加了 Node，
你就需要在添加节点时手动设置节点容量。

Kubernetes 调度器
保证节点上有足够的资源供其上的所有 Pod 使用。
它会检查节点上所有容器的请求的总和不会超过节点的容量。
总的请求包括由 kubelet 启动的所有容器，但不包括由容器运行时直接启动的容器，
也不包括不受 kubelet 控制的其他进程。

**说明：**

如果要为非 Pod 进程显式保留资源。
请参考[为系统守护进程预留资源](/zh-cn/docs/tasks/administer-cluster/reserve-compute-resources/#system-reserved)。

## 节点拓扑  {#node-topology}

功能状态：TopologyManager，Kubernetes 1.27，stable；首次引入于 1.16。特性门控已移除。该特性已稳定，不能再通过此门控禁用。

如果启用了 `TopologyManager` [特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/)，
kubelet 可以在作出资源分配决策时使用拓扑提示。
参考[控制节点上拓扑管理策略](/zh-cn/docs/tasks/administer-cluster/topology-manager/)了解详细信息。

## ## 接下来

进一步了解以下资料：

* 构成节点的[组件](/zh-cn/docs/concepts/architecture/#node-components) 。
* [Node 的 API 定义](/docs/reference/generated/kubernetes-api/v1.37/#node-v1-core)。
* 架构设计文档中有关
  [Node](https://git.k8s.io/design-proposals-archive/architecture/architecture.md#the-kubernetes-node)
  的章节。
* [节点自动扩缩](/zh-cn/docs/concepts/cluster-administration/node-autoscaling/)
  以管理集群中节点的数量和规模。
* [污点和容忍度](/zh-cn/docs/concepts/scheduling-eviction/taint-and-toleration/)。
* [节点资源管理器](/zh-cn/docs/concepts/policy/node-resource-managers/)。
* [Windows 节点的资源管理](/zh-cn/docs/concepts/configuration/windows-resource-management/)。
