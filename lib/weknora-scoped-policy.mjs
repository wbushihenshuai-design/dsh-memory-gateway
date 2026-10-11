/**
 * Fail-closed contract helpers for a future WeKnora scoped-memory proxy.
 *
 * This module intentionally has no network, filesystem, credential, or DSH
 * registration code. Project files and cwd are not trusted identity sources.
 * A caller must supply a host-authenticated principal and an operator-owned
 * binding registry. The current deployment does not activate this module.
 */

export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/u
export const OWNER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/u
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
export const HEX64_RE = /^[0-9a-f]{64}$/u
export const MAX_CONTENT_CHARS = 20000

const SECRET_RULES = Object.freeze([
  /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/iu,
  /\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret|password|passwd|pwd|cookie|session[_ -]?token)\b\s*[:=：]\s*[^\s,，。;；]+/iu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/iu,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{10,}\b/iu,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/iu,
])

export class ScopePolicyError extends Error {
  constructor(code) {
    super(code)
    this.name = 'ScopePolicyError'
    this.code = code
  }
}

function fail(code) {
  throw new ScopePolicyError(code)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(value, code, pattern = null) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) fail(code)
  if (pattern && !pattern.test(value)) fail(code)
  return value
}

function strictTimestamp(value, code) {
  if (value == null) return null
  if (typeof value !== 'string' || !value.trim()) fail(code)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) fail(code)
  return new Date(parsed).toISOString()
}

function assertNoSecret(value, code = 'memory_secret_detected') {
  if (typeof value !== 'string') return
  if (SECRET_RULES.some(rule => rule.test(value))) fail(code)
}

function cloneFreeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneFreeze))
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, child] of Object.entries(value)) out[key] = cloneFreeze(child)
    return Object.freeze(out)
  }
  return value
}

/**
 * Bind a request to an operator-owned registry entry and host-authenticated
 * principal. It deliberately ignores cwd, project files, aliases and global
 * fallbacks.
 *
 * Expected input:
 * {
 *   principal: { authenticated: true, owner: 'owner:primary', id: '...' },
 *   projectId: 'project-id',
 *   policyRevision: '...',
 *   registry: { 'project-id': {
 *     owner: 'owner:primary', principalId: '...', kbId: UUID,
 *     backend: 'scoped_proxy', enabled: true,
 *     writerRef: 'secret_ref://...' // optional, value-free
 *   }}
 * }
 */
export function resolveTrustedScope(input) {
  if (!isPlainObject(input)) fail('trusted_scope_input_invalid')
  const principal = input.principal
  if (!isPlainObject(principal) || principal.authenticated !== true) fail('trusted_principal_missing')
  const owner = requiredString(principal.owner, 'trusted_owner_invalid', OWNER_ID_RE)
  const principalId = requiredString(principal.id, 'trusted_principal_id_invalid', OWNER_ID_RE)
  const projectId = requiredString(input.projectId, 'trusted_project_invalid', PROJECT_ID_RE)
  const policyRevision = requiredString(input.policyRevision, 'trusted_policy_revision_invalid')
  const registry = input.registry
  if (!isPlainObject(registry)) fail('trusted_registry_missing')
  const binding = registry[projectId]
  if (!isPlainObject(binding)) fail('trusted_project_binding_missing')
  if (binding.enabled !== true || binding.backend !== 'scoped_proxy') fail('trusted_project_binding_disabled')
  if (binding.owner !== owner || binding.principalId !== principalId) fail('trusted_principal_project_mismatch')
  const kbId = requiredString(binding.kbId, 'trusted_kb_invalid', UUID_RE)
  if (binding.policyRevision !== policyRevision) fail('trusted_policy_revision_mismatch')
  if (binding.writerRef != null) {
    requiredString(binding.writerRef, 'trusted_writer_ref_invalid')
    if (!/^secret_ref:\/\/[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u.test(binding.writerRef)) fail('trusted_writer_ref_invalid')
  }
  return cloneFreeze({
    owner,
    principalId,
    projectId,
    kbId,
    policyRevision,
    backend: 'scoped_proxy',
  })
}

export function buildSearchRequest(scope, query, options = {}) {
  if (!isPlainObject(scope) || scope.backend !== 'scoped_proxy') fail('search_scope_invalid')
  requiredString(scope.owner, 'search_owner_invalid', OWNER_ID_RE)
  requiredString(scope.projectId, 'search_project_invalid', PROJECT_ID_RE)
  requiredString(scope.kbId, 'search_kb_invalid', UUID_RE)
  requiredString(scope.policyRevision, 'search_policy_revision_invalid')
  if (typeof query !== 'string' || !query.trim()) fail('search_query_invalid')
  const topK = Number(options.topK ?? 8)
  if (!Number.isInteger(topK) || topK < 1 || topK > 20) fail('search_top_k_invalid')
  return cloneFreeze({
    query: query.trim().slice(0, 2000),
    owner: scope.owner,
    project_id: scope.projectId,
    knowledge_base_id: scope.kbId,
    knowledge_base_ids: [scope.kbId],
    include_global: false,
    top_k: topK,
    policy_revision: scope.policyRevision,
  })
}

function validateHit(hit, scope, nowMs) {
  if (!isPlainObject(hit)) fail('recall_hit_invalid')
  const allowed = new Set([
    'id', 'knowledge_id', 'owner', 'project_id', 'knowledge_base_id',
    'status', 'revoked_at', 'expires_at', 'content', 'source', 'source_kind',
    'created_at', 'updated_at', 'score',
  ])
  if (Object.keys(hit).some(key => !allowed.has(key))) fail('recall_hit_fields_invalid')
  const id = requiredString(hit.id, 'recall_hit_id_invalid', UUID_RE)
  const knowledgeId = requiredString(hit.knowledge_id, 'recall_hit_knowledge_id_invalid', UUID_RE)
  if (hit.owner !== scope.owner || hit.project_id !== scope.projectId || hit.knowledge_base_id !== scope.kbId) {
    fail('recall_hit_scope_mismatch')
  }
  if (hit.status !== 'confirmed' || hit.revoked_at != null) fail('recall_hit_not_active')
  const expiresAt = strictTimestamp(hit.expires_at, 'recall_hit_expiry_invalid')
  if (expiresAt && Date.parse(expiresAt) <= nowMs) fail('recall_hit_expired')
  const content = requiredString(hit.content, 'recall_hit_content_invalid')
  if (content.length > MAX_CONTENT_CHARS) fail('recall_hit_content_too_large')
  assertNoSecret(content)
  if (hit.source != null) {
    requiredString(hit.source, 'recall_hit_source_invalid')
    assertNoSecret(hit.source, 'recall_hit_source_secret')
  }
  for (const key of ['created_at', 'updated_at']) strictTimestamp(hit[key], 'recall_hit_timestamp_invalid')
  if (hit.score != null && (typeof hit.score !== 'number' || !Number.isFinite(hit.score))) fail('recall_hit_score_invalid')
  return cloneFreeze({
    id,
    knowledge_id: knowledgeId,
    owner: hit.owner,
    project_id: hit.project_id,
    knowledge_base_id: hit.knowledge_base_id,
    status: hit.status,
    revoked_at: null,
    expires_at: expiresAt,
    content,
    source: hit.source ?? null,
    source_kind: hit.source_kind ?? null,
    created_at: hit.created_at ?? null,
    updated_at: hit.updated_at ?? null,
    score: hit.score ?? null,
  })
}

/** Validate every returned item; one bad item fails the whole response. */
export function validateRecallEnvelope(envelope, scope, options = {}) {
  if (!isPlainObject(envelope) || envelope.backend !== 'scoped_proxy') fail('recall_envelope_invalid')
  if (envelope.policy_revision !== scope.policyRevision) fail('recall_policy_revision_mismatch')
  if (envelope.owner !== scope.owner || envelope.project_id !== scope.projectId || envelope.knowledge_base_id !== scope.kbId) {
    fail('recall_envelope_scope_mismatch')
  }
  const hits = envelope.hits
  if (!Array.isArray(hits)) fail('recall_hits_invalid')
  const maxHits = Number(options.maxHits ?? 20)
  if (!Number.isInteger(maxHits) || maxHits < 1 || maxHits > 20 || hits.length > maxHits) fail('recall_hits_over_limit')
  const nowValue = options.now == null ? Date.now() : Date.parse(options.now)
  if (!Number.isFinite(nowValue)) fail('recall_now_invalid')
  const ids = new Set()
  const validated = hits.map(hit => {
    const value = validateHit(hit, scope, nowValue)
    if (ids.has(value.id)) fail('recall_duplicate_hit')
    ids.add(value.id)
    return value
  })
  return cloneFreeze({
    backend: 'scoped_proxy',
    policy_revision: scope.policyRevision,
    owner: scope.owner,
    project_id: scope.projectId,
    knowledge_base_id: scope.kbId,
    hits: validated,
  })
}

export function validateStageAck(ack, scope) {
  if (!isPlainObject(ack) || ack.backend !== 'scoped_proxy') fail('stage_ack_invalid')
  if (ack.policy_revision !== scope.policyRevision || ack.owner !== scope.owner || ack.project_id !== scope.projectId || ack.knowledge_base_id !== scope.kbId) {
    fail('stage_ack_scope_mismatch')
  }
  const sourceRefHash = requiredString(ack.source_ref_sha256, 'stage_ack_source_ref_invalid', HEX64_RE)
  const status = ack.status
  if (!['pending_review', 'accepted', 'rejected', 'revoked'].includes(status)) fail('stage_ack_status_invalid')
  if (status === 'accepted') fail('stage_ack_cannot_auto_confirm')
  const targetId = ack.target_id == null ? null : requiredString(ack.target_id, 'stage_ack_target_id_invalid', UUID_RE)
  return cloneFreeze({
    backend: 'scoped_proxy',
    policy_revision: scope.policyRevision,
    owner: scope.owner,
    project_id: scope.projectId,
    knowledge_base_id: scope.kbId,
    source_ref_sha256: sourceRefHash,
    target_id: targetId,
    status,
  })
}
