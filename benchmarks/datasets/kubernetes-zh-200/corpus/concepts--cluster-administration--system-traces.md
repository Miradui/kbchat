# 追踪 Kubernetes 系统组件

功能状态：Kubernetes v1.27，beta。

系统组件追踪功能记录各个集群操作的时延信息和这些操作之间的关系。

Kubernetes 组件基于 gRPC 导出器的
[OpenTelemetry 协议](https://opentelemetry.io/docs/specs/otlp/)
发送追踪信息，并用
[OpenTelemetry Collector](https://github.com/open-telemetry/opentelemetry-collector#-opentelemetry-collector)
收集追踪信息，再将其转交给追踪系统的后台。

## 追踪信息的收集 {#trace-collection}

Kubernetes 组件具有内置的 gRPC 导出器，供 OTLP 导出追踪信息，可以使用 OpenTelemetry Collector，
也可以不使用 OpenTelemetry Collector。

关于收集追踪信息、以及使用收集器的完整指南，可参见
[Getting Started with the OpenTelemetry Collector](https://opentelemetry.io/docs/collector/getting-started/)。
不过，还有一些特定于 Kubernetes 组件的事项值得注意。

默认情况下，Kubernetes 组件使用 gRPC 的 OTLP 导出器来导出追踪信息，将信息写到
[IANA OpenTelemetry 端口](https://www.iana.org/assignments/service-names-port-numbers/service-names-port-numbers.xhtml?search=opentelemetry)。
举例来说，如果收集器以 Kubernetes 组件的边车模式运行，
以下接收器配置会收集 span 信息，并将它们写入到标准输出。

```yaml
receivers:
  otlp:
    protocols:
      grpc:
exporters:
  # 用适合你后端环境的导出器替换此处的导出器
  exporters:
    debug:
      verbosity: detailed
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
```

要在不使用收集器的情况下直接将追踪信息发送到后端，请在 Kubernetes
追踪配置文件中指定端点字段以及所需的追踪后端地址。
该方法不需要收集器并简化了整体结构。

对于追踪后端标头配置，包括身份验证详细信息，环境变量可以与 `OTEL_EXPORTER_OTLP_HEADERS`
一起使用，请参阅 [OTLP 导出器配置](https://opentelemetry.io/docs/languages/sdk-configuration/otlp-exporter/)。

另外，对于 Kubernetes 集群名称、命名空间、Pod 名称等追踪资源属性配置，
环境变量也可以与 `OTEL_RESOURCE_ATTRIBUTES` 配合使用，请参见
[OTLP Kubernetes 资源](https://opentelemetry.io/docs/specs/semconv/resource/k8s/)。

## 组件追踪 {#component-traces}

### kube-apiserver 追踪 {#kube-apiserver-traces}

kube-apiserver 为传入的 HTTP 请求、传出到 webhook 和 etcd 的请求以及重入的请求生成 span。
由于 kube-apiserver 通常是一个公开的端点，所以它通过出站的请求传播
[W3C 追踪上下文](https://www.w3.org/TR/trace-context/)，
但不使用入站请求的追踪上下文。

#### 在 kube-apiserver 中启用追踪 {#enabling-tracing-in-the-kube-apiserver}

要启用追踪特性，需要使用 `--tracing-config-file=<<配置文件路径>` 为
kube-apiserver 提供追踪配置文件。下面是一个示例配置，它为万分之一的请求记录
span，并使用了默认的 OpenTelemetry 端点。

```yaml
apiVersion: apiserver.config.k8s.io/v1
kind: TracingConfiguration
# 默认值
#endpoint: localhost:4317
samplingRatePerMillion: 100
```

有关 TracingConfiguration 结构体的更多信息，请参阅
[API 服务器配置 API](/zh-cn/docs/reference/config-api/apiserver-config.v1/#apiserver-k8s-io-v1-TracingConfiguration)。

### kubelet 追踪   {#kubelet-traces}

功能状态：KubeletTracing，Kubernetes 1.34，stable；首次引入于 1.25。默认启用。门控值已锁定。

kubelet CRI 接口和实施身份验证的 HTTP 服务器被插桩以生成追踪 span。
与 API 服务器一样，端点和采样率是可配置的。
追踪上下文传播也是可以配置的。始终优先采用父 span 的采样决策。
用户所提供的追踪配置采样率将被应用到不带父级的 span。
如果在没有配置端点的情况下启用，将使用默认的 OpenTelemetry Collector
接收器地址 “localhost:4317”。

#### 在 kubelet 中启用追踪 {#enabling-tracing-in-the-kubelet}

要启用追踪，需应用[追踪配置](https://github.com/kubernetes/component-base/blob/release-1.27/tracing/api/v1/types.go)。
以下是 kubelet 配置的示例代码片段，每 10000 个请求中记录一个请求的
span，并使用默认的 OpenTelemetry 端点：

```yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
tracing:
  # 默认值
  #endpoint: localhost:4317
  samplingRatePerMillion: 100
```

如果 `samplingRatePerMillion` 被设置为一百万（`1000000`），
则所有 span 都将被发送到导出器。

Kubernetes v1.37 中的 kubelet 收集与垃圾回收、Pod
同步例程以及每个 gRPC 方法相关的 Span。
kubelet 借助 gRPC 来传播跟踪上下文，以便 CRI-O 和 containerd
这类带有跟踪插桩的容器运行时可以在其导出的 Span 与 kubelet
所提供的跟踪上下文之间建立关联。所得到的跟踪数据会包含 kubelet
与容器运行时 Span 之间的父子链接关系，从而为调试节点问题提供有用的上下文信息。

请注意导出 span 始终会对网络和 CPU 产生少量性能开销，具体取决于系统的总体配置。
如果在启用追踪的集群中出现类似性能问题，可以通过降低 `samplingRatePerMillion`
或通过移除此配置来彻底禁用追踪来缓解问题。

## 稳定性 {#stability}

追踪工具仍在积极开发中，未来它会以多种方式发生变化。
这些变化包括：span 名称、附加属性、检测端点等等。
此类特性在达到稳定版本之前，不能保证追踪工具的向后兼容性。

## ## 接下来

* 阅读 [Getting Started with the OpenTelemetry Collector](https://opentelemetry.io/docs/collector/getting-started/)
* 了解 [OTLP 导出器配置](https://opentelemetry.io/docs/languages/sdk-configuration/otlp-exporter/)
