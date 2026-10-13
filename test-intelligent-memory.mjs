import { KnowledgeGraph } from './lib/knowledge-graph.mjs'
import { PatternExtractor } from './lib/pattern-extractor.mjs'
import { FactLedger } from './lib/fact-ledger.mjs'
import path from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'

const TEST_DIR = './test-output/intelligent-memory'

// Mock LLM client for pattern extraction
class MockLLMClient {
  chat = {
    completions: {
      create: async () => ({
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
              ],
              lessons: [],
              strategies: []
            })
          }
        }]
      })
    }
  }
}

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`✅ ${name}`)
    passed++
  } catch (error) {
    console.error(`❌ ${name}`)
    console.error(`   Error: ${error.message}`)
    failed++
  }
}

console.log('\n🧪 智能记忆系统测试 - 方案 B\n')

try {
  mkdirSync(TEST_DIR, { recursive: true })
  
  // 测试 1: 知识图谱基础功能
  console.log('\n--- 测试 1: 知识图谱基础功能 ---')
  
  const kg1 = new KnowledgeGraph({ directory: path.join(TEST_DIR, 'kg1') })
  
  test('应该能添加节点并检索', () => {
    const node = kg1.addNode({
      type: 'pattern',
      content: '当遇到复杂问题时，先拆解为小步骤，逐步验证每个环节',
      tags: ['problem-solving', 'decomposition'],
      context: { project_id: 'test-project' },
      metadata: { confidence: 0.9 }
    })
    
    if (!node.id) throw new Error('Node ID is missing')
    if (node.type !== 'pattern') throw new Error('Node type mismatch')
    if (!node.tagSet.has('problem-solving')) throw new Error('Tag not found')
    
    const results = kg1.search({ tags: ['problem-solving'] })
    if (results.length !== 1) throw new Error(`Expected 1 result, got ${results.length}`)
    if (results[0].id !== node.id) throw new Error('Result ID mismatch')
  })
  
  test('应该支持跨项目检索（软性过滤）', () => {
    const kg2 = new KnowledgeGraph({ directory: path.join(TEST_DIR, 'kg2') })
    
    // 添加全局知识（无特定项目上下文）
    kg2.addNode({
      type: 'strategy',
      content: '调试时优先检查边界条件和异常处理',
      tags: ['debugging', 'best-practice'],
      context: {}, // 全局知识
      metadata: {}
    })
    
    // 添加项目 A 的知识
    kg2.addNode({
      type: 'lesson',
      content: '项目 A 中遇到过内存泄漏问题',
      tags: ['memory-leak', 'project-a'],
      context: { project_id: 'project-a' },
      metadata: {}
    })
    
    // 在项目中检索全局知识
    const results = kg2.search({ 
      tags: ['debugging'],
      contextType: 'project_id',
      contextValue: 'project-b'
    })
    
    const hasGlobalKnowledge = results.some(r => r.content.includes('边界条件'))
    if (!hasGlobalKnowledge) throw new Error('Global knowledge not found in cross-project search')
  })
  
  test('应该能记录模式使用情况并更新权重', () => {
    const kg3 = new KnowledgeGraph({ directory: path.join(TEST_DIR, 'kg3') })
    
    const node = kg3.addNode({
      type: 'pattern',
      content: '单元测试应先写失败用例再写成功用例',
      tags: ['testing', 'tdd'],
      context: {},
      metadata: {}
    })
    
    if (node.usageCount !== 0) throw new Error('Initial usageCount should be 0')
    if (node.successScore !== 0) throw new Error('Initial successScore should be 0')
    
    kg3.recordUsage(node.id, true)
    const updated1 = kg3.nodes.find(n => n.id === node.id)
    if (updated1.usageCount !== 1) throw new Error('Usage count should be 1 after first use')
    if (updated1.successScore !== 1) throw new Error('Success score should be 1 after success')
    
    kg3.recordUsage(node.id, false)
    const updated2 = kg3.nodes.find(n => n.id === node.id)
    if (updated2.usageCount !== 2) throw new Error('Usage count should be 2 after second use')
    if (updated2.successScore !== 0.5) throw new Error('Success score should be 0.5 after failure')
  })
  
  test('应该按成功分数和使用频率排序', () => {
    const kg4 = new KnowledgeGraph({ directory: path.join(TEST_DIR, 'kg4') })
    
    kg4.addNode({
      type: 'pattern',
      content: '方法 A - 低分低频',
      tags: ['test'],
      context: {},
      metadata: {}
    })
    
    kg4.addNode({
      type: 'pattern',
      content: '方法 B - 高分高频',
      tags: ['test'],
      context: {},
      metadata: {}
    })
    
    const highScoreNode = kg4.nodes[kg4.nodes.length - 1]
    highScoreNode.successScore = 10
    highScoreNode.usageCount = 10
    
    const results = kg4.search({ tags: ['test'], limit: 10 })
    
    if (results[0].content !== '方法 B - 高分高频') {
      throw new Error('High-score node should be ranked first')
    }
  })
  
  // 测试 2: 模式提取器
  console.log('\n--- 测试 2: 模式提取器 ---')
  
  const extractor = new PatternExtractor({ llmClient: new MockLLMClient() })
  
  test('应该能从对话中提取成功模式', async () => {
    const messages = [
      { role: 'user', content: '遇到了一个复杂的 bug，很难定位' },
      { role: 'assistant', content: '我建议你先拆解问题：1) 复现步骤 2) 检查边界条件 3) 逐步验证' },
      { role: 'user', content: '按照你的方法，我成功找到了问题所在！解决了。' }
    ]
    
    const patterns = await extractor.extractPatterns(messages, { session_id: 'test-session' })
    
    if (!Array.isArray(patterns)) throw new Error('Patterns should be an array')
    if (patterns.length === 0) throw new Error('Should extract at least one pattern')
    if (patterns[0].type !== 'pattern') throw new Error('Pattern type mismatch')
    if (!patterns[0].tags.includes('cross-domain')) throw new Error('Missing cross-domain tag')
  })
  
  test('应该生成模式摘要', () => {
    const patterns = [
      { type: 'pattern', content: '测试内容 1', tags: ['tag1', 'tag2'] },
      { type: 'lesson', content: '教训内容', tags: ['tag1', 'tag3'] },
      { type: 'strategy', content: '策略内容', tags: ['tag2', 'tag4'] }
    ]
    
    const summary = extractor.generateSummary(patterns)
    
    if (summary.totalPatterns !== 3) throw new Error(`Total patterns should be 3, got ${summary.totalPatterns}`)
    if (summary.byType.pattern !== 1) throw new Error('Pattern count mismatch')
    if (summary.byType.lesson !== 1) throw new Error('Lesson count mismatch')
    if (summary.topTags.length === 0) throw new Error('Top tags should not be empty')
  })
  
  // 测试 3: 跨领域知识迁移
  console.log('\n--- 测试 3: 跨领域知识迁移 ---')
  
  const kg5 = new KnowledgeGraph({ directory: path.join(TEST_DIR, 'kg5') })
  
  test('应该能发现相似模式', () => {
    // 添加数学问题的解决模式
    kg5.addNode({
      type: 'pattern',
      content: '解复杂方程时，先化简表达式再逐步求解',
      tags: ['math', 'problem-solving', 'cross-domain'],
      context: { domain: 'mathematics' },
      metadata: {}
    })
    
    // 添加编程问题的解决模式
    kg5.addNode({
      type: 'pattern',
      content: '调试复杂代码时，先简化逻辑再逐步排查',
      tags: ['programming', 'problem-solving', 'cross-domain'],
      context: { domain: 'programming' },
      metadata: {}
    })
    
    // 模拟新的地理问题
    const similarPatterns = kg5.findSimilarPatterns(
      '分析复杂数据关系时，先分解成小部分再整合',
      'geography'
    )
    
    if (similarPatterns.length < 1) throw new Error('Should find similar patterns')
    if (!similarPatterns.some(p => p.tags.includes('problem-solving'))) {
      throw new Error('Should find problem-solving patterns')
    }
  })
  
  test('应该支持多标签关联检索', () => {
    const kg6 = new KnowledgeGraph({ directory: path.join(TEST_DIR, 'kg6') })
    
    kg6.addNode({
      type: 'strategy',
      content: '系统性解决问题的框架',
      tags: ['systematic-thinking', 'problem-solving', 'methodology'],
      context: {},
      metadata: {}
    })
    
    const results = kg6.search({ 
      tags: ['systematic-thinking', 'debugging'],
      limit: 10
    })
    
    if (results.length === 0) throw new Error('Should find matching results')
    if (!results[0].tags.includes('systematic-thinking')) {
      throw new Error('Should match systematic-thinking tag')
    }
  })
  
  // 测试 4: 与事实账本的集成
  console.log('\n--- 测试 4: 与事实账本集成 ---')
  
  const ledger = new FactLedger({ directory: path.join(TEST_DIR, 'ledger') })
  const kg7 = new KnowledgeGraph({ directory: path.join(TEST_DIR, 'kg7') })
  
  test('应该能在事实持久化后同步到知识图谱', () => {
    const fact = {
      projectId: 'test-project',
      factKey: 'learning-pattern-1',
      text: '遇到问题时，先收集信息再分析原因最后制定解决方案',
      source: { type: 'session', id: 'session-123' },
      expiresAt: null
    }
    
    // 计算正确的 digest
    const digest = createHash('sha256').update(fact.text).digest('hex')
    
    const ledgerResult = ledger.publish({
      ...fact,
      authorization: { approved: true, role: 'admin' },
      readback: { digest, projectId: fact.projectId, completed: true }
    })
    
    if (!ledgerResult) throw new Error('Ledger publish failed')
    if (ledgerResult.state !== 'retained') throw new Error('Fact should be retained')
    
    kg7.addNode({
      type: 'pattern',
      content: fact.text,
      tags: ['problem-solving', 'methodology'],
      context: { project_id: fact.projectId },
      metadata: { sourceFactId: ledgerResult.id }
    })
    
    const graphResults = kg7.search({ tags: ['problem-solving'] })
    if (graphResults.length === 0) throw new Error('Knowledge graph should have data')
  })
  
  // 清理
  rmSync(TEST_DIR, { recursive: true, force: true })
  
  // 输出结果
  console.log('\n' + '='.repeat(50))
  console.log(`\n✅ 通过：${passed}`)
  console.log(`❌ 失败：${failed}`)
  console.log(`📊 总计：${passed + failed}`)
  console.log('\n' + '='.repeat(50) + '\n')
  
  if (failed > 0) {
    process.exit(1)
  }
  
} catch (error) {
  console.error('\n💥 测试套件执行失败:')
  console.error(error)
  process.exit(1)
}
