# 镜像

容器镜像（Image）所承载的是封装了应用程序及其所有软件依赖的二进制数据。
容器镜像是可执行的软件包，可以单独运行；该软件包对所处的运行时环境具有明确定义的运行时环境假定。

你通常会创建应用的容器镜像并将其推送到某仓库（Registry），然后在
Pod 中引用它。

本页概要介绍容器镜像的概念。

**说明：**

如果你正在寻找 Kubernetes 某个发行版本（如最新次要版本 v1.37）
的容器镜像，请访问[下载 Kubernetes](/zh-cn/releases/download/)。

## 镜像名称    {#image-names}

容器镜像通常会被赋予 `pause`、`example/mycontainer` 或者 `kube-apiserver` 这类的名称。
镜像名称也可以包含所在仓库的主机名。例如：`fictional.registry.example/imagename`。
还可以包含仓库的端口号，例如：`fictional.registry.example:10443/imagename`。

如果你不指定仓库的主机名，Kubernetes 认为你在使用 [Docker 公共仓库](https://hub.docker.com/)。
你可以通过在[容器运行时](/zh-cn/docs/setup/production-environment/container-runtimes/)
配置中设置默认镜像仓库来更改此行为。

在镜像名称之后，你可以添加一个**标签（Tag）** 或 **摘要（digest）**
（与使用 `docker` 或 `podman` 等命令时的方式相同）。
使用标签能让你辨识同一镜像序列中的不同版本。
摘要是特定版本镜像的唯一标识符，是镜像内容的哈希值，不可变。

镜像标签可以包含小写字母、大写字母、数字、下划线（`_`）、句点（`.`）和连字符（`-`）。
标签的长度最多为 128 个字符，并且必须遵循正则表达式模式：`[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}`。
你可以在 [OCI 分发规范](https://github.com/opencontainers/distribution-spec/blob/master/spec.md#workflow-categories)
中阅读有关并找到验证正则表达式的更多信息。
如果你不指定标签，Kubernetes 认为你想使用标签 `latest`。

镜像摘要由哈希算法（例如 `sha256`）和哈希值组成，例如：
`sha256:1ff6c18fbef2045af6b9c16bf034cc421a29027b800e4f9b68ae9b1cb3e9ae07`。
你可以在 [OCI 镜像规范](https://github.com/opencontainers/image-spec/blob/master/descriptor.md#digests)
中找到有关摘要格式的更多信息。

Kubernetes 可以使用的一些镜像名称示例包括：

- `busybox` - 仅包含镜像名称，没有标签或摘要，Kubernetes 将使用 Docker 公共镜像仓库和 `latest` 标签。
  （例如 `docker.io/library/busybox:latest`）
- `busybox:1.32.0` - 带标签的镜像名称，Kubernetes 将使用 Docker 公共镜像仓库。
  （例如 `docker.io/library/busybox:1.32.0`）
- `registry.k8s.io/pause:latest` - 带有自定义镜像仓库和 `latest` 标签的镜像名称。
- `registry.k8s.io/pause:3.5` - 带有自定义镜像仓库和非 `latest` 标签的镜像名称。
- `registry.k8s.io/pause@sha256:1ff6c18fbef2045af6b9c16bf034cc421a29027b800e4f9b68ae9b1cb3e9ae07` - 带摘要的镜像名称。
- `registry.k8s.io/pause:3.5@sha256:1ff6c18fbef2045af6b9c16bf034cc421a29027b800e4f9b68ae9b1cb3e9ae07` - 带有标签和摘要的镜像名称，镜像拉取仅参考摘要。

## 更新镜像  {#updating-images}

当你最初创建一个 Deployment、
StatefulSet、Pod
或者其他包含 PodTemplate 的对象，且没有显式指定拉取策略时，
Pod 中所有容器的默认镜像拉取策略将被设置为 `IfNotPresent`。这一策略会使得
kubelet
在镜像已经存在的情况下直接略过拉取镜像的操作。

### 镜像拉取策略   {#image-pull-policy}

容器的 `imagePullPolicy` 和镜像的标签会影响
[kubelet](/zh-cn/docs/reference/command-line-tools-reference/kubelet/)
尝试拉取（下载）指定的镜像。

以下列表包含了 `imagePullPolicy` 可以设置的值，以及这些值的效果：

`IfNotPresent`
: 只有当镜像在本地不存在时才会拉取。

`Always`
: 每当 kubelet 启动一个容器时，kubelet
  会请求[容器运行时](/zh-cn/docs/reference/glossary/?all=true#term-container-runtime)拉取镜像。
  容器运行时查询镜像仓库，将镜像标签或名称解析为  
  [摘要](https://docs.docker.com/engine/reference/commandline/pull/#pull-an-image-by-digest-immutable-identifier)，  
  并下载任何未在本地缓存的层。如果所有层都已存在，容器运行时将使用缓存的镜像而不再次下载。  
  kubelet 自身不检查镜像是否已在本地缓存；它总是委托给容器运行时。

`Never`
: kubelet 不会尝试获取镜像。如果镜像已经以某种方式存在本地，
  kubelet 会尝试启动容器；否则，会启动失败。
  更多细节见[提前拉取镜像](#pre-pulled-images)。

只要能够可靠地访问镜像仓库，容器运行时的缓存机制使得即使设置了
`imagePullPolicy: Always`，也能保持高效。
容器运行时可以注意到节点上已经存在的镜像层，这样就不需要再次下载。

**说明：**

在生产环境中部署容器时，你应该避免使用 `:latest` 标签，
因为这使得正在运行的镜像的版本难以追踪，并且难以正确地回滚。

相反，应指定一个有意义的标签，如 `v1.42.0`，和/或者一个摘要。

为了确保 Pod 总是使用相同版本的容器镜像，你可以指定镜像的摘要；
将 `<image-name>:<tag>` 替换为 `<image-name>@<digest>`，例如
`image@sha256:45b23dee08af5e43a7fea6c4cf9c25ccf269ee113168c19722f87876677c5cb2`。

当使用镜像标签时，如果镜像仓库修改了代码所对应的镜像标签，可能会出现新旧代码混杂在 Pod 中运行的情况。
镜像摘要唯一标识了镜像的特定版本，因此 Kubernetes 每次启动具有指定镜像名称和摘要的容器时，都会运行相同的代码。
通过摘要指定镜像可固定你运行的代码，这样镜像仓库的变化就不会导致版本的混杂。

有一些第三方的[准入控制器](/zh-cn/docs/reference/access-authn-authz/admission-controllers/)
在创建 Pod（和 PodTemplate）时产生变更，这样运行的工作负载就是根据镜像摘要，而不是标签来定义的。
无论镜像仓库上的标签发生什么变化，你都想确保你的整个工作负载都运行相同的代码，那么指定镜像摘要会很有用。

#### 默认镜像拉取策略    {#imagepullpolicy-defaulting}

当你（或控制器）向 API 服务器提交一个新的 Pod 时，你的集群会在满足特定条件时设置
`imagePullPolicy` 字段：

- 如果你省略了 `imagePullPolicy` 字段，并且你为容器镜像指定了摘要，
  那么 `imagePullPolicy` 会自动设置为 `IfNotPresent`。
- 如果你省略了 `imagePullPolicy` 字段，并且容器镜像的标签是 `:latest`，
  `imagePullPolicy` 会自动设置为 `Always`。
- 如果你省略了 `imagePullPolicy` 字段，并且没有指定容器镜像的标签，
  `imagePullPolicy` 会自动设置为 `Always`。
- 如果你省略了 `imagePullPolicy` 字段，并且为容器镜像指定了非 `:latest` 的标签，
  `imagePullPolicy` 就会自动设置为 `IfNotPresent`。

**说明：**

容器的 `imagePullPolicy` 的值总是在对象初次**创建**时设置的，
如果后来镜像的标签或摘要发生变化，则不会更新。

例如，如果你用一个**非** `:latest` 的镜像标签创建一个 Deployment，
并在随后更新该 Deployment 的镜像标签为 `:latest`，则 `imagePullPolicy`
字段**不会**变成 `Always`。
你必须手动更改已经创建的资源的拉取策略。

#### 必要的镜像拉取   {#required-image-pull}

如果你想总是强制执行拉取，你可以使用下述的一种方式：

- 设置容器的 `imagePullPolicy` 为 `Always`。
- 省略 `imagePullPolicy`，并使用 `:latest` 作为镜像标签；
  当你提交 Pod 时，Kubernetes 会将策略设置为 `Always`。
- 省略 `imagePullPolicy` 和镜像的标签；
  当你提交 Pod 时，Kubernetes 会将策略设置为 `Always`。
- 启用准入控制器 [AlwaysPullImages](/zh-cn/docs/reference/access-authn-authz/admission-controllers/#alwayspullimages)。

### ImagePullBackOff

当 kubelet 使用容器运行时创建 Pod 时，容器可能因为 `ImagePullBackOff` 导致状态为
[Waiting](/zh-cn/docs/concepts/workloads/pods/pod-lifecycle/#container-state-waiting)。

`ImagePullBackOff` 状态意味着容器无法启动，
因为 Kubernetes 无法拉取容器镜像（原因包括无效的镜像名称，
或从私有仓库拉取而没有 `imagePullSecret`）。
`BackOff` 部分表示 Kubernetes 将继续尝试拉取镜像，并增加回退延迟。

Kubernetes 会增加每次尝试之间的延迟，直到达到编译限制，即 300 秒（5 分钟）。

### 基于运行时类的镜像拉取  {#image-pull-per-runtime-class}

功能状态：RuntimeClassInImageCriApi，Kubernetes 1.29，alpha；首次引入于 1.29。默认禁用。使用前需配置相应特性门控。

Kubernetes 包含了根据 Pod 的 RuntimeClass 来执行镜像拉取的 Alpha 支持。

如果你启用了 `RuntimeClassInImageCriApi`
[特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/)，
kubelet 会通过一个由镜像名称和运行时处理程序构成的元组而不仅仅是镜像名称或镜像摘要来引用容器镜像。
你的容器运行时可能会根据选定的运行时处理程序调整其行为。
基于运行时类来拉取镜像对于 Windows Hyper-V 容器这类基于 VM 的容器会有帮助。

## 串行和并行镜像拉取  {#serial-and-parallel-image-pulls}

默认情况下，kubelet 以串行方式拉取镜像。
也就是说，kubelet 一次只向镜像服务发送一个镜像拉取请求。
其他镜像拉取请求必须等待，直到正在处理的那个请求完成。

节点独立地做出镜像拉取的决策。即使你使用串行的镜像拉取，两个不同的节点也可以并行拉取相同的镜像。

如果你想启用并行镜像拉取，可以在 [kubelet 配置](/zh-cn/docs/reference/config-api/kubelet-config.v1beta1/)
中将字段 `serializeImagePulls` 设置为 false。
当 `serializeImagePulls` 设置为 false 时，kubelet
会立即向镜像服务发送镜像拉取请求，多个镜像将同时被拉动。

启用并行镜像拉取时，确保你的容器运行时的镜像服务可以处理并行镜像拉取。

kubelet 从不代表一个 Pod 并行地拉取多个镜像。
例如，如果你有一个 Pod，它有一个初始容器和一个应用容器，那么这两个容器的镜像拉取将不会并行。
但是，如果你有两个使用不同镜像的 Pod，且启用并行镜像拉取特性时，
kubelet 会代表两个不同的 Pod 并行拉取镜像。

### 最大并行镜像拉取数量  {#maximum-parallel-image-pulls}

功能状态：Kubernetes v1.35，stable。

当 `serializeImagePulls` 被设置为 false 时，kubelet 默认对同时拉取的最大镜像数量没有限制。
如果你想限制并行镜像拉取的数量，可以在 kubelet 配置中设置字段 `maxParallelImagePulls`。
当 `maxParallelImagePulls` 设置为 **n** 时，只能同时拉取 **n** 个镜像，
超过 **n** 的任何镜像都必须等到至少一个正在进行拉取的镜像拉取完成后，才能拉取。

当启用并行镜像拉取时，限制并行镜像拉取的数量来防止镜像拉取消耗过多的网络带宽或磁盘 I/O。

你可以将 `maxParallelImagePulls` 设置为大于或等于 1 的正数。
如果将 `maxParallelImagePulls` 设置为大于等于 2，则必须将 `serializeImagePulls` 设置为 false。
kubelet 在无效的 `maxParallelImagePulls` 设置下会启动失败。

## 带镜像索引的多架构镜像  {#multi-architecture-images-with-image-indexes}

除了提供二进制的镜像之外，
容器仓库也可以提供[容器镜像索引](https://github.com/opencontainers/image-spec/blob/master/image-index.md)。
镜像索引可以指向镜像的多个[镜像清单](https://github.com/opencontainers/image-spec/blob/master/manifest.md)，
提供特定于体系结构版本的容器。
这背后的理念是让你可以为镜像命名（例如：`pause`、`example/mycontainer`、`kube-apiserver`）
的同时，允许不同的系统基于它们所使用的机器体系结构获取正确的二进制镜像。

Kubernetes 项目通常在命名容器镜像时添加后缀 `-$(ARCH)`。
为了向前兼容，在生成较老的镜像时也提供后缀。
例如，名为 `pause` 的镜像是一个多架构镜像，包含所有受支持架构的镜像清单；
而 `pause-amd64` 是一个向后兼容的版本，用于旧的配置，
或用于 YAML 文件中硬编码了带后缀镜像名称的情况。

## 使用私有仓库   {#using-a-private-registry}

从私有仓库读取镜像时可能需要发现和/或拉取镜像的身份认证。凭据可以用以下方式提供:

- [当你定义 Pod 时指定 `imagePullSecrets`](#specifying-imagepullsecrets-on-a-pod)

  只有提供自己密钥的 Pod 才能访问私有仓库。

- [配置节点向私有仓库进行身份验证](#configuring-nodes-to-authenticate-to-a-private-registry)
  - 所有 Pod 均可读取任何已配置的私有仓库。
  - 需要集群管理员配置节点。

- 使用 **kubelet 凭据提供程序**[动态获取私有仓库的凭据](#kubelet-credential-provider)
  
  kubelet 可以被配置为使用凭据提供程序 exec 插件来访问对应的私有镜像库。

- [预拉镜像](#pre-pulled-images)
  - 所有 Pod 都可以使用节点上缓存的所有镜像。
  - 需要所有节点的 root 访问权限才能进行设置。
- 特定于厂商的扩展或者本地扩展
  
  如果你在使用定制的节点配置，你（或者云平台提供商）可以实现让节点向容器仓库认证的机制。

下面将详细描述每一项。

### 在 Pod 上指定 `imagePullSecrets`   {#specifying-imagepullsecrets-on-a-pod}

**说明：**

运行使用私有仓库中镜像的容器时，建议使用这种方法。

Kubernetes 支持在 Pod 中设置容器镜像仓库的密钥。所有 `imagePullSecrets`
必须全部与 Pod 位于同一个名字空间中。
这些 Secret 必须是 `kubernetes.io/dockercfg` 或 `kubernetes.io/dockerconfigjson` 类型。

### 配置 Node 对私有仓库认证  {#configuring-nodes-to-authenticate-to-a-private-registry}

设置凭据的具体说明取决于你选择使用的容器运行时和仓库。
你应该参考解决方案的文档来获取最准确的信息。

有关配置私有容器镜像仓库的示例，
请参阅任务[从私有镜像库中拉取镜像](/zh-cn/docs/tasks/configure-pod-container/pull-image-private-registry)。
该示例使用 Docker Hub 中的私有镜像仓库。

### 用于认证镜像拉取的 kubelet 凭据提供程序  {#kubelet-credential-provider}

你可以配置 kubelet，以调用插件可执行文件的方式来动态获取容器镜像的仓库凭据。
这是为私有仓库获取凭据最稳健和最通用的方法，但也需要 kubelet 级别的配置才能启用。

这种技术在运行依赖私有仓库中容器镜像的静态 Pod
时尤其有用。在静态 Pod 的规约中，不能使用 service-account
或 secret 来提供私有镜像仓库的凭据，
因为它**不能**在规约中引用其他 API 资源。

有关更多细节请参见[配置 kubelet 镜像凭据提供程序](/zh-cn/docs/tasks/administer-cluster/kubelet-credential-provider/)。

### config.json 说明 {#config-json}

对于 `config.json` 的解释在原始 Docker 实现和 Kubernetes 的解释之间有所不同。
在 Docker 中，`auths` 键只能指定根 URL，而 Kubernetes 允许 glob URL 以及前缀匹配的路径。
唯一的限制是 glob 模式（`*`）必须为每个子域名包括点（`.`）。
匹配的子域名数量必须等于 glob 模式（`*.`）的数量，例如：

- `*.kubernetes.io` **不**会匹配 `kubernetes.io`，但会匹配 `abc.kubernetes.io`。
- `*.*.kubernetes.io` **不**会匹配 `abc.kubernetes.io`，但会匹配 `abc.def.kubernetes.io`。
- `prefix.*.io` 将匹配 `prefix.kubernetes.io`。
- `*-good.kubernetes.io` 将匹配 `prefix-good.kubernetes.io`。

这意味着，像这样的 `config.json` 是有效的：

```json
{
    "auths": {
        "my-registry.example/images": { "auth": "…" },
        "*.my-registry.example/images": { "auth": "…" }
    }
}
```

镜像拉取操作将每种有效模式的凭据都传递给 CRI 容器运行时。
例如下面的容器镜像名称会匹配成功：

- `my-registry.example/images`
- `my-registry.example/images/my-image`
- `my-registry.example/images/another-image`
- `sub.my-registry.example/images/my-image`

但这些容器镜像名称**不会**匹配成功：

- `a.sub.my-registry.example/images/my-image`
- `a.b.sub.my-registry.example/images/my-image`

kubelet 为每个找到的凭据的镜像按顺序拉取。这意味着对于不同的路径在
`config.json` 中也可能有多项：

```json
{
    "auths": {
        "my-registry.example/images": {
            "auth": "…"
        },
        "my-registry.example/images/subpath": {
            "auth": "…"
        }
    }
}
```

如果一个容器指定了要拉取的镜像 `my-registry.io/images/subpath/my-image`，
并且其中一个失败，kubelet 将尝试同时使用两个身份验证源下载镜像。

### 提前拉取镜像   {#pre-pulled-images}

**说明：**

该方法适用于你能够控制节点配置的场合。
如果你的云供应商负责管理节点并自动置换节点，这一方案无法可靠地工作。

默认情况下，`kubelet` 会尝试从指定的仓库拉取每个镜像。
但是，如果容器属性 `imagePullPolicy` 设置为 `IfNotPresent` 或者 `Never`，
则会优先使用（对应 `IfNotPresent`）或者一定使用（对应 `Never`）本地镜像。

如果你希望使用提前拉取镜像的方法代替仓库认证，就必须保证集群中所有节点提前拉取的镜像是相同的。

这一方案可以用来提前载入指定的镜像以提高速度，或者作为向私有仓库执行身份认证的一种替代方案。

与使用 [kubelet 凭据提供程序](#kubelet-credential-provider)类似，
预拉取镜像也适用于启动依赖私有仓库中镜像的静态 Pod。

**说明：**

功能状态：KubeletEnsureSecretPulledImages，Kubernetes 1.35，beta；首次引入于 1.33。默认启用。

对预拉取镜像的访问可能需要根据[镜像拉取凭据验证](#ensureimagepullcredentialverification)进行授权。

### 镜像拉取凭据验证   {#ensureimagepullcredentialverification}

功能状态：KubeletEnsureSecretPulledImages，Kubernetes 1.35，beta；首次引入于 1.33。默认启用。

如果为你的集群启用了 `KubeletEnsureSecretPulledImages` 特性门控，Kubernetes
将验证每个需要凭据才能拉取的镜像的凭据，即使该镜像已经存在于节点上。
此验证确保了在 Pod 请求中未成功使用提供的凭据拉取的镜像必须从镜像仓库重新拉取。
此外，若之前使用相同的凭据已成功拉取过镜像，
则再次使用这些凭据的镜像拉取操作将不需要从镜像仓库重新拉取，
而是通过本地验证（前提是镜像在本地可用）而无需访问镜像仓库。这由
[kubelet 配置](/zh-cn/docs/reference/config-api/kubelet-config.v1beta1/#kubelet-config-k8s-io-v1beta1-ImagePullCredentialsVerificationPolicy)中的
`imagePullCredentialsVerificationPolicy` 字段控制。

此配置控制在镜像已经存在于节点上时，何时必须验证镜像拉取凭据：

* `NeverVerify`：模仿关闭此特性门控的行为。
  如果镜像本地存在，则不会验证镜像拉取凭据。

* `NeverVerifyPreloadedImages`：在 kubelet 外部拉取的镜像不会被验证，
  但所有其他镜像都将验证其凭据。这是默认行为。

* `NeverVerifyAllowListedImages`：在 kubelet 外部拉取且列在
  kubelet 配置中的 `preloadedImagesVerificationAllowlist` 里的镜像不会被验证。

* `AlwaysVerify`：所有镜像在使用前都必须验证其凭据。

这种验证适用于[预拉取镜像](#pre-pulled-images)、
使用节点范围的密钥拉取的镜像以及使用 Pod 级别密钥拉取的镜像。

**说明：**

在凭据轮换的情况下，之前用于拉取镜像的凭据将继续验证，
而无需访问镜像仓库新的或已轮换的凭据将要求从镜像仓库重新拉取镜像。

#### 首次启用 `KubeletEnsureSecretPulledImages`

当 `KubeletEnsureSecretPulledImages` 首次启用时（无论是通过 kubelet 升级还是显式启用此特性），
如果 kubelet 当时能够访问任何镜像，则这些镜像都将被视为已预先拉取。
这种情况发生是因为 kubelet 没有镜像被拉取的记录。
只有当镜像首次被拉取时，kubelet 才能开始记录镜像拉取的信息。

如果担心这个问题，建议在启用此特性之前，
清理节点上所有不应被视为预拉取的镜像。

请注意，删除包含镜像拉取记录的目录会对 kubelet 重启产生相同的影响，
特别是容器运行时当前缓存在节点上的镜像将全部被视为预拉取的镜像。

#### 使用 Docker Config 创建 Secret   {#creating-a-secret-with-docker-config}

你需要知道用于向仓库进行身份验证的用户名、密码和客户端电子邮件地址，以及它的主机名。
运行以下命令，注意用合适的值替换占位符：

```shell
kubectl create secret docker-registry <name> \
  --docker-server=<docker-registry-server> \
  --docker-username=<docker-user> \
  --docker-password=<docker-password> \
  --docker-email=<docker-email>
```

如果你已经有 Docker 凭据文件，则可以将凭据文件导入为 Kubernetes
Secret，
而不是执行上面的命令。
[基于已有的 Docker 凭据创建 Secret](/zh-cn/docs/tasks/configure-pod-container/pull-image-private-registry/#registry-secret-existing-credentials)
解释了如何完成这一操作。

如果你在使用多个私有容器仓库，这种技术将特别有用。
原因是 `kubectl create secret docker-registry` 创建的是仅适用于某个私有仓库的 Secret。

**说明：**

Pod 只能引用位于自身所在名字空间中的 Secret，因此需要针对每个名字空间重复执行上述过程。

#### 在 Pod 中引用 `ImagePullSecrets` {#referring-to-imagepullsecrets-on-a-pod}

现在，在创建 Pod 时，可以在 Pod 定义中增加 `imagePullSecrets` 部分来引用该 Secret。
`imagePullSecrets` 数组中的每一项只能引用同一名字空间中的一个 Secret。

例如：

```shell
cat <<EOF > pod.yaml
apiVersion: v1
kind: Pod
metadata:
  name: foo
  namespace: awesomeapps
spec:
  containers:
    - name: foo
      image: janedoe/awesomeapp:v1
  imagePullSecrets:
    - name: myregistrykey
EOF

cat <<EOF >> ./kustomization.yaml
resources:
- pod.yaml
EOF
```

你需要对使用私有仓库的每个 Pod 执行以上操作。

不过，设置该字段的过程也可以通过为[服务账号](/zh-cn/docs/tasks/configure-pod-container/configure-service-account/)资源设置
`imagePullSecrets` 来自动完成。有关详细指令，
可参见[将 ImagePullSecrets 添加到服务账号](/zh-cn/docs/tasks/configure-pod-container/configure-service-account/#add-imagepullsecrets-to-a-service-account)。

你也可以将此方法与节点级别的 `.docker/config.json` 配置结合使用。
来自不同来源的凭据会被合并。

### 使用案例  {#use-cases}

配置私有仓库有多种方案，以下是一些常用场景和建议的解决方案。

1. 集群运行非专有镜像（例如，开源镜像）。镜像不需要隐藏。
   - 使用来自公共仓库的公共镜像
     - 无需配置
     - 某些云厂商会自动为公开镜像提供高速缓存，以便提升可用性并缩短拉取镜像所需时间

2. 集群运行一些专有镜像，这些镜像需要对公司外部隐藏，对所有集群用户可见
   - 使用托管的私有仓库
     - 在需要访问私有仓库的节点上可能需要手动配置
   - 或者，在防火墙内运行一个组织内部的私有仓库，并开放读取权限
     - 不需要配置 Kubernetes
   - 使用控制镜像访问的托管容器镜像仓库服务
     - 与手动配置节点相比，这种方案能更好地处理节点自动扩缩容
   - 或者，在不方便更改节点配置的集群中，使用 `imagePullSecrets`

3. 集群使用专有镜像，且有些镜像需要更严格的访问控制
   - 确保 [AlwaysPullImages 准入控制器](/zh-cn/docs/reference/access-authn-authz/admission-controllers/#alwayspullimages)被启用。
     否则，所有 Pod 都可以使用所有镜像。
   - 确保将敏感数据存储在 Secret 资源中，而不是将其打包在镜像里。

4. 集群是多租户的并且每个租户需要自己的私有仓库
   - 确保 [AlwaysPullImages 准入控制器](/zh-cn/docs/reference/access-authn-authz/admission-controllers/#alwayspullimages)。
     否则，所有租户的所有的 Pod 都可以使用所有镜像。
   - 为私有仓库启用鉴权。
   - 为每个租户生成访问仓库的凭据，存放在 Secret 中，并将 Secret 发布到各租户的名字空间下。
   - 租户将 Secret 添加到每个名字空间中的 imagePullSecrets。

如果你需要访问多个仓库，可以为每个仓库创建一个 Secret。

## 旧版的内置 kubelet 凭据提供程序    {#legacy-built-in-kubelet-credentials-provider}

在旧版本的 Kubernetes 中，kubelet 与云提供商凭据直接集成。
这使它能够动态获取镜像仓库的凭据。

kubelet 凭据提供程序集成存在三个内置实现：
ACR（Azure 容器仓库）、ECR（Elastic 容器仓库）和 GCR（Google 容器仓库）。

从 Kubernetes v1.26 开始，旧版机制已被移除，因此你需要：

- 在每个节点上配置一个 kubelet 镜像凭据提供程序；或
- 使用 `imagePullSecrets` 和至少一个 Secret 指定镜像拉取凭据。

## ## 接下来

* 阅读 [OCI Image Manifest 规范](https://github.com/opencontainers/image-spec/blob/main/manifest.md)。
* 了解[容器镜像垃圾收集](/zh-cn/docs/concepts/architecture/garbage-collection/#container-image-garbage-collection)。
* 了解[从私有仓库拉取镜像](/zh-cn/docs/tasks/configure-pod-container/pull-image-private-registry)。
