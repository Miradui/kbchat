# 拓扑感知的工作负载调度

功能状态：TopologyAwareWorkloadScheduling，Kubernetes 1.36，alpha；首次引入于 1.36。默认禁用。使用前需配置相应特性门控。

**拓扑感知调度**（Topology-Aware Scheduling，TAS）是一种[调度算法](/zh-cn/docs/concepts/scheduling-eviction/podgroup-scheduling/#placement-scheduling-algorithm)，
用于为指定的 PodGroup 寻找最优的放置位置，并保证所有 Pod 都被调度到同一拓扑域中。
用户可以通过修改 TAS 插件配置来适配自身的特定需求。

## 调度框架：TAS 插件配置 {#scheduling-framework-tas-plugins-configuration}

调度器包含了新的以及扩展的内置插件，用于实现 TAS 的扩展点：

* `TopologyPlacement`：实现了 `PlacementGeneratePlugin` 接口。
  它通过根据 PodGroup 中定义的拓扑 `key` 的不同取值对节点进行分组，从而生成候选放置方案。

* `NodeResourcesFit`：扩展实现了 `PlacementScorePlugin` 接口。其逻辑类似于标准的 Pod 装箱，
  基于放置中所有节点的资源分配比例对候选方案进行打分。它使用 `MostAllocated` 策略来最大化放置内的资源利用率，
  并继承了逐 Pod 插件中的资源权重设置。

* `PodGroupPodsCount`：实现了 `PlacementScorePlugin` 接口。
  它根据在该放置方案中可以成功调度的 PodGroup 中 Pod 的总数量来对候选方案进行评分。

### 自定义插件权重和装箱资源权重  {#customizing-plugin-weights-and-bin-packing-weights}

默认情况下，`NodeResourcesFit` 和 `PodGroupPodsCount` 插件具有相同的权重（默认均为 1），
以在装箱策略与尽可能多调度 Pod 之间保持良好的平衡。

你可以在 `KubeSchedulerConfiguration` 中调整这些权重，或修改装箱策略中的资源权重。
以下示例展示了如何更改这两个插件的权重，以及如何覆盖 `NodeResourcesFit` 的资源权重。
后者的修改将同时应用于逐 Pod 调度和放置评分算法：

```yaml
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
  - schedulerName: default-scheduler
    plugins:
      placementScore:
        enabled:
          # 1) 修改放置评分插件的默认权重
          - name: NodeResourcesFit
            weight: 2
          - name: PodGroupPodsCount
            weight: 5
    pluginConfig:
      - name: NodeResourcesFit
        args:
          # 2) 修改逐 Pod 和放置评分算法中的资源评分权重
          scoringStrategy:
            # 此类别仅在逐 Pod 调度中生效。放置评分始终使用 MostAllocated 策略
            type: LeastAllocated
            # 资源权重将同时应用于逐 Pod 和放置评分算法
            resources:
              - name: cpu
                weight: 2
              - name: memory
                weight: 3
```

## 多级拓扑放置  {#multi-level-topology-placements}

功能状态：CompositePodGroup，Kubernetes 1.37，alpha；首次引入于 1.37。默认禁用。使用前需配置相应特性门控。

当启用了
[`CompositePodGroup`](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/#CompositePodGroup)特性门控和
`scheduling.k8s.io/v1alpha3` API 组时，
拓扑感知调度插件将其支持扩展到多级 `CompositePodGroup` 层次结构。
在[层次化调度](/zh-cn/docs/concepts/scheduling-eviction/podgroup-scheduling/)过程中，
这些插件会被 `CompositePodGroup` 调用。

### 候选放置方案生成  {#candidate-placement-generation}

对于通过 `CompositePodGroup` 层次结构定义的工作负载，`TopologyPlacement` 插件通过逐级细分，
自顶向下地在组层次结构中生成候选放置方案：

* 对于根 `CompositePodGroup`，`TopologyPlacement` 根据所请求拓扑 `key` 的不同取值对节点进行分组，
  从而在所有可用集群节点中生成候选放置方案。
* 对于子 `CompositePodGroup` 或叶子 `PodGroup`，`TopologyPlacement` 在父组所假定的放置范围内生成候选放置方案。
  它基于子组所请求的拓扑 `key`，对父组放置中的节点集合进行分组细分。

**说明：**

如果未指定拓扑约束，`TopologyPlacement` 插件将生成一个与父放置方案等价的单个候选放置方案。

类似地，如果根组未指定任何拓扑约束，插件将生成一个对应于集群中所有可用节点的单个候选放置方案。
对于使用 `PodGroup` API 且未指定拓扑约束的单级工作负载，同样如此。

### 放置评分  {#placement-scoring}

在对 `CompositePodGroup` 的候选放置方案进行评分时，评分插件所采用的逻辑与单级 `PodGroup` 的情况类似：

* `PodGroupPodsCount`：基于该 `CompositePodGroup` 的所有后代叶子 `PodGroup` 中
  Pod 的总数（包括已调度的和已假定的）对候选放置方案进行评分。
  能够在子层次结构中容纳更多 Pod 的候选放置方案将获得更高的评分。
* `NodeResourcesFit`：汇总该 `CompositePodGroup` 的所有后代 `PodGroup` 中所有提议 Pod 的资源请求，
  并评估候选放置方案域内所有节点的资源利用率。

## ## 接下来

* 进一步了解[拓扑感知调度 API](/zh-cn/docs/concepts/workloads/workload-api/topology-aware-scheduling/)。
* 参阅 [Pod 组调度](/zh-cn/docs/concepts/scheduling-eviction/podgroup-scheduling/)的内容。
* 参阅 [Pod 组策略](/zh-cn/docs/concepts/workloads/workload-api/policies/)的内容。
