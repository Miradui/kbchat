# 节点资源管理器

Kubernetes 提供了一组资源管理器，用于支持延迟敏感的、高吞吐量的工作负载。
资源管理器的目标是协调和优化节点资源，以支持对 CPU、设备和内存（巨页）等资源有特殊需求的 Pod。

## 硬件拓扑对齐策略   {#hardware-topology-alignment-policies}

**拓扑管理器（Topology Manager）**是一个 kubelet 组件，旨在协调负责这些优化的组件集。
整体资源管理过程通过你指定的策略进行管理。
要了解更多信息，请阅读[控制节点上的拓扑管理策略](/zh-cn/docs/tasks/administer-cluster/topology-manager/)。

## 为 Pod 分配 CPU 的策略   {#policies-for-assigning-cpus-to-pods}

功能状态：CPUManager，Kubernetes 1.26，stable；首次引入于 1.8。特性门控已移除。该特性已稳定，不能再通过此门控禁用。

一旦 Pod 绑定到节点，该节点上的 kubelet 可能需要多路复用现有硬件（例如，在多个 Pod 之间共享 CPU），
或者通过专门划分一些资源来分配硬件（例如，为 Pod 独占使用分配一个或多个 CPU）。

默认情况下，kubelet 使用 [CFS 配额](https://en.wikipedia.org/wiki/Completely_Fair_Scheduler)
来强制执行 Pod 的 CPU 限制。当节点运行许多 CPU 密集型 Pod 时，工作负载可能会移动到不同的 CPU 核，
具体取决于 Pod 执行是否受到抑制以及调度时刻哪些 CPU 核可用。
许多工作负载对这种迁移不敏感，因此无需任何干预即可正常工作。

但是，对于某些工作负载而言，CPU 缓存亲和性和调度延迟会显著影响其性能；针对这些工作负载，
kubelet 允许使用不同的 CPU 管理策略来确定节点上的一些放置偏好。
这是使用 **CPU 管理器（CPU Manager）** 及其策略实现的。
有两种可用的策略：

- `none`：`none` 策略显式启用现有的默认 CPU 亲和性方案，除了操作系统调度器自动执行的操作外，不提供任何亲和性。
  使用 CFS 配额强制为 [Guaranteed Pod](/zh-cn/docs/concepts/workloads/pods/pod-qos/) 
  和 [Burstable Pod](/zh-cn/docs/concepts/workloads/pods/pod-qos/) 实施 CPU 使用限制。

- `static`：`static` 策略允许具有整数 CPU `requests` 的 `Guaranteed` Pod 中的容器访问节点上的独占 CPU。
  这种独占性是使用 [cpuset cgroup 控制器](https://www.kernel.org/doc/Documentation/cgroup-v2.txt)
  来强制保证的。

**说明：**

诸如容器运行时和 kubelet 本身之类的系统服务可以继续在这些独占 CPU 上运行。
独占性仅针对其他 Pod。

CPU 管理器不支持在运行时热插拔 CPU。

### 静态策略  {#static-policy}

静态策略可实现更精细的 CPU 管理和独占性的 CPU 分配。
此策略管理一个共享 CPU 池，该池最初包含节点中的所有 CPU。
可独占分配的 CPU 数量等于节点中的 CPU 总数减去 kubelet 配置所设置的所有预留 CPU。
kubelet 选项所预留的 CPU 以整数数量按物理核心 ID 的升序从初始共享池中取用。
此共享池是供 `BestEffort` 和 `Burstable` Pod 中的所有容器运行使用的 CPU 集。
CPU `requests` 为小数值的 `Guaranteed` Pod 中的容器也在共享池中的 CPU 上运行。
只有属于 `Guaranteed` Pod 且具有整数 CPU `requests` 的容器才会被分配独占 CPU。

**说明：**

当启用静态策略时，kubelet 要求 CPU 预留个数大于零。
这是因为预留 CPU 个数为零意味着将允许共享池变空。

当容器满足静态分配要求的 `Guaranteed` Pod 被调度到节点时，kubelet 会从共享池中删除 CPU 并将其放入容器的 cpuset 中。
kubelet 不使用 CFS 配额来限制这些容器的 CPU 使用率，因为它们的使用率受调度域本身限制。
换句话说，容器 cpuset 中的 CPU 数量等于 Pod 规约中指定的整数 CPU `limit`。
这种静态分配会提高 CPU 亲和性，并减少因 CPU 密集型工作负载下因为限流而导致的上下文切换。

考虑以下 Pod 规约中的容器：

```yaml
spec:
  containers:
  - name: nginx
    image: nginx
```

上面的 Pod 以 `BestEffort` QoS 类运行，因为它没有指定资源 `requests` 或 `limits`。
它在共享池中运行。

```yaml
spec:
  containers:
  - name: nginx
    image: nginx
    resources:
      limits:
        memory: "200Mi"
      requests:
        memory: "100Mi"
```

上面的 Pod 以 `Burstable` QoS 类运行，因为 `requests` 资源不等于 `limits` 且 `cpu` 数量未被指定。
它在共享池中运行。

```yaml
spec:
  containers:
  - name: nginx
    image: nginx
    resources:
      limits:
        memory: "200Mi"
        cpu: "2"
      requests:
        memory: "100Mi"
        cpu: "1"
```

上面的 Pod 以 `Burstable` QoS 类运行，因为 `requests` 资源不等于 `limits`。
它在共享池中运行。

```yaml
spec:
  containers:
  - name: nginx
    image: nginx
    resources:
      limits:
        memory: "200Mi"
        cpu: "2"
      requests:
        memory: "200Mi"
        cpu: "2"
```

上面的 Pod 以 `Guaranteed` QoS 类运行，因为其 `requests` 等于 `limits`。
并且 CPU 资源的容器资源限制是大于或等于 1 的整数。
nginx 容器被授予 2 个独占 CPU。

```yaml
spec:
  containers:
  - name: nginx
    image: nginx
    resources:
      limits:
        memory: "200Mi"
        cpu: "1.5"
      requests:
        memory: "200Mi"
        cpu: "1.5"
```

上面的 Pod 以 `Guaranteed` QoS 类运行，因为 `requests` 等于 `limits`。
但是 CPU 资源的容器资源限制是一个小数。
它在共享池中运行。

```yaml
spec:
  containers:
  - name: nginx
    image: nginx
    resources:
      limits:
        memory: "200Mi"
        cpu: "2"
```

上面的 Pod 以 `Guaranteed` QoS 类运行，因为仅指定了 `limits`，
并且在未显式指定时 `requests` 会被设置为等于 `limits`。
并且 CPU 资源的容器资源限制是大于或等于 1 的整数。
nginx 容器被授予 2 个独占 CPU。

#### 静态策略选项  {#cpu-policy-static--options}

以下是静态 CPU 管理策略可用的策略选项，以字母顺序列出：

`align-by-socket`（Alpha，默认隐藏）：
: 以物理芯片/插槽为边界（而不是逻辑 NUMA 边界）对齐 CPU（自 Kubernetes v1.25 起可用）

`distribute-cpus-across-cores`（Beta，默认可见）：
: 跨多个不同的物理核心分配虚拟核心（有时称为硬件线程）（自 Kubernetes v1.31 起可用）

`distribute-cpus-across-numa`（Alpha，默认隐藏）：
: 跨多个不同的 NUMA 域分配 CPU，力求在所选域之间实现均匀平衡（自 Kubernetes v1.23 起可用）

`full-pcpus-only`（GA，默认可见）
: 始终分配完整的物理核心（自 Kubernetes v1.22 起可用，自 Kubernetes v1.33 起进阶到 GA）

`strict-cpu-reservation`（GA，默认可见）
: 阻止所有 Pod（无论其服务质量类别如何）在预留的 CPU 上运行（自 Kubernetes v1.32 起可用）

`prefer-align-cpus-by-uncorecache`（Beta，默认可见）
: 尽可能通过非核心（最后一级）高速缓存边界对齐 CPU（自 Kubernetes v1.32 起可用，自 Kubernetes v1.35 起进阶到 GA）

你可以使用以下特性门控根据选项组的成熟度级别来启用或禁止它们：

* `CPUManagerPolicyBetaOptions`（默认启用）。禁用以隐藏 Beta 级选项。
* `CPUManagerPolicyAlphaOptions`（默认禁用）。启用以显示 Alpha 级选项。

你仍然必须使用 kubelet 配置文件中的 cpuManagerPolicyOptions 字段启用每个选项。

有关可以配置的各个选项的更多详细信息，请继续阅读。

##### `full-pcpus-only`

如果指定了 full-pcpus-only 策略选项，则 static 策略将始终分配完整的物理核心。
默认情况下，如果没有此选项，static 策略将使用拓扑感知的最佳匹配策略来分配 CPU。
在启用 SMT 的系统上，该策略可以分配与硬件线程对应的一个个虚拟核心。
这样做会导致不同的容器共享相同的物理核；这种行为反过来会导致吵闹的邻居问题。
启用该选项后，仅当可以通过分配完整的物理核心来满足某 Pod 中所有容器的 CPU 请求时，kubelet 才会接受该 Pod。
如果 Pod 未通过准入，则系统会将其置于 Failed 状态，并显示消息 SMTAlignmentError。

##### `distribute-cpus-across-numa`

如果指定了 `distribute-cpus-across-numa` 策略选项，则在需要多个 NUMA 节点来满足分配的情况下，
static 策略将跨多个 NUMA 节点均匀分配 CPU。
默认情况下，CPUManager 会将 CPU 打包到一个 NUMA 节点上，直到它被填满，剩余的所有 CPU 会溢出到下一个 NUMA 节点。
这可能会导致依赖于障碍（和类似的同步原语）的并行代码出现不希望的瓶颈，
因为这种类型的代码往往只会以其最慢的工作程序的速度运行（这一工作程序因为至少一个 NUMA 节点上的可用 CPU 较少而被减速）。
通过在跨多个 NUMA 节点均匀分配 CPU，应用程序开发人员可以更轻松地确保没有单个工作程序比所有其他工作程序受
NUMA 影响更严重，从而提高这些类型的应用的整体性能。

##### `align-by-socket`

如果指定了 align-by-socket 策略选项，则在决定如何将 CPU 分配给容器时，CPU 将被视为以插槽为边界对齐。
默认情况下，CPUManager 会在 NUMA 边界处对齐 CPU 分配，如果需要从多个 NUMA 节点提取 CPU 才能满足分配，则可能会导致性能下降。
虽然它试图确保所有 CPU 都从_最少_数量的 NUMA 节点中分配，但无法保证这些 NUMA 节点会在同一插槽上。
通过指示 CPUManager 以插槽为边界而不是以 NUMA 节点为边界显式对齐 CPU，我们可以避免此类问题。
请注意，此策略选项与 TopologyManager 的 `single-numa-node` 策略不兼容，
并且不适用于插槽数量大于 NUMA 节点数量的硬件。

##### `distribute-cpus-across-cores`

如果指定了 `distribute-cpus-across-cores` 策略选项，则 static
策略将尝试跨多个不同的物理核来分配虚拟核（硬件线程）。
默认情况下，CPUManager 倾向于将 CPU 打包到尽可能少的物理核上，这可能会导致同一物理核上的 CPU
之间发生争用，并导致性能瓶颈。
通过启用 `distribute-cpus-across-cores` 策略，static 策略可确保 CPU 分布在尽可能多的物理核上，
从而减少同一物理核上的争用，从而提高整体性能。
但是，重要的是要注意，当系统负载过重时，此策略的效果可能会降低。
在这种情况下，减少争用的好处会减少。
相反，默认行为可以帮助减少处理器核之间的通信开销，从而可能在高负载条件下提供更好的性能。

##### `strict-cpu-reservation`

KubeletConfiguration 中的 `reservedSystemCPUs` 参数
或已弃用的 kubelet 命令行选项 `--reserved-cpus` 定义显式的 CPU 集合，
用来运行操作系统系统守护进程和 Kubernetes 系统守护进程。
有关此参数的更多详细信息，
请参见[显式预留 CPU 列表](/zh-cn/docs/tasks/administer-cluster/reserve-compute-resources/#explicitly-reserved-cpu-list)页面。
默认情况下，此隔离仅针对 CPU 请求数量为整数的 Guaranteed 类的 Pod 实现，
而不适用于 Burstable 和 BestEffort 类的 Pod
（以及具有小数 CPU 请求的保证型 Pod）。准入仅将 CPU 请求与可分配的 CPU 进行比较。
由于 CPU 限制数量高于请求数量，因此默认行为允许 Burstable 和 BestEffort 类的 Pod 占用
`reservedSystemCPUs` 所预留的容量，并在实际部署中导致主机 OS 服务资源不足。
如果启用了 `strict-cpu-reservation` 策略选项，则 static 策略将不允许任何工作负载使用
`reservedSystemCPUs` 中指定的 CPU 核。

##### `prefer-align-cpus-by-uncorecache`

如果指定了 `prefer-align-cpus-by-uncorecache` 策略，则 static 策略为各个容器分配 CPU 资源时，
会让分配给容器的所有 CPU 共享同一个非处理核缓存块（也称为最后一级缓存或 LLC）。
默认情况下，CPUManager 会压缩打包 CPU 分配，这可能会导致分配给容器的 CPU 使用来自多个非核心的高速缓存块。
此选项使 CPUManager 能够在分配 CPU 时将非核心缓存的有效利用率最大化。
分配是在尽力而为的，目的是使共享同一非核心高速缓存的 CPU 个数尽可能多。
如果容器的 CPU 需求超过了单个非核心缓存对应的 CPU 个数，则 CPUManager
会尽量减少所使用的非核高速缓存数量，以保持最佳的非核高速缓存对齐。
某些的工作负载可以从降低缓存级别的缓存间延迟，减少嘈杂邻居的影响中受益。
如果 CPUManager 在节点具有足够资源的情况下无法最佳地对齐，则仍将使用默认的打包行为接受该容器。

## 为 Pod 分配内存的策略   {#memory-management-policies}

功能状态：MemoryManager，Kubernetes 1.32，stable；首次引入于 1.21。默认启用。

Kubernetes 内存管理器为 `Guaranteed`
QoS 类中的
Pod 分配 RAM（内存，以及可选的 Linux 大页内存）资源。

内存管理器采用提示生成协议，为 Pod 生成最合适的 NUMA 亲和性。
内存管理器将这些亲和性提示提交到中央管理器，即拓扑管理器（Topology Manager）。
取决于提示信息和拓扑管理器的策略，Pod 将被拒绝或允许进入节点。

此外，内存管理器可确保 Pod 请求的内存是从最少数量的 NUMA 节点中分配的。

要了解更多信息，请阅读[控制节点上的内存管理策略](/zh-cn/docs/tasks/administer-cluster/memory-manager/)。

## 其他资源管理器   {#other-resource-managers}

各个管理器的配置方式会在专项文档中详细阐述：

- [Device Manager](/zh-cn/docs/concepts/extend-kubernetes/compute-storage-net/device-plugins/#device-plugin-integration-with-the-topology-manager)
