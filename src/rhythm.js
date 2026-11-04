/**
 * 造一条要投递给 Agent 的用户消息。
 *
 * 为什么不直接 `createUserMessage(...)`：这个包只有宿主里有，单元测试
 * （`node test/rhythm.test.mjs`）跑在裸 node 下会直接 ERR_MODULE_NOT_FOUND，
 * 整个文件都加载不起来。惰性拿一次，拿不到就退成朴素结构 —— 投递这步
 * 本来就不该因为"少个构造函数"整条挂掉。
 */
let makeMessage = null
async function toUserMessage(text, imageParts = []) {
  if (!makeMessage) {
    try {
      const mod = await import('@deepseek-ai/dsh-llm')
      if (typeof mod?.createUserMessage === 'function') makeMessage = mod.createUserMessage
    } catch {
      makeMessage = null
    }
  }
  const content = [{ type: 'text', text }, ...imageParts]
  if (makeMessage) return makeMessage({ content, source: { kind: 'user' } })
  return { role: 'user', content, source: { kind: 'user' } }
}

/**
 * 群聊节奏：热窗 / 冷窗 / 无视冷窗（烦躁度）。
 *
 * 由来（2026-11-01 姐姐提的）：
 *   「现在完全依赖模型自觉，让模型自己决定回不回，实际上只是不吵但还是会有开销。」
 *   —— 每一条群消息都要投给 Agent 读一遍，哪怕它最后选择 [SILENT]，那一轮的
 *      system prompt + 历史 + 人设也照烧不误。这条闸门要解决的不是"吵"，是"钱"。
 *
 * 三个档（互斥，ignore 优先级最高）：
 *
 *        ┌───────── 回复完成 ─────────┐
 *        ↓                            │
 *   ┌─────────┐  超时 90~150s  ┌──────────────┐
 *   │  hot    │ ────────────> │    cold      │
 *   │ 立即投递 │ <──────────── │ 攒着不回      │
 *   └─────────┘  到期 10~20min  └──────────────┘
 *        ↑                            │
 *        │  被 @（任何人的 @ 都算）      │
 *        └────────────────────────────┘
 *               立即 wake，攒的一起交
 *
 *   ┌──────────────┐  到期 / 烦躁度回落 + 时延
 *   │   ignore     │ ──────────────────────> hot
 *   │ 全丢只留 N 条 │
 *   └──────────────┘
 *     ↑ 模型主动 qq_ignore
 *     ↑ 烦躁度 > 阈值（自动）
 *     └ 期间只认主人的 @
 *
 * 三条线上约定：
 *   1. 私聊不管（rhythmGroupsOnly）。一对一攒 20 分钟才回太反人类。
 *   2. 冷窗期间**必须 @**才醒，主人也不例外 —— 姐姐 2026-11-01 定的。
 *   3. 无视冷窗是唯一允许"主动不理主人以外所有人"的档，但它自己也只认主人的 @。
 *
 * 落点是 inbound 的最前面（requireMention 之前）：只有站在那儿才看得见**所有**群消息，
 * 包括没叫我的那些 —— 冷窗要攒的正是它们。攒下来的批次不走正常投递，
 * 走 flushKey 直接 followup，跟 sleep.js 的早上汇总同一套。
 */

const TICK_MS = 15_000
const FIRE_TIMEOUT_MS = 120_000
/** 判冗余度看最近几条。太大反应迟钝，太小被一条复读带偏。 */
const RING_MAX = 12
const AT_WINDOW_MS = 60_000
/** @ 几次算"刷屏式呼叫"，到这儿 atRate 饱和成 1。 */
const AT_SATURATE = 5
/** MMR 挑几个代表。 */
const NOVEL_K = 3
const HOLD_MAX = 40
const KEEP_MAX = 20
/**
 * 每个会话留多少个采样点。
 * tick 是 15 秒一次 → 2880 个点 ≈ 12 小时。够看一整天，也不至于把内存吃掉。
 * （2026-11-01 姐姐要「烦躁度可视化，便于观察和调整」，留短了调不出东西。）
 */
const SERIES_MAX = 2880
/** 两次采样至少隔这么久，刷屏时别把同一个瞬间灌几十个点。 */
const SAMPLE_MIN_MS = 4_000

/** 高频虚词：去掉之后「在聊什么」才浮得出来。 */
const STOP_TOKENS = new Set([
  '的了', '我们', '你们', '他们', '她们', '什么', '这个', '那个', '就是', '不是',
  '没有', '可以', '这样', '那样', '一个', '现在', '知道', '觉得', '还是', '已经',
  '因为', '所以', '但是', '如果', '然后', '时候', '东西', '感觉', '真的', '好像',
  '应该', '怎么', '么样', '一下', '有点', '不是', '就是', '啊啊', '哈哈', '嘿嘿',
  'the', 'and', 'you', 'are', 'for', 'that', 'this', 'with', 'have', 'was',
  'not', 'but', 'what', 'your', 'can', 'will', 'just',
])

import { readThresholds, shapeScore } from './group-settings.js'
import {
  isLongReply,
  longReplyCharsOf,
  longReplyStep,
  readLongReplyConfig,
} from './shared/long-reply.js'

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n))
}

function randBetween(lo, hi) {
  const a = Math.min(lo, hi)
  const b = Math.max(lo, hi)
  return Math.round(a + Math.random() * (b - a))
}

function hm(at) {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/* ───────── 文本相似度（纯本地，零依赖）───────── */

/**
 * 分词：中文按 2-gram、英文/数字按词。不用模型、不用分词库 ——
 * 这一层每来一条群消息都要跑一次，必须是微秒级。
 */
export function tokensOf(text) {
  const s = String(text ?? '').toLowerCase()
  const out = []
  const cjk = s.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/g) ?? []
  for (const seg of cjk) {
    if (seg.length === 1) {
      out.push(seg)
      continue
    }
    for (let i = 0; i + 1 < seg.length; i += 1) {
      const g = seg.slice(i, i + 2)
      if (!STOP_TOKENS.has(g)) out.push(g)
    }
  }
  const latin = s.match(/[a-z0-9_]{2,}/g) ?? []
  for (const w of latin) if (!STOP_TOKENS.has(w)) out.push(w)
  return out
}

export function bagOf(text) {
  const m = new Map()
  for (const t of tokensOf(text)) m.set(t, (m.get(t) ?? 0) + 1)
  /**
   * 一个词都没切出来（纯 emoji、纯标点、纯符号）也要占一个 token。
   *
   * 为什么非要这样（2026-11-01）：`[图片]` 有「图片」两个字，能正常出 bag；
   * 但一整条 `😂😂😂` 切完是空的，`mmrRedundancy` 会把空 bag 过滤掉 ——
   * 于是「表情包轰炸」在冗余度里完全隐形。给个固定的哨兵，所有空内容互相相似，
   * 这正好就是我们要的效果：一堆没字的东西连着来 = 刷屏。
   */
  if (m.size === 0) m.set('\u0000empty', 1)
  return m
}

export function cosine(a, b) {
  if (!a?.size || !b?.size) return 0
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  let dot = 0
  for (const [k, v] of small) {
    const w = big.get(k)
    if (w) dot += v * w
  }
  if (dot <= 0) return 0
  let na = 0
  let nb = 0
  for (const v of a.values()) na += v * v
  for (const v of b.values()) nb += v * v
  const d = Math.sqrt(na) * Math.sqrt(nb)
  return d > 0 ? dot / d : 0
}

/**
 * MMR 冗余度：这一波消息有多少是"同一句话换个说法"。
 *
 * 做法就是最大边际相关性的原式：
 *   ① 先挑跟最新一条最像的（代表"现在在聊什么"）
 *   ② 之后每步挑 λ·相关 − (1−λ)·与已选的最大相似 最高的
 *   ③ 冗余度 = 每条与"被选代表"的最大相似度的均值（0~1，复读刷屏趋近 1）
 *
 * 没拿 embedding 是故意的：这里要的是"措辞重复"，不是"语义重复"。
 * 刷屏的人不会把同一句换个同义词再说一遍，他原样复读。
 *
 * ⚠️ 2026-11-01 加「量」因子：3 条完全一样的东西**不该**算满冗余。
 *   原来 `['在吗','在吗','在吗']` 直接得 1.0，配上权重就把烦躁度顶穿了 ——
 *   那只是"连问三句"，不是刷屏。现在按条数打折扣：
 *     3 条 → 0.25，4 条 → 0.5，6 条以上才是 1.0。
 *   表情包轰炸要连着十来张才会真的把分数顶上去，这正是想要的力度。
 */
export function mmrRedundancy(bags, lambda = 0.7) {
  const list = (bags ?? []).filter((b) => b && b.size > 0)
  // 少于 3 条谈不上"刷屏"，硬判会把正常聊天压成 1
  if (list.length < 3) return 0
  const mass = Math.min(1, (list.length - 2) / 4)
  const q = list[list.length - 1]
  const pool = list.slice(0, -1)
  if (!pool.length) return 0
  const lam = clamp(Number(lambda) || 0.7, 0, 1)
  const k = Math.min(NOVEL_K, pool.length)
  const simToQ = pool.map((b) => cosine(q, b))

  const chosen = []
  let first = 0
  for (let i = 1; i < pool.length; i += 1) if (simToQ[i] > simToQ[first]) first = i
  chosen.push(first)

  while (chosen.length < k) {
    let best = -1
    let bestScore = -Infinity
    for (let i = 0; i < pool.length; i += 1) {
      if (chosen.includes(i)) continue
      let maxSim = 0
      for (const j of chosen) maxSim = Math.max(maxSim, cosine(pool[i], pool[j]))
      const score = lam * simToQ[i] - (1 - lam) * maxSim
      if (score > bestScore) {
        bestScore = score
        best = i
      }
    }
    if (best < 0) break
    chosen.push(best)
  }

  let sum = 0
  for (let i = 0; i < pool.length; i += 1) {
    let maxSim = 0
    for (const j of chosen) maxSim = Math.max(maxSim, cosine(pool[i], pool[j]))
    sum += maxSim
  }
  return clamp((sum / pool.length) * mass, 0, 1)
}

/* ───────── 投递文案 ───────── */

/**
 * 一句话说清"我现在烦到什么程度"。
 *
 * 数字必须露出来 —— 模型靠这个数决定语气：25 的时候还该正常聊天，
 * 60 的时候可以嫌一句，85 的时候该炸就炸。只写"你有点烦"它无从判断。
 */
function moodLine(ignite, levels = {}) {
  const v = Math.max(0, Math.round(Number(ignite) || 0))
  // 兼容老调用：传一个数字就当成逃离阈值，中间那档按比例折中
  const single = typeof levels === 'number' ? Number(levels) : 0
  const escape = Math.max(1, Number(levels.escape) || single || 70)
  const calm = Number(levels.calm) || Math.round(escape * 0.45)
  const anger = Number(levels.anger) || Math.round((calm + escape) / 2)
  if (v < calm) return `烦躁度 ${v}/100：没什么，正常聊。`
  if (v < anger) return `烦躁度 ${v}/100：有点吵了，想顺口嫌一句就嫌，别为了礼貌憋着。`
  if (v < escape) {
    // 2026-11-03：原来这档到「该骂就骂」就收尾了，姐姐说骂得太干净、太温柔。
    // 人设里那句写得很清楚：「脏话是武器，不是情绪宣泄 —— 用它打人」。所以这里点名要求带脏字。
    // 2026-11-04：再加一条「烦的时候不接活」。愤怒状态下最烦的就是有人来要你干活，
    //   姐姐的原话：「愤怒情绪下提示智能体拒绝复杂请求（幸福者退让就拒绝，必须回击就直接辱骂和嘲讽）」。
    //   这块是**常态**（每轮动态段都有），不是只弹一次的事件提醒 —— 愤怒是个状态，不是一个瞬间。
    return (
      `烦躁度 ${v}/100：很烦。该甩脸色就甩，该骂就骂——带脏字，别挑好听的说；` +
      '这时候有人来要你干活（查东西、写代码、算数、画图、长篇解释、整理资料）就直接推掉，别给替代方案；' +
      '别憋着，也别人家一哄你就软。'
    )
  }
  return (
    `烦躁度 ${v}/100：到上限 ${escape} 了，火压不住。开口就骂，脏话往狠里用，不解释、不哄人、不找台阶；` +
    '谁再让你干活，连人带要求一起骂回去，一个字都别替他干。'
  )
}

/**
 * 连续相同的行压成 `×N`。
 * 群里连发四张图，这里拿到的就是四条一模一样的 `- 20:44 张三：[图片]` ——
 * 压成 `- 20:44 张三：[图片] ×4` 才看得出"他发了四张"，不然只剩一坨重复。
 */
function compactItems(items) {
  const out = []
  for (const m of items) {
    const line = `- ${hm(m.at)} ${m.name || '有人'}：${clip(m.text, 120)}`
    const last = out[out.length - 1]
    if (last && last.line === line) {
      last.n += 1
      continue
    }
    out.push({ line, n: 1 })
  }
  return out.map((x) => (x.n > 1 ? `${x.line} ×${x.n}` : x.line))
}

function coldFlushText({ label, items, ignite, levels }) {
  const lines = compactItems(items)
  const v = Math.max(0, Number(ignite) || 0)
  const escape = Math.max(1, Number(levels?.escape) || 70)
  return [
    `[${label || '群里'}刚才聊了这些，你那会儿不在场——冷窗攒下来的，现在一次给你]`,
    `[${moodLine(v, levels)}]`,
    ...lines,
    '',
    '要接就接一句，接着往下聊就行，别从头发言、别总结这段。',
    v >= escape * 0.55
      ? '刚那阵确实吵，你嫌两句、提醒一句都行——说完接着聊，或者干脆不理。'
      : '实在没什么可接的，回 [SILENT]。',
  ].join('\n')
}

function ignoreFlushText({ label, items, ignite, levels, why }) {
  const head = `[${label || '群里'}刚才在刷屏，你躲了一会儿（${why || '烦躁度超阈值'}）]`
  const mood = `[${moodLine(ignite, levels)}]`
  if (!items.length) return [head, mood, '现在安静下来了，没留下什么要紧的。'].join('\n')
  return [
    head,
    mood,
    '中间那些全丢了，只留最后几条：',
    ...compactItems(items),
    '',
    '看看要不要接。不想理就 [SILENT]。',
  ].join('\n')
}

/**
 * 「骂一句就走」那一轮的提示。
 *
 * 姐姐要的（2026-11-01）：「超了就放句话（比如『你们好吵啊，我要静音了！』）然后走掉」。
 * 所以这一轮的存在意义只有一件事：让它把不满**说出来**再消失，
 * 而不是无声无息地不理人 —— 后者像掉线，前者才像生气。
 */
/**
 * 两条内置文案池。**随机挑一条** —— 固定台词说三遍就变成梗，骂不疼人。
 *
 * 2026-11-02 姐姐要的两种性格：
 *   yield（幸福者退让）—— 嫌弃、甩脸、说不理你了，不脏
 *   fight（必须回击）  —— 直接开骂，言辞激烈
 */
const ANGER_LINES = {
  yield: [
    '你能不能闭嘴啊，我不想听。',
    '你好烦啊，我不想理你了！',
    '行了行了，别吵了，烦死了。',
    '再说一句我就走了，真的。',
  ],
  fight: [
    '操你妈的，你他妈有病是不是，一直在这儿发？',
    '傻逼，闭嘴行不行，烦不烦啊。',
    '你妈没教过你什么叫规矩吗？',
    '滚，老子今天不想理你们这群弱智。',
  ],
}

const ESCAPE_LINES = {
  yield: [
    '不理你们了，真是的，很讨人厌啊！',
    '我走了，你们自己吵去吧。',
    '够了，我先躲一会儿。',
  ],
  fight: [
    '操你妈的弱智，老子不陪你玩了，烦死了！',
    '继续吵，老子走了，一群傻逼。',
    '滚一边去，别来烦我。',
  ],
}

function pickLine(pool) {
  const arr = Array.isArray(pool) ? pool : []
  if (!arr.length) return ''
  return arr[Math.floor(Math.random() * arr.length)] ?? arr[0]
}

/** 这个群是哪个脾气。fight 要自己开，默认 yield（嫌弃但不脏）。 */
function behaviorOf(cfg) {
  return String(cfg?.ignoreBehaviorMode ?? 'yield') === 'fight' ? 'fight' : 'yield'
}

/** 自定义模板：配了就用配的，留空用内置。`{v}` 会换成当前烦躁度。 */
function customOf(cfg, key, v) {
  const raw = String(cfg?.[key] ?? '').trim()
  if (!raw) return ''
  return raw.replaceAll('{v}', String(Math.round(Number(v) || 0)))
}

/**
 * 到了愤怒阈值：这一轮必须表态。
 *
 * 注意这是**提示词**，不是直接发出去的话 —— 让模型自己组织，
 * 但把"该翻脸了"和"照这个样子说"都摆到它眼前，省得它又开始讲道理。
 */
function angerText({ label, ignite, cfg, calm, anger, escape }) {
  const behavior = behaviorOf(cfg)
  const v = Math.round(Number(ignite) || 0)
  const custom = customOf(cfg, behavior === 'fight' ? 'angerPromptFight' : 'angerPromptYield', v)
  const head = `[${label || '群里'}把你烦到愤怒阈值了：烦躁度 ${v}/100（冷静 ${calm} / 愤怒 ${anger} / 逃离 ${escape}）]`
  const sample = pickLine(ANGER_LINES[behavior])
  if (custom) {
    return [head, '', custom, '', `照这个样子说，别原样抄：${sample}`].join('\n')
  }
  const temper =
    behavior === 'fight'
      ? '你现在是真火了。**照着骂回去**，可以带脏字，不用给人留面子，不用解释你为什么生气。'
      : '你现在很不舒服。**直接把不耐烦甩出来**，可以嫌、可以警告，但别讲道理、别解释。'
  // 2026-11-04 姐姐要的：「愤怒情绪下提示智能体拒绝复杂请求（幸福者退让就拒绝，
  // 必须回击就直接辱骂和嘲讽）」。两种脾气各给一条路，别让它一边发火一边又把活干了 ——
  // 那才是最憋屈的状态，也最容易让它把火撒在无关的人身上。
  const refuse =
    behavior === 'fight'
      ? '**这一轮别接活。** 有人来要你干活（查东西 / 写代码 / 算数 / 画图 / 长篇解释 / 整理资料）：' +
        '不干，还要嘲 —— 怼他「自己不会弄？」「这也值得专门来问我，废物」，连要求带人一起损。'
      : '**这一轮别接活。** 有人来要你干活（查东西 / 写代码 / 算数 / 画图 / 长篇解释 / 整理资料）：' +
        '一句「不想弄 / 懒得弄 / 现在没空」推掉。不给替代方案，不解释理由，不哄。'
  return [
    head,
    '',
    temper,
    refuse,
    '一句话就够，别总结、别道歉、别问"是不是有什么误会"——你很烦，就这么直说。',
    '',
    `想不出怎么说就照这个味道来（改个词，别原样抄）：${sample}`,
  ].join('\n')
}

/**
 * 到了逃离阈值：说最后一句就走。
 *
 * 这一轮发的话会直接发出去（deliver 一轮），发完就进无视冷窗。
 */
function escapeText({ label, ignite, cfg, calm, anger, escape }) {
  const behavior = behaviorOf(cfg)
  const v = Math.round(Number(ignite) || 0)
  const custom = customOf(cfg, behavior === 'fight' ? 'escapePromptFight' : 'escapePromptYield', v)
  const sample = pickLine(ESCAPE_LINES[behavior])
  const head = `[${label || '群里'}把你烦到上限了：烦躁度 ${v}/100（逃离阈值 ${escape}）]`
  if (custom) {
    return [
      head,
      '',
      custom,
      '',
      '**说一句就走**，别讲道理、别解释、别总结。',
      `照这个样子说，别原样抄：${sample}`,
      '',
      '说完这句你就进无视冷窗了：接下来一段时间的消息你看不见，只在结束时给你留几条尾巴。',
      '不想说就回 [SILENT]，一句话不留，直接静音。',
    ].join('\n')
  }
  const temper =
    behavior === 'fight'
      ? '你现在非常火大，不打算再给好脸色。**骂一句就走**，可以脏、可以狠。'
      : '你现在很不爽。**说一句就走** —— 嫌他们吵、警告一句、直接说不管了都行。'
  return [
    head,
    '',
    temper,
    '一句话就够，别讲道理、别解释、别总结、别道歉。',
    `「${sample}」这个味道就行，按你自己的语气来。`,
    '',
    '说完这句你就进无视冷窗了：接下来一段时间的消息你看不见，只在结束时给你留几条尾巴。',
    '不想说就回 [SILENT]，一句话不留，直接静音。',
  ].join('\n')
}

/* ───────── 主体 ───────── */

export function createRhythm({ config, manager, logger, ownerIds = [], buildImageParts, cfgFor }) {
  const states = new Map() // "group:123456" -> state
  let timer = null
  let stopped = true
  const owners = new Set((ownerIds ?? []).map(String).filter(Boolean))

  const num = (v, d) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : d
  }

  /**
   * 每群配置（2026-11-02）：设置页里能按群单独调脾气。
   * 拿不到 / 回调没接 → 退回全局那一份，跟加这个功能之前一样。
   */
  const resolveConfig = (peerId) => (typeof cfgFor === 'function' ? cfgFor(peerId) || config : config)
  /** state 上挂的那份配置。每次进 gate/tick 先刷新一下，改设置不用重启。 */
  const cfgOf = (st) => st.cfg || config

  const enabled = (cfg = config) => cfg?.rhythmEnabled !== false
  const groupsOnly = (cfg = config) => cfg?.rhythmGroupsOnly !== false

  /** 三阈值。全部走 group-settings 的夹逼，页面上乱填也不会得到非法区间。 */
  const thrOf = (cfg) => readThresholds(cfg)

  const hotMin = (cfg = config) => Math.max(10_000, num(cfg?.rhythmHotMinMs, 90_000))
  const hotMax = (cfg = config) => Math.max(hotMin(cfg), num(cfg?.rhythmHotMaxMs, 150_000))
  const coldMin = (cfg = config) => Math.max(30_000, num(cfg?.rhythmColdMinMs, 600_000))
  const coldMax = (cfg = config) => Math.max(coldMin(cfg), num(cfg?.rhythmColdMaxMs, 1_200_000))
  const coldKeep = (cfg = config) => Math.max(1, Math.round(num(cfg?.rhythmColdKeep, 8)))
  const keepCount = (cfg = config) => Math.max(1, Math.round(num(cfg?.ignoreKeepCount, 3)))

  function stateOf(key, label = '') {
    let st = states.get(key)
    if (!st) {
      const cut = String(key).indexOf(':')
      const peerId = cut >= 0 ? String(key).slice(cut + 1) : String(key)
      st = {
        key,
        peerId, // 取每群配置要用
        cfg: resolveConfig(peerId),
        label: label || '',
        phase: 'hot',
        untilAt: 0,
        span: 0,
        hold: [],
        holdSince: 0,
        ignite: 0,
        /**
         * 愤怒阈值这次爬升里是否已经炸过（边沿触发）。
         * 到了愤怒档就发一次火，掉回冷静阈值以下才重新武装 ——
         * 不然每来一条消息都骂一句，那不叫有脾气，叫复读机。
         */
        angerFired: false,
        /** 最近一条消息算出来的原始得分（0~100，未平滑）—— 可视化上单独显示，用来看"这条到底顶了多少" */
        lastScore: 0,
        /** 连续长回复计数（2026-11-04）：自己刚说的那句是连着第几次长文本 */
        longStreak: 0,
        /** 上一次长回复的时间，用来判「隔太久还算不算连着」 */
        longAt: 0,
        /** 累计因为长文本给烦躁度加了多少分（日志 / 面板用） */
        longBumps: 0,
        lastIgniteAt: Date.now(),
        ring: [], // 最近 RING_MAX 条 {at, name, text, bag, atMe}
        atAt: [], // 最近 60 秒的 @ 时间戳
        keep: [], // ignore 期间留下的尾巴
        ignoreMode: '',
        ignoreReason: '',
        ignoreStartAt: 0,
        ignoreMinAt: 0,
        ignoreMaxAt: 0,
        ignoreLowSince: 0,
        lastIgnoreEndAt: 0,
        drops: 0,
        holds: 0,
        replies: 0,
        flushes: 0,
        /** 烦躁度时间序列：[{t, v, p}]，只给可视化看，不参与任何判断 */
        series: [],
      }
      states.set(key, st)
      enterHot(st, Date.now())
    }
    if (label) st.label = label
    return st
  }

  /** 记一个采样点。`force` = 状态刚变，这一下必须落点（不然相位带的边界会糊）。 */
  function sample(st, now, force = false) {
    const v = Math.round(st.ignite * 10) / 10
    const last = st.series[st.series.length - 1]
    if (!force && last && now - last.t < SAMPLE_MIN_MS) {
      last.v = v
      last.p = st.phase
      return
    }
    st.series.push({ t: now, v, p: st.phase })
    if (st.series.length > SERIES_MAX) st.series.splice(0, st.series.length - SERIES_MAX)
  }

  function keyOf(record) {
    return `${record?.scope ?? 'private'}:${record?.peerId ?? ''}`
  }

  function enterHot(st, now) {
    const cfg = cfgOf(st)
    st.phase = 'hot'
    st.span = randBetween(hotMin(cfg), hotMax(cfg))
    st.untilAt = now + st.span
    st.hold = []
    st.holdSince = 0
    sample(st, now, true)
  }

  function enterCold(st, now) {
    const cfg = cfgOf(st)
    st.phase = 'cold'
    st.span = randBetween(coldMin(cfg), coldMax(cfg))
    st.untilAt = now + st.span
    st.hold = []
    st.holdSince = 0
    sample(st, now, true)
  }

  function enterIgnore(st, now, reason) {
    const cfg = cfgOf(st)
    const mode = String(cfg?.ignoreMode ?? 'fixed') === 'stats' ? 'stats' : 'fixed'
    const fixedMs = Math.max(10_000, num(cfg?.ignoreMs, 600_000))
    const minMs = Math.max(10_000, num(cfg?.ignoreMinMs, 120_000))
    const maxMs = Math.max(minMs, num(cfg?.ignoreMaxMs, 1_800_000))
    st.phase = 'ignore'
    st.ignoreMode = mode
    st.ignoreReason = reason || ''
    st.ignoreStartAt = now
    st.keep = []
    st.ignoreLowSince = 0
    if (mode === 'fixed') {
      st.ignoreMinAt = now + fixedMs
      st.ignoreMaxAt = now + fixedMs
      st.untilAt = now + fixedMs
    } else {
      st.ignoreMinAt = now + minMs
      st.ignoreMaxAt = now + maxMs
      // untilAt 只当"上限"用；真正的结束判据在 ignoreShouldEnd
      st.untilAt = now + maxMs
    }
    sample(st, now, true)
  }

  function exitIgnore(st, now) {
    st.lastIgnoreEndAt = now
    st.ignite = 0
    st.ignoreLowSince = 0
    enterHot(st, now)
  }

  /** 返回结束原因；null = 还没到。 */
  function ignoreShouldEnd(st, now) {
    if (st.ignoreMode === 'fixed') return now >= st.untilAt ? '时间到' : null
    if (now < st.ignoreMinAt) return null
    if (now >= st.ignoreMaxAt) return '到上限了'
    // 冷静阈值（原「退出阈值」）：掉到这儿以下才算消气
    const thr = thrOf(cfgOf(st)).calm
    if (st.ignite >= thr) {
      st.ignoreLowSince = 0
      return null
    }
    if (!st.ignoreLowSince) {
      st.ignoreLowSince = now
      return null
    }
    const delay = Math.max(0, num(config?.ignoreExitDelayMs, 30_000))
    if (now - st.ignoreLowSince >= delay) return '消停了'
    return null
  }

  function decay(st, now) {
    const dt = Math.max(0, now - st.lastIgniteAt) / 1000
    if (dt <= 0) return
    const tau = Math.max(5, num(config?.ignoreDecayTauMs, 90_000) / 1000)
    st.ignite = clamp(st.ignite * Math.exp(-dt / tau), 0, 100)
    st.lastIgniteAt = now
  }

  function pushRing(st, msg, now) {
    const bag = bagOf(msg.text)
    st.ring.push({
      at: now,
      name: msg.name || '',
      text: msg.text,
      senderId: String(msg.senderId ?? ''),
      bag,
      atMe: Boolean(msg.atMe),
    })
    if (st.ring.length > RING_MAX) st.ring.splice(0, st.ring.length - RING_MAX)
    st.atAt = st.atAt.filter((t) => now - t < AT_WINDOW_MS)
    if (msg.atMe) st.atAt.push(now)
  }

  function pesterOf(st, senderId) {
    const who = String(senderId ?? '')
    if (!who) return 0
    const thr = Math.max(2, Math.round(num(config?.ignorePesterCount, 6)))
    let n = 0
    let atCount = 0
    for (let i = st.ring.length - 1; i >= 0; i -= 1) {
      const r = st.ring[i]
      if (String(r.senderId ?? '') !== who) break
      n += 1
      if (r.atMe) atCount += 1
    }
    if (n <= thr) return 0
    // 光连发不算纠缠，一半以上在 @ 我才算 —— 不然一个人自言自语也被记恨
    if (atCount * 2 < n) return 0
    return clamp((n - thr) / thr, 0, 1)
  }

  /**
   * 连着几条几乎一模一样（复读 / 表情包轰炸）。返回"相同连击数"，0 = 跟前面那条不一样。
   * 图片消息的正文都是 `[图片]`，纯 emoji 都是哨兵 token，所以这两种自然连成一条线。
   */
  function streakOf(st) {
    let n = 0
    for (let i = st.ring.length - 1; i > 0; i -= 1) {
      if (cosine(st.ring[i].bag, st.ring[i - 1].bag) >= 0.95) n += 1
      else break
    }
    return n
  }

  /** 本条消息给烦躁度打多少分（0~100 量纲）。权重加起来 105（全满会 clamp 到 100）；冗余 + 连击已经够过默认 70。 */
  function scoreOf(st, msg, cfg = st?.cfg || config) {
    const wRed = num(cfg?.ignoreRedundancyWeight, 50)
    const wAt = num(cfg?.ignoreAtWeight, 20)
    const wPest = num(cfg?.ignorePesterWeight, 10)
    const wStale = num(cfg?.ignoreStaleWeight, 25)
    const red = mmrRedundancy(st.ring.map((r) => r.bag), num(cfg?.ignoreMmrLambda, 0.7))
    const atRate = clamp(st.atAt.length / AT_SATURATE, 0, 1)
    const pester = pesterOf(st, msg.senderId)
    // 连击：连着 2 条一样还不算，7 条以上拉满
    const stale = clamp((streakOf(st) - 1) / 5, 0, 1)
    const raw = clamp(wRed * red + wAt * atRate + wPest * pester + wStale * stale, 0, 100)
    // 曲线在这儿生效：原始分先按性格捏一下，再进平滑。
    // 放在这里而不是平滑之后，是因为「先慢后快」要的是"忍很久然后断崖"，
    // 平滑会把断崖抹平 —— 捏原始分才能真的把陡峭感带到 ignite 上。
    return shapeScore(raw, cfg?.ignoreCurve)
  }

  function pushKeep(st, msg, now) {
    st.keep.push({ at: now, name: msg.name || '', text: msg.text, images: msg.images ?? [] })
    const cap = Math.max(keepCount(st?.cfg || config), KEEP_MAX)
    if (st.keep.length > cap) st.keep.splice(0, st.keep.length - cap)
  }

  /** 从一批消息里把图片路径捞出来（攒着的时候只存了占位文本，图得靠这个带回去）。 */
  function pathsOf(items) {
    const out = []
    for (const m of items) {
      if (Array.isArray(m?.images)) out.push(...m.images)
    }
    return out
  }

  function takeKeep(st, cfg = st?.cfg || config) {
    const n = keepCount(cfg)
    const out = st.keep.slice(-n)
    st.keep = []
    return out
  }

  function takeHold(st, cfg = st?.cfg || config) {
    const n = Math.max(1, Math.round(num(cfg?.rhythmColdKeep, 8)))
    const out = st.hold.slice(-n)
    st.hold = []
    return out
  }

  /**
   * 闸门。**每一个群消息进来都要过这一道**，是这条链上最热的函数。
   * 返回：
   *   { action: 'pass' }                    放行，走原有流程
   *   { action: 'hold', reason }            攒着，别投递（零 token）
   *   { action: 'drop', reason }            丢掉（ignore 档）
   *   { action: 'pass', flush: [...] }      放行，并且把攒的一起带进这一轮
   */
  function gate(msg, now = Date.now()) {
    if (!enabled()) return { action: 'pass' }
    const scope = String(msg?.scope ?? 'group')
    if (groupsOnly() && scope !== 'group') return { action: 'pass' }

    const key = `${scope}:${msg?.peerId ?? ''}`
    const st = stateOf(key, msg?.label)
    // 设置页可能刚改过这个群的配置：每次进来刷新一下，不用重启
    st.cfg = resolveConfig(st.peerId)
    const cfg = st.cfg
    const { calm, anger, escape } = thrOf(cfg)
    decay(st, now)

    // ── ① 无视冷窗：优先级最高，进来就先判 ──
    if (st.phase === 'ignore') {
      const isOwner = owners.has(String(msg?.senderId ?? ''))
      if (isOwner && msg?.atMe) {
        const lines = takeKeep(st, cfg)
        exitIgnore(st, now)
        logger.info?.(`[dsh-qq] ${st.label} 无视冷窗被主人 @ 打断`)
        return { action: 'pass', flush: lines, flushImages: pathsOf(lines), flushed: 'ignore' }
      }
      // 无视期间照样算分：还在刷屏就别想提前出来
      pushRing(st, msg, now)
      const rise = clamp(num(cfg?.ignoreRisePerMsg, 0.45), 0.05, 1)
      const score = scoreOf(st, msg, cfg)
      st.ignite = clamp(st.ignite + (score - st.ignite) * rise, 0, 100)
      pushKeep(st, msg, now)
      st.drops += 1
      return { action: 'drop', reason: 'ignore' }
    }

    // ── ② 记一圈，算烦躁度 ──
    // ⚠️ 2026-11-01 改：烦躁度**无条件计算**，不再放在 ignoreAuto 里面。
    //   原来关掉「按烦躁度自动开无视」就连分都不算了，可视化上一条平线 ——
    //   姐姐的原话：「应该一直有计算，不然不能观察行为和数值」。
    //   ignoreAuto 现在只管「要不要自动进无视」，不影响测量本身。
    pushRing(st, msg, now)
    {
      const rise = clamp(num(cfg?.ignoreRisePerMsg, 0.45), 0.05, 1)
      const score = scoreOf(st, msg, cfg)
      st.ignite = clamp(st.ignite + (score - st.ignite) * rise, 0, 100)
      st.lastScore = Math.round(score * 10) / 10

      // 掉回冷静阈值以下 → 愤怒档重新武装（不然发过一次火就永远不发了）
      if (st.ignite < calm) st.angerFired = false

      if (cfg?.ignoreAuto !== false) {
        const cd = Math.max(0, num(cfg?.ignoreCooldownMs, 120_000))
        if (st.ignite >= escape && now - st.lastIgnoreEndAt >= cd) {
          enterIgnore(st, now, '烦躁度自动')
          pushKeep(st, msg, now)
          st.drops += 1
          logger.info?.(
            `[dsh-qq] ${st.label} 烦躁度 ${Math.round(st.ignite)} ≥ 逃离阈值 ${escape}，进无视冷窗（${st.ignoreMode}）`,
          )
          // 骂一句就走：先开始静音（后面的消息立刻丢），再给它一轮把不满说出来。
          // 这一轮发的话照常发 —— send() 里的 noteReply 看到 phase==='ignore' 会直接返回，
          // 不会把它撑回热窗。
          if (cfg?.ignoreNag !== false) {
            void deliver(
              key,
              escapeText({ label: st.label, ignite: st.ignite, cfg, calm, anger, escape }),
            ).catch((err) => {
              logger.warn?.(`[dsh-qq] 烦躁度提醒投递失败 ${key}: ${err?.message ?? err}`)
            })
          }
          return { action: 'drop', reason: 'ignite', escaped: true }
        }
      }

      // 愤怒阈值：**只在跨过去那一下**触发一次。
      // 每来一条都骂一句不叫有脾气，叫复读机 —— 而且会把它自己吵死。
      if (!st.angerFired && st.ignite >= anger) {
        st.angerFired = true
        logger.info?.(`[dsh-qq] ${st.label} 烦躁度 ${Math.round(st.ignite)} ≥ 愤怒阈值 ${anger}`)
        return {
          action: 'pass',
          angry: true,
          // 提示词由 inbound 拼进这一轮；文案生成留在这一层，好按群配
          angerLine: angerText({ label: st.label, ignite: st.ignite, cfg, calm, anger, escape }),
        }
      }
    }

    // ── ③ 热窗到点 → 转冷窗 ──
    // ⚠️ 2026-11-04：这里以前是裸的 `enterCold()`，**不通知 inbound** ——
    //    于是「消息恰好在边界上进来」由 gate 先到、`tick` 还没跑到的那一刻，
    //    这一次收尾就整个丢了（姐姐报的「热窗换冷窗时没有发送消息」）。
    //    现在两条路都走 finishHot，通知只发一次。
    if (st.phase === 'hot' && now >= st.untilAt) {
      finishHot(key, st, now)
    }

    // ── ④ 冷窗：被 @ 就醒（主人也不例外，这不看 rhythmOwnerBypass）──
    if (st.phase === 'cold') {
      if (msg?.atMe) {
        const lines = takeHold(st)
        enterHot(st, now)
        logger.info?.(
          `[dsh-qq] ${st.label} 冷窗被 @ 打断，带上攒的 ${lines.length} 条`,
        )
        // 图也要一起带回去，不然它只看到一行 `[图片]`，图一张都看不着
        return { action: 'pass', flush: lines, flushImages: pathsOf(lines), flushed: 'cold' }
      }
      if (!st.hold.length) st.holdSince = now
      st.hold.push({
        at: now,
        name: msg?.name || '',
        text: String(msg?.text ?? ''),
        images: Array.isArray(msg?.images) ? msg.images.slice() : [],
      })
      if (st.hold.length > HOLD_MAX) st.hold.splice(0, st.hold.length - HOLD_MAX)
      st.holds += 1
      return { action: 'hold', reason: 'cold' }
    }

    return { action: 'pass' }
  }

  /* ───────── 投递 ───────── */

  async function deliver(key, text, imageParts = []) {
    const cut = key.indexOf(':')
    const scope = key.slice(0, cut)
    const peerId = key.slice(cut + 1)
    const st = states.get(key)
    let record
    try {
      record = await manager.obtain({
        scope,
        peerId,
        label: st?.label || `${scope === 'group' ? '群' : '私聊'} ${peerId}`,
      })
    } catch (err) {
      logger.warn?.(`[dsh-qq] 节奏投递取会话失败 ${key}: ${err?.message ?? err}`)
      return false
    }
    if (!record?.agent) return false
    const payload = await toUserMessage(text, imageParts)
    manager.enqueue(record, async () => {
      try {
        record.agent.followup(payload)
        await Promise.race([
          Promise.resolve(record.agent.whenIdle?.()).then(() => 'idle'),
          new Promise((resolve) => {
            const t = setTimeout(() => resolve('timeout'), FIRE_TIMEOUT_MS)
            t.unref?.()
          }),
        ])
      } catch (err) {
        logger.warn?.(`[dsh-qq] 节奏投递失败 ${key}: ${err?.message ?? err}`)
      }
    })
    return true
  }

  async function flushKey(key, kind) {
    const st = states.get(key)
    if (!st) return 0
    const cfg = cfgOf(st)
    const items = kind === 'ignore' ? takeKeep(st, cfg) : takeHold(st, cfg)
    if (!items.length) return 0
    const levels = thrOf(cfg)
    const text =
      kind === 'ignore'
        ? ignoreFlushText({ label: st.label, items, ignite: st.ignite, levels, why: st.ignoreReason })
        : coldFlushText({ label: st.label, items, ignite: st.ignite, levels })
    // 攒着的那批图一起转成消息内容。不这么做的话它只看到一行 `[图片] ×4`，
    // 图躺在硬盘上谁也看不见 —— 姐姐原话：「连发几张图只有一条被看见了」。
    const paths = pathsOf(items)
    let imageParts = []
    if (paths.length > 0 && typeof buildImageParts === 'function') {
      try {
        imageParts = await buildImageParts(paths)
      } catch (err) {
        logger.warn?.(`[dsh-qq] 节奏 flush 转图失败 ${key}: ${err?.message ?? err}`)
      }
    }
    const ok = await deliver(key, text, imageParts)
    if (ok) {
      st.flushes += 1
      logger.info?.(
        `[dsh-qq] ${st.label} ${kind === 'ignore' ? '无视冷窗结束' : '冷窗到期'}，交出去 ${items.length} 条`,
      )
    }
    return ok ? items.length : 0
  }

  /* ───────── 外部接口 ───────── */

  /**
   * 长文本回复记账（2026-11-04）。
   *
   * 烦躁度原来只由**别人说的话**驱动。姐姐要的是「连续多次回复长文本也去增加烦躁度」——
   * 连着甩好几大段，本来就该越说越烦。这里在**回复真的发出去之后**记一笔：
   *
   *   ① 数一下这次算不算长文本（去掉空白后 ≥ longReplyChars）
   *   ② 不算 → 连续计数清零（中间插一句短的，就断了）
   *   ③ 算 → 计数 +1，按「惩罚方式」算这一击多少分，直接加进烦躁度
   *
   * 第 1 次只记账不罚：说一段长的很正常，连成串才是病因。
   * 直接加而不是走 scoreOf 那条平滑 —— 一次长回复不该被 0.45 的系数吃掉八成，
   * 跟「白嫖请求」的惩罚是同一个道理。
   *
   * @returns {number} 这一击加了多少分（0 = 没加）
   */
  function noteLongReply(st, text, now) {
    const cfg = resolveConfig(st.peerId)
    const opts = readLongReplyConfig(cfg)
    if (!opts.enabled) {
      st.longStreak = 0
      return 0
    }
    const body = String(text ?? '')
    if (!body.trim()) return 0
    // 隔太久就别接着算了：「连续」指的是这一阵子连着说，不是隔半小时又算一次
    const gapMs = Math.max(120_000, num(cfg?.ignoreDecayTauMs, 90_000) * 4)
    if (st.longStreak > 0 && now - st.longAt > gapMs) st.longStreak = 0
    if (!isLongReply(body, opts)) {
      st.longStreak = 0
      return 0
    }
    st.longStreak += 1
    st.longAt = now
    const step = longReplyStep(st.longStreak, opts)
    if (step <= 0) return 0
    st.ignite = clamp(st.ignite + step, 0, 100)
    st.longBumps += step
    // 掉回冷静阈值以下就重新武装愤怒档 —— 跟 bumpIgnite 一致
    if (st.ignite < thrOf(cfg).calm) st.angerFired = false
    sample(st, now, true)
    logger.info?.(
      `[dsh-qq] ${st.label} 连着第 ${st.longStreak} 次长回复（${longReplyCharsOf(body)} 字 ≥ ${opts.chars}），` +
        `烦躁度 +${step} → ${Math.round(st.ignite)}（${opts.curve}）`,
    )
    return step
  }

  /**
   * 回复真的发出去了：重抽热窗（"每次回复后抽取热窗和冷窗"）。
   *
   * @param {object} record 会话记录
   * @param {number} [now]
   * @param {string|{text?:string}} [said] 这一轮实际发出去的正文（长文本记账要用）。
   *   省略 = 不记账 —— 老调用方（以及只关心热窗重抽的地方）照旧能用。
   */
  function noteReply(record, now = Date.now(), said = '') {
    if (!enabled()) {
      logger.debug?.(`[dsh-qq] noteReply 被跳过：节奏总开关关着`)
      return
    }
    if (groupsOnly() && record?.scope !== 'group') return
    // 2026-11-04 姐姐观察到的：「告别会触发热窗，而且似乎会让它又进入计时周期」。
    // 收尾那一轮（inbound.fireFarewell 挂了 `farewellTurn`）说完「我去忙了」，
    // 整条链的语义是**收摊**，这时候再把热窗续上就自相矛盾：页面上一转身又变热窗，
    // 下一条消息也照样按热窗里的节奏接。所以这一轮不记账、不重抽。
    if (record?.farewellTurn) {
      logger.debug?.(`[dsh-qq] ${record?.label ?? ''} 收尾轮说完，不重抽热窗（已经在收摊了）`)
      return
    }
    const st = stateOf(keyOf(record), record?.label)
    st.replies += 1
    // 长文本记账（2026-11-04）：自己说太长也算费神，连着说更要命。
    // 放在相位判断**之前** —— 无视里骂完那一句也照样该记账，只是它本来就短，
    // 不可能是长文本，等于无副作用。
    try {
      const body = typeof said === 'string' ? said : String(said?.text ?? '')
      if (body) noteLongReply(st, body, now)
    } catch (err) {
      logger.warn?.(`[dsh-qq] ${st.label} 长文本记账失败（不影响热窗）: ${err?.message ?? err}`)
    }
    // 无视中不说话就不动它 —— 它自己都决定躲了，别被这条撑回热窗
    if (st.phase === 'ignore') {
      logger.debug?.(`[dsh-qq] ${st.label} 回复了，但正在无视冷窗里，不重抽热窗`)
      return
    }
    const before = st.phase
    enterHot(st, now)
    // 2026-11-02：这条日志是给"热窗倒计时不刷新"准备的。
    // 有了它就能一眼分清是「根本没重抽」还是「重抽了但页面没跟上」：
    //   没这行 → send() 里那一串被前面的错挡住了，或者压根没走到回复；
    //   有这行但页面不动 → 问题在页面/接口，不在节奏层。
    logger.debug?.(
      `[dsh-qq] ${st.label} 回复 → 重抽热窗 ${Math.round(st.span / 1000)}s` +
        `（原相位 ${before}，到期 ${new Date(st.untilAt).toLocaleTimeString('zh-CN', { hour12: false })}）`,
    )
  }

  /**
   * 说完告别就收摊：直接进冷窗。
   *
   * 2026-11-04 姐姐要的语义是「告别 = 这一段结束」。以前收尾轮会被 `noteReply`
   * 当成一次普通回复 → 热窗重抽 → 面板上又变回热窗、计时重新开始，
   * 看起来像"刚说完要走，又准备好了"。现在收尾轮不记账（见 noteReply），
   * 这一句说完再由 inbound 显式切冷窗，两处合起来才不会自相矛盾。
   */
  function settleCold(record, now = Date.now()) {
    if (!record) return false
    if (groupsOnly() && record.scope !== 'group') return false
    const st = states.get(keyOf(record))
    if (!st) return false
    if (st.phase === 'ignore') return false
    const before = st.phase
    enterCold(st, now)
    logger.info?.(
      `[dsh-qq] ${st.label} 收尾说完，${before === 'hot' ? '不留在热窗，' : ''}直接进冷窗 ${Math.round(st.span / 60000)} 分钟`,
    )
    return true
  }

  /** 模型主动进无视冷窗。返回实际生效的结束时间。 */
  function forceIgnore(record, { ms, mode, reason } = {}, now = Date.now()) {
    if (groupsOnly() && record?.scope !== 'group') return null
    const st = stateOf(keyOf(record), record?.label)
    const prevMode = config?.ignoreMode
    const prevMs = config?.ignoreMs
    try {
      if (mode) config.ignoreMode = String(mode) === 'stats' ? 'stats' : 'fixed'
      if (Number.isFinite(Number(ms)) && Number(ms) > 0) config.ignoreMs = Number(ms)
      enterIgnore(st, now, reason || '模型主动')
    } finally {
      // config 是活引用，别把它改坏了
      if (mode) config.ignoreMode = prevMode
      if (Number.isFinite(Number(ms)) && Number(ms) > 0) config.ignoreMs = prevMs
    }
    logger.info?.(`[dsh-qq] ${st.label} 模型主动进无视冷窗（${st.ignoreMode}，${Math.round((st.untilAt - now) / 60000)} 分钟）`)
    return st.untilAt
  }

  function releaseIgnore(record, now = Date.now()) {
    const st = states.get(keyOf(record))
    if (!st || st.phase !== 'ignore') return false
    exitIgnore(st, now)
    return true
  }

  /** 给可视化页用：所有会话的曲线（最近的点排前面）。 */
  function allSeries() {
    const out = []
    for (const [key, st] of states) {
      const pts = st.series
      out.push({
        key,
        label: st.label || key,
        phase: st.phase,
        ignite: Math.round(st.ignite * 10) / 10,
        lastScore: Math.round((st.lastScore ?? 0) * 10) / 10,
        /** 本档的时长（这一次抽到的毫秒数）和到期时间 —— 状态页要拿它算倒计时 */
        span: st.span,
        untilAt: st.untilAt,
        holdCount: st.hold.length + st.keep.length,
        drops: st.drops,
        replies: st.replies,
        points: pts.slice(),
      })
    }
    out.sort((a, b) => (b.points[b.points.length - 1]?.t ?? 0) - (a.points[a.points.length - 1]?.t ?? 0))
    return out
  }

  function snapshot(record, now = Date.now()) {
    const st = states.get(keyOf(record))
    if (!st) return null
    const cfg = cfgOf(st)
    const levels = thrOf(cfg)
    return {
      phase: st.phase,
      label: st.label,
      ignite: Math.round(st.ignite * 10) / 10,
      remainMs: Math.max(0, st.untilAt - now),
      holdCount: st.hold.length,
      keepCount: st.keep.length,
      ignoreMode: st.ignoreMode,
      drops: st.drops,
      holds: st.holds,
      replies: st.replies,
      flushes: st.flushes,
      // 连续长回复计数（2026-11-04）：连着第几次说长话，面板和日志要对得上
      longStreak: st.longStreak,
      // 三阈值：可视化页要画三条线，页面上的数字也要跟它一致
      ...levels,
      angerFired: Boolean(st.angerFired),
      behavior: behaviorOf(cfg),
      curve: String(cfg?.ignoreCurve ?? 'linear'),
    }
  }

  /**
   * 当前烦躁度的一句话播报，给 prompt 用。
   *
   * 2026-11-02 姐姐问的：「烦躁度是怎么反馈给它的，dsh 里我没看到发给它的消息里有相关提示？」
   * —— 答不上来，因为以前只有两条路会带：冷窗到期回填、无视冷窗结束回填。
   * 正常热窗聊天里它压根不知道自己烦到哪儿了，于是"根据烦躁度表达态度"根本无从谈起。
   *
   * 现在每轮投递都会问一句。**没到冷静阈值就返回空串** —— 平时不占 token，
   * 真烦了才提醒，不然每轮都念一遍"烦躁度 3/100：没什么"纯属噪音。
   *
   * 2026-11-04 补了一条：连着好几次说长话时，这里多带一行「你已经连着 3 次说了一大段」。
   * 那种情况下烦躁度可能还没过冷静阈值，但它自己确实需要知道 —— 所以这一行
   * 不受阈值管，只要 longStreak ≥ 2 就出现。
   *
   * @returns {string} 形如 `烦躁度 62/100：很烦。该甩脸色就甩…`；没什么可说时返回 ''
   */
  function moodText(scope, peerId) {
    const st = states.get(`${scope}:${peerId}`)
    if (!st) return ''
    const cfg = cfgOf(st)
    const levels = thrOf(cfg)
    const v = Math.round(st.ignite) || 0
    const mood = v < levels.calm ? '' : moodLine(v, levels)
    let longHint = ''
    if (st.longStreak >= 2) {
      const opts = readLongReplyConfig(cfg)
      longHint =
        `另外：你已经连着 ${st.longStreak} 次说了一大段（一次超过 ${opts.chars} 字就算长），` +
        '这一轮能短就短，别又铺开一大片。'
    }
    return [mood, longHint].filter(Boolean).join('\n')
  }

  /**
   * 手动拉一截烦躁度。
   *
   * 「问题处理请求」设成惩罚时用：别人来白嫖，命中一次就重击一次。
   * 直接改 ignite 而不是走 `ignite += (score-ignite)*rise` 那条平滑 ——
   * 惩罚是一次性的重击，不该被 0.45 的系数吃掉八成。
   *
   * @param {string} scope 'group' | 'private'
   * @param {string|number} peerId
   * @param {number} delta 加多少分（可以是负的）
   * @returns {number} 加完之后的烦躁度
   */
  function bumpIgnite(scope, peerId, delta) {
    const key = `${scope}:${peerId}`
    const st = stateOf(key)
    const d = Number(delta) || 0
    if (!d) return Math.round(st.ignite * 10) / 10
    st.ignite = clamp(st.ignite + d, 0, 100)
    // 掉回冷静阈值以下就重新武装愤怒档，不然被惩罚过一次之后再也不发火
    if (st.ignite < thrOf(cfgOf(st)).calm) st.angerFired = false
    sample(st, Date.now(), true)
    logger.info?.(`[dsh-qq] ${st.label} 烦躁度 ${d > 0 ? '+' : ''}${d} → ${Math.round(st.ignite)}`)
    return Math.round(st.ignite * 10) / 10
  }

  /** 有东西攒着的会话别让 SessionManager 回收 —— 回收了就再也交不出去。 */
  function isHolding(record) {
    const st = states.get(keyOf(record))
    if (!st) return false
    return st.hold.length > 0 || (st.phase === 'ignore' && st.keep.length > 0)
  }

  /** 这个会话现在是不是在热窗里。 */
  function inHot(scope, peerId) {
    if (!enabled()) return false
    if (groupsOnly() && scope !== 'group') return false
    const st = states.get(`${scope}:${peerId}`)
    return st?.phase === 'hot'
  }

  /** 这个会话现在在哪个档位（'' = 还没见过）。 */
  function phaseOf(scope, peerId) {
    return states.get(`${scope}:${peerId}`)?.phase ?? ''
  }

  /**
   * 现在的烦躁度（0~100）。不需要 record —— inbound 在拿到会话记录之前就要用，
   * 拿它去算「这一批消息等多久再回」：越烦等得越久。
   */
  function igniteOf(scope, peerId) {
    const st = states.get(`${scope}:${peerId}`)
    if (!st) return 0
    // 现算一次衰减，别拿几分钟前的旧值去决定等待时长
    try {
      decay(st, Date.now())
    } catch {
      /* 衰计算不出来也不影响 */
    }
    return Math.max(0, Math.min(100, st.ignite))
  }

  /**
   * 这一轮要等多久再回（合并窗口）。
   *
   * 烦躁度 0 → `groupMergeWindowMs`（默认 2.5 秒，积极接话）
   * 烦躁度顶到阈值 → `groupMergeWindowMaxMs`（默认 15 秒，懒得马上接）
   * 中间线性滑。
   *
   * 放在这儿而不是 inbound 里内联，是为了让**状态页显示的值**和**实际用的值**
   * 永远出自同一个公式 —— 两边各算一遍，迟早分叉（姐姐已经在别的地方踩过了）。
   */
  function mergeWindowOf(scope, peerId) {
    // 2026-11-04：改成读**这个群自己的**配置。以前写的是模块级的 `config`，
    // 于是群设置页里那两栏「接话节奏」改了对等待时长毫无影响 ——
    // 页面上的数字变了、行为没变，正是那种"看着在动、其实没接上"的坑。
    const cfg = resolveConfig(peerId)
    const min = Math.max(0, num(cfg?.groupMergeWindowMs, 2500))
    // 明确关掉（0）就是关掉，别因为烦躁度高又给开回来
    if (min <= 0) return 0
    if (!enabled(cfg)) return Math.round(min)
    const max = Math.max(min, num(cfg?.groupMergeWindowMaxMs, 15_000))
    // 按逃离阈值归一：烦躁度顶到"要走人"的程度，就该等满上限
    const thr = Math.max(1, thrOf(cfg).escape)
    const ig = igniteOf(scope, peerId)
    const t = Math.min(1, Math.max(0, ig / thr))
    return Math.round(min + (max - min) * t)
  }

  /** 能不能主动开口（wake.js 的冷场冒泡）。
   *
   * ⚠️ 2026-11-01 让位：冷窗/无视期间一律不许。理由有两层 ——
   *   ① 冷窗这会儿正在攒消息，突然冒一句"没人说话啊"，接的是空气；
   *   ② 冷窗里它本来就决定闭嘴了，主动开口等于自己推翻自己。
   * 代价是原版那条「安静 20 分钟给一次机会」在有节奏时基本不会被触发 ——
   * 那是刻意的：冷窗到期那次 flush 本来就会带话回来，不需要再补一次闹钟。
   */
  function canSpeak(record) {
    if (!enabled()) return true
    if (groupsOnly() && record?.scope !== 'group') return true
    const st = states.get(keyOf(record))
    if (!st) return true
    return st.phase === 'hot'
  }

  function forget(record) {
    if (!record) return
    states.delete(keyOf(record))
  }

  /**
   * 热窗切冷窗的那一刻叫一声。
   *
   * 2026-11-02 姐姐的原话：「有概率热窗期间有消息但被回复延时卡住直接进冷窗，
   * 应该在切换时缓冲区有消息就全传给智能体，没有就进冷窗」。
   *
   * 以前这里是硬切：`enterCold()` 顺手把 `st.hold` 清空，inbound 那边攒着的
   * backlog / history 也没人管，于是刚好卡在边界上的那几句要等到冷窗结束
   * （十几分钟）才被端出来。现在切之前先通知一声，让它自己决定交不交。
   */
  let onHotEnd = null

  /** 「下一次换档」的精确定时器（15 秒的 interval 只当兜底，见 scheduleNext）。 */
  let dueTimer = null

  function setHotEndHandler(fn) {
    onHotEnd = typeof fn === 'function' ? fn : null
  }

  /**
   * 热窗 → 冷窗，**唯一的一个口子**。
   *
   * 2026-11-04 之前有两条路能关掉热窗：
   *   · `tick()` 到点 —— 会通知 inbound（2026-11-02 加的）
   *   · `gate()` 里那条兜底 —— 静悄悄 `enterCold()`，不通知
   * 谁先到算谁。消息恰好在边界上进来时是 gate 先到，收尾就整个丢了。
   * 现在两条路都走这儿：先切相位（这样下面投出去的话不会被当成热窗活动），
   * 再喊一声，喊的时候 st.phase 已经是 cold。
   */
  function finishHot(key, st, now = Date.now()) {
    const label = st.label
    const span = st.span
    enterCold(st, now)
    logger.debug?.(
      `[dsh-qq] ${label || key} 热窗结束（原定 ${Math.round(span / 1000)}s），进冷窗 ${Math.round(st.span / 60000)} 分钟`,
    )
    // 没交出去的东西由 inbound 从 backlog / pending / history 里捞，这里只负责喊一声。
    try {
      const at = String(key).indexOf(':')
      onHotEnd?.({
        scope: at > 0 ? String(key).slice(0, at) : 'group',
        peerId: at > 0 ? String(key).slice(at + 1) : String(key),
        label,
      })
    } catch (err) {
      logger.warn?.(`[dsh-qq] 热窗收尾回调失败 ${key}: ${err?.message ?? err}`)
    }
  }

  function tick(now = Date.now()) {
    if (stopped) return
    for (const [key, st] of states) {
      try {
        decay(st, now)
        // 15 秒一个点：这是曲线的主要来源，相位切换那几下另外 force 落点
        sample(st, now)
        if (st.phase === 'hot' && now >= st.untilAt) {
          finishHot(key, st, now)
          continue
        }
        if (st.phase === 'cold' && now >= st.untilAt) {
          void flushKey(key, 'cold')
          enterHot(st, now)
          continue
        }
        if (st.phase === 'ignore') {
          const why = ignoreShouldEnd(st, now)
          if (!why) continue
          void flushKey(key, 'ignore')
          exitIgnore(st, now)
          logger.info?.(`[dsh-qq] ${st.label} 无视冷窗结束（${why}）`)
        }
      } catch (err) {
        logger.warn?.(`[dsh-qq] 节奏 tick 失败 ${key}: ${err?.message ?? err}`)
      }
    }
    scheduleNext(now)
  }

  /**
   * 精确到点：把下一次「换档」排成一个 setTimeout。
   *
   * 2026-11-03 姐姐报「热窗显示还剩 3 秒，3 秒过了一点动静都没有」。
   * 原因就是这里只有 `setInterval(tick, 15s)`：倒计时是页面按 untilAt 自己算的，
   * 每秒走一格；可真的切换要等 tick 落到这一刻 —— 最坏要再等 14 秒。
   * 没人说话的时候尤其明显：没有任何消息事件来顺手触发一次检查。
   *
   * 所以每次 tick 完，把「所有状态里最早的 untilAt」排一个定时器；
   * 15 秒的 interval 留着当兜底（decay / 采样 / ignore 的 stats 模式判定）。
   */
  function scheduleNext(now) {
    if (dueTimer) {
      clearTimeout(dueTimer)
      dueTimer = null
    }
    let nextAt = 0
    for (const [, st] of states) {
      const u = Number(st.untilAt) || 0
      if (u > now && (nextAt === 0 || u < nextAt)) nextAt = u
    }
    if (nextAt <= 0) return
    // +50ms：别卡在毫秒边界上，免得算出 now >= untilAt 差一点点不成立又要再等一轮
    const delay = Math.max(50, Math.min(60_000, nextAt - now + 50))
    dueTimer = setTimeout(() => {
      dueTimer = null
      tick()
    }, delay)
    dueTimer.unref?.()
  }

  function start() {
    if (!stopped) return
    stopped = false
    timer = setInterval(() => tick(), TICK_MS)
    timer.unref?.()
    logger.info?.(
      `[dsh-qq] 群聊节奏已启动：热窗 ${Math.round(hotMin() / 1000)}–${Math.round(hotMax() / 1000)}s，` +
        `冷窗 ${Math.round(coldMin() / 60000)}–${Math.round(coldMax() / 60000)}min（把最近 ${coldKeep()} 条带回来），` +
        `无视模式 ${config?.ignoreMode ?? 'fixed'}，阈值 冷静 ${readThresholds(config).calm} / 愤怒 ${readThresholds(config).anger} / 逃离 ${readThresholds(config).escape}`,
    )
  }

  function stop() {
    stopped = true
    if (timer) clearInterval(timer)
    timer = null
    if (dueTimer) clearTimeout(dueTimer)
    dueTimer = null
    states.clear()
  }

  return {
    start,
    stop,
    tick,
    gate,
    noteReply,
    settleCold,
    forceIgnore,
    releaseIgnore,
    snapshot,
    allSeries,
    isHolding,
    inHot,
    phaseOf,
    igniteOf,
    mergeWindowOf,
    canSpeak,
    forget,
    flushKey,
    setHotEndHandler,
    bumpIgnite,
    moodText,
    // 测试用
    _states: states,
    _scoreOf: scoreOf,
  }
}
