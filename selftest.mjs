import { pathToFileURL } from 'node:url'
const m = await import(pathToFileURL(process.argv[2] || './index.js'))
const handlers = {}
const ctx = { logger: { info: (...a)=>console.log('[info]',...a), warn: (...a)=>console.log('[warn]',...a) }, on: (e,f)=>{ (handlers[e]||=[]).push(f) } }

m.apply(ctx, {})   // 空配置：两子系统都 absent，入口绝不抛
console.log('empty-apply: OK')

// gateway 子系统激活（真实 key 文件路径）
m.apply(ctx, { gateway: {
  enabled: true, recall: true, ingest: true, includeGlobal: true, topK: 8, threshold: 0.25,
  recallMaxChars: 1400, recallTimeoutMs: 30000, recallJoinMs: 1500, ingestTimeoutMs: 5000,
  ingestBatchSize: 8, ingestFlushMs: 5000, maxMessageChars: 1800,
  gatewayUrl: 'http://127.0.0.1:8892', projectConfigName: '.agent-memory/project.json',
  memoryApiKeyFile: '/opt/agent-memory/GATEWAY_API_KEY.txt', memoryApiKeyEnv: 'AGENT_MEMORY_API_KEY',
}})
console.log('gateway-activated: OK')

// pilot 子系统：mock ctx 无服务 -> 必须 fail-closed(记 warn)，绝不崩
m.apply(ctx, { pilot: {
  enabled: true, workspaceId: 'ws', projectId: 'p', owner: 'owner:primary',
  principalId: 'platform-user:'+'a'.repeat(64), policyRevision: 'r1',
  registryPath: '/nope/r.json', manifestPath: '/nope/m.json', lifecyclePath: '/nope/l.json',
  queuePath: '/nope/q.json', donePath: '/nope/d.json', allowedPresets: ['x'],
}})
await new Promise(r=>setTimeout(r,150))

// 瀑布安全回归：合并入口 + 各子系统都不得在瀑布钩子注册无返回值监听
for (const ev of ['agent/request','agent/pre-step','agent/request-error'])
  if ((handlers[ev]||[]).length) { console.error('FAIL: waterfall listener on', ev); process.exit(1) }
console.log('waterfall-safety: OK')
console.log('assembled-exports:', Object.keys(m))
console.log('STATUS', JSON.stringify(ctx.dshMemoryGateway?.status?.()))
console.log('MERGED SELFTEST DONE')
