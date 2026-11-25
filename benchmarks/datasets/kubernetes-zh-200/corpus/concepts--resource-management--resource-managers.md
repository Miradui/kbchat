# 资源管理器

为了支持对延迟敏感和高吞吐量的工作负载，Kubernetes 提供了一组资源管理器。
这些管理器旨在协调并优化节点资源的对齐，
以满足对 CPU、设备和内存（巨页）资源有特定需求的 Pod 的配置要求。

## 拓扑管理器 {#topology-manager}

功能状态：TopologyManager，Kubernetes 1.27，stable；首次引入于 1.16。特性门控已移除。该特性已稳定，不能再通过此门控禁用。

**拓扑管理器**（Topology Manager）是一个 kubelet 组件，旨在协调负责这些优化的组件集。
要了解更多信息，请阅读[控制节点上的拓扑管理策略](/zh-cn/docs/tasks/administer-cluster/topology-manager/)。

## CPU 管理器 {#cpu-manager}

功能状态：CPUManager，Kubernetes 1.26，stable；首次引入于 1.8。特性门控已移除。该特性已稳定，不能再通过此门控禁用。

**CPU 管理器**（CPU Manager）是一个 kubelet 组件，为 CPU 资源提供独占的资源分配。
它会与拓扑管理器协商，以做出资源分配决策。
要了解更多信息，请阅读[控制节点上的 CPU 管理策略](/zh-cn/docs/tasks/administer-cluster/cpu-management-policies/)。

### 为 Pod 分配 CPU 的策略 {#policies-for-assigning-cpus-to-pods}

一旦 Pod 绑定到某个节点，该节点上的 kubelet 可能需要多路复用现有硬件
（例如在多个 Pod 之间共享 CPU），或者通过专门划出一部分资源来分配硬件
（例如为某个 Pod 的独占使用分配一个或多个 CPU）。

默认情况下，kubelet 使用 [CFS 配额](https://en.wikipedia.org/wiki/Completely_Fair_Scheduler)
来强制执行 Pod 的 CPU 限制。当节点上运行许多 CPU 密集型 Pod 时，
工作负载可能会迁移到不同的 CPU 核，具体取决于 Pod
是否被节流以及调度时哪些 CPU 核可用。许多工作负载对这种迁移并不敏感，
因此在没有任何干预的情况下也能正常工作。

但是，对于 CPU 缓存亲和性和调度延迟会显著影响性能的工作负载，
kubelet 允许使用其他 CPU 管理策略来确定节点上的一些放置偏好。
这是通过 **CPU 管理器**及其策略实现的。有两种可用的策略：

- `none`：`none` 策略显式启用现有的默认 CPU 亲和性方案，
  除了操作系统调度器自动完成的操作外不提供任何亲和性。
  [Guaranteed Pod](/zh-cn/docs/concepts/workloads/pods/pod-qos/) 和
  [Burstable Pod](/zh-cn/docs/concepts/workloads/pods/pod-qos/)
  的 CPU 使用限制通过 CFS 配额来强制执行。
- `static`：`static` 策略允许 `Guaranteed` Pod 中具有整数 CPU `requests`
  的容器访问节点上的独占 CPU。这种独占性是使用
  [CPU 集 cgroup 控制器](https://www.kernel.org/doc/Documentation/cgroup-v2.txt)来强制保证的。

**说明：**

诸如容器运行时和 kubelet 本身之类的系统服务可以继续在这些独占 CPU 上运行。独占性只延伸到其他 Pod。

CPU 管理器不支持在运行时离线或上线 CPU。

#### 静态策略 {#static-policy}

静态策略可实现更精细的 CPU 管理和独占 CPU 分配。
此策略管理一个共享 CPU 池，该池最初包含节点中的所有 CPU。
可独占分配的 CPU 数量等于节点中的 CPU 总数减去 kubelet 配置所设置的所有 CPU 预留量。
通过这些选项预留的 CPU 会以整数数量按物理核心 ID 的升序从初始共享池中取用。
此共享池是 `BestEffort` 和 `Burstable` Pod 中任何容器运行所在的 CPU 集合。
CPU `requests` 为小数的 `Guaranteed` Pod 中的容器也在共享池中的 CPU 上运行。
只有属于 `Guaranteed` Pod 且具有整数 CPU `requests` 的容器才会被分配独占 CPU。

**说明：**

当启用静态策略时，kubelet 要求 CPU 预留量大于零。这是因为预留量零会让共享池变为空。

当容器满足静态分配要求的 `Guaranteed` Pod 被调度到节点时，CPU 会从共享池中移除并放入容器的 CPU 集中。
不会使用 CFS 配额来限制这些容器的 CPU 使用量，因为它们的使用量由调度域本身限制。
换句话说，容器 CPU 集中的 CPU 数量等于 Pod 规约中指定的整数 CPU `limit`。
这种静态分配会提高 CPU 亲和性，并减少 CPU 密集型工作负载因节流而导致的上下文切换。

考虑以下 Pod 规约中的容器：

```yaml
spec:
  containers:
  - name: nginx
    image: nginx
```

上面的 Pod 以 `BestEffort` QoS 类运行，因为它没有指定资源 `requests` 或 `limits`。它在共享池中运行。

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

上面的 Pod 以 `Burstable` QoS 类运行，因为资源 `requests` 不等于 `limits`，
并且没有指定 `cpu` 数量。它在共享池中运行。

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

上面的 Pod 以 `Burstable` QoS 类运行，因为资源 `requests` 不等于 `limits`。它在共享池中运行。

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

上面的 Pod 以 `Guaranteed` QoS 类运行，因为 `requests` 等于 `limits`。
且该容器对 CPU 资源的资源限制是大于或等于 1 的整数。`nginx` 容器被授予 2 个独占 CPU。

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
但该容器对 CPU 资源的资源限制是一个小数。它在共享池中运行。

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

上面的 Pod 以 `Guaranteed` QoS 类运行，因为只指定了 `limits`，
并且在未显式指定时 `requests` 会被设置为等于 `limits`。
且该容器对 CPU 资源的资源限制是大于或等于 1 的整数。
`nginx` 容器被授予 2 个独占 CPU。

##### 静态策略选项 {#cpu-policy-static--options}

以下是静态 CPU 管理策略可用的策略选项，按字母顺序列出：

`align-by-socket`（Alpha，默认隐藏）
: 按物理封装/插槽边界对齐 CPU，而不是按逻辑 NUMA 边界对齐
  （自 Kubernetes v1.25 起可用）

`distribute-cpus-across-cores`（Alpha，默认隐藏）
: 跨不同的物理核心分配虚拟核心（有时称为硬件线程）
  （自 Kubernetes v1.31 起可用）

`distribute-cpus-across-numa`（Beta，默认可见）
: 跨不同的 NUMA 域分散 CPU，力求在所选域之间实现均衡
  （自 Kubernetes v1.23 起可用）

`full-pcpus-only`（GA，默认可见）
: 始终分配完整的物理核心
  （自 Kubernetes v1.22 起可用，自 Kubernetes v1.33 起进阶到 GA）

`strict-cpu-reservation`（GA，默认可见）
: 阻止所有 Pod（无论其服务质量类别如何）在预留的 CPU 上运行
  （自 Kubernetes v1.32 起可用，自 Kubernetes v1.35 起进阶到 GA）

`prefer-align-cpus-by-uncorecache`（GA，默认可见）
: 以尽力而为的方式按 uncore（最后一级）缓存边界对齐 CPU
  （自 Kubernetes v1.32 起可用）

你可以使用以下特性门控，根据选项组的成熟度级别来启用或禁用这些选项：

* `CPUManagerPolicyBetaOptions`（默认启用）。禁用可隐藏 Beta 级选项。
* `CPUManagerPolicyAlphaOptions`（默认禁用）。启用可显示 Alpha 级选项。

你仍然必须使用 kubelet 配置文件中的 `cpuManagerPolicyOptions` 字段启用各个选项。

有关可以配置的各个选项的更多详细信息，请继续阅读。

###### `full-pcpus-only`

如果指定了 `full-pcpus-only` 策略选项，静态策略将始终分配完整的物理核心。
默认情况下，若不使用此选项，静态策略会使用拓扑感知的最佳匹配分配来分配 CPU。
在启用了 SMT 的系统上，该策略可以分配与硬件线程对应的各个虚拟核心。
这可能导致不同的容器共享相同的物理核心；
这种行为又会引发[吵闹的邻居问题](https://en.wikipedia.org/wiki/Cloud_computing_issues#Performance_interference_and_noisy_neighbors)。
启用该选项后，只有当某个 Pod 的所有容器的 CPU 请求都能通过分配完整的物理核心得到满足时，kubelet 才会接受该 Pod。
如果该 Pod 未通过准入，它会被置为 Failed 状态，并带有 `SMTAlignmentError` 消息。

###### `distribute-cpus-across-numa`

如果指定了 `distribute-cpus-across-numa` 策略选项，
则在需要多个 NUMA 节点才能满足分配的情况下，静态策略会跨 NUMA 节点均匀分配 CPU。
默认情况下，`CPUManager` 会将 CPU 打包到一个 NUMA 节点上直到填满，剩余的 CPU 会直接溢出到下一个 NUMA 节点。
这可能会给依赖屏障（及类似同步原语）的并行代码带来不必要的瓶颈，
因为这类代码的执行速度往往只取决于其最慢的工作线程（而至少有一个 NUMA 节点上可用 CPU 较少会拖慢该线程）。
通过在多个 NUMA 节点之间均匀分配 CPU，应用开发者可以更容易地确保没有单个工作线程比其他线程受到更严重的
NUMA 影响，从而提升这类应用的整体性能。

###### `align-by-socket`

如果指定了 `align-by-socket` 策略选项，则在决定如何将 CPU 分配给容器时，
CPU 会被视为以插槽为边界对齐。默认情况下，`CPUManager` 在 NUMA 边界处对齐 CPU 分配，
如果需要从多个 NUMA 节点拉取 CPU 才能满足分配，这可能会导致性能下降。
尽管它试图确保所有 CPU 都从**最少**数量的 NUMA 节点中分配，但无法保证这些 NUMA 节点位于同一个插槽上。
通过指示 `CPUManager` 显式地以插槽边界而不是 NUMA 边界对齐 CPU，
我们可以避免此类问题。注意，此策略选项与 `TopologyManager` 的 `single-numa-node` 策略
不兼容，并且不适用于插槽数量大于 NUMA 节点数量的硬件。

###### `distribute-cpus-across-cores`

如果指定了 `distribute-cpus-across-cores` 策略选项，静态策略会尝试跨不同的物理核心分配虚拟核心（硬件线程）。
默认情况下，`CPUManager` 倾向于将 CPU 打包到尽可能少的物理核心上，这可能导致同一物理核心上的 CPU 之间发生争用，造成性能瓶颈。
通过启用 `distribute-cpus-across-cores` 策略，静态策略可确保 CPU 尽可能分散到更多的物理核心上，
减少同一物理核心上的争用，从而提高整体性能。但是，需要注意的是，当系统负载很重时，此策略的效果可能较差。
在这种情况下，减少争用带来的好处会减弱。相反，
默认行为有助于减少核心间通信开销，在高负载条件下可能提供更好的性能。

###### `strict-cpu-reservation`

[KubeletConfiguration](/zh-cn/docs/reference/config-api/kubelet-config.v1beta1/) 中的
`reservedSystemCPUs` 参数，或已弃用的 kubelet 命令行选项 `--reserved-cpus`，
为 OS 系统守护进程和 Kubernetes 系统守护进程定义了一个显式的 CPU 集合。有关此参数的更多详细信息，
请参见[显式预留的 CPU 列表](/zh-cn/docs/tasks/administer-cluster/reserve-compute-resources/#explicitly-reserved-cpu-list)页面。
默认情况下，这种隔离仅针对具有整数 CPU 请求的 Guaranteed Pod 实现，
而不适用于 Burstable 和 BestEffort Pod（以及具有小数 CPU 请求的 Guaranteed Pod）。
准入只会将 CPU 请求与可分配的 CPU 进行比较。
由于 CPU 限制高于请求，默认行为允许 Burstable 和 BestEffort Pod 占满
`reservedSystemCPUs` 的容量，从而在实际部署中导致主机 OS 服务资源匮乏。
如果启用了 `strict-cpu-reservation` 策略选项，
静态策略将不允许任何工作负载使用 `reservedSystemCPUs` 中指定的 CPU 核心。

###### `prefer-align-cpus-by-uncorecache`

如果指定了 `prefer-align-cpus-by-uncorecache` 策略，静态策略会为各个容器分配 CPU 资源，
使分配给某个容器的所有 CPU 共享同一个 uncore 缓存块（也称为最后一级缓存或 LLC）。
默认情况下，`CPUManager` 会紧密打包 CPU 分配，这可能导致分配给容器的 CPU 来自多个 uncore 缓存。
此选项使 `CPUManager` 能够以最大化 uncore 缓存利用效率的方式分配 CPU。
分配以尽力而为的方式进行，目的是让尽可能多的 CPU 归属同一个 uncore 缓存。
如果容器的 CPU 需求超过单个 uncore 缓存的 CPU 容量，
`CPUManager` 会尽量减少所使用的 uncore 缓存数量，以保持最佳的 uncore 缓存对齐。
特定工作负载可以从降低缓存间延迟和缓存层面的吵闹邻居影响中获益。
如果节点资源充足而 `CPUManager` 无法最佳对齐，容器仍会使用默认的紧密打包行为被接受。

## 内存管理器 {#memory-manager}

功能状态：MemoryManager，Kubernetes 1.32，stable；首次引入于 1.21。默认启用。

**内存管理器**（Memory Manager）是一个 kubelet 组件，为内存资源提供独占的资源分配。
它会与拓扑管理器协商，以做出资源分配决策。
要了解更多信息，请阅读[控制节点上的内存管理策略](/zh-cn/docs/tasks/administer-cluster/memory-manager/)。

### 为 Pod 分配内存的策略 {#memory-management-policies}

Kubernetes **内存管理器**为 `Guaranteed`
QoS 类中的 Pod
分配 RAM（内存，以及可选的 Linux 巨页）资源。

内存管理器采用提示生成协议，为 Pod 生成最合适的 NUMA 亲和性。
内存管理器将这些亲和性提示提供给中央管理器（**拓扑管理器**）。
根据这些提示和拓扑管理器的策略，Pod 会被拒绝或接入节点。

此外，内存管理器确保 Pod 请求的内存从最少数量的 NUMA 节点中分配。

要了解更多信息，请阅读[控制节点上的内存管理策略](/zh-cn/docs/tasks/administer-cluster/memory-manager/)。

## 设备管理器 {#device-manager}

功能状态：Kubernetes v1.26，stable。

**设备管理器**（Device Manager）是一个 kubelet 组件，使用设备插件 API 将硬件设备分配给 Pod。
它会与拓扑管理器协商，利用设备插件提供的拓扑信息来做出资源分配决策。要了解更多信息，
请阅读[设备插件与拓扑管理器的集成](/zh-cn/docs/concepts/extend-kubernetes/compute-storage-net/device-plugins/#device-plugin-integration-with-the-topology-manager)。

## Pod 级资源管理器 {#pod-level-resource-managers}

功能状态：PodLevelResourceManagers，Kubernetes 1.37，beta；首次引入于 1.36。默认禁用。使用前需配置相应特性门控。

对 `kubelet` 资源管理器（拓扑、CPU 和内存）的 Pod 级资源支持，
允许资源管理器直接使用 `.spec.resources` 做出 NUMA 对齐和独占分配决策。

要了解更多信息，请参阅专门的
[Pod 级资源管理器](/zh-cn/docs/concepts/resource-management/pod-level-resource-managers/)概念页面，
或阅读如何[分配 Pod 级 CPU 和内存资源](/zh-cn/docs/tasks/configure-pod-container/assign-pod-level-resources/)。

## ## 接下来

- [节点资源管理器](/zh-cn/docs/concepts/policy/node-resource-managers/)
