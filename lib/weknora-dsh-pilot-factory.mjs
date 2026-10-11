/**
 * Inactive host-only factory for a bounded WeKnora DSH pilot.
 *
 * This module is not a Cordis/profile registration. The host must construct the
 * prebound binding store with authenticated account + operator policy, wait for
 * plugin activation to settle, and call this factory explicitly. It creates
 * only caller-supplied independent session IDs; it never infers project/owner
 * from cwd, session membership, browser peers, or model text.
 *
 * The factory authorizes an exact preset selection and requires a host-owned
 * read-only tool-policy application after the preset is mounted and before the
 * setup callback returns. It cannot inspect or enforce preset internals itself;
 * the host callback must do that and return the exact policy acknowledgement.
 * The factory then commits the binding at DSH's setup/publication boundary and
 * attaches the session to the already-selected Workspace. A failed attach is
 * compensated by releasing the binding and disposing the returned handle.
 * Multi-session provisioning is sequential and compensates earlier successes if
 * a later create fails.
 */

const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{7,255}$/u
const PRESET_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/u

export class WeKnoraPilotError extends Error {
  constructor(code) {
    super(code)
    this.name = 'WeKnoraPilotError'
    this.code = code
  }
}

function fail(code) {
  throw new WeKnoraPilotError(code)
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function id(value, code, pattern = SESSION_RE) {
  if (typeof value !== 'string' || !pattern.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) fail(code)
  return value
}

function service(value, code) {
  if (!object(value)) fail(code)
  return value
}

function fixedCode(error, fallback = 'pilot_operation_failed') {
  if (error instanceof WeKnoraPilotError) return error.code
  return fallback
}

function selectionOf(raw) {
  if (!object(raw)) fail('pilot_selection_invalid')
  const sessionId = id(raw.sessionId, 'pilot_session_invalid')
  const workspaceId = id(raw.workspaceId, 'pilot_workspace_invalid', /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u)
  const projectId = id(raw.projectId, 'pilot_project_invalid', /^[a-z0-9][a-z0-9._-]{0,79}$/u)
  const presetId = id(raw.presetId, 'pilot_preset_invalid', PRESET_RE)
  return Object.freeze({ sessionId, workspaceId, projectId, presetId })
}

function currentModel(ctx) {
  let value
  try { value = ctx.agentDefaultModel.currentSelection() } catch { fail('pilot_model_unavailable') }
  if (!object(value)) fail('pilot_model_invalid')
  return value
}

function handleDisposer(handle) {
  if (!object(handle) || typeof handle.dispose !== 'function') fail('pilot_handle_invalid')
  return handle
}

/**
 * @param {{
 *   workspaceRegistry: {get: Function},
 *   agentPresets: {resolve: Function, mount: Function},
 *   agents: {create: Function},
 *   agentDefaultModel: {currentSelection: Function},
 *   applyReadOnlyToolPolicy: Function
 * }} ctx
 * @param {{reserve: Function, setupFor: Function, release: Function}} bindings
 */
export function createWeKnoraPilotFactory({ ctx, bindings } = {}) {
  service(ctx, 'pilot_context_missing')
  service(bindings, 'pilot_bindings_missing')
  service(ctx.workspaceRegistry, 'pilot_workspace_registry_missing')
  service(ctx.agentPresets, 'pilot_preset_registry_missing')
  service(ctx.agents, 'pilot_agent_registry_missing')
  service(ctx.agentDefaultModel, 'pilot_model_service_missing')
  if (typeof ctx.applyReadOnlyToolPolicy !== 'function') fail('pilot_tool_policy_missing')
  if (typeof ctx.workspaceRegistry.get !== 'function') fail('pilot_workspace_lookup_missing')
  if (typeof ctx.agentPresets.resolve !== 'function' || typeof ctx.agentPresets.mount !== 'function') fail('pilot_preset_api_missing')
  if (typeof ctx.agents.create !== 'function') fail('pilot_agent_create_missing')
  if (typeof ctx.agentDefaultModel.currentSelection !== 'function') fail('pilot_model_api_missing')
  if (typeof bindings.reserve !== 'function' || typeof bindings.setupFor !== 'function' || typeof bindings.release !== 'function') fail('pilot_binding_api_missing')

  async function createOne(rawSelection) {
    const selection = selectionOf(rawSelection)
    let workspace
    let preset
    try { workspace = ctx.workspaceRegistry.get(selection.workspaceId) } catch { fail('pilot_workspace_lookup_failed') }
    if (!object(workspace) || typeof workspace.path !== 'string' || !workspace.path || typeof workspace.attachSession !== 'function') fail('pilot_workspace_missing')
    try { preset = await ctx.agentPresets.resolve(selection.presetId) } catch { fail('pilot_preset_resolve_failed') }
    if (!object(preset) || typeof preset.id !== 'string' || !PRESET_RE.test(preset.id) || preset.id !== selection.presetId) fail('pilot_preset_selection_mismatch')

    let reserved = false
    let handle
    try {
      await bindings.reserve({
        sessionId: selection.sessionId,
        workspaceId: selection.workspaceId,
        projectId: selection.projectId,
      })
      reserved = true
      handle = handleDisposer(await ctx.agents.create({
        sessionId: selection.sessionId,
        meta: { cwd: workspace.path, agentPreset: preset.id },
        agentOptions: currentModel(ctx),
        setup: async (agentCtx, agent) => {
          await ctx.agentPresets.mount(agentCtx, preset.id)
          let policyAck
          try { policyAck = await ctx.applyReadOnlyToolPolicy(agentCtx, { sessionId: selection.sessionId, workspaceId: selection.workspaceId, projectId: selection.projectId, presetId: preset.id }) } catch { fail('pilot_tool_policy_failed') }
          const policyKeys = new Set(['authorized', 'mode', 'sessionId', 'workspaceId', 'projectId', 'presetId'])
           if (!object(policyAck) || Object.keys(policyAck).some(key => !policyKeys.has(key)) || policyAck.authorized !== true || policyAck.mode !== 'read-only' || policyAck.sessionId !== selection.sessionId || policyAck.workspaceId !== selection.workspaceId || policyAck.projectId !== selection.projectId || policyAck.presetId !== preset.id) fail('pilot_tool_policy_failed')
          return bindings.setupFor(selection.sessionId)(agentCtx, agent)
        },
      }))
      await workspace.attachSession(selection.sessionId)
      reserved = false
      let handleDisposed = false
      let bindingReleased = false
      let cleanupPromise
      const dispose = async () => {
        if (cleanupPromise) return cleanupPromise
        cleanupPromise = (async () => {
          let cleanupFailed = false
          // Retry only the part that failed. This keeps a transient disposer
          // failure from making the pilot permanently uncleanable.
          if (!handleDisposed) {
            try {
              await handle.dispose()
              handleDisposed = true
            } catch {
              cleanupFailed = true
            }
          }
          if (!handleDisposed) cleanupFailed = true
          if (handleDisposed && !bindingReleased) {
            try {
              await bindings.release(selection.sessionId)
              bindingReleased = true
            } catch {
              cleanupFailed = true
            }
          }
          if (cleanupFailed) fail('pilot_dispose_failed')
        })()
        try {
          return await cleanupPromise
        } catch (error) {
          cleanupPromise = undefined
          throw error
        }
      }
      // Do not expose the raw Agent handle. The host-owned disposer is the
      // only supported lifecycle operation after provisioning.
      return Object.freeze({ selection, dispose })
    } catch (error) {
      // Dispose the Agent before releasing its binding. If either step is
      // ambiguous, fail with a lifecycle error so the host can reconcile it.
      let cleanupFailed = false
      let handleDisposed = !handle
      if (handle) {
        try {
          await handle.dispose()
          handleDisposed = true
        } catch {
          cleanupFailed = true
        }
      }
      if (reserved && handleDisposed) {
        try { await bindings.release(selection.sessionId) } catch { cleanupFailed = true }
      } else if (reserved) {
        cleanupFailed = true
      }
      if (cleanupFailed) fail('pilot_dispose_failed')
      if (error instanceof WeKnoraPilotError) throw error
      fail(fixedCode(error))
    }
  }

  async function createMany(rawSelections) {
    if (!Array.isArray(rawSelections) || rawSelections.length < 1 || rawSelections.length > 2) fail('pilot_selections_invalid')
    const selections = rawSelections.map(selectionOf)
    const seen = new Set()
    for (const selection of selections) {
      if (seen.has(selection.sessionId)) fail('pilot_duplicate_session')
      seen.add(selection.sessionId)
    }
    const created = []
    try {
      for (const selection of selections) created.push(await createOne(selection))
      let cleanupPromise
      const dispose = async () => {
        if (cleanupPromise) return cleanupPromise
        cleanupPromise = (async () => {
          let failed = false
          for (const row of [...created].reverse()) {
            try { await row.dispose() } catch { failed = true }
          }
          if (failed) fail('pilot_dispose_failed')
        })()
        try {
          return await cleanupPromise
        } catch (error) {
          cleanupPromise = undefined
          throw error
        }
      }
      return Object.freeze({ sessions: Object.freeze(created.map(row => row.selection.sessionId)), dispose })
    } catch (error) {
      let cleanupFailed = false
      for (const row of created.reverse()) {
        try { await row.dispose() } catch { cleanupFailed = true }
      }
      // Never hide a failed compensating cleanup behind the original error.
      // The caller must treat the lifecycle as ambiguous and reconcile it.
      if (cleanupFailed) fail('pilot_dispose_failed')
      if (error instanceof WeKnoraPilotError) throw error
      fail('pilot_provision_failed')
    }
  }

  return Object.freeze({ createOne, createMany })
}

export const TEST_ONLY = Object.freeze({ selectionOf, fixedCode })
