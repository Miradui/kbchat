# 设备插件

功能状态：Kubernetes v1.26，stable。

Kubernetes 提供了一个设备插件框架，你可以用它来将系统硬件资源发布到
kubelet。

供应商可以实现设备插件，由你手动部署或作为 daemonset
来部署，而不必定制 Kubernetes 本身的代码。目标设备包括 GPU、高性能 NIC、FPGA、
InfiniBand 适配器以及其他类似的、可能需要特定于供应商的初始化和设置的计算资源。

## 注册设备插件    {#device-plugin-registration}

`kubelet` 提供了一个 `Registration` 的 gRPC 服务：

```gRPC
service Registration {
	rpc Register(RegisterRequest) returns (Empty) {}
}
```

设备插件可以通过此 gRPC 服务在 kubelet 进行注册。在注册期间，设备插件需要发送下面几样内容：

* 设备插件的 UNIX 套接字。
* 设备插件的 API 版本。
* `ResourceName` 是需要公布的。这里 `ResourceName`
  需要遵循[扩展资源命名方案](/zh-cn/docs/concepts/configuration/manage-resources-containers/#extended-resources)，
  类似于 `vendor-domain/resourcetype`。（比如 NVIDIA GPU 就被公布为 `nvidia.com/gpu`。）

成功注册后，设备插件就向 kubelet 发送它所管理的设备列表，然后 kubelet
负责将这些资源发布到 API 服务器，作为 kubelet 节点状态更新的一部分。

比如，设备插件在 kubelet 中注册了 `hardware-vendor.example/foo`
并报告了节点上的两个运行状况良好的设备后，节点状态将更新以通告该节点已安装 2 个
"Foo" 设备并且是可用的。

然后，用户可以请求设备作为 Pod 规范的一部分，
参见 [Container](/zh-cn/docs/reference/kubernetes-api/workload-resources/pod-v1/#Container)。
请求扩展资源类似于管理请求和限制的方式，
其他资源，有以下区别：

* 扩展资源仅可作为整数资源使用，并且不能被过量使用
* 设备不能在容器之间共享

### 示例 {#example-pod}

假设 Kubernetes 集群正在运行一个设备插件，该插件在一些节点上公布的资源为 `hardware-vendor.example/foo`。
下面就是一个 Pod 示例，请求此资源以运行一个工作负载的示例：

```yaml
---
apiVersion: v1
kind: Pod
metadata:
  name: demo-pod
spec:
  containers:
    - name: demo-container-1
      image: registry.k8s.io/pause:3.8
      resources:
        limits:
          hardware-vendor.example/foo: 2
#
# 这个 Pod 需要两个 hardware-vendor.example/foo 设备
# 而且只能够调度到满足需求的节点上
#
# 如果该节点中有 2 个以上的设备可用，其余的可供其他 Pod 使用
```

## 设备插件的实现    {#device-plugin-implementation}

设备插件的常规工作流程包括以下几个步骤：

1. 初始化。在这个阶段，设备插件将执行特定于供应商的初始化和设置，以确保设备处于就绪状态。

2. 插件启动一个 gRPC 服务，该服务使用主机路径
   `/var/lib/kubelet/device-plugins/` 下的 UNIX 套接字
   （此路径是硬编码的，不受 kubelet 的 `--root-dir` 或其他配置的影响），
   并实现了以下接口：

   
   ```gRPC
   service DevicePlugin {
         // GetDevicePluginOptions 返回与设备管理器沟通的选项。
         rpc GetDevicePluginOptions(Empty) returns (DevicePluginOptions) {}

         // ListAndWatch 返回 Device 列表构成的数据流。
         // 当 Device 状态发生变化或者 Device 消失时，ListAndWatch
         // 会返回新的列表。
         rpc ListAndWatch(Empty) returns (stream ListAndWatchResponse) {}

         // Allocate 在容器创建期间调用，这样设备插件可以运行一些特定于设备的操作，
         // 并告诉 kubelet 如何令 Device 可在容器中访问的所需执行的具体步骤
         rpc Allocate(AllocateRequest) returns (AllocateResponse) {}

         // GetPreferredAllocation 从一组可用的设备中返回一些优选的设备用来分配，
         // 所返回的优选分配结果不一定会是设备管理器的最终分配方案。
         // 此接口的设计仅是为了让设备管理器能够在可能的情况下做出更有意义的决定。
         rpc GetPreferredAllocation(PreferredAllocationRequest) returns (PreferredAllocationResponse) {}

         // PreStartContainer 在设备插件注册阶段根据需要被调用，调用发生在容器启动之前。
         // 在将设备提供给容器使用之前，设备插件可以运行一些诸如重置设备之类的特定于
         // 具体设备的操作，
         rpc PreStartContainer(PreStartContainerRequest) returns (PreStartContainerResponse) {}
   }
   ```

   

**说明：**

   
   插件并非必须为 `GetPreferredAllocation()` 或 `PreStartContainer()` 提供有用的实现逻辑，
   调用 `GetDevicePluginOptions()` 时所返回的 `DevicePluginOptions`
   消息中应该设置一些标志，表明这些调用（如果有）是否可用。`kubelet` 在直接调用这些函数之前，总会调用
   `GetDevicePluginOptions()` 来查看哪些可选的函数可用。
   

3. 插件通过位于主机路径 `/var/lib/kubelet/device-plugins/kubelet.sock` 下的 UNIX
   套接字向 kubelet 注册自身。

   

**说明：**

   
   工作流程的顺序很重要。插件必须在向 kubelet 注册自己之前开始提供 gRPC 服务，才能保证注册成功。
   

4. 成功注册自身后，设备插件将以提供服务的模式运行，在此期间，它将持续监控设备运行状况，
   并在设备状态发生任何变化时向 kubelet 报告。它还负责响应 `Allocate` gRPC 请求。
   在 `Allocate` 期间，设备插件可能还会做一些特定于设备的准备；例如 GPU 清理或 QRNG 初始化。
   如果操作成功，则设备插件将返回 `AllocateResponse`，其中包含用于访问被分配的设备容器运行时的配置。
   kubelet 将此信息传递到容器运行时。

   
   `AllocateResponse` 包含零个或多个 `ContainerAllocateResponse` 对象。
   设备插件在这些对象中给出为了访问设备而必须对容器定义所进行的修改。
   这些修改包括：

   
   * [注解](/zh-cn/docs/concepts/overview/working-with-objects/annotations/)
   * 设备节点
   * 环境变量
   * 挂载点
   * 完全限定的 CDI 设备名称

   

**说明：**

   
   设备管理器处理完全限定的 CDI 设备名称时，
   需要为 kubelet 和 kube-apiserver 启用 `DevicePluginCDIDevices`
   [特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/)。
   在 Kubernetes v1.28 版本中作为 Alpha 特性被加入，在 v1.29 版本中升级为 Beta 特性并在
   v1.31 版本升级为稳定可用特性。
   

### 处理 kubelet 重启   {#handling-kubelet-restarts}

设备插件应能监测到 kubelet 重启，并且向新的 kubelet 实例来重新注册自己。
新的 kubelet 实例启动时会删除 `/var/lib/kubelet/device-plugins` （设备插件的硬编码路径）下所有已经存在的 UNIX 套接字。
设备插件需要能够监控到它的 UNIX 套接字被删除，并且当发生此类事件时重新注册自己。

### 设备插件和不健康的设备

有时会发生设备出现故障或者被关闭的情况，这时，设备插件的职责是使用
`ListAndWatch Response` API 将相关情况通报给 kubelet。

一旦设备被标记为不健康，kubelet 将减少节点上此资源的可分配数量，
以反映有多少设备可用于调度新的 Pod，资源的容量数量不会因此发生改变。

分配给故障设备的 Pod 将继续分配给该设备。
通常情况下，依赖于设备的代码将开始失败，如果 Pod 的 `restartPolicy` 不是
`Always`，则 Pod 可能会进入 Failed 阶段，否则会进入崩溃循环。

在 Kubernetes v1.31 之前，要知道 Pod 是否与故障设备关联，
可以使用 [PodResources API](#monitoring-device-plugin-resources)。

功能状态：ResourceHealthStatus，Kubernetes 1.36，beta；首次引入于 1.31。默认启用。

当 `ResourceHealthStatus` 特性门控被启用（自 v1.36 起为 Beta 版并默认启用）时，
`allocatedResourcesStatus` 字段将添加到每个容器状态中，位于每个 Pod 的 `.status` 内。
`allocatedResourcesStatus` 字段报告分配给容器的每个设备的健康信息。
每个资源健康状况条目都可以包含一个可选的“message”字段，其中包含有关健康状况的更多易于理解的上下文信息，
如错误详情或故障原因。

对于发生故障的 Pod，或者你怀疑存在故障的情况，你可以使用此状态来了解
Pod 行为是否可能与设备故障有关。例如，如果加速器报告过热事件，
则 `allocatedResourcesStatus` 字段能够报告此情况。

## 设备插件部署   {#device-plugin-deployment}

你可以将你的设备插件作为节点操作系统的软件包来部署、作为 DaemonSet 来部署或者手动部署。

规范目录 `/var/lib/kubelet/device-plugins`（在 kubelet 中硬编码）是需要特权访问的，
所以设备插件必须要在被授权的安全的上下文中运行。
如果你将设备插件部署为 DaemonSet，`/var/lib/kubelet/device-plugins` 目录必须要在插件的
[PodSpec](/docs/reference/generated/kubernetes-api/v1.37/#podspec-v1-core)
中声明作为 volume 被挂载到插件中。

如果你选择 DaemonSet 方法，你可以通过 Kubernetes 进行以下操作：
将设备插件的 Pod 放置在节点上，在出现故障后重新启动守护进程 Pod，来进行自动升级。

## API 兼容性   {#api-compatibility}

之前版本控制方案要求设备插件的 API 版本与 kubelet 的版本完全匹配。
自从此特性在 v1.12 中进阶为 Beta 后，这不再是硬性要求。
API 是版本化的，并且自此特性进阶 Beta 后一直表现稳定。
因此，kubelet 升级应该是无缝的，但在稳定之前 API 仍然可能会有变更，还不能保证升级不会中断。

**说明：**

尽管 Kubernetes 的设备管理器（Device Manager）组件是正式发布的特性，
但**设备插件 API** 还不稳定。有关设备插件 API 和版本兼容性的信息，
请参阅[设备插件 API 版本](/zh-cn/docs/reference/node/device-plugin-api-versions/)。

作为一个项目，Kubernetes 建议设备插件开发者：

* 注意未来版本中设备插件 API 的变更。
* 支持多个版本的设备插件 API，以实现向后/向前兼容性。

若在需要升级到具有较新设备插件 API 版本的某个 Kubernetes 版本的节点上运行这些设备插件，
请在升级这些节点之前先升级设备插件以支持这两个版本。
采用该方法将确保升级期间设备分配的连续运行。

## 监控设备插件资源   {#monitoring-device-plugin-resources}

功能状态：Kubernetes v1.28，stable。

为了监控设备插件提供的资源，监控代理程序需要能够发现节点上正在使用的设备，
并获取元数据来描述哪个指标与容器相关联。
设备监控代理暴露给 [Prometheus](https://prometheus.io/) 的指标应该遵循
[Kubernetes Instrumentation Guidelines（英文）](https://github.com/kubernetes/community/blob/main/contributors/devel/sig-instrumentation/metric-instrumentation.md)，
使用 `pod`、`namespace` 和 `container` 标签来标识容器。

kubelet 提供了 gRPC 服务来使得正在使用中的设备被发现，并且还为这些设备提供了元数据：

```gRPC
// PodResourcesLister 是一个由 kubelet 提供的服务，用来提供供节点上
// Pod 和容器使用的节点资源的信息
service PodResourcesLister {
    rpc List(ListPodResourcesRequest) returns (ListPodResourcesResponse) {}
    rpc GetAllocatableResources(AllocatableResourcesRequest) returns (AllocatableResourcesResponse) {}
    rpc Get(GetPodResourcesRequest) returns (GetPodResourcesResponse) {}
}
```

### `List` gRPC 端点 {#grpc-endpoint-list}

这一 `List` 端点提供运行中 Pod 的资源信息，包括类似独占式分配的
CPU ID、设备插件所报告的设备 ID 以及这些设备分配所处的 NUMA 节点 ID。
此外，对于基于 NUMA 的机器，它还会包含为容器保留的内存和大页的信息。

从 Kubernetes v1.27 开始，`List` 端点可以通过 `DynamicResourceAllocation` API 提供在
`ResourceClaims` 中分配的当前运行 Pod 的资源信息。
从 Kubernetes v1.34 开始，此特性默认启用。

```gRPC
// ListPodResourcesResponse 是 List 函数的响应
message ListPodResourcesResponse {
    repeated PodResources pod_resources = 1;
}

// PodResources 包含关于分配给 Pod 的节点资源的信息
message PodResources {
    string name = 1;
    string namespace = 2;
    repeated ContainerResources containers = 3;
}

// ContainerResources 包含分配给容器的资源的信息
message ContainerResources {
    string name = 1;
    repeated ContainerDevices devices = 2;
    repeated int64 cpu_ids = 3;
    repeated ContainerMemory memory = 4;
    repeated DynamicResource dynamic_resources = 5;
}

// ContainerMemory 包含分配给容器的内存和大页信息
message ContainerMemory {
    string memory_type = 1;
    uint64 size = 2;
    TopologyInfo topology = 3;
}

// Topology 描述资源的硬件拓扑结构
message TopologyInfo {
        repeated NUMANode nodes = 1;
}

// NUMA 代表的是 NUMA 节点
message NUMANode {
        int64 ID = 1;
}

// ContainerDevices 包含分配给容器的设备信息
message ContainerDevices {
    string resource_name = 1;
    repeated string device_ids = 2;
    TopologyInfo topology = 3;
}

// DynamicResource 包含通过 Dynamic Resource Allocation 分配到容器的设备信息
message DynamicResource {
    string class_name = 1;
    string claim_name = 2;
    string claim_namespace = 3;
    repeated ClaimResource claim_resources = 4;
}

// ClaimResource 包含每个插件的资源信息
message ClaimResource {
    repeated CDIDevice cdi_devices = 1 [(gogoproto.customname) = "CDIDevices"];
}

// CDIDevice 指定 CDI 设备信息
message CDIDevice {
    // 完全合格的 CDI 设备名称
    // 例如：vendor.com/gpu=gpudevice1
    // 参阅 CDI 规范中的更多细节：
    // https://github.com/container-orchestrated-devices/container-device-interface/blob/main/SPEC.md
    string name = 1;
}
```

**说明：**

`List` 端点中的 `ContainerResources` 中的 cpu_ids 对应于分配给某个容器的专属 CPU。
如果要统计共享池中的 CPU，`List` 端点需要与 `GetAllocatableResources` 端点一起使用，如下所述：

1. 调用 `GetAllocatableResources` 获取所有可用的 CPU。
2. 在系统中所有的 `ContainerResources` 上调用 `GetCpuIds`。
3. 用 `GetAllocatableResources` 获取的 CPU 数减去 `GetCpuIds` 获取的 CPU 数。

### `GetAllocatableResources` gRPC 端点 {#grpc-endpoint-getallocatableresources}

功能状态：Kubernetes v1.28，stable。

端点 `GetAllocatableResources` 提供工作节点上原始可用的资源信息。
此端点所提供的信息比导出给 API 服务器的信息更丰富。

**说明：**

`GetAllocatableResources` 应该仅被用于评估一个节点上的[可分配的](/zh-cn/docs/tasks/administer-cluster/reserve-compute-resources/#node-allocatable)资源。
如果目标是评估空闲/未分配的资源，此调用应该与 `List()` 端点一起使用。
除非暴露给 kubelet 的底层资源发生变化，否则 `GetAllocatableResources` 得到的结果将保持不变。
这种情况很少发生，但当发生时（例如：热插拔，设备健康状况改变），客户端应该调用 `GetAllocatableResources` 端点。

然而，调用 `GetAllocatableResources` 端点在 CPU、内存被更新的情况下是不够的，
kubelet 需要重新启动以获取正确的资源容量和可分配的资源。

```gRPC
// AllocatableResourcesResponses 包含 kubelet 所了解到的所有设备的信息
message AllocatableResourcesResponse {
    repeated ContainerDevices devices = 1;
    repeated int64 cpu_ids = 2;
    repeated ContainerMemory memory = 3;
}
```

`ContainerDevices` 会向外提供各个设备所隶属的 NUMA 单元这类拓扑信息。
NUMA 单元通过一个整数 ID 来标识，其取值与设备插件所报告的一致。
[设备插件注册到 kubelet 时](/zh-cn/docs/concepts/extend-kubernetes/compute-storage-net/device-plugins/)
会报告这类信息。

gRPC 服务通过 kubelet 根目录（通常为 `/var/lib/kubelet/pod-resources/kubelet.sock`）
下的 Unix 套接字 `pod-resources/kubelet.sock` 提供。
设备插件资源的监控代理程序可以部署为守护进程或者 DaemonSet。
位于 kubelet 根目录（通常为 `/var/lib/kubelet/pod-resources`）下的标准
`pod-resources` 目录需要特权访问权限。
所以监控代理程序必须要在获得授权的安全的上下文中运行。
如果设备监控代理以 DaemonSet 形式运行，必须要在插件的
[PodSpec](/docs/reference/generated/kubernetes-api/v1.37/#podspec-v1-core)
中声明将 `pod-resources`
目录以卷的形式被挂载到设备监控代理中。

**说明：**

在从 DaemonSet 或以容器形式部署在主机上的任何其他应用中访问
`pod-resources/kubelet.sock` 时，
如果将套接字作为卷挂载，最好的做法是挂载目录 `pod-resources`
而不是 socket 文件本身。
这样可以确保在 kubelet 重新启动后，容器将能够重新连接到此套接字。

在典型的 Linux 节点上，这意味着挂载 `/var/lib/kubelet/pod-resources/`，
而不是 `/var/lib/kubelet/pod-resources/kubelet.sock`。

容器挂载是通过引用套接字或目录的 inode 进行管理的，具体取决于挂载的内容。
当 kubelet 重新启动时，套接字会被删除并创建一个新的套接字，而目录则保持不变。
因此，针对原始套接字的 inode 将变得无法使用，而到目录的 inode 将继续正常工作。

### `Get` gRPC 端点   {#grpc-endpoint-get}

功能状态：Kubernetes v1.34，beta。

`Get` 端点提供了当前运行 Pod 的资源信息。它会暴露与 `List` 端点中所述类似的信息。
`Get` 端点需要当前运行 Pod 的 `PodName` 和 `PodNamespace`。

```gRPC
// GetPodResourcesRequest 包含 Pod 相关信息
message GetPodResourcesRequest {
    string pod_name = 1;
    string pod_namespace = 2;
}
```

`Get` 端点可以提供与动态资源分配 API 所分配的动态资源相关的 Pod 信息。
从 Kubernetes v1.34 开始，此特性已默认启用。

## 设备插件与拓扑管理器的集成   {#device-plugin-integration-with-the-topology-manager}

功能状态：Kubernetes v1.27，stable。

拓扑管理器是 kubelet 的一个组件，它允许以拓扑对齐方式来调度资源。
为了做到这一点，设备插件 API 进行了扩展来包括一个 `TopologyInfo` 结构体。

```gRPC
message TopologyInfo {
    repeated NUMANode nodes = 1;
}

message NUMANode {
    int64 ID = 1;
}
```

设备插件希望拓扑管理器可以将填充的 TopologyInfo 结构体作为设备注册的一部分以及设备 ID
和设备的运行状况发送回去。然后设备管理器将使用此信息来咨询拓扑管理器并做出资源分配决策。

`TopologyInfo` 支持将 `nodes` 字段设置为 `nil` 或一个 NUMA 节点的列表。
这样就可以使设备插件通告跨越多个 NUMA 节点的设备。

将 `TopologyInfo` 设置为 `nil` 或为给定设备提供一个空的
NUMA 节点列表表示设备插件没有该设备的 NUMA 亲和偏好。

下面是一个由设备插件为设备填充 `TopologyInfo` 结构体的示例：

```
pluginapi.Device{ID: "25102017", Health: pluginapi.Healthy, Topology:&pluginapi.TopologyInfo{Nodes: []*pluginapi.NUMANode{&pluginapi.NUMANode{ID: 0,},}}}
```

## 设备插件示例 {#examples}

本部分链接到提供 Kubernetes 所需功能的第三方项目。Kubernetes 项目作者不负责这些项目。此页面遵循[CNCF 网站指南](https://github.com/cncf/foundation/blob/main/policies-guidance/website-guidelines.md)，按字母顺序列出项目。要将项目添加到此列表中，请在提交更改之前阅读[内容指南](/zh-cn/docs/contribute/style/content-guide/#third-party-content)。

下面是一些设备插件实现的示例：

* [Akri](https://github.com/project-akri/akri)，它可以让你轻松公开异构叶子设备（例如 IP 摄像机和 USB 设备）。
* [AMD GPU 设备插件](https://github.com/ROCm/k8s-device-plugin)
* 适用于通用 Linux 设备和 USB 设备的[通用设备插件](https://github.com/squat/generic-device-plugin)
* 用于异构 AI 计算虚拟化中间件（例如 NVIDIA、Cambricon、Hygon、Iluvatar、MThreads、Ascend、Metax 设备）的
  [HAMi](https://github.com/Project-HAMi/HAMi)
* [Intel 设备插件](https://github.com/intel/intel-device-plugins-for-kubernetes)支持
  Intel GPU、FPGA、QAT、VPU、SGX、DSA、DLB 和 IAA 设备
* [KubeVirt 设备插件](https://github.com/kubevirt/kubernetes-device-plugins)用于硬件辅助的虚拟化
* [NVIDIA GPU 设备插件](https://github.com/NVIDIA/k8s-device-plugin)NVIDIA 的官方设备插件，
  用于公布 NVIDIA GPU 和监控 GPU 健康状态。
* [为 Container-Optimized OS 所提供的 NVIDIA GPU 设备插件](https://github.com/GoogleCloudPlatform/container-engine-accelerators/tree/master/cmd/nvidia_gpu)
* [RDMA 设备插件](https://github.com/hustcat/k8s-rdma-device-plugin)
* [SocketCAN 设备插件](https://github.com/collabora/k8s-socketcan)
* [Solarflare 设备插件](https://github.com/vikaschoudhary16/sfc-device-plugin)
* [SR-IOV 网络设备插件](https://github.com/intel/sriov-network-device-plugin)
* [Xilinx FPGA 设备插件](https://github.com/Xilinx/FPGA_as_a_Service/tree/master/k8s-device-plugin)

## ## 接下来

* 查看[调度 GPU 资源](/zh-cn/docs/tasks/manage-gpus/scheduling-gpus/)来学习使用设备插件
* 查看在节点上如何[公布扩展资源](/zh-cn/docs/tasks/administer-cluster/extended-resource-node/)
* 学习[拓扑管理器](/zh-cn/docs/tasks/administer-cluster/topology-manager/)
* 阅读如何在 Kubernetes 中使用 [TLS Ingress 的硬件加速](/zh-cn/blog/2019/04/24/hardware-accelerated-ssl/tls-termination-in-ingress-controllers-using-kubernetes-device-plugins-and-runtimeclass/)
* 阅读更多关于[使用 DRA 分配扩展资源](/zh-cn/docs/concepts/scheduling-eviction/dynamic-resource-allocation/#extended-resource)
