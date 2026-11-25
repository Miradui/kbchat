# 强化指南 - 动态资源分配

动态资源分配（DRA）增加了强大的调度和设备管理功能。
由于 DRA 组件会更新 `ResourceClaim` 状态，集群管理员应使用明确的最小权限 RBAC
来配置这些更新的授权。

功能状态：DRAResourceClaimGranularStatusAuthorization，Kubernetes 1.36，beta；首次引入于 1.36。默认启用。

从 Kubernetes v1.36 开始，DRA 状态更新使用合成子资源，
在某些情况下还使用专门的节点感知动词。

## 强化 DRA 状态更新权限    {#harden-dra-status-update-permissions}

对于 DRA 状态更新，除了在 `resourceclaims/status` 子资源上授予 `update` 权限外，
集群管理员还必须根据组件需要修改的精确字段授予特定“合成”子资源的权限。
这在调度器、自定义控制器和 DRA 驱动程序之间强制执行最小权限原则。

DRA 授权检查分为两个合成子资源：

- **`resourceclaims/binding`**
  - 修改 `status.allocation` 和 `status.reservedFor` 所需。
  - 通常授予 kube-scheduler 和自定义分配控制器。
  - 使用标准的 `update` 和 `patch` 动词。
- **`resourceclaims/driver`**
  - 修改 `status.devices` 所需。
  - 此项检查按驱动程序执行，以防止驱动程序篡改不同节点和/或其他驱动程序上的设备。
  - 使用节点感知动词以实现更严格的作用域。

## 节点感知的 DRA 动词    {#node-aware-dra-verbs}

在授权更新 `resourceclaims/driver` 时，使用适当的专门动词前缀：

- **`associated-node:<verb>`**（例如 `associated-node:update`）
  - 适用于节点本地驱动程序。
  - API 服务器验证请求驱动程序的节点关联。
- **`arbitrary-node:<verb>`**（例如 `arbitrary-node:patch`）
  - 适用于可能从任何节点更新 claims 的控制平面或多节点控制器。

## 示例 RBAC 模式

### 调度器和分配控制器权限 

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: dra-binding-updater
rules:
  - apiGroups: ["resource.k8s.io"]
    resources: ["resourceclaims/status"]
    verbs: ["get", "patch", "update"]
  - apiGroups: ["resource.k8s.io"]
    resources: ["resourceclaims/binding"]
    verbs: ["patch", "update"]
```

### 节点本地 DRA 驱动程序权限

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: dra-node-driver-status-updater
rules:
  - apiGroups: ["resource.k8s.io"]
    resources: ["resourceclaims/status"]
    verbs: ["get", "patch", "update"]
  - apiGroups: ["resource.k8s.io"]
    resources: ["resourceclaims/driver"]
    verbs: ["associated-node:patch", "associated-node:update"]
    resourceNames: ["dra.example.com"]
```

### 多节点状态控制器权限

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: dra-multinode-status-updater
rules:
  - apiGroups: ["resource.k8s.io"]
    resources: ["resourceclaims/status"]
    verbs: ["get", "patch", "update"]
  - apiGroups: ["resource.k8s.io"]
    resources: ["resourceclaims/driver"]
    verbs: ["arbitrary-node:patch", "arbitrary-node:update"]
    resourceNames: ["dra.example.com"]
```

## 相关集群管理员任务

要在运行的集群中应用这些模式，请参阅
[在集群中强化动态资源分配](/zh-cn/docs/tasks/administer-cluster/hardening-dra/)。

## ## 接下来

- [授权](/zh-cn/docs/reference/access-authn-authz/authorization/)
- [在集群中设置 DRA](/zh-cn/docs/tasks/configure-pod-container/assign-resources/set-up-dra-cluster/)
- [动态资源分配](/zh-cn/docs/concepts/scheduling-eviction/dynamic-resource-allocation/)
