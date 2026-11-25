# 设备污点与容忍度

本页介绍 DRA 中的设备污点与容忍度，它们允许驱动和管理员阻止 Pod
使用特定设备，或驱逐已经在使用这些设备的 Pod。

## 设备污点与容忍度 {#device-taints-and-tolerations}

功能状态：DRADeviceTaints，Kubernetes 1.37，stable；首次引入于 1.33。默认启用。门控值已锁定。

设备污点与节点污点类似：一个污点包含字符串键、字符串值以及效果。
该效果会应用到正在使用被污染设备的 ResourceClaim，以及引用该 ResourceClaim 的所有 Pod。
`NoSchedule` 效果会阻止这些 Pod 的调度。
在尝试分配 ResourceClaim 时，被污染的设备会被忽略，
因为使用它们会阻止 Pod 的调度。

`NoExecute` 效果暗含 `NoSchedule`，并且会额外驱逐所有已被调度的 Pod。
该驱逐由 kube-controller-manager 中的设备污点驱逐控制器通过删除受影响的 Pod 来实现。

调度器和驱逐控制器会忽略 `None` 效果。
DRA 驱动可以用它向管理员或其他控制器传达异常情况，
例如设备的健康状况下降。管理员也可以用它在 DeviceTaintRule
中执行 Pod 驱逐的试运行（更多见下文）。

ResourceClaim 可以容忍污点。如果某个污点被容忍，则其效果不会生效。
空的容忍度匹配所有污点。容忍度可以被限制为仅对某些效果生效，
和/或匹配某些键值对。容忍度可以检查某个键是否存在（无论其值是什么），
也可以检查键的特定值。有关这种匹配的更多信息，
请参阅[节点污点概念](/zh-cn/docs/concepts/scheduling-eviction/taint-and-toleration#concepts)。

通过在一段时间内容忍污点可以延迟驱逐。
该延迟从污点被添加到设备上的时间开始计算，
该时间记录在污点的一个字段中。

如上所述，污点同样适用于分配节点上"所有"设备的 ResourceClaim。
必须所有设备都未被打上污点，或者它们的所有污点都被容忍。
使用管理员访问（见[上文](#admin-access)的描述）分配设备同样不能豁免。
使用该模式的管理员必须显式容忍所有污点才能访问被污染的设备。

你可以通过使用 DeviceTaintRule API 种类，以以下方式向设备添加污点。

### 由驱动设置的污点

DRA 驱动可以向其在 ResourceSlice 中发布的设备信息添加污点。
请查阅 DRA 驱动的文档，了解该驱动是否使用污点以及其键和值是什么。

### 由管理员设置的污点

功能状态：DRADeviceTaintRules，Kubernetes 1.37，stable；首次引入于 1.35。默认启用。门控值已锁定。

管理员或控制平面组件可以直接为设备设置污点，
而无需告知 DRA 驱动在其 ResourceSlice 中的设备信息里包含污点。
他们通过创建 DeviceTaintRule 来实现。
每个 DeviceTaintRule 向匹配设备选择算符的设备添加一个污点。
如果没有选择算符，则不会有设备被污染。
这降低了因误操作遗漏选择算符而意外驱逐所有使用 ResourceClaim 的 Pod 的风险。

可以通过指定 DeviceClass、驱动、池和/或设备的名称来选择设备。
DeviceClass 会选择所有被该 DeviceClass 中的选择算符选中的设备。
仅使用驱动名称，管理员可以污染由该驱动管理的所有设备，
例如在整个集群中对该驱动进行某种维护时。
如果驱动管理节点本地的设备，添加池名称可以将污点限制到单个节点。

最后，添加设备名称可以选择一个特定设备。
如果需要，设备名称和池名称也可以单独使用。
例如，建议节点本地设备的驱动使用节点名称作为其池名称。
这样，使用该池名称设置污点会自动污染节点上的所有设备。

驱动可能使用像 "gpu-0" 这样的稳定名称，
隐藏了当前分配给该名称的是哪一个具体设备。
为了支持污染特定的硬件实例，如果驱动为其硬件提供了
特定于供应商的唯一 ID 属性，可以在 DeviceTaintRule 中使用 CEL
选择算符来匹配该属性。

只要 DeviceTaintRule 存在，污点就会生效。
它可以随时被修改和删除。
以下是一个针对虚构 DRA 驱动的 DeviceTaintRule 示例：

```yaml
apiVersion: resource.k8s.io/v1
kind: DeviceTaintRule
metadata:
  name: example
spec:
  # 该特定驱动的整个硬件安装已损坏。
  # 驱逐所有 Pod，且不调度新的 Pod。
  deviceSelector:
    driver: dra.example.com
  taint:
    key: dra.example.com/unhealthy
    value: Broken
    effect: NoExecute
```

kube-apiserver 通过设置 `spec` 中的 `timeAdded` 字段，
自动追踪该污点的创建时间。容忍期从该时间戳开始计算。
在变更效果的更新过程中（见下文的模拟驱逐流程），
kube-apiserver 会自动更新时间戳。用户可以在创建 DeviceTaintRule
时显式设置该字段，或在更新时改为其他值，从而显式控制时间戳。

status 中包含由驱逐控制器添加的一个条件：

```
kubectl describe devicetaintrules
```

```
Name:         example
...
Spec:
  Device Selector:
    Driver:  dra.example.com
  Taint:
    Effect:      NoExecute
    Key:         dra.example.com/unhealthy
    Time Added:  2025-11-05T18:15:37Z
    Value:       Broken
Status:
  Conditions:
    Last Transition Time:  2025-11-05T18:15:37Z
    Message:               1 pod evicted since starting the controller.
    Observed Generation:   1
    Reason:                Completed
    Status:                False
    Type:                  EvictionInProgress
Events:                    <none>
```

Pod 通过被删除来驱逐。通常这会很快发生，
除非对污点的容忍度将其延迟一段时间，或者有非常多的 Pod 需要驱逐。
如果驱逐花费的时间较长，`message` 会提供关于当前状态的信息：
    
    ```
    2 pods need to be evicted in 2 different namespaces. 1 pod evicted since starting the controller.
    ```

该状况可用于检查驱逐当前是否正在进行：

    ```
    kubectl wait --for=condition=EvictionInProgress=false DeviceTaintRule/example
    ```

请注意调度器和控制器在不同时间观察到新污点可能引发的竞态条件：
这可能导致在控制器认为没有需要驱逐的 Pod 从而将此条件设置为
`False` 时，仍有 Pod 被调度。实际中，通过刻意延迟几秒钟才更新状态，
这种竞态条件出现的可能性非常低。

对于 `effect: None`，message 会提供关于受影响设备数量、
其中已分配的设备数量，以及如果效果为 `NoExecute` 将会被驱逐的 Pod
数量的信息。这可以在实际触发驱逐之前用作试运行：

- 使用所需的选择算符和 `effect: None` 创建一个 DeviceTaintRule。

- 查看 message：

```
3 published devices selected. 1 allocated device selected.
1 pod would be evicted in 1 namespace if the effect was NoExecute.
This information will not be updated again. Recreate the DeviceTaintRule to trigger an update.
```

  
  已发布的设备是 ResourceSlice 中列出的设备。为它们设置污点会阻止为新 Pod 分配。
  只有已分配的设备才会导致使用它们的 Pod 被驱逐。

- 编辑 DeviceTaintRule，将效果更改为 `NoExecute`。
