# 安装扩展（Addon）

本部分链接到提供 Kubernetes 所需功能的第三方项目。Kubernetes 项目作者不负责这些项目。此页面遵循[CNCF 网站指南](https://github.com/cncf/foundation/blob/main/policies-guidance/website-guidelines.md)，按字母顺序列出项目。要将项目添加到此列表中，请在提交更改之前阅读[内容指南](/zh-cn/docs/contribute/style/content-guide/#third-party-content)。

Add-on 扩展了 Kubernetes 的功能。

本文列举了一些可用的 add-on 以及到它们各自安装说明的链接。该列表并不试图详尽无遗。

## 联网和网络策略   {#networking-and-network-policy}

* [ACI](https://www.github.com/noironetworks/aci-containers) 通过 Cisco ACI 提供集成的容器网络和安全网络。
* [Antrea](https://antrea.io/) 在第 3/4 层执行操作，为 Kubernetes
  提供网络连接和安全服务。Antrea 利用 Open vSwitch 作为网络的数据面。
  Antrea 是一个[沙箱级的 CNCF 项目](https://www.cncf.io/projects/antrea/)。
* [Calico](https://www.tigera.io/project-calico/) 是一个联网和网络策略供应商。
  Calico 支持一套灵活的网络选项，因此你可以根据自己的情况选择最有效的选项，包括非覆盖和覆盖网络，带或不带 BGP。
  Calico 使用相同的引擎为主机、Pod 和（如果使用 Istio 和 Envoy）应用程序在服务网格层执行网络策略。

* [Canal](https://projectcalico.docs.tigera.io/getting-started/kubernetes/flannel/flannel)
  结合 Flannel 和 Calico，提供联网和网络策略。
* [Cilium](https://github.com/cilium/cilium) 是一种网络、可观察性和安全解决方案，具有基于 eBPF 的数据平面。
  Cilium 提供了简单的 3 层扁平网络，
  能够以原生路由（routing）和覆盖/封装（overlay/encapsulation）模式跨越多个集群，
  并且可以使用与网络寻址分离的基于身份的安全模型在 L3 至 L7 上实施网络策略。
  Cilium 可以作为 kube-proxy 的替代品；它还提供额外的、可选的可观察性和安全功能。
  Cilium 是一个[毕业级别的 CNCF 项目](https://www.cncf.io/projects/cilium/)。

* [CNI-Genie](https://github.com/cni-genie/CNI-Genie) 使 Kubernetes 无缝连接到
  Calico、Canal、Flannel 或 Weave 等其中一种 CNI 插件。
  CNI-Genie 是一个[沙箱级的 CNCF 项目](https://www.cncf.io/projects/cni-genie/)。
* [Contiv](https://contivpp.io/) 为各种用例和丰富的策略框架提供可配置的网络
  （带 BGP 的原生 L3、带 vxlan 的覆盖、标准 L2 和 Cisco-SDN/ACI）。
  Contiv 项目完全[开源](https://github.com/contiv)。
  其[安装程序](https://github.com/contiv/install) 提供了基于 kubeadm 和非 kubeadm 的安装选项。

* [Contrail](https://www.juniper.net/us/en/products-services/sdn/contrail/contrail-networking/) 基于
  [Tungsten Fabric](https://tungsten.io)，是一个开源的多云网络虚拟化和策略管理平台。
  Contrail 和 Tungsten Fabric 与业务流程系统（例如 Kubernetes、OpenShift、OpenStack 和 Mesos）集成在一起，
  为虚拟机、容器或 Pod 以及裸机工作负载提供了隔离模式。

* [Flannel](https://github.com/flannel-io/flannel#deploying-flannel-manually)
  是一个可以用于 Kubernetes 的 overlay 网络提供者。
* [Gateway API](/zh-cn/docs/concepts/services-networking/gateway/) 是一个由
  [SIG Network](https://github.com/kubernetes/community/tree/main/sig-network) 社区管理的开源项目，
  为服务网络建模提供一种富有表达力、可扩展和面向角色的 API。
* [Knitter](https://github.com/ZTE/Knitter/) 是在一个 Kubernetes Pod 中支持多个网络接口的插件。

* [kube-router](https://github.com/cloudnativelabs/kube-router) 是一个开源的、开箱即用的
  Kubernetes 网络解决方案，旨在提供简易的操作和高性能。
  它利用 Kubernetes API、BGP 和 Golang 构建控制路径，并利用 Linux
  网络原语（IPVS、nftables 等）构建数据路径。
  它提供了一种低开销的替代方案，并同时应用于 k0s 和 k3s。
* [Multus](https://github.com/k8snetworkplumbingwg/multus-cni) 是一个多插件，
  可在 Kubernetes 中提供多种网络支持，以支持所有 CNI 插件（例如 Calico、Cilium、Contiv、Flannel），
  而且包含了在 Kubernetes 中基于 SRIOV、DPDK、OVS-DPDK 和 VPP 的工作负载。

* [OVN-Kubernetes](https://github.com/ovn-org/ovn-kubernetes/) 是一个 Kubernetes 网络驱动，
  基于 [OVN（Open Virtual Network）](https://github.com/ovn-org/ovn/)实现，是从 Open vSwitch（OVS）
  项目衍生出来的虚拟网络实现。OVN-Kubernetes 为 Kubernetes 提供基于覆盖网络的网络实现，
  包括一个基于 OVS 实现的负载均衡器和网络策略。
* [Nodus](https://github.com/akraino-edge-stack/icn-nodus) 是一个基于 OVN 的 CNI 控制器插件，
  提供基于云原生的服务功能链（SFC）。

* [NSX-T](https://docs.vmware.com/en/VMware-NSX-T-Data-Center/index.html) 容器插件（NCP）
  提供了 VMware NSX-T 与容器协调器（例如 Kubernetes）之间的集成，以及 NSX-T 与基于容器的
  CaaS / PaaS 平台（例如关键容器服务（PKS）和 OpenShift）之间的集成。
* [Nuage](https://github.com/nuagenetworks/nuage-kubernetes/blob/v5.1.1-1/docs/kubernetes-1-installation.rst)
  是一个 SDN 平台，可在 Kubernetes Pods 和非 Kubernetes 环境之间提供基于策略的联网，并具有可视化和安全监控。
* [Romana](https://github.com/romana) 是一个 Pod 网络的第三层解决方案，并支持
  [NetworkPolicy](/zh-cn/docs/concepts/services-networking/network-policies/) API。

* [Spiderpool](https://github.com/spidernet-io/spiderpool) 为 Kubernetes
  提供了下层网络和 RDMA 高速网络解决方案，兼容裸金属、虚拟机和公有云等运行环境。
* [Terway](https://github.com/AliyunContainerService/terway/)
  是一套基于阿里云 VPC 和 ECS 网络产品的 CNI 插件，能够在阿里云环境中提供原生的 VPC 网络和网络策略支持。
* [Weave Net](https://github.com/rajch/weave#using-weave-on-kubernetes)
  提供在网络分组两端参与工作的联网和网络策略，并且不需要额外的数据库。

## 服务发现   {#service-discovery}

* [CoreDNS](https://coredns.io) 是一种灵活的，可扩展的 DNS 服务器，
  可以[安装](https://github.com/coredns/helm)为集群内的 Pod 提供 DNS 服务。

## 可视化管理   {#visualization-and-control}

* [Dashboard](https://github.com/kubernetes/dashboard#kubernetes-dashboard)
  是一个 Kubernetes 的 Web 控制台界面。
* [Headlamp](https://headlamp.dev/) 是一个**可扩展的 Kubernetes 用户界面（UI）**，
  既可以**以集群内方式部署**，也可以**作为桌面应用程序使用**。

## 基础设施   {#infrastructure}

* [KubeVirt](https://kubevirt.io/user-guide/#/installation/installation) 是可以让 Kubernetes
  运行虚拟机的 add-on。通常运行在裸机集群上。
* [节点问题检测器](https://github.com/kubernetes/node-problem-detector) 在 Linux 节点上运行，
  并将系统问题报告为[事件](/zh-cn/docs/reference/kubernetes-api/cluster-resources/event-v1/)
  或[节点状况](/zh-cn/docs/concepts/architecture/nodes/#condition)。

## 插桩  {#instrumentation}

* [kube-state-metrics](/zh-cn/docs/concepts/cluster-administration/kube-state-metrics)

## 遗留 Add-on   {#legacy-addons}

还有一些其它 add-on 归档在已废弃的 [cluster/addons](https://git.k8s.io/kubernetes/cluster/addons) 路径中。

维护完善的 add-on 应该被链接到这里。欢迎提出 PR！
