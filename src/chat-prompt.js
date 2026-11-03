/**
 * 把「聊天规矩」挂进系统提示词 —— **静态那一半**。
 *
 * 2026-11-02 深夜重写。上一版把「话头 / 表情包清单 / 事实卡」也挂成了 section，
 * 姐姐一句话点破：「怎么可能让 system 是动态的，必须静态」。
 *
 * 为什么那是错的，机制上写死在这儿：
 *   `systemPrompt.project(renderedPrompt, { inHistory: false })`
 *   （@deepseek-ai/dsh-agent-loop/lib/index.js:1073）
 *   —— system 每轮是**整块替换第一个节点**。里面只要有一个字跟上一轮不同，
 *   第一节点就变了，前缀缓存从第 0 字节起全部失效，连后面的历史一起作废。
 *   把逐轮会变的东西塞进 system，等于亲手把缓存收益全扔掉。
 *
 * 所以这版分两半：
 *
 *   ┌ 静态（system section）────────────────────────────────────────────┐
 *   │ 9130 chat-rules    内置协议规矩 + prompt/rules.md + prompt/extra.md │
 *   │ 9160 chat-persona  人设（prompt/persona.md 优先）                   │
 *   │ 9300 chat-tail     收尾自检（prompt/tail.md 可替换）                │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 *   ┌ 动态（runtime-context，落在「真实 user 消息」之前那条）──────────┐
 *   │ 600  chat-dynamics  事实卡 / 群词典 / 话头 / 群纸条 / 表情包候选    │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * 动态那条走 `systemPrompt.context({...})`：宿主把它渲染成一条
 * `user/message`（`source.kind === 'runtime-context'`），位置固定在真实发言之前
 * （agent-loop:1083），**每轮重建，system 一个字都不动**。
 *
 * 「静态」怎么落地：按 `段名|peerId` 记忆**第一次算出来的字符串**，之后原样返回。
 * 配置改了、文件改了都不自动重算 —— 那样 system 又会逐轮变。
 * 要生效就重启，或者点设置页的「重载提示词」（走 reloadChatPrompt，属于受控动作）。
 *
 * ⚠️ `text(c)` 是**同步**执行的，抛错会把整轮请求打成失败（rag 那边踩过）。
 *    每段都包一层 respond()，出错只当没有这段，绝不拖垮对话。
 */
import {
  buildChatRules,
  buildChatFacts,
  buildChatPersona,
  buildChatContext,
  buildChatTail,
} from './prompts.js'
import { facesCount } from './faces.js'
import { readPromptFiles, clearPromptFileCache } from './prompt-files.js'
import {
  loadFactsFor,
  factsFileFor,
  loadGlossaryFor,
  glossaryFileFor,
  loadGroupDigest,
} from './settings.js'

/** 静态段的冻结表：`段名|peerId` → 第一次算出来的字符串。 */
const frozen = new Map()

/** 提示词文件按 500ms TTL 读一次（四个 statSync，别每段都 stat 一遍）。 */
let filesCache = { at: 0, all: null }

function promptFiles(ctx, logger) {
  const now = Date.now()
  if (filesCache.all && now - filesCache.at < 500) return filesCache.all
  const all = readPromptFiles(ctx, logger)
  filesCache = { at: now, all }
  return all
}

/** 清掉冻结表 + 文件缓存：下一次 assemble 会重新拼一次（受控重载，不是每轮）。 */
export function reloadChatPrompt() {
  frozen.clear()
  filesCache = { at: 0, all: null }
  clearPromptFileCache()
}

/** 当前冻结了几段，给日志/诊断用。 */
export function chatPromptStats() {
  return { frozen: frozen.size, keys: [...frozen.keys()] }
}

/**
 * @param {{ctx:any, config:any, manager:any, logger:any, pin:any}} deps
 * @returns {boolean} 挂上了没有（没挂上时调用方继续用老的注入方式兜底）
 */
export function installChatPromptSection({ ctx, config, manager, logger, pin, rhythm }) {
  let sp = null
  try {
    sp = ctx.get('systemPrompt') ?? ctx.systemPrompt ?? null
  } catch {
    sp = null
  }
  if (!sp || typeof sp.section !== 'function') {
    logger?.warn?.('[dsh-qq] 宿主没有 systemPrompt.section，聊天规矩继续走消息注入')
    return false
  }

  const ownerIds = new Set(
    (Array.isArray(config?.ownerIds) ? config.ownerIds : []).map(String).filter(Boolean),
  )

  /** 统一的取 record + 兜错外壳。 */
  const respond = (fn) => (c) => {
    try {
      const sid = c?.agent?.session?.id ?? c?.agent?.id
      if (!sid) return ''
      const record = manager?.find?.(String(sid))
      if (!record) return ''
      const out = fn(record)
      return typeof out === 'string' ? out : ''
    } catch (err) {
      // 规矩生成失败绝不能让整轮请求挂掉 —— 没规矩照样能聊天
      logger?.warn?.(`[dsh-qq] 生成提示段失败（这一轮跳过）: ${err?.message ?? err}`)
      return ''
    }
  }

  const isGroupOf = (record) => record.scope === 'group'
  const isOwnerOf = (record) => !isGroupOf(record) && ownerIds.has(String(record.peerId))

  /** 冻一段：第一次算，之后原样返回（这就是「静态」）。 */
  const freeze = (name, record, build) => {
    const key = `${name}|${record?.peerId ?? '-'}`
    const hit = frozen.get(key)
    if (hit !== undefined) return hit
    const text = build()
    frozen.set(key, text)
    return text
  }

  // 静态段共用的取数：只管文件，不管每轮会变的东西
  const staticOpts = (logger) => {
    const all = promptFiles(ctx, logger)
    return { rulesFile: all.rules, extraFile: all.extra, personaFile: all.persona, tailFile: all.tail }
  }

  // 动态段共用的取数：每轮都变，正是**不能**进 system 的那批
  const chatOpts = (record) => {
    const isGroup = isGroupOf(record)
    return {
      isGroup,
      isOwner: isOwnerOf(record),
      // 只给「有没有图」这一个布尔：数量、名单一律不进提示词（2026-11-03 姐姐要求）。
      // 收藏随时在变，提示词里写死数字迟早是错的；挑图全交给语义检索。
      faces: { has: facesCount(config) > 0 },
      facts: loadFactsFor(record),
      factsFile: factsFileFor(record),
      glossary: isGroup ? loadGlossaryFor(record) : '',
      glossaryFile: isGroup ? glossaryFileFor(record) : '',
      // 纸条只在私聊给：给她讲讲别的群今天的尾巴。群里不需要，她就在那儿。
      groupDigest: isGroup
        ? ''
        : loadGroupDigest({
            workspaceRoot: String(config?.workspaceRoot ?? '').trim() || process.cwd(),
            today: new Date().toISOString().slice(0, 10),
            selfId: String(config?.selfId ?? '').trim(),
          }),
    }
  }

  const mounted = []
  const disposers = []

  const addSection = (name, order, text) => {
    try {
      const dispose = sp.section({ name, order, text })
      if (typeof dispose === 'function') disposers.push(dispose)
      mounted.push(name)
    } catch (err) {
      logger?.warn?.(`[dsh-qq] 挂 ${name} 失败: ${err?.message ?? err}`)
    }
  }

  const addContext = (name, order, text) => {
    try {
      const dispose = sp.context({ name, order, text })
      if (typeof dispose === 'function') disposers.push(dispose)
      mounted.push(`${name}(context)`)
      return true
    } catch (err) {
      logger?.warn?.(`[dsh-qq] 挂 ${name} 失败: ${err?.message ?? err}`)
      return false
    }
  }

  // ── 静态三段：冻一次，全程不变 ────────────────────────────────────────────

  addSection(
    'dsh-qq:chat-rules',
    9130,
    respond((record) =>
      freeze('rules', record, () =>
        buildChatRules(config, {
          isGroup: isGroupOf(record),
          isOwner: isOwnerOf(record),
          ...staticOpts(logger),
        }),
      ),
    ),
  )

  addSection(
    'dsh-qq:chat-persona',
    9160,
    respond((record) =>
      freeze('persona', record, () => buildChatPersona(config, staticOpts(logger))),
    ),
  )

  // 收尾：静态，但必须排在最后（越靠后越不容易被前面一大坨冲淡）
  addSection(
    'dsh-qq:chat-tail',
    9300,
    respond((record) => freeze('tail', record, () => buildChatTail(staticOpts(logger)))),
  )

  // ── 动态一段：事实卡 / 群词典 / 话头 / 群纸条 / 表情包 / 当前烦躁度 ─────
  // 走 runtime-context：每轮重建，落在真实 user 消息之前，**不进 system**。
  const dynamicText = respond((record) => {
    const opts = chatOpts(record)
    const parts = []
    const facts = buildChatFacts(config, opts)
    if (facts) parts.push(facts)
    const pins = pin?.view?.(record) ?? []
    if (pins.length > 0) {
      if (parts.length > 0) parts.push('')
      parts.push(pins.join('\n'))
    }
    const ctxText = buildChatContext(config, opts)
    if (ctxText) {
      if (parts.length > 0) parts.push('')
      parts.push(ctxText)
    }
    // 当前烦躁度：**只在这里给一份，永远是最新的**。
    // 2026-11-03 之前它拼在每条投递正文里，会跟着每条消息沉进会话历史，
    // 十轮之后上下文里躺着十份过期数值。搬到这里之后每轮重建、不进历史。
    let mood = ''
    try {
      mood = rhythm?.moodText?.(record.scope === 'group' ? 'group' : 'private', record.peerId) || ''
    } catch {
      mood = ''
    }
    if (mood) {
      if (parts.length > 0) parts.push('')
      parts.push(`[${mood}]`)
    }
    return parts.join('\n').trim()
  })

  const contextMounted = typeof sp.context === 'function'
  if (contextMounted) {
    addContext('dsh-qq:chat-dynamics', 600, dynamicText)
  } else {
    // 老宿主没有 context()：退回 section（难看但能跑），日志写明它会让缓存失效
    logger?.warn?.('[dsh-qq] 宿主没有 systemPrompt.context，动态段退回 system 段（会让缓存失效）')
    addSection('dsh-qq:pin', 9205, respond((record) => (pin?.view?.(record) ?? []).join('\n')))
    addSection('dsh-qq:chat-context', 9210, respond((record) => buildChatContext(config, chatOpts(record))))
    addSection('dsh-qq:chat-facts', 9150, respond((record) => buildChatFacts(config, chatOpts(record))))
  }

  if (mounted.length === 0) {
    logger?.warn?.('[dsh-qq] 一个提示段都没挂上，聊天规矩继续走消息注入')
    return false
  }

  // 交给 ctx 的生命周期：插件卸载时一起摘掉
  try {
    ctx.on?.('dispose', () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 已经没了就算了 */
        }
      }
      frozen.clear()
    })
  } catch {
    /* 没有 dispose 语义的宿主就算了 */
  }

  logger?.info?.(`[dsh-qq] 静态提示段已挂：dsh-qq:chat-rules / dsh-qq:chat-persona / dsh-qq:chat-tail（冻结后不再重算）`)
  if (contextMounted) {
    logger?.info?.('[dsh-qq] 动态提示段已挂到 runtime-context：dsh-qq:chat-dynamics（每轮重建，不进 system）')
  }
  return true
}
