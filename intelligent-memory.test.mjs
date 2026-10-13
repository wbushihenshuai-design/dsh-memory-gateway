import { KnowledgeGraph } from './lib/knowledge-graph.mjs'
import { PatternExtractor } from './lib/pattern-extractor.mjs'
import { FactLedger } from './lib/fact-ledger.mjs'
import { describe, it, beforeAll, afterAll, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import path from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'

const TEST_DIR = './test-output/intelligent-memory'

// Mock LLM client for pattern extraction
class MockLLMClient {
  async chat() {
    return {
      choices: [{
        message: {
          content: JSON.stringify({
            patterns: [
              {
                description: "当遇到复杂问题时，先拆解为小步骤，逐步验证每个环节",
                tags: ["problem-solving", "decomposition", "cross-domain"],
                confidence: 0.9,
                applicability: ["math", "programming", "debugging"]
              }
            ]
          })
        }
      }]
    }
  }
}

describe('智能记忆系统 - 方案 B', () => {
  let knowledgeGraph, factLedger
  
  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true })
  })
  
  afterAll(() => {
    // 清理测试数据
    try {
      rmSync(TEST_DIR, { recursive: true, force: true })
    } catch (e) {
      console.warn('Failed to clean test dir:', e.message)
    }
  })
  
  beforeEach(() => {
    knowledgeGraph = new KnowledgeGraph({ directory: path.join(TEST_DIR, 'knowledge-graph') })
    factLedger = new FactLedger({ directory: path.join(TEST_DIR, 'fact-ledger') })
  })
  
  describe('知识图谱基础功能', () => {
    it('应该能添加节点并检索', () => {
      const node = knowledgeGraph.addNode({
        type: 'pattern',
        content: '当遇到复杂问题时，先拆解为小步骤，逐步验证每个环节',
        tags: ['problem-solving', 'decomposition'],
        context: { project_id: 'test-project' },
        metadata: { confidence: 0.9 }
      })
      
      assert.ok(node.id)
      assert.equal(node.type, 'pattern')
      assert.ok(node.tagSet.has('problem-solving'))
      
      const results = knowledgeGraph.search({ tags: ['problem-solving'] })
      assert.equal(results.length, 1)
      assert.equal(results[0].id, node.id)
    })
    
    it('应该支持跨项目检索（软性过滤）', () => {
      // 添加全局知识（无特定项目上下文）
      knowledgeGraph.addNode({
        type: 'strategy',
        content: '调试时优先检查边界条件和异常处理',
        tags: ['debugging', 'best-practice'],
        context: {}, // 全局知识
        metadata: {}
      })
      
      // 添加项目 A 的知识
      knowledgeGraph.addNode({
        type: 'lesson',
        content: '项目 A 中遇到过内存泄漏问题',
        tags: ['memory-leak', 'project-a'],
        context: { project_id: 'project-a' },
        metadata: {}
      })
      
      // 在项目中检索全局知识
      const results = knowledgeGraph.search({ 
        tags: ['debugging'],
        contextType: 'project_id',
        contextValue: 'project-b'
      })
      
      // 应该能找到全局知识
      assert.ok(results.some(r => r.content.includes('边界条件')))
    })
    
    it('应该能记录模式使用情况并更新权重', () => {
      const node = knowledgeGraph.addNode({
        type: 'pattern',
        content: '单元测试应先写失败用例再写成功用例',
        tags: ['testing', 'tdd'],
        context: {},
        metadata: {}
      })
      
      // 初始状态
      assert.equal(node.usageCount, 0)
      assert.equal(node.successScore, 0)
      
      // 记录成功使用
      knowledgeGraph.recordUsage(node.id, true)
      const updated1 = knowledgeGraph.nodes.find(n => n.id === node.id)
      assert.equal(updated1.usageCount, 1)
      assert.equal(updated1.successScore, 1)
      
      // 记录失败使用
      knowledgeGraph.recordUsage(node.id, false)
      const updated2 = knowledgeGraph.nodes.find(n => n.id === node.id)
      assert.equal(updated2.usageCount, 2)
      assert.equal(updated2.successScore, 0.5)
    })
    
    it('应该按成功分数和使用频率排序', () => {
      // 添加多个模式
      knowledgeGraph.addNode({
        type: 'pattern',
        content: '方法 A - 低分低频',
        tags: ['test'],
        context: {},
        metadata: {}
      })
      
      knowledgeGraph.addNode({
        type: 'pattern',
        content: '方法 B - 高分高频',
        tags: ['test'],
        context: {},
        metadata: {}
      })
      
      const highScoreNode = knowledgeGraph.nodes[knowledgeGraph.nodes.length - 1]
      highScoreNode.successScore = 10
      highScoreNode.usageCount = 10
      
      const results = knowledgeGraph.search({ tags: ['test'], limit: 10 })
      
      // 高分高频的应该排在前面
      assert.equal(results[0].content, '方法 B - 高分高频')
    })
  })
  
  describe('模式提取器', () => {
    it('应该能从对话中提取成功模式', async () => {
      const extractor = new PatternExtractor({ llmClient: new MockLLMClient() })
      
      const messages = [
        { role: 'user', content: '遇到了一个复杂的 bug，很难定位' },
        { role: 'assistant', content: '我建议你先拆解问题：1) 复现步骤 2) 检查边界条件 3) 逐步验证' },
        { role: 'user', content: '按照你的方法，我成功找到了问题所在！解决了。' }
      ]
      
      const patterns = await extractor.extractPatterns(messages, { session_id: 'test-session' })
      
      assert.ok(Array.isArray(patterns))
      assert.ok(patterns.length > 0)
      assert.ok(patterns[0].type === 'pattern')
      assert.ok(patterns[0].tags.includes('cross-domain'))
    })
    
    it('应该生成模式摘要', () => {
      const extractor = new PatternExtractor({ llmClient: new MockLLMClient() })
      
      const patterns = [
        { type: 'pattern', content: '测试内容 1', tags: ['tag1', 'tag2'] },
        { type: 'lesson', content: '教训内容', tags: ['tag1', 'tag3'] },
        { type: 'strategy', content: '策略内容', tags: ['tag2', 'tag4'] }
      ]
      
      const summary = extractor.generateSummary(patterns)
      
      assert.equal(summary.totalPatterns, 3)
      assert.equal(summary.byType.pattern, 1)
      assert.equal(summary.byType.lesson, 1)
      assert.equal(summary.byType.strategy, 1)
      assert.ok(summary.topTags.length > 0)
    })
  })
  
  describe('跨领域知识迁移', () => {
    it('应该能发现相似模式', () => {
      // 添加数学问题的解决模式
      knowledgeGraph.addNode({
        type: 'pattern',
        content: '解复杂方程时，先化简表达式再逐步求解',
        tags: ['math', 'problem-solving', 'cross-domain'],
        context: { domain: 'mathematics' },
        metadata: {}
      })
      
      // 添加编程问题的解决模式
      knowledgeGraph.addNode({
        type: 'pattern',
        content: '调试复杂代码时，先简化逻辑再逐步排查',
        tags: ['programming', 'problem-solving', 'cross-domain'],
        context: { domain: 'programming' },
        metadata: {}
      })
      
      // 模拟新的地理问题
      const similarPatterns = knowledgeGraph.findSimilarPatterns(
        '分析复杂数据关系时，先分解成小部分再整合',
        'geography'
      )
      
      // 应该找到相似的 problem-solving 模式
      assert.ok(similarPatterns.length >= 1)
      assert.ok(similarPatterns.some(p => p.tags.includes('problem-solving')))
    })
    
    it('应该支持多标签关联检索', () => {
      knowledgeGraph.addNode({
        type: 'strategy',
        content: '系统性解决问题的框架',
        tags: ['systematic-thinking', 'problem-solving', 'methodology'],
        context: {},
        metadata: {}
      })
      
      // 使用多个标签检索
      const results = knowledgeGraph.search({ 
        tags: ['systematic-thinking', 'debugging'],
        limit: 10
      })
      
      // 应该能找到匹配 systematic-thinking 的结果
      assert.ok(results.length > 0)
      assert.ok(results[0].tags.includes('systematic-thinking'))
    })
  })
  
  describe('与事实账本的集成', () => {
    it('应该能在事实持久化后同步到知识图谱', () => {
      // 模拟从事实账本提取知识
      const fact = {
        projectId: 'test-project',
        factKey: 'learning-pattern-1',
        text: '遇到问题时，先收集信息再分析原因最后制定解决方案',
        source: { type: 'session', id: 'session-123' },
        expiresAt: null
      }
      
      // 发布到事实账本
      const ledgerResult = factLedger.publish({
        ...fact,
        authorization: { approved: true, role: 'admin' },
        readback: { digest: 'mock-digest', projectId: fact.projectId, completed: true }
      })
      
      assert.ok(ledgerResult)
      assert.equal(ledgerResult.state, 'retained')
      
      // 同步到知识图谱
      knowledgeGraph.addNode({
        type: 'pattern',
        content: fact.text,
        tags: ['problem-solving', 'methodology'],
        context: { project_id: fact.projectId },
        metadata: { sourceFactId: ledgerResult.id }
      })
      
      // 验证知识图谱中有数据
      const graphResults = knowledgeGraph.search({ tags: ['problem-solving'] })
      assert.ok(graphResults.length > 0)
    })
  })
})

console.log('\n=== 智能记忆系统测试套件已准备就绪 ===\n')
