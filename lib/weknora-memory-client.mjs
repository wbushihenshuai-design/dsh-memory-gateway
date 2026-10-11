import { readPrivateJson as readStrictPrivateJson } from './weknora-private-json.mjs'
import {
  ScopePolicyError,
  resolveTrustedScope,
  validateRecallEnvelope,
  validateStageAck,
  buildSearchRequest,
} from './weknora-scoped-policy.mjs'

const DEFAULT_API = 'http://127.0.0.1:8893/api/v1'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const HEX64_RE = /^[0-9a-f]{64}$/u
const PROJECT_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/u
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/u
const SECRET_REF_RE = /^secret_ref:\/\/[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u
const sameUUID = (left, right) => typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase()

const SECRET_RULES = Object.freeze([
  /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/iu,
  /\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret|password|passwd|pwd|cookie|session[_ -]?token)\b\s*[:=：]\s*[^\s,，。;；]+/iu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/iu,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{10,}\b/iu,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/iu,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\b(?:xoxb|xoxp)-[A-Za-z0-9-]{20,}\b/iu,
  /\b(?:token|credential|credentials|key)\b\s*[:=：]\s*[^\s,，。;；]+/iu,
])

export class WeKnoraMemoryError extends Error {
  constructor(code) {
    super(code)
    this.name = 'WeKnoraMemoryError'
    this.code = code
  }
}

function fail(code) {
  throw new WeKnoraMemoryError(code)
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertString(value, code, max = 20000) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max) fail(code)
  return value
}

function assertToken(value, code) {
  const token = assertString(value, code, 4096)
  if (/[\u0000-\u001f\u007f]/u.test(token)) fail(code)
  return token
}

function assertSecretFree(value, code = 'memory_secret_detected') {
  if (typeof value === 'string' && SECRET_RULES.some(pattern => pattern.test(value))) fail(code)
}

export function sanitizeQuery(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 20000) fail('search_query_invalid')
  const query = value.trim()
  if (SECRET_RULES.some(pattern => pattern.test(query))) return null
  return query.slice(0, 1200)
}

function assertUUID(value, code) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail(code)
  return value
}

function assertHash(value, code) {
  if (typeof value !== 'string' || !HEX64_RE.test(value)) fail(code)
  return value
}

function timestamp(value, code) {
  if (value == null) return null
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(code)
  return new Date(value).toISOString()
}

function readPrivateJson(path, maxBytes = 96 * 1024 * 1024) {
  try { return readStrictPrivateJson(path, { maxBytes }) }
  catch { fail('key_manifest_unavailable') }
}

function parseManifest(raw, expectedTenantId = 10001) {
  if (!isObject(raw) || raw.format_version !== 3 || !Number.isInteger(raw.tenant_id) || raw.tenant_id !== expectedTenantId || !isObject(raw.projects)) fail('key_manifest_invalid')
  return raw
}

export function loadKeyManifest(path, expectedTenantId = 10001) {
  try {
    return parseManifest(readPrivateJson(path), expectedTenantId)
  } catch (error) {
    if (error instanceof WeKnoraMemoryError) throw error
    fail('key_manifest_invalid')
  }
}

function bindingFor(manifest, projectId, mode) {
  if (!PROJECT_RE.test(projectId)) fail('trusted_project_invalid')
  const row = manifest.projects[projectId]
  if (!isObject(row)) fail('project_key_binding_missing')
  const active = assertUUID(row.active_kb_id, 'active_kb_invalid')
  const pending = row.pending_kb_id == null ? null : assertUUID(row.pending_kb_id, 'pending_kb_invalid')
  if (sameUUID(pending, active)) fail('active_pending_kb_must_differ')
  const binding = { active_kb_id: active, pending_kb_id: pending }
  if (mode === 'active') binding.reader_token = assertToken(row.reader_token, 'reader_key_missing')
  else {
    if (!pending) fail('pending_kb_invalid')
    binding.stage_token = assertToken(row.stage_token, 'stage_key_missing')
  }
  return Object.freeze(binding)
}

function lifecycleState(ledger, mode = 'active') {
  if (!isObject(ledger) || !isObject(ledger.records) || ledger.format_version !== 1 || ledger.backend !== 'scoped_proxy') fail('lifecycle_ledger_invalid')
  if (mode === 'active' && (ledger.publication_authorized !== true || ledger.active_retrieval_authorized !== true)) fail('active_retrieval_not_authorized')
  if (mode === 'stage' && (ledger.publication_authorized !== false || ledger.active_retrieval_authorized !== false)) fail('stage_lifecycle_state_invalid')
  const activeRetrievalAuthorized = ledger.active_retrieval_authorized === true
  const map = new Map()
  for (const [id, row] of Object.entries(ledger.records)) {
    assertUUID(id, 'lifecycle_target_id_invalid')
    if (!isObject(row)) fail('lifecycle_record_invalid')
    map.set(id, row)
  }
  return Object.freeze({ map, activeRetrievalAuthorized })
}

function rawHits(payload) {
  if (!isObject(payload) || (Object.hasOwn(payload, 'success') && payload.success !== true)) fail('weknora_response_invalid')
  const data = payload.data
  if (Array.isArray(data)) return data
  if (isObject(data) && Array.isArray(data.data)) return data.data
  if (isObject(data) && Array.isArray(data.rows)) return data.rows
  if (isObject(data) && Array.isArray(data.items)) return data.items
  if (Array.isArray(payload.hits)) return payload.hits
  fail('weknora_hits_invalid')
}

function rawRows(payload) {
  if (!isObject(payload)) fail('weknora_response_invalid')
  const data = payload.data
  if (Array.isArray(data)) return data
  if (isObject(data) && Array.isArray(data.data)) return data.data
  if (isObject(data) && Array.isArray(data.rows)) return data.rows
  if (isObject(data) && Array.isArray(data.items)) return data.items
  fail('weknora_rows_invalid')
}

function responseObject(payload, code) {
  if (!isObject(payload)) fail(code)
  if (isObject(payload.data)) return payload.data
  return payload
}

function normalizeHit(raw, scope, lifecycle, now) {
  if (!isObject(raw)) fail('weknora_hit_invalid')
  const knowledgeId = raw.knowledge_id
  assertUUID(knowledgeId, 'weknora_hit_knowledge_id_invalid')
  const id = raw.id == null ? knowledgeId : assertUUID(raw.id, 'weknora_hit_id_invalid')
  const life = lifecycle.get(knowledgeId)
  if (!life) fail('weknora_hit_untracked')
  if (life.owner !== scope.owner || life.project_id !== scope.projectId || life.knowledge_base_id !== scope.kbId) fail('weknora_hit_scope_mismatch')
  if (life.status !== 'confirmed' || life.revoked_at != null) fail('weknora_hit_not_active')
  const expiresAt = timestamp(life.expires_at, 'weknora_lifecycle_expiry_invalid')
  if (expiresAt && Date.parse(expiresAt) <= now) fail('weknora_hit_expired')
  const content = raw.content ?? raw.text ?? raw.memory
  assertString(content, 'weknora_hit_content_invalid')
  assertSecretFree(content)
  const source = life.source ?? raw.source ?? null
  if (source != null) {
    assertString(source, 'weknora_hit_source_invalid', 1000)
    assertSecretFree(source, 'weknora_hit_source_secret')
  }
  return {
    id,
    knowledge_id: knowledgeId,
    owner: scope.owner,
    project_id: scope.projectId,
    knowledge_base_id: scope.kbId,
    status: 'confirmed',
    revoked_at: null,
    expires_at: expiresAt,
    content,
    source,
    source_kind: life.source_kind ?? raw.source_kind ?? null,
    created_at: timestamp(life.created_at ?? raw.created_at, 'weknora_hit_created_invalid'),
    updated_at: timestamp(life.updated_at ?? raw.updated_at, 'weknora_hit_updated_invalid'),
    score: typeof raw.score === 'number' && Number.isFinite(raw.score) ? raw.score : null,
  }
}

function safeSource(value) {
  if (value == null) return null
  assertString(value, 'memory_source_invalid', 1000)
  if (/[\r\n|]/u.test(value)) fail('memory_source_invalid')
  assertSecretFree(value, 'memory_source_secret')
  return value
}

function stageBody(candidate) {
  if (!isObject(candidate)) fail('stage_candidate_invalid')
  const sourceRef = assertHash(candidate.source_ref_sha256, 'stage_source_ref_invalid')
  const project = assertString(candidate.project_id, 'stage_project_invalid', 80)
  if (!PROJECT_RE.test(project)) fail('stage_project_invalid')
  const owner = assertString(candidate.owner, 'stage_owner_invalid', 160)
  if (!OWNER_RE.test(owner) || /[|\r\n]/u.test(owner)) fail('stage_owner_invalid')
  const content = assertString(candidate.content, 'stage_content_invalid')
  assertSecretFree(content)
  if (candidate.status !== 'pending_review' || candidate.publication_authorized !== false) fail('stage_candidate_not_pending')
  if (candidate.scope !== 'project' || project !== candidate.project_id) fail('stage_candidate_scope_invalid')
  const expiresAt = timestamp(candidate.expires_at, 'stage_expiry_invalid')
  const lines = [
    '# Memory candidate (pending review)',
    '',
    '| field | value |',
    '|---|---|',
    `| migration status | pending_review |`,
    `| source ref SHA-256 | ${sourceRef} |`,
    `| owner | ${owner} |`,
    `| project_id | ${project} |`,
    `| source | ${safeSource(candidate.source) ?? ''} |`,
    `| created_at | ${timestamp(candidate.created_at, 'stage_created_invalid') ?? ''} |`,
    `| expires_at | ${expiresAt ?? ''} |`,
    '| publication authorized | false |',
    '',
    '## Sanitized candidate content',
    '',
    content,
    '',
  ]
  if (lines.some(line => /[\r\n]/u.test(line) && !line.startsWith('#') && !line.startsWith('|') && line !== '')) {
    // Content is allowed to be Markdown; the candidate itself has already
    // passed redaction. Provenance fields above remain single-line.
  }
  return { sourceRef, project, owner, expiresAt, content, body: lines.join('\n') }
}

function validateApiEndpoint(value) {
  const text = assertString(value, 'weknora_api_invalid', 300).replace(/\/$/u, '')
  // Credentials must never be sent to an arbitrary localhost service, a remote
  // HTTP endpoint, or a prefix that merely ends with /api/v1.
  if (![DEFAULT_API, 'https://kb.tiggo.autos/api/v1'].includes(text)) fail('weknora_api_host_unapproved')
  return text
}

async function boundedResponseText(response, maxBytes = 16 * 1024 * 1024) {
  if (!response.body || typeof response.body.getReader !== 'function') fail('weknora_response_stream_missing')
  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!(value instanceof Uint8Array)) fail('weknora_response_invalid')
      length += value.byteLength
      if (length > maxBytes) {
        await reader.cancel().catch(() => {})
        fail('weknora_response_too_large')
      }
      chunks.push(value)
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length)) }
    catch { fail('weknora_json_invalid') }
  } finally { reader.releaseLock() }
}

export class ScopedWeKnoraMemoryClient {
  constructor({ projectId, principal, policyRevision, manifest, registry, expectedTenantId = 10001, api = DEFAULT_API, fetchImpl = globalThis.fetch, now = () => Date.now(), lifecycle = {}, lifecycleProvider = null, mode = 'active' } = {}) {
    if (typeof fetchImpl !== 'function') fail('fetch_unavailable')
    this.projectId = assertString(projectId, 'trusted_project_invalid', 160)
    this.principal = principal
    this.policyRevision = assertString(policyRevision, 'trusted_policy_revision_invalid', 160)
    if (!['active', 'stage'].includes(mode)) fail('lifecycle_mode_invalid')
    this.mode = mode
    const checkedManifest = typeof manifest === 'string' ? loadKeyManifest(manifest, expectedTenantId) : parseManifest(manifest, expectedTenantId)
    this.binding = bindingFor(checkedManifest, this.projectId, mode)
    const registryProjects = isObject(registry?.projects) ? registry.projects : registry
    if (!isObject(registryProjects)) fail('trusted_registry_missing')
    if (isObject(registry?.projects) && (registry.format_version !== 1 || registry.backend !== 'scoped_proxy' || registry.tenant_id !== expectedTenantId || registry.policy_revision !== this.policyRevision || !isObject(registry.host_policy) || registry.host_policy.policy_revision !== this.policyRevision || registry.host_policy.tenant_id !== expectedTenantId)) fail('trusted_registry_invalid')
    const registryBinding = registryProjects[this.projectId]
    if (!isObject(registryBinding) || !sameUUID(registryBinding.kbId, this.binding.active_kb_id)) fail('trusted_registry_binding_invalid')
    if (mode === 'stage' && !sameUUID(registryBinding.pendingKbId, this.binding.pending_kb_id)) fail('trusted_pending_registry_binding_invalid')
    this.api = validateApiEndpoint(api)
    this.fetchImpl = fetchImpl
    this.now = now
    this.lifecycleProvider = lifecycleProvider
    if (lifecycleProvider != null && typeof lifecycleProvider !== 'function') fail('lifecycle_provider_invalid')
    this.lifecycle = lifecycleState(lifecycle, mode)
    this.scope = resolveTrustedScope({ principal, projectId: this.projectId, policyRevision: this.policyRevision, registry: registryProjects })
    if (!sameUUID(this.scope.kbId, this.binding.active_kb_id)) fail('trusted_manifest_registry_mismatch')
  }

  async #request(method, path, token, body, timeoutMs = 15000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const options = {
        method,
        headers: { Accept: 'application/json', 'X-API-Key': token },
        signal: controller.signal,
        redirect: 'error',
      }
      if (body !== undefined) {
        options.headers['Content-Type'] = 'application/json'
        options.body = JSON.stringify(body)
      }
      const response = await this.fetchImpl(this.api + path, options)
      const text = await boundedResponseText(response)
      if (text.length > 16 * 1024 * 1024) fail('weknora_response_too_large')
      let payload
      try { payload = text ? JSON.parse(text) : {} } catch { fail('weknora_json_invalid') }
      if (!response.ok) fail(`weknora_http_${response.status}`)
      if (isObject(payload) && payload.success === false) fail('weknora_api_error')
      return payload
    } catch (error) {
      if (error instanceof WeKnoraMemoryError) throw error
      if (error?.name === 'AbortError') fail('weknora_timeout')
      if (error?.name === 'TypeError' && /redirect/iu.test(String(error.message))) fail('weknora_redirect_rejected')
      fail('weknora_network_error')
    } finally {
      clearTimeout(timer)
    }
  }

  async search(query, { topK = 8 } = {}) {
    if (this.mode !== 'active') fail('stage_search_forbidden')
    const safeQuery = sanitizeQuery(query)
    const empty = () => ({ backend: 'scoped_proxy', policy_revision: this.policyRevision, owner: this.scope.owner, project_id: this.scope.projectId, knowledge_base_id: this.scope.kbId, hits: [] })
    if (safeQuery == null) return empty()
    const request = buildSearchRequest(this.scope, safeQuery, { topK })
    const payload = await this.#request('POST', '/knowledge-search', this.binding.reader_token, request)
    const now = Number(this.now())
    if (!Number.isFinite(now)) fail('clock_invalid')
    const lifecycle = this.lifecycleProvider == null ? this.lifecycle.map : lifecycleState(this.lifecycleProvider(), this.mode).map
    const seenKnowledge = new Set()
    const hits = []
    for (const raw of rawHits(payload)) {
      const knowledgeId = raw?.knowledge_id
      if (seenKnowledge.has(knowledgeId)) continue
      const normalized = normalizeHit(raw, this.scope, lifecycle, now)
      seenKnowledge.add(normalized.knowledge_id)
      hits.push(normalized)
      if (hits.length >= Math.min(topK, 20)) break
    }
    const envelope = {
      backend: 'scoped_proxy',
      policy_revision: this.policyRevision,
      owner: this.scope.owner,
      project_id: this.scope.projectId,
      knowledge_base_id: this.scope.kbId,
      hits,
    }
    return validateRecallEnvelope(envelope, this.scope, { maxHits: Math.min(topK, 20), now: new Date(now).toISOString() })
  }

  /** Automatic DSH ingest is intentionally not allowed to publish. */
  async ingest() {
    fail('automatic_ingest_requires_explicit_confirmation')
  }

  async #readbackDraft(targetId, expectedBody, expectedTitle) {
    const payload = await this.#request('GET', `/knowledge/${encodeURIComponent(targetId)}`, this.binding.stage_token, undefined, 30000)
    const doc = responseObject(payload, 'stage_readback_invalid')
    const returnedId = assertUUID(doc.id ?? doc.knowledge_id ?? targetId, 'stage_readback_id_invalid')
    if (!sameUUID(returnedId, targetId)) fail('stage_readback_id_mismatch')
    if (!sameUUID(doc.knowledge_base_id, this.binding.pending_kb_id)) fail('stage_readback_kb_mismatch')
    if (doc.parse_status !== 'draft') fail('stage_readback_status_invalid')
    if (doc.enable_status !== 'disabled') fail('stage_readback_enable_invalid')
    const metadata = isObject(doc.metadata) ? doc.metadata : null
    if (!metadata || metadata.status !== 'draft' || metadata.content !== expectedBody) fail('stage_readback_body_mismatch')
    if (metadata.title != null && metadata.title !== expectedTitle) fail('stage_readback_title_mismatch')
    return doc
  }

  async stage(candidate) {
    if (this.mode !== 'stage') fail('stage_client_mode_required')
    if (!isObject(candidate) || candidate.owner !== this.scope.owner || candidate.project_id !== this.scope.projectId) fail('stage_candidate_scope_mismatch')
    const body = stageBody(candidate)
    const title = `mem0-pending-${body.sourceRef}.md`
    const payload = await this.#request(
      'POST',
      `/knowledge-bases/${encodeURIComponent(this.binding.pending_kb_id)}/knowledge/manual`,
      this.binding.stage_token,
      { title, content: body.body, status: 'draft', channel: 'api' },
      30000,
    )
    const data = responseObject(payload, 'stage_response_invalid')
    const targetId = assertUUID(data.id ?? data.knowledge_id, 'stage_target_id_invalid')
    await this.#readbackDraft(targetId, body.body, title)
    const ack = {
      backend: 'scoped_proxy',
      policy_revision: this.policyRevision,
      owner: this.scope.owner,
      project_id: this.scope.projectId,
      knowledge_base_id: this.binding.pending_kb_id,
      source_ref_sha256: body.sourceRef,
      target_id: targetId,
      status: 'pending_review',
    }
    return validateStageAck(ack, { ...this.scope, kbId: this.binding.pending_kb_id })
  }
}

export const TEST_ONLY = Object.freeze({ stageBody, normalizeHit })
