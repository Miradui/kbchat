# 容器运行时接口（CRI）

CRI 是一个插件接口，它使 kubelet 能够使用各种容器运行时，无需重新编译集群组件。

你需要在集群中的每个节点上都有一个可以正常工作的容器运行时，
这样 kubelet 能启动
Pod 及其容器。

容器运行时接口（CRI）是在 kubelet 与容器运行时之间通信的主要协议。

Kubernetes 容器运行时接口（CRI）定义了在[节点组件](/zh-cn/docs/concepts/architecture/#node-components)
kubelet
和容器运行时之间通信的主要
[gRPC](https://grpc.io) 协议。

## API {#api}

功能状态：Kubernetes v1.23，stable。

当通过 gRPC 连接到容器运行时，kubelet 将充当客户端。运行时和镜像服务端点必须在容器运行时中可用，
可以使用 `--container-runtime-endpoint`
[命令行标志](/zh-cn/docs/reference/command-line-tools-reference/kubelet)在
kubelet 中单独配置。

对于 Kubernetes v1.26 及更高版本，
kubelet 要求容器运行时必须支持 `v1` 版本的 CRI API。
如果容器运行时不支持 `v1` API，kubelet 将不会注册该节点。

## 升级  {#upgrading}

在节点上升级 Kubernetes 版本时，kubelet 会重新启动。
如果容器运行时不支持 `v1` 版本的 CRI API，kubelet 将无法注册节点并报告错误。
如果由于容器运行时已升级而需要重新建立 gRPC 连接，
则该容器运行时必须支持 v1 版本的 CRI API，连接才能成功。
在容器运行时正确配置后，可能需要重新启动 kubelet 才能建立连接。

## List 流  {#list-streaming}

功能状态：CRIListStreaming，Kubernetes 1.36，alpha；首次引入于 1.36。默认禁用。使用前需配置相应特性门控。

标准的 CRI list RPC（`ListContainers`、`ListPodSandbox`、`ListImages`）
会将所有结果返回在一个单一的单元响应中。
在容器数量庞大的节点上（例如，包括运行中的和已停止的容器在内，总数超过约 10,000 个），
这些响应可能会超过 gRPC 默认的 16 MiB 消息大小限制，导致 kubelet 在与容器运行时同步状态时失败。

启用 `CRIListStreaming` 特性后，kubelet 使用服务器端流式
RPC（例如 `StreamContainers`、`StreamPodSandboxes`、`StreamImages`），
允许容器运行时将结果拆分到多个响应消息中，从而绕过单个消息的大小限制。
这对于以下情况尤其有用：

- 容器频繁变更的环境（CI/CD 系统）
- 大规模批处理工作负载

如果容器运行时不支持流式 RPC，kubelet 会自动回退到标准一元 RPC 以实现向后兼容。

## ## 接下来

- 了解更多有关 CRI [协议定义](https://github.com/kubernetes/cri-api/blob/v0.33.1/pkg/apis/runtime/v1/api.proto)
