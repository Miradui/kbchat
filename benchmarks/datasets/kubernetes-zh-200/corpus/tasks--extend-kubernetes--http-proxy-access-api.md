# 使用 HTTP 代理访问 Kubernetes API

本文说明如何使用 HTTP 代理访问 Kubernetes API。

## ## 准备开始

* 
你必须拥有一个 Kubernetes 的集群，且必须配置 kubectl 命令行工具让其与你的集群通信。
建议运行本教程的集群至少有两个节点，且这两个节点不能作为控制平面主机。
如果你还没有集群，你可以通过 [Minikube](https://minikube.sigs.k8s.io/docs/tutorials/multi_node/)
构建一个你自己的集群，或者你可以使用下面的 Kubernetes 练习环境之一：

* [iximiuz Labs](https://labs.iximiuz.com/playgrounds?category=kubernetes&filter=all)
* [Killercoda](https://killercoda.com/playgrounds/scenario/kubernetes)
* [KodeKloud](https://kodekloud.com/public-playgrounds)
 使用 `kubectl version` 检查版本。

如果你的集群中还没有任何应用，使用如下命令启动一个 Hello World 应用：

```shell
kubectl create deployment hello-app --image=gcr.io/google-samples/hello-app:2.0 --port=8080
```

## 使用 kubectl 启动代理服务器

使用如下命令启动 Kubernetes API 服务器的代理：

```shell
kubectl proxy --port=8080
```

## 探究 Kubernetes API

当代理服务器在运行时，你可以通过 `curl`、`wget` 或者浏览器访问 API。

获取 API 版本：

```shell
curl http://localhost:8080/api/
```

输出应该类似这样：

```
{
  "kind": "APIVersions",
  "versions": [
    "v1"
  ],
  "serverAddressByClientCIDRs": [
    {
      "clientCIDR": "0.0.0.0/0",
      "serverAddress": "10.0.2.15:8443"
    }
  ]
}
```

获取 Pod 列表：

```shell
curl http://localhost:8080/api/v1/namespaces/default/pods
```

输出应该类似这样：

```
{
  "kind": "PodList",
  "apiVersion": "v1",
  "metadata": {
    "resourceVersion": "33074"
  },
  "items": [
    {
      "metadata": {
        "name": "kubernetes-bootcamp-2321272333-ix8pt",
        "generateName": "kubernetes-bootcamp-2321272333-",
        "namespace": "default",
        "uid": "ba21457c-6b1d-11e6-85f7-1ef9f1dab92b",
        "resourceVersion": "33003",
        "creationTimestamp": "2016-08-25T23:43:30Z",
        "labels": {
          "pod-template-hash": "2321272333",
          "run": "kubernetes-bootcamp"
        },
        ...
}
```

## ## 接下来

想了解更多信息，请参阅 [kubectl 代理](/docs/reference/generated/kubectl/kubectl-commands#proxy)。
