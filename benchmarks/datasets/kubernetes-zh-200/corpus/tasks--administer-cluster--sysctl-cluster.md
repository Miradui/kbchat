# 在 Kubernetes 集群中使用 sysctl

功能状态：Kubernetes v1.21，stable。

本文档介绍如何通过 sysctl
接口在 Kubernetes 集群中配置和使用内核参数。

**说明：**

从 Kubernetes 1.23 版本开始，kubelet 支持使用 `/` 或 `.` 作为 sysctl 参数的分隔符。
从 Kubernetes 1.25 版本开始，支持为 Pod 设置 sysctl 时使用设置名字带有斜线的 sysctl。
例如，你可以使用点或者斜线作为分隔符表示相同的 sysctl 参数，以点作为分隔符表示为： `kernel.shm_rmid_forced`，
或者以斜线作为分隔符表示为：`kernel/shm_rmid_forced`。
更多 sysctl 参数转换方法详情请参考 Linux man-pages
[sysctl.d(5)](https://man7.org/linux/man-pages/man5/sysctl.d.5.html)。

## ## 准备开始

**说明：**

`sysctl` 是一个 Linux 特有的命令行工具，用于配置各种内核参数，
它在非 Linux 操作系统上无法使用。

你必须拥有一个 Kubernetes 的集群，且必须配置 kubectl 命令行工具让其与你的集群通信。
建议运行本教程的集群至少有两个节点，且这两个节点不能作为控制平面主机。
如果你还没有集群，你可以通过 [Minikube](https://minikube.sigs.k8s.io/docs/tutorials/multi_node/)
构建一个你自己的集群，或者你可以使用下面的 Kubernetes 练习环境之一：

* [iximiuz Labs](https://labs.iximiuz.com/playgrounds?category=kubernetes&filter=all)
* [Killercoda](https://killercoda.com/playgrounds/scenario/kubernetes)
* [KodeKloud](https://kodekloud.com/public-playgrounds)

对一些步骤，你需要能够重新配置在你的集群里运行的 kubelet 命令行的选项。

## 获取 Sysctl 的参数列表   {#listing-all-sysctl-parameters}

在 Linux 中，管理员可以通过 sysctl 接口修改内核运行时的参数。在 `/proc/sys/`
虚拟文件系统下存放许多内核参数。这些参数涉及了多个内核子系统，如：

- 内核子系统（通常前缀为: `kernel.`）
- 网络子系统（通常前缀为: `net.`）
- 虚拟内存子系统（通常前缀为: `vm.`）
- MDADM 子系统（通常前缀为: `dev.`）
- 更多子系统请参见[内核文档](https://www.kernel.org/doc/Documentation/sysctl/README)。

若要获取完整的参数列表，请执行以下命令：

```shell
sudo sysctl -a
```

## 安全和非安全的 Sysctl 参数  {#safe-and-unsafe-sysctls}

Kubernetes 将 sysctl 参数分为 **安全** 和 **非安全的**。
**安全** 的 sysctl 参数除了需要设置恰当的命名空间外，在同一节点上的不同 Pod
之间也必须是 **相互隔离的**。这意味着 Pod 上设置 **安全的** sysctl 参数时：

- 必须不能影响到节点上的其他 Pod
- 必须不能损害节点的健康
- 必须不允许使用超出 Pod 的资源限制的 CPU 或内存资源。

至今为止，大多数 **有命名空间的** sysctl 参数不一定被认为是 **安全** 的。
以下几种 sysctl 参数是 **安全的**：

- `kernel.shm_rmid_forced`；
- `net.ipv4.ip_local_port_range`；
- `net.ipv4.tcp_syncookies`；
- `net.ipv4.ping_group_range`（从 Kubernetes 1.18 开始）；
- `net.ipv4.ip_unprivileged_port_start`（从 Kubernetes 1.22 开始）；
- `net.ipv4.ip_local_reserved_ports`（从 Kubernetes 1.27 开始，需要 kernel 3.16+）；
- `net.ipv4.tcp_keepalive_time`（从 Kubernetes 1.29 开始，需要 kernel 4.5+）；
- `net.ipv4.tcp_fin_timeout`（从 Kubernetes 1.29 开始，需要 kernel 4.6+）；
- `net.ipv4.tcp_keepalive_intvl`（从 Kubernetes 1.29 开始，需要 kernel 4.5+）；
- `net.ipv4.tcp_keepalive_probes`（从 Kubernetes 1.29 开始，需要 kernel 4.5+）；
- `net.ipv4.tcp_rmem`（从 Kubernetes 1.32 开始，需要 kernel 4.15+）；
- `net.ipv4.tcp_wmem`（从 Kubernetes 1.32 开始，需要 kernel 4.15+）；
- `net.ipv4.tcp_slow_start_after_idle`（从 Kubernetes 1.37 开始，需要 kernel 4.15+）；
- `net.ipv4.tcp_notsent_lowat`（从 Kubernetes 1.37 开始，需要 kernel 4.6+）。

**说明：**

安全 sysctl 参数有一些例外：

- `net.*` sysctl 参数不允许在启用主机网络的情况下使用。
- `net.ipv4.tcp_syncookies` sysctl 参数在 Linux 内核 4.5 或更低的版本中是无命名空间的。

在未来的 Kubernetes 版本中，若 kubelet 支持更好的隔离机制，
则上述列表中将会列出更多 **安全的** sysctl 参数。

### 启用非安全的 Sysctl 参数   {#enabling-unsafe-sysctls}

所有 **安全的** sysctl 参数都默认启用。

所有 **非安全的** sysctl 参数都默认禁用，且必须由集群管理员在每个节点上手动开启。
那些设置了不安全 sysctl 参数的 Pod 仍会被调度，但无法正常启动。

参考上述警告，集群管理员只有在一些非常特殊的情况下（如：高可用或实时应用调整），
才可以启用特定的 **非安全的** sysctl 参数。
如需启用 **非安全的** sysctl 参数，请你在每个节点上分别设置 kubelet 命令行参数，例如：

```shell
kubelet --allowed-unsafe-sysctls \
  'kernel.msg*,net.core.somaxconn' ...
```

如果你使用 minikube，可以通过 `extra-config` 参数来配置：

```shell
minikube start --extra-config="kubelet.allowed-unsafe-sysctls=kernel.msg*,net.core.somaxconn"...
```

只有 **有命名空间的** sysctl 参数可以通过该方式启用。

## 设置 Pod 的 Sysctl 参数   {#setting-sysctls-for-pod}

目前，在 Linux 内核中，有许多的 sysctl 参数都是 **有命名空间的**。
这就意味着可以为节点上的每个 Pod 分别去设置它们的 sysctl 参数。
在 Kubernetes 中，只有那些有命名空间的 sysctl 参数可以通过 Pod 的 securityContext 对其进行配置。

以下列出有命名空间的 sysctl 参数，在未来的 Linux 内核版本中，此列表可能会发生变化。

- `kernel.shm*`,
- `kernel.msg*`,
- `kernel.sem`,
- `fs.mqueue.*`,

- 那些可以在容器网络命名空间中设置的 `net.*`。但是，也有例外（例如
  `net.netfilter.nf_conntrack_max` 和 `net.netfilter.nf_conntrack_expect_max`
  可以在容器网络命名空间中设置，但在 Linux 5.12.2 之前它们是无命名空间的）。

没有命名空间的 sysctl 参数称为 **节点级别的** sysctl 参数。
如果需要对其进行设置，则必须在每个节点的操作系统上手动地去配置它们，
或者通过在 DaemonSet 中运行特权模式容器来配置。

可使用 Pod 的 securityContext 来配置有命名空间的 sysctl 参数，
securityContext 应用于同一个 Pod 中的所有容器。

此示例中，使用 Pod SecurityContext 来对一个安全的 sysctl 参数
`kernel.shm_rmid_forced` 以及两个非安全的 sysctl 参数
`net.core.somaxconn` 和 `kernel.msgmax` 进行设置。
在 Pod 规约中对 **安全的** 和 **非安全的** sysctl 参数不做区分。

**警告：**

为了避免破坏操作系统的稳定性，请你在了解变更后果之后再修改 sysctl 参数。

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: sysctl-example
spec:
  securityContext:
    sysctls:
    - name: kernel.shm_rmid_forced
      value: "0"
    - name: net.core.somaxconn
      value: "1024"
    - name: kernel.msgmax
      value: "65536"
  ...
```

**警告：**

由于 **非安全的** sysctl 参数其本身具有不稳定性，在使用 **非安全的** sysctl 参数时可能会导致一些严重问题，
如容器的错误行为、机器资源不足或节点被完全破坏，用户需自行承担风险。

最佳实践方案是将集群中具有特殊 sysctl 设置的节点视为 **有污点的**，并且只调度需要使用到特殊
sysctl 设置的 Pod 到这些节点上。建议使用 Kubernetes
的[污点和容忍度特性](/docs/reference/generated/kubectl/kubectl-commands/#taint) 来实现它。

设置了 **非安全的** sysctl 参数的 Pod 在禁用了这两种 **非安全的** sysctl 参数配置的节点上启动都会失败。
与 **节点级别的** sysctl 一样，
建议开启[污点和容忍度特性](/docs/reference/generated/kubectl/kubectl-commands/#taint)或
[为节点配置污点](/zh-cn/docs/concepts/scheduling-eviction/taint-and-toleration/)以便将
Pod 调度到正确的节点之上。

## 为所有 Pod 设置 sysctl {#setting-sysctls-for-all-pods}

功能状态：DefaultPodSysctls，Kubernetes 1.37，alpha；首次引入于 1.37。默认禁用。使用前需配置相应特性门控。

你可以配置一组默认的内核参数（sysctl），由 `kubelet` 应用到运行于 Linux 节点上的所有 Pod，
包括静态 Pod。
当节点管理员需要在节点上或节点组内对所有工作负载强制实施一致的内核参数调优
（例如，为高性能网络调整 TCP 缓冲区大小），而又不要求每个 Pod 规约都单独设置
`securityContext.sysctls` 时，此特性非常有用。

要使用此特性，请为 `kubelet` 启用 `DefaultPodSysctls`
[特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/)，
并在你的
[KubeletConfiguration](/zh-cn/docs/reference/config-api/kubelet-config.v1beta1/)
中的 `defaultPodSysctls` 字段中指定键值对。

`defaultPodSysctls` 字段支持所有带命名空间的 sysctl（`kernel.shm*`、
`kernel.msg*`、`kernel.sem`、`kernel.domainname`、`fs.mqueue.*`、`net.*` 和
`user.*`），涵盖**安全的**和**非安全的** sysctl。由于这些默认值由节点管理员直接在
`kubelet` 上配置，因此你无需在 `allowedUnsafeSysctls` 中为非安全 sysctl 设置白名单。

以下示例配置 `kubelet` 将跨越多个命名空间子系统（网络、IPC 和用户命名空间）的默认
sysctl 应用到节点上的所有 Pod：

```yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
featureGates:
  DefaultPodSysctls: true
defaultPodSysctls:
  # 网络命名空间 sysctl（如果 Pod 使用 hostNetwork: true 则跳过）
  net.ipv4.ip_forward: "1"
  net.ipv4.tcp_rmem: "4096 87380 16777216"
  net.ipv4.tcp_wmem: "4096 65536 16777216"
  net.core.somaxconn: "1024"
  # IPC 命名空间 sysctl（如果 Pod 使用 hostIPC: true 则跳过）
  kernel.shmall: "1048576"
  kernel.msgmax: "65536"
  kernel.sem: "250 32000 32 128"
  fs.mqueue.msg_max: "1024"
  # 用户命名空间 sysctl（如果 Pod 共享宿主机用户命名空间则跳过）
  user.max_user_namespaces: "1000"
```

### 优先级与覆盖 {#precedence-and-overriding}

在 Pod 的 `spec.securityContext.sysctls` 中显式设置的值始终会覆盖 `kubelet` 的
`defaultPodSysctls` 中指定的对应默认值。覆盖以逐键方式独立应用：如果 Pod 为某个在
`defaultPodSysctls` 中也有定义的 sysctl 指定了值，则对该特定 sysctl 而言，
Pod 级别的设置优先，而其他默认值继续生效。请注意，sysctl 设置之间不存在关联分组；
如果你的工作负载覆盖了某个关联组（例如网络缓冲区大小）中的 sysctl，
则 Pod 规约必须按需处理所有相关设置。

### 宿主机命名空间与过滤 {#host-namespaces-and-filtering}

只有当 Pod 在相应的子系统独立命名空间中运行时，`kubelet` 才会应用默认的 sysctl 设置；
如果 Pod 共享宿主机的命名空间，则该 Pod 将跳过针对该命名空间的默认 sysctl 设置：

- 如果 Pod 使用宿主机网络（`hostNetwork: true`），则会跳过 `net.*` 类型的 sysctl 设置。
- 如果 Pod 使用了宿主机 IPC（即 `hostIPC: true`），则会跳过 IPC sysctl 设置
  （`kernel.sem`、`kernel.msg*`、`kernel.shm*`、`fs.mqueue.*`）。
- 如果 Pod 共享宿主机用户命名空间（`hostUsers: true` 或未设置），则会跳过 `user.*` 类型的 sysctl 设置。
- 如果 Pod 使用宿主机网络（`hostNetwork: true`），则跳过 UTS sysctl（`kernel.domainname`）设置。

### 校验与限制 {#validation-and-limitations}

`kubelet` 在启动期间会校验 `defaultPodSysctls`。非命名空间级别的 sysctl、无效的
sysctl 名称或重复的键将阻止 `kubelet` 启动。

此外，某些 `net.*` sysctl 可能是非命名空间级别的，具体取决于你的内核版本。在
`defaultPodSysctls` 中指定非命名空间级别的 `net.*` sysctl 将导致 Pod 沙箱创建失败，
并报 `FailedCreatePodSandBox` 错误。Pod 将会永远重试创建沙箱。请确保所有指定的
sysctl 在你的节点内核上都是命名空间级别的。

对 `defaultPodSysctls` 的更改仅应用于新建的 Pod。`kubelet` 不会动态重新配置已存在的
Pod（参见[节点重启后会发生什么](/zh-cn/docs/reference/node/what-happens-on-restart/#impact-of-a-kubelet-restart)）。
已存在的 Pod 将继续使用其沙箱创建时所应用的 sysctl 运行。如果你希望已存在的 Pod
采用更新后的默认 sysctl，你必须重新创建这些 Pod（例如，通过隔离并排空节点）。
