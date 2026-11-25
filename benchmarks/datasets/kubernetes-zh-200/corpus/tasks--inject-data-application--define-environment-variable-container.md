# 为容器设置环境变量

本页将展示如何为 Kubernetes Pod 下的容器设置环境变量。

## ## 准备开始

你必须拥有一个 Kubernetes 的集群，且必须配置 kubectl 命令行工具让其与你的集群通信。
建议运行本教程的集群至少有两个节点，且这两个节点不能作为控制平面主机。
如果你还没有集群，你可以通过 [Minikube](https://minikube.sigs.k8s.io/docs/tutorials/multi_node/)
构建一个你自己的集群，或者你可以使用下面的 Kubernetes 练习环境之一：

* [iximiuz Labs](https://labs.iximiuz.com/playgrounds?category=kubernetes&filter=all)
* [Killercoda](https://killercoda.com/playgrounds/scenario/kubernetes)
* [KodeKloud](https://kodekloud.com/public-playgrounds)

## 为容器设置一个环境变量   {#define-an-env-variable-for-a-container}

创建 Pod 时，可以为其下的容器设置环境变量。通过配置文件的 `env` 或者 `envFrom` 字段来设置环境变量。

`env` 和 `envFrom` 字段具有不同的效果。

`env`
：可以为容器设置环境变量，直接为你所给的每个变量指定一个值。

`envFrom`
：你可以通过引用 ConfigMap 或 Secret 来设置容器的环境变量。
使用 `envFrom` 时，引用的 ConfigMap 或 Secret 中的所有键值对都被设置为容器的环境变量。
你也可以指定一个通用的前缀字符串。

你可以阅读有关 [ConfigMap](/zh-cn/docs/tasks/configure-pod-container/configure-pod-configmap/#configure-all-key-value-pairs-in-a-configmap-as-container-environment-variables)
和 [Secret](/zh-cn/docs/tasks/inject-data-application/distribute-credentials-secure/#configure-all-key-value-pairs-in-a-secret-as-container-environment-variables)
的更多信息。

本页介绍如何使用 `env`。

本示例中，将创建一个只包含单个容器的 Pod。此 Pod 的配置文件中设置环境变量的名称为 `DEMO_GREETING`，
其值为 `"Hello from the environment"`。下面是此 Pod 的配置清单：

示例文件：`pods/inject/envars.yaml`

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: envar-demo
  labels:
    purpose: demonstrate-envars
spec:
  containers:
  - name: envar-demo-container
    image: gcr.io/google-samples/hello-app:2.0
    env:
    - name: DEMO_GREETING
      value: "Hello from the environment"
    - name: DEMO_FAREWELL
      value: "Such a sweet sorrow"
```

1. 基于配置清单创建一个 Pod：

    ```shell
    kubectl apply -f https://k8s.io/examples/pods/inject/envars.yaml
    ```

2. 获取正在运行的 Pod 信息：

    ```shell
    kubectl get pods -l purpose=demonstrate-envars
    ```

    
    查询结果应为：

    ```
    NAME            READY     STATUS    RESTARTS   AGE
    envar-demo      1/1       Running   0          9s
    ```

3. 列出 Pod 容器的环境变量：

    ```shell
    kubectl exec envar-demo -- printenv
    ```
    
    
    打印结果应为：

    ```
    NODE_VERSION=4.4.2
    EXAMPLE_SERVICE_PORT_8080_TCP_ADDR=10.3.245.237
    HOSTNAME=envar-demo
    ...
    DEMO_GREETING=Hello from the environment
    DEMO_FAREWELL=Such a sweet sorrow
    ```

**说明：**

通过 `env` 或 `envFrom` 字段设置的环境变量将覆盖容器镜像中指定的所有环境变量。

**说明：**

环境变量可以互相引用，但是顺序很重要。
使用在相同上下文中定义的其他变量的变量必须在列表的后面。
同样，请避免使用循环引用。

## 在配置中使用环境变量   {#using-env-var-inside-of-your-config}

你在 Pod 的配置中定义的、位于 `.spec.containers[*].env[*]` 下的环境变量
可以在配置的其他地方使用，例如可用在为 Pod 的容器设置的命令和参数中。
在下面的示例配置中，环境变量 `GREETING`、`HONORIFIC` 和 `NAME` 分别设置为 `Warm greetings to`、
`The Most Honorable` 和 `Kubernetes`。
环境变量 `MESSAGE` 将所有这些环境变量的集合组合起来，
然后再传递给容器 `env-print-demo` 的 CLI 参数中使用。

环境变量名称可以由除了 '='
外的任何[可打印的 ASCII](https://www.ascii-code.com/characters/printable-characters)
字符组成。

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: print-greeting
spec:
  containers:
  - name: env-print-demo
    image: bash
    env:
    - name: GREETING
      value: "Warm greetings to"
    - name: HONORIFIC
      value: "The Most Honorable"
    - name: NAME
      value: "Kubernetes"
    command: ["echo"]
    args: ["$(GREETING) $(HONORIFIC) $(NAME)"]
```

创建后，命令 `echo Warm greetings to The Most Honorable Kubernetes` 将在容器中运行。

## ## 接下来

* 进一步了解[环境变量](/zh-cn/docs/tasks/inject-data-application/environment-variable-expose-pod-information/)
* 进一步了解[通过环境变量来使用 Secret](/zh-cn/docs/concepts/configuration/secret/#using-secrets-as-environment-variables)
* 关于 [EnvVarSource](/docs/reference/generated/kubernetes-api/v1.37/#envvarsource-v1-core) 资源的信息。
