# 协调领导者选举

功能状态：CoordinatedLeaderElection，Kubernetes 1.33，beta；首次引入于 1.31。默认禁用。使用前需配置相应特性门控。

Kubernetes 1.37 包含一个 Beta 特性，
允许控制平面组件通过**协调领导者选举**确定性地选择一个领导者。
这对于在集群升级期间满足 Kubernetes 版本偏差约束非常有用。
目前，唯一内置的选择策略是 `OldestEmulationVersion`，
此策略会优先选择最低仿真版本作为领导者，其次按二进制版本选择领导者，最后会按创建时间戳选择领导者。

## 启用协调领导者选举   {#enabling-coordinated-leader-election}

确保你在启动 API 服务器时
`CoordinatedLeaderElection` [特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/)被启用，
并且 `coordination.k8s.io/v1beta1` API 组被启用。

此操作可以通过设置 `--feature-gates="CoordinatedLeaderElection=true"`
和 `--runtime-config="coordination.k8s.io/v1beta1=true"` 标志来完成。

## 组件配置   {#component-configuration}

前提是你已启用 `CoordinatedLeaderElection` 特性门控**并且**
启用了 `coordination.k8s.io/v1beta1` API 组，
兼容的控制平面组件会自动使用 LeaseCandidate 和 Lease API 根据需要选举领导者。

对于 Kubernetes 1.37，当特性门控和 API 组被启用时，
两个控制平面组件（kube-controller-manager 和 kube-scheduler）会自动使用协调领导者选举。

## Kubernetes 组件的领导者选举  {#leader-selection-for-kubernetes-components}

Kubernetes 使用 [Lease API](/zh-cn/docs/concepts/architecture/leases/)
在高可用集群中对同一控制平面组件的多个实例执行领导者选举，例如 `kube-controller-manager` 或 `kube-scheduler`。

[Lease](/zh-cn/docs/concepts/architecture/leases/) 充当一种轻量级的分布式锁，存放在
[Kubernetes API 服务器](/zh-cn/docs/reference/command-line-tools-reference/kube-apiserver/)中。
某个组件的所有正在运行的实例都会监听或定期读取相关的 Lease 对象，以确定目前哪个实例正在充当领导者。

[Lease API](/zh-cn/docs/reference/kubernetes-api/cluster-resources/lease-v1/) 定义如下字段：

`holderIdentity`
: 当前领导者的标识（例如：Pod 名称或基于主机名的字符串）。

`acquireTime`
: 获得领导权时的时间戳。

`renewTime`
: 领导者最近一次续约的时间戳。

`leaseDurationSeconds`
: 租约的有效期（候选实例在尝试获取过期租约之前，应等待此时间再加上一小段宽限时间）。

`leaseTransitions`
: 领导权发生变更的次数。

这些字段表明哪个实例拥有领导权，以及该领导权的有效期。

当 [Lease](/zh-cn/docs/concepts/architecture/leases/) 不存在或已经过期
（当前时间 > `renewTime` + `leaseDurationSeconds`）时，候选实例尝试使用自己的身份更新此 Lease。
Kubernetes 通过对象的 `resourceVersion` 使用 **乐观并发控制**：
在并发更新时，由于版本不匹配，只有一个更新会成功。更新被接受的实例将成为**领导者**。

Kubernetes 使用 [LeaseCandidate](/zh-cn/docs/reference/kubernetes-api/cluster-resources/lease-candidate-v1beta1/) API
来管理领导者选举。`kube-controller-manager` 和 `kube-scheduler` 这类控制平面组件通过创建 LeaseCandidate
对象来注册自己作为候选者，这些对象跟踪所有参与领导权竞争的实例，并包含候选者的身份、二进制版本和仿真版本等元数据。

在选举过程中，候选者通过共享的 [Lease](/zh-cn/docs/concepts/architecture/leases/) 进行协调。
Kubernetes 控制平面保证只有一个候选者能够成功获取 [Lease](/zh-cn/docs/concepts/architecture/leases/)
并承担**领导者**角色，而其他实例则保持为跟随者。如果当前**领导者**未能在设定的超时时段内续约
[Lease](/zh-cn/docs/concepts/architecture/leases/)，其余候选者将竞争获取领导权并选举新的**领导者**。

一旦当选，领导者通过更新 `renewTime` 字段来周期性地续约其 Lease
（例如，每隔 `leaseDurationSeconds` ÷ 2 进行一次续约，以避免在
[Lease](/zh-cn/docs/concepts/architecture/leases/) 即将过期时产生冲突）。
只要在租约过期之前完成续约，当前领导者实例就会继续保持领导权。
如果领导者崩溃、变得不可达，或停止续约 Lease，该 Lease 就会过期。
其他健康实例会检测到 Lease 过期并尝试发起新的选举。

这种机制确保即使某个组件为了稳定性和恢复能力运行了多个副本，
**任意时刻也只有一个实例会主动执行控制任务**，而其他实例处于待命状态，监听 Lease，并在需要时能够快速接管。
