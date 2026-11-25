# DRA API 对象

本页介绍 Kubernetes API 种类，这些种类由动态资源分配（DRA）用于对设备进行分类、请求和分配。

## DRA 术语 {#terminology}

DRA 使用以下 Kubernetes API 种类来提供核心分配功能。
所有这些 API 种类都包含在 `resource.k8s.io/v1`
API 组中。

DeviceClass
: 定义了可以被申领的设备类别，以及如何在申领中选择特定设备属性。
  DeviceClass 参数可以匹配 ResourceSlice 中的零个或多个设备。
  若要从 DeviceClass 中申领设备，ResourceClaim 需要选择特定的设备属性。

ResourceClaim
: 描述了访问集群中已挂接资源（例如设备）的请求。
  ResourceClaim 为 Pod 提供对特定资源的访问。
  ResourceClaim 可以由工作负载运维人员创建，
  也可以由 Kubernetes 基于 ResourceClaimTemplate 生成。

ResourceClaimTemplate
: 定义一个模板，Kubernetes 使用该模板为工作负载创建每个 Pod 的 ResourceClaim。
  ResourceClaimTemplate 为 Pod 提供对独立的、配置相似的资源的访问。
  Kubernetes 从此模板生成的每个 ResourceClaim 都会绑定到一个特定的 Pod。
  当 Pod 终止时，Kubernetes 删除对应的 ResourceClaim。

ResourceSlice
: 代表挂接到节点上的一个或多个资源，例如设备。
  驱动在集群中创建和管理 ResourceSlice。当 ResourceClaim 被创建并在 Pod 中使用时，
  Kubernetes 使用 ResourceSlice 查找能够访问已申领资源的节点。
  Kubernetes 将资源分配给 ResourceClaim，并将 Pod 调度到可以访问这些资源的节点上。

### DeviceClass {#deviceclass}

DeviceClass 允许集群管理员或设备驱动在集群中定义设备的类别。
DeviceClass 告知运维人员他们可以请求哪些设备，以及如何请求这些设备。
你可以使用[公共表达式语言（CEL）](https://cel.dev)根据特定属性选择设备。
引用 DeviceClass 的 ResourceClaim 随后可以请求 DeviceClass 中的特定配置。

要创建 DeviceClass，
请参阅[在集群中设置 DRA](/zh-cn/docs/tasks/configure-pod-container/assign-resources/set-up-dra-cluster)。

### ResourceClaim 与 ResourceClaimTemplate {#resourceclaims-templates}

ResourceClaim 定义了工作负载所需的资源。每个 ResourceClaim 都包含
**requests**，它们引用一个 DeviceClass 并从该 DeviceClass 中选择设备。
ResourceClaim 还可以使用 **selectors** 过滤符合特定需求的设备，
并可以使用 **constraints** 限制能够满足请求的设备。
ResourceClaim 可以由工作负载运维人员创建，
也可以由 Kubernetes 基于 ResourceClaimTemplate 生成。
ResourceClaimTemplate 定义了一个模板，Kubernetes 可以使用该模板为 Pod
自动生成 ResourceClaim。

#### ResourceClaim 与 ResourceClaimTemplate 的使用场景 {#when-to-use-rc-rct}

你使用的方法取决于你的需求，如下所述：

* **ResourceClaim：** 你希望多个 Pod 共享对特定设备的访问。
  你手动管理你创建的 ResourceClaim 的生命周期。

* **ResourceClaimTemplate：** 你希望 Pod
  能够独立访问独立的、配置相似的设备。Kubernetes 根据 ResourceClaimTemplate 中的规约生成
  ResourceClaim。每个生成的 ResourceClaim 的生存期都绑定到对应 Pod 的生存期。

* [**PodGroup ResourceClaimTemplate**](#workload-resource-claims)：
  你希望 PodGroup
  能够独立访问独立的、配置相似的设备，且其 Pod 可以共享这些设备。
  Kubernetes 根据 ResourceClaimTemplate 中的规约为 PodGroup 生成一个
  ResourceClaim。每个生成的 ResourceClaim 的生存期都绑定到对应 PodGroup
  的生存期。这要求启用
  [`DRAWorkloadResourceClaims`](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/#DRAWorkloadResourceClaims)
  特性。

当你定义工作负载时，可以使用
公共表达式语言（CEL）
来过滤特定的设备属性或容量。可用于过滤的可用参数取决于设备和驱动。

如果你在 Pod 中直接引用特定的 ResourceClaim，该 ResourceClaim 必须已经存在于与
Pod 相同的名字空间中。如果 ResourceClaim 不存在于该名字空间中，
Pod 将无法调度。此行为类似于 PersistentVolumeClaim 必须存在于引用它的 Pod
所在的同一名字空间中。

你可以在 Pod 中引用自动生成的 ResourceClaim，但这并不推荐，
因为自动生成的 ResourceClaim 的生存期绑定到触发生成的 Pod 或 PodGroup 的生存期。

要了解如何使用这些方法之一申领资源，
请参阅[使用 DRA 为工作负载分配设备](/zh-cn/docs/tasks/configure-pod-container/assign-resources/allocate-devices-dra/)。

#### 优先级列表 {#prioritized-list}

功能状态：DRAPrioritizedList，Kubernetes 1.36，stable；首次引入于 1.33。默认启用。

你可以为 ResourceClaim 或 ResourceClaimTemplate 中的请求提供子请求的优先级列表。
调度器会选择第一个可以被分配的子请求。
这允许用户指定在首选方案不可用时工作负载可以使用的备选设备。

在以下示例中，ResourceClaimTemplate 请求了一台颜色为黑色、尺寸为大号的设备。
如果没有具有这些属性的设备可用，Pod 将无法被调度。
借助优先级列表特性，可以指定第二个备选方案，即请求两台颜色为白色、尺寸为小号的设备。
如果大号黑色设备可用，将分配它；如果不可用，但有两台小号白色设备可用，Pod 仍然可以运行。

```yaml
apiVersion: resource.k8s.io/v1
kind: ResourceClaimTemplate
metadata:
  name: prioritized-list-claim-template
spec:
  spec:
    devices:
      requests:
      - name: req-0
        firstAvailable:
        - name: large-black
          deviceClassName: resource.example.com
          selectors:
          - cel:
              expression: |-
                device.attributes["resource-driver.example.com"].color == "black" &&
                device.attributes["resource-driver.example.com"].size == "large"
        - name: small-white
          deviceClassName: resource.example.com
          selectors:
          - cel:
              expression: |-
                device.attributes["resource-driver.example.com"].color == "white" &&
                device.attributes["resource-driver.example.com"].size == "small"
          count: 2
```

如果 Pod 适合在集群中的多个节点上运行，调度器在为每个节点打分时，
会将从任何优先级列表中选中的子请求的索引作为输入之一。
因此，能够分配更高级子请求中所请求设备的节点，
比只能分配较低级子请求设备的节点更有可能被选中。

该决策是按每个 Pod 单独作出的，因此如果 Pod 是 ReplicaSet 或类似分组的成员，
你不能依赖该组的所有成员都选用相同的子请求。你的工作负载必须能适应这一点。

#### 工作负载 ResourceClaim {#workload-resource-claims}

功能状态：DRAWorkloadResourceClaims，Kubernetes 1.37，beta；首次引入于 1.36。默认禁用。使用前需配置相应特性门控。

当你使用
[Workload API](/zh-cn/docs/concepts/workloads/workload-api/)
来组织 Pod 时，你可以为整个
PodGroup
预留 ResourceClaim，而不是为每个 Pod 单独预留；
并为 PodGroup 而非单个 Pod 生成 ResourceClaimTemplate，
从而允许 PodGroup 内的 Pod 共享对生成的 ResourceClaim 所分配设备的访问权。

此特性针对两个问题：

- ResourceClaim API 的 `status.reservedFor` 列表只能包含 256 项。
  由于 kube-scheduler 仅在该列表中记录单个 Pod，
  因此只能有 256 个 Pod 共享一个 ResourceClaim。
  通过允许将 PodGroup 记录在 `status.reservedFor` 中，
  远多于 256 个 Pod 可以共享一个 ResourceClaim。

- 只有当 ResourceClaim 的确切名称已知时，Pod 才能共享它。
  对于复制 **Pod 组**的复杂工作负载，当组的集合扩缩容时，
  每组中 Pod 共享的 ResourceClaim 都需要显式创建和删除。
  通过为每个 PodGroup 生成 ResourceClaim，
  单个 ResourceClaimTemplate 可以作为既被自动复制、又能在
  PodGroup 内的 Pod 之间共享的 ResourceClaim 的基础。

PodGroup API 定义了一个 `spec.resourceClaims` 字段，其结构与 Pod API 中的
`spec.resourceClaims` 字段相同，含义也类似：

```yaml
apiVersion: scheduling.k8s.io/v1beta1
kind: PodGroup
metadata:
  name: training-group
  namespace: some-ns
spec:
  ...
  resourceClaims:
  - name: pg-claim
    resourceClaimName: my-pg-claim
  - name: pg-claim-template
    resourceClaimTemplateName: my-pg-template
```

与 Pod 提出的申领类似，定义了 `resourceClaimName` 的 PodGroup
申领按名称引用一个 ResourceClaim。定义了 `resourceClaimTemplateName`
的申领引用一个 ResourceClaimTemplate，该模板会复制为整个 PodGroup 的一个
ResourceClaim，供其 Pod 之间共享。

当 Pod 定义的申领的 `name`、`resourceClaimName` 和
`resourceClaimTemplateName` 全部与其 PodGroup 的某个
`spec.resourceClaims` 匹配时，kube-scheduler 会为 PodGroup
而非 Pod 预留该 ResourceClaim。如果 Pod 的申领与 PodGroup 的申领不匹配，
kube-scheduler 则为 Pod 预留 ResourceClaim。在这两种情况下，
预留都会记录在 ResourceClaim 的 `status.reservedFor` 中。
PodGroup 预留以及对应的资源分配会在 ResourceClaim 中持久存在，
直到 PodGroup 被删除，即使该组中不再有任何 Pod。

当匹配 PodGroup 申领的 Pod 申领定义了 `resourceClaimTemplateName` 时，
会为 PodGroup 生成一个 ResourceClaim。组中定义了相同申领的其他 Pod
将共享该生成的 ResourceClaim，而不会为每个 Pod 触发新的 ResourceClaim 生成。
无论 `resourceClaimTemplateName` 申领是否匹配 PodGroup 申领，
生成的 ResourceClaim 的名称都会记录在 Pod 的 `status.resourceClaimStatuses` 中。

只有当
[`DRAWorkloadResourceClaims`](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/#DRAWorkloadResourceClaims)
特性启用时，匹配的 PodGroup 申领才会触发 ResourceClaimTemplate 创建 ResourceClaim。
在该特性禁用时，不会创建 ResourceClaim，以避免在集群升级或 `kube-apiserver` 与
`kube-controller-manager` 之间进行特性滚动/回滚期间产生虚假的按 Pod 分配的
ResourceClaim。

从 ResourceClaimTemplate 为 PodGroup 生成的 ResourceClaim 遵循 PodGroup
的生命周期。当 PodGroup 及其 ResourceClaimTemplate 都存在时，才会首次创建
ResourceClaim。在 PodGroup 已被删除且 ResourceClaim 不再被预留后，
ResourceClaim 会被删除。

请看以下示例：

```yaml
apiVersion: scheduling.k8s.io/v1beta1
kind: PodGroup
metadata:
  name: training-group
  namespace: some-ns
spec:
  ...
  resourceClaims:
  - name: pg-claim
    resourceClaimName: my-pg-claim
  - name: pg-claim-template
    resourceClaimTemplateName: my-pg-template
---
apiVersion: v1
kind: Pod
metadata:
  name: training-group-pod-1
  namespace: some-ns
spec:
  ...
  schedulingGroup:
    podGroupName: training-group
  resourceClaims:
  - name: pod-claim
    resourceClaimName: my-pod-claim
  - name: pod-claim-template
    resourceClaimTemplateName: my-pod-template
  - name: pg-claim
    resourceClaimName: my-pg-claim
  - name: pg-claim-template
    resourceClaimTemplateName: my-pg-template
```

在此示例中，`training-group` PodGroup 有一个名为 `training-group-pod-1` 的 Pod。
Pod 的 `pod-claim` 和 `pod-claim-template` 申领不匹配 PodGroup 的任何申领，
因此这些申领不受 PodGroup 的影响：ResourceClaim `my-pod-claim` 变为为 Pod 预留，
并且从 ResourceClaimTemplate `my-pod-template` 生成一个 ResourceClaim，
同样变为为 Pod 预留。`pg-claim` 和 `pg-claim-template` 确实匹配 PodGroup
的申领。ResourceClaim `my-pg-claim` 变为为 PodGroup 预留，
并且从 ResourceClaimTemplate `my-pg-template` 生成一个 ResourceClaim，
同样变为为 PodGroup 预留。

将 ResourceClaim 与 Workload API 资源关联由
`kube-apiserver`、`kube-controller-manager`、`kube-scheduler` 和 `kubelet` 中的
[`DRAWorkloadResourceClaims` 特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/#DRAWorkloadResourceClaims)控制。

### ResourceSlice {#resourceslice}

每个 ResourceSlice 代表一个池中一个或多个设备。
该池由设备驱动管理，驱动会创建和管理 ResourceSlice。
池中的资源可能由单个 ResourceSlice 表示，也可能跨越多个 ResourceSlice。

ResourceSlice 向设备使用者和调度器提供有用的信息，
并且对于动态资源分配至关重要。每个 ResourceSlice 必须包含以下信息：

* **资源池（Resource pool）：** 驱动管理的一个或多个资源的组。
  池可以跨越多个 ResourceSlice。池中资源的变更必须在该池的所有
  ResourceSlice 之间传播。管理该池的设备驱动负责确保此传播发生。

* **设备（Devices）：** 被管理的池中的设备。
  ResourceSlice 可以列出池中的每个设备，也可以列出池中的设备子集。
  ResourceSlice 定义设备信息，例如属性、版本和容量。
  设备使用者可以通过在 ResourceClaim 或 DeviceClass 中过滤设备信息来选择要分配的设备。

* **节点（Nodes）：** 可以访问这些资源的节点。
  驱动可以选择哪些节点可以访问资源，
  是集群中的所有节点、单个指定名称的节点，还是具有特定节点标签的节点。

驱动使用控制器将集群中的
ResourceSlice 与驱动必须发布的信息进行协调。
此控制器会覆写任何手动更改，例如集群用户创建或修改 ResourceSlice 的操作。

请看以下 ResourceSlice 示例：

```yaml
apiVersion: resource.k8s.io/v1
kind: ResourceSlice
metadata:
  name: cat-slice
spec:
  driver: "resource-driver.example.com"
  pool:
    generation: 1
    name: "black-cat-pool"
    resourceSliceCount: 1
  # allNodes 字段定义集群中的任何节点是否都可以访问该设备。
  allNodes: true
  devices:
  - name: "large-black-cat"
    attributes:
      color:
        string: "black"
      size:
        string: "large"
      cat:
        bool: true
```

该 ResourceSlice 由 `resource-driver.example.com` 驱动在 `black-cat-pool` 池中管理。
`allNodes: true` 字段表示集群中的任何节点都可以访问这些设备。
ResourceSlice 中有一台设备，名为 `large-black-cat`，具有以下属性：

* `color`：`black`
* `size`：`large`
* `cat`：`true`

DeviceClass 可以使用这些属性选择此 ResourceSlice，
ResourceClaim 可以在该 DeviceClass 中过滤特定设备。

#### 命名与优先级 {#resourceslice-naming-and-prioritization}

Kubernetes 调度器评估设备分配顺序的依据是 ResourceSlice
和资源池名称的字典序排序。调度器使用最先适应（first-fit）策略，
即选择满足申领需求的第一台可用设备。

这允许通过为池和 ResourceSlice 分配的名称来影响资源分配的优先级。
请注意，没有[绑定条件](/zh-cn/docs/concepts/resource-management/dynamic-resource-allocation/dra-features/#device-binding-conditions)
的池总是比具有绑定条件的池先被评估，无论它们的名称如何。

对于使用 `k8s.io/dynamic-resources/kubeletplugin` Go 包构建的驱动，
或使用该模块中的 ResourceSlice 控制器构建的驱动，
这些组件会自动处理 ResourceSlice 命名，
确保按照驱动指定的顺序进行评估。

## 管理员访问 {#admin-access}

功能状态：DRAAdminAccess，Kubernetes 1.36，stable；首次引入于 1.32。默认启用。

你可以将 ResourceClaim 或 ResourceClaimTemplate 中的请求标记为具有特权特性，
用于维护和故障排查任务。具有管理员访问的请求可以授予对正在使用中设备的访问权限，
并可能在使设备在容器中可用时启用额外权限：

```yaml
apiVersion: resource.k8s.io/v1
kind: ResourceClaimTemplate
metadata:
  name: large-black-cat-claim-template
spec:
  spec:
    devices:
      requests:
      - name: req-0
        exactly:
          deviceClassName: resource.example.com
          allocationMode: All
          adminAccess: true
```

管理员访问是一种特权模式，在多租户集群中不应授予普通用户。
只有被授权在带有 `resource.kubernetes.io/admin-access: "true"`
（区分大小写）标签的名字空间中创建 ResourceClaim 或
ResourceClaimTemplate 对象的用户，才能使用 `adminAccess` 字段。
这确保了非管理员用户不会滥用此特性。

管理员访问由 `kube-apiserver`、`kube-scheduler` 和 `kubelet` 中的
[`DRAAdminAccess` 特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/#DRAAdminAccess)控制。

## 列表类型属性 {#list-type-attributes}

功能状态：DRAListTypeAttributes，Kubernetes 1.36，alpha；首次引入于 1.36。默认禁用。使用前需配置相应特性门控。

此特性改进了 ResourceSlice API，允许 DRA 驱动为设备属性指定列表值，
而不仅仅是标量。这对于建模更复杂的节点内部拓扑非常有用，
例如当 CPU 与多个 PCIe 根节点相邻时。

对于 ResourceClaim 的编写者（最终用户），
这意味着 `matchAttribute` 和 `distinctAttribute` 在此类场景下工作得更好。

- `matchAttribute` — 两个属性必须具有**非空的列表交集**，
  而非完全相同（标量值被视为单项列表）。这仅意味着如果一个驱动为例如
  PCIe 根节点发布了单个值，而另一个驱动发布了一个列表，
  只要该单个值出现在列表中的某个位置，约束就被满足。

- `distinctAttribute` — 属性值必须**两两互不相交**（任意两台设备之间不共享任何值）。

为了帮助 ResourceClaim 的编写者在 CEL 表达式中使用可能为列表的属性，
此特性还引入了 `includes()` CEL 函数。

```
# 标量属性（向后兼容）
# 假设：device.attributes["dra.example.com"].model = "model-a"
device.attributes["dra.example.com"].model.includes("model-a")  # true
device.attributes["dra.example.com"].model.includes("model-b")  # false

# 列表类型属性（需要 DRAListTypeAttributes）
# 假设：device.attributes["dra.example.com"].supported-models = ["model-a", "model-b"]
device.attributes["dra.example.com"].supported-models.includes("model-a")  # true
device.attributes["dra.example.com"].supported-models.includes("model-c")  # false
```

### DRA 驱动编写者的细节

默认情况下，每个 `DeviceAttribute` 恰好保存一个标量值：
布尔值、整数、字符串或语义版本字符串。
`DRAListTypeAttributes` 特性门控为 `DeviceAttribute` 扩展了四个列表类型字段，
允许设备为单个属性通告多个值：

- **`bools`** — 布尔值列表
- **`ints`** — 64 位整数值列表
- **`strings`** — 字符串列表（每项最多 64 个字符）
- **`versions`** — 符合 semver.org 规范 2.0.0 的语义版本字符串列表
  （每项最多 64 个字符）

每台设备的单个属性值总数（标量字段加上所有列表元素的总和）上限为 **48**。
当 ResourceSlice 中的任何设备使用此特性或其他高级特性（如污点）时，
ResourceSlice 最多被限制为 **64** 台设备。

以下是一台设备使用列表类型字符串属性通告多个支持型号的示例：

```yaml
kind: ResourceSlice
apiVersion: resource.k8s.io/v1
metadata:
  name: example-resourceslice
spec:
  nodeName: worker-1
  pool:
    name: pool
    generation: 1
    resourceSliceCount: 1
  driver: dra.example.com
  devices:
  - name: gpu-0
    attributes:
      dra.example.com/supported-models:
        strings:
        - model-a
        - model-b
```

列表类型属性由 `kube-apiserver` 和 `kube-scheduler` 中的
[`DRAListTypeAttributes` 特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/#DRAListTypeAttributes)控制。

## 派生属性 {#derived-attributes}

功能状态：DRADerivedAttributes，Kubernetes 1.37，alpha；首次引入于 1.37。默认禁用。使用前需配置相应特性门控。

通常，`matchAttribute` 和 `distinctAttribute` 约束要求设备
使用完全相同的名称来发布属性。如果 GPU 驱动发布 `pcie_locality`，
而 NIC 驱动发布 `pcie_root`（或将相同信息嵌入到诸如 `numa0-pcie1` 的字符串中），
调度器无法识别它们表示的是同一事物，
因此来自两个驱动的设备无法被共置，除非先就共享属性名称达成一致。

`derivedAttributes` 让你可以就地弥合这一差距，
而无需等待驱动在共享属性名称上实现标准化。
在请求的 `.spec.devices.requests[].exactly` 或
`.spec.devices.requests[].firstAvailable[]` 下添加一个或多个
`derivedAttributes` 条目。每个条目定义一个 CEL 表达式，
调度器会针对该请求的每个候选设备评估该表达式。
评估结果成为一个虚拟属性，可以与驱动提供的设备属性完全一样地被
`matchAttribute` 或 `distinctAttribute` 约束引用。

```yaml
apiVersion: resource.k8s.io/v1
kind: ResourceClaim
metadata:
  name: gpu-nic-numa-alignment
spec:
  devices:
    requests:
    - name: gpu
      exactly:
        deviceClassName: gpu.example.com
        count: 1
        derivedAttributes:
        - name: derived/numa
          expression: device.attributes["gpu.example.com"].numa
    - name: nic
      exactly:
        deviceClassName: nic.example.com
        count: 1
        derivedAttributes:
        - name: derived/numa
          expression: device.attributes["nic.example.com"].numaNode
    constraints:
    - requests: ["gpu", "nic"]
      matchAttribute: derived/numa
```

在此示例中，`gpu` 和 `nic` 驱动使用不同的属性名称（`numa` 和 `numaNode`）来发布拓扑信息。
每个请求都从自己的设备属性中计算出一个公共的 `derived/numa` 值，
而 `matchAttribute` 约束将两个请求在该虚拟属性上对齐，
即使底层驱动从未就共享属性名称达成一致。

关于 `derivedAttributes` 需要了解以下几点：

- **命名：** `name` 必须是一个 DNS 子域名，后跟 `/` 和一个 C 标识符，
  格式与驱动提供的属性名称相同（例如 `example.com/numaNode` 或
  `derived/numaNode`）。如果该名称与驱动已经发布的驱动提供属性相匹配，
  则派生属性的值会在约束匹配时遮蔽驱动提供的属性。
  如果你希望避免无意中发生遮蔽，请使用不会被任何驱动使用的域名前缀，
  例如 `derived/`。每个请求最多可以定义 32 个派生属性。

- **必须被约束使用：** 每个派生属性必须被至少一个应用于定义它的请求（或子请求）的
  `matchAttribute` 或 `distinctAttribute` 约束引用。
  否则 ResourceClaim 验证会失败。

- **评估范围和顺序：** `expression` 对每个候选设备评估一次，
  评估发生在请求自己的 CEL 选择算符（`.selectors[].cel`）
  已经过滤完该设备之后。因此，派生属性不能被选择算符表达式引用，
  也不会通过 CEL 环境中的 `device.attributes` 暴露。

- **返回类型：** `expression` 必须评估为一个标量（`string`、`int`、`bool`
  或语义版本），或者当同时启用了 `DRAListTypeAttributes` 特性门控时，
  评估为上述标量类型之一的列表。

- **开销限制：** 每个表达式都有最大长度和 CEL 评估开销估算上限。
  除此之外，ResourceClaim 中所有 `derivedAttributes`
  表达式的组合估算开销也有上限，以限制单次调度尝试的总附加开销。
  如果超出上述任何限制，ResourceClaim 将被拒绝。

- **运行时错误会中止调度：** 如果对某个候选设备的表达式评估失败（例如因为它引用了该设备没有的属性），
  调度器会中止分配，且该 Pod 会调度失败，而不是静默跳过该设备。
  请以防御方式编写表达式，例如在读取属性之前先检查它是否存在。

派生属性由 `kube-apiserver` 和 `kube-scheduler` 中的
[`DRADerivedAttributes` 特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/#DRADerivedAttributes)
控制。

有关 DRA 驱动可以发布的标准设备属性列表，
请参阅[标准设备属性](/zh-cn/docs/reference/node/dra-standard-device-attributes/)参考。

## 通过 DRA 的扩展资源分配 {#extended-resource}

功能状态：DRAExtendedResource，Kubernetes 1.37，stable；首次引入于 1.34。默认启用。

你可以为 DeviceClass 提供一个扩展资源名称。调度器随后会为扩展资源请求选择匹配该类的设备。
这允许用户继续在 Pod 中使用扩展资源请求，
来请求由设备插件提供的扩展资源，或 DRA 设备。
在单个集群节点上，同一扩展资源可以由设备插件提供，也可以由 DRA 提供。
在同一集群中，某些节点上的同一扩展资源可以由设备插件提供，
而其他节点上可以由 DRA 提供。

在以下示例中，DeviceClass 被赋予了一个 `example.com/gpu` 的 extendedResourceName。
如果 Pod 请求扩展资源 `example.com/gpu: 2`，
它可以被调度到具有两台或更多匹配该 DeviceClass 设备的节点上。

```yaml
apiVersion: resource.k8s.io/v1
kind: DeviceClass
metadata:
  name: gpu.example.com
spec:
  selectors:
  - cel:
      expression: device.driver == 'gpu.example.com' && device.attributes['gpu.example.com'].type
        == 'gpu'
  extendedResourceName: example.com/gpu
```

此外，用户可以使用一种特殊的扩展资源来分配设备，而无需显式创建 ResourceClaim。
使用扩展资源名称前缀 `deviceclass.resource.kubernetes.io/` 加上 DeviceClass 名称即可。
这对任何 DeviceClass 都有效，即使它没有指定扩展资源名称。
生成的 ResourceClaim 将包含一个请求，要求分配该 DeviceClass 的指定数量设备的
`ExactCount`。

通过 DRA 的扩展资源分配由
`kube-apiserver`、`kube-scheduler`、`kube-controller-manager` 和 `kubelet` 中的
[`DRAExtendedResource` 特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/#DRAExtendedResource)控制。

有关请求扩展资源的实际演练，
请参阅[将扩展资源分配给容器](/zh-cn/docs/tasks/configure-pod-container/extended-resource/)。
