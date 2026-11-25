# 在集群中安装 DRA

功能状态：DynamicResourceAllocation，Kubernetes 1.35，stable；首次引入于 1.30。默认启用。门控值已锁定。

本文介绍如何在 Kubernetes 集群中通过启用 API 组并配置设备类别来设置**动态资源分配（DRA）**。
这些指示说明适用于集群管理员。

## 关于 DRA {#about-dra}

Kubernetes 提供的一项特性，允许你在多个 Pod 之间请求和共享资源。  
这些资源通常是挂接的设备，例如硬件加速器。

借助 DRA，设备驱动和集群管理员可以定义设备的**类别**，这些类别可供工作负载中的 Pod 申领。
Kubernetes 会将匹配的设备分配给特定的申领，并将相应的 Pod 调度到能够访问这些已分配设备的节点上。

确保你已了解 DRA 的工作机制及其术语，例如
DeviceClasses、
ResourceClaims以及
ResourceClaimTemplates。
更多信息请参见[动态资源分配（DRA）](/zh-cn/docs/concepts/resource-management/dynamic-resource-allocation/)。

## ## 准备开始

你必须拥有一个 Kubernetes 的集群，且必须配置 kubectl 命令行工具让其与你的集群通信。
建议运行本教程的集群至少有两个节点，且这两个节点不能作为控制平面主机。
如果你还没有集群，你可以通过 [Minikube](https://minikube.sigs.k8s.io/docs/tutorials/multi_node/)
构建一个你自己的集群，或者你可以使用下面的 Kubernetes 练习环境之一：

* [iximiuz Labs](https://labs.iximiuz.com/playgrounds?category=kubernetes&filter=all)
* [Killercoda](https://killercoda.com/playgrounds/scenario/kubernetes)
* [KodeKloud](https://kodekloud.com/public-playgrounds)
 Kubernetes 服务端最低版本：v1.34。使用 `kubectl version` 检查版本。

* 将设备直接或间接挂接到你的集群中。为避免驱动相关的问题，请在安装驱动之前先完成 DRA 特性的配置。

## 可选：启用额外的 DRA API 组 {#enable-dra}

DRA 整体上已经是 Kubernetes 中的稳定特性；但其中的某些具体功能仍可能处于 Alpha 或 Beta 阶段。
如果你希望使用尚未稳定的 DRA 相关能力，并且该能力依赖于某个专用的 API 类别，
则你必须显式启用对应的 Alpha 或 Beta 级别的 API 组。
一些较旧的 DRA 驱动或工作负载可能仍需要 Kubernetes 1.30 的 v1beta1 API
或 Kubernetes 1.32 的 v1beta2 API。
当且仅当需要支持这些时，才启用以下
API 组：

   * `resource.k8s.io/v1beta1`
   * `resource.k8s.io/v1beta2`

带有独立 API 类型的 Alpha 特性需要启用：

   * `resource.k8s.io/v1alpha3`

更多信息请参阅[启用或禁用 API 组](/zh-cn/docs/reference/using-api/#enabling-or-disabling)。

## 验证是否启用了 DRA {#verify}

若要验证集群是否配置正确，可尝试列出 DeviceClass：

```shell
kubectl get deviceclasses
```

如果组件配置正确，输出类似如下：

```
No resources found
```

如果 DRA 未正确配置，则上述命令的输出可能如下：

```
error: the server doesn't have a resource type "deviceclasses"
```

例如，当 resource.k8s.io API 组被禁用时，就可能出现这种情况。
类似的检查同样适用于处于 Alpha 或 Beta 阶段的顶层 API 类型。

你可以尝试以下排查步骤：

1. 重新配置并重启 `kube-apiserver` 组件。

2. 如果从 Pod 中完全删除了 `.spec.resourceClaims` 字段，
   或者 Pod 在不考虑 ResourceClaim 的情况下被调度，
   那么请验证 `DynamicResourceAllocation` **特性门控**在
   kube-apiserver、kube-controller-manager、kube-schedule
   或 kubelet 组件中是否被关闭。

## 安装设备驱动 {#install-drivers}

你启用集群的 DRA 特性后，你可以安装所挂接设备的驱动。
安装方式请参见设备所有者或驱动维护方提供的文档。你安装的驱动必须与 DRA 兼容。

若要验证驱动是否正常工作，可列出集群中的 ResourceSlice：

```shell
kubectl get resourceslices
```

输出示例如下：

```
NAME                                                  NODE                DRIVER               POOL                             AGE
00000-driver.example.com-cluster-1-node-1-abcde      cluster-1-node-1    driver.example.com   cluster-1-device-pool-1-r1gc     7s
00000-driver.example.com-cluster-1-node-2-fghij      cluster-1-node-2    driver.example.com   cluster-1-device-pool-2-446z     8s
```

尝试以下故障排查步骤：

1. 检查 DRA 驱动的健康状况，并在其日志输出中查找关于发布 ResourceSlice
   的错误消息。驱动的供应商可能有关于安装和故障排除的进一步指示。

## 创建 DeviceClass {#create-deviceclasses}

你可以通过创建
DeviceClasses
定义设备的分类，供应用运维人员在工作负载中申领这些设备。
某些设备驱动提供方也可能在驱动安装过程中要求你创建 DeviceClass。

你的驱动所发布的 ResourceSlice 中包含了设备的相关信息，例如容量、元数据和属性。你可以使用
cel 表达式按 DeviceClass 中的属性进行筛选，
从而帮助工作负载运维人员更轻松地找到合适的设备。

1. 若要查看可通过 CEL 表达式在 DeviceClass 中选择的设备属性，你可以查看某个 ResourceSlice 的规约：

   ```shell
   kubectl get resourceslice <resourceslice-name> -o yaml
   ```

   

   输出类似如下：

   

   ```yaml
   apiVersion: resource.k8s.io/v1
   kind: ResourceSlice
   # 为简洁省略部分内容
   spec:
     devices:
      - attributes:
          type:
            string: gpu
        capacity:
          memory:
            value: 64Gi
        name: gpu-0
      - attributes:
          type:
            string: gpu
        capacity:
          memory:
            value: 64Gi
        name: gpu-1
     driver: driver.example.com
     nodeName: cluster-1-node-1
   # 为简洁省略部分内容
   ```

   

   你也可以查阅驱动提供商的文档，了解可用的属性和对应值。

2. 查看以下 DeviceClass 示例清单，它选择所有由 `driver.example.com` 设备驱动管理的设备：

   

示例文件：`dra/deviceclass.yaml`

```yaml
apiVersion: resource.k8s.io/v1beta2
kind: DeviceClass
metadata:
  name: example-device-class
spec:
  selectors:
  - cel:
      expression: |-
        device.driver == "driver.example.com"
```

3. 在集群中创建 DeviceClass：

   ```shell
   kubectl apply -f https://k8s.io/examples/dra/deviceclass.yaml
   ```

## 清理 {#clean-up}

要删除本任务中创建的 DeviceClass，运行以下命令：

```shell
kubectl delete -f https://k8s.io/examples/dra/deviceclass.yaml
```

## ## 接下来

* [进一步了解 DRA](/zh-cn/docs/concepts/resource-management/dynamic-resource-allocation)
* [使用 DRA 为工作负载分配设备](/zh-cn/docs/tasks/configure-pod-container/assign-resources/allocate-devices-dra)
