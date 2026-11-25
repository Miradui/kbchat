# 安全

Kubernetes 文档的这一部分内容的旨在引导你学习如何更安全地运行工作负载，
以及维护 Kubernetes 集群的基本安全性。

Kubernetes 基于云原生架构，并借鉴了
CNCF 有关云原生信息安全良好实践的建议。

请阅读[云原生安全和 Kubernetes](/zh-cn/docs/concepts/security/cloud-native-security/)，
了解有关如何保护集群及其上运行的应用程序的更广泛背景信息。

## Kubernetes 安全机制 {#security-mechanisms}

Kubernetes 包含多个 API 和安全组件，
以及定义[策略](#policies)的方法，这些策略可以作为你的信息安全管理的一部分。

### 控制平面保护

任何 Kubernetes 集群的一个关键安全机制是[控制对 Kubernetes API 的访问](/zh-cn/docs/concepts/security/controlling-access)。

Kubernetes 希望你配置并使用 TLS，
以便在控制平面内以及控制平面与其客户端之间提供[传输中的数据加密](/zh-cn/docs/tasks/tls/managing-tls-in-a-cluster/)。
你还可以为 Kubernetes 控制平面中存储的数据启用静态加密；
这与对你自己的工作负载数据使用静态加密不同，后者可能也是一个好主意。

### Secret

[Secret](/zh-cn/docs/concepts/configuration/secret/) API
为需要保密的配置值提供基本保护。

### 工具负载保护

实施 [Pod 安全标准](/zh-cn/docs/concepts/security/pod-security-standards/)以确保
Pod 及其容器得到适当隔离。如果需要，你还可以使用
[RuntimeClass](/zh-cn/docs/concepts/containers/runtime-class) 来配置自定义隔离。

[网络策略（NetworkPolicy)](/zh-cn/docs/concepts/services-networking/network-policies/)
可让控制 Pod 之间或 Pod 与集群外部网络之间的网络流量。

### 准入控制   {#admission-control}

[准入控制器](/zh-cn/docs/reference/access-authn-authz/admission-controllers/)是拦截
Kubernetes API 请求的插件，可以根据请求中的特定字段验证或修改请求。
精心设计这些控制器有助于避免 Kubernetes API 在版本更新过程中发生意外干扰。
有关设计注意事项，请参阅
[Admission Webhook 良好实践](/zh-cn/docs/concepts/cluster-administration/admission-webhooks-good-practices/)。

### 审计

Kubernetes [审计日志记录](/zh-cn/docs/tasks/debug/debug-cluster/audit/)提供了一组与安全相关、
按时间顺序排列的记录，记录了集群中的操作序列。
集群审计用户、使用 Kubernetes API 的应用程序以及控制平面本身生成的活动。

## 云提供商安全

本页面中的条目引用了 Kubernetes 外部的供应商。Kubernetes 项目的开发人员不对这些第三方产品（项目）负责。要将供应商、产品或项目添加到此列表中，请在提交更改之前阅读[内容指南](/zh-cn/docs/contribute/style/content-guide/#third-party-content)。[更多信息。](#third-party-content-disclaimer)

如果你在自己的硬件或不同的云平台上运行 Kubernetes 集群，请参阅对应云平台的文档以了解安全最佳实践。
以下是一些流行云提供商的安全文档的链接：

IaaS 提供商        | 链接 |
-------------------- | ------------ |
阿里云 | https://www.alibabacloud.com/trust-center |
亚马逊网络服务 | https://aws.amazon.com/security |
谷歌云平台 | https://cloud.google.com/security |
华为云 | https://www.huaweicloud.com/intl/en-us/securecenter/overallsafety |
IBM 云 | https://www.ibm.com/cloud/security |
微软 Azure | https://docs.microsoft.com/en-us/azure/security/azure-security |
Oracle 云基础设施| https://www.oracle.com/security |
腾讯云 | https://www.tencentcloud.com/solutions/data-security-and-information-protection |
VMware vSphere | https://www.vmware.com/solutions/security/hardening-guides |

## 策略

你可以使用 Kubernetes 原生机制定义安全策略，例如
[NetworkPolicy](/zh-cn/docs/concepts/services-networking/network-policies/)（对网络数据包过滤的声明式控制）
或 [ValidatingAdmissionPolicy](/zh-cn/docs/reference/access-authn-authz/validating-admission-policy/)
（对某人可以使用 Kubernetes API 进行哪些更改的声明性限制）。

你还可以依赖 Kubernetes 周边更广泛的生态系统的策略实现。
Kubernetes 提供了扩展机制，让这些生态系统项目在源代码审查、
容器镜像审批、API 访问控制、网络等方面实施自己的策略控制。

有关策略机制和 Kubernetes 的更多信息，请阅读[策略](/zh-cn/docs/concepts/policy/)。

## ## 接下来

了解相关的 Kubernetes 安全主题：

* [保护集群](/zh-cn/docs/tasks/administer-cluster/securing-a-cluster/)
* Kubernetes 中的[已知漏洞](/zh-cn/docs/reference/issues-security/official-cve-feed/)（以及更多信息的链接）
* [传输中的数据加密](/zh-cn/docs/tasks/tls/managing-tls-in-a-cluster/)（针对控制平面）
* [静态数据加密](/zh-cn/docs/tasks/administer-cluster/encrypt-data/)
* [控制对 Kubernetes API 的访问](/zh-cn/docs/concepts/security/controlling-access)
* Pod 的 [网络策略](/zh-cn/docs/concepts/services-networking/network-policies/)
* [Kubernetes 中的 Secret](/zh-cn/docs/concepts/configuration/secret/)
* [Pod 安全标准](/zh-cn/docs/concepts/security/pod-security-standards/)
* [运行时类](/zh-cn/docs/concepts/containers/runtime-class)

了解上下文：

* [云原生安全和 Kubernetes](/zh-cn/docs/concepts/security/cloud-native-security/)

获取认证：

* [Kubernetes 安全专家认证](https://training.linuxfoundation.org/certification/certified-kubernetes-security-specialist/)和官方培训课程。

阅读本节的更多内容：
