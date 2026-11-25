# 集群网络系统

集群网络系统是 Kubernetes 的核心部分，但是想要准确理解它的工作原理可是个不小的挑战。
下面列出的是网络系统的的四个主要问题：

1. 高度耦合的容器间通信：这个已经被 Pod
   和 `localhost` 通信解决了。
2. Pod 间通信：这是本文档讲述的重点。
3. Pod 与 Service 间通信：涵盖在 [Service](/zh-cn/docs/concepts/services-networking/service/) 中。
4. 外部与 Service 间通信：也涵盖在 Service 中。

Kubernetes 的宗旨就是在应用之间共享机器。
通常来说，共享机器需要两个应用之间不能使用相同的端口，但是在多个应用开发者之间
去大规模地协调端口是件很困难的事情，而且容易引入开发者无法控制的集群层面的问题。

动态分配端口也会给系统带来很多复杂度 - 每个应用都需要设置一个端口的参数，
而 API 服务器还需要知道如何将动态端口数值插入到配置模块中，服务也需要知道如何找到对方等等。
与其去解决这些问题，Kubernetes 选择了其他不同的方法。

要了解 Kubernetes 网络模型，请参阅[此处](/zh-cn/docs/concepts/services-networking/)。

## Kubernetes IP 地址范围   {#kubernetest-ip-address-ranges}

Kubernetes 集群需要从以下组件中配置的可用地址范围中为 Pod、Service 和 Node 分配不重叠的 IP 地址：

- 配置网络插件并向 Pod 分配 IP 地址。
- 配置 kube-apiserver 并向 Service 分配 IP 地址。
- 配置 kubelet 或 cloud-controller-manager 并向 Node 分配 IP 地址。

[图片未纳入文字评测：/zh-cn/docs/images/kubernetes-cluster-network.svg]

## 集群网络类型   {#cluster-network-ipfamilies}

根据配置的 IP 协议族，Kubernetes 集群可以分为以下几类：

- 仅 IPv4：配置网络插件、kube-apiserver 和 kubelet/cloud-controller-manager 来仅分配 IPv4 地址。
- 仅 IPv6：配置网络插件、kube-apiserver 和 kubelet/cloud-controller-manager 来仅分配 IPv6 地址。
- IPv4/IPv6 或 IPv6/IPv4 [双协议栈](/zh-cn/docs/concepts/services-networking/dual-stack/)：
  - 配置网络插件来分配 IPv4 和 IPv6 地址。
  - 配置kube-apiserver 来分配 IPv4 和 IPv6 地址。
  - 配置kubelet 或 cloud-controller-manager 来分配 IPv4 和 IPv6 地址。
  - 所有组件必须就配置的主要 IP 协议族达成一致。

Kubernetes 集群只考虑 Pod、Service 和 Node 对象中存在的 IP 协议族，而不考虑所表示对象的现有 IP。
例如，服务器或 Pod 的网络接口上可能配置了多个 IP 地址，但在实现 Kubernetes 网络模型以及定义集群类型时，
**只有** `node.status.addresses` 或 `pod.status.ips` 中列出的 IP 地址才会被纳入考虑范围。

## 如何实现 Kubernetes 的网络模型    {#how-to-implement-the-kubernetes-network-model}

网络模型由各节点上的容器运行时来实现。最常见的容器运行时使用
[Container Network Interface](https://github.com/containernetworking/cni) (CNI) 插件来管理其网络和安全能力。
来自不同供应商 CNI 插件有很多。其中一些仅提供添加和删除网络接口的基本功能，
而另一些则提供更复杂的解决方案，例如与其他容器编排系统集成、运行多个 CNI 插件、高级 IPAM 功能等。

请参阅[此页面](/zh-cn/docs/concepts/cluster-administration/addons/#networking-and-network-policy)了解
Kubernetes 支持的网络插件的非详尽列表。

## ## 接下来

网络模型的早期设计、运行原理都在[联网设计文档](https://git.k8s.io/design-proposals-archive/network/networking.md)里有详细描述。
关于未来的计划，以及旨在改进 Kubernetes 联网能力的一些正在进行的工作，可以参考 SIG Network
的 [KEPs](https://github.com/kubernetes/enhancements/tree/master/keps/sig-network)。
