# Finalizers

Finalizer 是带有命名空间的键，告诉 Kubernetes 等到特定的条件被满足后，
再完全删除被标记为删除的资源。
Finalizer 提醒控制器清理被删除的对象拥有的资源。

当你告诉 Kubernetes 删除一个指定了 Finalizer 的对象时，
Kubernetes API 通过填充 `.metadata.deletionTimestamp` 来标记要删除的对象，
并返回 `202` 状态码（HTTP "已接受"）使其进入只读状态。
此时控制平面或其他组件会采取 Finalizer 所定义的行动，
而目标对象仍然处于终止中（Terminating）的状态。
这些行动完成后，控制器会删除目标对象相关的 Finalizer。
当 `metadata.finalizers` 字段为空时，Kubernetes 认为删除已完成并删除对象。

你可以使用 Finalizer 控制资源的垃圾收集。
例如，你可以定义一个 Finalizer，在删除目标资源前清理相关
API 资源或基础设施。

你可以使用 Finalizers 来控制对象的垃圾回收，
方法是在删除目标资源之前提醒控制器执行特定的清理任务。

Finalizers 通常不指定要执行的代码。
相反，它们通常是特定资源上的键的列表，类似于注解。
Kubernetes 自动指定了一些 Finalizers，但你也可以指定你自己的。

## Finalizers 如何工作   {#how-finalizers-work}

当你使用清单文件创建资源时，你可以在 `metadata.finalizers` 字段指定 Finalizers。
当你试图删除该资源时，处理删除请求的 API 服务器会注意到 `finalizers` 字段中的值，
并进行以下操作：

* 修改对象，将你开始执行删除的时间添加到 `metadata.deletionTimestamp` 字段。
* 禁止对象被删除，直到其 `metadata.finalizers` 字段内的所有项被删除。
* 返回 `202` 状态码（HTTP "Accepted"）。

管理 finalizer 的控制器注意到对象上发生的更新操作，对象的 `metadata.deletionTimestamp`
被设置，意味着已经请求删除该对象。然后，控制器会试图满足资源的 Finalizers 的条件。
每当一个 Finalizer 的条件被满足时，控制器就会从资源的 `finalizers` 字段中删除该键。
当 `finalizers` 字段为空时，`deletionTimestamp` 字段被设置的对象会被自动删除。
你也可以使用 Finalizers 来阻止删除未被管理的资源。

一个常见的 Finalizer 的例子是 `kubernetes.io/pv-protection`，
它用来防止意外删除 `PersistentVolume` 对象。
当一个 `PersistentVolume` 对象被 Pod 使用时，
Kubernetes 会添加 `pv-protection` Finalizer。
如果你试图删除 `PersistentVolume`，它将进入 `Terminating` 状态，
但是控制器因为该 Finalizer 存在而无法删除该资源。
当 Pod 停止使用 `PersistentVolume` 时，
Kubernetes 清除 `pv-protection` Finalizer，控制器就会删除该卷。

**说明：**

* 当你 `DELETE` 一个对象时，Kubernetes 为该对象添加删除时间戳，
  然后立即开始限制对这个正处于待删除状态的对象的 `.metadata.finalizers` 字段进行修改。
  你可以删除现有的 finalizers （从 `finalizers` 列表删除条目），但你不能添加新的 finalizer。
  对象的 `deletionTimestamp` 被设置后也不能修改。

* 删除请求已被发出之后，你无法复活该对象。唯一的方法是删除它并创建一个新的相似对象。

**说明：**

自定义 finalizer 名称**必须**是公开限定的 finalizer 名称，例如 `example.com/finalizer-name`。
Kubernetes 强制要求使用此格式；
如果任意自定义 finalizer 在更改时未使用限定的 finalizer 名称，API 服务器将拒绝写入到这些对象。

**说明：**

自定义的 finalizer 名称**必须**是具有公共限定前缀的 finalizer 名称，
例如 `example.com/finalizer-name`。Kubernetes 强制要求使用这种格式；
如果对象中的更改未使用合规的限定格式，API 服务器将拒绝写入包含自定义 finalizer 的对象。

## 属主引用、标签和 Finalizers {#owners-labels-finalizers}

与标签类似，
[属主引用](/zh-cn/docs/concepts/overview/working-with-objects/owners-dependents/)描述了
Kubernetes 中对象之间的关系，但它们作用不同。
当一个控制器管理类似于
Pod 的对象时，它使用标签来跟踪相关对象组的变化。
例如，当 Job 创建一个或多个 Pod 时，
Job 控制器会给这些 Pod 应用上标签，并跟踪集群中的具有相同标签的 Pod 的变化。

Job 控制器还为这些 Pod 添加了“属主引用”，指向创建 Pod 的 Job。
如果你在这些 Pod 运行的时候删除了 Job，
Kubernetes 会使用属主引用（而不是标签）来确定集群中哪些 Pod 需要清理。

当 Kubernetes 识别到要删除的资源上的属主引用时，它也会处理 Finalizers。

在某些情况下，Finalizers 会阻止依赖对象的删除，
这可能导致目标属主对象被保留的时间比预期的长，而没有被完全删除。
在这些情况下，你应该检查目标属主和附属对象上的 Finalizers 和属主引用，来排查原因。

**说明：**

在对象卡在删除状态的情况下，要避免手动移除 Finalizers，以允许继续删除操作。
Finalizers 通常因为特殊原因被添加到资源上，所以强行删除它们会导致集群出现问题。
只有了解 finalizer 的用途时才能这样做，并且应该通过一些其他方式来完成
（例如，手动清除其余的依赖对象）。

## ## 接下来

* 在 Kubernetes 博客上阅读[使用 Finalizers 控制删除](/blog/2021/05/14/using-finalizers-to-control-deletion/)。
