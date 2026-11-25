# 使用 DRA 为工作负载分配设备

功能状态：DynamicResourceAllocation，Kubernetes 1.35，stable；首次引入于 1.30。默认启用。门控值已锁定。

本文介绍如何使用**动态资源分配（DRA）** 为 Pod 分配设备。
这些指示说明面向工作负载运维人员。在阅读本文之前，请先了解 DRA 的工作原理以及相关术语，例如
ResourceClaim 和
ResourceClaimTemplate。
更多信息参阅[动态资源分配（DRA）](/zh-cn/docs/concepts/resource-management/dynamic-resource-allocation/)。

## 关于使用 DRA 分配设备 {#about-device-allocation-dra}

作为工作负载运维人员，你可以通过创建 ResourceClaim 或 ResourceClaimTemplate
来**申领**工作负载所需的设备。当你部署工作负载时，Kubernetes 和设备驱动会找到可用的设备，
将其分配给 Pod，并将 Pod 调度到可访问这些设备的节点上。

## ## 准备开始

你必须拥有一个 Kubernetes 的集群，且必须配置 kubectl 命令行工具让其与你的集群通信。
建议运行本教程的集群至少有两个节点，且这两个节点不能作为控制平面主机。
如果你还没有集群，你可以通过 [Minikube](https://minikube.sigs.k8s.io/docs/tutorials/multi_node/)
构建一个你自己的集群，或者你可以使用下面的 Kubernetes 练习环境之一：

* [iximiuz Labs](https://labs.iximiuz.com/playgrounds?category=kubernetes&filter=all)
* [Killercoda](https://killercoda.com/playgrounds/scenario/kubernetes)
* [KodeKloud](https://kodekloud.com/public-playgrounds)
 Kubernetes 服务端最低版本：v1.34。使用 `kubectl version` 检查版本。

* 请确保集群管理员已安装好 DRA，挂接了设备并安装了驱动程序。
  详情请参见[在集群中安装 DRA](/zh-cn/docs/tasks/configure-pod-container/assign-resources/set-up-dra-cluster)。

## 寻找可申领的设备  {#identify-devices}

你的集群管理员或设备驱动程序会创建定义设备类别的
DeviceClass。你可以使用
cel 表达式筛选特定的设备属性，从而申领设备。

获取集群中的 DeviceClass 列表：

```shell
kubectl get deviceclasses
```

输出类似如下：

```
NAME                 AGE
driver.example.com   16m
```

如果你遇到权限错误，你可能无权获取 DeviceClass。
请与你的集群管理员或驱动提供商联系，了解可用的设备属性。

## 申领资源 {#claim-resources}

你可以通过
ResourceClaim
请求某个 DeviceClass 的资源。要创建 ResourceClaim，可以采用以下方式之一：

* 手动创建 ResourceClaim，如果你希望多个 Pod 共享相同设备，或希望申领在 Pod 生命期结束后仍然存在。
* 使用
  ResourceClaimTemplate，
  让 Kubernetes 为每个 Pod 生成并管理 ResourceClaim。如果你希望每个 Pod
  访问独立的、具有类似配置的设备，你可以创建 ResourceClaimTemplate。例如，
  在使用[并行执行](/zh-cn/docs/concepts/workloads/controllers/job/#parallel-jobs)的
  Job 中，你可能希望多个 Pod 同时访问设备。

如果你在 Pod 中直接引用了特定 ResourceClaim，该 ResourceClaim 必须已存在于集群中。否则，
Pod 会保持在 Pending 状态，直到申领被创建。你可以在 Pod 中引用自动生成的 ResourceClaim，
但不推荐这样做，因为自动生成的 ResourceClaim 的生命期被绑定到了触发生成它的 Pod。

要创建申领资源的工作负载，请选择以下选项之一：

### ResourceClaimTemplate

查看以下示例清单：

示例文件：`dra/resourceclaimtemplate.yaml`

```yaml
apiVersion: resource.k8s.io/v1
kind: ResourceClaimTemplate
metadata:
  name: example-resource-claim-template
spec:
  spec:
    devices:
      requests:
      - name: gpu-claim
        exactly:
          deviceClassName: example-device-class
          selectors:
          - cel:
              expression: |-
                device.attributes["driver.example.com"].type == "gpu" &&
                device.capacity["driver.example.com"].memory == quantity("64Gi")
```

此清单会创建一个 ResourceClaimTemplate，它请求属于 `example-device-class`
DeviceClass、且同时满足以下两个参数的设备：

* 属性 `driver.example.com/type` 的值为 `gpu`
* 容量为 `64Gi`

创建 ResourceClaimTemplate 的命令如下：

```shell
kubectl apply -f https://k8s.io/examples/dra/resourceclaimtemplate.yaml
```

### ResourceClaim

查看以下示例清单：

示例文件：`dra/resourceclaim.yaml`

```yaml
apiVersion: resource.k8s.io/v1
kind: ResourceClaim
metadata:
  name: example-resource-claim
spec:
  devices:
    requests:
    - name: single-gpu-claim
      exactly:
        deviceClassName: example-device-class
        allocationMode: All
        selectors:
        - cel:
            expression: |-
              device.attributes["driver.example.com"].type == "gpu" &&
              device.capacity["driver.example.com"].memory == quantity("64Gi")
```

此清单会创建一个 ResourceClaim，请求属于 `example-device-class`
DeviceClass、且同时满足以下两个参数的设备：

* 属性 `driver.example.com/type` 的值为 `gpu`
* 容量为 `64Gi`

创建 ResourceClaim 的命令如下：

```shell
kubectl apply -f https://k8s.io/examples/dra/resourceclaim.yaml
```

## 使用 DRA 在工作负载中请求设备 {#request-devices-workloads}

要请求设备分配，请在 Pod 规约的 `resourceClaims` 字段中指定 ResourceClaim
或 ResourceClaimTemplate，然后在容器的 `resources.claims` 字段中按名称请求具体的资源申领。
你可以在 `resourceClaims` 中列出多个条目，并在不同容器中使用特定的申领。

1. 查看以下 Job 示例：

   

示例文件：`dra/dra-example-job.yaml`

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: example-dra-job
spec:
  completions: 10
  parallelism: 2
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: container0
        image: ubuntu:24.04
        command: ["sleep", "9999"]
        resources:
          claims:
          - name: separate-gpu-claim
      - name: container1
        image: ubuntu:24.04
        command: ["sleep", "9999"]
        resources:
          claims:
          - name: shared-gpu-claim
      - name: container2
        image: ubuntu:24.04
        command: ["sleep", "9999"]
        resources:
          claims:
          - name: shared-gpu-claim
      resourceClaims:
      - name: separate-gpu-claim
        resourceClaimTemplateName: example-resource-claim-template
      - name: shared-gpu-claim
        resourceClaimName: example-resource-claim
```

   

   此 Job 中的每个 Pod 具备以下属性：

   * 提供名为 `separate-gpu-claim` 的 ResourceClaimTemplate 和名为
     `shared-gpu-claim` 的 ResourceClaim 给容器使用。
   * 运行以下容器：

     * `container0` 请求 `separate-gpu-claim` ResourceClaimTemplate 中定义的设备。
     * `container1` 和 `container2` 共享对 `shared-gpu-claim` ResourceClaim 中设备的访问。

2. 创建 Job：

   ```shell
   kubectl apply -f https://k8s.io/examples/dra/dra-example-job.yaml
   ```

尝试以下故障排查步骤：

1. 当工作负载未如预期启动时，从 Job 到 Pod 再到 ResourceClaim 逐步深入检查，
   并使用 `kubectl describe` 检查每个层级的对象，
   查看是否有状态字段或事件可以解释工作负载为何没有启动。
2. 当创建 Pod 失败并显示 `must specify one of：resourceClaimName, resourceClaimTemplateName` 时，
   检查 `pod.spec.resourceClaims` 中的所有条目是否正好设置了这些字段之一。如果是这样，
   那么可能是集群安装了一个针对 Kubernetes < 1.32 的 API 构建的 Pod 变更 Webhook。
   请与你的集群管理员合作检查这个问题。

## 清理 {#clean-up}

要删除本任务中创建的 Kubernetes 对象，请按照以下步骤操作：

1. 删除示例 Job：

   ```shell
   kubectl delete -f https://k8s.io/examples/dra/dra-example-job.yaml
   ```

2. 运行以下其中一条命令来删除你的资源申领：

   * 删除 ResourceClaimTemplate：

     ```shell
     kubectl delete -f https://k8s.io/examples/dra/resourceclaimtemplate.yaml
     ```

   

   * 删除 ResourceClaim：

     ```shell
     kubectl delete -f https://k8s.io/examples/dra/resourceclaim.yaml
     ```

## ## 接下来

* [进一步了解 DRA](/zh-cn/docs/concepts/resource-management/dynamic-resource-allocation)
