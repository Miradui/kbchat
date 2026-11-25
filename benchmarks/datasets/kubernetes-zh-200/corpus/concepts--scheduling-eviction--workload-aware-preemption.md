# 工作负载感知的抢占

功能状态：GenericWorkload，Kubernetes 1.37，beta；首次引入于 1.35。默认禁用。使用前需配置相应特性门控。

**说明：**

在 v1.36 中，工作负载感知的抢占逻辑由 `WorkloadAwarePreemption` 特性门控控制。
此特性门控在 v1.37 中被合并到 `GenericWorkload` 特性门控中。

工作负载感知的抢占引入了一种专门为 PodGroup 设计的抢占机制。
当 PodGroup 无法被调度时，调度器会使用抢占逻辑，尝试使该 PodGroup 的调度成为可能。
此方法仅在 PodGroup 调度期间使用，并替代给定 PodGroup 中 Pod 的默认抢占机制。

当此特性被启用时，调度器将 PodGroup 视为单个抢占者单元，而不是孤立地评估 PodGroup 中的各个 Pod。
为了给组中悬决的 Pod 腾出空间，它会在整个集群中搜索被抢占者，
并知道如何根据其他 PodGroup 的干扰模式将其作为被抢占者来处理和抢占。

此特性与[编组调度](/zh-cn/docs/concepts/scheduling-eviction/gang-scheduling/)耦合，
并依赖于 [Workload API](/zh-cn/docs/concepts/workloads/workload-api/)。
确保集群中启用了 [`scheduling.k8s.io/v1beta1`]API 组。

## 工作原理   {#how-it-works}

工作负载感知的抢占过程遵循与[默认抢占](/zh-cn/docs/concepts/scheduling-eviction/pod-priority-preemption/#preemption)相同的原则，
但存在以下差异：

1. 集群范围域：调度器不会逐个节点地评估抢占，而是将整个集群作为单个域进行评估。
   它会在多个节点间选择一组可以被移除的被抢占者，从而为抢占者 PodGroup 腾出足够的调度空间。

2. 被抢占者重要性层级：调度器使用严格的层级来决定哪些抢占单元（单个 Pod 或 PodGroup）更为关键、应当被豁免抢占：

   * 优先级：优先级更高的单元总是更重要。
   * 工作负载类型：在相同优先级下，PodGroup 比单个 Pod 更重要。
   * 组大小（PodGroup）：如果两个单元都是 PodGroup，成员更多（规模更大）的那个被认为更重要。
   * 启动时间：更早启动的单元更重要。

3. PodGroup 优先级和干扰：调度器会考虑 PodGroup
   特定的[优先级和干扰模式](/zh-cn/docs/concepts/workloads/workload-api/disruption-and-priority/)，
   以评估在抢占事件中其 Pod 是否以及如何能被抢占。

4. 性能与最优性考量：出于性能原因，工作负载感知的抢占首先模拟移除所有潜在被抢占者并运行一次调度。
   然后它尝试为选定的放置方案尽可能多地豁免被抢占者。这种权衡意味着可能存在导致更少抢占的替代放置方案，
   但由于性能原因，调度器不会选择它。

**说明：**

当调度单个 Pod 时，适用默认的 Pod 抢占机制。
在 v1.36 中，当调度器为单个 Pod 执行默认抢占并尝试抢占属于某个 PodGroup 的 Pod 时，
它**不会**考虑该 PodGroup 的 `priority` 或 `disruptionMode` 字段。
此限制不再适用于 v1.37。

### 豁免算法   {#reprieval-algorithm}

在运行工作负载感知的抢占时，调度器会运行模拟，移除潜在的抢占被抢占者并运行 PodGroup 调度算法。
然后它尝试为返回的放置方案尽可能多地豁免被抢占者。为此，调度器会复用 PodGroup 调度的 CycleStates。
对于每个按重要性排序的潜在被抢占者，调度器：

1. 将被抢占者的 Pod 重新添加到其节点和抢占者 Pod 的 CycleStates 中。
2. 对于 PodGroup 中的每个 Pod（按与调度算法相同的顺序）：

   * 在其建议的节点上为该 Pod 运行 Filter 插件
   * 将该 Pod 添加到其建议的节点上
   * 在其建议的节点上为该 Pod 运行 Reserve 插件

如果对于每个 Pod，Filtering 都通过，则被抢占者的 Pod 保留在其节点上。

如果至少有一个 Pod 的 Filtering 失败，则被抢占者的 Pod 将从 CycleStates 和节点中移除。

在两种情况下，调度器都会将抢占者 Pod 从其节点上移除并调用其 Unreserve，
以便下一次豁免尝试可以验证 PodGroup 的调度。然后调度器继续处理另一个潜在被抢占者，
直到所有被抢占者都被处理完毕。

### CompositePodGroup 的抢占   {#preemption-for-compositepodgroups}

功能状态：CompositePodGroup，Kubernetes 1.37，alpha；首次引入于 1.37。默认禁用。使用前需配置相应特性门控。

当 [`CompositePodGroup`](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/#CompositePodGroup)
特性门控和 `scheduling.k8s.io/v1alpha3` API 组启用时，
工作负载感知的抢占也为 `CompositePodGroup` 提供支持。

底层的抢占机制与 `PodGroup` 相同——如果调度器需要释放容量来放置根 `CompositePodGroup`，
它会对整个组层级进行抢占评估，而不是针对单个 Pod。

`CompositePodGroup` 也可以被选为抢占被抢占者。被抢占者选择过程经过调整，以按以下方式考虑 `CompositePodGroup`：

1. 被抢占者重要性层级：

   - 在相同优先级下，`CompositePodGroup` 比独立的 `PodGroup` 更重要。
   - 对于两个相同优先级的 `CompositePodGroup`，成员更多（规模更大）的那个被认为更重要。

2. 干扰模式：与 `PodGroup` 类似，`CompositePodGroup`
   指定了[干扰模式](/zh-cn/docs/concepts/workloads/workload-api/disruption-and-priority/)，
   用于决定在抢占期间其子组应如何被处理。

除了工作负载感知的抢占外，在 Pod 调度周期中，`CompositePodGroup` 也可以被默认 Pod 抢占选为被抢占者，
与 `PodGroup` 和 Pod 并列。默认 Pod 抢占与工作负载感知的抢占共享被抢占者重要性层级逻辑，
并尊重 `CompositePodGroup` 的 `disruptionMode` 字段。

## ## 接下来

* 进一步了解 [PodGroup 优先级和干扰](/zh-cn/docs/concepts/workloads/workload-api/disruption-and-priority/)。
* 了解 [Workload API](/zh-cn/docs/concepts/workloads/workload-api/)。
* 进一步阅读[编组调度](/zh-cn/docs/concepts/scheduling-eviction/gang-scheduling/)。
