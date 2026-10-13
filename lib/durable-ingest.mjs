// Post-redaction only. Never persist raw client conversations in this module.
import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
export class DurableIngest {
  constructor({ directory, processBatch, reconcile, now = () => Date.now(), ttlMs = 7 * 86400000, maxEntries = 200, maxBytes = 8 * 1024 * 1024 }) {
    this.directory = directory; this.processBatch = processBatch; this.reconcile = reconcile; this.now = now; this.running = false
    this.ttlMs = Math.min(7 * 86400000, Math.max(1, ttlMs)); this.maxEntries = maxEntries; this.maxBytes = maxBytes
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  save(record) {
    const file = path.join(this.directory, record.id + '.json'); const tmp = file + '.' + randomUUID() + '.tmp'
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 }); renameSync(tmp, file)
  }
  get(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) return null
    try { return JSON.parse(readFileSync(path.join(this.directory, id + '.json'), 'utf8')) } catch { return null }
  }
  enqueue({ sanitizedMessages, projectId, source, redactionComplete }) {
    if (redactionComplete !== true) throw Error('redaction_required')
    if (typeof projectId !== 'string' || !/^[A-Za-z0-9._:-]{1,80}$/.test(projectId)) throw Error('project_required')
    if (!Array.isArray(sanitizedMessages) || !sanitizedMessages.length) throw Error('messages_required')
    const files = readdirSync(this.directory).filter(f => /^[a-f0-9]{64}\.json$/.test(f))
    const bytes = files.reduce((sum, file) => sum + statSync(path.join(this.directory, file)).size, 0)
    if (files.length >= this.maxEntries || bytes + Buffer.byteLength(JSON.stringify(sanitizedMessages)) > this.maxBytes) throw Error('queue_capacity_exceeded')
    const id = createHash('sha256').update(JSON.stringify({ projectId, source, sanitizedMessages })).digest('hex')
    const prior = this.get(id); if (prior) return this.status(prior)
    const record = { id, projectId, source, sanitizedMessages, state: 'queued', attempts: 0, createdAt: this.now(), nextAttemptAt: 0 }
    this.save(record); return this.status(record)
  }
  status(record) {
    if (!record) return null
    return { id: record.id, projectId: record.projectId, state: record.state, attempts: record.attempts, createdAt: record.createdAt, updatedAt: record.updatedAt || null, retainedVerified: record.state === 'retained' }
  }
  async sweep() {
    if (this.running) return
    this.running = true
    try {
      for (const file of readdirSync(this.directory).filter(f => /^[a-f0-9]{64}\.json$/.test(f))) {
        const r = this.get(file.slice(0,-5)); if (!r) continue
        if (this.now() - r.createdAt >= this.ttlMs) { unlinkSync(path.join(this.directory, file)); continue }
        // In-flight work at a crash is uncertain. Never blindly resend it.
        if (r.state === 'processing') { r.state = 'reconcile_pending'; r.updatedAt = this.now(); this.save(r); continue }
        if (['persisting','reconcile_pending'].includes(r.state) && this.reconcile) {
          try {
            const result = await this.reconcile(r)
            if (result?.retainedVerified === true) { r.state = 'retained'; delete r.sanitizedMessages; r.updatedAt = this.now(); this.save(r) }
          } catch { /* keep uncertain state; no blind replay */ }
          continue
        }
        if (r.state !== 'queued' || r.nextAttemptAt > this.now()) continue
        r.state = 'processing'; r.attempts++; r.updatedAt = this.now(); this.save(r)
        try {
          const result = await this.processBatch(r)
          r.state = result?.retainedVerified === true ? 'retained' : result?.rejected === true ? 'rejected' : result?.accepted === true ? 'persisting' : result?.retrySafe === true ? 'queued' : 'reconcile_pending'
          if (r.state === 'queued') r.nextAttemptAt = this.now() + Math.min(900000, 30000 * 2 ** Math.min(r.attempts,5))
          if (['retained','rejected'].includes(r.state)) delete r.sanitizedMessages
        } catch { r.state = 'reconcile_pending' }
        r.updatedAt = this.now(); this.save(r)
      }
    } finally { this.running = false }
  }
}
