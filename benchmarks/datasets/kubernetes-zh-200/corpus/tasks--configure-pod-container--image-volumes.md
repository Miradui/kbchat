# Pod 使用镜像卷

功能状态：ImageVolume，Kubernetes 1.36，stable；首次引入于 1.31。默认启用。

本页展示了如何使用镜像卷配置 Pod。此特性允许你在容器内挂载来自 OCI 镜像仓库的内容。

## ## 准备开始

你必须拥有一个 Kubernetes 的集群，且必须配置 kubectl 命令行工具让其与你的集群通信。
建议运行本教程的集群至少有两个节点，且这两个节点不能作为控制平面主机。
如果你还没有集群，你可以通过 [Minikube](https://minikube.sigs.k8s.io/docs/tutorials/multi_node/)
构建一个你自己的集群，或者你可以使用下面的 Kubernetes 练习环境之一：

* [iximiuz Labs](https://labs.iximiuz.com/playgrounds?category=kubernetes&filter=all)
* [Killercoda](https://killercoda.com/playgrounds/scenario/kubernetes)
* [KodeKloud](https://kodekloud.com/public-playgrounds)
 Kubernetes 服务端最低版本：v1.31。使用 `kubectl version` 检查版本。

- 容器运行时需要支持镜像卷特性
- 你需要能够在主机上执行命令
- 你需要能够进入 Pod 执行命令

## 运行使用镜像卷的 Pod   {#create-pod}

为 Pod 启用镜像卷的方式是：在 `.spec` 中将 `volumes[*].image`
字段设置为一个有效的镜像并在容器的 `volumeMounts` 中消费此镜像。例如：

示例文件：`pods/image-volumes.yaml`

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: image-volume
spec:
  containers:
  - name: shell
    command: ["sleep", "infinity"]
    image: debian
    volumeMounts:
    - name: volume
      mountPath: /volume
  volumes:
  - name: volume
    image:
      reference: quay.io/crio/artifact:v2
      pullPolicy: IfNotPresent
```

1. 在你的集群上创建 Pod：

   ```shell
   kubectl apply -f https://k8s.io/examples/pods/image-volumes.yaml
   ```

2. 挂接到容器：

   ```shell
   kubectl exec image-volume -it -- bash
   ```

3. 查看卷中某个文件的内容：

   ```shell
   cat /volume/dir/file
   ```

   
   输出类似于：

   ```none
   1
   ```

   
   你还可以查看不同路径中的另一个文件：

   ```shell
   cat /volume/file
   ```

   
   输出类似于：

   ```none
   2
   ```

## 进一步阅读

- [`image` 卷](/zh-cn/docs/concepts/storage/volumes/#image)

## 使用 `subPath`（或 `subPathExpr`）

从 Kubernetes v1.33 开始，使用 `image` 卷特性时，可以利用
[`subPath`](/zh-cn/docs/concepts/storage/volumes/#using-subpath) 或
[`subPathExpr`](/zh-cn/docs/concepts/storage/volumes/#using-subpath-expanded-environment)。

示例文件：`pods/image-volumes-subpath.yaml`

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: image-volume
spec:
  containers:
  - name: shell
    command: ["sleep", "infinity"]
    image: debian
    volumeMounts:
    - name: volume
      mountPath: /volume
      subPath: dir
  volumes:
  - name: volume
    image:
      reference: quay.io/crio/artifact:v2
      pullPolicy: IfNotPresent
```

1. 在你的集群上创建 Pod：

   ```shell
   kubectl apply -f https://k8s.io/examples/pods/image-volumes-subpath.yaml
   ```

2. 挂接到容器：

   ```shell
   kubectl exec image-volume -it -- bash
   ```

3. 检查卷中 `dir` 子路径下的文件的内容：

   ```shell
   cat /volume/file
   ```

  

  输出类似于：

   ```none
   1
   ```
