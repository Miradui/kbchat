# 为 Pod 或容器配置安全上下文

安全上下文（Security Context）定义 Pod 或 Container 的特权与访问控制设置。
安全上下文包括但不限于：

* 自主访问控制（Discretionary Access Control）：
  基于[用户 ID（UID）和组 ID（GID）](https://wiki.archlinux.org/index.php/users_and_groups)
  来判定对对象（例如文件）的访问权限。

* [安全性增强的 Linux（SELinux）](https://zh.wikipedia.org/wiki/%E5%AE%89%E5%85%A8%E5%A2%9E%E5%BC%BA%E5%BC%8FLinux)：
  为对象赋予安全性标签。

* 以特权模式或者非特权模式运行。

* [Linux 权能](https://linux-audit.com/linux-capabilities-hardening-linux-binaries-by-removing-setuid/): 
  为进程赋予 root 用户的部分特权而非全部特权。

* [AppArmor](/zh-cn/docs/tutorials/security/apparmor/)：使用程序配置来限制个别程序的权能。

* [Seccomp](/zh-cn/docs/tutorials/security/seccomp/)：过滤进程的系统调用。

* `allowPrivilegeEscalation`：控制进程是否可以获得超出其父进程的特权。
  例如，通过执行 [setuid 可执行文件](https://en.wikipedia.org/wiki/Setuid)来提升权限。

  该布尔值直接控制是否为容器进程设置 [`no_new_privs`](https://www.kernel.org/doc/Documentation/prctl/no_new_privs.txt) 标志。
  但需要注意的是，两者的取值逻辑是相反的：如果 `allowPrivilegeEscalation` 设置为 true，
  则 `no_new_privs` 将被设置为 false。

  如果在容器规范的 `securityContext` 字段中未定义 `allowPrivilegeEscalation`，则其默认值为 true。

  `allowPrivilegeEscalation: false` 与具有以下配置的容器存在冲突，因此不能同时设置：

  - 以特权模式运行，或者
  - 具有 `CAP_SYS_ADMIN` 权能

* `readOnlyRootFilesystem`：以只读方式加载容器的根文件系统。

以上条目不是安全上下文设置的完整列表 -- 请参阅
[SecurityContext](/docs/reference/generated/kubernetes-api/v1.37/#securitycontext-v1-core)
了解其完整列表。

## ## 准备开始

你必须拥有一个 Kubernetes 的集群，且必须配置 kubectl 命令行工具让其与你的集群通信。
建议运行本教程的集群至少有两个节点，且这两个节点不能作为控制平面主机。
如果你还没有集群，你可以通过 [Minikube](https://minikube.sigs.k8s.io/docs/tutorials/multi_node/)
构建一个你自己的集群，或者你可以使用下面的 Kubernetes 练习环境之一：

* [iximiuz Labs](https://labs.iximiuz.com/playgrounds?category=kubernetes&filter=all)
* [Killercoda](https://killercoda.com/playgrounds/scenario/kubernetes)
* [KodeKloud](https://kodekloud.com/public-playgrounds)
 使用 `kubectl version` 检查版本。

## 为 Pod 设置安全性上下文   {#set-the-security-context-for-a-pod}

要为 Pod 设置安全性设置，可在 Pod 规约中包含 `securityContext` 字段。`securityContext` 字段值是一个
[PodSecurityContext](/docs/reference/generated/kubernetes-api/v1.37/#podsecuritycontext-v1-core)
对象。你为 Pod 所设置的安全性配置会应用到 Pod 中所有 Container 上。
下面是一个 Pod 的配置文件，该 Pod 定义了 `securityContext` 和一个 `emptyDir` 卷：

示例文件：`pods/security/security-context.yaml`

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: security-context-demo
spec:
  securityContext:
    runAsUser: 1000
    runAsGroup: 3000
    fsGroup: 2000
    supplementalGroups: [4000]
  volumes:
  - name: sec-ctx-vol
    emptyDir: {}
  containers:
  - name: sec-ctx-demo
    image: busybox:1.28
    command: [ "sh", "-c", "sleep 1h" ]
    volumeMounts:
    - name: sec-ctx-vol
      mountPath: /data/demo
    securityContext:
      allowPrivilegeEscalation: false
```

在配置文件中，`runAsUser` 字段指定 Pod 中的所有容器内的进程都使用用户 ID 1000
来运行。`runAsGroup` 字段指定所有容器中的进程都以主组 ID 3000 来运行。
如果忽略此字段，则容器的主组 ID 将是 root（0）。
当 `runAsGroup` 被设置时，所有创建的文件也会划归用户 1000 和组 3000。
由于 `fsGroup` 被设置，容器中所有进程也会是附组 ID 2000 的一部分。
卷 `/data/demo` 及在该卷中创建的任何文件的属主都会是组 ID 2000。
此外，当 `supplementalGroups` 字段被指定时，容器的所有进程也会成为所指定的组的一部分。
如果此字段被省略，则表示为空。

创建该 Pod：

```shell
kubectl apply -f https://k8s.io/examples/pods/security/security-context.yaml
```

检查 Pod 的容器处于运行状态：

```shell
kubectl get pod security-context-demo
```

开启一个 Shell 进入到运行中的容器：

```shell
kubectl exec -it security-context-demo -- sh
```

在你的 Shell 中，列举运行中的进程：

```shell
ps
```

输出显示进程以用户 1000 运行，即 `runAsUser` 所设置的值：

```none
PID   USER     TIME  COMMAND
    1 1000      0:00 sleep 1h
    6 1000      0:00 sh
...
```

在你的 Shell 中，进入 `/data` 目录列举其内容：

```shell
cd /data
ls -l
```

输出显示 `/data/demo` 目录的组 ID 为 2000，即 `fsGroup` 的设置值：

```none
drwxrwsrwx 2 root 2000 4096 Jun  6 20:08 demo
```

在你的 Shell 中，进入到 `/data/demo` 目录下创建一个文件：

```shell
cd demo
echo hello > testfile
```

列举 `/data/demo` 目录下的文件：

```shell
ls -l
```

输出显示 `testfile` 的组 ID 为 2000，也就是 `fsGroup` 所设置的值：

```none
-rw-r--r-- 1 1000 2000 6 Jun  6 20:08 testfile
```

运行下面的命令：

```shell
id
```

输出类似于：

```none
uid=1000 gid=3000 groups=2000,3000,4000
```

从输出中你会看到 `gid` 值为 3000，也就是 `runAsGroup` 字段的值。
如果 `runAsGroup` 被忽略，则 `gid` 会取值 0（root），而进程就能够与 root
用户组所拥有以及要求 root 用户组访问权限的文件交互。
你还可以看到，除了 `gid` 之外，`groups` 还包含了由 `fsGroup` 和
`supplementalGroups` 指定的组 ID。

退出你的 Shell：

```shell
exit
```

### 容器镜像内 `/etc/group` 中定义的隐式组成员身份

默认情况下，Kubernetes 会将 Pod 中的组信息与容器镜像内 `/etc/group`
中定义的信息合并。

示例文件：`pods/security/security-context-5.yaml`

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: security-context-demo
spec:
  securityContext:
    runAsUser: 1000
    runAsGroup: 3000
    supplementalGroups: [4000]
  containers:
  - name: sec-ctx-demo
    image: registry.k8s.io/e2e-test-images/agnhost:2.45
    command: [ "sh", "-c", "sleep 1h" ]
    securityContext:
      allowPrivilegeEscalation: false
```

此 Pod 的安全上下文包含 `runAsUser`、`runAsGroup` 和 `supplementalGroups`。  
然而，你可以看到，挂接到容器进程的实际附加组将包括来自容器镜像中
`/etc/group` 的组 ID。

创建 Pod：

```shell
kubectl apply -f https://k8s.io/examples/pods/security/security-context-5.yaml
```

验证 Pod 的 Container 正在运行：

```shell
kubectl get pod security-context-demo
```

打开一个 Shell 进入正在运行的 Container：

```shell
kubectl exec -it security-context-demo -- sh
```

检查进程身份：

```shell
id
```

输出类似于：

```none
uid=1000 gid=3000 groups=3000,4000,50000
```

你可以看到 `groups` 包含组 ID `50000`。
这是因为镜像中定义的用户（`uid=1000`）属于在容器镜像内 `/etc/group` 中定义的组（`gid=50000`）。

检查容器镜像中的 `/etc/group`：

```shell
cat /etc/group
```

你可以看到 uid `1000` 属于组 `50000`。

```none
...
user-defined-in-image:x:1000:
group-defined-in-image:x:50000:user-defined-in-image
```

退出你的 Shell：

```shell
exit
```

**说明：**

**隐式合并的**附加组可能会导致安全问题，
特别是在访问卷时（有关细节请参见 [kubernetes/kubernetes#112879](https://issue.k8s.io/112879)）。  
如果你想避免这种问题，请查阅以下章节。

## 配置 Pod 的细粒度 SupplementalGroups 控制   {#supplementalgroupspolicy}

功能状态：SupplementalGroupsPolicy，Kubernetes 1.33，beta；首次引入于 1.31。默认启用。

通过为 kubelet 和 kube-apiserver 设置 `SupplementalGroupsPolicy`
[特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/)，
并为 Pod 设置 `.spec.securityContext.supplementalGroupsPolicy` 字段，此特性可以被启用。

`supplementalGroupsPolicy` 字段为 Pod 中的容器进程定义了计算附加组的策略。
此字段有两个有效值：

* `Merge`：为容器的主用户在 `/etc/group` 中定义的组成员身份将被合并。
  如果不指定，这就是默认策略。

* `Strict`：仅将 `fsGroup`、`supplementalGroups` 或 `runAsGroup`
  字段中的组 ID 挂接为容器进程的附加组。这意味着容器主用户在 `/etc/group`
  中的组成员身份将不会被合并。

当此特性被启用时，它还会在 `.status.containerStatuses[].user.linux`
字段中暴露挂接到第一个容器进程的进程身份。这对于检测是否挂接了隐式组 ID 非常有用。

示例文件：`pods/security/security-context-6.yaml`

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: security-context-demo
spec:
  securityContext:
    runAsUser: 1000
    runAsGroup: 3000
    supplementalGroups: [4000]
    supplementalGroupsPolicy: Strict
  containers:
  - name: sec-ctx-demo
    image: registry.k8s.io/e2e-test-images/agnhost:2.45
    command: [ "sh", "-c", "sleep 1h" ]
    securityContext:
      allowPrivilegeEscalation: false
```

此 Pod 清单定义了 `supplementalGroupsPolicy=Strict`。
你可以看到没有将 `/etc/group` 中定义的组成员身份合并到容器进程的附加组中。

创建 Pod：

```shell
kubectl apply -f https://k8s.io/examples/pods/security/security-context-6.yaml
```

验证 Pod 的 Container 正在运行：

```shell
kubectl get pod security-context-demo
```

检查进程身份：

```shell
kubectl exec -it security-context-demo -- id
```

输出类似于：

```none
uid=1000 gid=3000 groups=3000,4000
```

查看 Pod 的状态：

```shell
kubectl get pod security-context-demo -o yaml
```

你可以看到 `status.containerStatuses[].user.linux`
字段暴露了挂接到第一个容器进程的进程身份。

```none
...
status:
  containerStatuses:
  - name: sec-ctx-demo
    user:
      linux:
        gid: 3000
        supplementalGroups:
        - 3000
        - 4000
        uid: 1000
...
```

**说明：**

请注意，`status.containerStatuses[].user.linux`
字段的值是**第一个挂接到**容器中第一个容器进程的进程身份。
如果容器具有足够的权限来进行与进程身份相关的系统调用
（例如 [`setuid(2)`](https://man7.org/linux/man-pages/man2/setuid.2.html)、
[`setgid(2)`](https://man7.org/linux/man-pages/man2/setgid.2.html) 或
[`setgroups(2)`](https://man7.org/linux/man-pages/man2/setgroups.2.html) 等），
则容器进程可以更改其身份。因此，**实际**进程身份将是动态的。

### 实现   {#implementations-supplementalgroupspolicy}

本部分链接到提供 Kubernetes 所需功能的第三方项目。Kubernetes 项目作者不负责这些项目。此页面遵循[CNCF 网站指南](https://github.com/cncf/foundation/blob/main/policies-guidance/website-guidelines.md)，按字母顺序列出项目。要将项目添加到此列表中，请在提交更改之前阅读[内容指南](/zh-cn/docs/contribute/style/content-guide/#third-party-content)。

已知以下容器运行时支持细粒度的 SupplementalGroups 控制。

CRI 级别：

- [containerd](https://containerd.io/)，自 v2.0 起
- [CRI-O](https://cri-o.io/)，自 v1.31 起

你可以在 Node 状态中查看此特性是否受支持。

```yaml
apiVersion: v1
kind: Node
...
status:
  features:
    supplementalGroupsPolicy: true
```

**说明：**

在这个 Alpha 版本（从 v1.31 到 v1.32）中，当一个带有
`SupplementalGroupsPolicy=Strict` 的 Pod
被调度到不支持此功能的节点上（即 `.status.features.supplementalGroupsPolicy=false`），
Pod 的补充组策略会**静默地**回退到 `Merge` 策略。

然而，自从 Beta 版本（v1.33）以来，为了更严格地实施该策略，**此类
Pod 创建将被 kubelet 拒绝，因为节点无法确保指定的策略**。
当你的 Pod 被拒绝时，你将会看到带有 `reason=SupplementalGroupsPolicyNotSupported`
的警告事件，如下所示：

```yaml
apiVersion: v1
kind: Event
...
type: Warning
reason: SupplementalGroupsPolicyNotSupported
message: "SupplementalGroupsPolicy=Strict is not supported in this node"
involvedObject:
  apiVersion: v1
  kind: Pod
  ...
```

## 为 Pod 配置卷访问权限和属主变更策略    {#configure-volume-permission-and-ownership-change-policy-for-pods}

功能状态：Kubernetes v1.23，stable。

默认情况下，Kubernetes 在挂载一个卷时，会递归地更改每个卷中的内容的属主和访问权限，
使之与 Pod 的 `securityContext` 中指定的 `fsGroup` 匹配。
对于较大的数据卷，检查和变更属主与访问权限可能会花费很长时间，降低 Pod 启动速度。
你可以在 `securityContext` 中使用 `fsGroupChangePolicy` 字段来控制 Kubernetes
检查和管理卷属主和访问权限的方式。

**fsGroupChangePolicy** - `fsGroupChangePolicy` 定义在卷被暴露给 Pod 内部之前对其
内容的属主和访问许可进行变更的行为。此字段仅适用于那些支持使用 `fsGroup` 来
控制属主与访问权限的卷类型。此字段的取值可以是：

* `OnRootMismatch`：只有根目录的属主与访问权限与卷所期望的权限不一致时，
  才改变其中内容的属主和访问权限。这一设置有助于缩短更改卷的属主与访问
  权限所需要的时间。
* `Always`：在挂载卷时总是更改卷中内容的属主和访问权限。

例如：

```yaml
securityContext:
  runAsUser: 1000
  runAsGroup: 3000
  fsGroup: 2000
  fsGroupChangePolicy: "OnRootMismatch"
```

**说明：**

此字段对于 [`secret`](/zh-cn/docs/concepts/storage/volumes/#secret)、
[`configMap`](/zh-cn/docs/concepts/storage/volumes/#configmap)
和 [`emptyDir`](/zh-cn/docs/concepts/storage/volumes/#emptydir)
这类临时性存储无效。

## 将卷权限和所有权更改委派给 CSI 驱动程序

功能状态：Kubernetes v1.26，stable。

如果你部署了一个[容器存储接口（CSI）](https://github.com/container-storage-interface/spec/blob/master/spec.md)
驱动，而该驱动支持 `VOLUME_MOUNT_GROUP` `NodeServiceCapability`，
在 `securityContext` 中指定 `fsGroup` 来设置文件所有权和权限的过程将由 CSI
驱动而不是 Kubernetes 来执行。在这种情况下，由于 Kubernetes 不执行任何所有权和权限更改，
`fsGroupChangePolicy` 不会生效，并且按照 CSI 的规定，CSI 驱动应该使用所指定的
`fsGroup` 来挂载卷，从而生成了一个对 `fsGroup` 可读/可写的卷.

## 为 Container 设置安全性上下文  {#set-the-security-context-for-a-container}

若要为 Container 设置安全性配置，可以在 Container 清单中包含 `securityContext` 
字段。`securityContext` 字段的取值是一个
[SecurityContext](/docs/reference/generated/kubernetes-api/v1.37/#securitycontext-v1-core)
对象。你为 Container 设置的安全性配置仅适用于该容器本身，并且所指定的设置在与
Pod 层面设置的内容发生重叠时，会重写 Pod 层面的设置。Container 层面的设置不会影响到 Pod 的卷。

下面是一个 Pod 的配置文件，其中包含一个 Container。Pod 和 Container 都有
`securityContext` 字段：

示例文件：`pods/security/security-context-2.yaml`

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: security-context-demo-2
spec:
  securityContext:
    runAsUser: 1000
  containers:
  - name: sec-ctx-demo-2
    image: gcr.io/google-samples/hello-app:2.0
    securityContext:
      runAsUser: 2000
      allowPrivilegeEscalation: false
```

创建该 Pod：

```shell
kubectl apply -f https://k8s.io/examples/pods/security/security-context-2.yaml
```

验证 Pod 中的容器处于运行状态：

```shell
kubectl get pod security-context-demo-2
```

启动一个 Shell 进入到运行中的容器内：

```shell
kubectl exec -it security-context-demo-2 -- sh
```

在你的 Shell 中，列举运行中的进程：

```shell
ps aux
```

输出显示进程以用户 2000 运行。该值是在 Container 的 `runAsUser` 中设置的。
该设置值重写了 Pod 层面所设置的值 1000。

```
USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND
2000         1  0.0  0.0   4336   764 ?        Ss   20:36   0:00 /bin/sh -c node server.js
2000         8  0.1  0.5 772124 22604 ?        Sl   20:36   0:00 node server.js
...
```

退出你的 Shell：

```shell
exit
```

## 为 Container 设置权能   {#set-capabilities-for-a-container}

使用 [Linux 权能](https://man7.org/linux/man-pages/man7/capabilities.7.html)，
你可以赋予进程 root 用户所拥有的某些特权，但不必赋予其全部特权。
要为 Container 添加或移除 Linux 权能，可以在 Container 清单的 `securityContext`
节包含 `capabilities` 字段。

首先，看一下不包含 `capabilities` 字段时候会发生什么。
下面是一个配置文件，其中没有添加或移除容器的权能：

示例文件：`pods/security/security-context-3.yaml`

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: security-context-demo-3
spec:
  containers:
  - name: sec-ctx-3
    image: gcr.io/google-samples/hello-app:2.0
```

创建该 Pod：

```shell
kubectl apply -f https://k8s.io/examples/pods/security/security-context-3.yaml
```

验证 Pod 的容器处于运行状态：

```shell
kubectl get pod security-context-demo-3
```

启动一个 Shell 进入到运行中的容器：

```shell
kubectl exec -it security-context-demo-3 -- sh
```

在你的 Shell 中，列举运行中的进程：

```shell
ps aux
```

输出显示容器中进程 ID（PID）：

```
USER  PID %CPU %MEM    VSZ   RSS TTY   STAT START   TIME COMMAND
root    1  0.0  0.0   4336   796 ?     Ss   18:17   0:00 /bin/sh -c node server.js
root    5  0.1  0.5 772124 22700 ?     Sl   18:17   0:00 node server.js
```

在你的 Shell 中，查看进程 1 的状态：

```shell
cd /proc/1
cat status
```

输出显示进程的权能位图：

```
...
CapPrm:	00000000a80425fb
CapEff:	00000000a80425fb
...
```

记下进程权能位图，之后退出你的 Shell：

```shell
exit
```

接下来运行一个与前例中容器相同的容器，只是这个容器有一些额外的权能设置。

下面是一个 Pod 的配置，其中运行一个容器。配置为容器添加 `CAP_NET_ADMIN` 和
`CAP_SYS_TIME` 权能：

示例文件：`pods/security/security-context-4.yaml`

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: security-context-demo-4
spec:
  containers:
  - name: sec-ctx-4
    image: gcr.io/google-samples/hello-app:2.0
    securityContext:
      capabilities:
        add: ["NET_ADMIN", "SYS_TIME"]
```

创建 Pod：

```shell
kubectl apply -f https://k8s.io/examples/pods/security/security-context-4.yaml
```

启动一个 Shell，进入到运行中的容器：

```shell
kubectl exec -it security-context-demo-4 -- sh
```

在你的 Shell 中，查看进程 1 的权能：

```shell
cd /proc/1
cat status
```

输出显示的是进程的权能位图：

```
...
CapPrm:	00000000aa0435fb
CapEff:	00000000aa0435fb
...
```

比较两个容器的权能位图：

```
00000000a80425fb
00000000aa0435fb
```

在第一个容器的权能位图中，位 12 和 25 是没有设置的。在第二个容器中，位 12
和 25 是设置了的。位 12 是 `CAP_NET_ADMIN` 而位 25 则是 `CAP_SYS_TIME`。
参见 [capability.h](https://github.com/torvalds/linux/blob/master/include/uapi/linux/capability.h)
了解权能常数的定义。

**说明：**

Linux 权能常数定义的形式为 `CAP_XXX`。但是你在 container 清单中列举权能时，
要将权能名称中的 `CAP_` 部分去掉。例如，要添加 `CAP_SYS_TIME`，
可在权能列表中添加 `SYS_TIME`。

## 为容器设置 Seccomp 配置

若要为容器设置 Seccomp 配置（Profile），可在你的 Pod 或 Container 清单的
`securityContext` 节中包含 `seccompProfile` 字段。该字段是一个 
[SeccompProfile](/docs/reference/generated/kubernetes-api/v1.37/#seccompprofile-v1-core)
对象，包含 `type` 和 `localhostProfile` 属性。
`type` 的合法选项包括 `RuntimeDefault`、`Unconfined` 和 `Localhost`。
`localhostProfile` 只能在 `type: Localhost` 配置下才可以设置。
该字段标明节点上预先设定的配置的路径，路径是相对于 kubelet 所配置的
Seccomp 配置路径（使用 `--root-dir` 设置）而言的。

下面是一个例子，设置容器使用节点上容器运行时的默认配置作为 Seccomp 配置：

```yaml
...
securityContext:
  seccompProfile:
    type: RuntimeDefault
```

下面是另一个例子，将 Seccomp 的样板设置为位于
`<kubelet-根目录>/seccomp/my-profiles/profile-allow.json`
的一个预先配置的文件。

```yaml
...
securityContext:
  seccompProfile:
    type: Localhost
    localhostProfile: my-profiles/profile-allow.json
```

## 为 Container 设置 AppArmor 配置   {#set-the-apparmor-profile-for-a-container}

要为 Container 设置 AppArmor 配置，请在 Container 的 `securityContext` 节中包含 `appArmorProfile` 字段。
`appArmorProfile` 字段是一个
[AppArmorProfile](/docs/reference/generated/kubernetes-api/v1.37/#apparmorprofile-v1-core)
对象，由 `type` 和 `localhostProfile` 组成。  
`type` 的有效选项包括 `RuntimeDefault`（默认）、`Unconfined` 和 `Localhost`。
只有当 `type` 为 `Localhost` 时，才能设置 `localhostProfile`。  
它表示节点上预配的配置文件的名称。
此配置需要被加载到所有适合 Pod 的节点上，因为你不知道 Pod 将被调度到哪里。  
关于设置自定义配置的方法，参见[使用配置文件设置节点](/zh-cn/docs/tutorials/security/apparmor/#setting-up-nodes-with-profiles)。

注意：如果 `containers[*].securityContext.appArmorProfile.type` 被显式设置为
`RuntimeDefault`，那么如果 AppArmor 未在 Node 上被启用，Pod 将不会被准入。  
然而，如果 `containers[*].securityContext.appArmorProfile.type` 未被指定，
则只有在节点已启用 AppArmor 时才会应用默认值（也是 `RuntimeDefault`）。  
如果节点已禁用 AppArmor，Pod 将被准入，但 Container 将不受 `RuntimeDefault` 配置的限制。

以下是将 AppArmor 配置设置为节点的容器运行时默认配置的例子：

```yaml
...
containers:
- name: container-1
  securityContext:
    appArmorProfile:
      type: RuntimeDefault
```

以下是将 AppArmor 配置设置为名为 `k8s-apparmor-example-deny-write` 的预配配置的例子：

```yaml
...
containers:
- name: container-1
  securityContext:
    appArmorProfile:
      type: Localhost
      localhostProfile: k8s-apparmor-example-deny-write
```

有关更多细节参见[使用 AppArmor 限制容器对资源的访问](/zh-cn/docs/tutorials/security/apparmor/)。

## 为 Container 赋予 SELinux 标签   {#assign-selinux-labels-to-a-container}

若要给 Container 设置 SELinux 标签，可以在 Pod 或 Container 清单的
`securityContext` 节包含 `seLinuxOptions` 字段。
`seLinuxOptions` 字段的取值是一个
[SELinuxOptions](/docs/reference/generated/kubernetes-api/v1.37/#selinuxoptions-v1-core)
对象。下面是一个应用 SELinux 标签的例子：

```yaml
...
securityContext:
  seLinuxOptions:
    level: "s0:c123,c456"
```

**说明：**

要指定 SELinux，需要在宿主操作系统中装载 SELinux 安全性模块。
在不支持 SELinux 的 Windows 和 Linux 工作节点上，此字段和下面描述的任何
SELinux 特性开关均不起作用。

### 高效重打 SELinux 卷标签

功能状态：SELinuxMountReadWriteOncePod，Kubernetes 1.36，stable；首次引入于 1.25。默认启用。

默认情况下，Kubernetes 通过使用挂载选项 `-o context=<label>`，立即为符合条件的卷应用 SELinux 标签。

要使用这项加速功能，必须满足下列条件：

* Pod 必须使用 PersistentVolumeClaim。
* Pod 的 `spec.securityContext.seLinuxChangePolicy` 字段为 nil（默认值）或 `MountOption`。

* Pod（或其中使用 PersistentVolumeClaim 的所有容器）必须设置 `seLinuxOptions`。

* 对应的 PersistentVolume 必须是：
  * 使用传统树内（In-Tree） `iscsi`、`rbd` 或 `fs` 卷类型的卷。
  * 或者是使用 CSI 驱动程序的卷
    CSI 驱动程序必须能够通过在 CSIDriver 实例中设置 `spec.seLinuxMount: true`
    以支持 `-o context` 挂载。

对于这些所有卷类型，重打 SELinux 标签的方式有所不同：
容器运行时为卷中的所有节点（文件和目录）递归地修改 SELinux 标签。
明确地说，这适用于 Kubernetes 临时卷，如 `secret`、`configMap`
和 `projected`，以及所有 CSIDriver 实例未明确宣布使用
`-o context` 选项进行挂载的卷。

当使用这种加速时，所有在同一个节点上同时使用相同适用卷的 Pod
**必须具有相同的 SELinux 标签**。具有不同 SELinux 标签的 Pod 将无法启动，
并且会处于 `ContainerCreating` 状态，直到使用该卷的所有其他
SELinux 标签的 Pod 被删除。

功能状态：SELinuxChangePolicy，Kubernetes 1.36，stable；首次引入于 1.32。默认启用。

对于不希望使用挂载选项来重新打标签的 Pod，可以将
`spec.securityContext.seLinuxChangePolicy` 设置为 `Recursive`。
当多个 Pod 共享同一节点上的单个卷，但使用不同的 SELinux 标签以允许同时访问此卷时，
此配置是必需的。例如，一个特权 Pod 运行时使用 `spc_t` 标签，
而一个非特权 Pod 运行时使用默认标签 `container_file_t`。
在不设置 `spec.securityContext.seLinuxChangePolicy`（或使用默认值 `MountOption`）的情况下，
这样的多个 Pod 中只能有一个在节点上运行，其他 Pod 会在 ContainerCreating 时报错
`conflicting SELinux labels of volume <卷名称>: <正运行的 Pod 的标签> and <未启动的 Pod 的标签>`。

#### SELinuxWarningController

为了更容易识别受 SELinux 卷重新打标签的变化所影响的 Pod，一个名为
`SELinuxWarningController` 的新控制器已被添加到 kube-controller-manager 中。
这个控制器默认是被禁用的，你可以通过设置 `--controllers=*,selinux-warning-controller`
[命令行标志](/zh-cn/docs/reference/command-line-tools-reference/kube-controller-manager/)或通过在
[KubeControllerManagerConfiguration 中设置 `genericControllerManagerConfiguration.controllers` 字段](/zh-cn/docs/reference/config-api/kube-controller-manager-config.v1alpha1/#controllermanager-config-k8s-io-v1alpha1-GenericControllerManagerConfiguration)来启用。
此控制器需要启用 `SELinuxChangePolicy` 特性门控。

当此控制器被启用时，它会观察运行中的 Pod。
当控制器检测到两个 Pod 使用相同的卷但具有不同的 SELinux 标签时：

1. 它会向这两个 Pod 发出一个事件。通过 `kubectl describe pod <Pod 名称>` 可以看到：

   ```
   SELinuxLabel "<Pod 上的标签>" conflicts with pod <另一个 Pod 名称> that uses the same volume as this pod with SELinuxLabel "<另一个 Pod 标签>". If both pods land on the same node, only one of them may access the volume.
   ```

2. 增加 `selinux_warning_controller_selinux_volume_conflict` 指标值。
   此指标将两个 Pod 的名称 + 命名空间作为标签，以便轻松识别受影响的 Pod。

集群管理员可以使用此信息识别此变更所影响的 Pod，并主动筛选出不需优化的 Pod
（即设置 `spec.securityContext.seLinuxChangePolicy: Recursive`）。

**警告：**

对于使用 SELinux 的集群，我们强烈建议在升级到 Kubernetes v1.37
或更高版本（届时 `SELinuxMount` 特性将正式发布并默认启用）之前，启用此控制器，并确保
`selinux_warning_controller_selinux_volume_conflict` 指标未报告任何冲突。

#### 特性门控

以下特性门控可以控制 SELinux 卷重新打标签的行为：

* `SELinuxMountReadWriteOncePod`：为具有 `accessModes: ["ReadWriteOncePod"]` 的卷启用优化。
  启用此特性门控是非常安全的，因为在这种访问模式下，不会出现两个 Pod 共享同一卷的情况。
  此特性门控在 1.36 版本中正式发布。

* `SELinuxChangePolicy`：启用 Pod 的 `spec.securityContext.seLinuxChangePolicy` 字段以及
  kube-controller-manager 中相关的 SELinuxWarningController。当具有不同 SELinux 标签的多个
  Pod 共享一个卷时，可以使用它来让这些 Pod 不参与挂载优化。自 1.36 起进入正式发布（GA）。

* `SELinuxMount`：对所有符合条件的卷启用该优化。自 1.37 起进入正式发布（GA）。
  从较早的、默认禁用 `SELinuxMount` 的 Kubernetes 版本升级时，建议先启用 `SELinuxChangePolicy`
  特性门控以及 SELinuxWarningController，以评估此次变更带来的影响。

## 管理对 `/proc` 文件系统的访问   {#proc-access}

功能状态：ProcMountType，Kubernetes 1.36，stable；首次引入于 1.12。默认启用。门控值已锁定。

对于遵循 OCI 运行时规范的运行时，容器默认运行模式下，存在多个被屏蔽且只读的路径。
这样做的结果是在容器的 mount 命名空间内会存在这些路径，并且这些路径的工作方式与容器是隔离主机时类似，
但容器进程无法写入它们。
被屏蔽的和只读的路径列表如下：

- 被屏蔽的路径：

  - `/proc/asound`
  - `/proc/acpi`
  - `/proc/kcore`
  - `/proc/keys`
  - `/proc/latency_stats`
  - `/proc/timer_list`
  - `/proc/timer_stats`
  - `/proc/sched_debug`
  - `/proc/scsi`
  - `/sys/firmware`
  - `/sys/devices/virtual/powercap`

- 只读的路径：

  - `/proc/bus`
  - `/proc/fs`
  - `/proc/irq`
  - `/proc/sys`
  - `/proc/sysrq-trigger`

对于某些 Pod，你可能希望绕过默认的路径屏蔽。
最常见的情况是你尝试在 Kubernetes 容器内（在 Pod 内）运行容器。

`securityContext` 字段 `procMount` 允许用户请求容器的 `/proc` 为 `Unmasked`，
或者由容器进程以读写方式挂载。这一设置也适用于不在 `/proc` 内的 `/sys/firmware` 路径。

```yaml
...
securityContext:
  procMount: Unmasked
```

**说明：**

将 `procMount` 设置为 Unmasked 需要将 Pod 规约中的 `spec.hostUsers`
的值设置为 `false`。换句话说：希望使用未被屏蔽的 `/proc` 或 `/sys`
路径的容器也必须位于 [user 命名空间](/zh-cn/docs/concepts/workloads/pods/user-namespaces/)中。
Kubernetes v1.12 到 v1.29 没有强制执行该要求。

## 讨论   {#discussion}

Pod 的安全上下文适用于 Pod 中的容器，也适用于 Pod 所挂载的卷（如果有的话）。
尤其是，`fsGroup` 和 `seLinuxOptions` 按下面的方式应用到挂载卷上：

* `fsGroup`：支持属主管理的卷会被修改，将其属主变更为 `fsGroup` 所指定的 GID，
  并且对该 GID 可写。进一步的细节可参阅
  [属主变更设计文档](https://git.k8s.io/design-proposals-archive/storage/volume-ownership-management.md)。

* `seLinuxOptions`：支持 SELinux 标签的卷会被重新打标签，以便可被 `seLinuxOptions`
  下所设置的标签访问。通常你只需要设置 `level` 部分。
  该部分设置的是赋予 Pod 中所有容器及卷的
  [多类别安全性（Multi-Category Security，MCS)](https://selinuxproject.org/page/NB_MLS)标签。

**警告：**

在为 Pod 设置 MCS 标签之后，所有带有相同标签的 Pod 可以访问该卷。
如果你需要跨 Pod 的保护，你必须为每个 Pod 赋予独特的 MCS 标签。

## 清理

删除之前创建的所有 Pod：

```shell
kubectl delete pod security-context-demo
kubectl delete pod security-context-demo-2
kubectl delete pod security-context-demo-3
kubectl delete pod security-context-demo-4
```

## ## 接下来

* [PodSecurityContext](/docs/reference/generated/kubernetes-api/v1.37/#podsecuritycontext-v1-core) API 定义
* [SecurityContext](/docs/reference/generated/kubernetes-api/v1.37/#securitycontext-v1-core) API 定义
* [CRI 插件配置指南](https://github.com/containerd/containerd/blob/main/docs/cri/config.md)
* [安全上下文的设计文档（英文）](https://github.com/kubernetes/design-proposals-archive/blob/main/auth/security_context.md)
* [属主管理的设计文档（英文）](https://github.com/kubernetes/design-proposals-archive/blob/main/storage/volume-ownership-management.md)
* [Pod 安全性准入](/zh-cn/docs/concepts/security/pod-security-admission/)
* [AllowPrivilegeEscalation 的设计文档（英文）](https://github.com/kubernetes/design-proposals-archive/blob/main/auth/no-new-privs.md)
* 关于在 Linux 系统中的安全机制的更多信息，可参阅
  [Linux 内核安全性能力概述](https://www.linux.com/learn/overview-linux-kernel-security-features)（注意：部分信息已过时）。
* 了解 Linux Pod 的 [user 命名空间](/zh-cn/docs/concepts/workloads/pods/user-namespaces/)。
* [OCI 运行时规范中的被屏蔽的路径](https://github.com/opencontainers/runtime-spec/blob/f66aad47309/config-linux.md#masked-paths)
