# 集群管理员使用动态资源分配的良好实践

本文介绍在利用动态资源分配（DRA）配置 Kubernetes 集群时的良好实践。这些指示说明适用于集群管理员。

## 分离 DRA 相关 API 的权限   {#separate-permissions-to-dra-related-apis}

DRA 是通过多个不同的 API 进行编排的。使用鉴权工具（如 RBAC 或其他方案）根据用户的角色来控制对相关 API 的访问权限。

通常情况下，DeviceClass 和 ResourceSlice 应仅限管理员和 DRA 驱动访问。
通过申领机制来部署 Pod 的集群运维人员将需要访问 ResourceClaim API 和 ResourceClaimTemplate API。
这两个 API 的作用范围都是命名空间。

## 部署与维护 DRA 驱动  {#dra-driver-deployment-and-maintenance}

DRA 驱动是运行在集群的每个节点上的第三方应用，对接节点的硬件和 Kubernetes 原生的 DRA 组件。
安装方式取决于你所选的驱动，但通常会作为 DaemonSet 部署到集群中所有或部分节点上（可使用节点选择算符或类似机制）。

### 使用支持无缝升级的驱动（如可用） {#use-drivers-with-seamless-upgrade-if-available}

DRA 驱动实现
[`kubeletplugin` 包接口](https://pkg.go.dev/k8s.io/dynamic-resource-allocation/kubeletplugin)。
你的驱动可能通过实现此接口的一个属性，支持两个版本共存一段时间，从而实现**无缝升级**。
该功能仅适用于 kubelet v1.33 及更高版本，对于运行旧版 Kubernetes 的节点所组成的异构集群，
可能不支持这种功能。请查阅你的驱动文档予以确认。

如果你的环境支持无缝升级，建议使用此功能以最大限度地减少驱动升级期间的调度延迟。

如果你无法使用无缝升级，则在升级期间因驱动停机时，你可能会观察到：

* 除非相关申领已准备就绪，否则 Pod 无法启动。
* 在驱动可能之前，使用了申领的最后一个 Pod 的清理操作将延迟。
  此 Pod 不会被标记为已终止，这会阻止此 Pod 所用的资源被其他 Pod 重用。
* 运行中的 Pod 将继续运行。

### 确认你的 DRA 驱动暴露了存活探针并加以利用 {#confirm-your-dra-driver-exposes-a-liveness-probe-and-utilize-it}

你的 DRA 驱动可能已实现用于健康检查的 gRPC 套接字，这是 DRA 驱动的良好实践之一。
最简单的利用方式是将该 grpc 套接字配置为部署 DRA 驱动 DaemonSet 的存活探针。
驱动文档或部署工具可能已包括此项配置，但如果你是自行配置或未以 Kubernetes Pod 方式运行 DRA 驱动，
确保你的编排工具在该 grpc 套接字健康检查失败时能重启驱动。这样可以最大程度地减少 DRA 驱动的意外停机，
并提升其自我修复能力，从而减少调度延迟或排障时间。

### 腾空节点时尽可能最后再腾空 DRA 驱动  {#when-draining-a-node-drain-the-dra-driver-as-late-as-possible}

DRA 驱动负责取消为 Pod 分配的任意设备的就绪状态。如果在具有申领的 Pod 被删除之前 DRA
驱动就被腾空，它将无法完成清理流程。
如果你实现了自定义的节点腾空逻辑，建议在终止 DRA 驱动之前检查是否存在已分配/已保留的
ResourceClaim 或 ResourceClaimTemplate。

## 在大规模环境中在高负载场景下监控和调优组件  {#monitor-and-tune-components-for-higher-load-especially-in-high-scale-environments}

控制面组件 kube-scheduler
以及 kube-controller-manager
中的内部 ResourceClaim 控制器在调度使用 DRA 申领的 Pod 时承担了大量任务。与不使用 DRA 的 Pod 相比，
这些组件所需的 API 服务器调用次数、内存和 CPU 使用率都更高。此外，
节点本地组件（如 DRA 驱动和 kubelet）也在创建 Pod 沙箱时使用 DRA API 分配硬件请求资源。
尤其在集群节点数量众多或大量工作负载依赖 DRA 定义的资源申领时，
集群管理员应当预先为相关组件配置合理参数以应对增加的负载。

组件配置不当可能会直接或连锁地影响 Pod 生命周期中的多个环节。例如，如果 `kube-scheduler`
组件的 QPS 和 Burst 配置值过低，调度器可能能快速识别适合的节点，但绑定 Pod 到节点的过程则会变慢。
在使用 DRA 的调度流程中，`kube-controller-manager` 中 client-go 的 QPS 和 Burst 参数尤为关键。

集群调优所需的具体数值取决于多个因素，如节点/Pod 数量、Pod 创建速率、变化频率，甚至与是否使用 DRA 无关。更多信息请参考
[SIG Scalability README 中的可扩缩性阈值](https://github.com/kubernetes/community/blob/main/sig-scalability/configs-and-limits/thresholds.md)。
在一项针对启用了 DRA 的 100 节点集群的规模测试中，部署了 720 个长生命周期 Pod（90% 饱和度）和 80
个短周期 Pod（10% 流失，重复 10 次），作业创建 QPS 为 10。将 `kube-controller-manager` 的 QPS
设置为 75、Burst 设置为 150，能达到与非 DRA 部署中相同的性能指标。在这个下限设置下，
客户端速率限制器能有效保护 API 服务器避免突发请求，同时不影响 Pod 启动 SLO。
这可作为一个良好的起点。你可以通过监控下列指标，进一步判断对 DRA 性能影响最大的组件，从而优化其配置。
有关 Kubernetes 中所有稳定指标的更多信息，请参阅 [Kubernetes 指标参考](/zh-cn/docs/reference/instrumentation/metrics/)。

### `kube-controller-manager` 指标  {#kube-controller-manager-metrics}

以下指标聚焦于由 `kube-controller-manager` 组件管理的内部 ResourceClaim 控制器：

* 工作队列添加速率：监控 
```promql
sum(rate(workqueue_adds_total{name="resource_claim"}[5m]))
```
，
  以衡量任务加入 ResourceClaim 控制器的速度。
* 工作队列深度：跟踪 
```promql
sum(workqueue_depth{endpoint="kube-controller-manager", name="resource_claim"})
```
，
  识别 ResourceClaim 控制器中是否存在积压。
* 工作队列处理时长：观察
  
```promql
histogram_quantile(0.99, sum(rate(workqueue_work_duration_seconds_bucket{name="resource_claim"}[5m])) by (le))
```
，
  以了解 ResourceClaim 控制器的处理速度。

如果你观察到工作队列添加速率低、工作队列深度高和/或工作队列处理时间长，
则说明控制器性能可能不理想。你可以考虑调优 QPS、Burst 以及 CPU/内存配置。

如果你观察到工作队列添加速率高、工作队列深度高，但工作队列处理时间合理，
则说明控制器正在有效处理任务，但并发可能不足。由于控制器并发是硬编码的，
所以集群管理员可以通过降低 Pod 创建 QPS 来减缓资源申领任务队列的压力。

### `kube-scheduler` 指标 {#kube-scheduler-metrics}

以下调度器指标是所有 Pod 的整体性能聚合指标，不仅限于使用 DRA 的 Pod。需注意，
这些端到端指标最终也会受到 `kube-controller-manager` 创建 ResourceClaim
的性能影响，尤其在广泛使用 ResourceClaimTemplate 的部署中。

* 调度器端到端耗时：监控
  
```promql
histogram_quantile(0.99, sum(increase(scheduler_pod_scheduling_sli_duration_seconds_bucket[5m])) by (le))
```
。
* 调度器算法延迟：跟踪
  
```promql
histogram_quantile(0.99, sum(increase(scheduler_scheduling_algorithm_duration_seconds_bucket[5m])) by (le))
```
。

### `kubelet` 指标  {#kubelet-metrics}

当绑定到节点的 Pod 必须满足 ResourceClaim 时，kubelet 会调用 DRA 驱动的
`NodePrepareResources` 和 `NodeUnprepareResources` 方法。你可以通过以下指标从 kubelet 的角度观察其行为。

* kubelet 调用 PrepareResources：监控
  
```promql
histogram_quantile(0.99, sum(rate(dra_operations_duration_seconds_bucket{operation_name="PrepareResources"}[5m])) by (le))
```
。
* kubelet 调用 UnprepareResources：跟踪
  
```promql
histogram_quantile(0.99, sum(rate(dra_operations_duration_seconds_bucket{operation_name="UnprepareResources"}[5m])) by (le))
```
。

### DRA kubeletplugin 操作  {#dra-kubeletplugin-operations}

DRA 驱动实现 [`kubeletplugin` 包接口](https://pkg.go.dev/k8s.io/dynamic-resource-allocation/kubeletplugin)，
该接口会针对底层 gRPC 操作 `NodePrepareResources` 和 `NodeUnprepareResources` 暴露指标。
你可以从内部 kubeletplugin 的角度通过以下指标观察其行为：

* DRA kubeletplugin 的 NodePrepareResources 操作：观察
  
```promql
histogram_quantile(0.99, sum(rate(dra_grpc_operations_duration_seconds_bucket{method_name=~".*NodePrepareResources"}[5m])) by (le))
```
。
* DRA kubeletplugin 的 NodeUnprepareResources 操作：观察
  
```promql
histogram_quantile(0.99, sum(rate(dra_grpc_operations_duration_seconds_bucket{method_name=~".*NodeUnprepareResources"}[5m])) by (le))
```
。

## ## 接下来

* [进一步了解 DRA](/zh-cn/docs/concepts/scheduling-eviction/dynamic-resource-allocation)
* 阅读 [Kubernetes 指标参考](/zh-cn/docs/reference/instrumentation/metrics/)
