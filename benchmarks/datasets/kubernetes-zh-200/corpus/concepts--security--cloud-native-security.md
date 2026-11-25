# 云原生安全和 Kubernetes

Kubernetes 基于云原生架构，并借鉴了
CNCF
有关云原生信息安全良好实践的建议。

继续阅读本页，了解 Kubernetes 如何设计以帮助你部署安全的云原生平台。

## 云原生信息安全

CNCF 关于云原生安全的[白皮书](https://github.com/cncf/tag-security/blob/main/security-whitepaper/v1/cloud-native-security-whitepaper-simplified-chinese.md)
介绍了适用于不同**生命周期阶段**的安全控制和实践。

## **开发**阶段 {#lifecycle-phase-develop}

- 确保开发环境的完整性。
- 在设计应用时，遵循信息安全的良好实践，
   并根据实际情况进行调整。
- 将最终用户的安全作为解决方案设计的一部分。

要达到这些目的，你可以：

1. 采用诸如[零信任](https://glossary.cncf.io/zh-cn/zero-trust-architecture/)类似的架构，
   尽可能缩小攻击面，对内部威胁也有效。
2. 建立考虑安全问题的代码审查流程。
3. 构建系统或应用程序的**威胁模型**，确定信任边界。
   利用该威胁模型识别风险，并帮助找到处理这些风险的方法。
4. 合理的采用高级的安全自动化机制，例如**模糊测试**和[**安全混沌工程**](https://glossary.cncf.io/zh-cn/security-chaos-engineering/)。

## **分发**阶段 {#lifecycle-phase-distribute}

- 针对你所运行的容器镜像，确保供应链安全。
- 针对运行应用程序的集群或其他组件，保证其供应链安全。
   例如：其他组件可能是你的云原生应用用于数据持久化的外部数据库。

要达到这些目的，你可以：

1. 扫描容器镜像和其他制品以查找已知漏洞。
2. 确保软件分发时采用传输加密技术，并建立软件源的信任链。
3. 在有更新，尤其是安全公告时，采用并遵循更新依赖项的流程。
4. 使用数字证书等验证机制来保证供应链可信。
5. 订阅信息反馈和其他机制，以提醒你安全风险。
6. 严格限制制品访问权限。将容器镜像存储在[私有仓库](/zh-cn/docs/concepts/containers/images/#using-a-private-registry)，
   仅允许已授权客户端拉取镜像。

## **部署**阶段 {#lifecycle-phase-deploy}

确保对要部署的内容、可部署的人员和可部署的位置进行适当限制。
你可以采取分发阶段的举措，例如验证容器镜像制品的加密身份。

你可以部署不同的应用程序和集群组件到不同的命名空间中。
容器和命名空间都提供了与信息安全相关的隔离机制。

当你部署 Kubernetes 时，也是在为应用程序的运行环境奠定基础：一个或多个 Kubernetes 集群。
该基础设施必须提供上层所期望的安全保障。

## **运行**阶段 {#lifecycle-phase-runtime}

运行阶段包含三个关键领域：[访问](#protection-runtime-access)、
[计算](#protection-runtime-compute)和[存储](#protection-runtime-storage)。

### 运行阶段的防护：访问 {#protection-runtime-access}

Kubernetes API 是集群运行的基础。保护 API 是提供可靠的集群安全性的关键。

Kubernetes 文档中的其他页面更详细地介绍了如何设置访问控制的具体细节。
[安全检查清单](/zh-cn/docs/concepts/security/security-checklist/)为你的集群提供了一套建议的基本检查。

除此之外，加固集群还意味着对访问 API 实施有效的[身份认证](/zh-cn/docs/concepts/security/controlling-access/#authentication)和
[鉴权](/zh-cn/docs/concepts/security/controlling-access/#authorization)。
使用 [ServiceAccount](/zh-cn/docs/concepts/security/service-accounts/) 
为工作负载和集群组件提供和管理安全身份。

Kubernetes 使用 TLS 保护 API 流量；确保在部署集群时采用了 TLS（包含工作节点和控制平面间的流量）加密方式，
并保护好加密密钥。如果使用 Kubernetes 自带的
[证书签名请求](/zh-cn/docs/reference/access-authn-authz/certificate-signing-requests/#certificate-signing-requests) API，
特别注意不要滥用它们。

### 运行阶段的防护：计算 {#protection-runtime-compute}

容器提供了两种功能：
不同应用程序间的隔离，以及将这些隔离的应用程序合并运行到同一台主机的机制。
隔离和聚合这两个方面意味着运行时安全需要权衡利弊，并找到合适的平衡点。

Kubernetes 依赖容器运行时
来设置和运行容器。Kubernetes 项目不会推荐特定的容器运行时，
你应当确保选用的运行时符合你的信息安全需要。

要在运行时保护计算资源，你可以：

1. 为应用程序强制采用 [Pod 安全性标准](/zh-cn/docs/concepts/security/pod-security-standards/)，
   确保它们仅以所需权限运行。
2. 在你的节点上运行专门为运行容器化工作负载的而设计的专用操作系统。
   它通常基于只读操作系统（**不可变镜像**），只提供运行容器所必须的服务。

   容器化专用操作系统有助于隔离系统组件，并在容器逃逸时减少攻击面。

3. 定义 [ResourceQuota](/zh-cn/docs/concepts/policy/resource-quotas/)
   以公平分配共享资源，并使用
   [LimitRange](/zh-cn/docs/concepts/policy/limit-range/)
   等机制确保 Pod 定义了资源需求。
4. 划分工作负载到不同节点上来提高隔离性。
   使用来自 Kubernetes 本身或生态系统的
   [节点隔离](/zh-cn/docs/concepts/scheduling-eviction/assign-pod-node/#node-isolation-restriction)机制，
   以确保具有不同信任上下文的 Pod 在不同的节点上运行。
5. 使用提供安全限制的
   容器运行时。
6. 在 Linux 节点上，使用 Linux 安全模式，例如 [AppArmor](/zh-cn/docs/tutorials/security/apparmor/)
  或者 [seccomp](/zh-cn/docs/tutorials/security/seccomp/)。

### 运行阶段的防护：存储 {#protection-runtime-storage}

要保护你的集群和应用运行使用的存储，你可以：

1. 为你的集群集成提供静态加密的外部存储插件。
2. 为 API 对象启用[静态加密](/zh-cn/docs/tasks/administer-cluster/encrypt-data/)。
3. 使用备份保证数据的持久性。在需要的时候，验证备份数据的可恢复性。
4. 集群节点和它们所依赖的任何网络存储都需要认证才能连接。
5. 在你的应用程序中实现数据加密。

对于加密密钥来说，在专用硬件中生成这些密钥是防范泄密风险的最佳防护。
**硬件安全模块**可以让你在不允许将安全密钥拷贝到其他地方的情况下执行加密操作。

### 网络和安全 {#networking-and-security}

你也应当考虑网络安全措施，
例如 [NetworkPolicy](/zh-cn/docs/concepts/services-networking/network-policies/)
或者[服务网格](https://glossary.cncf.io/zh-cn/service-mesh/)。
一些 Kubernetes 的网络插件使用虚拟专用网络（VPN）叠加等技术，
可以为集群网络提供加密功能。
从设计上，Kubernetes 允许你在你的集群中使用自有网络插件。
如果你使用托管 Kubernetes，提供商可能会为你选择一个网络插件。

你选用的网络插件和集成方式会对传输中的信息安全产生重大影响。

### 可观测性和运行时安全 {#Observability-and-runtime-security}

Kubernetes 允许你使用外部工具扩展集群。
你可以选择第三方解决方案帮助你监控或排查应用程序或运行集群的故障。
Kubernetes 自身还内置了一些基本的可观测性功能。
运行在容器中的代码可以生成日志，暴露指标或提供其他的可观测数据；
在部署时，你需要确保你的集群提供适当级别的安全保护。

如果你配置了指标看板或其他类似的组件，审查暴露指标数据到看板的组件链路和看板本身。
确保整个链路设计具有足够的弹性和足够的完整性保护，
只有这样，即便是在集群降级导致的事件发生时，你也可以依赖它。

在适当的情况下，在 Kubernetes 层之下部署一些安全举措，
例如加密后启动或验证分发时间（有助于确保日志和审计记录的真实性）。

对于高安全级别需求环境，部署加密保护措施，以确保日志防篡改和保密。

## ## 接下来

### 云原生安全 {#further-reading-cloud-native}

* CNCF 有关云原生安全的[白皮书](https://github.com/cncf/tag-security/blob/main/community/resources/security-whitepaper/v2/CNCF_cloud-native-security-whitepaper-May2022-v2.pdf)。
* CNCF 有关加固软件供应链的最佳实践[白皮书](https://github.com/cncf/tag-security/blob/f80844baaea22a358f5b20dca52cd6f72a32b066/supply-chain-security/supply-chain-security-paper/CNCF_SSCP_v1.pdf)。
* [Fixing the Kubernetes clusterf\*\*k: Understanding security from the kernel up](https://archive.fosdem.org/2020/schedule/event/kubernetes/)（FOSDEM 2020）
* [Kubernetes 安全最佳实践](https://www.youtube.com/watch?v=wqsUfvRyYpw)（Kubernetes Forum Seoul 2019）
* [朝着开箱即用的测量启动前进](https://www.youtube.com/watch?v=EzSkU3Oecuw)（Linux Security Summit 2016）

### Kubernetes 和信息安全 {#further-reading-k8s}

* [安全](/zh-cn/docs/concepts/security/)
* [保护集群](/zh-cn/docs/tasks/administer-cluster/securing-a-cluster/)
* 针对控制平面[传输中的数据加密](/zh-cn/docs/tasks/tls/managing-tls-in-a-cluster/) 
* [静态加密机密数据](/zh-cn/docs/tasks/administer-cluster/encrypt-data/)
* [Secret](/zh-cn/docs/concepts/configuration/secret/)
* [Kubernetes API 访问控制](/zh-cn/docs/concepts/security/controlling-access)
* 针对 Pod 的[网络策略](/zh-cn/docs/concepts/services-networking/network-policies/) 
* [Pod 安全性标准](/zh-cn/docs/concepts/security/pod-security-standards/)
* [容器运行时类](/zh-cn/docs/concepts/containers/runtime-class)
