# 交换内存管理

你可以配置 Kubernetes 在节点上使用交换内存，
让内核可以通过把页面换出到后备存储来释放物理内存。这在多种使用场景下都很有用。
例如，节点上运行的工作负载可以从使用交换内存中受益，比如那些内存占用很大但在任一时刻只访问其中一部分内存的工作负载。
它还有助于防止 Pod 在内存用量激增期间被终止，使节点免受可能危及自身稳定性的系统级内存激增影响，
让节点上的内存管理更加灵活，等等。

要了解如何在集群中配置交换内存，
请阅读[在 Kubernetes 节点上配置交换内存](/zh-cn/docs/tutorials/cluster-management/provision-swap-memory/)。

## 操作系统支持 {#operating-system-support}

* Linux 节点支持交换内存；你需要配置每个节点来启用它。
  默认情况下，kubelet 在启用了交换内存的 Linux 节点上**不会**启动。
* Windows 节点要求有交换空间。
  默认情况下，kubelet 在禁用了交换空间的 Windows 节点上**不会**启动。

## 此特性如何工作？ {#how-does-it-work}

可以设想在节点上使用交换内存的方式有多种。
如果节点上已经运行着 kubelet，那么在制备好交换内存之后，需要重启 kubelet 才能识别它。

当 kubelet 在已制备并可用交换内存的节点上启动时（配置为 `failSwapOn: false`），kubelet 将：

- 能够在这个启用了交换内存的节点上启动。
- 指示容器运行时接口（Container Runtime Interface，CRI）实现
  （通常称为容器运行时）默认不为 Kubernetes 工作负载分配任何交换内存。

节点上的交换内存配置通过
[KubeletConfiguration 中的 `memorySwap`](/zh-cn/docs/reference/config-api/kubelet-config.v1)
向集群管理员公开。作为集群管理员，你可以通过设置 `memorySwap.swapBehavior`
来指定存在交换内存时节点的行为。

### 交换内存行为 {#swap-behaviors}

你需要选择一种要使用的[交换内存行为](/zh-cn/docs/reference/node/swap-behavior/)。
集群中的不同节点可以使用不同的交换内存行为。

Linux 节点可选的交换内存行为包括：

`NoSwap`（默认）
: 在此节点上作为 Pod 运行的工作负载不会也不能使用交换内存。

`LimitedSwap`
: Kubernetes 工作负载可以使用交换内存。

**说明：**

如果你选择 NoSwap 行为，并将 kubelet 配置为容忍交换空间（`failSwapOn: false`），
那么你的工作负载不会使用任何交换内存。

然而，Kubernetes 所管理的容器之外的进程，例如 systemd 服务（甚至 kubelet 自身！）**可以**利用交换内存。

你可以阅读[在 Kubernetes 节点上配置交换内存](/zh-cn/docs/tutorials/cluster-management/provision-swap-memory/)来了解如何为集群启用交换内存。

### 容器运行时集成 {#container-runtime-integration}

kubelet 使用容器运行时 API，指示容器运行时以能为容器启用所需交换内存配置的方式应用特定配置
（例如，在 cgroup v2 的情况下为 `memory.swap.max`）。对于使用控制组（即 cgroup）的运行时，
容器运行时随后负责将这些设置写入容器级的 cgroup。

## 交换内存使用的可观测性 {#observability-for-swap-use}

### 节点级和容器级指标统计 {#node-and-container-level-metric-statistics}

kubelet 现在会收集节点级和容器级的指标统计信息，
可以通过 `/metrics/resource`（主要由 Prometheus 等监控工具使用）
和 `/stats/summary`（主要由自动扩缩容工具使用）这两个 kubelet HTTP 端点访问。
这让能够直接向 kubelet 发起请求的客户端在使用 `LimitedSwap` 时可以监控交换内存的使用情况和剩余交换内存量。
此外，cadvisor 中还新增了 `machine_swap_bytes` 指标，用于显示机器的物理交换内存总容量。
更多信息请参阅[此页面](/zh-cn/docs/reference/instrumentation/node-metrics/)。

例如，支持以下 `/metrics/resource`：

- `node_swap_usage_bytes`：节点当前的交换内存使用量，单位为字节。
- `container_swap_usage_bytes`：容器当前的交换内存使用量，单位为字节。
- `container_swap_limit_bytes`：容器当前的交换内存限额，单位为字节。

### 使用 `kubectl top --show-swap` {#using-kubectl-top-show-swap}

查询指标很有价值，但略显繁琐，因为这些指标的设计初衷是供软件而非人类使用。
为了以更友好的方式使用这些数据，
`kubectl top` 命令已扩展为支持交换内存指标，可通过 `--show-swap` 标志使用。

要获取节点上交换内存使用情况的信息，可以使用 `kubectl top nodes --show-swap`：

```shell
kubectl top nodes --show-swap
```

输出结果类似于：

```
NAME    CPU(cores)   CPU(%)   MEMORY(bytes)   MEMORY(%)   SWAP(bytes)    SWAP(%)       
node1   1m           10%      2Mi             10%         1Mi            0%   
node2   5m           10%      6Mi             10%         2Mi            0%   
node3   3m           10%      4Mi             10%         <unknown>      <unknown>   
```

要获取各 Pod 的交换内存使用情况信息，可以使用 `kubectl top pods --show-swap`：

```shell
kubectl top pod -n kube-system --show-swap
```

输出结果类似于：

```
NAME                                      CPU(cores)   MEMORY(bytes)   SWAP(bytes)
coredns-58d5bc5cdb-5nbk4                  2m           19Mi            0Mi
coredns-58d5bc5cdb-jsh26                  3m           37Mi            0Mi
etcd-node01                               51m          143Mi           5Mi
kube-apiserver-node01                     98m          824Mi           16Mi
kube-controller-manager-node01            20m          135Mi           9Mi
kube-proxy-ffgs2                          1m           24Mi            0Mi
kube-proxy-fhvwx                          1m           39Mi            0Mi
kube-scheduler-node01                     13m          69Mi            0Mi
metrics-server-8598789fdb-d2kcj           5m           26Mi            0Mi   
```

### 节点在节点状态中报告交换内存容量 {#nodes-to-report-swap-capacity-as-part-of-node-status}

现在新增了一个节点状态字段 `node.status.nodeInfo.swap.capacity`，用于报告节点的交换内存容量。

例如，可以使用以下命令获取集群中各节点的交换内存容量：

```shell
kubectl get nodes -o go-template='{{range .items}}{{.metadata.name}}: {{if .status.nodeInfo.swap.capacity}}{{.status.nodeInfo.swap.capacity}}{{else}}<unknown>{{end}}{{"\n"}}{{end}}'
```

输出结果类似于：

```
node1: 21474836480
node2: 42949664768
node3: <unknown>
```

**说明：**

`<unknown>` 值表示该节点的 `.status.nodeInfo.swap.capacity` 字段未设置。
这通常意味着节点没有制备交换内存；在较小概率下，
也可能是 kubelet 无法确定该节点的交换内存容量。

### 使用 Node Feature Discovery（NFD）发现交换内存 {#node-feature-discovery}

[Node Feature Discovery](https://github.com/kubernetes-sigs/node-feature-discovery)
是一个用于检测硬件特性和配置的 Kubernetes 插件。可以用它来发现哪些节点制备了交换内存。

例如，要找出哪些节点制备了交换内存，请使用以下命令：

```shell
kubectl get nodes -o jsonpath='{range .items[?(@.metadata.labels.feature\.node\.kubernetes\.io/memory-swap)]}{.metadata.name}{"\t"}{.metadata.labels.feature\.node\.kubernetes\.io/memory-swap}{"\n"}{end}'
```

输出结果类似于：

```
k8s-worker1: true
k8s-worker2: true
k8s-worker3: false
```

在此示例中，节点 `k8s-worker1` 和 `k8s-worker2` 制备了交换内存，而 `k8s-worker3` 没有。

## 风险与注意事项 {#risks-and-caveats}

**注意：**

强烈建议对交换空间进行加密。更多信息参阅[内存支持的卷](#memory-backed-volumes)。

系统上可用交换内存会降低可预测性。虽然交换内存可以通过让更多 RAM 可用而提升性能，但把数据换回内存
是一项开销很大的操作，有时会慢上好几个数量级，这可能导致意外的性能回退。

此外，交换内存会改变系统在内存压力下的行为。启用交换内存会增加吵闹的邻居的风险，
经常使用自身 RAM 的 Pod 可能会导致其他 Pod 被换出。
另外，由于交换内存允许 Kubernetes 中的工作负载使用更多无法被可预测地核算的内存，
加上意外的装箱配置，调度器目前不会核算交换内存的使用量。
这进一步加剧了吵闹的邻居的风险。

启用了交换内存的节点，其性能取决于底层物理存储。
在使用交换内存时，与固态硬盘或 NVMe 等更快的存储介质相比，
在每秒 I/O 操作数（IOPS）受限的环境（例如存在 I/O 限流的云虚拟机）中，性能会明显变差。
由于交换内存可能造成 I/O 压力，建议为系统关键的守护进程赋予更高的 I/O 延迟优先级。
请参阅下文的[推荐做法](#good-practice-for-using-swap-in-a-kubernetes-cluster)一节。

### 内存支持的卷 {#memory-backed-volumes}

在 Linux 节点上，由内存支持的卷（例如 [`secret`](/zh-cn/docs/concepts/configuration/secret/)
卷挂载，或带有 `medium: Memory` 的 [`emptyDir`](/zh-cn/docs/concepts/storage/volumes/#emptydir)）
是使用 `tmpfs` 文件系统实现的。这类卷的内容应始终保留在内存中，因此不应被换出到磁盘。
为确保这类卷的内容保留在内存中，使用了 `noswap` tmpfs 选项。

Linux 内核从 6.3 版本开始正式支持 `noswap` 选项（更多信息参见
[Linux 内核版本要求](/zh-cn/docs/reference/node/kernel-version-requirements/#requirements-other)）。
不过，不同的发行版通常也会选择把这个挂载选项向后移植到较旧的 Linux 版本中。

为了验证节点是否支持 `noswap` 选项，kubelet 将执行以下操作：

* 如果内核版本高于 6.3，则假定支持 `noswap` 选项。
* 否则，kubelet 会在启动时尝试以 `noswap` 选项挂载一个临时 tmpfs。
  如果 kubelet 因未知选项而失败，则假定不支持 `noswap`，因而不会使用它。
  kubelet 会打印一条日志，提醒用户内存支持的卷可能会被换出到磁盘。
  如果 kubelet 成功，则删除这个临时 tmpfs 并使用 `noswap` 选项。
  * 如果不支持 `noswap` 选项，kubelet 会打印一条警告日志，然后继续执行。

关于设置交换内存的示例，请参阅[在 Kubernetes 节点上配置交换内存](/zh-cn/docs/tutorials/cluster-management/provision-swap-memory/)。
不过，处理加密交换内存不属于 kubelet 的职责范围；它其实是操作系统配置层面的通用问题，应在该层面解决。
管理员有责任制备加密的交换内存来降低这一风险。

### 驱逐 {#evictions}

为启用了交换内存的节点配置内存驱逐阈值可能很棘手。

在禁用交换内存的情况下，把 kubelet 的驱逐阈值配置为略低于节点的内存容量是合理的。
其理由是，我们希望在节点内存耗尽并调用内存不足（Out Of Memory，OOM）
终止程序之前，Kubernetes 就开始驱逐 Pod；因为 OOM 终止程序并不感知 Kubernetes，
因此它不会考虑 QoS、Pod 优先级或其他 Kubernetes 特有的因素。

启用交换内存后，情况会更复杂。在 Linux 中，`vm.min_free_kbytes`
参数定义了内核开始积极回收内存（包括换出页面）的内存阈值。
如果把 kubelet 的驱逐阈值设置为在内核开始回收内存之前就发生驱逐，
可能会导致工作负载在节点出现内存压力期间始终无法换出。
然而，把驱逐阈值设置得太高又可能导致节点内存耗尽并调用 OOM 终止程序，这同样不理想。

为解决这个问题，建议把 kubelet 的驱逐阈值设置为略低于 `vm.min_free_kbytes` 的值。
这样，节点可以在 kubelet 开始驱逐 Pod 之前就开始交换，让工作负载能够换出未使用的数据，从而避免发生驱逐。
另一方面，由于只是略低，kubelet 很可能会在节点内存耗尽之前就开始驱逐 Pod，从而避免调用 OOM 终止程序。

可以在节点上运行以下命令来确定 `vm.min_free_kbytes` 的值：

```shell
cat /proc/sys/vm/min_free_kbytes
```

### 未使用的交换空间 {#unutilized-swap-space}

在 `LimitedSwap` 行为下，Pod 可用的交换内存量会根据其内存请求相对于节点总内存的比例自动确定
（更多细节请参阅[下文](#how-is-the-swap-limit-being-determined-with-limitedswap)一节）。

这种设计意味着通常会有部分交换内存仍然不能被 Kubernetes 工作负载使用。
例如，由于 Kubernetes 1.37 不允许
Guaranteed QoS 类 中的 Pod 使用交换内存，
与 Guaranteed Pod 的内存请求成比例的那部分交换内存将会闲置，不被 Kubernetes 工作负载使用。

在许多 Pod 都不符合交换条件的情况下，这种行为会带来一定风险。
另一方面，它实际上保留了一部分系统预留的交换内存，可供 Kubernetes 范围之外的进程使用，
例如系统守护进程甚至 kubelet 自身。

## 在 Kubernetes 集群中使用交换内存的良好实践 {#good-practice-for-using-swap-in-a-kubernetes-cluster}

### 为系统关键的守护进程禁用交换内存 {#disable-swap-for-system-critical-daemons}

在测试阶段并根据用户反馈，我们观察到系统关键的守护进程和服务的性能可能会下降。
这意味着系统守护进程（包括 kubelet）的运行速度可能比平时更慢。
如果遇到这一问题，建议把 system 切片的 cgroup 配置为禁止交换（即设置 `memory.swap.max=0`）。

### 为 I/O 延迟保护系统关键的守护进程 {#protect-system-critical-daemons-for-i-o-latency}

交换内存会增加节点上的 I/O 负载。当内存压力导致内核快速地把页面换入换出时，
依赖 I/O 操作的系统关键的守护进程和服务可能会出现性能下降。

为缓解这一问题，建议 systemd 用户从 I/O 延迟的角度优先考虑 system 切片。对于非 systemd 用户，
建议为系统守护进程和进程设置一个专用 cgroup，并以同样的方式优先考虑 I/O 延迟。
这可以通过为 system 切片设置 `io.latency` 来实现，从而赋予它更高的 I/O 优先级。
更多信息请参阅 [cgroup 的文档](https://www.kernel.org/doc/Documentation/admin-guide/cgroup-v2.rst)。

### 交换内存与控制平面节点 {#swap-and-control-plane-nodes}

Kubernetes 项目建议在运行控制平面节点时不配置任何交换空间。
控制平面主要运行 Guaranteed QoS Pod，因此通常可以禁用交换内存。
主要顾虑是控制平面上的关键服务被换出，可能会对性能产生负面影响。

### 使用专用磁盘承载交换内存 {#use-of-a-dedicated-disk-for-swap}

Kubernetes 项目建议，无论何时运行启用了交换内存的节点，都应使用加密的交换内存。
如果交换内存位于某个分区或根文件系统上，工作负载可能会干扰需要写入磁盘的系统进程。
当它们共用同一块磁盘时，进程可能会压垮交换内存，
扰乱 kubelet、容器运行时和 systemd 的 I/O，进而影响其他工作负载。
由于交换空间位于磁盘上，确保磁盘对于预期用例足够快至关重要。
或者，你也可以在单个后备设备的不同映射区域之间配置 I/O 优先级。

### 交换内存感知调度 {#swap-aware-scheduling}

Kubernetes 1.37 不支持在把 Pod 分配到节点时考虑交换内存的使用情况。
调度器通常使用基础设施资源的**请求值**来指导 Pod 的放置，而 Pod 并不会请求交换空间；它们只请求 `memory`。
这意味着调度器在做出调度决策时不会考虑交换内存。虽然我们正在积极处理这一点，但目前尚未实现。

为了让管理员确保 Pod 不会被调度到有交换内存的节点上（除非明确打算使用交换内存），
管理员可以为有可用交换内存的节点添加污点来防止这一问题。
污点将确保容忍交换内存的工作负载在负载较高时不会溢出到没有交换内存的节点上。

### 为获得最佳性能选择存储 {#selecting-storage-for-optimal-performance}

用于交换空间的存储设备对于在高内存使用期间维持系统响应能力至关重要。
机械硬盘（HDD）不适合这项任务，因为其机械特性会引入明显的延迟，导致严重的性能下降和系统抖动。
对于现代性能需求，固态硬盘（SSD）之类的设备可能是承载交换内存的合适选择，
因为其低延迟的电子访问可以将速度下降降到最低。

## 交换内存行为详解 {#swap-behavior-details}

### 如何通过 LimitedSwap 确定交换内存限额？ {#how-is-the-swap-limit-being-determined-with-limitedswap}

交换内存的配置（包括其限制）是一项重大挑战。它不仅容易出现配置错误，而且作为系统级属性，
任何错误配置都可能危及整个节点，而不只是某个特定的工作负载。为降低这一风险并确保节点的健康，
我们实现了带限制自动配置的交换内存。

使用 `LimitedSwap` 时，不属于 Burstable QoS 类别的 Pod（即 `BestEffort`/`Guaranteed` QoS Pod）
被禁止使用交换内存。`BestEffort` QoS Pod 表现出不可预测的内存消耗模式，而且缺少有关其内存使用情况的信息，
因此很难确定安全的交换内存分配量。

相反，`Guaranteed` QoS Pod 通常用于依赖工作负载所指定的精确资源分配、且内存立即可用的应用。
为了维持上述安全和节点健康保证，当 `LimitedSwap` 生效时，这些 Pod 不允许使用交换内存。
此外，高优先级 Pod 也不允许使用交换内存，以确保它们消耗的内存始终驻留在 RAM 中，随时可用。

在详细说明交换内存限额的计算方式之前，有必要先定义以下术语：

* `nodeTotalMemory`：节点上可用的物理内存总量。
* `totalPodsSwapAvailable`：节点上可供 Pod 使用的交换内存总量（部分交换内存可能保留给系统使用）。
* `containerMemoryRequest`：容器的内存请求。

交换内存限额配置为：  
（ `containerMemoryRequest` / `nodeTotalMemory` ）× `totalPodsSwapAvailable`

换句话说，容器能够使用的交换内存量与其内存请求、节点的总物理内存以及节点上可供 Pod
使用的交换内存总量成比例关系。

值得注意的是，对于 Burstable QoS Pod 中的容器，可以通过设置与内存限制相等的内存请求来选择不使用交换内存。
以这种方式配置的容器将无法访问交换内存。

## ## 接下来

- 要了解如何在 Linux 节点上管理交换内存，请阅读
  [在 Kubernetes 节点上配置交换内存](/zh-cn/docs/tutorials/cluster-management/provision-swap-memory/)。
- 你可以查看一篇[关于 Kubernetes 与交换内存的博客文章](/blog/2025/03/25/swap-linux-improvements/)
- 如需背景信息，请参阅最初的 KEP，[KEP-2400](https://github.com/kubernetes/enhancements/tree/master/keps/sig-node/2400-node-swap)，
  及其[设计](https://github.com/kubernetes/enhancements/blob/master/keps/sig-node/2400-node-swap/README.md)。
