// dsh-agent-memory-gateway — DSH client plugin for the agent memory gateway.
//
// Recall: injects top-scored project+global memories into the system prompt
// (fail-open, short timeout, 5-minute per-project cache).
// Ingest: batches session messages to the gateway; facts are extracted and
// redacted server-side. Fully fail-open: any defect disables the feature,
// never the host. Rebuilt 2026-10-11 after the original /opt copy was lost
// in the 200→201 migration (contract taken from the profile config and
// /srv/memory-gateway/index.js).
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const name = 'dsh-memory-gateway:gateway'  // 子模块内部标识; 包入口 name 见 ../index.js

const RECALL_SECTION = 'agent-memory-gateway:recall'
const CONTINUITY_QUERY = '项目最近进展、部署变更、当前运行状态、待办和长期约束'
const ROLES = new Set(['system', 'user', 'assistant', 'tool'])
const MIN_CHARS = 8
const RECALL_CACHE_TTL_MS = 300_000
const STATE_DIR = '/opt/agent-memory/state'

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function intOf(value, fallback) {
  const n = Math.round(Number(value))
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function numOf(value, fallback, lo, hi) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

function readKey(cfg, logger) {
  const envName = typeof cfg.memoryApiKeyEnv === 'string' && cfg.memoryApiKeyEnv ? cfg.memoryApiKeyEnv
    : typeof cfg.apiKeyEnv === 'string' && cfg.apiKeyEnv ? cfg.apiKeyEnv : 'AGENT_MEMORY_API_KEY'
  const fromEnv = process.env[envName]
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  for (const file of [cfg.memoryApiKeyFile, cfg.apiKeyFile]) {
    if (typeof file !== 'string' || !file) continue
    try {
      const first = readFileSync(file, 'utf8').split(/\r?\n/, 1)[0].trim()
      if (first) return first
    } catch { /* try the next source */ }
  }
  logger?.warn?.('agent-memory-gateway: no API key (env/file) — plugin idle')
  return null
}

function makeProjectResolver(cfg) {
  const cache = new Map()
  const confName = typeof cfg.projectConfigName === 'string' && cfg.projectConfigName ? cfg.projectConfigName : '.agent-memory/project.json'
  return function resolve(cwd) {
    if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd)) return null
    if (cache.has(cwd)) return cache.get(cwd)
    let dir = cwd
    let found = null
    for (let i = 0; i < 12; i++) {
      try {
        const parsed = JSON.parse(readFileSync(path.join(dir, confName), 'utf8'))
        if (parsed && typeof parsed.project_id === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(parsed.project_id)) {
          found = parsed.project_id
          break
        }
      } catch { /* keep walking up */ }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    cache.set(cwd, found)
    return found
  }
}

async function postJson(base, route, key, body, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), Math.max(200, intOf(timeoutMs, 1000)))
  try {
    const res = await fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) return { ok: false, status: res.status, data: await res.json().catch(() => null) }
    return { ok: true, data: await res.json().catch(() => null) }
  } catch {
    return { ok: false, status: 0 }
  } finally {
    clearTimeout(timer)
  }
}

function applyInner(ctx, cfg) {
  const logger = ctx?.logger
  if (cfg.enabled !== true) {
    logger?.info?.('agent-memory-gateway: disabled by profile config')
    return
  }
  const gatewayUrl = typeof cfg.gatewayUrl === 'string' && cfg.gatewayUrl ? cfg.gatewayUrl.replace(/\/+$/, '') : 'http://127.0.0.1:8892'
  const key = readKey(cfg, logger)
  if (!key) return

  const recallOn = cfg.recall !== false
  const ingestOn = cfg.ingest !== false
  const includeGlobal = cfg.includeGlobal !== false
  const topK = Math.min(20, intOf(cfg.topK, 8))
  const threshold = numOf(cfg.threshold, 0.25, 0, 1)
  const recallMaxChars = intOf(cfg.recallMaxChars, 1400)
  const recallTimeoutMs = intOf(cfg.recallTimeoutMs, 30000)
  const recallJoinMs = intOf(cfg.recallJoinMs, 1500)
  const ingestTimeoutMs = intOf(cfg.ingestTimeoutMs, 5000)
  const ingestBatchSize = intOf(cfg.ingestBatchSize, 8)
  const ingestFlushMs = intOf(cfg.ingestFlushMs, 5000)
  const maxMessageChars = intOf(cfg.maxMessageChars, 1800)
  const resolveProject = makeProjectResolver(cfg)
  // Host-owned fallback is a project scope, never implicit global publishing.
  const fallbackProject = typeof cfg.fallbackProjectId === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(cfg.fallbackProjectId) ? cfg.fallbackProjectId : null

  const agents = new Map()
  const recallCache = new Map()
  let disposed = false

  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    appendFileSync(path.join(STATE_DIR, 'activated.log'), JSON.stringify({ t: new Date().toISOString(), pid: process.pid, recall: recallOn, ingest: ingestOn }) + '\n', { mode: 0o600 })
  } catch { /* best effort */ }


  function agentState(agent) {
    let st = agents.get(agent)
    if (!st) {
      const header = object(agent?.session?.header) ? agent.session.header : {}
      st = {
        agent,
        projectId: resolveProject(typeof header.cwd === 'string' ? header.cwd : null) || fallbackProject,
        ingestState: ingestOn ? 'idle' : 'disabled',
        submittedFacts: 0,
        lastSubmissionAt: null,
        flushing: false,
        sessionId: typeof header.id === 'string' ? header.id : null,
        seen: new Set(),
        queue: [],
        cursor: typeof agent?.session?.seq === 'number' ? agent.session.seq : 0,
      }
      agents.set(agent, st)
    }
    return st
  }





  async function flush(st) {
    if (st.flushing || st.queue.length === 0) return
    if (!st.projectId) {
      st.ingestState = 'unavailable:no-project'
      return
    }
    st.flushing = true
    st.ingestState = 'submitting'
    const batch = st.queue.splice(0, Math.max(ingestBatchSize, 20))
    try {
      const response = await postJson(gatewayUrl, '/v1/memories/ingest', key, {
        project_id: st.projectId,
        messages: batch,
        source: { client: 'dsh-web', agent: name, thread_id: st.sessionId },
      }, ingestTimeoutMs)
      st.lastSubmissionAt = new Date().toISOString()
      if (response.ok && object(response.data) && response.data.ok === true && Number.isInteger(response.data.facts_accepted)) {
        st.submittedFacts += response.data.facts_accepted
        st.ingestState = response.data?.facts_accepted > 0 ? 'persisting:unverified' : 'processed:no-durable-facts'
      } else {
        // A timeout is uncertain, not a known failure: do not blindly resend.
        st.ingestState = response.data?.queued ? 'reconcile_pending' : response.ok ? 'unknown:invalid-response' : response.status === 0 ? 'unknown:timeout-or-network' : `failed:http-${response.status}`
      }
    } finally {
      st.flushing = false
    }
  }

  // The gateway fans the query out across banks, so a cold recall takes ~12s.
  // Strategy: never block prompt assembly on the network — warm the cache in
  // the background (agent/created) and let assembly join an in-flight recall
  // only for recallJoinMs; otherwise fail open and pick it up on the next step.
  async function recallFetch(projectId) {
    const body = { query: CONTINUITY_QUERY, top_k: topK, threshold, include_global: includeGlobal }
    if (projectId) body.project_id = projectId
    const res = await postJson(gatewayUrl, '/v1/memories/search', key, body, recallTimeoutMs)
    if (!res.ok || !Array.isArray(res.data?.results)) throw new Error('recall-unavailable')
    const lines = []
    let used = 0
    for (const item of res.data.results) {
      const fact = typeof item?.text === 'string' ? item.text.replace(/\s+/g, ' ').trim() : ''
      if (!fact) continue
      const line = `- ${fact}`
      if (used + line.length > recallMaxChars) break
      lines.push(line)
      used += line.length + 1
    }
    return lines.length ? '以下持久记忆与当前项目相关（自动召回，供参考，可能不是最新）：\n' + lines.join('\n') : ''
  }

  function recallEntry(projectId) {
    const cacheKey = projectId || '(global)'
    let entry = recallCache.get(cacheKey)
    if (!entry) {
      entry = { text: '', at: 0, failedAt: 0, inflight: null }
      recallCache.set(cacheKey, entry)
    }
    const fresh = entry.at > 0 && Date.now() - entry.at < RECALL_CACHE_TTL_MS
    const cooloff = entry.failedAt > 0 && Date.now() - entry.failedAt < 30_000
    if (!fresh && !cooloff && !entry.inflight) {
      entry.inflight = recallFetch(projectId)
        .then((text) => {
          entry.text = text
          entry.at = Date.now()
          entry.failedAt = 0
          return text
        })
        .catch(() => {
          entry.failedAt = Date.now()
          return entry.text
        })
        .finally(() => { entry.inflight = null })
    }
    return entry
  }

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  if (recallOn || ingestOn) ctx?.on?.('agent/created', (payload) => {
    try {
      const agent = payload?.agent
      if (!agent || disposed) return
      const st = agentState(agent)
      if (recallOn) recallEntry(st.projectId)
    } catch { /* fail-open */ }
  })

  if (recallOn) {
    ctx?.on?.('system-prompt/assemble', async (assembly, context, next) => {
      const result = await next()
      try {
        const agent = context?.agent
        if (!agent || disposed || !Array.isArray(result?.sections)) return result
        const st = agentState(agent)
        const entry = recallEntry(st.projectId)
        const recallState = entry.inflight ? 'pending' : entry.failedAt ? 'unavailable' : entry.at ? (entry.text ? 'cache-hit' : 'no-hits') : 'idle'
        const statusText = `记忆运行状态（宿主提供，非写入授权）：项目=${st.projectId || 'unassigned'}；自动摄取=${ingestOn ? 'enabled' : 'disabled'}；摄取状态=${st.ingestState}；本会话已提交候选事实=${st.submittedFacts}；召回=${recallState}。提交或超时不代表已持久保存；未经后端回读不得声称 retained。`
        let text = entry.text
        if (!text && entry.inflight) {
          text = (await Promise.race([entry.inflight, delay(recallJoinMs).then(() => null)])) ?? ''
        }
        text = statusText + (text ? '\n' + text : '')
        if (!result.sections.some((s) => s?.name === RECALL_SECTION)) {
          // 装配结果可能被深冻结(cordis 惯例): 用不可变替换代替原地 push, 否则 TypeError 会被 fail-open 吞掉导致召回静默失效
          const nextSections = result.sections.concat([{ name: RECALL_SECTION, text, interpolate: false }])
          try {
            result.sections = nextSections
            appendFileSync(path.join(STATE_DIR, 'recall-pushed.log'), JSON.stringify({ t: new Date().toISOString(), projectId: agentState(agent).projectId, chars: text.length, direct: true }) + "\n", { mode: 0o600 })
          } catch {
            return { ...result, sections: nextSections }
          }
        }
      } catch { /* fail-open */ }
      return result
    })
  }

  // 事故教训(2026-10-11): 'agent/request'/'agent/pre-step' 等是 dispatch.waterfall 钩子,
  // 监听者必须 return next() 传值; 返回 undefined 会清空请求配置, 使 prepareRequest 在
  // dsh-agent-loop L1185 读 proposedConfig.provider 抛 TypeError, 瘫痪全部会话。
  // 摄取只挂 emit 事件(agent/assistant-stream 为 dispatch.emit, 安全), 用会话日志游标取新消息。
  if (ingestOn) {
    const ingestText = (st, role, blocks) => {
      const content = (blocks ?? []).filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text).join('\n').trim()
      if (content.length < MIN_CHARS) return
      const hash = createHash('sha1').update(role + '\0' + content).digest('hex')
      if (st.seen.has(hash)) return
      st.seen.add(hash)
      if (st.seen.size > 4000) st.seen.clear()
      st.queue.push({ role, content: content.slice(0, maxMessageChars) })
      if (st.projectId && st.queue.length >= ingestBatchSize) void flush(st)
    }
    const scanSession = (st) => {
      const sess = st.agent?.session
      if (!sess || typeof sess.seq !== 'number' || typeof sess.snapshotEvents !== 'function') return
      const from = st.cursor
      const to = sess.seq
      if (to <= from) return
      st.cursor = to
      let events
      try { events = sess.snapshotEvents(from, to) } catch { return }
      for (const ev of events ?? []) {
        if (!ev) continue
        if (ev.type === 'user/message') {
          const c = ev.data?.content
          ingestText(st, ev.data?.role === 'assistant' ? 'assistant' : 'user', Array.isArray(c) ? c : [])
        } else if (ev.type === 'assistant/message') {
          const c = ev.data?.message?.content
          ingestText(st, 'assistant', Array.isArray(c) ? c : [])
        }
      }
    }
    ctx?.on?.('agent/assistant-stream', (payload) => {
      try {
        const frame = payload?.frame
        if (frame?.type !== 'end' || frame?.outcome?.kind !== 'committed') return
        const agent = payload?.agent
        if (!agent || disposed) return
        scanSession(agentState(agent))
      } catch { /* fail-open */ }
    })
    const timer = setInterval(() => {
      for (const st of new Set(agents.values())) {
        try { scanSession(st); void flush(st) } catch { /* fail-open */ }
      }
    }, ingestFlushMs)
    timer.unref?.()
    ctx?.effect?.(() => () => { disposed = true; clearInterval(timer) }, 'memory-gateway: timer lifecycle')
    ctx?.on?.('agent/disposed', (payload) => {
      const agent = payload?.agent
      const st = agents.get(agent)
      if (st) {
        try { scanSession(st) } catch { /* fail-open */ }
        void flush(st)
        agents.delete(agent)
      }
    })
  }

  const sessionStatus = st => {
    const entry = recallCache.get(st.projectId || '(global)')
    return { sessionId: st.sessionId, projectId: st.projectId, ingestState: st.ingestState, queued: st.queue.length, submittedFacts: st.submittedFacts, lastSubmissionAt: st.lastSubmissionAt, retainedVerified: false, recallState: !recallOn ? 'disabled' : entry?.inflight ? 'pending' : entry?.failedAt ? 'unavailable' : entry?.at ? (entry.text ? 'cache-hit' : 'no-hits') : 'idle' }
  }
  const status = () => ({ enabled: true, recall: recallOn, ingest: ingestOn, agents: agents.size, sessions: [...agents.values()].map(sessionStatus) })
  // Exact routes must enforce the host fence AND persistent browser auth.
  ctx?.inject?.(['webServer', 'connection'], host => {
    const route = { kind: 'exact', path: '/api/memory-gateway/status', handler(request, response) {
      const rejection = host.connection.requestRejection(request)
      if (rejection !== undefined) { response.writeHead(rejection); response.end(); return }
      if (request.method !== 'GET') { response.writeHead(405, { Allow: 'GET' }); response.end(); return }
      const sid = new URL(request.url, 'http://localhost').searchParams.get('session_id')
      const data = status()
      if (sid) data.sessions = data.sessions.filter(row => row.sessionId === sid)
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(data))
    } }
    host.effect(() => host.webServer.register(route), 'memory-gateway: authenticated status')
  })
  try {
    ctx.agentMemoryGateway = Object.freeze({ status })
  } catch { /* profile ctx 代理可能拒绝新增属性: 状态接口丢失可接受, 功能监听已注册 */ }
  logger?.info?.(`agent-memory-gateway: enabled (recall=${recallOn} ingest=${ingestOn} url=${gatewayUrl})`)
}

export function apply(ctx, input = {}) {
  try {
    applyInner(ctx, object(input) ? input : {})
  } catch {
    ctx?.logger?.warn?.('agent-memory-gateway: unexpected activation failure — plugin disabled')
  }
}
