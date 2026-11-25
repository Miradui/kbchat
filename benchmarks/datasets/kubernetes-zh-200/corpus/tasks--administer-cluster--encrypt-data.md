# 静态加密机密数据

Kubernetes 中允许允许用户编辑的持久 API 资源数据的所有 API 都支持静态加密。
例如，你可以启用静态加密 Secret。
此静态加密是对 etcd 集群或运行 kube-apiserver 的主机上的文件系统的任何系统级加密的补充。

本页展示如何启用和配置静态 API 数据加密。

**说明：**

此任务涵盖使用 Kubernetes API
存储的资源数据的加密。
例如，你可以加密 Secret 对象，包括它们包含的键值数据。

如果要加密安装到容器中的文件系统中的数据，则需要：

- 使用提供加密 volumes 的存储集成
- 在你自己的应用程序中加密数据

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

* 在 Kubernetes v1.27 或更高版本中可以使用通配符匹配资源。

使用 `kubectl version` 检查版本。

## 确定是否已启用静态数据加密   {#determining-whether-encryption-at-rest-is-already-enabled}

默认情况下，API 服务器将资源的明文表示存储在 etcd 中，没有静态加密。

`kube-apiserver` 进程使用 `--encryption-provider-config` 参数指定配置文件的路径，
所指定的配置文件的内容将控制 Kubernetes API 数据在 etcd 中的加密方式。
如果你在运行 kube-apiserver 时没有使用 `--encryption-provider-config` 命令行参数，
则你未启用静态加密。如果你在运行 kube-apiserver 时使用了 `--encryption-provider-config`
命令行参数，并且此参数所引用的文件指定 `identity` 提供程序作为加密提供程序列表中的第一个，
则你未启用静态加密（**默认的 `identity` 提供程序不提供任何机密性保护**）。

如果你在运行 kube-apiserver 时使用了 `--encryption-provider-config` 命令行参数，
并且此参数所引用的文件指定一个不是 `identity` 的提供程序作为加密提供程序列表中的第一个，
则你已启用静态加密。然而此项检查并未告知你先前向加密存储的迁移是否成功。如果你不确定，
请参阅[确保所有相关数据都已加密](#ensure-all-secrets-are-encrypted)。

**注意：**

**重要：** 对于高可用配置（有两个或多个控制平面节点），加密配置文件必须相同！
否则，`kube-apiserver` 组件无法解密存储在 etcd 中的数据。

## 理解静态数据加密    {#understanding-the-encryption-at-rest-configuration}

```yaml

---
#
# 注意：这是一个示例配置。请勿将其用于你自己的集群！
#
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources:
      - secrets
      - configmaps
      - pandas.awesome.bears.example # 自定义资源 API
    providers:
      # 此配置不提供数据机密性。
      # 第一个配置的 provider 正在指定将资源存储为纯文本的 "identity" 机制。
      - identity: {} # 纯文本，换言之未加密
      - aesgcm:
          keys:
            - name: key1
              secret: c2VjcmV0IGlzIHNlY3VyZQ==
            - name: key2
              secret: dGhpcyBpcyBwYXNzd29yZA==
      - aescbc:
          keys:
            - name: key1
              secret: c2VjcmV0IGlzIHNlY3VyZQ==
            - name: key2
              secret: dGhpcyBpcyBwYXNzd29yZA==
      - secretbox:
          keys:
            - name: key1
              secret: YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY=
  - resources:
      - events
    providers:
      - identity: {} # 即使如下指定 *.* 也不会加密 events
  - resources:
      - '*.apps' # 通配符匹配需要 Kubernetes 1.27 或更高版本
    providers:
      - aescbc:
          keys:
          - name: key2
            secret: c2VjcmV0IGlzIHNlY3VyZSwgb3IgaXMgaXQ/Cg==
  - resources:
      - '*.*' # 通配符匹配需要 Kubernetes 1.27 或更高版本
    providers:
      - aescbc:
          keys:
          - name: key3
            secret: c2VjcmV0IGlzIHNlY3VyZSwgSSB0aGluaw==

```

每个 `resources` 数组项目是一个单独的完整的配置。
`resources.resources` 字段是应加密的 Kubernetes 资源（例如 Secret、ConfigMap 或其他资源）名称
（`resource` 或 `resource.group`）的数组。

如果自定义资源被添加到 `EncryptionConfiguration` 并且集群版本为 1.26 或更高版本，
则 `EncryptionConfiguration` 中提到的任何新创建的自定义资源都将被加密。
在该版本之前存在于 etcd 中的任何自定义资源和配置不会被加密，直到它们被下一次写入到存储为止。
这与内置资源的行为相同。请参阅[确保所有 Secret 都已加密](#ensure-all-secrets-are-encrypted)一节。

`providers` 数组是可能的加密提供程序的有序列表，用于你所列出的 API。
每个提供程序支持多个密钥 - 解密时会按顺序尝试这些密钥，
如果这是第一个提供程序，其第一个密钥将被用于加密。

每个条目只能指定一个提供程序类型（可以是 `identity` 或 `aescbc`，但不能在同一个项目中同时指定二者）。
列表中的第一个提供程序用于加密写入存储的资源。
当从存储器读取资源时，与存储的数据匹配的所有提供程序将按顺序尝试解密数据。
如果由于格式或密钥不匹配而导致没有提供程序能够读取存储的数据，则会返回一个错误，以防止客户端访问该资源。

`EncryptionConfiguration` 支持使用通配符指定应加密的资源。
使用 “`*.<group>`” 加密 group 内的所有资源（例如以上例子中的 “`*.apps`”）或使用
“`*.*`” 加密所有资源。“`*.`” 可用于加密核心组中的所有资源。“`*.*`”
将加密所有资源，甚至包括 API 服务器启动之后添加的自定义资源。

**说明：**

不允许在同一资源列表或跨多个条目中使用相互重疊的通配符，因为这样一来配置的一部分将无法生效。
`resources` 列表的处理顺序和优先级由配置中列出的顺序决定。

如果你有一个涵盖资源（resource）的通配符，并且想要过滤掉静态加密的特定类型资源，
则可以通过添加一个单独的 `resources` 数组项来实现此目的，
其中包含要豁免的资源的名称，还可以在其后跟一个 `providers` 数组项来指定 `identity` 提供商。
你可以将此数组项添加到列表中，以便它早于你指定加密的配置（不是 `identity` 的提供商）出现。

例如，如果启用了 '`*.*`'，并且你想要选择不加密 Event 和 ConfigMap，
请在 `resources` 中**靠前**的位置添加一个新的条目，后跟带有 `identity`
的 providers 数组项作为提供程序。较为特定的条目必须位于通配符条目之前。

新项目看起来类似于：

```yaml
  ...
  - resources:
      - configmaps. # 特定于来自核心 API 组的资源，因为结尾是 “.”
      - events
    providers:
      - identity: {}
  # 然后是资源中的其他条目
```

确保新项列在资源数组中的通配符 “`*.*`” 项**之前**，使新项优先。

有关 `EncryptionConfiguration` 结构体的更多详细信息，
请参阅[加密配置 API](/zh-cn/docs/reference/config-api/apiserver-config.v1/)。

**注意：**

如果通过加密配置无法读取资源（因为密钥已更改），唯一的方法是直接从底层 etcd 中删除该密钥。
任何尝试读取资源的调用将会失败，直到它被删除或提供有效的解密密钥。

### 可用的提供程序   {#providers}

在为集群的 Kubernetes API 数据配置静态加密之前，你需要选择要使用的提供程序。

下表描述了每个可用的提供程序：

<table class="complex-layout">
<caption style="display: none;">

Kubernetes 静态数据加密的提供程序
</caption>
<thead>
  <tr>
  <th>名称</th>
  <th>加密类型</th>
  <th>强度</th>
  <th>速度</th>
  <th>密钥长度</th>
  </tr>
</thead>
<tbody id="encryption-providers-identity">
  
  <tr>
  <th rowspan="2" scope="row"><tt>identity</tt></th>
  <td><strong>无</strong></td>
  <td>N/A</td>
  <td>N/A</td>
  <td>N/A</td>
  </tr>
  <tr>
  <td colspan="4">
  
  不加密写入的资源。当设置为第一个提供程序时，已加密的资源将在新值写入时被解密。
  </td>
  </tr>
</tbody>
<tbody id="encryption-providers-that-encrypt">
  <tr>
  <th rowspan="2" scope="row"><tt>aescbc</tt></th>
  <td>
  
  带有 <a href="https://datatracker.ietf.org/doc/html/rfc2315">PKCS#7</a> 填充的 AES-CBC
  </td>
  <td>弱</td>
  <td>快</td>
  <td>32 字节</td>
  <td>16、24 或 32 字节</td>
  </tr>
  <tr>
  <td colspan="4">
  
  由于 CBC 容易受到密文填塞攻击（Padding Oracle Attack），不推荐使用。密钥材料可从控制面主机访问。
  </td>
  </tr>
  <tr>
  <th rowspan="2" scope="row"><tt>aesgcm</tt></th>
  <td>
  
  带有随机数的 AES-GCM
  </td>
  <td>
  
  每写入 200k 次后必须轮换
  </td>
  <td>最快</td>
  <td>16、24 或者 32 字节</td>
  </tr>
  <tr>
  <td colspan="4">
  
  不建议使用，除非实施了自动密钥轮换方案。密钥材料可从控制面主机访问。
  </td>
  </tr>
  <tr>
  <th rowspan="2" scope="row"><tt>kms</tt> v1 <em>（自 Kubernetes 1.28 起弃用）</em></th>
  <td>
  
  针对每个资源使用不同的 DEK 来完成信封加密。
  </td>
  <td>最强</td>
  <td>慢（<em>与 <tt>kms</tt> V2 相比</em>）</td>
  <td>32 字节</td>
  </tr>
  <tr>
  <td colspan="4">
    
    通过数据加密密钥（DEK）使用 AES-GCM 加密数据；
    DEK 根据 Key Management Service（KMS）中的配置通过密钥加密密钥（Key Encryption Keys，KEK）加密。
    密钥轮换方式简单，每次加密都会生成一个新的 DEK，KEK 的轮换由用户控制。
    <br />
    
    阅读如何<a href="/zh-cn/docs/tasks/administer-cluster/kms-provider#configuring-the-kms-provider-kms-v1">配置 KMS V1 提供程序</a>
    </td>
  </tr>
  <tr>
  <th rowspan="2" scope="row"><tt>kms</tt> v2 </th>
  <td>
  
  针对每个 API 服务器使用不同的 DEK 来完成信封加密。
  </td>
  <td>最强</td>
  <td>快</td>
  <td>32 字节</td>
  </tr>
  <tr>
  <td colspan="4">
    
    通过数据加密密钥（DEK）使用 AES-GCM 加密数据；
    DEK 根据 Key Management Service（KMS）中的配置通过密钥加密密钥（Key Encryption Keys，KEK）加密。
    Kubernetes 基于秘密的种子数为每次加密生成一个新的 DEK。
    每当 KEK 轮换时，种子也会轮换。
    如果使用第三方工具进行密钥管理，这是一个不错的选择。
    从 `v1.29` 开始，该功能处于稳定阶段。
    <br />
    
    阅读如何<a href="/zh-cn/docs/tasks/administer-cluster/kms-provider#configuring-the-kms-provider-kms-v2">配置 KMS V2 提供程序</a>。
    </td>
  </tr>
  <tr>
  <th rowspan="2" scope="row"><tt>secretbox</tt></th>
  <td>XSalsa20 和 Poly1305</td>
  <td>强</td>
  <td>更快</td>
  <td>32 字节</td>
  </tr>
  <tr>
  <td colspan="4">
  
  使用相对较新的加密技术，在需要高度评审的环境中可能不被接受。密钥材料可从控制面主机访问。
  </td>
  </tr>
</tbody>
</table>

如果你没有另外指定，`identity` 提供程序将作为默认选项。
**`identity` 提供程序不会加密存储的数据，并且提供无附加的机密保护。**

### 密钥存储   {#key-storage}

#### 本地密钥存储    {#local-key-storage}

使用本地管理的密钥对 Secret 数据进行加密可以防止 etcd 受到威胁，但无法防范主机受到威胁的情况。
由于加密密钥被存储在主机上的 EncryptionConfiguration YAML 文件中，有经验的攻击者可以访问该文件并提取加密密钥。

#### 托管的（KMS）密钥存储   {#kms-key-storage}

KMS 提供程序使用**封套加密**：Kubernetes 使用一个数据密钥来加密资源，然后使用托管的加密服务来加密该数据密钥。
Kubernetes 为每个资源生成唯一的数据密钥。API 服务器将数据密钥的加密版本与密文一起存储在 etcd 中；
API 服务器在读取资源时，调用托管的加密服务并提供密文和（加密的）数据密钥。
在托管的加密服务中，提供程序使用**密钥加密密钥**来解密数据密钥，解密数据密钥后恢复为明文。
在控制平面和 KMS 之间的通信需要在传输过程中提供 TLS 这类保护。

使用封套加密会依赖于密钥加密密钥，此密钥不存储在 Kubernetes 中。
就 KMS 而言，如果攻击者意图未经授权地访问明文值，则需要同时入侵 etcd
**和**第三方 KMS 提供程序。

### 保护加密密钥   {#protection-for-encryption-keys}

你应该采取适当的措施来保护允许解密的机密信息，无论是本地加密密钥还是允许
API 服务器调用 KMS 的身份验证令牌。

即使你依赖提供商来管理主加密密钥（或多个密钥）的使用和生命周期，
你仍然有责任确保托管加密服务的访问控制和其他安全措施满足你的安全需求。

## 加密你的数据  {#encrypting-your-data}

### 生成加密密钥  {#generate-key-no-kms}

以下步骤假设你没有使用 KMS，因此这些步骤还假设你需要生成加密密钥。
如果你已有加密密钥，请跳至[编写加密配置文件](#write-an-encryption-configuration-file)。

**注意：**

与不加密相比，将原始加密密钥存储在 EncryptionConfig 中只能适度改善你的安全状况。

为了获得额外的保密性，请考虑使用 `kms` 提供程序，因为这依赖于 Kubernetes
集群外部保存的密钥。`kms` 的实现可以与硬件安全模块或由云提供商管理的加密服务配合使用。

要了解如何使用 KMS 设置静态加密，请参阅[使用 KMS 提供程序进行数据加密](/zh-cn/docs/tasks/administer-cluster/kms-provider/)。
你使用的 KMS 提供程序插件可能还附带其他特定文档。

首先生成新的加密密钥，然后使用 base64 对其进行编码：

### Linux

生成 32 字节随机密钥并对其进行 base64 编码。你可以使用这个命令：

```shell
head -c 32 /dev/urandom | base64
```

如果你想使用 PC 的内置硬件熵源，可以使用 `/dev/hwrng` 而不是 `/dev/urandom`。
并非所有 Linux 设备都提供硬件随机数生成器。

### macOS

生成 32 字节随机密钥并对其进行 base64 编码。你可以使用此命令：

```shell
head -c 32 /dev/urandom | base64
```

### Windows

生成 32 字节随机密钥并对其进行 base64 编码。你可以使用此命令：

```powershell
# 不要在已设置随机数生成器种子的会话中运行此命令。
[Convert]::ToBase64String((1..32|%{[byte](Get-Random -Max 256)}))
```

**说明：**

保持加密密钥的机密性，包括在生成密钥时，甚至理想的情况下在你不再主动使用密钥后也要保密。

### 复制加密密钥

使用安全的文件传输机制，将该加密密钥的副本提供给所有其他控制平面主机。

至少，使用传输加密 - 例如，安全 shell（SSH）。为了提高安全性，
请在主机之间使用非对称加密，或更改你正在使用的方法，以便依赖 KMS 加密。

### 编辑加密配置文件   {#write-an-encryption-configuration-file}

**注意：**

加密配置文件可能包含可以解密 etcd 中内容的密钥。
如果此配置文件包含任何密钥信息，你必须在所有控制平面主机上合理限制权限，
以便只有运行 kube-apiserver 的用户可以读取此配置。

创建一个新的加密配置文件。其内容应类似于：

```yaml
---
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources:
      - secrets
      - configmaps
      - pandas.awesome.bears.example
    providers:
      - aescbc:
          keys:
            - name: key1
              # 参见以下文本了解有关 Secret 值的详情
              secret: <BASE 64 ENCODED SECRET>
      - identity: {} # 这个回退允许读取未加密的 Secret；
                     # 例如，在初始迁移期间
```

要创建新的加密密钥（不使用 KMS），请参阅[生成加密密钥](#generate-key-no-kms)。

### 使用新的加密配置文件

你将需要把新的加密配置文件挂载到 `kube-apiserver` 静态 Pod。以下是这个操作的示例：

1. 将新的加密配置文件保存到控制平面节点上的 `/etc/kubernetes/enc/enc.yaml`。
2. 编辑 `kube-apiserver` 静态 Pod 的清单：`/etc/kubernetes/manifests/kube-apiserver.yaml`，
   代码范例如下：

   
   ```yaml
   ---
   #
   # 这是一个静态 Pod 的清单片段。
   # 检查是否适用于你的集群和 API 服务器。
   #
   apiVersion: v1
   kind: Pod
   metadata:
     annotations:
       kubeadm.kubernetes.io/kube-apiserver.advertise-address.endpoint: 10.20.30.40:443
     creationTimestamp: null
     labels:
       app.kubernetes.io/component: kube-apiserver
       tier: control-plane
     name: kube-apiserver
     namespace: kube-system
   spec:
     containers:
     - command:
       - kube-apiserver
       ...
       - --encryption-provider-config=/etc/kubernetes/enc/enc.yaml  # 增加这一行
       volumeMounts:
       ...
       - name: enc                           # 增加这一行
         mountPath: /etc/kubernetes/enc      # 增加这一行
         readOnly: true                      # 增加这一行
       ...
     volumes:
     ...
     - name: enc                             # 增加这一行
       hostPath:                             # 增加这一行
         path: /etc/kubernetes/enc           # 增加这一行
         type: DirectoryOrCreate             # 增加这一行
     ...
   ```

4. 重启你的 API 服务器。

**注意：**

你的配置文件包含可以解密 etcd 内容的密钥，因此你必须正确限制控制平面节点的访问权限，
以便只有能运行 `kube-apiserver` 的用户才能读取它。

你现在已经为**一个**控制平面主机进行了加密。典型的 Kubernetes
集群有多个控制平面主机，因此需要做的事情更多。

### 重新配置其他控制平面主机   {#api-server-config-update-more}

如果你的集群中有多个 API 服务器，应轮流将更改部署到每个 API 服务器。

**注意：**

对于具有两个或更多控制平面节点的集群配置，每个控制平面节点的加密配置应该是相同的。

如果控制平面节点间的加密驱动配置不一致，这种差异可能导致 kube-apiserver 无法解密数据。

你在计划更新集群的加密配置时，请确保控制平面中的 API 服务器在任何时候都能解密存储的数据（即使是在更改逐步实施的过程中也是如此）。

确保在每个控制平面主机上使用**相同的**加密配置。

### 验证数据已被加密   {#verifying-that-data-is-encryped}

数据在写入 etcd 时会被加密。重新启动你的 `kube-apiserver` 后，任何新创建或更新的 Secret
或在 `EncryptionConfiguration` 中配置的其他资源类别都应在存储时被加密。

如果想要检查，你可以使用 `etcdctl` 命令行程序来检索你的 Secret 数据内容。

以下示例演示了如何对加密 Secret API 进行检查。

1. 创建一个新的 Secret，名称为 `secret1`，命名空间为 `default`：

   ```shell
   kubectl create secret generic secret1 -n default --from-literal=mykey=mydata
   ```

2. 使用 `etcdctl` 命令行工具，从 etcd 中读取 Secret：

   ```
   ETCDCTL_API=3 etcdctl get /registry/secrets/default/secret1 [...] | hexdump -C
   ```

   
   这里的 `[...]` 是用来连接 etcd 服务的额外参数。

   
   例如：

   ```shell
   ETCDCTL_API=3 etcdctl \
      --cacert=/etc/kubernetes/pki/etcd/ca.crt   \
      --cert=/etc/kubernetes/pki/etcd/server.crt \
      --key=/etc/kubernetes/pki/etcd/server.key  \
      get /registry/secrets/default/secret1 | hexdump -C
   ```

   
   输出类似于（有删减）：

   ```hexdump
   00000000  2f 72 65 67 69 73 74 72  79 2f 73 65 63 72 65 74  |/registry/secret|
   00000010  73 2f 64 65 66 61 75 6c  74 2f 73 65 63 72 65 74  |s/default/secret|
   00000020  31 0a 6b 38 73 3a 65 6e  63 3a 61 65 73 63 62 63  |1.k8s:enc:aescbc|
   00000030  3a 76 31 3a 6b 65 79 31  3a c7 6c e7 d3 09 bc 06  |:v1:key1:.l.....|
   00000040  25 51 91 e4 e0 6c e5 b1  4d 7a 8b 3d b9 c2 7c 6e  |%Q...l..Mz.=..|n|
   00000050  b4 79 df 05 28 ae 0d 8e  5f 35 13 2c c0 18 99 3e  |.y..(..._5.,...>|
   [...]
   00000110  23 3a 0d fc 28 ca 48 2d  6b 2d 46 cc 72 0b 70 4c  |#:..(.H-k-F.r.pL|
   00000120  a5 fc 35 43 12 4e 60 ef  bf 6f fe cf df 0b ad 1f  |..5C.N`..o......|
   00000130  82 c4 88 53 02 da 3e 66  ff 0a                    |...S..>f..|
   0000013a
   ```

3. 验证存储的密钥前缀是否为 `k8s:enc:aescbc:v1:`，这表明 `aescbc` provider 已加密结果数据。
   确认 `etcd` 中显示的密钥名称和上述 `EncryptionConfiguration` 中指定的密钥名称一致。
   在此例中，你可以看到在 `etcd` 和 `EncryptionConfiguration` 中使用了名为 `key1` 的加密密钥。

4. 通过 API 检索，验证 Secret 是否被正确解密：

   ```shell
   kubectl get secret secret1 -n default -o yaml
   ```

   
   其输出应该包含 `mykey: bXlkYXRh`，其中 `mydata` 的内容使用 base64 进行加密，
   请参阅[解密 Secret](/zh-cn/docs/tasks/configmap-secret/managing-secret-using-kubectl/#decoding-secret)
   了解如何完全解码 Secret 内容。

### 确保所有相关数据都被加密   {#ensure-all-secrets-are-encrypted}

仅仅确保新对象被加密通常是不够的：你还希望对已经存储的对象进行加密。

例如，你已经配置了集群，使得 Secret 在写入时进行加密。
为每个 Secret 执行替换操作将加密那些对象保持不变的静态内容。

你可以在集群中的所有 Secret 上进行此项变更：

```shell
# 以能够读写所有 Secret 的管理员身份运行此命令
kubectl get secrets --all-namespaces -o json | kubectl replace -f -
```

上面的命令读取所有 Secret，然后使用相同的数据更新这些 Secret，以便应用服务端加密。

**说明：**

如果由于冲突写入而发生错误，请重试该命令。
多次运行此命令是安全的。

对于较大的集群，你可能希望通过命名空间或更新脚本来对 Secret 进行划分。

## 防止纯文本检索   {#cleanup-all-secrets-encrypted}

如果你想确保对特定 API 类型的唯一访问是使用加密完成的，你可以移除
API 服务器以明文形式读取该 API 的支持数据的能力。

**警告：**

此更改可防止 API 服务器检索标记为静态加密但实际上以明文形式存储的资源。

当你为某个 API 配置静态加密时（例如：API 种类 `Secret`，代表核心 API 组中的 `secrets` 资源），
你**必须**确保该集群中的所有这些资源确实被静态加密，
在后续步骤开始之前请检查此项。

一旦集群中的所有 Secret 都被加密，你就可以删除加密配置中的 `identity` 部分。例如：

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
            - name: key1
              secret: <BASE 64 ENCODED SECRET>
      - identity: {} # 删除此行

```

…然后依次重新启动每个 API 服务器。此更改可防止 API 服务器访问纯文本 Secret，即使是意外访问也是如此。

## 轮换解密密钥   {#rotating-a-decryption-key}

在不发生停机的情况下更改 Kubernetes 的加密密钥需要多步操作，特别是在有多个 `kube-apiserver`
进程正在运行的高可用环境中。

1. 生成一个新密钥并将其添加为所有控制平面节点上当前提供程序的第二个密钥条目
1. 重新启动所有 `kube-apiserver` 进程以确保每台服务器都可以使用新密钥加密任何数据
1. 对新的加密密钥进行安全备份。如果你丢失了此密钥的所有副本，则需要删除用已丢失的密钥加密的所有资源，
   并且在静态加密被破坏期间，工作负载可能无法按预期运行。
1. 将新密钥设置为 `keys` 数组中的第一个条目，以便将其用于新编写的静态加密
1. 重新启动所有 `kube-apiserver` 进程，以确保每个控制平面主机现在使用新密钥进行加密
1. 作为特权用户，运行 `kubectl get secrets --all-namespaces -o json | kubectl replace -f -`
   以用新密钥加密所有现有的 Secret
1. 将所有现有 Secret 更新为使用新密钥并对新密钥进行安全备份后，从配置中删除旧的解密密钥。

## 解密所有数据    {#decrypting-all-data}

此示例演示如何停止静态加密 Secret API。如果你所加密的是其他 API 类型，请调整对应步骤来适配。

要禁用静态加密，请将 `identity` 提供程序作为加密配置文件中的第一个条目：

```yaml
---
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources:
      - secrets
      # 在此列出你之前静态加密的任何其他资源
    providers:
      - identity: {} # 添加此行
      - aescbc:
          keys:
            - name: key1
              secret: <BASE 64 ENCODED SECRET> # 将其保留在适当的位置并确保它位于 "identity" 之后
```

然后运行以下命令以强制解密所有 Secret：

```shell
kubectl get secrets --all-namespaces -o json | kubectl replace -f -
```

将所有现有加密资源替换为不使用加密的支持数据后，你可以从 `kube-apiserver`
中删除加密设置。

## 配置自动重新加载   {#configure-automatic-reloading}

你可以配置加密提供程序配置的自动重新加载。
该设置决定了 API 服务器
是仅在启动时加载一次为 `--encryption-provider-config` 指定的文件，
还是在每次你更改该文件时都自动加载。
启用此选项可允许你在不重启 API 服务器的情况下更改静态加密所需的密钥。

要允许自动重新加载，
可使用 `--encryption-provider-config-automatic-reload=true` 运行 API 服务器。
该功能启用后，每分钟会轮询文件变化以监测修改情况。
`apiserver_encryption_config_controller_automatic_reload_last_timestamp_seconds` 指标用于标识新配置生效的时间。
这种设置可以在不重启 API 服务器的情况下轮换加密密钥。

## ## 接下来

* 进一步学习[解密已静态加密的数据](/zh-cn/docs/tasks/administer-cluster/decrypt-data/)。
* 进一步学习 [EncryptionConfiguration 配置 API（v1）](/zh-cn/docs/reference/config-api/apiserver-config.v1/)。
