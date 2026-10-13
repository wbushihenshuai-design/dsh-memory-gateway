import { randomUUID, createHash } from 'node:crypto'

/**
 * 模式提取器 - 从对话中自动提取学习模式和成功策略
 * 核心功能：
 * 1. 识别"问题 - 方法 - 结果"三元组
 * 2. 抽象出通用模式（不依赖具体领域）
 * 3. 标记为可跨领域迁移的策略
 */
export class PatternExtractor {
  constructor({ llmClient, now = () => new Date().toISOString() }) {
    this.llmClient = llmClient
    this.now = now
  }
  
  /**
   * 从对话中提取模式
   * @param {Array} messages - 对话消息数组
   * @param {string} context - 上下文信息（会话 ID、项目等）
   */
  async extractPatterns(messages, context) {
    const patternPromises = []
    
    // 检测成功的解决方案
    patternPromises.push(this._detectSuccessPatterns(messages, context))
    
    // 检测错误和教训
    patternPromises.push(this._detectLessonPatterns(messages, context))
    
    // 检测方法论
    patternPromises.push(this._detectMethodologyPatterns(messages, context))
    
    return Promise.all(patternPromises).then(results => 
      results.flat().filter(Boolean)
    )
  }
  
  /**
   * 检测成功模式（问题解决过程）
   */
  async _detectSuccessPatterns(messages, context) {
    const successIndicators = [
      '解决了', '完成了', '成功了', '通过了', '实现了',
      '修复了', '部署了', '上线了', '验证通过'
    ]
    
    const successMsgs = messages.filter(m => 
      successIndicators.some(indicator => m.content.includes(indicator))
    )
    
    if (successMsgs.length === 0) return []
    
    // 调用 LLM 提取模式
    const prompt = this._buildSuccessPatternPrompt(successMsgs, context)
    try {
      const response = await this.llmClient.chat.completions.create({
        model: 'qwen3:8b',
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      })
      
      const extracted = JSON.parse(response.choices[0].message.content)
      return extracted.patterns.map(p => ({
        type: 'pattern',
        content: p.description,
        tags: [...p.tags, 'cross-domain', 'success'],
        context: { ...context, patternType: 'success' },
        metadata: {
          confidence: p.confidence || 0.8,
          applicability: p.applicability || ['general'],
        },
      }))
    } catch (error) {
      console.error('Failed to extract success patterns:', error)
      return []
    }
  }
  
  /**
   * 检测错误和教训
   */
  async _detectLessonPatterns(messages, context) {
    const errorIndicators = [
      '错误', '失败', '报错', '踩坑', '教训', '注意',
      '不要', '避免', '问题', 'bug', '缺陷'
    ]
    
    const errorMsgs = messages.filter(m => 
      errorIndicators.some(indicator => m.content.includes(indicator))
    )
    
    if (errorMsgs.length === 0) return []
    
    const prompt = this._buildLessonPatternPrompt(errorMsgs, context)
    try {
      const response = await this.llmClient.chat.completions.create({
        model: 'qwen3:8b',
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      })
      
      const extracted = JSON.parse(response.choices[0].message.content)
      return extracted.lessons.map(l => ({
        type: 'lesson',
        content: l.warning,
        tags: [...l.tags, 'cross-domain', 'lesson'],
        context: { ...context, patternType: 'lesson' },
        metadata: {
          severity: l.severity || 'medium',
          prevention: l.prevention,
        },
      }))
    } catch (error) {
      console.error('Failed to extract lesson patterns:', error)
      return []
    }
  }
  
  /**
   * 检测方法论
   */
  async _detectMethodologyPatterns(messages, context) {
    const methodologyIndicators = [
      '步骤', '方法', '流程', '策略', '框架', '体系',
      '原则', '最佳实践', '经验'
    ]
    
    const methodMsgs = messages.filter(m => 
      methodologyIndicators.some(indicator => m.content.includes(indicator))
    )
    
    if (methodMsgs.length === 0) return []
    
    const prompt = this._buildMethodologyPatternPrompt(methodMsgs, context)
    try {
      const response = await this.llmClient.chat.completions.create({
        model: 'qwen3:8b',
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      })
      
      const extracted = JSON.parse(response.choices[0].message.content)
      return extracted.strategies.map(s => ({
        type: 'strategy',
        content: s.description,
        tags: [...s.tags, 'cross-domain', 'methodology'],
        context: { ...context, patternType: 'methodology' },
        metadata: {
          complexity: s.complexity || 'medium',
          applicableScenarios: s.applicableScenarios || [],
        },
      }))
    } catch (error) {
      console.error('Failed to extract methodology patterns:', error)
      return []
    }
  }
  
  _buildSuccessPatternPrompt(messages, context) {
    return `从以下成功对话中提取可跨领域迁移的问题解决模式。

上下文：${JSON.stringify(context)}

对话内容：
${messages.map((m, i) => `${i + 1}. ${m.role}: ${m.content}`).join('\n')}

请返回 JSON 格式：
{
  "patterns": [
    {
      "description": "抽象的模式描述（不依赖具体领域）",
      "tags": ["标签 1", "标签 2"],
      "confidence": 0.9,
      "applicability": ["领域 1", "领域 2"]
    }
  ]
}

要求：
1. 模式必须是通用的，可以应用到其他领域
2. 提取具体的步骤和方法，而不是泛泛而谈
3. 标签要能支持跨领域检索`
  }
  
  _buildLessonPatternPrompt(messages, context) {
    return `从以下错误和教训对话中提取可预防的陷阱和注意事项。

上下文：${JSON.stringify(context)}

对话内容：
${messages.map((m, i) => `${i + 1}. ${m.role}: ${m.content}`).join('\n')}

请返回 JSON 格式：
{
  "lessons": [
    {
      "warning": "需要警惕的问题描述",
      "tags": ["标签 1", "标签 2"],
      "severity": "high|medium|low",
      "prevention": "如何避免这个问题的具体建议"
    }
  ]
}

要求：
1. 教训必须是可操作的，能指导未来行为
2. 提取通用的警示点，而不是特定领域的细节
3. 标签要能支持跨领域检索`
  }
  
  _buildMethodologyPatternPrompt(messages, context) {
    return `从以下方法论对话中提取系统性的策略和框架。

上下文：${JSON.stringify(context)}

对话内容：
${messages.map((m, i) => `${i + 1}. ${m.role}: ${m.content}`).join('\n')}

请返回 JSON 格式：
{
  "strategies": [
    {
      "description": "策略或框架的描述",
      "tags": ["标签 1", "标签 2"],
      "complexity": "low|medium|high",
      "applicableScenarios": ["场景 1", "场景 2"]
    }
  ]
}

要求：
1. 策略必须是结构化的，有清晰的步骤或原则
2. 提取可复用的方法论，而不是临时方案
3. 标签要能支持跨领域检索`
  }
  
  /**
   * 生成模式摘要（用于快速浏览）
   */
  generateSummary(patterns) {
    const byType = {}
    patterns.forEach(p => {
      if (!byType[p.type]) byType[p.type] = []
      byType[p.type].push(p)
    })
    
    const summary = {
      totalPatterns: patterns.length,
      byType: Object.keys(byType).reduce((acc, type) => {
        acc[type] = byType[type].length
        return acc
      }, {}),
      topTags: this._getTopTags(patterns),
      patterns: patterns.slice(0, 10).map(p => ({
        type: p.type,
        content: p.content.substring(0, 100) + '...',
        tags: p.tags.slice(0, 5),
      })),
    }
    
    return summary
  }
  
  _getTopTags(patterns, limit = 10) {
    const tagCounts = {}
    patterns.forEach(p => {
      p.tags.forEach(tag => {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1
      })
    })
    
    return Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([tag, count]) => ({ tag, count }))
  }
}
