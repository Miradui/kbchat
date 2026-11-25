# 节点压力驱逐

节点压力驱逐是 kubelet 主动终止 Pod 以回收节点上资源的过程。</br>

kubelet
监控集群节点的内存、磁盘空间和文件系统的 inode 等资源。
当这些资源中的一个或者多个达到特定的消耗水平，
kubelet 可以主动地使节点上一个或者多个 Pod 失效，以回收资源防止饥饿。

在节点压力驱逐期间，kubelet 将所选 Pod
的[阶段](/zh-cn/docs/concepts/workloads/pods/pod-lifecycle/#pod-phase)设置为
`Failed` 并终止 Pod。

节点压力驱逐不同于 [API 发起的驱逐](/zh-cn/docs/concepts/scheduling-eviction/api-eviction/)。

kubelet 并不理会你配置的 PodDisruptionBudget
或者是 Pod 的 `terminationGracePeriodSeconds`。
如果你使用了[软驱逐条件](#soft-eviction-thresholds)，kubelet 会考虑你所配置的
`eviction-max-pod-grace-period`。
如果你使用了[硬驱逐条件](#hard-eviction-thresholds)，kubelet 使用 `0s`
宽限期（立即关闭）来终止 Pod。

## 自我修复行为   {#self-healing-behavior}

kubelet 在终止最终用户 Pod 之前会尝试[回收节点级资源](#reclaim-node-resources)。
例如，它会在磁盘资源不足时删除未使用的容器镜像。

如果 Pod 是由替换失败 Pod 的工作负载资源
（例如 StatefulSet
或者 Deployment）管理，
则控制平面或 `kube-controller-manager` 会创建新的 Pod 来代替被驱逐的 Pod。

### 静态 Pod 的自我修复   {#self-healing-for-static-pods}

如果你在面临资源压力的节点上运行静态 Pod，则 kubelet 可能会驱逐该静态 Pod。
由于静态 Pod 始终表示在该节点上运行 Pod 的意图，kubelet 会尝试创建替代 Pod。

创建替代 Pod 时，kubelet 会考虑静态 Pod 的**优先级**。如果静态 Pod 清单指定了低优先级，
并且集群的控制平面内定义了优先级更高的 Pod，并且节点面临资源压力，则 kubelet
可能无法为该静态 Pod 腾出空间。
即使节点上存在资源压力，kubelet 也会继续尝试运行所有静态 Pod。

## 驱逐信号和阈值  {#eviction-signals-and-thresholds}

kubelet 使用各种参数来做出驱逐决定，如下所示：

- 驱逐信号
- 驱逐条件
- 监控间隔

### 驱逐信号 {#eviction-signals}

驱逐信号是特定资源在特定时间点的当前状态。
kubelet 使用驱逐信号，通过将信号与驱逐条件进行比较来做出驱逐决定，
驱逐条件是节点上应该可用资源的最小量。

kubelet 使用以下驱逐信号：

| 驱逐信号                  | 描述                                                                                  | 仅限于 Linux |
|--------------------------|---------------------------------------------------------------------------------------|------------|
| `memory.available`       | `memory.available` := `node.status.capacity[memory]` - `node.stats.memory.workingSet` |            |
| `nodefs.available`       | `nodefs.available` := `node.stats.fs.available`                                       |            |
| `nodefs.inodesFree`      | `nodefs.inodesFree` := `node.stats.fs.inodesFree`                                     |      •     |
| `imagefs.available`      | `imagefs.available` := `node.stats.runtime.imagefs.available`                         |            |
| `imagefs.inodesFree`     | `imagefs.inodesFree` := `node.stats.runtime.imagefs.inodesFree`                       |      •     |
| `containerfs.available`  | `containerfs.available` := `node.stats.runtime.containerfs.available`                 |            |
| `containerfs.inodesFree` | `containerfs.inodesFree` := `node.stats.runtime.containerfs.inodesFree`               |      •     |
| `pid.available`          | `pid.available` := `node.stats.rlimit.maxpid` - `node.stats.rlimit.curproc`           |      •     |

在上表中，**描述**列显示了 kubelet 如何获取信号的值。每个信号支持百分比值或者是字面值。
kubelet 计算相对于与信号有关的总量的百分比值。

#### 内存信号 {#memory-signals}

在 Linux 节点上，`memory.available` 的值来自 CGroupFs，而不是像 `free -m` 这样的工具。
这很重要，因为 `free -m` 在容器中不起作用，
如果用户使用[节点可分配资源](/zh-cn/docs/tasks/administer-cluster/reserve-compute-resources/#node-allocatable)这一功能特性，
资源不足的判定是基于 CGroup 层次结构中的用户 Pod 所处的局部及 CGroup 根节点作出的。
这个[脚本](/zh-cn/examples/admin/resource/memory-available.sh)或者
[CGroupv2 脚本](/zh-cn/examples/admin/resource/memory-available-cgroupv2.sh)重现了
kubelet 为计算 `memory.available` 而执行的相同步骤。
kubelet 在其计算中排除了 inactive_file（非活动 LRU 列表上基于文件来虚拟的内存的字节数），
因为它假定在压力下内存是可回收的。

**说明：**

功能状态：HugepageAwareEviction，Kubernetes 1.37，beta；首次引入于 1.37。默认启用。

在配置了 [HugePage](/zh-cn/docs/tasks/manage-hugepages/scheduling-hugepages/)
的节点上，kubelet 会从驱逐管理器所使用的 `memory.available` 中减去该节点的
HugePage 总容量。如果不做此调整，由于内存 CGroup 控制器不会将 hugetlb 分配计入其工作集，
被 HugePage 预留的内存会虚增 `AvailableBytes`。这会延迟驱逐并导致 OOM 终止。
要恢复原先行为，可以禁用 `HugepageAwareEviction`
[特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/)。

在 Windows 节点上，`memory.available` 的值来自节点的全局内存提交级别
（通过 [`GetPerformanceInfo()`](https://learn.microsoft.com/windows/win32/api/psapi/nf-psapi-getperformanceinfo)
系统调用查询），方法是从节点的
[`CommitLimit`](https://learn.microsoft.com/windows/win32/api/psapi/ns-psapi-performance_information)
减去节点的全局 [`CommitTotal`](https://learn.microsoft.com/windows/win32/api/psapi/ns-psapi-performance_information)。
请注意，如果节点的页面文件大小发生变化，`CommitLimit` 也会发生变化！

#### 文件系统信号 {#filesystem-signals}

kubelet 可识别三个可与驱逐信号一起使用的特定文件系统标识符（`<identifier>.inodesFree` 或
`<identifier>.available`）：

1. `nodefs`：节点的主文件系统，用于本地磁盘卷、
   非内存介质的 `emptyDir` 卷、日志存储、临时存储等。
   例如，`nodefs` 包含 `/var/lib/kubelet`。

2. `imagefs`：可供容器运行时存储容器镜像（只读层）。如果没有单独的
   `containerfs`，镜像文件系统也会存储容器可写层。

3. `containerfs`：可供容器运行时存储可写层的可选文件系统。
   使用 `containerfs` 时，可以将 `imagefs` 文件系统拆分为仅存储镜像（只读层），
   而不存储其他任何内容。

这些标识符描述了 kubelet 观察到的文件系统。
它们并不总是代表三个不同的挂载点：在常见的布局中，
两个或全部三个标识符可能指向同一个底层文件系统。

**说明：**

**分割镜像文件系统**特性增加了新的驱逐信号、阈值和 `containerfs` 的指标。
要使用 `containerfs`，Kubernetes 发行版 v1.37
需要启用 `KubeletSeparateDiskGC`
[特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/)。
对于 Kubernetes v1.37，
只有 CRI-O（v1.29 或更高版本）提供 `containerfs` 文件系统支持。

kubelet 支持三种常见的容器文件系统布局：

- 所有内容都位于单个 `nodefs` 上，也称为 `rootfs` 或简称为 `root`。
  在这种布局中，`nodefs`、`imagefs` 和 `containerfs` 都指向同一个底层文件系统。

- 容器运行时存储位于专用磁盘上，与根文件系统分离。在这种布局中，`imagefs` 和 `containerfs`
  指向相同的底层文件系统，该文件系统同时存储镜像层和容器可写层。
  这通常被称为“分割磁盘”（或“独立磁盘”）文件系统。

- 容器可写层位于 `nodefs` 上，而容器镜像（只读层）则存储在独立的 `imagefs` 上。在这种布局中，
  `containerfs` 和 `nodefs` 指向相同的底层文件系统。这通常被称为“分割镜像”文件系统。

kubelet 将尝试直接从底层容器运行时自动发现这些文件系统及其当前配置，
并忽略其他本地节点文件系统。

kubelet 不支持其他容器文件系统或存储配置，并且目前不支持为镜像和容器提供多个文件系统。

### 弃用的 kubelet 垃圾收集功能 {#deprecated-kubelet-garbage-collection-features}

一些 kubelet 垃圾收集功能已被弃用，以鼓励使用驱逐机制。

| 现有标志                                   | 原因                                  |
| ----------------------------------------- | ------------------------------------ |
| `--maximum-dead-containers`               | 一旦旧的日志存储在容器的上下文之外就会被弃用 |
| `--maximum-dead-containers-per-container` | 一旦旧的日志存储在容器的上下文之外就会被弃用 |
| `--minimum-container-ttl-duration`        | 一旦旧的日志存储在容器的上下文之外就会被弃用 |

### 驱逐条件 {#eviction-thresholds}

你可以为 kubelet 指定自定义驱逐条件，以便在作出驱逐决定时使用。
你可以设置[软性的](#soft-eviction-thresholds)和[硬性的](#hard-eviction-thresholds)驱逐阈值。

驱逐条件的形式为 `[eviction-signal][operator][quantity]`，其中：

- `eviction-signal` 是要使用的[驱逐信号](#eviction-signals)。
- `operator` 是你想要的[关系运算符](https://en.wikipedia.org/wiki/Relational_operator#Standard_relational_operators)，
  比如 `<`（小于）。
- `quantity` 是驱逐条件数量，例如 `1Gi`。
  `quantity` 的值必须与 Kubernetes 使用的数量表示相匹配。
  你可以使用文字值或百分比（`%`）。

例如，如果一个节点的总内存为 10GiB 并且你希望在可用内存低于 1GiB 时触发驱逐，
则可以将驱逐条件定义为 `memory.available<10%` 或
`memory.available<1Gi`（你不能同时使用二者）。

你可以配置软和硬驱逐条件。

#### 软驱逐条件 {#soft-eviction-thresholds}

软驱逐条件将驱逐条件与管理员所必须指定的宽限期配对。
在超过宽限期之前，kubelet 不会驱逐 Pod。
如果没有指定的宽限期，kubelet 会在启动时返回错误。

你可以既指定软驱逐条件宽限期，又指定 Pod 终止宽限期的上限，给 kubelet 在驱逐期间使用。
如果你指定了宽限期的上限并且 Pod 满足软驱逐阈条件，则 kubelet 将使用两个宽限期中的较小者。
如果你没有指定宽限期上限，kubelet 会立即杀死被驱逐的 Pod，不允许其体面终止。

你可以使用以下标志来配置软驱逐条件：

- `eviction-soft`：一组驱逐条件，如 `memory.available<1.5Gi`，
  如果驱逐条件持续时长超过指定的宽限期，可以触发 Pod 驱逐。
- `eviction-soft-grace-period`：一组驱逐宽限期，
  如 `memory.available=1m30s`，定义软驱逐条件在触发 Pod 驱逐之前必须保持多长时间。
- `eviction-max-pod-grace-period`：在满足软驱逐条件而终止 Pod
  时使用的最大允许宽限期（以秒为单位）。

#### 硬驱逐条件 {#hard-eviction-thresholds}

硬驱逐条件没有宽限期。当达到硬驱逐条件时，
kubelet 会立即杀死 Pod，而不会正常终止以回收紧缺的资源。

你可以使用 `eviction-hard` 标志来配置一组硬驱逐条件，
例如 `memory.available<1Gi`。

kubelet 具有以下默认硬驱逐条件：

- `memory.available<100Mi`（Linux 节点）
- `nodefs.available<10%`（Windows 节点）
- `imagefs.available<15%`
- `nodefs.inodesFree<5%`（Linux 节点）
- `imagefs.inodesFree<5%` (Linux 节点)

只有在没有更改任何参数的情况下，硬驱逐阈值才会被设置成这些默认值。
如果你更改了任何参数的值，则其他参数的取值不会继承其默认值设置，而将被设置为零。
为了提供自定义值，你应该分别设置所有阈值。
你也可以在 kubelet 配置文件中设置 `mergeDefaultEvictionSettings` 为 `true`。
如果该值设为 `true`，并且某个参数被修改，则其他参数将继承其默认值，而不是被设为 0。

`containerfs.available` 和 `containerfs.inodesFree`（Linux 节点）默认驱逐阈值将被设置如下：

- 如果 `containerfs` 和 `nodefs` 指的是同一个底层文件系统，那么
  `containerfs` 的阈值设置与 `nodefs` 相同。

- 如果 `containerfs` 和 `imagefs` 指的是同一个底层文件系统，那么
  `containerfs` 的阈值设置与 `imagefs` 相同。

不支持为与 `containerfs` 相关的阈值设置自定义覆盖值，如果尝试这样做，将会发出警告；
任何提供的自定义值都将被忽略。

## 驱逐监测间隔   {#eviction-monitoring-interval}

kubelet 根据其配置的 `housekeeping-interval`（默认为 `10s`）评估驱逐条件。

## 节点状况 {#node-conditions}

kubelet 报告[节点状况](/zh-cn/docs/concepts/architecture/nodes/#condition)以反映节点处于压力之下，
原因是满足硬性的或软性的驱逐条件，与配置的宽限期无关。

kubelet 根据下表将驱逐信号映射为节点状况：

| 节点状况 | 驱逐信号 | 描述 |
|---------|--------|------|
| `MemoryPressure` | `memory.available` | 节点上的可用内存已满足驱逐条件 |
| `DiskPressure`   | `nodefs.available`、`nodefs.inodesFree`、`imagefs.available`、`imagefs.inodesFree`、`containerfs.available` 或 `containerfs.inodesFree` | 节点的根文件系统、镜像文件系统或容器文件系统上的可用磁盘空间和 inode 已满足驱逐阈值 |
| `PIDPressure`    | `pid.available` | （Linux）节点上的可用进程标识符已低于驱逐条件 |

控制平面还将这些节点状况[映射](/zh-cn/docs/concepts/scheduling-eviction/taint-and-toleration/#taint-nodes-by-condition)为其污点。

kubelet 根据配置的 `--node-status-update-frequency` 更新节点状况，默认为 `10s`。

### 节点状况波动   {#node-condition-oscillation}

在某些情况下，节点在软驱逐条件上下振荡，而没有保持定义的宽限期。
这会导致报告的节点状况在 `true` 和 `false` 之间不断切换，从而导致错误的驱逐决策。

为了防止振荡，你可以使用 `eviction-pressure-transition-period` 标志，
该标志控制 kubelet 在将节点状况转换为不同状态之前必须等待的时间。
过渡期的默认值为 `5m`。

### 回收节点级资源 {#reclaim-node-resources}

kubelet 在驱逐最终用户 Pod 之前会先尝试回收节点级资源。

当报告 `DiskPressure` 节点状况时，kubelet 会根据节点上的文件系统回收节点级资源。

#### 没有 `imagefs` 或 `containerfs` {#without-imagefs-or-containerfs}

如果节点只有一个 `nodefs` 文件系统且该文件系统达到驱逐阈值，
kubelet 将按以下顺序释放磁盘空间：

1. 对已死亡的 Pod 和容器执行垃圾收集操作。

1. 删除未使用的镜像。

#### 有 `imagefs`

如果节点有一个专用的 `imagefs` 文件系统供容器运行时使用，kubelet 会执行以下操作：

- 如果 `nodefs` 文件系统满足驱逐条件，kubelet 垃圾收集死亡 Pod 和容器。
- 如果 `imagefs` 文件系统满足驱逐条件，kubelet 将删除所有未使用的镜像。

#### 有 `imagefs` 和 `containerfs` {#with-imagefs-and-containerfs}

如果节点除了 `imagefs` 文件系统之外还配置了专用的 `containerfs` 以供容器运行时使用，
则 kubelet 将尝试按如下方式回收资源：

- 如果 `containerfs` 文件系统满足驱逐阈值，则 kubelet 将垃圾收集死机的 Pod 和容器。

- 如果 `imagefs` 文件系统满足驱逐阈值，则 kubelet 将删除所有未使用的镜像。

### kubelet 驱逐时 Pod 的选择

如果 kubelet 回收节点级资源的尝试没有使驱逐信号低于条件，
则 kubelet 开始驱逐最终用户 Pod。

kubelet 使用以下参数来确定 Pod 驱逐顺序：

1. Pod 的资源使用是否超过其请求
1. [Pod 优先级](/zh-cn/docs/concepts/scheduling-eviction/pod-priority-preemption/)
1. Pod 相对于请求的资源使用情况

因此，kubelet 按以下顺序排列和驱逐 Pod：

1. 首先考虑资源使用量超过其请求的 `BestEffort` 或 `Burstable` Pod。
   这些 Pod 会根据它们的优先级以及它们的资源使用级别超过其请求的程度被逐出。
1. 资源使用量少于请求量的 `Guaranteed` Pod 和 `Burstable` Pod 根据其优先级被最后驱逐。

**说明：**

kubelet 不使用 Pod 的 [QoS 类](/zh-cn/docs/concepts/workloads/pods/pod-qos/)来确定驱逐顺序。
在回收内存等资源时，你可以使用 QoS 类来估计最可能的 Pod 驱逐顺序。
QoS 分类不适用于临时存储（EphemeralStorage）请求，
因此如果节点在 `DiskPressure` 下，则上述场景将不适用。

仅当 `Guaranteed` Pod 中所有容器都被指定了请求和限制并且二者相等时，才保证 Pod 不被驱逐。
这些 Pod 永远不会因为另一个 Pod 的资源消耗而被驱逐。
如果系统守护进程（例如 `kubelet` 和 `journald`）
消耗的资源比通过 `system-reserved` 或 `kube-reserved` 分配保留的资源多，
并且该节点只有 `Guaranteed` 或 `Burstable` Pod 使用的资源少于其上剩余的请求，
那么 kubelet 必须选择驱逐这些 Pod 中的一个以保持节点稳定性并减少资源匮乏对其他 Pod 的影响。
在这种情况下，它会选择首先驱逐最低优先级的 Pod。

如果你正在运行[静态 Pod](/zh-cn/docs/concepts/workloads/pods/#static-pods)
并且希望避免其在资源压力下被驱逐，请直接为该 Pod 设置 `priority` 字段。
静态 Pod 不支持 `priorityClassName` 字段。

当 kubelet 因 inode 或 进程 ID 不足而驱逐 Pod 时，
它使用 Pod 的相对优先级来确定驱逐顺序，因为 inode 和 PID 没有对应的请求字段。

kubelet 根据节点是否具有专用的 `imagefs` 文件系统或者 `containerfs`
文件系统对 Pod 进行不同的排序：

#### 没有 `imagefs` 或 `containerfs`（`nodefs` 和 `imagefs` 使用相同的文件系统）{#without-imagefs}

- 如果 `nodefs` 触发驱逐，kubelet 将根据 Pod
  的总磁盘使用量（`本地卷 + 日志和所有容器的可写层`）对 Pod 进行排序。

#### 有 `imagefs`（`nodefs` 和 `imagefs` 文件系统是独立的）{#with-imagefs}

- 如果 `nodefs` 触发驱逐，kubelet 将根据 `nodefs`
  使用量（`本地卷 + 所有容器的日志`）对 Pod 进行排序。

- 如果 `imagefs` 触发驱逐，kubelet 将根据所有容器的可写层用量对 Pod 进行排序。

#### 有 `imagefs` 和 `containerfs`（`imagefs` 和 `containerfs` 已拆分）{#with-containersfs}

- 如果 `containerfs` 触发驱逐，kubelet 将根据
  `containerfs` 使用情况（`本地卷 + 日志和所有容器的可写层`）对 Pod 进行排序。

- 如果 `imagefs` 触发驱逐，kubelet
  将根据`镜像存储`用量对 Pod 进行排序，该用量表示给定镜像的磁盘使用情况。

### 最小驱逐回收 {#minimum-eviction-reclaim}

**说明：**

在 Kubernetes v1.37 中，你无法为
`containerfs.available` 指标设置自定义值。
此特定指标的配置将自动设置为反映为 `nodefs` 或 `imagefs` 设置的值，具体取决于配置。

在某些情况下，驱逐 Pod 只会回收少量的紧俏资源。
这可能导致 kubelet 反复达到配置的驱逐条件并触发多次驱逐。

你可以使用 `--eviction-minimum-reclaim` 标志或
[kubelet 配置文件](/zh-cn/docs/tasks/administer-cluster/kubelet-config-file/)为每个资源配置最小回收量。
当 kubelet 注意到某个资源耗尽时，它会继续回收该资源，直到回收到你所指定的数量为止。

例如，以下配置设置最小回收量：

```yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
evictionHard:
  memory.available: "500Mi"
  nodefs.available: "1Gi"
  imagefs.available: "100Gi"
evictionMinimumReclaim:
  memory.available: "0Mi"
  nodefs.available: "500Mi"
  imagefs.available: "2Gi"
```

在这个例子中，如果 `nodefs.available` 信号满足驱逐条件，
kubelet 会回收资源，直到信号达到 1GiB 的条件，
然后继续回收至少 500MiB 直到信号达到 1.5GiB。

类似地，kubelet 尝试回收 `imagefs` 资源，直到 `imagefs.available` 值达到 `102Gi`，
即 102 GiB 的可用容器镜像存储。如果 kubelet 可以回收的存储量小于 2GiB，
则 kubelet 不会回收任何内容。

对于所有资源，默认的 `eviction-minimum-reclaim` 为 `0`。

## 节点内存不足行为   {#node-out-of-memory-behavior}

如果节点在 kubelet 能够回收内存之前遇到**内存不足**（OOM）事件，
则节点依赖 [oom_killer](https://lwn.net/Articles/391222/) 来响应。

kubelet 根据 Pod 的服务质量（QoS）为每个容器设置一个 `oom_score_adj` 值。

| 服务质量            | `oom_score_adj`                                                                        |
|--------------------|---------------------------------------------------------------------------------------|
| `Guaranteed`       | -997                                                                                  |
| `BestEffort`       | 1000                                                                                  |
| `Burstable`        | **min(max(2, 1000 - (1000 * memoryRequestBytes) / machineMemoryCapacityBytes), 999)** |

**说明：**

kubelet 还将具有 `system-node-critical`
优先级的任何
Pod 中的容器 `oom_score_adj` 值设为 `-997`。

如果 kubelet 在节点遇到 OOM 之前无法回收内存，
则 `oom_killer` 根据它在节点上使用的内存百分比计算 `oom_score`，
然后加上 `oom_score_adj` 得到每个容器有效的 `oom_score`。
然后它会杀死得分最高的容器。

这意味着低 QoS Pod 中相对于其调度请求消耗内存较多的容器，将首先被杀死。

与 Pod 驱逐不同，如果容器被 OOM 杀死，
kubelet 可以根据其 `restartPolicy` 重新启动它。

## 良好实践 {#node-pressure-eviction-good-practices}

以下各小节阐述驱逐配置的好的做法。

#### 可调度的资源和驱逐策略

当你为 kubelet 配置驱逐策略时，
你应该确保调度程序不会在 Pod 触发驱逐时对其进行调度，因为这类 Pod 会立即引起内存压力。

考虑以下场景：

* 节点内存容量：10GiB
* 操作员希望为系统守护进程（内核、`kubelet` 等）保留 10% 的内存容量
* 操作员希望在节点内存利用率达到 95% 以上时驱逐 Pod，以减少系统 OOM 的概率。

为此，kubelet 启动设置如下：

```none
--eviction-hard=memory.available<500Mi
--system-reserved=memory=1.5Gi
```

在此配置中，`--system-reserved` 标志为系统预留了 1GiB 的内存，
即 `总内存的 10% + 驱逐条件量`。

如果 Pod 使用的内存超过其请求值或者系统使用的内存超过 `1Gi`，
则节点可以达到驱逐条件，这使得 `memory.available` 信号低于 500MiB 并触发条件。

### DaemonSet 和节点压力驱逐  {#daemonset}

Pod 优先级是做出驱逐决定的主要因素。
如果你不希望 kubelet 驱逐属于 DaemonSet 的 Pod，
请在 Pod 规约中通过指定合适的 `priorityClassName` 为这些 Pod
提供足够高的 `priorityClass`。
你还可以使用较低优先级或默认优先级，以便仅在有足够资源时才运行 `DaemonSet` Pod。

## 已知问题   {#known-issues}

以下部分描述了与资源不足处理相关的已知问题。

#### kubelet 可能不会立即观察到内存压力

默认情况下，kubelet 轮询 cAdvisor 以定期收集内存使用情况统计信息。
如果该轮询时间窗口内内存使用量迅速增加，kubelet 可能无法足够快地观察到 `MemoryPressure`，
但是 OOM killer 仍将被调用。

你可以使用 `--kernel-memcg-notification`
标志在 kubelet 上启用 `memcg` 通知 API，以便在超过条件时立即收到通知。

如果你不是追求极端利用率，而是要采取合理的过量使用措施，
则解决此问题的可行方法是使用 `--kube-reserved` 和 `--system-reserved` 标志为系统分配内存。

### active_file 内存未被视为可用内存

在 Linux 上，内核跟踪活动最近最少使用（LRU）列表上的基于文件所虚拟的内存字节数作为 `active_file` 统计信息。
kubelet 将 `active_file` 内存区域视为不可回收。
对于大量使用块设备形式的本地存储（包括临时本地存储）的工作负载，
文件和块数据的内核级缓存意味着许多最近访问的缓存页面可能被计为 `active_file`。
如果这些内核块缓冲区中在活动 LRU 列表上有足够多，
kubelet 很容易将其视为资源用量过量并为节点设置内存压力污点，从而触发 Pod 驱逐。

更多细节请参见
[https://github.com/kubernetes/kubernetes/issues/43916](https://github.com/kubernetes/kubernetes/issues/43916)。

你可以通过为可能执行 I/O 密集型活动的容器设置相同的内存限制和内存请求来应对该行为。
你将需要估计或测量该容器的最佳内存限制值。

## ## 接下来

- 了解 [API 发起的驱逐](/zh-cn/docs/concepts/scheduling-eviction/api-eviction/)
- 了解 [Pod 优先级和抢占](/zh-cn/docs/concepts/scheduling-eviction/pod-priority-preemption/)
- 了解 [PodDisruptionBudget](/zh-cn/docs/tasks/run-application/configure-pdb/)
- 了解[服务质量](/zh-cn/docs/tasks/configure-pod-container/quality-service-pod/)（QoS）
- 查看[驱逐 API](/docs/reference/generated/kubernetes-api/v1.37/#create-eviction-pod-v1-core)
