# 解密已静态加密的机密数据

Kubernetes 中允许允许你写入持久性 API 资源数据的所有 API 都支持静态加密。
例如，你可以为 Secret 启用静态加密。
此静态加密是对 etcd 集群或运行 kube-apiserver 的主机上的文件系统的所有系统级加密的补充。

本文介绍如何停止静态加密 API 数据，以便 API 数据以未加密的形式存储。
你可能希望这样做以提高性能；但通常情况下，如果加密某些数据是个好主意，那么继续加密这些数据也是一个好主意。

**说明：**

此任务涵盖使用 Kubernetes API
存储的资源数据的加密。例如，你可以加密 Secret 对象，包括它们所包含的键值数据。

如果要加密安装到容器中的文件系统中的数据，则需要：

- 使用提供存储卷加密的存储集成方案
- 在你自己的应用中加密数据

## ## 准备开始

* 
你必须拥有一个 Kubernetes 的集群，且必须配置 kubectl 命令行工具让其与你的集群通信。
建议运行本教程的集群至少有两个节点，且这两个节点不能作为控制平面主机。
如果你还没有集群，你可以通过 [Minikube](https://minikube.sigs.k8s.io/docs/tutorials/multi_node/)
构建一个你自己的集群，或者你可以使用下面的 Kubernetes 练习环境之一：

* [iximiuz Labs](https://labs.iximiuz.com/playgrounds?category=kubernetes&filter=all)
* [Killercoda](https://killercoda.com/playgrounds/scenario/kubernetes)
* [KodeKloud](https://kodekloud.com/public-playgrounds)

* 此任务假设你将 Kubernetes API 服务器组件以静态 Pod
  方式运行在每个控制平面节点上。

* 集群的控制平面**必须**使用 etcd v3.x（主版本 3，任何次要版本）。

* 要加密自定义资源，你的集群必须运行 Kubernetes v1.26 或更高版本。

* 你应该有一些已加密的 API 数据。

使用 `kubectl version` 检查版本。

## 确定静态加密是否已被启用   {#determine-whether-encryption-at-rest-is-already-enabled}

默认情况下，API 服务器使用一个名为 `identity` 的提供程序来存储资源的明文表示。
**默认的 `identity` 提供程序不提供任何机密性保护。**

`kube-apiserver` 进程接受参数 `--encryption-provider-config`，该参数指定了配置文件的路径。
如果你指定了一个路径，那么该文件的内容将控制 Kubernetes API 数据在 etcd 中的加密方式。
如果未指定，则表示你未启用静态加密。

该配置文件的格式是 YAML，表示名为
[`EncryptionConfiguration`](/zh-cn/docs/reference/config-api/apiserver-config.v1/) 的配置 API 类别。
你可以在[静态加密配置](/zh-cn/docs/tasks/administer-cluster/encrypt-data/#understanding-the-encryption-at-rest-configuration)中查看示例配置。

如果设置了 `--encryption-provider-config`，检查哪些资源（如 `secrets`）已配置为进行加密，
并查看所适用的是哪个提供程序。确保该资源类型首选的提供程序 **不是** `identity`；
只有在想要禁用静态加密时，才可将 `identity`（**无加密**）设置为默认值。
验证资源首选的提供程序是否不是 `identity`，这意味着写入该类型资源的任何新信息都将按照配置被加密。
如果在任何资源的首选提供程序中看到 `identity`，这意味着这些资源将以非加密的方式写入 etcd 中。

## 解密所有数据 {#decrypting-all-data}

本例展示如何停止对 Secret API 进行静态加密。如果你正在加密其他 API 类别，可以相应调整以下步骤。

### 找到加密配置文件   {#locate-encryption-configuration-file}

首先，找到 API 服务器的配置文件。在每个控制平面节点上，kube-apiserver 的静态 Pod
清单指定了一个命令行参数 `--encryption-provider-config`。你很可能会发现此文件通过
[`hostPath`](/zh-cn/docs/reference/storage/volume-types/#hostpath) 卷挂载到静态 Pod 中。
一旦你找到到此卷，就可以在节点文件系统中找到此文件并对其进行检查。

### 配置 API 服务器以解密对象   {#configure-api-server-to-decrypt-objects}

要禁用静态加密，将 `identity` 提供程序设置为加密配置文件中的第一个条目。

例如，如果你现有的 EncryptionConfiguration 文件内容如下：

```yaml
---
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources:
      - secrets
    providers:
      - aescbc:
          keys:
            # 你加密时不要使用这个（无效）的示例密钥
            - name: example
              secret: 2KfZgdiq2K0g2YrYpyDYs9mF2LPZhQ==
```

然后将其更改为：

```yaml
---
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources:
      - secrets
    providers:
      - identity: {} # 增加这一行
      - aescbc:
          keys:
            - name: example
              secret: 2KfZgdiq2K0g2YrYpyDYs9mF2LPZhQ==
```

并重启此节点上的 kube-apiserver Pod。

### 重新配置其他控制平面主机 {#api-server-config-update-more-1}

如果你的集群中有多个 API 服务器，应轮流对每个 API 服务器部署这些更改。

确保在每个控制平面主机上使用相同的加密配置。

### 强制解密   {#force-decryption}

然后运行以下命令强制解密所有 Secret：

```shell
# 如果你正在解密不同类别的对象，请相应更改 "secrets"
kubectl get secrets --all-namespaces -o json | kubectl replace -f -
```

一旦你用未加密的后台数据替换了**所有**现有的已加密资源，即可从 `kube-apiserver` 中删除这些加密设置。

要移除的命令行选项为：

- `--encryption-provider-config`
- `--encryption-provider-config-automatic-reload`

再次重启 kube-apiserver Pod 以应用新的配置。

### 重新配置其他控制平面主机   {#api-server-config-update-more-2}

如果你的集群中有多个 API 服务器，应再次轮流对每个 API 服务器部署这些更改。

确保在每个控制平面主机上使用相同的加密配置。

## ## 接下来

* 更多细节参阅 [EncryptionConfiguration configuration API (v1)](/zh-cn/docs/reference/config-api/apiserver-config.v1/)。
