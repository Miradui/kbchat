# 服务账号

本页介绍 Kubernetes 中的 ServiceAccount 对象，
讲述服务账号的工作原理、使用场景、限制、替代方案，还提供了一些资源链接方便查阅更多指导信息。

## 什么是服务账号？  {#what-are-service-accounts}

服务账号是在 Kubernetes 中一种用于非人类用户的账号，在 Kubernetes 集群中提供不同的身份标识。
应用 Pod、系统组件以及集群内外的实体可以使用特定 ServiceAccount 的凭据来将自己标识为该 ServiceAccount。
这种身份可用于许多场景，包括向 API 服务器进行身份认证或实现基于身份的安全策略。

服务账号以 ServiceAccount 对象的形式存在于 API 服务器中。服务账号具有以下属性：

* **名字空间限定：** 每个服务账号都与一个 Kubernetes 名字空间绑定。
  每个名字空间在创建时，会获得一个[名为 `default` 的 ServiceAccount](#default-service-accounts)。

* **轻量级：** 服务账号存在于集群中，并在 Kubernetes API 中定义。你可以快速创建服务账号以支持特定任务。

* **可移植性：** 复杂的容器化工作负载的配置包中可能包括针对系统组件的服务账号定义。
  服务账号的轻量级性质和名字空间作用域的身份使得这类配置可移植。

服务账号与用户账号不同，用户账号是集群中通过了身份认证的人类用户。默认情况下，
用户账号不存在于 Kubernetes API 服务器中；相反，API 服务器将用户身份视为不透明数据。
你可以使用多种方法认证为某个用户账号。某些 Kubernetes 发行版可能会添加自定义扩展 API
来在 API 服务器中表示用户账号。

| 描述 | 服务账号 | 用户或组 |
| --- | --- | --- |
| 位置 | Kubernetes API（ServiceAccount 对象）| 外部 |
| 访问控制 | Kubernetes RBAC 或其他[鉴权机制](/zh-cn/docs/reference/access-authn-authz/authorization/#authorization-modules) | Kubernetes RBAC 或其他身份和访问管理机制 |
| 目标用途 | 工作负载、自动化工具 | 人 |

### 默认服务账号 {#default-service-accounts}

在你创建集群时，Kubernetes 会自动为集群中的每个名字空间创建一个名为 `default` 的 ServiceAccount 对象。
在启用了基于角色的访问控制（RBAC）时，Kubernetes 为所有通过了身份认证的主体赋予
[默认 API 发现权限](/zh-cn/docs/reference/access-authn-authz/rbac/#default-roles-and-role-bindings)。
每个名字空间中的 `default` 服务账号除了这些权限之外，默认没有其他访问权限。
如果基于角色的访问控制（RBAC）被启用，当你删除名字空间中的 `default` ServiceAccount 对象时，
控制平面会用新的 ServiceAccount 对象替换它。

如果你在某个名字空间中部署 Pod，并且你没有[手动为 Pod 指派 ServiceAccount](#assign-to-pod)，
Kubernetes 将该名字空间的 `default` 服务账号指派给这一 Pod。

## Kubernetes 服务账号的使用场景   {#use-cases}

一般而言，你可以在以下场景中使用服务账号来提供身份标识：

* 你的 Pod 需要与 Kubernetes API 服务器通信，例如在以下场景中：
  * 提供对存储在 Secret 中的敏感信息的只读访问。
  * 授予[跨名字空间访问](#cross-namespace)的权限，例如允许 `example` 名字空间中的 Pod 读取、列举和监视
    `kube-node-lease` 名字空间中的 Lease 对象。

* 你的 Pod 需要与外部服务进行通信。例如，工作负载 Pod 需要一个身份来访问某商业化的云 API，
  并且商业化 API 的提供商允许配置适当的信任关系。
* [使用 `imagePullSecret` 完成在私有镜像仓库上的身份认证](/zh-cn/docs/tasks/configure-pod-container/configure-service-account/#add-imagepullsecrets-to-a-service-account)。

* 外部服务需要与 Kubernetes API 服务器进行通信。例如，作为 CI/CD 流水线的一部分向集群作身份认证。
* 你在集群中使用了第三方安全软件，该软件依赖不同 Pod 的 ServiceAccount 身份，按不同上下文对这些 Pod 分组。

## 如何使用服务账号  {#how-to-use}

要使用 Kubernetes 服务账号，你需要执行以下步骤：

1. 使用像 `kubectl` 这样的 Kubernetes 客户端或定义对象的清单（manifest）创建 ServiceAccount 对象。
2. 使用鉴权机制（如 [RBAC](/zh-cn/docs/reference/access-authn-authz/rbac/)）为 ServiceAccount 对象授权。

3. 在创建 Pod 期间将 ServiceAccount 对象指派给 Pod。

   如果你所使用的是来自外部服务的身份，可以[获取 ServiceAccount 令牌](#get-a-token)，并在该服务中使用这一令牌。

有关具体操作说明，参阅[为 Pod 配置服务账号](/zh-cn/docs/tasks/configure-pod-container/configure-service-account/)。

### 为 ServiceAccount 授权   {#grant-permissions}

你可以使用 Kubernetes 内置的
[基于角色的访问控制 (RBAC)](/zh-cn/docs/reference/access-authn-authz/rbac/)机制来为每个服务账号授予所需的最低权限。
你可以创建一个用来授权的**角色**，然后将此角色**绑定**到你的 ServiceAccount 上。
RBAC 可以让你定义一组最低权限，使得服务账号权限遵循最小特权原则。
这样使用服务账号的 Pod 不会获得超出其正常运行所需的权限。

有关具体操作说明，参阅 [ServiceAccount 权限](/zh-cn/docs/reference/access-authn-authz/rbac/#service-account-permissions)。

#### 使用 ServiceAccount 进行跨名字空间访问   {#cross-namespace}

你可以使用 RBAC 允许一个名字空间中的服务账号对集群中另一个名字空间的资源执行操作。
例如，假设你在 `dev` 名字空间中有一个服务账号和一个 Pod，并且希望该 Pod 可以查看 `maintenance`
名字空间中正在运行的 Job。你可以创建一个 Role 对象来授予列举 Job 对象的权限。
随后在 `maintenance` 名字空间中创建 RoleBinding 对象将 Role 绑定到此 ServiceAccount 对象上。
现在，`dev` 名字空间中的 Pod 可以使用该服务账号列出 `maintenance` 名字空间中的 Job 对象集合。

### 将 ServiceAccount 指派给 Pod   {#assign-to-pod}

要将某 ServiceAccount 指派给某 Pod，你需要在该 Pod 的规约中设置 `spec.serviceAccountName` 字段。
Kubernetes 将自动为 Pod 提供该 ServiceAccount 的凭据。在 Kubernetes v1.22 及更高版本中，
Kubernetes 使用 `TokenRequest` API 获取一个短期的、**自动轮换**的令牌，
并以[投射卷](/zh-cn/docs/concepts/storage/projected-volumes/#serviceaccounttoken)的形式挂载此令牌。

默认情况下，Kubernetes 会将所指派的 ServiceAccount
（无论是 `default` 服务账号还是你指定的定制 ServiceAccount）的凭据提供给 Pod。

要防止 Kubernetes 自动注入指定的 ServiceAccount 或 `default` ServiceAccount 的凭据，
可以将 Pod 规约中的 `automountServiceAccountToken` 字段设置为 `false`。

在 Kubernetes 1.22 之前的版本中，Kubernetes 会将一个长期有效的静态令牌以 Secret 形式提供给 Pod。

#### 手动获取 ServiceAccount 凭据   {#get-a-token}

如果你需要 ServiceAccount 的凭据并将其挂载到非标准位置，或者用于 API 服务器之外的受众，可以使用以下方法之一：

* [TokenRequest API](/zh-cn/docs/reference/kubernetes-api/authentication-resources/token-request-v1/)（推荐）：
  在你自己的**应用代码**中请求一个短期的服务账号令牌。此令牌会自动过期，并可在过期时被轮换。
  如果你有一个旧的、对 Kubernetes 无感知能力的应用，你可以在同一个 Pod
  内使用边车容器来获取这些令牌，并将其提供给应用工作负载。

* [令牌卷投射](/zh-cn/docs/tasks/configure-pod-container/configure-service-account/#serviceaccount-token-volume-projection)（同样推荐）：
  在 Kubernetes v1.20 及更高版本中，使用 Pod 规约告知 kubelet 将服务账号令牌作为**投射卷**添加到 Pod 中。
  所投射的令牌会自动过期，在过期之前 kubelet 会自动轮换此令牌。

* [服务账号令牌 Secret](/zh-cn/docs/tasks/configure-pod-container/configure-service-account/#manually-create-an-api-token-for-a-serviceaccount)（不推荐）：
  你可以将服务账号令牌以 Kubernetes Secret 的形式挂载到 Pod 中。这些令牌不会过期且不会轮换。
  在 v1.24 版本之前，系统会为每个服务账户自动创建一个永久令牌。此方法已不再被推荐，
  尤其是在大规模应用时，因为使用静态、长期有效的凭证存在风险。
  [LegacyServiceAccountTokenNoAutoGeneration 特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates-removed)
  （从 Kubernetes v1.24 至 v1.26 默认启用），阻止 Kubernetes 自动为 ServiceAccount 创建这些令牌。
  此特性门控在 v1.27 版本中被移除，因为此特性已升级为正式发布（GA）状态；
  你仍然可以手动为 ServiceAccount 创建无限期的服务账户令牌，但应考虑到安全影响。

#### 服务账号令牌的节点受众限制  {#node-audience-restriction}

功能状态：ServiceAccountNodeAudienceRestriction，Kubernetes 1.33，beta；首次引入于 1.32。默认启用。

当启用了 `ServiceAccountNodeAudienceRestriction`
[特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/)时，
[NodeRestriction](/zh-cn/docs/reference/access-authn-authz/admission-controllers#noderestriction)
限制了 kubelet 在通过 `TokenRequest` API 创建服务账号令牌时可以请求的受众。
默认情况下，kubelet 只能请求该节点上已有 Pod 引用的受众（通过 projected 服务账号令牌卷或 CSI 驱动程序令牌请求）。
管理员可以使用带有 `request-serviceaccounts-token-audience`
动词的 RBAC 规则授予 kubelet 访问其他受众的权限。

此限制仅适用于 kubelet（节点身份），不影响 `TokenRequest` API 的其他调用者。
有关详细信息和 RBAC 示例，
请参阅[服务账号令牌受众限制](/zh-cn/docs/reference/access-authn-authz/node/#service-account-token-audience-restriction)。

**说明：**

对于运行在 Kubernetes 集群外的应用，你可能考虑创建一个长期有效的 ServiceAccount 令牌，
并将其存储在 Secret 中。尽管这种方式可以实现身份认证，但 Kubernetes 项目建议你避免使用此方法。
长期有效的持有者令牌（Bearer Token）会带来安全风险，一旦泄露，此令牌就可能被滥用。
为此，你可以考虑使用其他替代方案。例如，你的外部应用可以使用一个保护得很好的私钥和证书进行身份认证，
或者使用你自己实现的[身份认证 Webhook](/zh-cn/docs/reference/access-authn-authz/authentication/#webhook-token-authentication)
这类自定义机制。

你还可以使用 TokenRequest 为外部应用获取短期的令牌。

### 限制对 Secret 的访问（已弃用）  {#enforce-mountable-secrets}

功能状态：Kubernetes v1.32，deprecated。

**说明：**

`kubernetes.io/enforce-mountable-secrets` 自 Kubernetes v1.32 起已弃用。
你可以使用单独的命名空间来隔离对挂载 Secret 的访问。

Kubernetes 提供了名为 `kubernetes.io/enforce-mountable-secrets` 的注解，
你可以添加到你的 ServiceAccount 中。当应用了这个注解后，
ServiceAccount 的 Secret 只能挂载到特定类型的资源上，从而增强集群的安全性。

你可以使用以下清单将注解添加到一个 ServiceAccount 中：

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  annotations:
    kubernetes.io/enforce-mountable-secrets: "true"
  name: my-serviceaccount
  namespace: my-namespace
```

当此注解设置为 "true" 时，Kubernetes 控制平面确保来自该 ServiceAccount
的 Secret 受到特定挂载限制。

1. 在 Pod 中作为卷挂载的每个 Secret 的名称必须列在该 Pod 中 ServiceAccount 的 `secrets` 字段中。

2. 在 Pod 中使用 `envFrom` 引用的每个 Secret 的名称也必须列在该 Pod 中
   ServiceAccount 的 `secrets` 字段中。

3. 在 Pod 中使用 `imagePullSecrets` 引用的每个 Secret 的名称也必须列在该 Pod 中
   ServiceAccount 的 `secrets` 字段中。

通过理解并执行这些限制，集群管理员可以维护更严格的安全配置，并确保 Secret 仅被适当的资源访问。

## 对服务账号凭据进行鉴别   {#authenticating-credentials}

ServiceAccount 使用签名的 JSON Web Token（JWT）来向 Kubernetes API
服务器以及任何其他存在信任关系的系统进行身份认证。根据令牌的签发方式
（使用 `TokenRequest` 限制时间或使用传统的 Secret 机制），ServiceAccount
令牌也可能有到期时间、受众和令牌**开始**生效的时间点。
当客户端以 ServiceAccount 的身份尝试与 Kubernetes API 服务器通信时，
客户端会在 HTTP 请求中包含 `Authorization: Bearer <token>` 标头。
API 服务器按照以下方式检查该持有者令牌的有效性：

1. 检查令牌签名。
1. 检查令牌是否已过期。
1. 检查令牌申明中的对象引用是否当前有效。
1. 检查令牌是否当前有效。
1. 检查受众申明。

TokenRequest API 为 ServiceAccount 生成**绑定令牌**。这种绑定与以该 ServiceAccount
身份运行的客户端（如 Pod）的生命期相关联。有关绑定 Pod 服务账号令牌的 JWT 模式和载荷的示例，
请参阅[服务账号令牌卷投射](/zh-cn/docs/tasks/configure-pod-container/configure-service-account/#serviceaccount-token-volume-projection)。

对于使用 `TokenRequest` API 签发的令牌，API 服务器还会检查正在使用 ServiceAccount 的特定对象引用是否仍然存在，
方式是通过该对象的唯一 ID 进行匹配。
对于以 Secret 形式挂载到 Pod 中的旧有令牌，API 服务器会基于 Secret 来检查令牌。

有关身份认证过程的更多信息，参考[身份认证](/zh-cn/docs/reference/access-authn-authz/authentication/#service-account-tokens)。

### 在自己的代码中检查服务账号凭据   {#authenticating-in-code}

如果你的服务需要检查 Kubernetes 服务账号凭据，可以使用以下方法：

* [TokenReview API](/zh-cn/docs/reference/kubernetes-api/authentication-resources/token-review-v1/)（推荐）
* OIDC 发现

Kubernetes 项目建议你使用 TokenReview API，因为当你删除某些 API 对象
（如 Secret、ServiceAccount、Pod 和 Node）的时候，此方法将使绑定到这些 API 对象上的令牌失效。
例如，如果删除包含投射 ServiceAccount 令牌的 Pod，则集群立即使该令牌失效，
并且 TokenReview 操作也会立即失败。
如果你使用的是 OIDC 验证，则客户端将继续将令牌视为有效，直到令牌达到其到期时间戳。

你的应用应始终定义其所接受的受众，并检查令牌的受众是否与应用期望的受众匹配。
这有助于将令牌的作用域最小化，这样它只能在你的应用内部使用，而不能在其他地方使用。

## 替代方案   {#alternatives}

* 使用其他机制签发你自己的令牌，然后使用
  [Webhook 令牌身份认证](/zh-cn/docs/reference/access-authn-authz/authentication/#webhook-token-authentication)通过你自己的验证服务来验证持有者令牌。

* 为 Pod 提供你自己的身份：
  * [使用 SPIFFE CSI 驱动插件将 SPIFFE SVID 作为 X.509 证书对提供给 Pod](https://cert-manager.io/docs/projects/csi-driver-spiffe/)。
    

🛇 本条目指向第三方项目或产品，而该项目（产品）不是 Kubernetes 的一部分。[更多信息](#third-party-content-disclaimer)

  * [使用 Istio 这类服务网格为 Pod 提供证书](https://istio.io/latest/zh/docs/tasks/security/cert-management/plugin-ca-cert/)。

* 从集群外部向 API 服务器进行身份认证，而不使用服务账号令牌：
  * [配置 API 服务器接受来自你自己的身份驱动的 OpenID Connect（OIDC）令牌](/zh-cn/docs/reference/access-authn-authz/authentication/#openid-connect-tokens)。
  * 使用来自云提供商等外部身份和访问管理（IAM）服务创建的服务账号或用户账号向集群进行身份认证。
  * [使用 CertificateSigningRequest API 和客户端证书](/zh-cn/docs/tasks/tls/managing-tls-in-a-cluster/)。

* [配置 kubelet 从镜像仓库中获取凭据](/zh-cn/docs/tasks/administer-cluster/kubelet-credential-provider/)。
* 使用设备插件访问虚拟的可信平台模块（TPM），进而可以使用私钥进行身份认证。

## ## 接下来

* 学习如何[作为集群管理员管理你的 ServiceAccount](/zh-cn/docs/reference/access-authn-authz/service-accounts-admin/)。
* 学习如何[将 ServiceAccount 指派给 Pod](/zh-cn/docs/tasks/configure-pod-container/configure-service-account/)。
* 阅读 [ServiceAccount API 参考文档](/zh-cn/docs/reference/kubernetes-api/authentication-resources/service-account-v1/)。
