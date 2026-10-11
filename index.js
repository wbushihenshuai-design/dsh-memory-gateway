// dsh-memory-gateway — unified memory plugin for the DSH web profile (was three plugins).
//
// Subsystems (each keeps its own standalone contract; one failing activation never
// takes down the others):
//   1. gateway — instant session memory via the local memory-gateway: system-prompt
//      recall + batched ingest from session events. lib/gateway.mjs  (fail-open)
//   2. pilot   — fail-closed WeKnora knowledge-base memory pilot bound to exactly one
//      workspace/project/principal/policy; queue-driven, can only narrow scope.
//      lib/pilot.mjs  (fail-closed by design)
//   3. sidebar — retained WeKnora web panel in the DSH right sidebar; rendered entirely
//      by the client half (client.js). The host half is intentionally a no-op, so the
//      launcher appears whenever the bundle is installed.
//
// Config shape (profile cordis.patch.yml row):
//   config:
//     gateway: { enabled: true, ... }   # gateway subsystem switch nested here
//     pilot:   { enabled: true, ... }   # full pilot host policy nested here
//
// History note (2026-10-11 incident, E-085): never register plain listeners on
// dispatch.waterfall hooks (agent/request etc.) — returning undefined there clobbers
// the request config and kills every session. Listeners on waterfall values MUST
// return the value (or next()’s result).
export const name = 'dsh-memory-gateway'

// pilot 需要的服务注入清单（gateway 侧无需）
export const inject = ['deepseekAccount', 'workspaceRegistry', 'agents', 'agentPresets', 'agentDefaultModel']

import { apply as applyGateway } from './lib/gateway.mjs'
import { apply as applyPilot } from './lib/pilot.mjs'

export function apply(ctx, input = {}) {
  const cfg = input && typeof input === 'object' ? input : {}
  const logger = ctx?.logger

  try {
    if (cfg.gateway && typeof cfg.gateway === 'object') applyGateway(ctx, cfg.gateway)
  } catch {
    logger?.warn?.('dsh-memory-gateway: gateway subsystem activation failed — stays off')
  }

  try {
    if (cfg.pilot && typeof cfg.pilot === 'object') applyPilot(ctx, cfg.pilot)
  } catch {
    logger?.warn?.('dsh-memory-gateway: pilot subsystem activation failed — stays off')
  }

  logger?.info?.(`dsh-memory-gateway: bundle applied (gateway=${cfg.gateway ? 'configured' : 'absent'} pilot=${cfg.pilot ? 'configured' : 'absent'})`)
}
