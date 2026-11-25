# Kubernetes 自我修复

Kubernetes 旨在通过自我修复能力来维护工作负载的健康和可用性。  
它能够自动替换失败的容器，在节点不可用时重新调度工作负载，
并确保系统的期望状态得以维持。

## 自我修复能力 {#self-healing-capabilities}

- **容器级重启：** 如果 Pod 中的某个容器失败，Kubernetes 会根据
  [`restartPolicy`](/zh-cn/docs/concepts/workloads/pods/pod-lifecycle/#restart-policy)
  定义的策略重启此容器。

- **副本替换：** 如果 [Deployment](/zh-cn/docs/concepts/workloads/controllers/deployment/)
  或 [StatefulSet](/zh-cn/docs/concepts/workloads/controllers/statefulset/) 中的某个 Pod 失败，
  Kubernetes 会创建一个替代 Pod，以维持指定的副本数量。  
  如果属于 [DaemonSet](/zh-cn/docs/concepts/workloads/controllers/daemonset/)
  的某个 Pod 失败，控制平面会在同一节点上创建一个替代 Pod。

- **持久存储恢复：** 如果某个节点正在运行一个挂载了持久卷（PV）
  的 Pod，且该节点发生故障，Kubernetes 可以将该卷重新挂载到另一个节点上的新 Pod。

- **服务的负载均衡：** 如果 [Service](/zh-cn/docs/concepts/services-networking/service/)
  背后的某个 Pod 失败，Kubernetes 会自动将其从 Service 的端点中移除，
  以确保流量仅路由到健康的 Pod。

以下是提供 Kubernetes 自我修复功能的一些关键组件：

- **[kubelet](/zh-cn/docs/concepts/architecture/#kubelet)：** 
  确保容器正在运行，并重启失败的容器。

- **Deployment（通过 ReplicaSet）、ReplicaSet、StatefulSet 和 DaemonSet 控制器：** 维持期望的 Pod 副本数量。

- **PersistentVolume 控制器：** 管理有状态工作负载的卷挂载和卸载。

## 注意事项 {#considerations}

- **存储故障：** 如果持久卷变得不可用，可能需要执行恢复步骤。

- **应用程序错误：** Kubernetes 可以重启容器，但底层的应用程序问题需要单独解决。

## ## 接下来 

- 进一步阅读 [Pod](/zh-cn/docs/concepts/workloads/pods/)
- 了解 [Kubernetes 控制器](/zh-cn/docs/concepts/architecture/controller/)
- 探索 [持久卷（PersistentVolume）](/zh-cn/docs/concepts/storage/persistent-volumes/)
- 阅读关于[节点自动扩展](/zh-cn/docs/concepts/cluster-administration/node-autoscaling/)。
  节点自动扩展还能够在集群中的节点发生故障时提供自动修复功能。
