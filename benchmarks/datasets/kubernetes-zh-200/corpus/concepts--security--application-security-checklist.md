# 应用安全检查清单

本检查清单旨在为开发者提供在 Kubernetes 上安全地运行应用的基本指南。
此列表并不打算详尽无遗，会随着时间的推移而不断演变。

关于如何阅读和使用本文档：

- 主题的顺序并不代表优先级的顺序。
- 在每章节的列表下面的段落中，都详细列举了一些检查项。
- 本检查清单假设“开发者”是与命名空间范围对象交互的 Kubernetes 集群用户。

**注意：**

单靠检查清单自身**不足以**获得良好的安全态势。
实现良好的安全态势需要持续的关注和改进，实现安全上有备无患的目标道路漫长，清单可作为征程上的第一步。
对于你的特定安全需求，此清单中的某些建议可能过于严格或过于宽松。
由于 Kubernetes 的安全性并不是“一刀切”的，因此针对每一类检查清单项目都应该做价值评估。

## 基础安全加固  {#base-security-hardening}

以下检查清单提供了一些适用于部署到 Kubernetes 的大多数应用的基础安全加固建议。

### 应用设计  {#application-design}

- [ ] 在设计应用时遵循正确的[安全原则](https://www.cncf.io/wp-content/uploads/2022/06/CNCF_cloud-native-security-whitepaper-May2022-v2.pdf)。
- [ ] 应用通过资源请求和限制配置了适当的 QoS 类。
  - [ ] 为工作负载设置一个内存限制，此限制等于或大于请求。
  - [ ] 敏感工作负载可以设置 CPU 限制。

### 服务账号   {#service-account}

- [ ] 避免使用 `default` ServiceAccount。为每个工作负载或微服务创建 ServiceAccount。
- [ ] 除非 Pod 特别要求访问 Kubernetes API 进行操作，否则 `automountServiceAccountToken` 应被设置为 `false`。

### Pod 级别的 `securityContext` 建议   {#security-context-pod}

- [ ] 设置 `runAsNonRoot: true`。
- [ ] 将容器配置为以低特权用户来执行（例如，使用 `runAsUser` 和 `runAsGroup`），
  并在容器镜像内配置恰当的文件或目录权限。
- [ ] 可以选择添加一个补充组，使用 `fsGroup` 访问持久卷。
- [ ] 应用部署到强制执行适当
  [Pod 安全标准](/zh-cn/docs/concepts/security/pod-security-standards/)的命名空间。
  如果你不能控制部署应用的集群以执行此类强制操作，请通过文档说明或实施额外的深度防御来避免遗漏。

### 容器级别的 `securityContext` 建议   {#security-context-container}

- [ ] 使用 `allowPrivilegeEscalation: false` 禁用特权提级。
- [ ] 使用 `readOnlyRootFilesystem: true` 将根文件系统配置为只读。
- [ ] 避免运行特权容器（设置 `privileged: false`）。
- [ ] 从容器中删除所有权能，只添加容器运行所需的特定权限。

### 基于角色的访问控制（RBAC）   {#rbac}

- [ ] 仅在必要时才授予 **create**、**patch**、**update** 和 **delete** 等权限。
- [ ] 避免创建允许用户能够创建或更新角色的 RBAC 权限，
  创建了这类权限可能导致[特权提级](/zh-cn/docs/reference/access-authn-authz/rbac/#privilege-escalation-prevention-and-bootstrapping)。
- [ ] 审查 `system:unauthenticated` 组的绑定，并在可能的情况下将其移除，
  因为这类绑定会为能够在网络层与 API 服务器通信的所有人提供访问权限。

对 **create**、**update** 和 **delete** 动词的授权要非常谨慎。
如果允许针对 Namespace 对象使用 **patch** 动词，
可能会[允许用户更新命名空间或部署上的标签](/zh-cn/docs/concepts/security/rbac-good-practices/#namespace-modification)，
这可能会增加攻击面。

对于敏感工作负载，考虑提供推荐的 ValidatingAdmissionPolicy 以进一步限制允许的写入操作。

### 镜像安全  {#image-security}

- [ ] 使用镜像扫描工具在将容器部署到 Kubernetes 集群之前扫描镜像。
- [ ] 使用容器签名在将容器部署到 Kubernetes 集群之前验证容器镜像签名。

### 网络策略  {#netowrk-policies}

- [ ] 配置 [NetworkPolicy](/zh-cn/docs/concepts/services-networking/network-policies/)，
  仅允许来自 Pod 的预期入站和出站流量。

确保你的集群提供并强制执行 NetworkPolicy。
如果你所编写的应用将被人们部署到不同集群中，请考虑你是否可以假设 NetworkPolicy 可用且被启用。

## 高级安全加固  {#advanced}

本指南的这一节涵盖了一些高级安全加固要点，这些要点可能在不同 Kubernetes 环境设置中有用。

### Linux 容器安全   {#linux-container-security}

为 Pod 容器配置 安全上下文。

- [ ] [为容器设置 Seccomp 配置](/zh-cn/docs/tasks/configure-pod-container/security-context/#set-the-seccomp-profile-for-a-container)。
- [ ] [使用 AppArmor 限制容器对资源的访问](/zh-cn/docs/tutorials/security/apparmor/)。
- [ ] [为容器赋予 SELinux 标签](/zh-cn/docs/tasks/configure-pod-container/security-context/#assign-selinux-labels-to-a-container)。

### 运行时类   {#runtime-classes}

- [ ] 为容器配置适当的运行时类。

本部分链接到提供 Kubernetes 所需功能的第三方项目。Kubernetes 项目作者不负责这些项目。此页面遵循[CNCF 网站指南](https://github.com/cncf/foundation/blob/main/policies-guidance/website-guidelines.md)，按字母顺序列出项目。要将项目添加到此列表中，请在提交更改之前阅读[内容指南](/zh-cn/docs/contribute/style/content-guide/#third-party-content)。

某些容器可能需要不同于集群默认运行时所提供的隔离级别。
你可以在 Pod 规约中使用 `runtimeClassName` 定义不同的运行时类。

对于敏感的工作负载，考虑使用 [gVisor](https://gvisor.dev/docs/) 这类内核仿真工具，
或使用 [kata-containers](https://katacontainers.io/) 等机制进行虚拟化隔离。

在高度信任的环境中，考虑使用[机密虚拟机](/zh-cn/blog/2023/07/06/confidential-kubernetes/)进一步提高集群安全性。
