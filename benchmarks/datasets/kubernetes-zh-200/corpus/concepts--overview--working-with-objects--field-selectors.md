# 字段选择算符

“字段选择算符（Field selectors）”允许你根据一个或多个资源字段的值筛选
Kubernetes 对象。
下面是一些使用字段选择算符查询的例子：

* `metadata.name=my-service`
* `metadata.namespace!=default`
* `status.phase=Pending`

下面这个 `kubectl` 命令将筛选出
[`status.phase`](/zh-cn/docs/concepts/workloads/pods/pod-lifecycle/#pod-phase)
字段值为 `Running` 的所有 Pod：

```shell
kubectl get pods --field-selector status.phase=Running
```

**说明：**

字段选择算符本质上是资源“过滤器（Filters）”。默认情况下，字段选择算符/过滤器是未被应用的，
这意味着指定类型的所有资源都会被筛选出来。
这使得 `kubectl get pods` 和 `kubectl get pods --field-selector ""`
这两个 `kubectl` 查询是等价的。

## 支持的字段  {#supported-fields}

不同的 Kubernetes 资源类型支持不同的字段选择算符。
所有资源类型都支持 `metadata.name` 和 `metadata.namespace` 字段。
使用不被支持的字段选择算符会产生错误。例如：

```shell
kubectl get ingress --field-selector foo.bar=baz
```

```
Error from server (BadRequest): Unable to find "ingresses" that match label selector "", field selector "foo.bar=baz": "foo.bar" is not a known field selector: only "metadata.name", "metadata.namespace"
```

### 支持字段列表

| 类别                       | 字段                                                                                                                                                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pod                       | `spec.nodeName`<br>`spec.restartPolicy`<br>`spec.schedulerName`<br>`spec.serviceAccountName`<br>`spec.hostNetwork`<br>`status.phase`<br>`status.podIP`<br>`status.podIPs`<br>`status.nominatedNodeName`                                                         |
| Event                     | `involvedObject.kind`<br>`involvedObject.namespace`<br>`involvedObject.name`<br>`involvedObject.uid`<br>`involvedObject.apiVersion`<br>`involvedObject.resourceVersion`<br>`involvedObject.fieldPath`<br>`reason`<br>`reportingComponent`<br>`source`<br>`type` |
| Secret                    | `type`                                                                                                                                                                                                                                                          |
| Service                   | `spec.clusterIP`<br>`spec.type`                                                                                                                                                                                                                                 | 
| Namespace                 | `status.phase`                                                                                                                                                                                                                                                  |
| ReplicaSet                | `status.replicas`                                                                                                                                                                                                                                               |
| ReplicationController     | `status.replicas`                                                                                                                                                                                                                                               |
| Job                       | `status.successful`                                                                                                                                                                                                                                             |
| Node                      | `spec.unschedulable`                                                                                                                                                                                                                                            |
| CertificateSigningRequest | `spec.signerName`                                                                                                                                                                                                                                               |

### 自定义资源字段

所有自定义资源类型都支持 `metadata.name` 和 `metadata.namespace` 字段。

此外，CustomResourceDefinition
的 `spec.versions[*].selectableFields` 字段声明了自定义资源中哪些其他字段可以用于字段选择算符。
有关如何使用 CustomResourceDefinitions 的字段选择算符的更多信息，
请参阅[自定义资源的选择字段](/zh-cn/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definitions/#crd-selectable-fields)。

## 支持的操作符   {#supported-operators}

你可在字段选择算符中使用 `=`、`==` 和 `!=`（`=` 和 `==` 的意义是相同的）操作符。
例如，下面这个 `kubectl` 命令将筛选所有不属于 `default` 命名空间的 Kubernetes Service：

```shell
kubectl get services  --all-namespaces --field-selector metadata.namespace!=default
```

**说明：**

[基于集合的操作符](/zh-cn/docs/concepts/overview/working-with-objects/labels/#set-based-requirement)
（`in`、`notin`、`exists`）不支持字段选择算符。

## 链式选择算符   {#chained-selectors}

同[标签](/zh-cn/docs/concepts/overview/working-with-objects/labels/)和其他选择算符一样，
字段选择算符可以通过使用逗号分隔的列表组成一个选择链。
下面这个 `kubectl` 命令将筛选 `status.phase` 字段不等于 `Running` 同时
`spec.restartPolicy` 字段等于 `Always` 的所有 Pod：

```shell
kubectl get pods --field-selector=status.phase!=Running,spec.restartPolicy=Always
```

## 多种资源类型   {#multiple-resource-types}

你能够跨多种资源类型来使用字段选择算符。
下面这个 `kubectl` 命令将筛选出所有不在 `default` 命名空间中的
StatefulSet 和 Service：

```shell
kubectl get statefulsets,services --all-namespaces --field-selector metadata.namespace!=default
```
