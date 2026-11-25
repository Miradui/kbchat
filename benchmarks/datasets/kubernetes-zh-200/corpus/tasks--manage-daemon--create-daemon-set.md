# 构建一个基本的 DaemonSet

本页演示如何构建一个基本的 DaemonSet，
用其在 Kubernetes 集群中的每个节点上运行 Pod。
这个简单的使用场景包含了从主机挂载一个文件，使用
[Init 容器](/zh-cn/docs/concepts/workloads/pods/init-containers/)记录文件的内容，
以及使用 `pause` 容器。

## ## 准备开始

你必须拥有一个 Kubernetes 的集群，且必须配置 kubectl 命令行工具让其与你的集群通信。
建议运行本教程的集群至少有两个节点，且这两个节点不能作为控制平面主机。
如果你还没有集群，你可以通过 [Minikube](https://minikube.sigs.k8s.io/docs/tutorials/multi_node/)
构建一个你自己的集群，或者你可以使用下面的 Kubernetes 练习环境之一：

* [iximiuz Labs](https://labs.iximiuz.com/playgrounds?category=kubernetes&filter=all)
* [Killercoda](https://killercoda.com/playgrounds/scenario/kubernetes)
* [KodeKloud](https://kodekloud.com/public-playgrounds)

为了演示 DaemonSet 的行为，Kubernetes 集群至少需包含两个节点（一个控制平面节点和一个工作节点）。

## 定义 DaemonSet   {#define-the-daemonset}

在此任务中，将创建一个基本的 DaemonSet，确保 Pod 的副本被调度到每个节点上。
此 Pod 将使用 Init 容器从主机读取并记录 `/etc/machine-id` 的内容，
而主容器将是一个 `pause` 容器，用于保持 Pod 运行。

示例文件：`application/basic-daemonset.yaml`

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: example-daemonset
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: example
  template:
    metadata:
      labels:
        app.kubernetes.io/name: example
    spec:
      containers:
      - name: pause
        image: registry.k8s.io/pause
      initContainers:
      - name: log-machine-id
        image: busybox:1.37
        command: ['sh', '-c', 'cat /etc/machine-id > /var/log/machine-id.log']
        volumeMounts:
        - name: machine-id
          mountPath: /etc/machine-id
          readOnly: true
        - name: log-dir
          mountPath: /var/log
      volumes:
      - name: machine-id
        hostPath:
          path: /etc/machine-id
          type: File
      - name: log-dir
        hostPath:
          path: /var/log
```

1. 基于（YAML）清单创建 DaemonSet：

   ```shell
   kubectl apply -f https://k8s.io/examples/application/basic-daemonset.yaml
   ```

2. 完成创建操作后，你可以验证 DaemonSet 是否在集群中的每个节点上运行 Pod：

   ```shell
   kubectl get pods -o wide
   ```

   

   输出将列出每个节点上有一个 Pod，类似于：

   ```
   NAME                                READY   STATUS    RESTARTS   AGE    IP       NODE
   example-daemonset-xxxxx             1/1     Running   0          5m     x.x.x.x  node-1
   example-daemonset-yyyyy             1/1     Running   0          5m     x.x.x.x  node-2
   ```

3. 你可以通过检查从主机挂载的日志目录来查看 `/etc/machine-id` 文件的日志内容：

   ```shell
   kubectl exec <pod-name> -- cat /var/log/machine-id.log
   ```
  
   

   其中 `<pod-name>` 是某一个 Pod 的名称。

## ## 清理

要删除 DaemonSet，请运行以下命令：

```shell
kubectl delete --cascade=foreground --ignore-not-found --now daemonsets/example-daemonset
```

这个简单的 DaemonSet 例子介绍了 Init 容器和主机路径卷这类关键组件，
你可以在此基础上扩展以应对更高级的使用场景。有关细节参阅
[DaemonSet](/zh-cn/docs/concepts/workloads/controllers/daemonset/)。

## ## 接下来

* 参阅[在 DaemonSet 上执行滚动更新](/zh-cn/docs/tasks/manage-daemon/update-daemon-set/)
* 参见[创建 DaemonSet 以收养现有 DaemonSet Pod](/zh-cn/docs/concepts/workloads/controllers/daemonset/)
