# 动态资源分配

功能状态：DynamicResourceAllocation，Kubernetes 1.35，stable；首次引入于 1.30。默认启用。门控值已锁定。

本节介绍 Kubernetes 中的**动态资源分配（Dynamic Resource Allocation，DRA）**。

DRA 是Kubernetes 提供的一项特性，允许你在多个 Pod 之间请求和共享资源。  
这些资源通常是挂接的设备，例如硬件加速器。

借助 DRA，设备驱动和集群管理员可以定义设备的**类别**，这些类别可供工作负载中的 Pod 申领。
Kubernetes 会将匹配的设备分配给特定的申领，并将相应的 Pod 调度到能够访问这些已分配设备的节点上。

使用 DRA 分配资源提供了与[动态卷制备](/zh-cn/docs/concepts/storage/dynamic-provisioning/)类似的体验：
你使用 PersistentVolumeClaims 从存储类中**申领**存储容量，
并在 Pod 中请求使用该已申领的容量。

### DRA 的优势 {#dra-benefits}

DRA 提供了一种灵活的方式来分类、请求和使用集群中的设备。
使用 DRA 具有以下优势：

* **灵活的设备过滤：** 使用公共表达式语言（CEL）对特定设备属性进行细粒度过滤。
* **设备共享：** 通过引用相应的资源申领，与多个容器或 Pod 共享同一资源。
* **设备配置：** 将特定于供应商的设备配置附加到你的资源申领，
  启用按工作负载的设备配置，而非如今的按节点设备配置。
* **集中式设备分类：** 设备驱动和集群管理员可以使用 DeviceClass
  为应用运维人员提供针对各种用例优化的硬件类别。
  例如，你可以为通用工作负载创建成本优化的 DeviceClass，
  为关键作业创建高性能的 DeviceClass。
* **简化的 Pod 请求：** 通过 DRA，应用运维人员无需在 Pod 资源请求中指定设备数量。
  相反，Pod 引用一个资源申领，该申领中的设备配置将应用于该 Pod。

与需要按容器请求设备、不支持设备共享且不支持基于表达式的设备过滤的
[设备插件](/zh-cn/docs/concepts/extend-kubernetes/compute-storage-net/device-plugins/)相比，
这些优势在设备分配工作流方面提供了显著改进。

### DRA 用户类型 {#dra-user-types}

使用 DRA 分配设备的工作流涉及以下类型的用户：

* **设备所有者（Device owner）：** 负责设备。设备所有者可以是商业供应商、集群运维人员或其他实体。
  要使用 DRA，设备必须具备兼容 DRA 的驱动，这些驱动需要完成以下工作：

  * 创建 ResourceSlice，为 Kubernetes 提供关于节点和资源的信息。
  * 当集群中的资源容量发生变化时更新 ResourceSlice。
  * 根据申领配置设备，并通过容器设备接口（Container Device Interface，CDI）
    将它们附加到容器。
  * 可选地，创建工作负载运维人员可用于申领设备的 DeviceClass。

* **集群管理员（Cluster admin）：** 负责配置集群和节点、附加设备、安装驱动等类似任务。
  要使用 DRA，集群管理员需要完成以下工作：

  * 将设备附加到节点。
  * 安装支持 DRA 的设备驱动。
  * 可选地，创建工作负载运维人员可用于申领设备的 DeviceClass。

* **工作负载运维人员（Workload operator）：** 负责在集群中部署和管理工作负载。
  要使用 DRA 为 Pod 分配设备，工作负载运维人员需要完成以下工作：

  * 创建 ResourceClaim 或 ResourceClaimTemplate，以在 DeviceClass 中请求特定配置。
  * 部署使用特定 ResourceClaim 或 ResourceClaimTemplate 的工作负载。

## 限制

* Kubernetes 调度器不支持为 DRA 资源进行
  [抢占](/zh-cn/docs/concepts/scheduling-eviction/pod-priority-preemption/)。
  这意味着在节点上运行并使用 DRA 资源的现有 Pod，
  不能被同样需要 DRA 资源的更高优先级 Pod 抢占。
  高优先级 Pod 将保持挂起状态，直到设备可用 —— 这发生在冲突 Pod 终止或被手动删除时。

## ## 接下来

- [在集群中设置 DRA](/zh-cn/docs/tasks/configure-pod-container/assign-resources/set-up-dra-cluster/)
- [使用 DRA 为工作负载分配设备](/zh-cn/docs/tasks/configure-pod-container/assign-resources/allocate-devices-dra/)
- [访问 DRA 设备元数据](/zh-cn/docs/tasks/configure-pod-container/assign-resources/access-dra-device-metadata/)
- 有关设计的更多信息，请参阅
  [使用结构化参数的动态资源分配](https://github.com/kubernetes/enhancements/tree/master/keps/sig-node/4381-dra-structured-parameters)
  KEP。
