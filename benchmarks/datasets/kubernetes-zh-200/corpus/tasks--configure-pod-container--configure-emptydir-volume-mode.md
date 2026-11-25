# 在 emptyDir 卷上设置权限

功能状态：EmptyDirVolumeMode，Kubernetes 1.37，alpha；首次引入于 1.37。默认禁用。使用前需配置相应特性门控。

本页介绍如何使用 `mode` 字段在 `emptyDir` 卷目录上设置 Unix 权限位。

## ## 准备开始

你必须拥有一个 Kubernetes 的集群，且必须配置 kubectl 命令行工具让其与你的集群通信。
建议运行本教程的集群至少有两个节点，且这两个节点不能作为控制平面主机。
如果你还没有集群，你可以通过 [Minikube](https://minikube.sigs.k8s.io/docs/tutorials/multi_node/)
构建一个你自己的集群，或者你可以使用下面的 Kubernetes 练习环境之一：

* [iximiuz Labs](https://labs.iximiuz.com/playgrounds?category=kubernetes&filter=all)
* [Killercoda](https://killercoda.com/playgrounds/scenario/kubernetes)
* [KodeKloud](https://kodekloud.com/public-playgrounds)
 Kubernetes 服务端最低版本：v1.37。使用 `kubectl version` 检查版本。

你需要在 API 服务器**和** kubelet 上启用 `EmptyDirVolumeMode`
[特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/)。

## 创建使用带自定义权限 emptyDir 卷的 Pod {#create-pod}

`emptyDir.mode` 字段允许你在卷目录上设置 Unix 权限位
（八进制范围从 `0000` 到 `01777`）。如果未指定，目录将以默认的
`0777` 权限创建。

例如，要创建一个设置了粘滞位（sticky bit）的共享 `/tmp` 目录，
使得只有文件所有者可以删除自己的文件：

示例文件：`pods/emptydir-volume-mode.yaml`

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: emptydir-mode-demo
spec:
  containers:
  - image: registry.k8s.io/busybox
    name: test-container
    command: ["sleep", "3600"]
    volumeMounts:
    - mountPath: /tmp
      name: tmp-volume
  volumes:
  - name: tmp-volume
    emptyDir:
      mode: 01777
```

1.  在你的集群上创建 Pod：

    ```shell
    kubectl apply -f https://k8s.io/examples/pods/emptydir-volume-mode.yaml
    ```

2.  验证 Pod 正在运行：

    ```shell
    kubectl get pod emptydir-mode-demo
    ```

3.  检查已挂载卷的权限：

    ```shell
    kubectl exec emptydir-mode-demo -- ls -ld /tmp
    ```

    
    输出类似于：

    ```none
    drwxrwxrwt 2 root root 4096 Jul 28 00:00 /tmp
    ```

    
    末尾的 `t` 确认粘滞位已设置。

4.  删除你为这个练习创建的 Pod：

    ```shell
    kubectl delete pod emptydir-mode-demo
    ```

## ## 接下来

- 了解更多关于 [`emptyDir` 卷](/zh-cn/docs/concepts/storage/volumes/#emptydir)的信息
