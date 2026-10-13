import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'

/**
 * 智能知识图谱 - 实现跨领域、跨项目的关联记忆
 * 核心功能：
 * 1. 不依赖 project_id 的软性过滤
 * 2. 自动提取学习模式和成功策略
 * 3. 基于标签和语义的关联检索
 */
export class KnowledgeGraph {
  constructor({ directory, now = () => new Date().toISOString() }) {
    this.directory = directory
    this.now = now
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    
    this.nodesFile = path.join(directory, 'nodes.json')
    this.edgesFile = path.join(directory, 'edges.json')
    
    try {
      this.nodes = JSON.parse(readFileSync(this.nodesFile, 'utf8'))
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
      this.nodes = []
    }
    
    try {
      this.edges = JSON.parse(readFileSync(this.edgesFile, 'utf8'))
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
      this.edges = []
    }
  }
  
  saveNodes() {
    const temp = this.nodesFile + '.' + randomUUID() + '.tmp'
    writeFileSync(temp, JSON.stringify(this.nodes), { mode: 0o600 })
    renameSync(temp, this.nodesFile)
  }
  
  saveEdges() {
    const temp = this.edgesFile + '.' + randomUUID() + '.tmp'
    writeFileSync(temp, JSON.stringify(this.edges), { mode: 0o600 })
    renameSync(temp, this.edgesFile)
  }
  
  /**
   * 添加节点（可以是事实、模式、策略等）
   * @param {Object} node - 节点数据
   * @param {string} node.type - 节点类型：'fact', 'pattern', 'strategy', 'lesson', 'meta-learning'
   * @param {string} node.content - 内容文本
   * @param {string[]} node.tags - 标签数组（用于关联检索）
   * @param {string} node.context - 上下文信息（会话 ID、项目等）
   * @param {Object} node.metadata - 元数据（难度、成功率、适用领域等）
   */
  addNode(node) {
    const id = createHash('sha256').update(node.content + node.type).digest('hex').slice(0, 32)
    const existing = this.nodes.find(n => n.id === id)
    
    if (existing) {
      // 更新现有节点
      existing.updatedAt = this.now()
      existing.tagSet = new Set([...(existing.tagSet || []), ...node.tags])
      return existing
    }
    
    const newNode = {
      id,
      type: node.type,
      content: node.content,
      tags: node.tags || [],
      tagSet: new Set(node.tags || []),
      context: node.context || {},
      metadata: node.metadata || {},
      createdAt: this.now(),
      updatedAt: this.now(),
      usageCount: 0,
      successScore: 0,
    }
    
    this.nodes.push(newNode)
    this.saveNodes()
    return newNode
  }
  
  /**
   * 创建节点间的关联
   * @param {Object} edge - 边数据
   * @param {string} edge.source - 源节点 ID
   * @param {string} edge.target - 目标节点 ID
   * @param {string} edge.relation - 关系类型：'similar-to', 'solves', 'builds-on', 'contradicts', 'inspired-by'
   * @param {Object} edge.metadata - 边的元数据（置信度、时间等）
   */
  addEdge(edge) {
    const id = createHash('sha256').update(edge.source + edge.target + edge.relation).digest('hex').slice(0, 32)
    
    const existing = this.edges.find(e => e.id === id)
    if (existing) return existing
    
    const newEdge = {
      id,
      source: edge.source,
      target: edge.target,
      relation: edge.relation,
      metadata: edge.metadata || {},
      createdAt: this.now(),
    }
    
    this.edges.push(newEdge)
    this.saveEdges()
    return newEdge
  }
  
  /**
   * 基于标签和上下文的智能检索
   * 不强制要求 project_id 匹配，而是根据标签相似度推荐
   * @param {Object} query - 查询条件
   * @param {string[]} query.tags - 标签过滤
   * @param {string} query.contextType - 上下文类型（session/project/domain）
   * @param {string} query.contextValue - 上下文值
   * @param {number} query.limit - 返回数量限制
   * @param {string} query.nodeType - 节点类型过滤
   */
  search({ tags = [], contextType = null, contextValue = null, limit = 20, nodeType = null }) {
    let results = this.nodes.filter(n => n.state !== 'revoked')
    
    // 按节点类型过滤
    if (nodeType) {
      results = results.filter(n => n.type === nodeType)
    }
    
    // 按标签过滤（至少匹配一个标签）
    if (tags.length > 0) {
      results = results.filter(n => 
        n.tags.some(tag => tags.includes(tag))
      )
    }
    
    // 按上下文过滤（软性匹配）
    if (contextType && contextValue) {
      results = results.filter(n => {
        const ctx = n.context || {}
        // 如果节点的上下文包含查询的值，或者节点没有特定上下文（全局知识）
        return ctx[contextType] === contextValue || !ctx[contextType]
      })
    }
    
    // 按使用频率和成功分数排序
    results.sort((a, b) => {
      const scoreA = (a.usageCount || 0) * 0.3 + (a.successScore || 0) * 0.7
      const scoreB = (b.usageCount || 0) * 0.3 + (b.successScore || 0) * 0.7
      return scoreB - scoreA
    })
    
    return results.slice(0, limit).map(n => ({
      id: n.id,
      type: n.type,
      content: n.content,
      tags: Array.from(n.tagSet),
      context: n.context,
      metadata: n.metadata,
      relevanceScore: this._calculateRelevance(n, tags, contextType, contextValue),
    }))
  }
  
  _calculateRelevance(node, queryTags, contextType, contextValue) {
    let score = 0
    
    // 标签匹配加分
    queryTags.forEach(tag => {
      if (node.tagSet.has(tag)) score += 2
    })
    
    // 上下文匹配加分
    if (contextType && contextValue) {
      const ctx = node.context || {}
      if (ctx[contextType] === contextValue) score += 1
      else if (!ctx[contextType]) score += 0.5 // 全局知识也有一定相关性
    }
    
    // 成功分数加分
    score += (node.successScore || 0) * 0.1
    
    return score
  }
  
  /**
   * 发现相似模式（用于跨领域知识迁移）
   * @param {string} problemDescription - 问题描述
   * @param {string} currentDomain - 当前领域
   */
  findSimilarPatterns(problemDescription, currentDomain) {
    // 简单版本：基于关键词匹配
    const keywords = problemDescription.split(/[\s,。！？]+/).filter(w => w.length > 2)
    
    const candidates = this.nodes.filter(n => 
      n.type === 'pattern' || n.type === 'strategy'
    )
    
    const matches = candidates.map(node => {
      const textWords = node.content.split(/[\s,。！？]+/)
      const commonWords = keywords.filter(w => textWords.includes(w))
      const tagMatches = node.tags.filter(t => 
        t.includes(currentDomain) || t.includes('cross-domain')
      ).length
      
      return {
        node,
        similarity: commonWords.length + tagMatches * 2,
      }
    }).filter(m => m.similarity > 0)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5)
    
    return matches.map(m => ({
      ...m.node,
      similarity: m.similarity,
    }))
  }
  
  /**
   * 记录模式使用情况（用于提升成功模式的权重）
   */
  recordUsage(nodeId, success = true) {
    const node = this.nodes.find(n => n.id === nodeId)
    if (!node) return
    
    node.usageCount = (node.usageCount || 0) + 1
    if (success) {
      node.successScore = (node.successScore || 0) + 1
    } else {
      node.successScore = Math.max(0, (node.successScore || 0) - 0.5)
    }
    
    node.lastUsed = this.now()
    this.saveNodes()
  }
  
  /**
   * 导出知识图谱统计
   */
  getStatistics() {
    const byType = {}
    this.nodes.forEach(n => {
      byType[n.type] = (byType[n.type] || 0) + 1
    })
    
    const topPatterns = this.nodes
      .filter(n => n.type === 'pattern' || n.type === 'strategy')
      .sort((a, b) => (b.successScore || 0) - (a.successScore || 0))
      .slice(0, 10)
      .map(n => ({
        id: n.id,
        content: n.content.substring(0, 100) + '...',
        successScore: n.successScore || 0,
        usageCount: n.usageCount || 0,
      }))
    
    return {
      totalNodes: this.nodes.length,
      byType,
      topPatterns,
      totalEdges: this.edges.length,
    }
  }
}
