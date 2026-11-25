# DRA 特性

本页面针对一些高级用例介绍可选的 DRA 特性。其中一些特性需要 DRA 驱动的支持。
每个特性都注明了其成熟度以及启用该特性的特性门控。

## 可分区设备   {#partitionable-devices}

功能状态：DRAPartitionableDevices，Kubernetes 1.36，beta；首次引入于 1.33。默认启用。

DRA 中表示的设备不一定必须是连接到单台机器的单个单元，也可以是由连接到多台机器的多个设备组成的逻辑设备。
这些设备可能会消耗底层物理设备的重叠资源，这意味着当分配一个逻辑设备时，其他设备将不再可用。

在 ResourceSlice API 中，这表示为命名 CounterSet 的列表，每个 CounterSet 包含一组命名计数器。
这些计数器表示物理设备上可用于通过 DRA 通告的逻辑设备的资源。

逻辑设备可以指定 ConsumesCounters 列表。
每个条目包含对一个 CounterSet 的引用，以及一组命名计数器及其将消耗的数量。
因此，要使设备可分配，被引用的计数器集必须具有足够的数量来满足设备引用的计数器需求。

CounterSet 必须在与设备不同的 ResourceSlice 中指定。
设备可以消耗与其位于同一资源池中的任何 CounterSet 定义的计数器。

以下是两个设备的示例，每个设备从一个具有 8Gi 内存的共享计数器中消耗 6Gi 内存。
因此，在任何时间点只能分配其中一个设备。
调度器会处理这种情况，并且对使用者是透明的，因为 ResourceClaim API 不受影响。

```yaml
apiVersion: resource.k8s.io/v1
kind: ResourceSlice
metadata:
  name: resourceslice-with-countersets
spec:
  nodeName: worker-1
  pool:
    name: pool
    generation: 1
    resourceSliceCount: 2
  driver: dra.example.com
  sharedCounters:
  - name: gpu-1-counters
    counters:
      memory:
        value: 8Gi
---
apiVersion: resource.k8s.io/v1
kind: ResourceSlice
metadata:
  name: resourceslice-with-devices
spec:
  nodeName: worker-1
  pool:
    name: pool
    generation: 1
    resourceSliceCount: 2
  driver: dra.example.com
  devices:
  - name: device-1
    consumesCounters:
    - counterSet: gpu-1-counters
      counters:
        memory:
          value: 6Gi
  - name: device-2
    consumesCounters:
    - counterSet: gpu-1-counters
      counters:
        memory:
          value: 6Gi
```

可分区设备由 `kube-apiserver` 和 `kube-scheduler` 中的
[`DRAPartitionableDevices` 特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/#DRAPartitionableDevices)控制。

## 设备兼容性组   {#device-compatibility-groups}

功能状态：DRADeviceCompatibilityGroups，Kubernetes 1.37，alpha；首次引入于 1.37。默认禁用。使用前需配置相应特性门控。

设备兼容性组允许 DRA 驱动声明哪些分区设备可以在同一物理硬件上共同分配。
如果没有此特性，不兼容的设备组合只有在 kubelet 在节点上准备 Pod 时才会被检测到 —— 这会导致准备失败。
有了兼容性组，调度器会在调度时、任何节点端工作开始之前就拒绝不兼容的组合。

这对于支持互斥操作模式的硬件最为有用。例如，可以在 MIG 模式或 vGPU 模式下运行的 GPU：
处于 MIG 模式的设备和处于 vGPU 模式的设备不能共同分配，因为它们以不兼容的方式消耗重叠的物理资源。
通过声明 `compatibilityGroups`，驱动使此约束对调度器可见。

此特性建立在[可分区设备](#partitionable-devices)的基础之上：
`compatibilityGroups` 字段位于 `device.consumesCounters[]` 条目上，而该条目仅存在于可分区设备中。
`DRADeviceCompatibilityGroups` 和 `DRAPartitionableDevices` 这两个特性门控都必须在
`kube-apiserver` 和 `kube-scheduler` 中启用。

### 工作原理   {#device-compatibility-groups-how-it-works}

驱动为 ResourceSlice 中的每个 `device.consumesCounters[]` 条目定义一个 `compatibilityGroups` 列表。
该列表最多包含 2 个不透明的字符串名称，表示该设备在该特定计数器集上的操作模式或分区类型。

当调度器分配从同一计数器集获取资源的多个设备时，它会计算这些设备的 `compatibilityGroups` 的交集。
只有当该交集非空时 —— 即每个共同分配的设备至少共享一个共同的组名 —— 分配才会成功。
从不同计数器集获取资源的设备永远不会相互比较。

未声明任何组的设备（未设置、为 nil 或为空列表）被视为特殊情况：它只能与同一计数器集上其他没有组的设备共同分配。
它永远不能与声明了一个或多个组的设备共同分配。

此约束适用于在单个调度周期内分配的所有声明：
如果两个声明各自从同一计数器集分配一个设备，则跨声明的组交集也会被强制执行。

### 示例   {#device-compatibility-groups-example}

考虑一个可以在 MIG 模式或 vGPU 模式下运行的 GPU。
驱动发布两个设备，每个设备从同一个 8 GiB 的共享内存计数器中消耗 4 GiB。
仅根据计数器容量，两个设备可以一起分配。每个设备将其操作模式声明为一个兼容性组，从而使两种模式互斥：

```yaml
apiVersion: resource.k8s.io/v1
kind: ResourceSlice
metadata:
  name: gpu-counters
spec:
  nodeName: worker-1
  pool:
    name: gpu-pool
    generation: 1
    resourceSliceCount: 2
  driver: gpu.example.com
  sharedCounters:
  - name: gpu-0-memory
    counters:
      memory:
        value: 8Gi
---
apiVersion: resource.k8s.io/v1
kind: ResourceSlice
metadata:
  name: gpu-devices
spec:
  nodeName: worker-1
  pool:
    name: gpu-pool
    generation: 1
    resourceSliceCount: 2
  driver: gpu.example.com
  devices:
  - name: gpu-0-mig
    consumesCounters:
    - counterSet: gpu-0-memory
      counters:
        memory:
          value: 4Gi
      compatibilityGroups:
      - mig
  - name: gpu-0-vgpu
    consumesCounters:
    - counterSet: gpu-0-memory
      counters:
        memory:
          value: 4Gi
      compatibilityGroups:
      - vgpu
```

在此示例中：

- `gpu-0-mig` 属于 `mig` 组。
- `gpu-0-vgpu` 属于 `vgpu` 组。

如果一个 Pod 或 PodGroup 从该资源池请求两个设备，
调度器会检查所选的两个设备在 `gpu-0-memory` 计数器集上是否共享一个共同的兼容性组。
由于 `{"mig"} ∩ {"vgpu"} = ∅`，该设备对会被拒绝——即使计数器集有足够的内存同时满足两者。
两个请求只能通过来自存在此类设备对的资源池中的两个 MIG 设备（或两个 vGPU 设备）来满足。

### 约束条件   {#device-compatibility-groups-constraints}

- 每个 `consumesCounters[]` 条目最多可以声明 **2** 个组名。
- 组名在单个条目内必须唯一。
- 组名对 Kubernetes 是不透明的；它们仅在发布驱动的资源池内有意义。
- 组按计数器集进行比较：一个计数器集上的组对另一个计数器集的共同分配决策没有影响。

### 版本偏差安全   {#device-compatibility-groups-version-skew}

当 `DRADeviceCompatibilityGroups` 特性门控被禁用时（Alpha 阶段的默认设置），
kube-apiserver 会从任何新的或更新的 ResourceSlice 中剥离 `compatibilityGroups`
字段——除非旧对象已经设置了该字段。
然后，调度器会将任何以前有分组设备的资源池中的设备视为属于不完整的资源池，并完全跳过它们。

只有非空列表才算作设置了该字段：`compatibilityGroups: null` 和 `compatibilityGroups: []`
被视为与省略该字段相同。
带有这些值的设备的行为与没有组的设备完全相同 —— 它们不会导致调度器将资源池视为不完整。

设备兼容性组由 kube-apiserver 和 kube-scheduler 中的
[`DRADeviceCompatibilityGroups` 特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/#DRADeviceCompatibilityGroups)控制。
同时还必须启用
[`DRAPartitionableDevices` 特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/#DRAPartitionableDevices)。

## 可消耗容量   {#consumable-capacity}

功能状态：DRAConsumableCapacity，Kubernetes 1.36，beta；首次引入于 1.34。默认启用。

可消耗容量特性允许多个独立的 ResourceClaim 消耗同一设备，由 Kubernetes 调度器管理每个声明消耗了多少设备容量。
这类似于 Pod 如何共享节点上的资源；ResourceClaim 可以共享设备上的资源。

设备驱动可以设置 `ResourceSlice` 的 `.spec.devices` 中新增的 `allowMultipleAllocations` 字段，
以允许将该设备分配给多个独立的 ResourceClaim 或一个 ResourceClaim 内的多个请求。

用户可以设置 `ResourceClaim` 的 `spec.devices.requests` 中新增的 `capacity` 字段，以指定每次分配的设备资源需求。

对于允许多次分配的设备，所请求的容量从其总容量中提取（即消耗），这一概念被称为**可消耗容量**。
然后，调度器确保所有声明的总消耗容量不超过设备的整体容量。
此外，驱动开发者可以对各个设备容量使用 `requestPolicy` 约束来控制这些容量的消耗方式。
例如，驱动开发者可以指定某个容量只能以 1Gi 的增量消耗。

下面是一个网络设备的示例，该设备允许多次分配并包含可消耗的带宽容量。

```yaml
kind: ResourceSlice
apiVersion: resource.k8s.io/v1
metadata:
  name: resourceslice
spec:
  nodeName: worker-1
  pool:
    name: pool
    generation: 1
    resourceSliceCount: 1
  driver: dra.example.com
  devices:
  - name: eth1
    allowMultipleAllocations: true
    attributes:
      name:
        string: "eth1"
    capacity:
      bandwidth:
        requestPolicy:
          default: "1M"
          validRange:
            min: "1M"
            step: "8"
        value: "10G"
```

可消耗容量的请求方式如下例所示。

```yaml
apiVersion: resource.k8s.io/v1
kind: ResourceClaimTemplate
metadata:
  name: bandwidth-claim-template
spec:
  spec:
    devices:
      requests:
      - name: req-0
        exactly:
          deviceClassName: resource.example.com
          capacity:
            requests:
              bandwidth: 1G
```

分配结果将包含已消耗的容量和共享标识符。

```yaml
apiVersion: resource.k8s.io/v1
kind: ResourceClaim
...
status:
  allocation:
    devices:
      results:
      - consumedCapacity:
          bandwidth: 1G
        device: eth1
        shareID: "a671734a-e8e5-11e4-8fde-42010af09327"
```

在本例中，选择了一个可多次分配的设备。
然而，任何至少具有所请求 1G 带宽的 `resource.example.com` 设备都可以满足该需求。
如果选择了不可多次分配的设备，则分配将占用整个设备。
要强制只使用可多次分配的设备，可以使用 CEL 条件 `device.allowMultipleAllocations == true`。

### DistinctAttribute 约束   {#distinctattribute-constraint}

在一个 ResourceClaim 中请求多个设备时，你可以使用 DistinctAttribute
约束来确保每个已分配设备在指定属性上具有不同的值。此约束是随可消耗容量特性一起引入的。

DistinctAttribute 约束在处理可多次分配的设备时特别有用。
它可以防止调度器在单个 ResourceClaim 内多次分配同一设备，即使该设备允许多次分配也是如此。

除了防止重复分配外，此约束还有助于通过确保设备根据其属性分布来优化性能。
例如，你可以使用它在不同的 NUMA 节点间分布设备，以优化内存带宽并减少争用。

## 细粒度状态授权   {#granular-status-authorization}

功能状态：DRAResourceClaimGranularStatusAuthorization，Kubernetes 1.36，beta；首次引入于 1.36。默认启用。

从 Kubernetes v1.36 开始，DRA 通过使用合成子资源和节点感知动词，对 `ResourceClaim` 状态的更新实施细粒度的授权检查。

有关安全加固指南（包括调度器和 DRA 驱动的 RBAC 示例），
请参见[加固指南 - 动态资源分配](/zh-cn/docs/concepts/security/hardening-guide/dynamic-resource-allocation/)。

有关集群管理员的分步操作流程，请参见[在集群中加固动态资源分配](/zh-cn/docs/tasks/administer-cluster/hardening-dra/)。

## 可选节点操作   {#optional-node-operations}

功能状态：DRAOptionalNodeOperations，Kubernetes 1.37，alpha；首次引入于 1.37。默认禁用。使用前需配置相应特性门控。

在动态资源分配（DRA）中，`kubelet` 通过 gRPC 与节点本地驱动协作，
在容器启动前准备已分配的设备（`NodePrepareResources`），并在 Pod 终止时取消准备（`NodeUnprepareResources`）。
虽然这种设置对于 GPU 或 FPGA 等节点本地硬件至关重要，但某些资源完全在控制平面中管理，不需要节点本地设置。

可选节点操作特性允许资源驱动声明可以跳过特定的节点本地 gRPC 操作。
配置后，`kubelet` 会绕过这些设备的驱动查找和 gRPC 调用，从而无需在每个工作节点上部署和维护空的节点本地驱动。

### 驱动配置   {#driver-configuration}

驱动开发者可以在 ResourceSlice 的 `.spec.skipNodeOperations` 中指定 `skipNodeOperations` 字段。
该字段是一个唯一字符串列表，指定要为该切片中所有设备绕过的节点本地操作。

有效值包括：

* `"NodePrepareResources"`：跳过 `NodePrepareResources` gRPC 调用。
  除非同时列出了 `"NodeUnprepareResources"`（或指定了 `"*"`），否则不能指定该值。
  此限制避免了在缺少节点本地插件时 Pod 卡在 Terminating 状态的问题，因为当跳过准备操作时，
  Pod 启动期间不会检查插件。

* `"NodeUnprepareResources"`：跳过 `NodeUnprepareResources` gRPC 调用。

* `"*"`：跳过所有节点本地资源操作。

以下是一个用于控制平面资源的 ResourceSlice 示例，该资源跳过所有节点本地操作：

```yaml
apiVersion: resource.k8s.io/v1
kind: ResourceSlice
metadata:
  name: control-plane-resources
spec:
  nodeName: worker-1
  pool:
    name: central-pool
    generation: 1
    resourceSliceCount: 1
  driver: control-plane.example.com
  skipNodeOperations:
  - "*"
  devices:
  - name: virtual-device-1
```

### 分配结果与执行   {#allocation-result-and-execution}

当 Kubernetes 调度器将设备分配给 ResourceClaim 时，
它会将 `skipNodeOperations` 列表从 ResourceSlice 复制到分配结果中：

```yaml
apiVersion: resource.k8s.io/v1
kind: ResourceClaim
...
status:
  allocation:
    devices:
      results:
      - device: virtual-device-1
        driver: control-plane.example.com
        pool: central-pool
        skipNodeOperations:
        - "*"
```

当 Pod 在节点上运行时，`kubelet` 读取分配结果。
如果 ResourceClaim 中某个给定驱动的所有已分配设备都跳过某项特定操作，
则 `kubelet` 会完全绕过对该驱动的该 gRPC 钩子调用。

### 操作注意事项   {#operational-considerations}

#### 原地驱动更新   {#in-place-driver-updates}

由于 `skipNodeOperations` 设置是在分配时从 ResourceSlice 复制到 ResourceClaim 中的，
因此正在运行的 Pod 和活跃的分配会保留它们被调度时的设置。

如果驱动的节点操作要求被原地更新（例如，从需要节点操作变为跳过节点操作），现有的声明仍将使用之前的配置。
为避免出现问题 —— 例如终止中的 Pod 在等待已停用的节点插件时挂起 ——
集群管理员应在更改驱动的节点操作要求或移除节点本地驱动 DaemonSet
之前，确保该驱动没有活跃的声明存在。

#### 节点声明特性集成   {#node-declared-features-integration}

为了防止 Pod 被调度到 `kubelet` 不支持跳过 DRA 操作的节点上（这会导致 `kubelet` 在等待缺失的节点插件时失败），
该特性与[节点声明特性](/zh-cn/docs/concepts/scheduling-eviction/node-declared-features/)集成。
当 Pod 使用配置了 `skipNodeOperations` 的 ResourceClaim 时，Kubernetes 调度器会在调度 Pod 之前，
验证目标节点是否在其 `.status.declaredFeatures` 中声明了对 `DRAOptionalNodeOperations` 特性的支持。

可选节点操作由 `kube-apiserver`、`kube-scheduler` 和 `kubelet` 中的
[`DRAOptionalNodeOperations`](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/#DRAOptionalNodeOperations)
特性门控控制。
