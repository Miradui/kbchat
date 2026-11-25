# 针对 Pod 和容器的 Linux 内核安全约束

本页描述了一些 Linux 内核中内置的、你可以在 Kubernetes 工作负载中使用的安全特性。
要了解如何将这些特性应用到你的 Pod 和容器，
请参阅[为 Pod 或容器配置 SecurityContext](/zh-cn/docs/tasks/configure-pod-container/security-context/)。
你须熟悉 Linux 和 Kubernetes 工作负载的基础知识。

## 运行不具有 root 特权的工作负载   {#run-without-root}

当你在 Kubernetes 中部署一个工作负载时，可以使用 Pod 规约来限制该工作负载以非 root 用户在节点上运行。
你可以使用 Pod 的 `securityContext` 为 Pod 中的进程定义特定的 Linux 用户和组，
并明确限制容器不可以 root 用户运行。在 Pod 清单中设置的这些值优先于容器镜像中的类似值，
这对于运行非自有的镜像特别有用。

**注意：**

确保你分配给工作负载的用户或组具有应用正常运行所需的权限。
将用户或组更改为没有适当权限的用户或组可能会导致文件访问问题或操作失败。

配置本页所述的内核安全特性可以对集群中进程能够执行的操作进行细粒度的控制，但大规模管理这些配置可能会有挑战。
以非 root 用户运行容器，或在需要 root 特权时在 user 命名空间中运行容器，有助于减少你因必须配置的内核安全权能的要求。

## Linux 内核中的安全特性   {#linux-security-features}

Kubernetes 允许你配置和使用 Linux 内核特性来提高容器化的工作负载的隔离性，完成安全加固。
常见的特性包括以下几种：

* **安全计算模式 (seccomp)**：过滤某个进程可以执行哪些系统调用
* **AppArmor**：限制单个程序的访问特权
* **安全增强 Linux (SELinux)**：为对象赋予安全标签，以便更好地管理安全策略的实施

要配置其中一个特性的设置，你为节点所选择的操作系统必须在内核中启用对应的特性。
例如，Ubuntu 7.10 及更高版本默认启用 AppArmor。
要了解你的操作系统是否启用了特定特性，请查阅对应的操作系统文档。

你可以使用 Pod 规约中的 `securityContext` 字段来定义适用于 Pod 中进程的约束。
`securityContext` 字段还支持其他安全设置，例如使用特定 Linux 权能或基于 UID 和 GID 的文件访问权限。
要了解更多信息，请参阅[为 Pod 或容器配置 SecurityContext](/zh-cn/docs/tasks/configure-pod-container/security-context/)。

### seccomp

你的某些工作负载可能需要在你的节点的主机上以 root 用户执行特定操作的权限。
Linux 使用**权能（Capability）** 将可用的特权划分为不同类别，这样进程就能够获取执行特定操作所需的特权，
而无需为其授予所有特权。每个权能都对应进程可以执行的一组系统调用（syscalls）。
seccomp 允许你限制这些单独的系统调用。seccomp 可用于沙盒化进程的权限，限制其可以从用户空间向内核发出的调用。

在 Kubernetes 中，你在每个节点上使用**容器运行时**来运行你的容器。
运行时的例子包括 CRI-O、Docker 或 containerd。每个运行时默认仅允许一部分 Linux 权能。
你可以使用 seccomp 配置文件进一步限制所允许的系统调用。容器运行时通常包含一个默认的 seccomp 配置文件。
Kubernetes 允许你自动将加载到某个节点上的那些 seccomp 配置文件应用到你的 Pod 和容器。

**说明：**

Kubernetes 还可以为 Pod 和容器设置 `allowPrivilegeEscalation`。当此字段设置为 `false` 时，
将阻止进程获取新权能，并限制非特权用户将已应用的 seccomp 配置文件更改为某个更宽松的配置文件。

要了解如何在 Kubernetes 中实现 seccomp，
请参阅[使用 seccomp 限制容器的系统调用](/zh-cn/docs/tutorials/security/seccomp/)或
[Seccomp 节点参考](/zh-cn/docs/reference/node/seccomp/)。

要了解 seccomp 的更多细节，请参阅 Linux 内核文档中的
[Seccomp BPF](https://www.kernel.org/doc/html/latest/userspace-api/seccomp_filter.html)。

#### seccomp 的注意事项   {#seccomp-considerations}

seccomp 是一种底层安全配置，只有在你需要对 Linux 系统调用进行细粒度控制时才应自行配置。
使用 seccomp，尤其是在大规模使用时，会有以下风险：

* 在应用更新期间这些配置可能被破坏
* 攻击者仍然可以使用被允许的系统调用来利用漏洞
* 逐个应用地管理配置文件在规模较大时变得具有挑战性

**建议**：使用与你的容器运行时捆绑的默认 seccomp 配置文件。
如果你需要一个隔离性更好的环境，请考虑使用沙箱，例如 gVisor。
沙箱通过自定义 seccomp 配置文件解决了上述风险，但需要占用节点上的更多计算资源，
并且可能与 GPU 和其他专用硬件存在兼容性问题。

### AppArmor 和 SELinux：基于策略的强制访问控制   {#policy-based-mac}

你可以使用 Linux 上基于策略的强制访问控制（MAC）机制（例如 AppArmor 和 SELinux）来加固你的 Kubernetes 工作负载。

#### AppArmor

[AppArmor](https://apparmor.net/) 是一个 Linux 内核安全模块，它在标准的基于 Linux 用户和组的权限基础上，
进一步将程序限制在有限的资源集内。AppArmor 可以针对任何应用配置，以减小其潜在的攻击面并提供更深入的防御。
AppArmor 通过调优的配置文件进行配置，以允许特定程序或容器所需的访问，例如 Linux 权能、网络访问和文件权限。
每个配置文件要么在强制（Enforcing）模式下运行，即阻止访问不被允许的资源，
要么在投诉（Complaining）模式下运行，只报告违规行为。

AppArmor 可以通过限制容器被允许执行哪些操作来帮助你运行更为安全的部署，还可以通过系统日志提供更好的审计。
你使用的容器运行时可能附带默认的 AppArmor 配置文件，或者你也可以使用自定义的配置文件。

要了解如何在 Kubernetes 中使用 AppArmor，
请参阅[使用 AppArmor 限制容器对资源的访问](/zh-cn/docs/tutorials/security/apparmor/)。

#### SELinux

SELinux 是一个 Linux 内核安全模块，允许你限制特定**主体**（例如进程）对系统上文件的访问。
你可以定义要应用到具有特定 SELinux 标签的主体的安全策略。
当具有特定 SELinux 标签的进程试图访问某个文件时，SELinux 服务器会检查该进程的安全策略是否允许访问并做出鉴权决策。

在 Kubernetes 中，你可以在清单的 `securityContext` 字段中设置 SELinux 标签。
所指定的标签被赋予给那些进程。如果你配置了影响这些标签的安全策略，则主机操作系统内核将强制执行这些策略。

要了解如何在 Kubernetes 中使用 SELinux，
请参阅[为容器分配 SELinux 标签](/zh-cn/docs/tasks/configure-pod-container/security-context/#assign-selinux-labels-to-a-container)。

#### AppArmor 和 SELinux 之间的区别   {#apparmor-selinux-diff}

Linux 节点上的操作系统通常包含 AppArmor 或 SELinux 其中之一。
这两种机制都能提供类似的保护，但有以下区别：

* **配置**：AppArmor 使用配置文件定义对资源的访问。SELinux 使用适用于特定标签的策略。
* **策略应用**：在 AppArmor 中，你使用文件路径来定义资源。SELinux 使用资源的索引节点 (inode) 来标识资源。

### 特性摘要   {#summary}

下表描述了每种安全控制机制的使用场景和范围。你可以同时使用所有这些控制机制来构建更稳固的系统。

<table>
  
  <caption>Linux 内核安全特性摘要</caption>
  <thead>
    <tr>
      <th>安全特性</th>
      <th>描述</th>
      <th>使用方式</th>
      <th>示例</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>seccomp</td>
      
      <td>限制用户空间中的各个内核调用。如果某漏洞使用了某受限的系统调用，这一机制可降低系统被破坏的可能性。</td>
      <td>在 Pod 或容器规约中配置某已加载的 seccomp 配置文件，以将其约束应用于 Pod 中的进程。</td>
      <td>拒绝曾在
      <a href="https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2022-0185">CVE-2022-0185</a>
      中使用的 <code>unshare</code> 系统调用。</td>
    </tr>
    <tr>
      <td>AppArmor</td>
      
      <td>限制程序对特定资源的访问。减少程序的攻击面。改进审计日志。</td>
      <td>在容器规约中设定某已加载的 AppArmor 配置文件。</td>
      <td>限制只读程序，不允许其写入系统中的任何文件路径。</td>
    </tr>
    <tr>
      <td>SELinux</td>
      
      <td>使用标签和安全策略限制对文件、应用、端口和进程等资源的访问。</td>
      <td>为特定标签设置访问限制。使用这些标签来标记进程，以强制执行与标签相关的访问限制。</td>
      <td>限制容器访问其自身文件系统之外的文件。</td>
    </tr>
  </tbody>
</table>

**说明：**

像 AppArmor 和 SELinux 这样的机制可以提供超出容器范围的保护。例如，你可以使用 SELinux 帮助缓解
[CVE-2019-5736](https://access.redhat.com/security/cve/cve-2019-5736)。

### 管理自定义配置的注意事项   {#considerations-custom-configurations}

seccomp、AppArmor 和 SELinux 通常有一个默认配置来提供基本的保护。
你还可以创建自定义配置文件和策略来满足你的工作负载的要求。
大规模场景下管理和分发这些自定义配置可能具有挑战性，特别是当你同时使用这三种特性时。
为了帮助你在大规模场景下管理这些配置，可以使用类似
[Kubernetes Security Profiles Operator](https://github.com/kubernetes-sigs/security-profiles-operator)
的工具。

## 内核级安全特性和特权容器   {#kernel-security-features-privileged-containers}

Kubernetes 允许你指定一些被信任的容器能以**特权**模式运行。
Pod 中的所有容器都能够以特权模式运行，以使用操作系统的管理性质权能，这些权能在其他情况下是不可访问的。
此特性在 Windows 和 Linux 上都可用。

特权容器显式覆盖你可能在工作负载中使用的以下一些 Linux 内核约束：

* **seccomp**：特权容器以 `Unconfined` 为 seccomp 配置文件运行，覆盖你在清单中指定的所有 seccomp 配置。
* **AppArmor**：特权容器忽略任何已应用的 AppArmor 配置文件。
* **SELinux**：特权容器以 `unconfined_t` 域运行。

### 特权容器    {#privileged-containers}

如果你在容器的 [`securityContext`](/zh-cn/docs/tasks/configure-pod-container/security-context/)
字段中设置 `privileged: true` 字段，则 Pod 中的所有容器都可以启用**特权模式**。
特权容器会覆盖或使许多其他加固选项无效，例如已应用的 seccomp 配置文件、AppArmor 配置文件或 SELinux 约束。
特权容器被赋予所有的 Linux 权能，包括它们所不需要的权能。例如，特权容器中的 root 用户可能能够绕过运行时的
seccomp 配置和其他限制，在节点上使用 `CAP_SYS_ADMIN` 和 `CAP_NET_ADMIN` 权能。

在大多数情况下，你应避免使用特权容器，而是通过 `securityContext` 字段中的 `capabilities`
字段来授予容器所需的特定权能。只有在你无法通过 securityContext 授予某个权能时，才使用特权模式。
这对希望使用操作系统管理权能（如操纵网络栈或访问硬件设备）的容器来说特别有用。

在 Kubernetes 1.26 及更高版本中，你还可以通过在 Pod 规约的安全上下文中设置 `windowsOptions.hostProcess` 标志，
以类似的特权模式运行 Windows 容器。有关细节和说明，
请参阅[创建 Windows HostProcess Pod](/zh-cn/docs/tasks/configure-pod-container/create-hostprocess-pod/)。

## 建议和最佳实践    {#recommendations-best-practices}

* 在配置内核级安全权能之前，你应该考虑实施网络级别的隔离。
  有关细节参阅[安全检查清单](/zh-cn/docs/concepts/security/security-checklist/#network-security)。
* 除非必要，否则通过在 Pod 清单中设置特定的用户和组 ID 并指定 `runAsNonRoot: true`，以非 root 身份运行 Linux 工作负载。

此外，你可以通过在 Pod 清单中设置 `hostUsers: false` 来在 user 命名空间中运行工作负载。
这使你可以以 user 命名空间中的 root 用户运行容器，但在节点上的主机命名空间中是非 root 用户。
此特性仍处于早期开发阶段，可能不是你所需要的支持级别。
有关说明，请参阅[为 Pod 配置 user 命名空间](/zh-cn/docs/tasks/configure-pod-container/user-namespaces/)。

## ## 接下来

* [学习如何使用 AppArmor](/zh-cn/docs/tutorials/security/apparmor/)
* [学习如何使用 seccomp](/zh-cn/docs/tutorials/security/seccomp/)
* [学习如何使用 SELinux](/zh-cn/docs/tasks/configure-pod-container/security-context/#assign-selinux-labels-to-a-container)
* [Seccomp 节点参考](/zh-cn/docs/reference/node/seccomp/)
