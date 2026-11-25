# 访问 DRA 设备元数据

功能状态：Kubernetes v1.36，alpha。

本页面展示如何从使用动态资源分配（DRA）的容器中访问
[设备元数据](/zh-cn/docs/concepts/scheduling-eviction/dynamic-resource-allocation/#device-metadata)。
设备元数据让工作负载能够发现有关已分配设备的信息（如设备属性或网络接口详细信息），
具体方式是在容器内的已知路径读取 JSON 文件。

在阅读本页面之前，你应该熟悉
[动态资源分配（DRA）](/zh-cn/docs/concepts/scheduling-eviction/dynamic-resource-allocation/)
以及如何[为工作负载分配设备](/zh-cn/docs/tasks/configure-pod-container/assign-resources/allocate-devices-dra/)。

## ## 准备开始

你必须拥有一个 Kubernetes 的集群，且必须配置 kubectl 命令行工具让其与你的集群通信。
建议运行本教程的集群至少有两个节点，且这两个节点不能作为控制平面主机。
如果你还没有集群，你可以通过 [Minikube](https://minikube.sigs.k8s.io/docs/tutorials/multi_node/)
构建一个你自己的集群，或者你可以使用下面的 Kubernetes 练习环境之一：

* [iximiuz Labs](https://labs.iximiuz.com/playgrounds?category=kubernetes&filter=all)
* [Killercoda](https://killercoda.com/playgrounds/scenario/kubernetes)
* [KodeKloud](https://kodekloud.com/public-playgrounds)
 Kubernetes 服务端最低版本：v1.36。使用 `kubectl version` 检查版本。

* 确保集群管理员已安装配置了 DRA、挂接了设备并安装了驱动程序。
  更多信息请参阅[在集群中设置 DRA](/zh-cn/docs/tasks/configure-pod-container/assign-resources/set-up-dra-cluster)。
* 确保集群中部署的 DRA 驱动程序支持设备元数据。
  使用 [DRA kubelet 插件](https://pkg.go.dev/k8s.io/dynamic-resource-allocation/kubeletplugin)
  的驱动程序在启动插件时会启用 `EnableDeviceMetadata` 和 `MetadataVersions` 选项。
  有关详细信息，请查阅驱动程序的文档。

## 通过 ResourceClaim 访问设备元数据    {#access-metadata-resourceclaim}

当你使用直接引用的 ResourceClaim 来分配设备时，
设备元数据文件会出现在容器内的以下路径：

```
/var/run/kubernetes.io/dra-device-attributes/resourceclaims/<claimName>/<requestName>/<driverName>-metadata.json
```

1. 查看以下示例清单：

   

示例文件：`dra/dra-device-metadata-pod.yaml`

```yaml
apiVersion: resource.k8s.io/v1
kind: ResourceClaim
metadata:
  name: gpu-claim
spec:
  devices:
    requests:
    - name: gpu
      exactly:
        deviceClassName: gpu.example.com
---
apiVersion: v1
kind: Pod
metadata:
  name: gpu-metadata-reader
spec:
  resourceClaims:
  - name: my-gpu
    resourceClaimName: gpu-claim
  containers:
  - name: workload
    image: ubuntu:24.04
    resources:
      claims:
      - name: my-gpu
        request: gpu
    command:
    - sh
    - -c
    - |
      echo "=== DRA device metadata ==="
      find /var/run/kubernetes.io/dra-device-attributes -name '*-metadata.json' -print -exec cat {} \;
      sleep 3600
  restartPolicy: Never
```

   此清单创建一个名为 `gpu-claim` 的 ResourceClaim，
   请求从 `gpu.example.com` DeviceClass 获取设备，以及一个读取设备元数据的 Pod。

2. 创建 ResourceClaim 和 Pod：

   ```shell
   kubectl apply -f https://k8s.io/examples/dra/dra-device-metadata-pod.yaml
   ```

3. Pod 运行后，查看容器日志以查看元数据：

   ```shell
   kubectl logs gpu-metadata-reader
   ```

   
   输出类似于：

   ```
   === DRA device metadata ===
   /var/run/kubernetes.io/dra-device-attributes/resourceclaims/gpu-claim/gpu/gpu.example.com-metadata.json
   {
     "kind": "DeviceMetadata",
     "apiVersion": "metadata.resource.k8s.io/v1alpha1",
     ...
   }
   ```

4. 要检查完整的元数据文件，请在容器中执行命令：

   ```shell
   kubectl exec gpu-metadata-reader -- \
     cat /var/run/kubernetes.io/dra-device-attributes/resourceclaims/gpu-claim/gpu/gpu.example.com-metadata.json
   ```

   
   输出是一个 JSON 对象，包含设备属性，例如型号、驱动版本和设备 UUID。
   有关 JSON 结构的详细信息，请参阅
   [元数据模式](/zh-cn/docs/concepts/scheduling-eviction/dynamic-resource-allocation/#device-metadata-schema)。

## 通过 ResourceClaimTemplate 访问设备元数据    {#access-metadata-template}

当你使用 ResourceClaimTemplate 时，Kubernetes 会为每个 Pod 生成一个 ResourceClaim。
由于生成的 claim 名称不可预测，元数据文件出现在使用 Pod 的 claim 引用名称的路径中：

```
/var/run/kubernetes.io/dra-device-attributes/resourceclaimtemplates/<podClaimName>/<requestName>/<driverName>-metadata.json
```

`<podClaimName>` 对应 Pod 的 `spec.resourceClaims[]` 条目中的 `name` 字段。
JSON 元数据还包括一个 `podClaimName` 字段，用于记录此映射。

1. 查看以下示例清单：

   

示例文件：`dra/dra-device-metadata-template-pod.yaml`

```yaml
apiVersion: resource.k8s.io/v1
kind: ResourceClaimTemplate
metadata:
  name: gpu-claim-template
spec:
  spec:
    devices:
      requests:
      - name: gpu
        exactly:
          deviceClassName: gpu.example.com
---
apiVersion: v1
kind: Pod
metadata:
  name: gpu-metadata-template-reader
spec:
  resourceClaims:
  - name: my-gpu
    resourceClaimTemplateName: gpu-claim-template
  containers:
  - name: workload
    image: ubuntu:24.04
    resources:
      claims:
      - name: my-gpu
        request: gpu
    command:
    - sh
    - -c
    - |
      echo "=== DRA device metadata (from template) ==="
      find /var/run/kubernetes.io/dra-device-attributes -name '*-metadata.json' -print -exec cat {} \;
      sleep 3600
  restartPolicy: Never
```

   此清单创建一个 ResourceClaimTemplate 和一个 Pod。
   每个 Pod 获得自己生成的 ResourceClaim。元数据路径使用 Pod 的 claim 引用名称 `my-gpu`。

1. 创建 ResourceClaimTemplate 和 Pod：

   ```shell
   kubectl apply -f https://k8s.io/examples/dra/dra-device-metadata-template-pod.yaml
   ```

1. Pod 运行后，查看元数据：

   ```shell
   kubectl exec gpu-metadata-template-reader -- \
     cat /var/run/kubernetes.io/dra-device-attributes/resourceclaimtemplates/my-gpu/gpu/gpu.example.com-metadata.json
   ```

## 在应用程序中读取元数据    {#read-metadata-application}

### Go 应用程序

`k8s.io/dynamic-resource-allocation/devicemetadata` 包提供了用于读取元数据文件的现成函数。
这些函数自动处理版本协商，解码元数据流并将其转换为内部类型，
使你的代码能够跨模式版本工作，而无需手动版本检查。

对于直接引用的 ResourceClaim：

```go
import "k8s.io/dynamic-resource-allocation/devicemetadata"

dm, err := devicemetadata.ReadResourceClaimMetadata("gpu-claim", "gpu")
```

对于模板生成的 claim（使用 Pod 的 claim 引用名称）：

```go
dm, err := devicemetadata.ReadResourceClaimTemplateMetadata("my-gpu", "gpu")
```

如果你知道特定的驱动程序名称，可以读取单个驱动程序的元数据文件：

```go
dm, err := devicemetadata.ReadResourceClaimMetadataWithDriverName("gpu.example.com", "gpu-claim", "gpu")
```

返回的 `*metadata.DeviceMetadata` 包含 claim 元数据、请求和每个设备的属性。

其他语言的应用程序可以直接读取 JSON 文件，并在解析之前检查 `apiVersion` 字段以确定模式版本。

## 清理    {#clean-up}

删除你创建的资源：

```shell
kubectl delete -f https://k8s.io/examples/dra/dra-device-metadata-pod.yaml
kubectl delete -f https://k8s.io/examples/dra/dra-device-metadata-template-pod.yaml
```

## ## 接下来

* [进一步了解 DRA 设备元数据](/zh-cn/docs/concepts/scheduling-eviction/dynamic-resource-allocation/#device-metadata)
* [使用 DRA 为工作负载分配设备](/zh-cn/docs/tasks/configure-pod-container/assign-resources/allocate-devices-dra/)
* 有关设计的更多信息，请参阅
  [KEP-5304](https://github.com/kubernetes/enhancements/tree/master/keps/sig-node/5304-dra-attributes-downward-api)。
