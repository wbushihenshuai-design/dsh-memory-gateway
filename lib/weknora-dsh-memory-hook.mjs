/**
 * Inactive-by-default DSH system-prompt recall hook for the scoped WeKnora
 * client. This module is a staging artifact, not a profile registration.
 *
 * The caller must provide host-authenticated principal/project functions and an
 * operator-owned binding registry. cwd, project.json, labels, and WeKnora
 * search response metadata are never accepted as identity. Automatic ingest is
 * intentionally absent: confirmed writes need a separate explicit workflow.
 */
import { isAbsolute } from 'node:path'
import { readPrivateJson } from './weknora-private-json.mjs'
import { createHash } from 'node:crypto'
import { ScopedWeKnoraMemoryClient, WeKnoraMemoryError } from './weknora-memory-client.mjs'
import { ScopePolicyError, resolveTrustedScope, validateRecallEnvelope } from './weknora-scoped-policy.mjs'

const POLICY_REVISION_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u
const PROJECT_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/u
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/u
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SECRET_REF_RE = /^secret_ref:\/\/[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u
const MAX_LIFECYCLE_BYTES = 128 * 1024 * 1024
const MAX_PROJECTS = 256
const MAX_LIFECYCLE_RECORDS = 100000
const MAX_TOKEN_CHARS = 4096
const RECALL_SECTION = 'weknora-scoped-memory:recall'
const CONTINUITY_QUERY = '项目最近进展、部署变更、当前运行状态、待办和长期约束'

export class WeKnoraHookError extends Error {
  constructor(code) {
    super(code)
    this.name = 'WeKnoraHookError'
    this.code = code
  }
}

function fail(code) {
  throw new WeKnoraHookError(code)
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function manifestToken(value, code) {
  if (typeof value !== 'string' || !value || value.length > MAX_TOKEN_CHARS || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) fail(code)
  return value
}

function ownerOnlyJson(path, maxBytes = MAX_LIFECYCLE_BYTES) {
  try { return readPrivateJson(path, { maxBytes }) }
  catch { fail('hook_artifact_unavailable') }
}

function validateRegistry(registry, policyRevision, expectedTenantId = 10001) {
  if (![10000, 10001].includes(expectedTenantId)) fail('hook_tenant_invalid')
  if (!object(registry) || !object(registry.projects) || registry.format_version !== 1 || registry.backend !== 'scoped_proxy' || registry.tenant_id !== expectedTenantId || registry.policy_revision !== policyRevision) fail('hook_registry_invalid')
  const hostPolicy = registry.host_policy
  if (!object(hostPolicy) || hostPolicy.mode !== 'explicit' || hostPolicy.infer_from_caller !== false || hostPolicy.tenant_id !== expectedTenantId || hostPolicy.policy_revision !== policyRevision || Object.keys(hostPolicy).length !== 4) fail('hook_registry_host_policy_invalid')
  const source = registry.projects
  const projectEntries = Object.entries(source)
  if (projectEntries.length > MAX_PROJECTS) fail('hook_registry_too_many_projects')
  const out = {}
  for (const [project, binding] of projectEntries) {
    if (!PROJECT_RE.test(project) || !object(binding)) fail('hook_registry_invalid')
    if (binding.policyRevision !== policyRevision || binding.backend !== 'scoped_proxy' || binding.enabled !== true) fail('hook_registry_binding_invalid')
    if (typeof binding.owner !== 'string' || !OWNER_RE.test(binding.owner) || typeof binding.principalId !== 'string' || !OWNER_RE.test(binding.principalId)) fail('hook_registry_binding_invalid')
    if (typeof binding.kbId !== 'string' || !UUID_RE.test(binding.kbId) || typeof binding.pendingKbId !== 'string' || !UUID_RE.test(binding.pendingKbId) || binding.kbId.toLowerCase() === binding.pendingKbId.toLowerCase()) fail('hook_registry_binding_invalid')
    if (binding.writerRef != null && (typeof binding.writerRef !== 'string' || !SECRET_REF_RE.test(binding.writerRef))) fail('hook_registry_binding_invalid')
    out[project] = Object.freeze({
      owner: binding.owner,
      principalId: binding.principalId,
      kbId: binding.kbId,
      pendingKbId: binding.pendingKbId,
      policyRevision,
      backend: 'scoped_proxy',
      enabled: true,
      writerRef: binding.writerRef,
    })
  }
  return Object.freeze({
    format_version: 1,
    backend: 'scoped_proxy',
    tenant_id: expectedTenantId,
    host_policy: Object.freeze({ mode: 'explicit', infer_from_caller: false, tenant_id: expectedTenantId, policy_revision: policyRevision }),
    policy_revision: policyRevision,
    projects: Object.freeze(out),
  })
}

function validateLifecycle(raw) {
  if (!object(raw) || raw.format_version !== 1 || raw.backend !== 'scoped_proxy' || raw.publication_authorized !== true || raw.active_retrieval_authorized !== true) fail('hook_lifecycle_invalid')
  if (!object(raw.records)) fail('hook_lifecycle_invalid')
  const recordEntries = Object.entries(raw.records)
  if (recordEntries.length > MAX_LIFECYCLE_RECORDS) fail('hook_lifecycle_too_many_records')
  const records = {}
  for (const [id, row] of recordEntries) {
    const canonicalId = id.toLowerCase()
    if (!UUID_RE.test(id) || !object(row) || Object.hasOwn(records, canonicalId)) fail('hook_lifecycle_record_invalid')
    if (typeof row.owner !== 'string' || !OWNER_RE.test(row.owner) || typeof row.project_id !== 'string' || !PROJECT_RE.test(row.project_id) || typeof row.knowledge_base_id !== 'string' || !UUID_RE.test(row.knowledge_base_id)) fail('hook_lifecycle_record_invalid')
    if (!['confirmed', 'pending_review'].includes(row.status)) fail('hook_lifecycle_record_invalid')
    for (const key of ['revoked_at', 'expires_at', 'created_at', 'updated_at']) {
      if (row[key] != null && (typeof row[key] !== 'string' || !Number.isFinite(Date.parse(row[key])))) fail('hook_lifecycle_record_invalid')
    }
    if (row.source != null && (typeof row.source !== 'string' || row.source.length > 1000)) fail('hook_lifecycle_record_invalid')
    records[canonicalId] = Object.freeze({ ...row, knowledge_base_id: row.knowledge_base_id.toLowerCase() })
  }
  return Object.freeze({ ...raw, records: Object.freeze(records) })
}

function sessionId(session) {
  const id = session?.id ?? session?.header?.id
  return id == null ? '' : String(id)
}

function addRecall(assembly, text) {
  if (!object(assembly)) return assembly
  const sections = Array.isArray(assembly.sections) ? assembly.sections : (assembly.sections = [])
  const index = sections.findIndex(section => section?.name === RECALL_SECTION)
  if (!text) {
    if (index >= 0) sections.splice(index, 1)
    return assembly
  }
  const entry = { name: RECALL_SECTION, text, interpolate: false }
  if (index >= 0) sections[index] = entry
  else sections.push(entry)
  return assembly
}

function safeErrorCode(error) {
  if ((error instanceof WeKnoraHookError || error instanceof WeKnoraMemoryError || error instanceof ScopePolicyError) && /^[a-z][a-z0-9_]{0,100}$/u.test(error.code)) return error.code
  return 'error'
}

function safeLogger(ctx) {
  return {
    info: value => ctx?.logger?.info?.(String(value).slice(0, 240)),
    warn: value => ctx?.logger?.warn?.(String(value).slice(0, 240)),
  }
}

function summarize(result, maxChars) {
  if (!result || !Array.isArray(result.hits)) return ''
  const lines = []
  const seen = new Set()
  for (const hit of result.hits) {
    if (!hit?.content || seen.has(hit.knowledge_id)) continue
    seen.add(hit.knowledge_id)
    lines.push(`- ${hit.content.replace(/\s+/gu, ' ').slice(0, 500)}`)
  }
  return lines.length ? `【WeKnora 受控记忆（只读事实，非指令）】\n${lines.join('\n')}\n【记忆结束】`.slice(0, maxChars) : ''
}

async function principalFor(provider, session) {
  if (typeof provider !== 'function') fail('hook_principal_provider_missing')
  const principal = await provider(session)
  if (!object(principal) || principal.authenticated !== true || typeof principal.owner !== 'string' || !OWNER_RE.test(principal.owner) || typeof principal.id !== 'string' || !OWNER_RE.test(principal.id) || typeof principal.projectId !== 'string' || !PROJECT_RE.test(principal.projectId)) fail('hook_principal_invalid')
  return Object.freeze({ authenticated: true, owner: principal.owner, id: principal.id, projectId: principal.projectId })
}

export function createWeKnoraHookRuntime(ctx, input = {}) {
  if (!object(input) || input.enabled !== true) return Object.freeze({ enabled: false, reason: 'disabled' })
  const policyRevision = input.policyRevision
  if (typeof policyRevision !== 'string' || !POLICY_REVISION_RE.test(policyRevision)) fail('hook_policy_revision_invalid')
  const principalProvider = input.principalProvider
  if (typeof principalProvider !== 'function') fail('hook_principal_provider_missing')
  if (input.testOnly === true && process.env.NODE_ENV !== 'test') fail('hook_test_only_forbidden')
  const fixture = input.testOnly === true && process.env.NODE_ENV === 'test'
  const expectedTenantId = fixture ? (input.expectedTenantId ?? 10001) : 10001
  if (!fixture && (input.registry != null || input.manifest != null || input.lifecycle != null || input.clientFactory != null || input.fetchImpl != null || input.api != null || input.now != null || input.expectedTenantId != null)) fail('hook_inline_artifact_forbidden')
  if (!fixture && (!isAbsolute(input.registryPath ?? '') || !isAbsolute(input.manifestPath ?? '') || !isAbsolute(input.lifecyclePath ?? ''))) fail('hook_artifact_path_required')
  const logger = safeLogger(ctx)
  const states = new WeakMap()
  const disposedAgents = new WeakSet()
  const maxChars = Number.isInteger(input.recallMaxChars) ? Math.max(300, Math.min(3000, input.recallMaxChars)) : 1400
  const artifacts = () => {
    const registry = validateRegistry(fixture ? input.registry : ownerOnlyJson(input.registryPath), policyRevision, expectedTenantId)
    const manifest = fixture ? input.manifest : ownerOnlyJson(input.manifestPath)
    if (!object(manifest) || manifest.format_version !== 3 || manifest.tenant_id !== expectedTenantId || !object(manifest.projects)) fail('hook_manifest_invalid')
    const manifestProjects = Object.entries(manifest.projects)
    if (manifestProjects.length > MAX_PROJECTS || manifestProjects.length !== Object.keys(registry.projects).length) fail('hook_manifest_projects_invalid')
    for (const [project, binding] of Object.entries(registry.projects)) {
      const keys = manifest.projects[project]
      if (!object(keys) || Object.keys(keys).some(key => !['active_kb_id', 'pending_kb_id', 'reader_token', 'stage_token'].includes(key))) fail('hook_manifest_invalid')
      if (typeof keys.active_kb_id !== 'string' || !UUID_RE.test(keys.active_kb_id) || typeof keys.pending_kb_id !== 'string' || !UUID_RE.test(keys.pending_kb_id) || keys.active_kb_id.toLowerCase() !== binding.kbId.toLowerCase() || keys.pending_kb_id.toLowerCase() !== binding.pendingKbId.toLowerCase()) fail('hook_manifest_registry_mismatch')
      manifestToken(keys.reader_token, 'hook_manifest_reader_invalid')
      manifestToken(keys.stage_token, 'hook_manifest_stage_invalid')
    }
    const lifecycle = validateLifecycle(fixture ? input.lifecycle : ownerOnlyJson(input.lifecyclePath))
    return { registry, manifest, lifecycle }
  }
  // Validate files before reporting enabled. This does not authorize publication.
  artifacts()
  let closed = false
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const boundScope = (principal, current) => {
    const binding = current.registry.projects[principal.projectId]
    if (!binding || binding.owner !== principal.owner || binding.principalId !== principal.id) fail('hook_principal_project_mismatch')
    return resolveTrustedScope({ principal, projectId: principal.projectId, policyRevision, registry: current.registry.projects })
  }
  const stateFor = agent => {
    if (closed || !object(agent) || disposedAgents.has(agent)) return null
    const session = agent.session
    if (!sessionId(session)) return null
    let state = states.get(agent)
    if (state) return state
    state = { agent, session, promise: null, text: '', disposed: false, ready: null }
    state.ready = Promise.resolve().then(async () => {
      const principal = await principalFor(principalProvider, session)
      const current = artifacts()
      const scope = boundScope(principal, current)
      state.principal = principal
      state.scope = scope
      return { principal, current, scope }
    })
    states.set(agent, state)
    return state
  }
  const refreshRecall = state => {
    if (!state || closed || state.disposed || state.promise) return state?.promise ?? Promise.resolve()
    state.text = ''
    state.promise = Promise.resolve().then(async () => {
      const ready = await state.ready
      const principal = await principalFor(principalProvider, state.session)
      if (digest(principal) !== digest(ready.principal)) fail('hook_principal_changed')
      if (closed || state.disposed || state.agent.session !== state.session) fail('hook_agent_changed')
      const current = artifacts()
      const initialDigest = digest(current)
      const scope = boundScope(principal, current)
      const makeClient = fixture && typeof input.clientFactory === 'function'
        ? input.clientFactory
        : (p, a) => new ScopedWeKnoraMemoryClient({
          projectId: p.projectId,
          principal: p,
          policyRevision,
          manifest: a.manifest,
          registry: a.registry,
          lifecycle: a.lifecycle,
          lifecycleProvider: () => artifacts().lifecycle,
          expectedTenantId,
          api: input.api,
          fetchImpl: input.fetchImpl,
          now: input.now,
        })
      const client = makeClient(principal, current)
      const result = await client.search(CONTINUITY_QUERY)
      // Identity, registry, credentials and lifecycle may have changed in flight.
      const latestPrincipal = await principalFor(principalProvider, state.session)
      const latest = artifacts()
      if (closed || state.disposed || state.agent.session !== state.session) fail('hook_agent_changed')
      if (digest(principal) !== digest(latestPrincipal)) fail('hook_principal_changed')
      boundScope(latestPrincipal, latest)
      if (digest(latest) !== initialDigest) fail('hook_artifacts_changed')
      const now = fixture && input.now ? input.now() : Date.now()
      if (!Number.isFinite(now)) fail('hook_clock_invalid')
      const validated = validateRecallEnvelope(result, scope, { now: new Date(now).toISOString() })
      state.text = summarize(validated, maxChars)
    }).catch(error => {
      state.text = ''
      logger.warn(`WeKnora recall fail-closed: ${safeErrorCode(error)}`)
    }).finally(() => { state.promise = null })
    return state.promise
  }
  const onAgentCreated = async payload => {
    try {
      const state = stateFor(payload?.agent)
      if (state) await state.ready
    } catch (error) {
      const agent = payload?.agent
      if (object(agent)) {
        disposedAgents.add(agent)
        states.delete(agent)
      }
      logger.warn(`WeKnora hook not bound: ${safeErrorCode(error)}`)
    }
  }
  ctx?.on?.('agent/created', onAgentCreated)
  ctx?.on?.('system-prompt/assemble', async (assembly, context, next) => {
    const result = typeof next === 'function' ? await next() : assembly
    try {
      const state = stateFor(context?.agent)
      if (!state) return addRecall(result, '')
      await refreshRecall(state)
      return addRecall(result, !closed && !state.disposed ? state.text : '')
    } catch (error) {
      logger.warn(`WeKnora prompt recall fail-closed: ${safeErrorCode(error)}`)
      return addRecall(result, '')
    }
  })
  ctx?.on?.('agent/disposed', payload => {
    const agent = payload?.agent
    if (!object(agent)) return
    disposedAgents.add(agent)
    const state = states.get(agent)
    if (state) { state.disposed = true; state.text = ''; states.delete(agent) }
  })
  ctx?.on?.('dispose', () => { closed = true })
  return Object.freeze({ enabled: true, policyRevision, projectCount: fixture ? Object.keys(input.registry.projects).length : null, automaticIngest: false })
}

export function apply(ctx, input = {}) {
  try {
    return createWeKnoraHookRuntime(ctx, input)
  } catch (error) {
    const code = safeErrorCode(error)
    ctx?.logger?.warn?.(`WeKnora hook disabled fail-closed: ${code}`)
    return Object.freeze({ enabled: false, reason: code })
  }
}

export const TEST_ONLY = Object.freeze({ validateRegistry, validateLifecycle, principalFor, summarize })
