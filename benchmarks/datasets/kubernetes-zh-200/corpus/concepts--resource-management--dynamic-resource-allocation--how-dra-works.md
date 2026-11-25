# DRA 的工作原理

本页介绍 Kubernetes 如何通过动态资源分配（DRA）为工作负载分配设备，
以及预先调度的 Pod 如何与该流程交互。

## 如何使用 DRA 进行资源分配 {#how-it-works}

以下各节描述了各种
[DRA 用户类型](/zh-cn/docs/concepts/resource-management/dynamic-resource-allocation/#dra-user-types)的工作流，
以及 Kubernetes 系统在动态资源分配过程中的工作流。

### 用户的工作流 {#user-workflow}

1. **驱动创建：** 设备所有者或第三方实体创建驱动，
   这些驱动能够在集群中创建和管理 ResourceSlice。
   这些驱动还可以选择性地创建 DeviceClass，
   用于定义设备的类别以及如何请求它们。

2. **集群配置：** 集群管理员创建集群、将设备附加到节点并安装 DRA 设备驱动。
   集群管理员还可以选择性地创建 DeviceClass，
   用于定义设备的类别以及如何请求它们。

3. **资源申领：** 工作负载运维人员创建 ResourceClaimTemplate 或 ResourceClaim，
   在 DeviceClass 中请求特定设备配置。在同一阶段，
   工作负载运维人员修改其 Kubernetes 清单以请求这些
   ResourceClaimTemplate 或 ResourceClaim。

### Kubernetes 的工作流 {#kubernetes-workflow}

1. **ResourceSlice 创建：** 集群中的驱动创建 ResourceSlice，
   用于表示被管理的同类设备池中一个或多个设备。

2. **工作负载创建：** 集群控制平面检查新工作负载中是否引用了
   ResourceClaimTemplate 或特定的 ResourceClaim。

   
   *  如果工作负载使用 ResourceClaimTemplate，名为 `resourceclaim-controller`
      的控制器会为该工作负载生成 ResourceClaim。
   *  如果工作负载使用特定的 ResourceClaim，Kubernetes 会检查该
      ResourceClaim 在集群中是否存在。如果 ResourceClaim 不存在，
      Pod 将无法部署。

3. **ResourceSlice 过滤：** 对于每个 Pod，Kubernetes 检查集群中的 ResourceSlice，
   以找到满足以下所有条件的设备：

   * 可以访问这些资源的节点有资格运行该 Pod。
   * ResourceSlice 具有与 Pod 的 ResourceClaim 需求匹配的未分配资源。

4. **资源分配：** 在为 Pod 的 ResourceClaim 找到合格的 ResourceSlice 后，
   Kubernetes 调度器使用分配详情更新 ResourceClaim。
   调度器使用最先适应（first-fit）策略，并按池和 ResourceSlice 的名称字典序对其进行评估。
   驱动可以通过适当的命名为特定的 slice 或池设置优先级。详细信息请参阅
   [命名与优先级](/zh-cn/docs/concepts/resource-management/dynamic-resource-allocation/dra-api/#resourceslice-naming-and-prioritization)。

5. **Pod 调度：** 资源分配完成后，调度器将 Pod 放置在可以访问所分配资源的节点上。
   该节点上的设备驱动和 `kubelet` 通过 gRPC 协调以配置设备和 Pod
   对设备的访问权限，除非驱动为不需要节点本地制备或清理的设备声明了
   [可选的节点操作](/zh-cn/docs/concepts/resource-management/dynamic-resource-allocation/dra-features/#optional-node-operations)。

## 预先调度的 Pod

当你（或另一个 API 客户端）创建 Pod 时，如果 `spec.nodeName` 已经被设置，
调度器将被绕开。如果该 Pod 所需的某个 ResourceClaim 尚不存在、尚未分配或未为该 Pod
保留，那么 kubelet 将无法运行该 Pod，并会周期性地重新检查，
因为这些需求可能稍后仍会被满足。

当 Pod 被调度时调度器中尚未启用动态资源分配支持时（版本偏差、配置、特性门控等），
也可能出现这种情况。
kube-controller-manager 会检测到此情况，并通过保留所需的 ResourceClaim
尝试使 Pod 变为可运行状态。但是，这仅在这些 ResourceClaim 已被调度器为其他某个 Pod 分配时才有效。

最好避免绕开调度器，因为被分配到节点的 Pod 在挂起期间会阻塞常规资源（RAM、CPU），
使其无法被其他 Pod 使用。若要让 Pod 在特定节点上运行，
同时仍经过正常的调度流程，请为 Pod 创建一个与目标节点精确匹配的节点选择算符：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: pod-with-cats
spec:
  nodeSelector:
    kubernetes.io/hostname: name-of-the-intended-node
  ...
```

你也可以在准入阶段变更进入系统的 Pod，取消 `.spec.nodeName` 字段的设置，
改为使用节点选择算符。

## 设备绑定条件

功能状态：DRADeviceBindingConditions，Kubernetes 1.36，beta；首次引入于 1.34。默认启用。

设备绑定条件（Device Binding Conditions）允许 Kubernetes 调度器延迟 Pod 绑定，
直到外部资源（例如通过交换架构连接的 GPU 或可重新编程的 FPGA）被确认就绪为止。

这种等待行为在调度框架的
[PreBind 阶段](/zh-cn/docs/concepts/scheduling-eviction/scheduling-framework/#pre-bind)中实现。
在此阶段，调度器在继续绑定之前会检查所有必需的设备条件是否均已满足。

这通过避免过早绑定提高了调度的可靠性，并支持与外部设备控制器的协调。

要使用此特性，设备驱动（通常由驱动所有者管理）必须在 `ResourceSlice` 的
`Device` 部分发布以下字段。集群管理员必须启用 `DRADeviceBindingConditions` 和
`DRAResourceClaimDeviceStatus` 特性门控，调度器才会遵循这些字段。

`bindingConditions`
: 在 Pod 可以被绑定之前必须被设置为 True
  （位于关联 ResourceClaim 的 `.status.conditions` 字段中）的**条件类型**列表。
  这些条件通常表示就绪信号，例如 DeviceAttached（设备已挂接）或
  DeviceInitialized（设备已初始化）。

`bindingFailureConditions`
: 条件类型列表，若在关联 ResourceClaim 的 `status.conditions` 字段中被设置为 True，
  则表示失败状态。如果其中任意条件为 True，调度器将中止绑定并重新调度该 Pod。

`bindsToNode`
: 若设置为 `true`，调度器会在 ResourceClaim 的
  `status.allocation.nodeSelector` 字段中记录所选中的节点名称。
  这不会影响 Pod 的 `spec.nodeSelector`。相反，
  它会在 ResourceClaim 内部设置一个节点选择算符，
  外部控制器可以使用它来执行节点特定的操作，例如设备挂接或制备。

bindingConditions 和 bindingFailureConditions 中列出的所有条件类型
都根据 ResourceClaim 的 `status.conditions` 字段进行评估。
外部控制器负责使用标准 Kubernetes
条件语义（`type`、`status`、`reason`、`message`、`lastTransitionTime`）更新这些条件。

调度器最多等待 **600 秒**（默认值），以等待所有 `bindingConditions` 变为 `True`。
如果达到超时或任何 `bindingFailureConditions` 为 `True`，
调度器会清除分配并重新调度该 Pod。集群管理员可以通过编辑 kube-scheduler
配置文件来配置此超时时间。

以下给出了在 `KubeSchedulerConfiguration` 中配置此超时的示例：

```yaml
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
- schedulerName: default-scheduler
  pluginConfig:
  - name: DynamicResources
    args:
      apiVersion: kubescheduler.config.k8s.io/v1
      kind: DynamicResourcesArgs
      bindingTimeout: 60s
```

### 示例 {#device-binding-conditions-example}

以下是你可能在集群中看到的一个 ResourceSlice 示例，
该集群中正在使用某个 DRA 驱动，并且该驱动支持绑定条件：

```yaml
apiVersion: resource.k8s.io/v1
kind: ResourceSlice
metadata:
  name: gpu-slice-1
spec:
  driver: dra.example.com
  nodeSelector:
    nodeSelectorTerms:
    - matchExpressions:
      - key: accelerator-type
        operator: In
        values:
        - "high-performance"
  pool:
    name: gpu-pool
    generation: 1
    resourceSliceCount: 1
  devices:
    - name: gpu-1
      attributes:
        vendor:
          string: "example"
        model:
          string: "example-gpu"
      bindsToNode: true
      bindingConditions:
        - dra.example.com/is-prepared
      bindingFailureConditions:
        - dra.example.com/preparing-failed
```

该示例 ResourceSlice 具有以下属性：

- ResourceSlice 目标为带有 `accelerator-type=high-performance` 标签的节点，
  因此调度器仅使用特定的一组合格节点。

- 调度器从所选组中选择一个节点（例如 `node-3`），并将 ResourceClaim 中的
  `status.allocation.nodeSelector` 字段设置为该节点名称。

- `dra.example.com/is-prepared` 绑定条件指示设备 `gpu-1` 必须被制备
  （`is-prepared` 条件的状态为 `True`）后才能绑定。

- 如果 `gpu-1` 设备制备失败（`preparing-failed` 条件状态为 `True`），
  调度器会中止绑定。

- 调度器最多等待 600 秒（默认值），等待设备准备就绪。

- 外部控制器可以使用 ResourceClaim 中的节点选择算符，在选定的节点上执行节点特定的设置。

设备绑定条件由 `kube-apiserver` 和 `kube-scheduler` 中的
[`DRADeviceBindingConditions` 特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/#DRADeviceBindingConditions)控制。

## 节点可分配资源 {#node-allocatable-resources}

功能状态：DRANodeAllocatableResources，Kubernetes 1.36，alpha；首次引入于 1.36。默认禁用。使用前需配置相应特性门控。

由 DRA 管理的设备可能具有由节点可分配资源（如 `cpu`、`memory` 或 `hugepages`）
构成的底层占用。此特性将这些基于 DRA 的请求与常规 Pod `spec`
中对这些资源的请求一起整合到调度器的标准核算中。

DRA 驱动使用两种不同的模型来定义设备如何消耗节点可分配资源：

* **直接资源映射（`mapping`）：** DRA 设备直接提供标准节点资源
  （例如自定义 CPU 核心池或内存块）。申领分配直接映射到节点上的标准 CPU 或内存容量。

* **辅助设备开销（`overhead`）：** DRA 设备（例如 GPU 或加速器）在被分配给
  Pod 或容器时，需要主机资源（例如主机 RAM）作为辅助开销才能运行。

### Pod 编写者的注意事项

在使用申领为这些类型的设备编写 PodSpec 时，需要注意以下几点：

* 当使用 Pod 级资源时，调度器会同时针对容器的 requests 和 limits 对其进行严格验证：

  * 所有容器 requests 与 DRA 申领资源的总和不得超过 Pod 级 requests；
    否则该 Pod 将无法调度。
  * 每个单独容器的 limit 加上其 DRA 分配不得超过 Pod 级 limits；
    否则该 Pod 将无法调度。

* 容器的总资源需求等于其容器级资源与其关联资源申领中的任何节点可分配资源之和。

* **申领共享限制：** 使用直接资源映射（`mapping`）的申领不能在多个 Pod 之间共享。
  带有 `overhead` 的设备申领支持设备共享，且开销按每个 Pod 或每个容器追踪。

* 带有 DRA 申领的 Pod 支持对 `spec` 中的标准 requests 进行就地调整大小。
  调度器确保调整后的标准 requests 与静态 DRA 分配结合后仍然能适配节点。

### DRA 驱动编写者的细节

DRA 驱动使用 ResourceSlice 中设备上的 `nodeAllocatableResources` 字段
来声明此节点可分配资源占用。
它定义了将请求的 DRA 设备或容量转换为在节点的 `status.allocatable`
中追踪的标准资源的映射（注意，此字段不支持扩展资源）。
这对于直接暴露原生资源的驱动（例如 CPU 或内存 DRA 驱动）
和需要辅助节点依赖的设备（例如需要主机内存的加速器）都非常有用。

`nodeAllocatableResources` 字段支持两种不同的使用场景：

* **映射（Mapping）：** 当 DRA 设备直接代表标准资源时使用
  （例如 CPU 或内存 DRA 驱动）。调度器通过使用 `capacityMultiplier` 缩放容量，
  或使用 `deviceMultiplier` 缩放设备数量来计算精确的数量。

* **开销（Overhead）：** 当设备需要辅助节点依赖时使用
 （例如 GPU 消耗的主机内存）。这可以定义为固定的 `perPod` 成本，
  或定义为随引用容器数量线性缩放的可变 `perContainer` 成本。

#### 示例：CPU DRA 驱动（映射 Mapping）

以下示例中，CPU DRA 驱动使用 [DRA 可消耗容量](#consumable-capacity)将一个
CPU 插槽作为 128 个 CPU 的池暴露出来。`capacityKey` 将消耗的
`cpu.example.com/cpu` 容量直接链接到节点的标准 `cpu` 可分配资源：

```yaml
apiVersion: resource.k8s.io/v1
kind: ResourceSlice
metadata:
  name: my-node-cpus
spec:
  driver: cpu.example.com
  nodeName: my-node
  pool:
    name: socket-cpus
    generation: 1
    resourceSliceCount: 1
  devices:
  - name: socket0cpus
    allowMultipleAllocations: true
    capacity:
      "cpu.example.com/cpu": "128"
    nodeAllocatableResources:
      mapping:
        cpu:
          capacityKey: "cpu.example.com/cpu"
  - name: socket1cpus
    allowMultipleAllocations: true
    capacity:
      "cpu.example.com/cpu": "128"
    nodeAllocatableResources:
      mapping:
        cpu:
          capacityKey: "cpu.example.com/cpu"
          capacityMultiplier: 1
```

#### 示例：带辅助资源的加速器（Overhead）

以下资源切片示例中，一台加速器每个 Pod 需要额外 8Gi 的内存才能运行：

```yaml
apiVersion: resource.k8s.io/v1
kind: ResourceSlice
metadata:
  name: my-node-xpus
spec:
  driver: xpu.example.com
  nodeName: my-node
  pool:
    name: xpu-pool
    generation: 1
    resourceSliceCount: 1
  devices:
  - name: xpu-model-x-001
    attributes:
      example.com/model:
        string: "model-x"
    nodeAllocatableResources:
      overhead:
        memory:
          perPod: "8Gi"
```

在 Pod 成功绑定到节点后，通过 DRA 分配的精确节点可分配资源数量会由
`kube-scheduler` 聚合，并直接嵌入到 Pod 的
`status.nodeAllocatableResourceClaimStatuses` 字段中。
这提供了从调度器到 `kubelet` 的清晰、持久的交接。

关键是，`kubelet` 原生地消费此 API 来完美对齐系统级边界：

- **cgroups：** Pod 和容器的 cgroups 现在将包含基于 DRA 的分配，
  防止工作负载被内核人为地节流。
- **OOM Scores：** `kubelet` 将容器的 DRA 内存 requests 计算到其有效内存请求中。

节点可分配资源是一个 Alpha 特性，当在 `kube-apiserver`、`kube-scheduler` 和
`kubelet` 中启用 [`DRANodeAllocatableResources` 特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/#DRANodeAllocatableResources)
时即启用。
