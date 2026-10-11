/**
 * Host-only pre-publication binding seam for the inactive WeKnora DSH hook.
 *
 * The host/controller must call reserve() after an explicit, operator-authorized
 * workspace/project selection and BEFORE agents.create()/resume(). It must pass
 * setupFor(sessionId) as the AgentSetup callback. The callback commits the
 * reservation at the exact unpublished-agent publication boundary.
 * readAuthorizationEpoch() must be a host-owned synchronous, monotonic counter
 * advanced on every account lifetime or policy change. It closes the async
 * setup window; async account lookup alone cannot validate a sync commit.
 *
 * This module deliberately does not inspect cwd, project files, Peer IDs,
 * cookies, workspace membership lists, or browser state. The resolver is an
 * external/operator-owned authorization authority; DSH workspace metadata is
 * not treated as ACL. No bearer token or secret is stored or returned.
 */
import { createHash } from 'node:crypto'

const PROJECT_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/u
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/u
const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u
const SECRET_KEY_RE = /(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|cookie|credential)/iu

export class PreboundBindingError extends Error {
  constructor(code) {
    super(code)
    this.name = 'PreboundBindingError'
    this.code = code
  }
}

function fail(code) { throw new PreboundBindingError(code) }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function opaque(value, code) {
  if (typeof value !== 'string' || !OPAQUE_ID_RE.test(value)) fail(code)
  return value
}
function project(value) {
  if (typeof value !== 'string' || !PROJECT_RE.test(value)) fail('prebound_project_invalid')
  return value
}
function owner(value) {
  if (typeof value !== 'string' || !OWNER_RE.test(value)) fail('prebound_owner_invalid')
  return value
}
function sessionOf(value) {
  let id
  // Session/agent objects may be proxies from the host. A throwing getter
  // must surface as a fixed code, never as the upstream error message.
  try { id = value?.id ?? value?.header?.id } catch { fail('prebound_session_invalid') }
  return opaque(id, 'prebound_session_invalid')
}
async function platformUserId(account) {
  let userId
  try {
    const platform = await account.getPlatformSession()
    userId = object(platform) ? platform.userId : undefined
  } catch {
    fail('prebound_account_unavailable')
  }
  if (typeof userId !== 'string' || !userId || userId !== userId.trim() || !OPAQUE_ID_RE.test(userId)) fail('prebound_account_unauthenticated')
  return userId
}
function principalId(userId) {
  return `platform-user:${createHash('sha256').update(`weknora-host-principal\0${userId}`).digest('hex')}`
}
function rejectSecretFields(keys) {
  const allowed = new Set(['authorized', 'workspaceId', 'projectId', 'owner'])
  for (const key of keys) {
    if (SECRET_KEY_RE.test(key)) fail('prebound_binding_secret_field')
    if (!allowed.has(key)) fail('prebound_binding_fields_invalid')
  }
}
function bindingResult(binding, selection) {
  let snapshot
  try {
    if (object(binding)) snapshot = {
      keys: Object.keys(binding),
      authorized: binding.authorized,
      workspaceId: binding.workspaceId,
      projectId: binding.projectId,
      owner: binding.owner,
    }
  } catch { fail('prebound_binding_unavailable') }
  if (!snapshot || snapshot.authorized !== true) fail('prebound_binding_unauthorized')
  rejectSecretFields(snapshot.keys)
  if (snapshot.workspaceId !== selection.workspaceId || snapshot.projectId !== selection.projectId) fail('prebound_binding_selection_mismatch')
  const resolvedOwner = owner(snapshot.owner)
  return Object.freeze({ workspaceId: selection.workspaceId, projectId: selection.projectId, owner: resolvedOwner })
}

/**
 * @param {{account:{getPlatformSession:Function}, resolveBinding:Function, readAuthorizationEpoch:Function, maxReservations?:number}} deps
 * resolveBinding is an operator-owned authorization call. It receives only
 * value-free identity and the explicit selection; it must return
 * {authorized:true, workspaceId, projectId, owner}.
 * readAuthorizationEpoch is mandatory, synchronous, and monotonic. The host
 * must advance it on account/session lifetime or binding-policy changes,
 * including an account change away and back. A constant is only a test fixture.
 */
export function createPreboundBindingStore({ account, resolveBinding, readAuthorizationEpoch, maxReservations = 1024 } = {}) {
  if (!object(account) || typeof account.getPlatformSession !== 'function') fail('prebound_account_provider_missing')
  if (typeof resolveBinding !== 'function') fail('prebound_binding_resolver_missing')
  if (typeof readAuthorizationEpoch !== 'function') fail('prebound_epoch_provider_missing')
  if (!Number.isSafeInteger(maxReservations) || maxReservations < 1 || maxReservations > 10000) fail('prebound_reservation_limit_invalid')
  const reservations = new Map()
  const pending = new Map()
  let lastEpoch = -1

  function readEpoch() {
    let value
    try { value = readAuthorizationEpoch() }
    catch { fail('prebound_epoch_unavailable') }
    if (!Number.isSafeInteger(value) || value < 0) {
      // Drain a wrongly async provider without exposing its rejection detail.
      try { Promise.prototype.then.call(value, () => {}, () => {}) } catch {}
      fail('prebound_epoch_invalid')
    }
    if (value < lastEpoch) fail('prebound_epoch_regressed')
    lastEpoch = value
    return value
  }
  function assertEpoch(expected) {
    if (readEpoch() !== expected) fail('prebound_authorization_changed')
  }

  function assertParent(parentId, parentRow, userId) {
    if (!parentId) return
    const current = reservations.get(parentId)
    if (!parentRow || current !== parentRow || current.published !== true) fail('prebound_parent_not_published')
    if (current.userId !== userId) fail('prebound_parent_account_mismatch')
    assertEpoch(current.authorizationEpoch)
  }

  async function reserve(raw = {}) {
    // Read selection fields inside a guard: caller-supplied getters must not
    // leak their original error (or a destructuring TypeError) to callers.
    let sessionId
    let workspaceId
    let projectId
    let parentSessionId = null
    try {
      if (!object(raw)) fail('prebound_selection_invalid')
      sessionId = raw.sessionId
      workspaceId = raw.workspaceId
      projectId = raw.projectId
      parentSessionId = raw.parentSessionId ?? null
    } catch (error) {
      if (error instanceof PreboundBindingError) throw error
      fail('prebound_selection_invalid')
    }
    const sid = opaque(sessionId, 'prebound_session_invalid')
    const workspace = opaque(workspaceId, 'prebound_workspace_invalid')
    const pid = project(projectId)
    if (reservations.has(sid) || pending.has(sid)) fail('prebound_session_already_reserved')
    let parentId = null
    let parentRow = null
    if (parentSessionId != null) {
      parentId = opaque(parentSessionId, 'prebound_parent_invalid')
      parentRow = reservations.get(parentId)
      if (!parentRow || parentRow.published !== true) fail('prebound_parent_not_published')
    }
    if (reservations.size + pending.size >= maxReservations) fail('prebound_reservation_limit')
    const attempt = { active: true, authorizationEpoch: readEpoch() }
    pending.set(sid, attempt)
    try {
      let userId
      try { userId = await platformUserId(account) }
      catch (error) {
        if (error instanceof PreboundBindingError) throw error
        fail('prebound_account_unavailable')
      }
      if (!attempt.active) fail('prebound_reservation_released')
      assertEpoch(attempt.authorizationEpoch)
      assertParent(parentId, parentRow, userId)
      let binding
      try {
        binding = await resolveBinding({ userId, sessionId: sid, workspaceId: workspace, projectId: pid, parentSessionId: parentId })
      } catch { fail('prebound_binding_unavailable') }
      if (!attempt.active) fail('prebound_reservation_released')
      assertEpoch(attempt.authorizationEpoch)
      const checked = bindingResult(binding, { workspaceId: workspace, projectId: pid })
      let currentUserId
      try { currentUserId = await platformUserId(account) }
      catch (error) {
        if (error instanceof PreboundBindingError) throw error
        fail('prebound_account_unavailable')
      }
      if (currentUserId !== userId) fail('prebound_account_changed')
      if (!attempt.active) fail('prebound_reservation_released')
      assertEpoch(attempt.authorizationEpoch)
      assertParent(parentId, parentRow, userId)
      const row = { ...checked, userId, authorizationEpoch: attempt.authorizationEpoch, published: false, setupIssued: false, parentSessionId: parentId }
      reservations.set(sid, row)
      return Object.freeze({ sessionId: sid, workspaceId: checked.workspaceId, projectId: checked.projectId, owner: checked.owner, published: false })
    } finally {
      if (pending.get(sid) === attempt) pending.delete(sid)
      attempt.active = false
    }
  }

  function setupFor(sessionId) {
    const sid = opaque(sessionId, 'prebound_session_invalid')
    const row = reservations.get(sid)
    if (!row) fail('prebound_reservation_missing')
    if (row.published) fail('prebound_already_published')
    return (_agentContext, agent) => {
      const current = reservations.get(sid)
      if (!current || current !== row) fail('prebound_setup_stale')
      // The `session` property access itself can come from a hostile proxy.
      let agentSession
      try { agentSession = agent?.session } catch { fail('prebound_session_invalid') }
      if (sessionOf(agentSession) !== sid) fail('prebound_session_mismatch')
      if (row.setupIssued) fail('prebound_setup_already_issued')
      row.setupIssued = true
      let committed = false
      return {
        commit() {
          const latest = reservations.get(sid)
          if (!latest || latest !== row || committed || row.published) fail('prebound_commit_invalid')
           assertEpoch(row.authorizationEpoch)
          latest.published = true
          committed = true
        },
      }
    }
  }

  async function principalProvider(session) {
    const sid = sessionOf(session)
    const row = reservations.get(sid)
    if (!row || row.published !== true) fail('prebound_reservation_not_published')
    let userId
    try { userId = await platformUserId(account) }
    catch (error) {
      if (error instanceof PreboundBindingError) throw error
      fail('prebound_account_unavailable')
    }
    const current = reservations.get(sid)
    if (current !== row || row.published !== true) fail('prebound_reservation_released')
    if (userId !== row.userId) fail('prebound_account_changed')
    assertEpoch(row.authorizationEpoch)
    return Object.freeze({ authenticated: true, owner: row.owner, id: principalId(userId), projectId: row.projectId })
  }

  function release(sessionId) {
    const sid = opaque(sessionId, 'prebound_session_invalid')
    const attempt = pending.get(sid)
    if (attempt) {
      attempt.active = false
      pending.delete(sid)
    }
    const row = reservations.get(sid)
    if (row) {
      row.released = true
      reservations.delete(sid)
    }
  }

  function status(sessionId) {
    const sid = opaque(sessionId, 'prebound_session_invalid')
    const row = reservations.get(sid)
    return row ? Object.freeze({ sessionId: sid, workspaceId: row.workspaceId, projectId: row.projectId, published: row.published }) : null
  }

  return Object.freeze({ reserve, setupFor, principalProvider, release, status })
}
