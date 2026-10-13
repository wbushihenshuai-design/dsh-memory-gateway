// Regression suite for the memory-gateway pending replay queue.
// Runs the gateway against local stub backends only — never production.
// usage: node tests/pending-queue.test.mjs
import { spawn } from 'node:child_process'
import http from 'node:http'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ENTRY = process.env.GW_ENTRY || path.join(HERE, '..', 'index.js')
const ADMIN_KEY = 'test-admin-key'
const CLIENT_KEY = 'test-client-key'
const SECRET_SENTINEL = 'SuperSecretToken123456abcdef'
const MARKER = 'PENDINGONLYMARKER-qq7788'
const MARKER2 = 'RESOLVEDONLYMARKER-rr9911'
const retries = { pass: 0, fail: 0, lines: [] }

function check(name, ok, detail) {
  retries.lines.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) retries.pass += 1
  else retries.fail += 1
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Stub backends (mutable mode, recorded traffic)
// ---------------------------------------------------------------------------

function makeLlmStub() {
  const state = { mode: 'facts', hits: 0 }
  const factJson = (text) => JSON.stringify({ facts: [{ text, scope: 'global', kind: 'fact', confidence: 0.92, sensitivity: 'internal', durability: 'long_term' }] })
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      state.hits += 1
      if (state.mode === 'fail') return res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'stub unavailable' } }))
      const content = state.mode === 'empty' ? JSON.stringify({ facts: [] })
        : state.mode === 'marker' ? factJson(`待处理标记 ${MARKER}`)
        : state.mode === 'resolved' ? factJson(`已入库标记 ${MARKER2}`)
        : factJson('该批次确认了一条可复用事实。')
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }))
    })
  })
  return { state, server }
}

function makeHindsightStub() {
  const state = { mode: 'ok', batches: [], stored: [] }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const send = (code, obj) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj))
      if (req.method === 'POST' && req.url.endsWith('/memories/recall')) {
        const q = JSON.parse(raw || '{}').query || ''
        const hits = state.stored.filter((t) => t.includes(q)).map((t) => ({ text: t, scores: { semantic: 0.9 }, tags: ['scope:global'], metadata: {} }))
        return send(200, { results: hits })
      }
      if (req.method === 'POST' && req.url.endsWith('/memories')) {
        if (state.mode === 'fail') return send(500, { detail: 'stub retain failure' })
        const body = JSON.parse(raw || '{}')
        state.batches.push(body)
        for (const item of body.items || []) state.stored.push(String(item.content || ''))
        return send(200, { operation_ids: ['op-' + state.batches.length] })
      }
      if (req.method === 'PUT') return send(200, { name: 'main' })
      if (req.url.includes('/stats')) return send(200, { total_nodes: 0, total_links: 0 })
      if (req.url.endsWith('/banks')) return send(200, { data: [{ name: 'main' }] })
      return send(200, {})
    })
  })
  return { state, server }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

// ---------------------------------------------------------------------------
// Gateway child process
// ---------------------------------------------------------------------------

let portCursor = 18901
async function startGateway({ dataDir, llmPort, hsPort, env = {} }) {
  const freePort = portCursor++
  const childEnv = {
    ...process.env,
    PORT: String(freePort),
    DATA_DIR: dataDir,
    HINDSIGHT_BASE_URL: `http://127.0.0.1:${hsPort}`,
    HINDSIGHT_MAIN_BANK: 'main',
    HINDSIGHT_SEARCH_BANKS: 'main',
    HINDSIGHT_LEGACY_BANKS: 'main',
    CLOUD_LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
    CLOUD_LLM_MODEL: 'stub-model',
    CLOUD_LLM_API_KEY: 'stub-key',
    CLOUD_LLM_TIMEOUT_SECONDS: '5',
    MEMORY_GATEWAY_API_KEYS: CLIENT_KEY,
    GATEWAY_ADMIN_API_KEY: ADMIN_KEY,
    GATEWAY_PENDING_RETRY_SECONDS: '2',
    GATEWAY_PENDING_TTL_HOURS: '168',
    ...env,
  }
  const proc = spawn('node', [ENTRY], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  proc.stdout.on('data', (c) => { logs += c })
  proc.stderr.on('data', (c) => { logs += c })
  const base = `http://127.0.0.1:${childEnv.PORT}`
  let up = false
  for (let i = 0; i < 80; i += 1) {
    if (proc.exitCode !== null) throw new Error(`gateway exited early (code ${proc.exitCode}) on port ${freePort}: ${logs.slice(-300)}`)
    try {
      const r = await fetch(`${base}/healthz`)
      if (r.status === 200 || r.status === 503) { up = true; break }
    } catch { /* not up yet */ }
    await sleep(200)
  }
  if (!up) throw new Error(`gateway did not come up on port ${freePort}`)
  const probe = await fetch(`${base}/healthz`).then((r) => r.json()).catch(() => null)
  if (!probe || typeof probe.pending !== 'number') throw new Error(`port ${freePort} responded but not our gateway`)
  return {
    proc,
    base,
    port: Number(childEnv.PORT),
    getLogs: () => logs,
    async stop() { proc.kill('SIGTERM'); await sleep(300); if (!proc.exitCode) proc.kill('SIGKILL') },
  }
}

async function ingest(gw, content, project = 'test-proj') {
  const res = await fetch(`${gw.base}/v1/memories/ingest`, {
    method: 'POST',
    headers: { 'X-API-Key': CLIENT_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: project, source: { client: 'test', agent: 'pending-suite' }, messages: [{ role: 'user', content }] }),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function pendingFiles(dataDir) {
  try {
    const names = await fsp.readdir(path.join(dataDir, 'pending'))
    return names.filter((n) => n.endsWith('.json'))
  } catch { return [] }
}

async function persistedFiles(dataDir) {
  try {
    const names = await fsp.readdir(path.join(dataDir, 'persisted'))
    return names.filter((n) => n.endsWith('.json'))
  } catch { return [] }
}

async function readPending(dataDir, name) {
  return JSON.parse(await fsp.readFile(path.join(dataDir, 'pending', name), 'utf8'))
}

async function waitFor(cond, timeoutMs = 20000, stepMs = 400) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return true
    await sleep(stepMs)
  }
  return false
}

async function mkTmp(label) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `mg-${label}-`))
  await fsp.chmod(dir, 0o700)
  return dir
}

async function api(gw, method, urlPath, key) {
  const headers = key ? { 'X-API-Key': key } : {}
  const res = await fetch(`${gw.base}${urlPath}`, { method, headers })
  return { status: res.status, body: await res.json().catch(() => null) }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

async function runMain() {
  const llm = makeLlmStub()
  const hs = makeHindsightStub()
  const llmPort = await listen(llm.server)
  const hsPort = await listen(hs.server)
  const dataDir = await mkTmp('main')
  const gw = await startGateway({ dataDir, llmPort, hsPort })
  try {
    // T1 — 后端失败时入队而不是丢弃
    llm.state.mode = 'fail'
    const first = await ingest(gw, `部署结论：网关端口 18095。附带凭据 Authorization: Bearer ${SECRET_SENTINEL} 与 api_key=${SECRET_SENTINEL}`)
    check('T1 ingest 返回 502 且标记已入队', first.status === 502 && first.body?.queued === true, `status=${first.status} queued=${first.body?.queued}`)
    const p1 = await pendingFiles(dataDir)
    check('T1b pending 落盘 1 条', p1.length === 1, `count=${p1.length}`)
    if (p1.length) {
      const rec = await readPending(dataDir, p1[0])
      const body = JSON.stringify(rec)
      check('T2 落盘正文已脱敏（不含密钥原文）', body.includes('[REDACTED') && !body.includes(SECRET_SENTINEL))
      check('T2b 记录含状态机字段', ['reconcile_pending', 'reconcile_pending'].includes(rec.state) && !!rec.content_digest && !!rec.expires_at && !!rec.authorization && !!rec.retention_policy, `state=${rec.state}`)
    }
    const hz = await api(gw, 'GET', '/healthz', null)
    check('T3 healthz 暴露 pending 计数', hz.body?.pending === 1, `pending=${hz.body?.pending}`)
    const noKey = await api(gw, 'GET', '/v1/admin/pending', null)
    const clientKey = await api(gw, 'GET', '/v1/admin/pending', CLIENT_KEY)
    const adminGet = await api(gw, 'GET', '/v1/admin/pending', ADMIN_KEY)
    check('T4 admin 路由鉴权(401/403/200)', noKey.status === 401 && clientKey.status === 403 && adminGet.status === 200, `${noKey.status}/${clientKey.status}/${adminGet.status}`)
    check('T4b admin 列表不返回正文', adminGet.status === 200 && !JSON.stringify(adminGet.body).includes(SECRET_SENTINEL) && !JSON.stringify(adminGet.body).includes('messages'), `items=${adminGet.body?.items?.length}`)

    // T5 — 恢复后自动重放入库
    const digest = p1.length ? (await readPending(dataDir, p1[0])).content_digest : null
    llm.state.mode = 'facts'
    const drained = await waitFor(async () => (await pendingFiles(dataDir)).length === 0)
    check('T5 后端恢复后自动重放(无需人工)', drained, `pending=${(await pendingFiles(dataDir)).length}`)
    const done = await persistedFiles(dataDir)
    check('T5b 证据落到 persisted 且状态 persisting', done.length === 1 && (await readPendingEvidence(dataDir, done[0])).state === 'persisting', `persisted=${done.length}`)
    const batch = hs.state.batches.at(-1)
    check('T5c 重放保留了幂等摘要 source_hash', !!batch && !!digest && batch.items?.[0]?.metadata?.source_hash === digest, `hash_match=${batch?.items?.[0]?.metadata?.source_hash === digest}`)
    check('T5d 重放不再盲发第二份', hs.state.batches.filter((b) => b.items?.[0]?.metadata?.source_hash === digest).length === 1, `batches=${hs.state.batches.length}`)

    // T6 — 同一批次重复提交不再入队
    llm.state.mode = 'fail'
    const dup = await ingest(gw, `部署结论：网关端口 18095。附带凭据 Authorization: Bearer ${SECRET_SENTINEL} 与 api_key=${SECRET_SENTINEL}`)
    const p6 = await pendingFiles(dataDir)
    check('T6 幂等：同摘要不重复入队', dup.body?.queued === false && p6.length === 0, `queued=${dup.body?.queued} pending=${p6.length}`)
    const other = await ingest(gw, '另一个结论：tailnet 地址 100.64.0.15。')
    check('T6b 不同批次正常入队', (other.body?.queued === true) && (await pendingFiles(dataDir)).length === 1, `pending=${(await pendingFiles(dataDir)).length}`)

    // T7 — 零事实不入队（这是正常拒绝，不是失败）
    llm.state.mode = 'empty'
    const empty = await ingest(gw, '今天天气不错，没有任何长期事实。')
    check('T7 零事实不入队', empty.status === 200 && empty.body?.facts_extracted === 0 && (await pendingFiles(dataDir)).length === 1, `status=${empty.status} pending=${(await pendingFiles(dataDir)).length}`)

    // T8 — recall 不会提前暴露 pending 正文
    llm.state.mode = 'fail'
    const markerBatch = await ingest(gw, `请把 ${MARKER} 这条结论记住。`)
    check('T8a 标记批次入队', (await pendingFiles(dataDir)).length === 2 && markerBatch.body?.queued === true, `pending=${(await pendingFiles(dataDir)).length}`)
    const search = await fetch(`${gw.base}/v1/memories/search`, {
      method: 'POST',
      headers: { 'X-API-Key': CLIENT_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: MARKER, project_id: 'test-proj', include_global: true, top_k: 8 }),
    })
    const searchBody = await search.json()
    check('T8b 拒绝用例：pending 正文不得经 recall 进入上下文', !JSON.stringify(searchBody).includes(MARKER), `results=${JSON.stringify(searchBody).includes(MARKER)}`)
    llm.state.mode = 'resolved'
    const pos = await ingest(gw, `正向对照：请记录 ${MARKER2}。`)
    await waitFor(async () => JSON.stringify(await (await fetch(`${gw.base}/v1/memories/search`, { method: 'POST', headers: { 'X-API-Key': CLIENT_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: MARKER2, top_k: 8 }) })).json()).includes(MARKER2), 20000)
    const posHit = JSON.stringify(await (await fetch(`${gw.base}/v1/memories/search`, { method: 'POST', headers: { 'X-API-Key': CLIENT_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: MARKER2, top_k: 8 }) })).json())
    check('T8c 正向用例：走通队列后同一 marker 可被召回(证明不是静默吞掉)', posHit.includes(MARKER2), `queued=${pos.body?.queued}`)

    // T9 — Hindsight 侧失败也入队并可重放
    llm.state.mode = 'facts'
    hs.state.mode = 'fail'
    const hsFail = await ingest(gw, '结论：UFW 已放行 18095/tcp 来自 100.64.0.0/10。')
    const queued9 = hsFail.body?.queued === true
    const beforeBatches = hs.state.batches.length
    hs.state.mode = 'ok'
    const drained9 = await waitFor(async () => hs.state.batches.length > beforeBatches)
    check('T9 入库失败入队并在恢复后补写', queued9 && drained9, `queued=${queued9} replayed=${drained9}`)

    // T10 — 手动重试入口
    llm.state.mode = 'fail'
    await ingest(gw, '结论：重启网关会让 failover 冷却 600 秒。')
    llm.state.mode = 'facts'
    const forced = await api(gw, 'POST', '/v1/admin/pending/retry', ADMIN_KEY)
    check('T10 admin 可强制立即重放', forced.status === 200 && forced.body?.summary?.resolved >= 1, `resolved=${forced.body?.summary?.resolved}`)

    // T11 — 重启对账：pending 跨进程存活并自动收敛
    llm.state.mode = 'fail'
    await ingest(gw, '结论：记忆链路依赖 18096 端口。')
    const pendingBeforeRestart = (await pendingFiles(dataDir)).length
    await gw.stop()
    const gw2 = await startGateway({ dataDir, llmPort, hsPort })
    llm.state.mode = 'facts'
    const reconciled = await waitFor(async () => (await pendingFiles(gw2.port ? dataDir : dataDir)).length < pendingBeforeRestart, 25000)
    check('T11 重启后对账并继续重放', reconciled && gw2.getLogs().includes('pending_resolved'), `pending_after=${(await pendingFiles(dataDir)).length}/${pendingBeforeRestart}`)
    llm.state.mode = 'fail'
    check('T11b 日志含 queued/resolved/expired 事件词', gw2.getLogs().includes('pending_resolved'))
    return gw2
  } finally {
    llm.server.close(); hs.server.close()
  }
}


async function runBootTiming() {
  const llm = makeLlmStub(); const hs = makeHindsightStub()
  const llmPort = await listen(llm.server); const hsPort = await listen(hs.server)
  const dataDir = await mkTmp('boot')
  llm.state.mode = 'fail'
  const gw = await startGateway({ dataDir, llmPort, hsPort, env: { GATEWAY_PENDING_RETRY_SECONDS: '60' } })
  const r15 = await ingest(gw, '重启对账计时用例结论。')
  const n = (await pendingFiles(dataDir)).length
  if (n !== 1) console.log('DEBUG T15 ingest=', r15.status, JSON.stringify(r15.body), '\n  logs=', gw.getLogs().split('\n').slice(-4).join(' | '))
  await gw.stop()
  llm.state.mode = 'facts'
  const t0 = Date.now()
  const gw2 = await startGateway({ dataDir, llmPort, hsPort, env: { GATEWAY_PENDING_RETRY_SECONDS: '60' } })
  const ok = await waitFor(async () => (await pendingFiles(dataDir)).length === 0, 14000, 100)
  const dt = Date.now() - t0
  check(`T15 启动对账不等整周期(60s 间隔下 ${dt}ms 内补写)`, n === 1 && ok && dt < 10000, `pending=${n} replayed=${ok}`)
  llm.server.close(); hs.server.close()
  return gw2
}

async function readPendingEvidence(dataDir, name) {
  return JSON.parse(await fsp.readFile(path.join(dataDir, 'persisted', name), 'utf8'))
}

async function runTtl() {
  const llm = makeLlmStub(); const hs = makeHindsightStub()
  const llmPort = await listen(llm.server); const hsPort = await listen(hs.server)
  const dataDir = await mkTmp('ttl')
  const gw = await startGateway({ dataDir, llmPort, hsPort, env: { GATEWAY_PENDING_TTL_HOURS: '168' } })
  try {
    llm.state.mode = 'fail'
    await ingest(gw, '临时结论：这条会在到期后被清除。')
    const files = await pendingFiles(dataDir)
    if (!files.length) return check('T12 TTL 到期物理清除', false, 'no pending file'), gw
    const rec = await readPending(dataDir, files[0])
    rec.expires_at = new Date(Date.now() - 1000).toISOString()
    await fsp.writeFile(path.join(dataDir, 'pending', files[0]), JSON.stringify(rec), { mode: 0o600 })
    const gone = await waitFor(async () => (await pendingFiles(dataDir)).length === 0, 15000)
    const raw = await fsp.readFile(path.join(dataDir, 'pending', files[0]), 'utf8').catch(() => null)
    check('T12 TTL 到期物理清除正文', gone && raw === null && gw.getLogs().includes('pending_expired'), `gone=${gone}`)
    return gw
  } finally { llm.server.close(); hs.server.close() }
}

async function runCap() {
  const llm = makeLlmStub(); const hs = makeHindsightStub()
  const llmPort = await listen(llm.server); const hsPort = await listen(hs.server)
  const dataDir = await mkTmp('cap')
  const gw = await startGateway({ dataDir, llmPort, hsPort, env: { GATEWAY_PENDING_MAX_ENTRIES: '2', GATEWAY_PENDING_MAX_BYTES: '65536' } })
  try {
    llm.state.mode = 'fail'
    for (let i = 0; i < 5; i += 1) await ingest(gw, `容量测试第 ${i} 条结论，内容各不相同以避免去重。`)
    const files = await pendingFiles(dataDir)
    check('T13 条数上限生效并丢弃最旧', files.length <= 2 && gw.getLogs().includes('pending_over_cap_dropped'), `count=${files.length}`)
    return gw
  } finally { llm.server.close(); hs.server.close() }
}

async function runDisabled() {
  const llm = makeLlmStub(); const hs = makeHindsightStub()
  const llmPort = await listen(llm.server); const hsPort = await listen(hs.server)
  const dataDir = await mkTmp('off')
  const gw = await startGateway({ dataDir, llmPort, hsPort, env: { GATEWAY_PENDING_ENABLED: 'false' } })
  try {
    llm.state.mode = 'fail'
    const r = await ingest(gw, '关闭队列时的结论。')
    check('T14 可用开关彻底关闭队列(回到旧行为)', r.status === 502 && r.body?.queued === false && (await pendingFiles(dataDir)).length === 0, `queued=${r.body?.queued}`)
    return gw
  } finally { llm.server.close(); hs.server.close() }
}

const cleanups = []
try {
  const a = await runMain(); cleanups.push(a)
  const b = await runTtl(); cleanups.push(b)
  const c = await runCap(); cleanups.push(c)
  const d = await runDisabled(); cleanups.push(d)
  const e = await runBootTiming(); cleanups.push(e)
} catch (error) {
  check('SUITE 未抛异常', false, String(error).slice(0, 200))
}
for (const gw of cleanups) { try { await gw.stop() } catch { /* already stopped */ } }
console.log(retries.lines.join('\n'))
console.log(`\n合计: PASS=${retries.pass} FAIL=${retries.fail}`)
process.exit(retries.fail === 0 ? 0 : 1)
