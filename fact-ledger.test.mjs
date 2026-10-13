import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {FactLedger} from './lib/fact-ledger.mjs'
const directory=mkdtempSync(path.join(tmpdir(),'fact-ledger-'))
try{
 const now=()=> '2026-10-12T13:00:00.000Z'
 const ledger=new FactLedger({directory,now})
 const input=text=>({projectId:'project-a',factKey:'dsh.runtime.service',text,source:{sessionId:'a',evidence:'mock-test'},authorization:{approved:true,projectId:'project-a'},readback:{completed:true,projectId:'project-a',digest:createHash('sha256').update(text).digest('hex')}})
 assert.throws(()=>ledger.publish({...input('old'),readback:null}),/readback_required/)
 assert.throws(()=>ledger.publish({...input('old'),authorization:{approved:true,projectId:'other'}}),/not_authorized/)
 const old=ledger.publish(input('old'));assert.equal(ledger.publish(input('old')).id,old.id)
 assert.throws(()=>ledger.publish(input('new')),/conflict_requires/)
 const changed=ledger.publish({...input('new'),supersedes:old.id})
 assert.equal(old.state,'superseded');assert.equal(ledger.recall('project-a')[0].id,changed.id);assert.equal(ledger.recall('other').length,0)
 const corrected=ledger.publish({...input('corrected'),supersedes:changed.id,correction:true})
 assert.equal(changed.state,'revoked');assert.equal(ledger.recall('project-a')[0].id,corrected.id)
 assert.equal(ledger.daily('2026-10-12','project-a').confirmed.length,1)
 assert.equal(new FactLedger({directory,now}).recall('project-a')[0].id,corrected.id)
 console.log('PASS authorized readback gate, version replacement, correction revocation, scoped recall, daily summary, restart')
}finally{rmSync(directory,{recursive:true,force:true})}
