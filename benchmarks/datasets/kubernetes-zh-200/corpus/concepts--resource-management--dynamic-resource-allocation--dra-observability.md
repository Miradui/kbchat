# 动态资源的可观测性

本页介绍如何观测通过 DRA 动态分配的资源的状态和健康状况。

## 动态资源的可观测性 {#observability-dynamic-resources}

你可以使用以下任一方法检查动态分配的资源的状态：

* [kubelet 设备指标](#monitoring-resources)
* [ResourceClaim 状态](#resourceclaim-device-status)
* [设备健康监控](#device-health-monitoring)

### kubelet 设备指标 {#monitoring-resources}

`PodResourcesLister` kubelet gRPC 服务让你可以监控正在使用的设备。
`DynamicResource` 消息提供特定于动态资源分配的信息，例如设备名称和申领名称。
有关细节请参阅[监控设备插件资源](/zh-cn/docs/concepts/extend-kubernetes/compute-storage-net/device-plugins/#monitoring-device-plugin-resources)。

### ResourceClaim 设备状态 {#resourceclaim-device-status}

功能状态：DRAResourceClaimDeviceStatus，Kubernetes 1.37，stable；首次引入于 1.32。默认启用。

DRA 驱动可以在 ResourceClaim 的 `status.devices` 字段中，
为每个已分配的设备报告驱动特定的[设备状态](/zh-cn/docs/concepts/overview/working-with-objects/#object-spec-and-status)数据。
例如，驱动可能会列出分配给某个网络接口设备的 IP 地址。更新此字段需要特定的合成 RBAC 权限，
请参阅[强化指南 - 动态资源分配](/zh-cn/docs/concepts/security/hardening-guide/dynamic-resource-allocation/)和[在集群中强化动态资源分配（DRA）](/zh-cn/docs/tasks/administer-cluster/hardening-dra/)。

驱动添加到 ResourceClaim `status.devices` 字段中的信息是否准确取决于驱动本身。
请评估各个驱动，以决定是否可以将此字段作为设备信息的唯一来源。

如果你禁用
[`DRAResourceClaimDeviceStatus` 特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/#DRAResourceClaimDeviceStatus)，
则在存储 ResourceClaim 时，`status.devices` 字段会被自动清除。
当 DRA 驱动能够更新 `status.devices` 字段已设置的现有 ResourceClaim 时，
就支持 ResourceClaim 设备状态。

在以下示例中，负责管理已分配设备的驱动（`resource-driver.example.com`）
填充了 ResourceClaim 的 `status.devices` 字段：

```yaml
apiVersion: resource.k8s.io/v1
kind: ResourceClaim
metadata:
  name: macvlan-eth0
spec:
...
status:
  allocation:
    devices:
      results:
      - device: eth0
        driver: resource-driver.example.com
        pool: nic-worker-a
        request: macvlan-eth0
        shareID: 8e7acdf9-0290-4ecd-a801-a654b021d2b7
        consumedCapacity:
          resource-driver.example.com/bandwidth: 1G
  devices:
  - conditions:
    - lastTransitionTime: "2025-10-21T08:38:17Z"
      message: Device successfully allocated and assigned to the pod
      reason: NetworkReady
      status: "True"
      type: NetworkReady
    device: eth0
    driver: resource-driver.example.com
    networkData:
      hardwareAddress: 00:01:ec:84:fb:51
      interfaceName: net1
      ips:
      - 10.10.1.2/24
      - 2001:db8::1/64
    pool: nic-worker-a
    shareID: 8e7acdf9-0290-4ecd-a801-a654b021d2b7
```

如果某个设备尚未被分配，则驱动使用该设备更新 ResourceClaim
`status.devices` 字段的请求会被拒绝。
当设备被取消分配（从 `status.allocation.devices` 中移除）时，
`status.devices` 中相应的条目会被自动移除。

有关 `status.devices` 字段的细节，请参阅
API 参考：resource/resource-claim-v1 API 参考。

### 设备健康监控 {#device-health-monitoring}

功能状态：ResourceHealthStatus，Kubernetes 1.36，beta；首次引入于 1.31。默认启用。

Kubernetes 提供了一种机制来监控和报告动态分配的基础设施资源的健康状况。
对于在专用硬件上运行的有状态应用，了解设备何时发生故障或变得不健康至关重要。
了解设备是否恢复也同样有帮助。

要使用此功能，必须启用 `ResourceHealthStatus`
[特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/#ResourceHealthStatus)
（自 v1.36 起为 Beta 版并默认启用），
并且 DRA 驱动必须实现 `DRAResourceHealth` gRPC 服务。

当 DRA 驱动检测到已分配的设备变得不健康时，它会将此状态报告回 kubelet。
随后此健康信息会直接暴露在 Pod 的状态中。
kubelet 会填充每个容器状态中的 `allocatedResourcesStatus` 字段，
详细说明分配给该容器的每个设备的健康状况。
每个资源健康状况条目都可以包含一个可选的 `message` 字段，
其中包含有关健康状况的更多易于理解的上下文信息，如错误详情或故障原因。

如果在超时时间段内 kubelet 未收到来自 DRA 驱动的健康更新，
则该设备的健康状况会被标记为 “Unknown”。
DRA 驱动可以通过在 `DeviceHealth` gRPC 消息中
设置 `health_check_timeout_seconds` 字段，按设备配置此超时时间。
如果未指定，kubelet 使用 30 秒的默认超时时间。
这允许不同的硬件类型（例如 GPU、FPGA 或存储设备）根据其健康状况报告特征使用合适的超时值。

这为用户和控制器应对硬件故障提供了关键的可见性。
对于发生故障的 Pod，你可以检查此状态以确定故障是否与不健康的设备有关。

**说明：**

Pod 终止后（例如处于 Failed 状态），设备健康状况不会在 Pod 状态中更新。

## 资源池状态 {#resource-pool-status}

功能状态：DRAResourcePoolStatus，Kubernetes 1.36，alpha；首次引入于 1.36。默认禁用。使用前需配置相应特性门控。

你可以使用 ResourcePoolStatusRequest API 查询资源池中设备的可用性。
这让你能够了解整个集群的 DRA 资源池中有多少设备可用、已分配或不可用。

要检查资源池状态：

1. 创建一个 ResourcePoolStatusRequest，指定驱动名称（必需），
   并可选地指定返回的资源池数量限制。
   你还可以通过指定资源池名称将其限制为单个资源池：

   

   ```yaml
   apiVersion: resource.k8s.io/v1alpha3
   kind: ResourcePoolStatusRequest
   metadata:
     name: check-gpus
   spec:
     driver: example.com/gpu
     # 可选：筛选特定的资源池
     # poolName: my-pool
     # 可选：限制返回的资源池数量（默认值：100，最大值：1000）
     # limit: 10
   ```

2. 等待控制器处理该请求：

   ```shell
   kubectl wait --for=condition=Complete resourcepoolstatusrequest/check-gpus --timeout=30s
   ```

3. 读取状态以查看资源池可用性：

   ```shell
   kubectl get resourcepoolstatusrequest/check-gpus -o yaml
   ```

   

   状态中包括：

   - `poolCount`：与筛选条件匹配的资源池总数
     （如果因 limit 而被截断，所列出的资源池数量可能更少）。

   

   - `pools`：资源池详情列表，每一项包含：
     - `driver` 和 `poolName`：标识该资源池。
     - `generation`：在所有 ResourceSlice 中观测到的最新资源池代数。
     - `resourceSliceCount`：构成该资源池的 ResourceSlice 数量。
     - `totalDevices`：资源池中的设备总数。
     - `allocatedDevices`：当前已分配给申领的设备。
     - `availableDevices`：可供分配的设备
       （totalDevices - allocatedDevices - unavailableDevices）。
     - `unavailableDevices`：因污点或其他状况而不可用的设备。
     - `nodeName`：与该资源池关联的节点（如果有）。
     - `validationError`：当资源池的数据无法被完整验证时设置
       （例如在代数更新上线期间）。设置后，设备计数字段可能未被设置。
     - `partitionSummary`：对于[可分区](/zh-cn/docs/concepts/resource-management/dynamic-resource-allocation/dra-features/#partitionable-devices)资源池，提供按分区类型划分的可分配性
       （参见[分区摘要](#resource-pool-partition-summary)）。
     - `shareableSummary`：对于包含[可共享设备](/zh-cn/docs/concepts/resource-management/dynamic-resource-allocation/dra-features/#consumable-capacity)的资源池，提供聚合容量使用量
       （参见[共享摘要](#resource-pool-shareable-summary)）。

   

   - `conditions`：包括 `Complete`（成功）或 `Failed`（错误）状况类型。

4. 完成后删除该请求：

   ```shell
   kubectl delete resourcepoolstatusrequest/check-gpus
   ```

ResourcePoolStatusRequest 对象由 kube-controller-manager 中的控制器处理一次。
规约一经创建便不可变，而一旦状态被填充，整个对象也会变为不可变。
要获取更新的可用性数据，请删除并重新创建该请求。
已完成的请求会在 1 小时后被自动清理。

此功能需要对 ResourcePoolStatusRequest 资源的显式 RBAC 权限。
没有任何默认的 ClusterRole 包含此权限。

资源池状态由 `kube-apiserver` 和 `kube-controller-manager` 中的
[`DRAResourcePoolStatus` 特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/#DRAResourcePoolStatus)控制。

### 分区摘要 {#resource-pool-partition-summary}

功能状态：DRAPartitionableDevicesType，Kubernetes 1.37，alpha；首次引入于 1.37。默认禁用。使用前需配置相应特性门控。

GPU 等单个物理设备可能会被通告为多个分区类型
（例如完整 GPU 与半尺寸的 MIG 切片），这些分区类型从同一组共享计数器取用资源。
由于这些分区会竞争相同的底层容量，单纯的设备计数无法告诉你每种类型还有多少仍可分配。
对于[可分区](/zh-cn/docs/concepts/resource-management/dynamic-resource-allocation/dra-features/#partitionable-devices)资源池，
`partitionSummary` 视图可以回答这个问题。对于每个分区类型，它会报告：

- `attribute`：其值用于分组此条目的设备属性的完全限定名称。
  它对应 ResourceSlice 的 `spec.partitionTypeAttribute`；
  当切片未声明该属性时，则对应请求的 `spec.defaultPartitionTypeAttribute`。
- `type`：设备上该属性的值（例如 `Full` 或 `Half`）。
- `total`：资源池中此分区类型的设备数量。
- `allocatable`：在当前共享计数器消耗情况下，
  此分区类型还有多少**额外**设备仍可分配。

指定的属性必须是字符串属性。如果可分区设备的分区类型属性缺失，或者不是字符串
（例如整数、布尔值或版本值），则资源池会报告验证错误，而不是分区摘要。
对于[列表类型属性](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/#DRAListTypeAttributes)没有特殊处理；
非字符串属性根本就不是有效的分区类型属性。

为了生成此视图，驱动为每个可分区设备打上一个字符串属性，
其值指明分区类型，并在 ResourceSlice 的 `partitionTypeAttribute` 字段中指定该属性：

```yaml
apiVersion: resource.k8s.io/v1
kind: ResourceSlice
# ...
spec:
  # 此切片中的每个可分区设备都带有该属性；
  # 共享同一值的设备具有相同的共享计数器开销。
  partitionTypeAttribute: gpu.example.com/profile
```

如果驱动尚未更新以声明 `partitionTypeAttribute`，
请求仍可以通过在规约中指定一个回退属性来获取分区摘要。
切片自身的 `partitionTypeAttribute` 始终优先；
请求级别的默认值只适用于其切片未声明该属性的设备：

```yaml
apiVersion: resource.k8s.io/v1alpha3
kind: ResourcePoolStatusRequest
metadata:
  name: check-gpu-partitions
spec:
  driver: gpu.example.com
  # 供自身未声明分组属性的切片使用的回退分组属性。
  defaultPartitionTypeAttribute: gpu.example.com/profile
```

当切片和请求都未指定属性时，可分区资源池不会报告 `partitionSummary`。

`partitionSummary` 视图由 `kube-apiserver` 和 `kube-controller-manager` 中的
[`DRAPartitionableDevicesType` 特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/#DRAPartitionableDevicesType)控制，
而该门控又要求启用
[`DRAResourcePoolStatus`](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/#DRAResourcePoolStatus)
和
[`DRAPartitionableDevices`](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/#DRAPartitionableDevices)
特性门控。

### 共享摘要 {#resource-pool-shareable-summary}

对于包含[可共享设备](/zh-cn/docs/concepts/resource-management/dynamic-resource-allocation/dra-features/#consumable-capacity)的资源池
（即设置了 `allowMultipleAllocations`、可被多个申领消耗的设备），`shareableSummary` 会报告整个资源池的聚合容量使用量：

- `fullyAvailableDevices`：未消耗任何容量的可共享设备。
- `partiallyAvailableDevices`：消耗了部分但不是全部容量的可共享设备。
- `capacity`：按容量名称给出整个资源池中聚合的 `total`、`consumed` 和
  `available`（即 `total` 减去 `consumed`，不会为负）数量。

只有当资源池中至少有一个设备可共享时，才会填充 `shareableSummary`。
它属于[资源池状态](#resource-pool-status)功能
（[`DRAResourcePoolStatus`](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/#DRAResourcePoolStatus) 特性门控），
不要求启用 `DRAPartitionableDevicesType`；
它所汇总的可共享设备来自[可消耗容量](/zh-cn/docs/concepts/resource-management/dynamic-resource-allocation/dra-features/#consumable-capacity)特性。

## 容器中的 DRA 设备元数据 {#device-metadata}

功能状态：Kubernetes v1.37，beta。

DRA 驱动可以将设备元数据（例如设备属性（PCI 总线地址或中介设备 UUID）
和网络配置）以 JSON 文件的形式直接暴露给容器。
这让应用无需查询 Kubernetes API 或使用自定义控制器，
即可发现已分配设备的相关信息。

KEP-5304 定义了驱动必须遵循的[设备元数据协议](#device-metadata-protocol)，
以便应用在不同驱动和集群之间看到一致的布局。
[DRA kubelet 插件库](https://pkg.go.dev/k8s.io/dynamic-resource-allocation/kubeletplugin)实现了此协议。

设备元数据遵循与设备访问相同的规则：只有当容器请求该设备时，元数据才在该容器内可用。
有关细节请参阅[使用 DRA 在工作负载中请求设备](/zh-cn/docs/tasks/configure-pod-container/assign-resources/allocate-devices-dra/#request-devices-workloads)。

### 设备元数据协议 {#device-metadata-protocol}

该协议由四条规则组成：

1. **文件路径。** 元数据文件位于容器内的
   `/var/run/kubernetes.io/dra-device-attributes` 下。
   对于直接引用的 ResourceClaim，路径为
   `resourceclaims/<claimName>/<requestName>/<driverName>-metadata.json`。
   对于由 ResourceClaimTemplate 创建的申领，路径为
   `resourceclaimtemplates/<podClaimName>/<requestName>/<driverName>-metadata.json`，
   其中 `podClaimName` 为 `pod.spec.resourceClaims[].name`。

   
   当请求使用[优先级列表](/zh-cn/docs/concepts/resource-management/dynamic-resource-allocation/dra-api/#prioritized-list)时，
   `<requestName>` 路径段只使用顶层请求名称。文件中的 `requests[].name` 字段包含完整的
   `<request>/<subrequest>` 引用，例如 `gpu/high-memory`。

   
   路径常量定义在
   [`k8s.io/dynamic-resource-allocation/api/metadata`](https://pkg.go.dev/k8s.io/dynamic-resource-allocation/api/metadata)。

2. **JSON API。** 每个文件是一个或多个
   [`DeviceMetadata`](https://pkg.go.dev/k8s.io/dynamic-resource-allocation/api/metadata/v1beta1#DeviceMetadata)
   对象的流。每个对象都有 `apiVersion` 和 `kind`，遵循 Kubernetes API 约定。
   同一份元数据会按驱动选择的顺序，为每个已配置的 API 版本各编码一次。
   使用方会使用它们能够解码的第一个版本，并跳过未知版本。
   已知版本中的格式错误对象会被视为错误。

3. **代数。** 初始文件的 `metadata.generation` 设为 `1`。
   每次更新都会递增该代数，以便使用方能够检测到变化。

4. **容器暴露。** DRA kubelet 插件库使用
   CDI 将每个文件以只读方式绑定挂载。
   其他实现可以使用不同的机制，只要文件出现在所需的路径上并且是只读的即可。

### 在驱动中启用设备元数据 {#device-metadata-enable}

设备元数据是驱动侧的功能。它没有 Kubernetes 特性门控，
并且在 DRA kubelet 插件库中默认禁用。
驱动必须启用该功能并明确选择要写入的版本：

```go
kubeletplugin.EnableDeviceMetadata(true, []schema.GroupVersion{
	metadatav1beta1.SchemeGroupVersion,
	metadatav1alpha1.SchemeGroupVersion,
})
```

`v1beta1` 版本是必需的。驱动也可以写入 `v1alpha1`，以兼容较旧的使用方。
切片中的顺序就是元数据流中的顺序；框架不会对版本排序。驱动应将最新版本放在最前面。
启用了设备元数据但未提供版本、缺少 `v1beta1` 或使用未知版本，
都会导致插件在启动期间失败。

对于每个已准备的设备，驱动可以用
[`kubeletplugin.DeviceMetadata`](https://pkg.go.dev/k8s.io/dynamic-resource-allocation/kubeletplugin#DeviceMetadata)
填充
[`Device.Metadata`](https://pkg.go.dev/k8s.io/dynamic-resource-allocation/kubeletplugin#Device)。
驱动应在其 ResourceSlice 中包含它为该设备发布的属性，这样工作负载在运行时能看到相同的信息。
驱动也可以包含仅在运行时才有意义的属性。对于网络设备，驱动可以在 CNI 配置完成后，
通过调用
[`UpdateRequestMetadata`](https://pkg.go.dev/k8s.io/dynamic-resource-allocation/kubeletplugin#Helper.UpdateRequestMetadata)
添加接口名称、IP 地址和硬件地址。

上面的 kubelet 插件 API 链接描述了面向驱动开发者的集成方式。
DRA 框架没有定义通用的命令行标志，
因此集群运维人员通过其驱动提供的部署配置来启用该功能。

启用后，DRA kubelet 插件库会在准备已分配设备时写入元数据文件。
它还会默认将 CDI 规范写入 `/var/run/cdi`。
容器运行时必须配置为从该目录发现 CDI 规范。
该库会为生成的每个规范确定所需的最低 CDI 规范版本。

当一个请求从多个 DRA 驱动分配设备时，每个驱动都会写入自己的元数据文件。
知道驱动名称的使用方应根据申领、请求和驱动名称构造确切的路径。
Go 使用方可以使用
[`ReadResourceClaimMetadata`](https://pkg.go.dev/k8s.io/dynamic-resource-allocation/devicemetadata#ReadResourceClaimMetadata)
或
[`ReadResourceClaimTemplateMetadata`](https://pkg.go.dev/k8s.io/dynamic-resource-allocation/devicemetadata#ReadResourceClaimTemplateMetadata)
来读取并合并某个请求的所有按驱动划分的文件。

### 元数据模式 {#device-metadata-schema}

元数据文件中的每个对象都符合
[`DeviceMetadata`](https://pkg.go.dev/k8s.io/dynamic-resource-allocation/api/metadata/v1beta1#DeviceMetadata)
API（`metadata.resource.k8s.io/v1beta1`）。

该模式包含：

- ResourceClaim 的标准对象元数据，包括其名称、名字空间、UID 和元数据代数。
- 对于由 ResourceClaimTemplate 生成的申领，可选的 `podClaimName`。
- 请求列表。每个请求有一个必需的名称和一个已分配设备的列表。
- 每个设备的驱动、资源池和名称。
- 可选的设备属性和网络数据。

属性值使用与 ResourceSlice 设备属性相同的表示形式。
每个属性恰好有一个标量值（`int`、`bool`、`string` 或 `version`）
或列表值（`ints`、`bools`、`strings` 或 `versions`）。
设备容量值不包含在设备元数据中。

网络数据可以包含 `interfaceName`、`ips` 和 `hardwareAddress`。
有关字段约束，请参阅
[`DeviceMetadata` API 文档](https://pkg.go.dev/k8s.io/dynamic-resource-allocation/api/metadata/v1beta1#DeviceMetadata)。

以下示例展示通过 ResourceClaimTemplate 分配的 GPU 设备在元数据流中的一个对象：

```json
{
  "kind": "DeviceMetadata",
  "apiVersion": "metadata.resource.k8s.io/v1beta1",
  "metadata": {
    "name": "pod0-gpu-2kqrd",
    "namespace": "gpu-test1",
    "uid": "c7e7b22e-239b-4498-b27c-7f1344481e14",
    "generation": 1
  },
  "podClaimName": "gpu",
  "requests": [
    {
      "name": "gpu",
      "devices": [
        {
          "driver": "gpu.example.com",
          "pool": "worker-0",
          "name": "gpu-0",
          "attributes": {
            "driverVersion": {
              "version": "1.0.0"
            },
            "index": {
              "int": 0
            },
            "model": {
              "string": "LATEST-GPU-MODEL"
            },
            "uuid": {
              "string": "gpu-18db0e85-99e9-c746-8531-ffeb86328b39"
            }
          }
        }
      ]
    }
  ]
}
```

DRA kubelet 插件在写入元数据之前不会对其进行验证。Go 使用方在解码流时可以选择启用生成的验证。
解码和验证的结果是分开的：验证错误不会阻止返回已成功解码的对象。有关用法，
请参阅[访问 DRA 设备元数据](/zh-cn/docs/tasks/configure-pod-container/assign-resources/access-dra-device-metadata/#read-metadata-application)。

### 即时元数据与延迟元数据 {#device-metadata-lifecycle}

对于即时元数据，驱动在准备申领时提供属性或网络数据。
DRA kubelet 插件在使用该设备的容器启动之前写入代数 `1` 的文件。

对于延迟元数据，驱动可以在没有属性或网络数据的情况下准备设备。初始的代数 `1` 文件包含设备标识。
驱动稍后调用 `UpdateRequestMetadata` 以原子方式替换整个流并递增代数。
更新要求初始文件存在。如果设备准备为某个请求返回空设备，
框架不会为该请求创建元数据文件，也不会创建元数据 CDI 设备。

在每个使用该设备的容器的生命期内，元数据对该容器始终可用。
框架在申领被取消准备后移除元数据文件和 CDI 规范。

要了解如何在工作负载中使用设备元数据，
请参阅[访问 DRA 设备元数据](/zh-cn/docs/tasks/configure-pod-container/assign-resources/access-dra-device-metadata/)。

### 自定义驱动 {#device-metadata-custom-drivers}

不使用 DRA kubelet 插件库的自定义驱动必须自行实现[设备元数据协议](#device-metadata-protocol)。
这包括在正确的路径下写入带版本的 `DeviceMetadata` 流、在每次更新时递增 `metadata.generation`，
以及通过 CDI 或等效机制以只读方式暴露文件。
