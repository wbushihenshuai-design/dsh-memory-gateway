import assert from 'node:assert/strict'
import {apply} from './lib/gateway.mjs'
process.env.DSH_MEMORY_TEST_KEY='test-only'
for (const [kind,expected] of [['timeout','unknown:timeout-or-network'],['500','failed:http-500'],['queued','reconcile_pending'],['bad-json','unknown:invalid-response'],['accepted','persisting:unverified']]) {
 const handlers={};let seq=0;const events=[];const project=`test-${kind}`
 globalThis.fetch=async(url,opts)=>{
  assert.equal(JSON.parse(opts.body).project_id,project)
  if(url.endsWith('/search'))return {ok:false,status:503,json:async()=>({})}
  if(kind==='timeout')throw Error('network')
  if(kind==='bad-json')return {ok:true,json:async()=>{throw Error('json')}}
  if(kind==='500')return {ok:false,status:500,json:async()=>({})}
  if(kind==='queued')return {ok:false,status:502,json:async()=>({queued:true})}
  return {ok:true,json:async()=>({ok:true,facts_accepted:2})}
 }
 const ctx={on:(e,f)=>{(handlers[e]??=[]).push(f)},effect:()=>{}}
 apply(ctx,{enabled:true,recall:false,ingest:true,fallbackProjectId:project,memoryApiKeyEnv:'DSH_MEMORY_TEST_KEY',ingestBatchSize:1,ingestFlushMs:60000})
 const agent={session:{header:{id:kind},get seq(){return seq},snapshotEvents:(f,t)=>events.slice(f,t)}}
 handlers['agent/created'][0]({agent})
 events.push({type:'user/message',data:{content:[{type:'text',text:'A reusable confirmed operational finding'}]}});seq=1
 handlers['agent/assistant-stream'][0]({agent,frame:{type:'end',outcome:{kind:'committed'}}})
 await new Promise(r=>setTimeout(r,5))
 const status=ctx.agentMemoryGateway.status().sessions[0]
 assert.equal(status.ingestState,expected);assert.equal(status.retainedVerified,false)
 console.log(`PASS ingest-only first turn and ${kind}: ${expected}`)
}
