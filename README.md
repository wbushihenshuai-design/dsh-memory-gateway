# dsh-memory-gateway

DSH 统一记忆 bundle——把原来三个自研插件合并为一个：

| 子系统 | 前身 | 作用 | 开关 |
|---|---|---|---|
| **gateway** | dsh-agent-memory-gateway | 即时会话记忆：系统提示召回 + 会话事件批量摄取到本地 memory-gateway(:8892) | `config.gateway.enabled` |
| **pilot** | @local/weknora-memory-pilot | fail-closed WeKnora 知识库记忆试点：固定单工作区/单项目/单主体/预设白名单，队列驱动，只能收窄不能扩权 | `config.pilot.enabled` |
| **sidebar** | @local/weknora-sidebar-link | DSH 右侧栏常驻 WeKnora 面板（iframe, kb.tiggo.autos） | 安装即显示（client 半区无 host 配置） |

## 合并原则

- 每个子系统保持原独立合同的语义（gateway 全程 fail-open；pilot 全程 fail-closed）。
- 入口对每个子系统的激活各自 try/catch：任一子系统缺陷只让该子系统静默关闭，绝不影响宿主插件图。
- 入口只声明一次 `inject`（pilot 所需服务）；子模块不再导出 name/inject。
- **瀑布钩子红线**（E-085 事故教训）：绝不在 `dispatch.waterfall` 钩子(agent/request / agent/pre-step / agent/request-error)上注册无返回值监听；`selftest.mjs` 含该回归断言。

## profile 配置示例

```yaml
- id: dsh-memory-gateway
  config:
    gateway:
      enabled: true
      recall: true
      ingest: true
      # ... 其余 gateway 参数见 lib/gateway.mjs
      gatewayUrl: http://127.0.0.1:8892
      memoryApiKeyFile: /opt/agent-memory/GATEWAY_API_KEY.txt
      memoryApiKeyEnv: AGENT_MEMORY_API_KEY
    pilot:
      enabled: true
      workspaceId: <uuid>
      projectId: <project>
      owner: owner:primary
      principalId: platform-user:<64hex>
      policyRevision: <rev>
      registryPath: /abs/path/registry.json
      manifestPath: /abs/path/keys.json
      lifecyclePath: /abs/path/lifecycle.json
      queuePath: /abs/path/queue.json
      donePath: /abs/path/done.json
      allowedPresets:
        - standard-128k-deepseek-compact
```

## 自测

```sh
node --input-type=module -e "await import('./selftest.mjs')"
```

无网关/无密钥环境下应显示：gateway 激活但调用 fail-open、pilot fail-closed disabled、waterfall-safety OK。
