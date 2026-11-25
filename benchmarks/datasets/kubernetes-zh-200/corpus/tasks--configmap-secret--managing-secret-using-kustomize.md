# 使用 Kustomize 管理 Secret

`kubectl` 支持使用 [Kustomize 对象管理工具](/zh-cn/docs/tasks/manage-kubernetes-objects/kustomization/)来管理
Secret 和 ConfigMap。你可以使用 Kustomize 创建**资源生成器（Resource Generator）**，
该生成器会生成一个 Secret，让你能够通过 `kubectl` 应用到 API 服务器。

## ## 准备开始

你必须拥有一个 Kubernetes 的集群，且必须配置 kubectl 命令行工具让其与你的集群通信。
建议运行本教程的集群至少有两个节点，且这两个节点不能作为控制平面主机。
如果你还没有集群，你可以通过 [Minikube](https://minikube.sigs.k8s.io/docs/tutorials/multi_node/)
构建一个你自己的集群，或者你可以使用下面的 Kubernetes 练习环境之一：

* [iximiuz Labs](https://labs.iximiuz.com/playgrounds?category=kubernetes&filter=all)
* [Killercoda](https://killercoda.com/playgrounds/scenario/kubernetes)
* [KodeKloud](https://kodekloud.com/public-playgrounds)

## 创建 Secret    {#create-a-secret}

你可以在 `kustomization.yaml` 文件中定义 `secreteGenerator` 字段，
并在定义中引用其它本地文件、`.env` 文件或文字值生成 Secret。
例如：下面的指令为用户名 `admin` 和密码 `1f2d1e2e67df` 创建 kustomization 文件。

**说明：**

Secret 的 `stringData` 字段与服务端应用不兼容。

### 创建 kustomization 文件   {#create-the-kustomization-file}

### 文字

secretGenerator:
- name: database-creds
  literals:
  - username=admin
  - password=1f2d1e2e67df

### 文件

1. 将凭据存储在文件中。文件名是 Secret 的 key 值：

   ```shell
   echo -n 'admin' > ./username.txt
   echo -n '1f2d1e2e67df' > ./password.txt
   ```
    
   

   `-n` 标志确保文件结尾处没有换行符。

2. 创建 `kustomization.yaml` 文件：

   ```yaml
   secretGenerator:
   - name: database-creds
     files:
     - username.txt
     - password.txt
   ```

### .env 文件

你也可以使用 `.env` 文件在 `kustomization.yaml` 中定义 `secretGenerator`。
例如下面的 `kustomization.yaml` 文件从 `.env.secret` 文件获取数据：

```yaml
secretGenerator:
- name: db-user-pass
  envs:
  - .env.secret
```

在所有情况下，你都不需要对取值作 base64 编码。
YAML 文件的名称**必须**是 `kustomization.yaml` 或 `kustomization.yml`。

### 应用 kustomization 文件   {#apply-the-kustomization-file}

若要创建 Secret，应用包含 kustomization 文件的目录。

```shell
kubectl apply -k <目录路径>
```

输出类似于：

```
secret/database-creds-5hdh7hhgfk created
```

生成 Secret 时，Secret 的名称最终是由 `name` 字段和数据的哈希值拼接而成。
这将保证每次修改数据时生成一个新的 Secret。

要验证 Secret 是否已创建并解码 Secret 数据，

```shell
kubectl get -k <目录路径> -o jsonpath='{.data}' 
```

输出类似于：

```
{ "password": "MWYyZDFlMmU2N2Rm", "username": "YWRtaW4=" }
```

```
echo 'MWYyZDFlMmU2N2Rm' | base64 --decode
```

输出类似于：

```
1f2d1e2e67df
```

更多信息参阅
[使用 kubectl 管理 Secret](/zh-cn/docs/tasks/configmap-secret/managing-secret-using-kubectl/#verify-the-secret)和
[使用 Kustomize 对 Kubernetes 对象进行声明式管理](/zh-cn/docs/tasks/manage-kubernetes-objects/kustomization/)

## 编辑 Secret {#edit-secret}

1. 在 `kustomization.yaml` 文件中，修改诸如 `password` 等数据。
1. 应用包含 kustomization 文件的目录：

   ```shell
   kubectl apply -k <目录路径>
   ```

   

   输出类似于：

   ```
   secret/db-user-pass-6f24b56cc8 created
   ```

编辑过的 Secret 被创建为一个新的 `Secret` 对象，而不是更新现有的 `Secret` 对象。
你可能需要在 Pod 中更新对该 Secret 的引用。

## 清理   {#clean-up}

要删除 Secret，请使用 `kubectl`：

```shell
kubectl delete secret db-user-pass
```

## ## 接下来

- 进一步阅读 [Secret 概念](/zh-cn/docs/concepts/configuration/secret/)
- 了解如何[使用 kubectl 管理 Secret](/zh-cn/docs/tasks/configmap-secret/managing-secret-using-kubectl/)
- 了解如何[使用配置文件管理 Secret](/zh-cn/docs/tasks/configmap-secret/managing-secret-using-config-file/)
