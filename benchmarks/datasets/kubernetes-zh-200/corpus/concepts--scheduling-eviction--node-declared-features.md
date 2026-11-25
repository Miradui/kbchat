# 节点声明式特性

功能状态：NodeDeclaredFeatures，Kubernetes 1.37，stable；首次引入于 1.35。默认启用。门控值已锁定。

Kubernetes 节点使用 _声明式特性_ 来报告特定功能的可用性，包括新功能和特性门控功能。
控制平面组件利用这些信息以做出更好的决策。通过 `NodeDeclaredFeatures`，
kube-scheduler 确保 Pod 只被放置在明确满足 Pod 所需特性的节点上。 此外，
`NodeDeclaredFeatureValidator` 准入控制器会根据节点的声明式特性验证 Pod 更新。

这一机制帮助管理版本偏移并改善集群稳定性，尤其是集群在升级期间或集群处于混合版本环境时，
这些情况下各个节点可能没有都启用相同的特性。这是为 Kubernetes 特性开发人员准备的，
用于引入新的节点级特性并在后台运行；部署 Pod 的应用程序开发人员无需直接与此框架交互。

## 工作原理 {#how-it-works}

1.  **kubelet 特性报告：** 在启动时，每个节点上的 kubelet 会监测哪些受管理的
    Kubernetes 特性目前是启用的，并将其报告在节点的 `.status.declaredFeatures`
    字段中。只有积极开发的特性才会在此字段中列出。

2.  **调度过滤：** 默认的 kube-scheduler 使用 `NodeDeclaredFeatures` 插件。此插件：
    * 在 `PreFilter` 阶段，通过检查 `PodSpec` 来推断 Pod 所需要的阶段特性集。
    * 在 `Filter` 阶段，检查在节点 `.status.declaredFeatures`
      字段列出的特性是否满足推测的 Pod 需求。在缺少所需特性的节点上，Pod
      将不会被调度。自定义调度器同样可以利用 `.status.declaredFeatures`
      字段来确保执行类似的约束。

3.  **准入控制：** `NodeDeclaredFeatureValidator` 准入控制器可以拒绝 Pod
    绑定到那些 Pod 需要的特性未被声明的节点上，从而防止 Pod 更新期间出现问题。

## 启用节点声明式特性 {#enabling-node-declared-features}

想要使用节点声明式特性，必须在 `kube-apiserver`、`kube-scheduler` 和 `kubelet` 组件上启用
[`NodeDeclaredFeatures`](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/#NodeDeclaredFeatures) 特性门控。

## ## 接下来

* 阅读 KEP 以了解更多细节：
  [KEP-5328: Node Declared Features](https://github.com/kubernetes/enhancements/blob/6d3210f7dd5d547c8f7f6a33af6a09eb45193cd7/keps/sig-node/5328-node-declared-features/README.md)
* 阅读关于 [`NodeDeclaredFeatureValidator` 准入控制器](/zh-cn/docs/reference/access-authn-authz/admission-controllers/#nodedeclaredfeaturevalidator)
