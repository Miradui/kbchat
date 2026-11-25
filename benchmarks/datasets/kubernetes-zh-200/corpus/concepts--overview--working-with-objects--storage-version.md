# 存储版本

Kubernetes API 服务器在存储对象时，依赖于一个与 etcd 兼容的后端存储
（通常该后端存储就是 etcd 本身）。每个对象都使用该 API 类型的某个特定版本进行序列化；
例如 ConfigMap 的 v1 表示形式。Kubernetes 使用术语**存储版本**来描述对象在你的集群中是如何存储的。

Kubernetes API 还依赖于自动转换；例如，如果你有一个
HorizontalPodAutoscaler，则你可以使用 HorizontalPodAutoscaler API 的 v1 和 v2
版本的任意组合与该 HorizontalPodAutoscaler 进行交互。Kubernetes 负责转换每个 API 调用，
使得客户端不会看到实际被序列化的版本。

对于集群管理员而言，对象存储版本是一个需要理解的重要概念，
因为它将对象的 API 表示与存储后端中的实际编码关联起来。
当对象的底层二进制编码变得重要时（例如静态加密或 API 弃用），这一点可能非常关键。

同一 API 可能具有多个存储版本，API 服务器可以将这些存储版本转换为某个对象模式。
属于该资源的单个对象在任何时候只能有一个存储版本。
这意味着 API 服务器知晓对象的二进制编码，并能够在所有已存储的版本之间动态转换，
以得到对象的 API 表示。

对象的版本与存储版本完全独立。例如，只要两个对象之间存储版本没有被更新过，
同一资源的 `v1alpha1` 和 `v1beta1` API 对象在存储中的编码就是相同的。

## 存储版本与资源的映射   {#storage-version-to-resource-mapping}

每个资源在任意时刻都只有一个活跃的存储版本，这意味着对对象的任何写入操作都会以该存储版本存储对象。
不过，存储版本可以被更新，使得对象可以以不同的版本存储。一个对象在任何时候只会以一种存储版本存储。

从 API 服务器读取数据时，会将已存储的数据转换为对象的 API 表示。
这使得旧的存储版本可以无限期存在，只要该对象没有发生更新。
另一方面，写入操作则会在更新时将已存储的对象转换为新的表示。

## 自定义资源的存储版本   {#CustomResourceDefinition-storage-version}

[自定义资源](/zh-cn/docs/concepts/extend-kubernetes/api-extension/custom-resources/#storage)是动态定义的，
因此其存储版本与内置 Kubernetes 类型有所不同。内置对象的存储编码通常与其 API 类型分开定义，
其中已存储的对象充当枢纽，特定资源版本除了作为对象模式中的一个字段外并不重要。

而对于自定义资源，必须将资源的某个版本设置为存储版本。
该特定版本的自定义资源所定义的模式将用作资源在存储层的编码。
有关 API 设置和版本控制的更多详细信息，参阅
[CRD 高级特性](/zh-cn/docs/concepts/extend-kubernetes/api-extension/custom-resources/#advanced-features-and-flexibility)。

例如，查看以下 **crontabs** 的 CustomResourceDefinition：

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: crontabs.example.com
spec:
  group: example.com
  # CustomResourceDefinition 支持的版本列表
  versions:
  - name: v1beta1
    # 每个版本可通过所用的参数来启用/禁用
    served: true
    # 必须将一个版本标记为存储版本
    storage: true
    schema:
      openAPIV3Schema:
        type: object
        properties:
          host:
            type: string
          port:
            type: string
  - name: v1
    served: true
    storage: false
    schema:
      openAPIV3Schema:
        type: object
        properties:
          host:
            type: string
          port:
            type: string
          time:
            type: string
  conversion:
    strategy: None
  scope: Namespaced
  names:
    plural: crontabs
    singular: crontab
    kind: CronTab
    shortNames:
    - ct
```

`v1beta1` API 定义被用作存储版本，这意味着对 `crontabs` 的任何更新或创建操作都会以
`v1beta1` API 的对象模式进行存储。在本例中，这实际上意味着 `v1` API 对象将永远无法存储 `time` 字段，
因为该字段不属于存储定义的一部分。此模式在存储层用作对象本身的二进制编码。
尝试同时将两个版本设置为存储版本是无效的，
因为那将意味着两种数据模式会同时被视为存储对象的有效方式。

当修改用于存储的版本时，该版本的 API 将用于存储任何新建或更新的 CR。
监视或获取对象时对象仍在使用中，但只会从旧的存储版本转换对象，不影响对象本身。
只有更新或创建操作才会生效并使用新定义的存储版本。

## 存储版本与静态加密的关系   {#how-storage-versions-are-relevant-to-encryption-at-rest}

有一些工具可以对集群的[静态存储进行加密](/zh-cn/docs/tasks/administer-cluster/kms-provider/)，
尤其是针对集群的 Secret。这为防范数据泄露增加了额外的保护层，
因为集群中实际存储的数据是加密的。这意味着 API 服务器在从存储中检索数据时实际上在解密数据。
API 服务器必须拥有该存储版本对应的密钥，才能正确解码对象。

在这种情况下，存储版本不仅仅是对象的二进制编码。
只要所存储的内容能够以某种方式转换为 API 对象，就可以将其用作存储版本。

## 迁移到不同的存储版本   {#migrating-to-a-different-storage-version}

单个资源有多个存储版本可能给集群管理员带来问题。
在确定所有对象都不再使用与某个 API 版本关联的存储版本之前，
集群管理员可能无法移除该可能不再受支持的 CRD API 旧版本。
由于对象数量庞大，且无法直观地辨别哪些对象是新的、
哪些对象仍由旧的存储版本支撑，因此很难判断何时可以安全地移除某个版本。
如果过早移除某个版本，可能导致完全无法读取对象。

另一个重要问题是上文提到的加密密钥的使用。由于必须主动使用资源才能更新其存储版本，
当进行密钥轮换时，旧加密密钥和新加密密钥都必须保持在使用状态，
直到管理员确信所有对象至少被写入过一次。
这同时带来安全风险和可用性问题，因为在此之前密钥无法被完全停用。

参阅[存储版本迁移](/zh-cn/docs/tasks/manage-kubernetes-objects/storage-version-migration)，
了解如何运行迁移以确保所有对象都使用较新的存储版本而无需人工干预的示例。
