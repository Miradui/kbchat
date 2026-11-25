# 获取正在运行容器的 Shell

本文介绍怎样使用 `kubectl exec` 命令获取正在运行容器的 Shell。

## ## 准备开始

你必须拥有一个 Kubernetes 的集群，且必须配置 kubectl 命令行工具让其与你的集群通信。
建议运行本教程的集群至少有两个节点，且这两个节点不能作为控制平面主机。
如果你还没有集群，你可以通过 [Minikube](https://minikube.sigs.k8s.io/docs/tutorials/multi_node/)
构建一个你自己的集群，或者你可以使用下面的 Kubernetes 练习环境之一：

* [iximiuz Labs](https://labs.iximiuz.com/playgrounds?category=kubernetes&filter=all)
* [Killercoda](https://killercoda.com/playgrounds/scenario/kubernetes)
* [KodeKloud](https://kodekloud.com/public-playgrounds)

## 获取容器的 Shell

在本练习中，你将创建包含一个容器的 Pod。容器运行 nginx 镜像。下面是 Pod 的配置文件：

示例文件：`application/shell-demo.yaml`

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: shell-demo
spec:
  volumes:
  - name: shared-data
    emptyDir: {}
  containers:
  - name: nginx
    image: nginx
    volumeMounts:
    - name: shared-data
      mountPath: /usr/share/nginx/html
  hostNetwork: true
  dnsPolicy: Default
```

创建 Pod：

```shell
kubectl apply -f https://k8s.io/examples/application/shell-demo.yaml
```

检查容器是否运行正常：

```shell
kubectl get pod shell-demo
```

获取正在运行容器的 Shell：

```shell
kubectl exec --stdin --tty shell-demo -- /bin/bash
```

**说明：**

双破折号 "--" 用于将要传递给命令的参数与 kubectl 的参数分开。

在 shell 中，打印根目录：

```shell
# 在容器内运行如下命令
ls /
```

在 shell 中，实验其他命令。下面是一些示例：

```shell
# 你可以在容器中运行这些示例命令
ls /
cat /proc/mounts
cat /proc/1/maps
apt-get update
apt-get install -y tcpdump
tcpdump
apt-get install -y lsof
lsof
apt-get install -y procps
ps aux
ps aux | grep nginx
```

## 编写 nginx 的根页面

再看一下 Pod 的配置文件。该 Pod 有个 `emptyDir` 卷，容器将该卷挂载到了 `/usr/share/nginx/html`。

在 shell 中，在 `/usr/share/nginx/html` 目录创建一个 `index.html` 文件：

```shell
# 在容器内运行如下命令
echo 'Hello shell demo' > /usr/share/nginx/html/index.html
```

在 shell 中，向 nginx 服务器发送 GET 请求：

```shell
# 在容器内运行如下命令
apt-get update
apt-get install curl
curl http://localhost/
```

输出结果显示了你在 `index.html` 中写入的文本。

```shell
Hello shell demo
```

当用完 shell 后，输入 `exit` 退出。

```shell
exit # 快速退出容器内的 Shell
```

## 在容器中运行单个命令

在普通的命令窗口（而不是 shell）中，打印环境运行容器中的变量：

```shell
kubectl exec shell-demo -- env
```

实验运行其他命令。下面是一些示例：

```shell
kubectl exec shell-demo -- ps aux
kubectl exec shell-demo -- ls /
kubectl exec shell-demo -- cat /proc/1/mounts
```

## 当 Pod 包含多个容器时打开 shell

如果 Pod 有多个容器，`--container` 或者 `-c` 可以在 `kubectl exec` 命令中指定容器。
例如，你有个名为 my-pod 的 Pod，该 Pod 有两个容器分别为 **main-app** 和 **healper-app**。
下面的命令将会打开一个 shell 访问 **main-app** 容器。

```shell
kubectl exec -i -t my-pod --container main-app -- /bin/bash
```

**说明：**

短的命令参数 `-i` 和 `-t` 与长的命令参数 `--stdin` 和 `--tty` 作用相同。

## ## 接下来

* 阅读 [kubectl exec](/docs/reference/generated/kubectl/kubectl-commands/#exec)。
