# PodGroup 调度

功能状态：GenericWorkload，Kubernetes 1.37，beta；首次引入于 1.35。默认禁用。使用前需配置相应特性门控。

标准的 Kubernetes 调度器按顺序逐个评估 Pod。当多个工作负载（例如机器学习训练作业）被并发提交时，
这种顺序评估可能导致资源死锁。例如，两个相互竞争的工作负载可能各自调度了其 Pod 的一个子集，
消耗了集群容量，但两个工作负载都没有足够的资源来完全启动。

PodGroup 调度周期将一组 Pod 作为单个单元进行评估。调度器尝试同时为组中的所有 Pod 寻找放置位置。
如果它无法找到足够的资源来满足整个组的需求，则不会绑定任何 Pod。

此外，将组视为一个统一实体建立了一种基础架构，简化了其他基于组的调度特性的实现。

此特性依赖于 [Workload API](/zh-cn/docs/concepts/workloads/workload-api/)。
确保在集群中启用了
[`GenericWorkload`](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/#GenericWorkload)
特性门控以及 `scheduling.k8s.io/v1alpha1` API 组。

## PodGroup 调度周期   {#podgroup-scheduling-cycle}

为了支持将一组 Pod 一起调度，kube-scheduler 使用了 **PodGroup 调度周期**。
调度器不再逐个处理 Pod 并将其阻塞在 `WaitOnPermit` 门控处，
而是集体评估属于特定 PodGroup 的整个悬决 Pod 组。
它不再为每个 Pod 执行单独的调度周期，而是评估整个组的可行性，随后直接进入绑定阶段。

当调度器弹出一个属于某 PodGroup 的 Pod 时，它会检索该组中所有其他排队的 Pod。
然后，它根据优先级和调度器最初观察到这些 Pod 的时间对它们进行确定性排序，
并按如下方式启动 PodGroup 调度周期：

1. **对集群状态进行快照：** 当调度器开始评估 PodGroup 时，它会为整个周期拍摄一次集群状态快照。
   这确保了对整个组的评估保持一致，并防止与其他事件发生竞争状况。

2. **寻找可行的放置位置：** 调度器运行
   [PodGroup 调度算法](#podgroup-scheduling-algorithm)来为组中的 Pod 寻找有效的节点放置位置。

3. **原子性决策：** 根据算法的结果，调度决策以原子方式应用于整个 PodGroup。

   * **成功：** 如果调度器找到了足够的资源和有效的 Pod 放置位置
     （例如，满足 [Gang 调度](/zh-cn/docs/concepts/scheduling-eviction/gang-scheduling/)的 `minCount` 约束），
     这些 Pod 将带着其选定的节点直接进入绑定周期。任何剩余的不可调度 Pod 将被返回到调度队列，等待可用资源，
     以便它们可以加入已被调度的 Pod。

     此外，如果在其他 Pod 已经被调度后有新的 Pod 被添加到 PodGroup，该周期将在考虑已存在 Pod 的同时评估新 Pod。

   * **失败：** 如果调度器无法找到足够的资源使 PodGroup 可行
     （例如，未能满足 `minCount` 约束），则整个 PodGroup 被视为不可调度。
     不会绑定任何 Pod，所有 Pod 都会被返回到调度队列。标准的调度退避逻辑适用，允许 PodGroup 稍后重试。

通过使用这种单周期方法，调度器避免了低效的瓶颈，即部分调度的组在无限期等待其余组员适配的同时占用了集群容量。

## PodGroup 调度算法   {#podgroup-scheduling-algorithm}

默认的 PodGroup 调度算法在很大程度上依赖于基于 Pod 的基线调度算法。它遍历所有 Pod，并对每个 Pod 执行以下操作：

1. 使用标准的逐 Pod 过滤和评分阶段寻找可行的节点。

   * 如果 Pod 适配，则假定它暂时被保留在所选节点上，直到调度算法结束。
   * 如果 Pod 无法适配，调度器会通过运行 `PostFilter` 扩展点来尝试抢占。

2. 使用 `Permit` 扩展点检查可调度的 Pod 是否满足组的调度标准
   （例如，[Gang 调度](/zh-cn/docs/concepts/scheduling-eviction/gang-scheduling/)的 `minCount`）。
   如果它对任何 Pod 返回 `Success` 状态，则 PodGroup 被视为可行。
   如果算法处理完所有 Pod 都未达到 `Success` 状态，则 PodGroup 被视为不可调度。

## 放置调度算法   {#placement-scheduling-algorithm}

功能状态：TopologyAwareWorkloadScheduling，Kubernetes 1.36，alpha；首次引入于 1.36。默认禁用。使用前需配置相应特性门控。

放置调度算法是一种替代的 PodGroup 调度算法，
它使用[调度插件](/zh-cn/docs/reference/scheduling/config/#scheduling-plugins)来为所考虑的 PodGroup
寻找最优放置位置。用户可以通过使用和配置插件来使算法适应其特定需求。

对于给定的 PodGroup，该算法分三个主要阶段进行：

### 阶段 1：候选放置生成   {#phase-1-candidate-placement-generation}

生成候选**放置位置**（节点子集，理论上可用于 PodGroup 分配），
例如基于 PodGroup 的调度约束（可在 PodGroup 对象中定义）。

此阶段作为扩展点执行：`PlacementGeneratePlugin`。

### 阶段 2：Pod 级别过滤和可行性检查   {#phase-2-pod-level-filtering-and-feasibility-check}

通过运行默认的 PodGroup 调度算法来验证每个提议的放置位置，
查看 PodGroup 中所需数量的 Pod 是否能适配。如果可以，则该放置位置被标记为可行。

### 阶段 3：放置评分和选择   {#phase-3-placement-scoring-and-selection}

对所有可行的放置位置进行评分，以为 PodGroup 选择最优域。

此阶段作为扩展点执行：`PlacementScorePlugin`。

### 局限性   {#limitations}

PodGroup 调度算法依赖于特定的 Pod 排序，可能无法找到通过以不同顺序处理组中的 Pod 本可发现的有效放置位置。具体来说：

* 对于基本的**同质** Pod 组（即所有 Pod 具有相同调度需求，
  且缺乏 Pod 间依赖关系（如亲和性、反亲和性或拓扑分布约束）的 Pod 组），
  如果存在放置位置，算法预期能够找到。

* 对于**异质** Pod 组，不保证能找到有效的放置位置。

* 对于具有 **Pod 间依赖关系**的 Pod 组，不保证能找到有效的放置位置。

除上述情况外，对于涉及**组内依赖**的情况（例如，当一个 Pod 的可调度性通过 Pod 间亲和性依赖于另一个组成员时），
由于其确定性的处理顺序，无论集群状态如何，此算法都可能无法找到放置位置。

为了在整个周期内保持一致的行为，该算法要求属于单个 PodGroup 的所有 Pod
共享相同的 `.spec.schedulerName`。此要求在周期开始前进行验证，如果不满足此约束，PodGroup 将被拒绝。

## PodGroup 状况   {#podgroup-conditions}

PodGroup 调度周期完成后，调度器会更新 PodGroup 的 `status.conditions` 上的状况：

* `PodGroupScheduled`：报告 PodGroup 是否已被成功调度。
* `DisruptionTarget`：指示 PodGroup 即将因中断（如抢占）而被终止。

### `PodGroupScheduled`

当调度周期成功时，该状况被设置为 `True`，原因为
`Scheduled`。对于 `gang` 策略的 PodGroup，这意味着至少放置了 `minCount` 个 Pod。

当调度失败时，该状况被设置为 `False`，原因为以下之一：

* `Unschedulable` — 由于资源约束、亲和性或反亲和性规则，或编组容量不足，组无法被放置。
* `SchedulerError` — 由于调度器内部错误导致调度失败（例如，在解析 `nodeAffinity` 等调度约束时）。

### `DisruptionTarget`   {#disruptiontarget}

当调度器抢占 PodGroup 以便为更高优先级的 PodGroup 或
Pod 腾出空间时，它会将此状况设置为 `True`，原因为 `PreemptionByScheduler`。

你可以使用以下命令检查状况：

```shell
kubectl get podgroup <name> -o jsonpath='{.status.conditions}'
```

## ## 接下来

* 了解 [Workload API](/zh-cn/docs/concepts/workloads/workload-api/)。
* 了解如何在 Pod 中[引用 Workload](/zh-cn/docs/concepts/workloads/pods/workload-reference/)。
* 进一步阅读 [Gang 调度](/zh-cn/docs/concepts/scheduling-eviction/gang-scheduling/)。
