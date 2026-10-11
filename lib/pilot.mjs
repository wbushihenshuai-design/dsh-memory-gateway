// @local/weknora-memory-pilot
//
// Fail-closed WeKnora memory pilot plugin. NOT a general memory backend.
//
// The host policy is fixed at activation: exactly one workspace, one project,
// one principal digest, one preset allow-list. The queue file may only supply
// session IDs matching the pilot prefix; it can never widen scope, change the
// project, or pick an unlisted preset. Every artifact read enforces owner-only
// file mode. Any validation failure disables the plugin for the process
// lifetime — it never falls back to a looser policy.
import { createHash } from 'node:crypto'
import { readFileSync, statSync, existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply as applyHook } from './weknora-dsh-memory-hook.mjs'
import { createPreboundBindingStore } from './weknora-dsh-prebound-binding.mjs'
import { createWeKnoraPilotFactory } from './weknora-dsh-pilot-factory.mjs'

const name = 'dsh-memory-gateway:pilot'  // 子模块内部标识
// inject 清单已上提到包入口 index.js(合并后由入口统一声明)

const SESSION_PREFIX = /^pilot-[a-z0-9][a-z0-9._-]{6,63}$/u
const POLICY_KEYS = new Set(['authorized', 'mode', 'sessionId', 'workspaceId', 'projectId', 'presetId'])

function stablePrincipalId(userId) {
  return `platform-user:${createHash('sha256').update(`weknora-host-principal\0${userId}`).digest('hex')}`
}

function ownerOnlyJson(file, logger) {
  try {
    const info = statSync(file)
    if ((info.mode & 0o077) !== 0 || !(info.uid === 0 || info.uid === process.getuid())) {
      logger?.warn?.('weknora-memory-pilot: queue file must be owner-only (0600, current user)')
      return null
    }
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function applyInner(ctx, cfg) {
  const logger = ctx?.logger
  if (cfg.enabled !== true) {
    logger?.info?.('weknora-memory-pilot: disabled by profile config')
    return
  }

  // ---- fixed host policy (profile config is the authority; nothing else) ----
  const policy = {
    workspaceId: cfg.workspaceId,
    projectId: cfg.projectId,
    owner: cfg.owner,
    principalId: cfg.principalId,
    policyRevision: cfg.policyRevision,
    registryPath: cfg.registryPath,
    manifestPath: cfg.manifestPath,
    lifecyclePath: cfg.lifecyclePath,
    queuePath: cfg.queuePath,
    donePath: cfg.donePath,
    allowedPresets: Array.isArray(cfg.allowedPresets) ? cfg.allowedPresets : [],
  }
  const policyOk =
    typeof policy.workspaceId === 'string' && policy.workspaceId &&
    typeof policy.projectId === 'string' && policy.projectId &&
    typeof policy.owner === 'string' && /^owner:primary$/u.test(policy.owner) &&
    typeof policy.principalId === 'string' && /^platform-user:[0-9a-f]{64}$/u.test(policy.principalId) &&
    typeof policy.policyRevision === 'string' && policy.policyRevision &&
    [policy.registryPath, policy.manifestPath, policy.lifecyclePath, policy.queuePath, policy.donePath].every(p => typeof p === 'string' && path.isAbsolute(p)) &&
    policy.allowedPresets.length > 0 && policy.allowedPresets.every(p => typeof p === 'string' && p)
  if (!policyOk) {
    logger?.warn?.('weknora-memory-pilot: invalid or incomplete host policy in profile config — plugin disabled')
    return
  }

  // ---- authorization epoch: advances on any account lifetime change ----
  let epoch = 1
  const abort = new AbortController()
  ctx.on?.('dispose', () => { abort.abort() })
  void (async () => {
    try {
      for await (const _view of ctx.deepseekAccount.watch(abort.signal)) epoch += 1
    } catch {
      // watch teardown on dispose is normal; a broken watch must not silently
      // keep a stale epoch trusted, so freeze provisioning by disabling below.
      epoch = Number.NaN
    }
  })()

  // ---- resolveBinding: exact host-policy match, value-free ----
  async function resolveBinding(request) {
    if (!request || typeof request !== 'object') return { authorized: false }
    if (request.workspaceId !== policy.workspaceId || request.projectId !== policy.projectId) return { authorized: false }
    if (typeof request.userId !== 'string' || stablePrincipalId(request.userId) !== policy.principalId) return { authorized: false }
    return { authorized: true, workspaceId: policy.workspaceId, projectId: policy.projectId, owner: policy.owner }
  }

  let bindings
  try {
    bindings = createPreboundBindingStore({
      account: ctx.deepseekAccount,
      resolveBinding,
      readAuthorizationEpoch: () => {
        if (!Number.isSafeInteger(epoch)) throw new Error('epoch unavailable')
        return epoch
      },
      maxReservations: 4,
    })
  } catch {
    logger?.warn?.('weknora-memory-pilot: binding store construction failed — plugin disabled')
    return
  }

  // ---- recall hook (fail-closed inside applyHook) ----
  let hook
  try {
    hook = applyHook(ctx, {
      enabled: true,
      policyRevision: policy.policyRevision,
      registryPath: policy.registryPath,
      manifestPath: policy.manifestPath,
      lifecyclePath: policy.lifecyclePath,
      principalProvider: bindings.principalProvider,
    })
  } catch {
    hook = { enabled: false, reason: 'hook_apply_failed' }
  }
  if (hook?.enabled !== true) {
    logger?.warn?.(`weknora-memory-pilot: recall hook unavailable (${hook?.reason ?? 'unknown'}) — provisioning disabled`)
    return
  }

  // ---- read-only tool policy acknowledgement (exact selection only) ----
  function applyReadOnlyToolPolicy(_agentCtx, request) {
    if (!request || typeof request !== 'object') throw new Error('policy request invalid')
    if (
      request.sessionId == null || request.workspaceId !== policy.workspaceId ||
      request.projectId !== policy.projectId || !policy.allowedPresets.includes(request.presetId)
    ) throw new Error('policy selection mismatch')
    return { authorized: true, mode: 'read-only', sessionId: request.sessionId, workspaceId: request.workspaceId, projectId: request.projectId, presetId: request.presetId }
  }

  const factory = createWeKnoraPilotFactory({
    ctx: {
      workspaceRegistry: ctx.workspaceRegistry,
      agentPresets: ctx.agentPresets,
      agents: ctx.agents,
      agentDefaultModel: ctx.agentDefaultModel,
      applyReadOnlyToolPolicy,
    },
    bindings,
  })

  // ---- queue-driven provisioning: the queue may only narrow, never widen ----
  const live = new Map()
  let busy = false
  async function drainQueue() {
    if (busy || !existsSync(policy.queuePath)) return
    const queue = ownerOnlyJson(policy.queuePath, logger)
    if (!queue) return
    try {
      const raw = Array.isArray(queue.requests) ? queue.requests : []
      const requests = raw.slice(0, 2).map(row => ({
        sessionId: String(row?.sessionId ?? ''),
        workspaceId: policy.workspaceId,
        projectId: policy.projectId,
        presetId: policy.allowedPresets.includes(row?.presetId) ? row.presetId : policy.allowedPresets[0],
      }))
      if (raw.length === 0 || raw.length > 2 || requests.some(r => !SESSION_PREFIX.test(r.sessionId) || live.has(r.sessionId))) {
        writeFileSync(policy.donePath, JSON.stringify({ ok: false, error: 'queue_selection_invalid', at: new Date().toISOString() }) + '\n', { mode: 0o600 })
        unlinkSync(policy.queuePath)
        return
      }
      const result = await factory.createMany(requests.map(r => ({ ...r })))
      for (const sessionId of result.sessions) live.set(sessionId, result)
      writeFileSync(policy.donePath, JSON.stringify({
        ok: true, sessions: result.sessions, dispose: 'plugin-managed', at: new Date().toISOString(),
      }) + '\n', { mode: 0o600 })
      unlinkSync(policy.queuePath)
    } catch {
      writeFileSync(policy.donePath, JSON.stringify({ ok: false, error: 'provision_failed', at: new Date().toISOString() }) + '\n', { mode: 0o600 })
      try { unlinkSync(policy.queuePath) } catch {}
    }
  }
  const timer = setInterval(() => { void drainQueue() }, 3000)
  timer.unref?.()
  ctx.on?.('dispose', () => {
    clearInterval(timer)
    for (const result of new Set(live.values())) { void result.dispose().catch(() => {}) }
    live.clear()
  })

  try {
    ctx.weknoraPilot = Object.freeze({
      status: () => Object.freeze({ enabled: true, policyRevision: policy.policyRevision, sessions: [...live.keys()], epoch: Number.isSafeInteger(epoch) ? epoch : null }),
    })
  } catch { /* profile ctx 代理可能拒绝新增属性: 状态接口丢失可接受 */ }
  logger?.info?.('weknora-memory-pilot: enabled (recall hook + queue-driven provisioning)')
}

export function apply(ctx, input = {}) {
  // Outermost containment: an unexpected defect here must never take down the
  // host process plugin graph. The pilot simply stays off.
  try {
    applyInner(ctx, input && typeof input === 'object' ? input : {})
  } catch {
    ctx?.logger?.warn?.('weknora-memory-pilot: unexpected activation failure — plugin disabled')
  }
}
