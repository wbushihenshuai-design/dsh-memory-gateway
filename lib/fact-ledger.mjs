import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'

// Authority decisions and backend readback must be supplied by a trusted adapter.
export class FactLedger {
  constructor({directory,now=()=>new Date().toISOString()}){
    this.directory=directory
    this.now=now
    mkdirSync(directory,{recursive:true,mode:0o700})
    this.file=path.join(directory,'facts.json')
    try{this.rows=JSON.parse(readFileSync(this.file,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e;this.rows=[]}
  }
  
  save(){
    const temp=this.file+'.'+randomUUID()+'.tmp'
    writeFileSync(temp,JSON.stringify(this.rows),{mode:0o600})
    renameSync(temp,this.file)
  }
  
  // 权限控制增强：支持多角色和多项目授权
  validateAuthorization(authorization, projectId) {
    if (!authorization?.approved) return false
    if (authorization.role === 'admin') return true
    if (authorization.projectId && authorization.projectId !== projectId) return false
    if (authorization.allowedProjects && !authorization.allowedProjects.includes(projectId)) return false
    return true
  }
  
  publish({projectId,factKey,text,source,expiresAt=null,supersedes=null,correction=false,authorization,readback}) {
    if(!this.validateAuthorization(authorization, projectId)) throw Error('write_not_authorized')
    if(typeof text!=='string'||!text.trim()||typeof factKey!=='string'||!factKey)throw Error('invalid_fact')
    const digest=createHash('sha256').update(text).digest('hex')
    if(readback?.digest!==digest||readback?.projectId!==projectId||readback?.completed!==true)throw Error('readback_required')
    const existing=this.rows.find(r=>r.projectId===projectId&&r.factKey===factKey&&r.state==='retained')
    if(existing&&existing.digest===digest)return existing
    if(existing&&supersedes!==existing.id)throw Error('conflict_requires_explicit_supersedes')
    if(supersedes&&(!existing||existing.id!==supersedes))throw Error('invalid_supersedes')
    if(existing){existing.state=correction?'revoked':'superseded';existing.closedAt=this.now()}
    const row={id:randomUUID(),projectId,factKey,text,source,digest,expiresAt,state:'retained',createdAt:this.now(),supersedes,correction}
    this.rows.push(row);this.save();return row
  }
  
  recall(projectId){
    const now=this.now()
    return this.rows.filter(r=>r.projectId===projectId&&r.state==='retained'&&(!r.expiresAt||r.expiresAt>now))
  }
  
  // 保留期限自动清理：删除已过期的事实
  cleanupExpired(){
    const now=this.now()
    const before=this.rows.length
    this.rows=this.rows.filter(r=>!r.expiresAt||r.expiresAt>now)
    if(before!==this.rows.length){this.save();return{deleted:before-this.rows.length}}
    return null
  }
  
  // 获取即将过期的事实（用于预警）
  getExpiringSoon(ttlHours=24){
    const now=new Date(this.now())
    const threshold=new Date(now.getTime()+ttlHours*60*60*1000).toISOString()
    return this.rows.filter(r=>r.expiresAt&&r.expiresAt<=threshold&&r.expiresAt>now&&r.state==='retained')
  }
  
  daily(date,projectId){
    const changes=this.rows.filter(r=>r.projectId===projectId&&r.createdAt.slice(0,10)===date)
    return {
      date,projectId,
      confirmed:changes.filter(r=>r.state==='retained').map(r=>({id:r.id,factKey:r.factKey,text:r.text,source:r.source})),
      historical:changes.filter(r=>r.state!=='retained').map(r=>({id:r.id,state:r.state,factKey:r.factKey})),
      note:'仅包含已回读事实；不等于当天所有工作均已完成'
    }
  }
}
