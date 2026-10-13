import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import {DurableIngest} from './lib/durable-ingest.mjs'
const directory=mkdtempSync(path.join(tmpdir(),'dsh-memory-queue-'))
try {
 let calls=0
 let queue=new DurableIngest({directory,processBatch:async()=>{calls++;return {accepted:true}}})
 const input={projectId:'personal-workspace',source:{thread:'a'},sanitizedMessages:[{role:'assistant',content:'A verified fact without secrets'}],redactionComplete:true}
 assert.throws(()=>queue.enqueue({...input,redactionComplete:false}),/redaction_required/)
 const a=queue.enqueue(input);assert.equal(a.state,'queued');assert.equal(queue.enqueue(input).id,a.id)
 assert.notEqual(queue.enqueue({...input,projectId:'project-b'}).id,a.id)
 await queue.sweep();assert.equal(queue.status(queue.get(a.id)).state,'persisting');assert.equal(queue.status(queue.get(a.id)).retainedVerified,false)
 queue=new DurableIngest({directory,processBatch:async()=>{throw Error('must not resend')}})
 await queue.sweep();assert.equal(calls,2)
 const b=queue.enqueue({...input,source:{thread:'crashed'}})
 const record=queue.get(b.id);record.state='processing';queue.save(record)
 await queue.sweep();assert.equal(queue.get(b.id).state,'reconcile_pending')
 assert.equal('sanitizedMessages' in queue.status(queue.get(a.id)),false)
 queue=new DurableIngest({directory,processBatch:async()=>{throw Error('no replay')},reconcile:async record=>({retainedVerified:record.id===a.id})})
 await queue.sweep()
 assert.equal(queue.get(a.id).state,'retained');assert.equal(queue.get(a.id).sanitizedMessages,undefined)
 assert.equal(queue.get(b.id).state,'reconcile_pending')
 let clock=1000
 const bounded=new DurableIngest({directory:path.join(directory,'bounded'),now:()=>clock,ttlMs:100,maxEntries:1,processBatch:async()=>({accepted:true})})
 const item=bounded.enqueue(input)
 assert.equal(bounded.enqueue(input).id,item.id)
 assert.throws(()=>bounded.enqueue({...input,source:{thread:'overflow'}}),/capacity_exceeded/)
 clock=1101;await bounded.sweep();assert.equal(bounded.get(item.id),null)
 console.log('PASS durable restart, scoped dedupe, redaction gate, no blind replay, metadata-only status')
}finally{rmSync(directory,{recursive:true,force:true})}
