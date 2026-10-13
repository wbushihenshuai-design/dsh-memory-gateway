import assert from 'node:assert/strict'
import { apply } from './lib/gateway.mjs'
process.env.DSH_MEMORY_TEST_KEY='test-only'
const handlers={};const requests=[]
const originalFetch=globalThis.fetch
let seq=0; const events=[]
const agent={session:{header:{id:'test-session',cwd:process.cwd()},get seq(){return seq},snapshotEvents:(from,to)=>events.slice(from,to)}}
globalThis.fetch=async(url,opts)=>{requests.push({url,body:JSON.parse(opts.body)});return {ok:true,json:async()=>url.endsWith('/search')?{results:[]}:{ok:true,facts_accepted:1}}}
const ctx={on:(e,f)=>{(handlers[e]??=[]).push(f)}}
apply(ctx,{enabled:true,recall:true,ingest:true,fallbackProjectId:'personal-workspace',memoryApiKeyEnv:'DSH_MEMORY_TEST_KEY',ingestBatchSize:1,ingestFlushMs:60000})
handlers['agent/created'][0]({agent})
events.push({type:'user/message',data:{content:[{type:'text',text:'A verified reusable operational conclusion.'}]}});seq=1
handlers['agent/assistant-stream'][0]({agent,frame:{type:'end',outcome:{kind:'committed'}}})
await new Promise(r=>setTimeout(r,10))
const base=Object.freeze({sections:Object.freeze([]),sentinel:42});let nextCalls=0
const result=await handlers['system-prompt/assemble'][0](null,{agent},async()=>{nextCalls++;return base})
assert.equal(nextCalls,1);assert.equal(result.sentinel,42);assert.ok(result.sections[0].text.includes('personal-workspace'))
assert.ok(result.sections[0].text.includes('persisting:unverified'))
assert.ok(requests.some(r=>r.url.endsWith('/ingest')))
assert.ok(requests.every(r=>r.body.project_id==='personal-workspace'))
assert.equal(ctx.agentMemoryGateway.status().sessions[0].retainedVerified,false)
assert.equal(handlers['agent/pre-step'],undefined)
// The exact status route rejects unauthenticated callers before projecting data.
let route
const routeCtx={on:(e,f)=>{},inject:(deps,fn)=>fn({connection:{requestRejection:req=>req.auth?undefined:401},webServer:{register:r=>{route=r}},effect:f=>f()})}
apply(routeCtx,{enabled:true,recall:false,ingest:true,fallbackProjectId:'personal-workspace',memoryApiKeyEnv:'DSH_MEMORY_TEST_KEY',ingestFlushMs:60000})
let code,body
const response={writeHead:c=>{code=c},end:v=>{body=v}}
route.handler({method:'GET',url:'/api/memory-gateway/status',auth:false},response)
assert.equal(code,401);assert.equal(body,undefined)
route.handler({method:'GET',url:'/api/memory-gateway/status',auth:true},response)
assert.equal(code,200);assert.equal(JSON.parse(body).enabled,true)
globalThis.fetch=originalFetch
console.log('PASS fallback attribution, first-turn capture, frozen waterfall, honest persistence state')
