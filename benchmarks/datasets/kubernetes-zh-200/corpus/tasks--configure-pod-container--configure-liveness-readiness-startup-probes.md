# 配置存活、就绪和启动探针

本页展示了如何配置容器的存活、就绪和启动探针。

有关探测的更多信息，请参阅[存活、就绪和启动探针](/zh-cn/docs/concepts/workloads/pods/probes)。

## ## 准备开始

你必须拥有一个 Kubernetes 的集群，且必须配置 kubectl 命令行工具让其与你的集群通信。
建议运行本教程的集群至少有两个节点，且这两个节点不能作为控制平面主机。
如果你还没有集群，你可以通过 [Minikube](https://minikube.sigs.k8s.io/docs/tutorials/multi_node/)
构建一个你自己的集群，或者你可以使用下面的 Kubernetes 练习环境之一：

* [iximiuz Labs](https://labs.iximiuz.com/playgrounds?category=kubernetes&filter=all)
* [Killercoda](https://killercoda.com/playgrounds/scenario/kubernetes)
* [KodeKloud](https://kodekloud.com/public-playgrounds)

## 定义存活命令 {#define-a-liveness-command}

许多长时间运行的应用最终会进入损坏状态，除非重新启动，否则无法被恢复。
Kubernetes 提供了存活探针来发现并处理这种情况。

在本练习中，你会创建一个 Pod，其中运行一个基于
`registry.k8s.io/busybox:1.27.2` 镜像的容器。
下面是这个 Pod 的配置文件。

示例文件：`pods/probe/exec-liveness.yaml`

```yaml
apiVersion: v1
kind: Pod
metadata:
  labels:
    test: liveness
  name: liveness-exec
spec:
  containers:
  - name: liveness
    image: registry.k8s.io/busybox:1.27.2
    args:
    - /bin/sh
    - -c
    - touch /tmp/healthy; sleep 30; rm -f /tmp/healthy; sleep 600
    livenessProbe:
      exec:
        command:
        - cat
        - /tmp/healthy
      initialDelaySeconds: 5
      periodSeconds: 5
```

在这个配置文件中，可以看到 Pod 中只有一个 `Container`。
`periodSeconds` 字段指定了 kubelet 应该每 5 秒执行一次存活探测。
`initialDelaySeconds` 字段告诉 kubelet 在执行第一次探测前应该等待 5 秒。
kubelet 在容器内执行命令 `cat /tmp/healthy` 来进行探测。
如果命令执行成功并且返回值为 0，kubelet 就会认为这个容器是健康存活的。
如果这个命令返回非 0 值，kubelet 会杀死这个容器并重新启动它。

当容器启动时，执行如下的命令：

```shell
/bin/sh -c "touch /tmp/healthy; sleep 30; rm -f /tmp/healthy; sleep 600"
```

这个容器生命的前 30 秒，`/tmp/healthy` 文件是存在的。
所以在这最开始的 30 秒内，执行命令 `cat /tmp/healthy` 会返回成功代码。
30 秒之后，执行命令 `cat /tmp/healthy` 就会返回失败代码。

创建 Pod：

```shell
kubectl apply -f https://k8s.io/examples/pods/probe/exec-liveness.yaml
```

在 30 秒内，查看 Pod 的事件：

```shell
kubectl describe pod liveness-exec
```

输出结果表明还没有存活探针失败：

```none
Type    Reason     Age   From               Message
----    ------     ----  ----               -------
Normal  Scheduled  11s   default-scheduler  Successfully assigned default/liveness-exec to node01
Normal  Pulling    9s    kubelet, node01    Pulling image "registry.k8s.io/busybox:1.27.2"
Normal  Pulled     7s    kubelet, node01    Successfully pulled image "registry.k8s.io/busybox:1.27.2"
Normal  Created    7s    kubelet, node01    Created container liveness
Normal  Started    7s    kubelet, node01    Started container liveness
```

35 秒之后，再来看 Pod 的事件：

```shell
kubectl describe pod liveness-exec
```

在输出结果的最下面，有信息显示存活探针失败了，这个失败的容器被杀死并且被重建了。

```none
Type     Reason     Age                From               Message
----     ------     ----               ----               -------
Normal   Scheduled  57s                default-scheduler  Successfully assigned default/liveness-exec to node01
Normal   Pulling    55s                kubelet, node01    Pulling image "registry.k8s.io/busybox:1.27.2"
Normal   Pulled     53s                kubelet, node01    Successfully pulled image "registry.k8s.io/busybox:1.27.2"
Normal   Created    53s                kubelet, node01    Created container liveness
Normal   Started    53s                kubelet, node01    Started container liveness
Warning  Unhealthy  10s (x3 over 20s)  kubelet, node01    Liveness probe failed: cat: can't open '/tmp/healthy': No such file or directory
Normal   Killing    10s                kubelet, node01    Container liveness failed liveness probe, will be restarted
```

再等 30 秒，确认这个容器被重启了：

```shell
kubectl get pod liveness-exec
```

输出结果显示 `RESTARTS` 的值增加了 1。
请注意，一旦失败的容器恢复为运行状态，`RESTARTS` 计数器就会增加 1：

```none
NAME            READY     STATUS    RESTARTS   AGE
liveness-exec   1/1       Running   1          1m
```

## 定义一个存活态 HTTP 请求接口 {#define-a-liveness-HTTP-request}

另外一种类型的存活探测方式是使用 HTTP GET 请求。
下面是一个 Pod 的配置文件，其中运行一个基于
`registry.k8s.io/e2e-test-images/agnhost` 镜像的容器。

示例文件：`pods/probe/http-liveness.yaml`

```yaml
apiVersion: v1
kind: Pod
metadata:
  labels:
    test: liveness
  name: liveness-http
spec:
  containers:
  - name: liveness
    image: registry.k8s.io/e2e-test-images/agnhost:2.40
    args:
    - liveness
    livenessProbe:
      httpGet:
        path: /healthz
        port: 8080
        httpHeaders:
        - name: Custom-Header
          value: Awesome
      initialDelaySeconds: 3
      periodSeconds: 3
```

在这个配置文件中，你可以看到 Pod 也只有一个容器。
`periodSeconds` 字段指定了 kubelet 每隔 3 秒执行一次存活探测。
`initialDelaySeconds` 字段告诉 kubelet 在执行第一次探测前应该等待 3 秒。
kubelet 会向容器内运行的服务（服务在监听 8080 端口）发送一个 HTTP GET 请求来执行探测。
如果服务器上 `/healthz` 路径下的处理程序返回成功代码，则 kubelet 认为容器是健康存活的。
如果处理程序返回失败代码，则 kubelet 会杀死这个容器并将其重启。

返回大于或等于 200 并且小于 400 的任何代码都标示成功，其它返回代码都标示失败。

你可以访问
[`server.go`](https://github.com/kubernetes/kubernetes/blob/master/test/images/agnhost/liveness/server.go)
阅读服务的源码。

容器存活期间的最开始 10 秒中，`/healthz` 处理程序返回 200 的状态码。
之后处理程序返回 500 的状态码。

```go
http.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
    duration := time.Now().Sub(started)
    if duration.Seconds() > 10 {
        w.WriteHeader(500)
        w.Write([]byte(fmt.Sprintf("error: %v", duration.Seconds())))
    } else {
        w.WriteHeader(200)
        w.Write([]byte("ok"))
    }
})
```

kubelet 在容器启动之后 3 秒开始执行健康检查。所以前几次健康检查都是成功的。
但是 10 秒之后，健康检查会失败，并且 kubelet 会杀死容器再重新启动容器。

创建一个 Pod 来测试 HTTP 的存活检测：

```shell
kubectl apply -f https://k8s.io/examples/pods/probe/http-liveness.yaml
```

10 秒之后，通过查看 Pod 事件来确认存活探针已经失败，并且容器被重新启动了。

```shell
kubectl describe pod liveness-http
```

在 1.13 之后的版本中，设置本地的 HTTP 代理环境变量不会影响 HTTP 的存活探测。

### 在 HTTP 探针中使用 HTTP/2 明文（h2c）  {#use-h2c-with-http-probes}

功能状态：H2CContainerProbe，Kubernetes 1.37，alpha；首次引入于 1.37。默认禁用。使用前需配置相应特性门控。

默认情况下，`kubelet` 在执行 HTTP 探针时发送的是 HTTP/1.1 请求。

如果你的应用仅通过 HTTP/2 明文（h2c）提供健康检查端点，你可以在探针规约的
`httpGet` 字段下添加 `protocol` 字段，并将其值指定为 `HTTP2`。
这要求在 `kube-apiserver` 和 `kubelet` 上同时启用 `H2CContainerProbe`
[特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/)。

示例文件：`pods/probe/h2c-liveness.yaml`

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: h2c-app
spec:
  containers:
  - name: app
    image: registry.k8s.io/e2e-test-images/agnhost:2.64.0
    command: ["/agnhost", "h2c-server", "--port=8080"]
    ports:
    - containerPort: 8080
    livenessProbe:
      httpGet:
        path: /healthz
        port: 8080
        protocol: HTTP2
      initialDelaySeconds: 5
      periodSeconds: 10
```

当 `protocol` 设置为 `HTTP2` 时，`kubelet` 将通过 HTTP/2
明文（h2c）—— 即在明文 TCP 上使用 HTTP/2，且不启用 TLS —— 进行连接。以下配置不受支持：

* `protocol: HTTP2` 与 `scheme: HTTPS`
* `protocol: HTTP2` 与 `host` 字段中的任何值

如果该特性门控处于禁用状态，API 服务器会从新建或更新的 Pod 中移除 `protocol` 字段。

## 定义 TCP 的存活探测 {#define-a-TCP-liveness-probe}

第三种类型的存活探测是使用 TCP 套接字。
使用这种配置时，kubelet 会尝试在指定端口和容器建立套接字链接。
如果能建立连接，这个容器就被看作是健康的，如果不能则这个容器就被看作是有问题的。

示例文件：`pods/probe/tcp-liveness-readiness.yaml`

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: goproxy
  labels:
    app: goproxy
spec:
  containers:
  - name: goproxy
    image: registry.k8s.io/goproxy:0.1
    ports:
    - containerPort: 8080
    readinessProbe:
      tcpSocket:
        port: 8080
      initialDelaySeconds: 15
      periodSeconds: 10
    livenessProbe:
      tcpSocket:
        port: 8080
      initialDelaySeconds: 15
      periodSeconds: 10
```

如你所见，TCP 检测的配置和 HTTP 检测非常相似。
下面这个例子同时使用就绪探针和存活探针。kubelet 会在容器启动 15 秒后运行第一次存活探测。
此探测会尝试连接 `goproxy` 容器的 8080 端口。
如果此存活探测失败，容器将被重启。kubelet 将继续每隔 10 秒运行一次这种探测。

除了存活探针，这个配置还包括一个就绪探针。
kubelet 会在容器启动 15 秒后运行第一次就绪探测。
与存活探测类似，就绪探测会尝试连接 `goproxy` 容器的 8080 端口。
如果就绪探测失败，Pod 将被标记为未就绪，且不会接收来自任何服务的流量。

要尝试 TCP 存活检测，运行以下命令创建 Pod：

```shell
kubectl apply -f https://k8s.io/examples/pods/probe/tcp-liveness-readiness.yaml
```

15 秒之后，通过查看 Pod 事件来检测存活探针：

```shell
kubectl describe pod goproxy
```

## 定义 gRPC 存活探针 {#define-a-grpc-liveness-probe}

功能状态：Kubernetes v1.27，stable。

如果你的应用实现了
[gRPC 健康检查协议](https://github.com/grpc/grpc/blob/master/doc/health-checking.md)，
这个例子展示了如何配置 Kubernetes 以将其用于应用的存活性检查。
类似地，你可以配置就绪探针和启动探针。

下面是一个示例清单：

示例文件：`pods/probe/grpc-liveness.yaml`

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: etcd-with-grpc
spec:
  containers:
  - name: etcd
    image: registry.k8s.io/etcd:3.5.1-0
    command: [ "/usr/local/bin/etcd", "--data-dir",  "/var/lib/etcd", "--listen-client-urls", "http://0.0.0.0:2379", "--advertise-client-urls", "http://127.0.0.1:2379", "--log-level", "debug"]
    ports:
    - containerPort: 2379
    livenessProbe:
      grpc:
        port: 2379
      initialDelaySeconds: 10
```

要尝试 gRPC 存活检查，请使用以下命令创建一个 Pod。
在下面的示例中，etcd Pod 配置为使用 gRPC 存活探针。

```shell
kubectl apply -f https://k8s.io/examples/pods/probe/grpc-liveness.yaml
```

15 秒钟之后，查看 Pod 事件确认存活性检查并未失败：

```shell
kubectl describe pod etcd-with-grpc
```

当使用 gRPC 探针时，需要注意以下一些技术细节：

- 这些探针运行时针对的是 Pod 的 IP 地址或其主机名。
  请一定配置你的 gRPC 端点使之监听于 Pod 的 IP 地址之上。
- 默认情况下，探针通过明文连接。有关如何启用 TLS
  的信息，请参阅[将 TLS 用于 gRPC 探针](#grpc-probe-tls)。
- 对于内置的探针而言，不存在错误代码。所有错误都被视作探测失败。
- 如果 `ExecProbeTimeout` 特性门控被设置为 `false`，则 `grpc-health-probe`
  不会考虑 `timeoutSeconds` 设置状态（默认值为 `1s`），
  而内置探针则会在超时时返回失败。

### 在 gRPC 探针中使用 TLS {#grpc-probe-tls}

功能状态：GRPCContainerProbeTLS，Kubernetes 1.37，alpha；首次引入于 1.37。默认禁用。使用前需配置相应特性门控。

默认情况下，`kubelet` 通过明文连接 gRPC 健康检查端点。
如果你的应用仅通过 TLS 提供 gRPC 服务，你可以在探针规约的 `grpc`
字段下添加 `mode` 字段，并将其值指定为 `TLS`。这要求在 `kube-apiserver`
和 `kubelet` 上同时启用 `GRPCContainerProbeTLS`
[特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/)。

示例文件：`pods/probe/grpc-tls-liveness.yaml`

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: grpc-tls-app
spec:
  containers:
  - name: app
    image: registry.k8s.io/e2e-test-images/agnhost:2.40
    command: ["/agnhost", "grpc-health-checking", "--port=8443"]
    ports:
    - containerPort: 8443
    livenessProbe:
      grpc:
        port: 8443
        mode: TLS
      initialDelaySeconds: 5
      periodSeconds: 10
```

当 `mode` 设置为 `TLS` 时，`kubelet` 通过 TLS 进行连接，并使用
`InsecureSkipVerify`，不会对服务器证书进行校验。
这与 HTTPS 探针的行为一致，目前不支持证书校验。

如果该特性门控处于禁用状态，`kube-apiserver`
会从新建或更新的 Pod 中移除 `mode` 字段。

## 使用命名端口 {#use-a-named-port}

对于 HTTP 和 TCP 存活检测可以使用命名的
[`port`](/zh-cn/docs/reference/kubernetes-api/workload-resources/pod-v1/#ports)
（gRPC 探针不支持使用命名端口）。

例如：

```yaml
ports:
- name: liveness-port
  containerPort: 8080

livenessProbe:
  httpGet:
    path: /healthz
    port: liveness-port
```

## 使用启动探针保护慢启动容器 {#define-startup-probes}

有时候，会有一些现有的应用在启动时需要较长的初始化时间。
在这种情况下，若要不影响对死锁作出快速响应的探测，设置存活探测参数是要技巧的。
解决办法是使用相同的命令来设置启动探测，针对 HTTP 或 TCP 检测，可以通过将
`failureThreshold * periodSeconds` 参数设置为足够长的时间来应对最糟糕情况下的启动时间。

这样，前面的例子就变成了：

```yaml
ports:
- name: liveness-port
  containerPort: 8080

livenessProbe:
  httpGet:
    path: /healthz
    port: liveness-port
  failureThreshold: 1
  periodSeconds: 10

startupProbe:
  httpGet:
    path: /healthz
    port: liveness-port
  failureThreshold: 30
  periodSeconds: 10
```

幸亏有启动探测，应用将会有最多 5 分钟（30 * 10 = 300s）的时间来完成其启动过程。
一旦启动探测成功一次，存活探测任务就会接管对容器的探测，对容器死锁作出快速响应。
如果启动探测一直没有成功，容器会在 300 秒后被杀死，并且根据 `restartPolicy`
来执行进一步处置。

## 定义就绪探针 {#define-readiness-probes}

有时候，应用会暂时性地无法为请求提供服务。
例如，应用在启动时可能需要加载大量的数据或配置文件，或是启动后要依赖等待外部服务。
在这种情况下，既不想杀死应用，也不想给它发送请求。
Kubernetes 提供了就绪探针来发现并缓解这些情况。
容器所在 Pod 上报还未就绪的信息，并且不接受通过 Kubernetes Service 的流量。

**说明：**

就绪探针在容器的整个生命周期中保持运行状态。

**注意：**

存活探针与就绪性探针相互间不等待对方成功。
如果要在执行就绪性探针之前等待，应该使用 `initialDelaySeconds`
或 `startupProbe`。

就绪探针的配置和存活探针的配置相似。
唯一区别就是要使用 `readinessProbe` 字段，而不是 `livenessProbe` 字段。

```yaml
readinessProbe:
  exec:
    command:
    - /bin/cat
    - /tmp/healthy
  initialDelaySeconds: 5
  periodSeconds: 5
```

HTTP 和 TCP 的就绪探针配置也和存活探针的配置完全相同。

就绪态探针和存活态探针可以针对同一容器并行使用。
同时使用两者可以确保流量不会进入尚未就绪的容器，并在容器发生故障时将其重启。

## ## 接下来

* 进一步了解关于[存活、就绪和启动探针](/zh-cn/docs/concepts/workloads/pods/probes)的信息。
* 有关探针相关字段的完整规范，请参阅 API 参考：
  * [Pod](/zh-cn/docs/reference/kubernetes-api/workload-resources/pod-v1/)
  * [Container](/zh-cn/docs/reference/kubernetes-api/workload-resources/pod-v1/#Container)
  * [Probe](/zh-cn/docs/reference/kubernetes-api/workload-resources/pod-v1/#Probe)
