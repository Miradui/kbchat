# 系统日志

系统组件的日志记录集群中发生的事件，这对于调试非常有用。
你可以配置日志的精细度，以展示更多或更少的细节。
日志可以是粗粒度的，如只显示组件内的错误，
也可以是细粒度的，如显示事件的每一个跟踪步骤（比如 HTTP 访问日志、pod 状态更新、控制器动作或调度器决策）。

**警告：**

与此处描述的命令行标志不同，日志输出本身不属于 Kubernetes API 的稳定性保证范围：
单个日志条目及其格式可能会在不同版本之间发生变化！

## Klog

klog 是 Kubernetes 的日志库。
[klog](https://github.com/kubernetes/klog)
为 Kubernetes 系统组件生成日志消息。

Kubernetes 正在进行简化其组件日志的努力。下面的 klog 命令行参数从 Kubernetes v1.23
开始[已被废弃](https://github.com/kubernetes/enhancements/tree/master/keps/sig-instrumentation/2845-deprecate-klog-specific-flags-in-k8s-components)，
在 Kubernetes v1.26 中被移除：

- `--add-dir-header`
- `--alsologtostderr`
- `--log-backtrace-at`
- `--log-dir`
- `--log-file`
- `--log-file-max-size`
- `--logtostderr`
- `--one-output`
- `--skip-headers`
- `--skip-log-headers`
- `--stderrthreshold`

输出总会被写到标准错误输出（stderr）之上，无论输出格式如何。
对输出的重定向将由调用 Kubernetes 组件的软件来处理。
这一软件可以是 POSIX Shell 或者类似 systemd 这样的工具。

在某些场合下，例如对于无发行主体的（distroless）容器或者 Windows 系统服务，
这些替代方案都是不存在的。那么你可以使用
[`kube-log-runner`](https://github.com/kubernetes/kubernetes/blob/d2a8a81639fcff8d1221b900f66d28361a170654/staging/src/k8s.io/component-base/logs/kube-log-runner/README.md)
可执行文件来作为 Kubernetes 的封装层，完成对输出的重定向。
在很多 Kubernetes 基础镜像中，都包含一个预先构建的可执行程序。
这个程序原来称作 `/go-runner`，而在服务器和节点的发行版本库中，称作 `kube-log-runner`。

下表展示的是 `kube-log-runner` 调用与 Shell 重定向之间的对应关系：

| 用法                            | POSIX Shell（例如 Bash） | `kube-log-runner <options> <cmd>`  |
| --------------------------------|--------------------------|------------------------------------|
| 合并 stderr 与 stdout，写出到 stdout | `2>&1`             | `kube-log-runner`（默认行为 ）|
| 将 stderr 与 stdout 重定向到日志文件 | `1>>/tmp/log 2>&1` | `kube-log-runner -log-file=/tmp/log` |
| 输出到 stdout 并复制到日志文件中     | `2>&1 \| tee -a /tmp/log`  | `kube-log-runner -log-file=/tmp/log -also-stdout` |
| 仅将 stdout 重定向到日志 | `>/tmp/log` | `kube-log-runner -log-file=/tmp/log -redirect-stderr=false` |

### klog 输出   {#klog-output}

传统的 klog 原生格式示例：

```
I1025 00:15:15.525108       1 httplog.go:79] GET /api/v1/namespaces/kube-system/pods/metrics-server-v0.3.1-57c75779f-9p8wg: (1.512ms) 200 [pod_nanny/v0.0.0 (linux/amd64) kubernetes/$Format 10.56.1.19:51756]
```

消息字符串可能包含换行符：

```
I1025 00:15:15.525108       1 example.go:79] This is a message
which has a line break.
```

### 结构化日志   {#structured-logging}

功能状态：Kubernetes v1.23，beta。

**警告：**

迁移到结构化日志消息是一个正在进行的过程。在此版本中，并非所有日志消息都是结构化的。
解析日志文件时，你也必须要处理非结构化日志消息。

日志格式和值的序列化可能会发生变化。

结构化日志记录旨在日志消息中引入统一结构，以便以编程方式提取信息。
你可以方便地用更小的开销来处理结构化日志。
生成日志消息的代码决定其使用传统的非结构化的 klog 还是结构化的日志。

默认的结构化日志消息是以文本形式呈现的，其格式与传统的 klog 保持向后兼容：

```
<klog header> "<message>" <key1>="<value1>" <key2>="<value2>" ...
```

示例：

```
I1025 00:15:15.525108       1 controller_utils.go:116] "Pod status updated" pod="kube-system/kubedns" status="ready"
```

字符串在输出时会被添加引号。其他数值类型都使用 [`%+v`](https://pkg.go.dev/fmt#hdr-Printing)
来格式化，因此可能导致日志消息会延续到下一行，
[具体取决于数据本身](https://github.com/kubernetes/kubernetes/issues/106428)。

```
I1025 00:15:15.525108       1 example.go:116] "Example" data="This is text with a line break\nand \"quotation marks\"." someInt=1 someFloat=0.1 someStruct={StringField: First line,
second line.}
```

### 上下文日志   {#contextual-logging}

功能状态：Kubernetes v1.30，beta。

上下文日志建立在结构化日志之上。
它主要是关于开发人员如何使用日志记录调用：基于该概念的代码将更加灵活，
并且支持在[结构化日志 KEP](https://github.com/kubernetes/enhancements/tree/master/keps/sig-instrumentation/3077-contextual-logging)
中描述的额外用例。

如果开发人员在他们的组件中使用额外的函数，比如 `WithValues` 或 `WithName`，
那么日志条目将会包含额外的信息，这些信息会被调用者传递给函数。

对于 Kubernetes 1.37，这一特性是由 `StructuredLogging`
[特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/)所控制的，默认启用。
这个基础设施是在 1.24 中被添加的，并不需要修改组件。
该 [`component-base/logs/example`](https://github.com/kubernetes/kubernetes/blob/v1.24.0-beta.0/staging/src/k8s.io/component-base/logs/example/cmd/logger.go)
命令演示了如何使用新的日志记录调用以及组件如何支持上下文日志记录。

```console
$ cd $GOPATH/src/k8s.io/kubernetes/staging/src/k8s.io/component-base/logs/example/cmd/
$ go run . --help
...
      --feature-gates mapStringBool  A set of key=value pairs that describe feature gates for alpha/experimental features. Options are:
                                     AllAlpha=true|false (ALPHA - default=false)
                                     AllBeta=true|false (BETA - default=false)
                                     ContextualLogging=true|false (BETA - default=true)
$ go run . --feature-gates ContextualLogging=true
...
I0222 15:13:31.645988  197901 example.go:54] "runtime" logger="example.myname" foo="bar" duration="1m0s"
I0222 15:13:31.646007  197901 example.go:55] "another runtime" logger="example" foo="bar" duration="1h0m0s" duration="1m0s"
```

`logger` 键和 `foo="bar"` 会被函数的调用者添加上，
不需修改该函数，它就会记录 `runtime` 消息和 `duration="1m0s"` 值。

禁用上下文日志后，`WithValues` 和 `WithName` 什么都不会做，
并且会通过调用全局的 klog 日志记录器记录日志。
因此，这些附加信息不再出现在日志输出中：

```console
$ go run . --feature-gates ContextualLogging=false
...
I0222 15:14:40.497333  198174 example.go:54] "runtime" duration="1m0s"
I0222 15:14:40.497346  198174 example.go:55] "another runtime" duration="1h0m0s" duration="1m0s"
```

### JSON 日志格式   {#json-log-format}

功能状态：Kubernetes v1.19，alpha。

**警告：**

JSON 输出并不支持太多标准 klog 参数。对于不受支持的 klog 参数的列表，
请参见[命令行工具参考](/zh-cn/docs/reference/command-line-tools-reference/)。

并不是所有日志都保证写成 JSON 格式（例如，在进程启动期间）。
如果你打算解析日志，请确保可以处理非 JSON 格式的日志行。

字段名和 JSON 序列化可能会发生变化。

`--logging-format=json` 参数将日志格式从 klog 原生格式改为 JSON 格式。
JSON 日志格式示例（美化输出）：

```json
{
   "ts": 1580306777.04728,
   "v": 4,
   "msg": "Pod status updated",
   "pod":{
      "name": "nginx-1",
      "namespace": "default"
   },
   "status": "ready"
}
```

具有特殊意义的 key：

* `ts` - Unix 时间风格的时间戳（必选项，浮点值）
* `v` - 精细度（仅用于 info 级别，不能用于错误信息，整数）
* `err` - 错误字符串（可选项，字符串）
* `msg` - 消息（必选项，字符串）

当前支持 JSON 格式的组件列表：

* kube-controller-manager
* kube-apiserver
* kube-scheduler
* kubelet

### 日志精细度级别   {#log-verbosity-level}

参数 `-v` 控制日志的精细度。增大该值会增大日志事件的数量。
减小该值可以减小日志事件的数量。增大精细度会记录更多的不太严重的事件。
精细度设置为 0 时只记录关键（critical）事件。

### 日志位置   {#log-location}

有两种类型的系统组件：运行在容器中的组件和不运行在容器中的组件。例如：

* Kubernetes 调度器和 kube-proxy 在容器中运行。
* kubelet 和容器运行时不在容器中运行。

在使用 systemd 的系统中，kubelet 和容器运行时写入 journald。
在别的系统中，日志写入 `/var/log` 目录下的 `.log` 文件中。
容器中的系统组件总是绕过默认的日志记录机制，写入 `/var/log` 目录下的 `.log` 文件。
与容器日志类似，你应该轮转 `/var/log` 目录下系统组件日志。
在 `kube-up.sh` 脚本创建的 Kubernetes 集群中，日志轮转由 `logrotate` 工具配置。
`logrotate` 工具，每天或者当日志大于 100MB 时，轮转日志。

## 日志查询   {#log-query}

功能状态：NodeLogQuery，Kubernetes 1.36，stable；首次引入于 1.27。默认启用。

日志查询功能可以帮助调试 Linux 和 Windows 节点中的问题。
该功能在 Kubernetes v1.27 中引入，允许查看节点上运行的服务的日志。
要使用此特性，请确保目标节点的 kubelet 配置选项 `enableSystemLogHandler`
和 `enableSystemLogQuery` 都设置为 **true**。

在 Kubernetes v1.36 中，此功能升级为稳定版，`NodeLogQuery`
[特性门控](/zh-cn/docs/reference/command-line-tools-reference/feature-gates/) 
现在被锁定为 **true**，因此该特性门控默认启用，只剩下 `enableSystemLogHandler` 
作为启用或禁用日志查询功能的唯一选项。

`enableSystemLogHandler` 默认值为 **false**，建议保持禁用状态，除非正在进行调试。

**警告：**

授予对 `nodes/proxy` 的权限（即使只是 **get** 权限）也会授权访问强大的 kubelet API，
这些 API 可用于在节点上运行的任何容器中执行命令，因此请谨慎管理这些权限。
有关更多信息，请参阅
[kubelet 身份验证/授权](/zh-cn/docs/reference/access-authn-authz/kubelet-authn-authz/#get-nodes-proxy-warning)。

在 Linux 系统中，服务日志默认可通过 `journald` 获取。
在 Windows 系统中，服务日志默认可通过应用程序日志提供程序获取。
在两种操作系统中，也可以通过读取 `/var/log/` 目录下的文件来获取日志。

假如你被授权与节点对象交互，你可以在所有节点或只是某个子集上试用此特性。
这里有一个从节点中检索 kubelet 服务日志的例子：

```shell
# 从名为 node-1.example 的节点中获取 kubelet 日志
kubectl get --raw "/api/v1/nodes/node-1.example/proxy/logs/?query=kubelet"
```

你也可以获取文件，前提是日志文件位于 kubelet 允许进行日志获取的目录中。
例如你可以从 Linux 节点上的 `/var/log` 中获取日志。

```shell
kubectl get --raw "/api/v1/nodes/<insert-node-name-here>/proxy/logs/?query=/<insert-log-file-name-here>"
```

kubelet 使用启发方式来检索日志。
如果你还未意识到给定的系统服务正将日志写入到操作系统的原生日志记录程序（例如 journald）
或 `/var/log/` 中的日志文件，这会很有帮助。这种启发方式先检查原生的日志记录程序，
如果不可用，则尝试从 `/var/log/<servicename>`、`/var/log/<servicename>.log`
或 `/var/log/<servicename>/<servicename>.log` 中检索第一批日志。

可用选项的完整列表如下：

选项           | 描述
------------- | -----------
`boot`        | `boot` 显示来自特定系统引导的消息
`pattern`     | `pattern` 通过提供的兼容 PERL 的正则表达式来过滤日志条目
`query`       | `query` 是必需的，指定返回日志的服务或文件
`sinceTime`   | 显示日志的 [RFC3339](https://www.rfc-editor.org/rfc/rfc3339) 起始时间戳（包含）
`untilTime`   | 显示日志的 [RFC3339](https://www.rfc-editor.org/rfc/rfc3339) 结束时间戳（包含）
`tailLines`   | 指定要从日志的末尾检索的行数；默认为获取全部日志

更复杂的查询示例：

```shell
# 从名为 node-1.example 且带有单词 "error" 的节点中获取 kubelet 日志
kubectl get --raw "/api/v1/nodes/node-1.example/proxy/logs/?query=kubelet&pattern=error"
```

## ## 接下来

* 阅读 [Kubernetes 日志架构](/zh-cn/docs/concepts/cluster-administration/logging/)
* 阅读[结构化日志提案（英文）](https://github.com/kubernetes/enhancements/tree/master/keps/sig-instrumentation/1602-structured-logging)
* 阅读[上下文日志提案（英文）](https://github.com/kubernetes/enhancements/tree/master/keps/sig-instrumentation/3077-contextual-logging)
* 阅读 [klog 参数的废弃（英文）](https://github.com/kubernetes/enhancements/tree/master/keps/sig-instrumentation/2845-deprecate-klog-specific-flags-in-k8s-components)
* 阅读[日志严重级别约定（英文）](https://github.com/kubernetes/community/blob/main/contributors/devel/sig-instrumentation/logging.md)
* 阅读[日志查询](https://kep.k8s.io/2258)
