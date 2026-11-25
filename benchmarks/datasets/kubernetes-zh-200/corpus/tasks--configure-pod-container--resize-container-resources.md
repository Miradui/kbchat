# 调整分配给容器的 CPU 和内存资源

功能状态：InPlacePodVerticalScaling，Kubernetes 1.35，stable；首次引入于 1.27。默认启用。门控值已锁定。

本页面说明了如何在**不重新创建 Pod** 的情况下，更改分配给容器的 CPU 和内存资源请求与限制。

传统上，更改 Pod 的资源需求需要删除现有 Pod 并创建一个替代 Pod，
这通常由[工作负载控制器](/zh-cn/docs/concepts/workloads/controllers/)管理。
而就地 Pod 调整功能允许在运行中的 Pod 内变更容器的 CPU 和内存分配，从而可能避免干扰应用。
Pod 资源调整的流程详见：[调整分配给 Pod 的 CPU 与内存资源](/zh-cn/docs/tasks/configure-pod-container/resize-pod-resources)。

**关键概念：**

- **期望资源（Desired Resources）**：容器的 `spec.containers[*].resources`
  字段表示容器的**期望**资源，对于 CPU 和内存是可变的。
- **实际资源（Actual Resources）**：`status.containerStatuses[*].resources`
  字段反映当前运行容器**实际配置**的资源。
  对于尚未启动或重新启动的容器，该字段表示其下次启动时分配的资源。
- **触发调整（Triggering a Resize）**：你可以通过更新 Pod 规约中的 `requests` 和 `limits` 来请求调整。
  这通常通过 `kubectl patch`、`kubectl apply` 或 `kubectl edit` 操作
  Pod 的 `resize` 子资源来完成。
  当期望资源与已分配资源不一致时，kubelet 会尝试调整容器资源。
- **已分配资源（Allocated Resources，进阶）**：`status.containerStatuses[*].allocatedResources`
  字段用于记录由 kubelet 确认的资源值，主要用于内部调度逻辑。
  在大多数监控和验证场景中，建议关注 `status.containerStatuses[*].resources` 字段。

如果某个节点上存在处于挂起或未完成调整状态的 Pod（见下文 [Pod 调整状态](#pod-resize-status)），
调度器会在进行调度决策时，
使用容器的期望请求、已分配请求和实际请求三者中的**最大值**。

## ## 准备开始

你必须拥有一个 Kubernetes 的集群，且必须配置 kubectl 命令行工具让其与你的集群通信。
建议运行本教程的集群至少有两个节点，且这两个节点不能作为控制平面主机。
如果你还没有集群，你可以通过 [Minikube](https://minikube.sigs.k8s.io/docs/tutorials/multi_node/)
构建一个你自己的集群，或者你可以使用下面的 Kubernetes 练习环境之一：

* [iximiuz Labs](https://labs.iximiuz.com/playgrounds?category=kubernetes&filter=all)
* [Killercoda](https://killercoda.com/playgrounds/scenario/kubernetes)
* [KodeKloud](https://kodekloud.com/public-playgrounds)
 Kubernetes 服务端最低版本：1.33。使用 `kubectl version` 检查版本。

你需要在控制平面和集群中的所有节点上启用 `InPlacePodVerticalScaling`
[特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/)。  

要为被延后的资源调整请求启用调度器自动抢占功能，还必须为你的控制平面启用
`InPlacePodVerticalScalingSchedulerPreemption` [特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/)。

要动态调整基于内存的（`medium: Memory`）`emptyDir` 卷的大小，还必须为你的控制平面和节点启用
`InPlacePodVerticalScalingMemoryBackedVolumes` [特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/)，
并且底层节点必须运行 CGroup v2。

要使用 `--subresource=resize` 参数，`kubectl` 客户端版本需至少为 v1.32。

## Pod 大小调整状态   {#pod-resize-status}

kubelet 会通过更新 Pod 的状态状况来反映调整请求的当前状态：

* `type: PodResizePending`：kubelet 当前无法立即执行该请求。`message` 字段会说明原因：
  * `reason: Infeasible`：请求的资源在当前节点上不可行（例如请求超出节点总资源）。
  * `reason: Deferred`：请求的资源当前无法满足，但未来可能满足（例如其他 Pod 被移除后），
    kubelet 会重试调整。
* `type: PodResizeInProgress`：kubelet 已接受调整并分配了资源，但调整仍在进行中。  
  这一状态通常很短暂，但也可能因资源类型或运行时行为而延长。
  执行过程中的任何错误都会在 `message` 字段中报告，同时带有 `reason: Error`。

### 被延后的资源调整请求如何重试与抢占

如果请求的调整大小操作被标记为 **Deferred**，kubelet 会定期重新尝试执行该调整，例如当其他 Pod 被移除或缩容时。

**说明：**

功能状态：InPlacePodVerticalScalingSchedulerPreemption，Kubernetes 1.37，alpha；首次引入于 1.37。默认禁用。使用前需配置相应特性门控。

当启用 `InPlacePodVerticalScalingSchedulerPreemption` 特性门控时，`kube-scheduler`
会监视那些资源调整状态为 `Deferred`（已延后）的 Pod。

如果某节点的容量不足以满足一个高优先级 Pod 的资源调整请求，
调度器可以抢占（即驱逐）该节点上优先级较低的 Pod，
从而释放出所需的 CPU 或内存容量。

更多细节请参见[就地 Pod 资源调整的抢占](/zh-cn/docs/concepts/scheduling-eviction/pod-priority-preemption/preemption-for-in-place-pod-resize)。

当存在多个延迟的调整操作时，kubelet 会按照以下优先级顺序进行重试：

* 优先级（基于 PriorityClass）较高的 Pod，其调整请求会先被重试。
* 如果两个 Pod 拥有相同的优先级，则会先重试 Guaranteed 类型的 Pod，再重试 Burstable 的类型 Pod。
* 如果上述条件均相同，则优先处理在延迟状态下停留时间更长的 Pod。

需要注意的是，即使高优先级的调整被再次标记为待处理，也不会阻塞其余待处理的调整操作；
其余的待处理调整仍会被继续重试。

### 利用 `observedGeneration` 字段

功能状态：PodObservedGenerationTracking，Kubernetes 1.35，stable；首次引入于 1.33。默认启用。门控值已锁定。

* 顶层的 `status.observedGeneration` 字段显示了 kubelet 已确认的最新 Pod 规约所对应的 `metadata.generation`。
  你可以使用该字段来判断 kubelet 已处理的最近一次调整请求。
* 在 `PodResizeInProgress` 状态条件，`conditions[].observedGeneration` 字段表示当前正在进行的调整操作开始时，
  该 Pod 规约（podSpec）的 `metadata.generation`。
* 在 `PodResizePending` 状态条件，`conditions[].observedGeneration` 字段表示上一次尝试为待处理调整请求分配资源时，
  Pod 规约的 `metadata.generation`。

## 容器调整策略   {#container-resize-policies}

容器可以在资源需求中指定可选的 `resizePolicy` 数组。  
该数组中的每一项定义了某种资源在就地调整期间应如何处理。

你可以通过在容器规约中设置 `resizePolicy`，控制在调整资源时容器是否需要重启。
这样可以针对不同资源类型（CPU 或内存）进行精细化控制。

```yaml
    resizePolicy:
    - resourceName: cpu
      restartPolicy: NotRequired
    - resourceName: memory
      restartPolicy: RestartContainer
```

* `NotRequired`：（默认）在不重启容器的情况下应用资源变更。
* `RestartContainer`：重启容器以应用新的资源值。
  对于内存变更，许多应用和运行时无法动态调整内存分配，因此通常需要重启。

如果未为某个资源指定 `resizePolicy[*].restartPolicy`，则默认为 `NotRequired`。

**说明：**

如果 Pod 的整体 `restartPolicy` 为 `Never`，则所有容器的 `resizePolicy` 必须对所有资源都设置为 `NotRequired`。
此类 Pod 不允许配置需要重启的调整策略。

**示例场景：**

考虑一个容器，其 CPU 的 `restartPolicy` 为 `NotRequired`，内存的
`restartPolicy` 为 `RestartContainer`：
* 如果仅更改 CPU 资源，容器将原地调整大小。
* 如果仅更改内存资源，容器将重启。
* 如果**同时**更改 CPU 和内存资源，容器将重启（由于内存策略）。

## 调整内存支持的 emptyDir 卷大小

功能状态：InPlacePodVerticalScalingMemoryBackedVolumes，Kubernetes 1.37，alpha；首次引入于 1.37。默认禁用。使用前需配置相应特性门控。

当启用 `InPlacePodVerticalScalingMemoryBackedVolumes` 特性门控时，Pod
的 `/resize` 子资源支持更新运行中 Pod 上基于内存的（`medium: Memory`）`emptyDir`
卷的 `sizeLimit`，而无需重启容器或重建 Pod。

当通过 `/resize` 子资源更新某个卷的 `sizeLimit` 时，kubelet
会动态地更新底层的 `tmpfs` 挂载点，且不会对容器造成中断，
同时能安全地避免出现内存不足（OOM）错误或误触发驱逐。

要调整基于内存的 `emptyDir` 卷的大小，请针对 Pod 的 `resize`
子资源更新 `spec.volumes[].emptyDir.sizeLimit`：

```shell
kubectl patch pod <pod-name> --subresource resize --patch \
  '{"spec":{"volumes":[{"name":"cache-volume", "emptyDir":{"sizeLimit":"200Mi"}}]}}'
```

你可以通过 Pod 的状态状况（`PodResizePending` 和
`PodResizeInProgress`）来监控资源调整进度。
完成之后，你可以在运行中的容器内核对实际的卷容量（例如使用
`kubectl exec` 运行 `df -h`）。

## 限制   {#limitations}

对于 Kubernetes v1.37，原地调整 Pod 资源大小存在以下限制：

* **资源类型**：只能调整 CPU 和内存资源。

* **内存减少**：如果内存调整的重启策略为 `NotRequired`（或未指定），kubelet
  会尽力在降低内存限制时避免 OOM（内存不足导致的进程被杀死），
  但并不提供任何保证。在降低容器内存限制之前，如果内存使用量已超过请求的限制，则此次调整会被跳过，
  状态将保持在 "In Progress"。之所以称为尽力而为，是因为该过程仍可能受到竞争条件影响：
  在检查完成后，内存使用量可能会立即出现峰值。

* **QoS 类**：Pod 的原始[服务质量（QoS）类](/zh-cn/docs/concepts/workloads/pods/pod-qos/)
  （Guaranteed、Burstable 或 BestEffort）在创建时确定，**不能**通过调整大小来更改。
  调整后的资源值仍必须遵守原始 QoS 类的规则：
  * **Guaranteed**：调整后，CPU 和内存的请求必须继续等于限制。
  * **Burstable**：CPU 和内存的请求和限制不能**同时**变为相等
    （因为这会将其更改为 Guaranteed）。
  * **BestEffort**：不能添加资源要求（`requests` 或 `limits`）
    （因为这会将其更改为 Burstable 或 Guaranteed）。

* **容器类型**：不可重启的 Init 容器和
  临时容器不能调整大小。
  [边车容器](/zh-cn/docs/concepts/workloads/pods/sidecar-containers/)可以调整大小。

* **资源移除**：一旦设置了资源请求和限制，就不能完全移除；
  只能更改为不同的值。

* **操作系统**：Windows Pod 不支持原地调整大小。

* **节点策略**：由[静态 CPU 或内存管理器策略](/zh-cn/docs/tasks/administer-cluster/cpu-management-policies/)管理的
  Pod 不能原地调整大小。

* **交换内存**：使用[交换内存](/zh-cn/docs/concepts/architecture/nodes/#swap-memory)的 Pod 不能调整内存请求，
  除非内存的 `resizePolicy` 为 `RestartContainer`。

* **基于内存的卷调整大小：**原地调整基于内存的（`medium: Memory`）`emptyDir`
  卷的大小，要求节点运行 CGroup v2。在运行 CGroup v1 的节点上，
  原地卷调整请求会被视为不可行而拒绝。基于磁盘的 `emptyDir`
  卷和持久卷无法通过 Pod 的 `/resize` 子资源进行调整大小。

这些限制可能会在未来的 Kubernetes 版本中放宽。

## 创建命名空间

创建一个命名空间，以便将你在此练习中创建与集群其余部分隔离的资源。

```shell
kubectl create namespace qos-example
```

## 示例 1：调整 CPU 而不重启   {#example-1-resizing-cpu-without-restart}

首先，创建一个设计用于原地 CPU 调整和需要重启的内存调整的 Pod。

示例文件：`pods/resource/pod-resize.yaml`

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: resize-demo
spec:
  containers:
  - name: pause
    image: registry.k8s.io/pause:3.8
    resizePolicy:
    - resourceName: cpu
      restartPolicy: NotRequired # Default, but explicit here
    - resourceName: memory
      restartPolicy: RestartContainer
    resources:
      limits:
        memory: "200Mi"
        cpu: "700m"
      requests:
        memory: "200Mi"
        cpu: "700m"
```

创建 Pod：

```shell
kubectl create -f pod-resize.yaml -n qos-example
```

这个 Pod 以 Guaranteed QoS 类启动。验证其初始状态：

```shell
# 等待 Pod 运行
kubectl get pod resize-demo --output=yaml -n qos-example
```

观察 `spec.containers[0].resources` 和 `status.containerStatuses[0].resources`。
它们应该与清单文件匹配（700m CPU，200Mi 内存）。注意 `status.containerStatuses[0].restartCount`（应该为 0）。

现在，将 CPU 请求和限制增加到 `800m`。使用带有 `--subresource resize` 命令行参数的 `kubectl patch`。

```shell
kubectl patch pod resize-demo -n qos-example --subresource resize --patch \
  '{"spec":{"containers":[{"name":"pause", "resources":{"requests":{"cpu":"800m"}, "limits":{"cpu":"800m"}}}]}}'

# 替代方法：
# kubectl -n qos-example edit pod resize-demo --subresource resize
# kubectl -n qos-example apply -f <updated-manifest> --subresource resize --server-side
```

**说明：**

`--subresource resize` 命令行参数要求 `kubectl` 客户端版本为 v1.32.0 或更高。
较早版本会报告 `invalid subresource` 错误。

在应用补丁后再次检查 Pod 状态：

```shell
kubectl get pod resize-demo --output=yaml --namespace=qos-example
```

你应该看到：
* `spec.containers[0].resources` 现在显示 `cpu: 800m`。
* `status.containerStatuses[0].resources` 也显示 `cpu: 800m`，表明节点上的调整已成功。
* `status.containerStatuses[0].restartCount` 保持为 `0`，因为 CPU 的 `resizePolicy` 是 `NotRequired`。

## 示例 2：调整内存并重启   {#example-2-resizing-memory-with-restart}

现在，将**同一个** Pod 的内存增加到 `300Mi`。
由于内存的 `resizePolicy` 是 `RestartContainer`，容器将会重启。

```shell
kubectl patch pod resize-demo -n qos-example --subresource resize --patch \
  '{"spec":{"containers":[{"name":"pause", "resources":{"requests":{"memory":"300Mi"}, "limits":{"memory":"300Mi"}}}]}}'
```

在应用补丁后立即检查 Pod 状态：

```shell
kubectl get pod resize-demo --output=yaml --namespace=qos-example
```

你现在应该观察到：
* `spec.containers[0].resources` 显示 `memory: 300Mi`。
* `status.containerStatuses[0].resources` 也显示 `memory: 300Mi`。
* `status.containerStatuses[0].restartCount` 增加到 `1`（如果之前发生过重启，可能会更多），
  表明容器已重启以应用内存变更。

## 故障排查：不可行的调整请求   {#troubleshooting-infeasible-resize-request}

接下来，尝试请求不合理的 CPU 数量，例如 1000 个完整核心（写作 `"1000"` 而不是 `"1000m"` 毫核），这很可能超出节点容量。

```shell
# 尝试使用过大的 CPU 请求进行补丁
kubectl patch pod resize-demo -n qos-example --subresource resize --patch \
  '{"spec":{"containers":[{"name":"pause", "resources":{"requests":{"cpu":"1000"}, "limits":{"cpu":"1000"}}}]}}'
```

查询 Pod 的详细信息：

```shell
kubectl get pod resize-demo --output=yaml --namespace=qos-example
```

你会看到表明问题的变更：

* `spec.containers[0].resources` 反映了**期望**状态（`cpu: "1000"`）。
* Pod 添加了一个 `type: PodResizePending` 和 `reason: Infeasible` 的条件。
* 状况的 `message` 会解释原因（`Node didn't have enough capacity: cpu, requested: 800000, capacity: ...`）
* 重要的是，`status.containerStatuses[0].resources` **仍然显示之前的值**（`cpu: 800m`，`memory: 300Mi`），
  因为不可行的调整未被 kubelet 应用。
* 由于这次失败的尝试，`restartCount` 不会发生变化。

要修复这个问题，你需要使用可行的资源值再次对 Pod 进行补丁。

## 清理   {#clean-up}

删除命名空间，从而删除你在此任务中创建的所有 Pod：

```shell
kubectl delete namespace qos-example
```

## ## 接下来

### 对于应用开发人员

* [为容器和 Pod 分配内存资源](/zh-cn/docs/tasks/configure-pod-container/assign-memory-resource/)

* [为容器和 Pod 分配 CPU 资源](/zh-cn/docs/tasks/configure-pod-container/assign-cpu-resource/)

* [分配 Pod 级别的 CPU 和内存资源](/zh-cn/docs/tasks/configure-pod-container/assign-pod-level-resources/)

### 对于集群管理员

* [为名字空间配置默认内存请求和限制](/zh-cn/docs/tasks/administer-cluster/manage-resources/memory-default-namespace/)

* [为名字空间配置默认 CPU 请求和限制](/zh-cn/docs/tasks/administer-cluster/manage-resources/cpu-default-namespace/)

* [为名字空间配置最小和最大内存约束](/zh-cn/docs/tasks/administer-cluster/manage-resources/memory-constraint-namespace/)

* [为名字空间配置最小和最大 CPU 约束](/zh-cn/docs/tasks/administer-cluster/manage-resources/cpu-constraint-namespace/)

* [为名字空间配置内存和 CPU 配额](/zh-cn/docs/tasks/administer-cluster/manage-resources/quota-memory-cpu-namespace/)
