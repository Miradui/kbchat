# 调度、抢占和驱逐

在 Kubernetes 中，调度（scheduling）指的是确保 Pod
匹配到合适的节点，
以便 kubelet 能够运行它们。
抢占（Preemption）指的是终止低优先级的
Pod 以便高优先级的 Pod 可以调度到 Node 上的过程。
驱逐（Eviction）是在资源匮乏的节点上，主动让一个或多个 Pod 失效的过程。

## 调度   {#scheduling}

* [Kubernetes 调度器](/zh-cn/docs/concepts/scheduling-eviction/kube-scheduler/)
* [将 Pod 指派到节点](/zh-cn/docs/concepts/scheduling-eviction/assign-pod-node/)
* [Pod 开销](/zh-cn/docs/concepts/scheduling-eviction/pod-overhead/)
* [Pod 拓扑分布约束](/zh-cn/docs/concepts/scheduling-eviction/topology-spread-constraints/)
* [污点和容忍度](/zh-cn/docs/concepts/scheduling-eviction/taint-and-toleration/)
* [动态资源分配](/zh-cn/docs/concepts/scheduling-eviction/dynamic-resource-allocation)
* [调度器性能调试](/zh-cn/docs/concepts/scheduling-eviction/scheduler-perf-tuning/)
* [扩展资源的资源装箱](/zh-cn/docs/concepts/scheduling-eviction/resource-bin-packing/)
* [Pod 调度就绪](/zh-cn/docs/concepts/scheduling-eviction/pod-scheduling-readiness/)
* [PodGroup 调度](/zh-cn/docs/concepts/scheduling-eviction/podgroup-scheduling/)
* [Gang 调度](/zh-cn/docs/concepts/scheduling-eviction/gang-scheduling/)
* [拓扑感知调度](/zh-cn/docs/concepts/scheduling-eviction/topology-aware-scheduling/)
* [工作负载感知抢占](/zh-cn/docs/concepts/scheduling-eviction/workload-aware-preemption/)
* [Descheduler](https://github.com/kubernetes-sigs/descheduler#descheduler-for-kubernetes)
* [节点声明特性](/zh-cn/docs/concepts/scheduling-eviction/node-declared-features/)

## Pod 干扰   {#pod-disruption}

[Pod 干扰](/zh-cn/docs/concepts/workloads/pods/disruptions/) 是指节点上的
Pod 被自愿或非自愿终止的过程。

自愿干扰是由应用程序所有者或集群管理员有意启动的。非自愿干扰是无意的，可能由不可避免的问题触发，
如节点耗尽资源或 Pod 被意外删除。

* [Pod 优先级和抢占](/zh-cn/docs/concepts/scheduling-eviction/pod-priority-preemption/)
* [节点压力驱逐](/zh-cn/docs/concepts/scheduling-eviction/node-pressure-eviction/)
* [API 发起的驱逐](/zh-cn/docs/concepts/scheduling-eviction/api-eviction/)
