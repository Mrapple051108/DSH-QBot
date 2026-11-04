/**
 * 热窗到点那一刻的判定与文案。纯函数，不碰宿主，能单独测。
 *
 * 为什么要把这段从 inbound.js 里拎出来 —— 2026-11-04 姐姐报的两个毛病：
 *
 *   ①「热窗换到冷窗时没有发送消息，原本是有热窗换冷窗会把缓冲区的消息
 *      发给它的，回了就继续热窗，选择不回就切冷窗」
 *   ②「抽中的时间没人说话，到点以后却没有收到消息，然后一直顶到
 *      我设置的（冷窗）上限才回」
 *
 * 这两个是同一个根：1.3.2 为了修「窗口关掉了还在回话」，把收尾改成
 * **只交 `pending`**（该回却被间隔/额度压住的那几条）。可是热窗里根本没
 * 那两道闸 —— `skipGap` 让间隔闸在热窗里失效，额度默认 0 = 不限 ——
 * 于是 `pending` 在热窗里几乎永远是空的，`flushBuffersOnHotEnd` 每次都
 * 在第一行就 return 了。收尾等于被整个删掉：那几句要么等冷窗到期
 * （6~15 分钟）才被端出来，要么就此消失。
 *
 * 修法不是把 1.3.1 那套整桶端回去（那才会重新犯「接别人的闲聊」的错），
 * 而是把判断条件从「谁记在哪个账上」换成**「它现在有没有开口的资格」**：
 *
 *   · 必须 @ 才接话的群 —— 只有 @ 开出来的对话窗口**还开着**才交；
 *     窗口早关了（1.1.3 那次事故：23:11:58 关窗，23:23:39 还在回）
 *     就闭嘴进冷窗。这是 1.1.3 真正要防的东西。
 *   · 不用 @ 的群（`mentionMode: never`）—— 本来就允许它主动接话，照交。
 *
 * 资格有了，剩下就交给它自己：交出去的话里写清「想接就接一句，
 * 接了热窗就续上；不想接就回 [SILENT]，那我就进冷窗」—— 回不回是它
 * 的决定，不是代码替它决定。
 */

/** 一次最多交几条上下文（别人的话）—— 只给"刚才在聊什么"，不是给一本账。 */
export const CONTEXT_MAX = 12
/** 一次最多交几条该回没回的 —— 正常情况下就一两条，给个兜底上限。 */
export const PENDING_MAX = 20

/**
 * 热窗到点的这一刻，它有没有资格开口。
 *
 * @param {object} o
 * @param {boolean} o.needMention 这个群是不是「必须 @ 才接话」
 * @param {number} o.wakeUntil 这个群所有对话窗口里最晚的一个到期时间（0 = 一个都没开）
 * @param {number} [o.now]
 * @returns {{ speak: boolean, reason: 'open' | 'closed' | 'free' }}
 */
export function hotEndStanding({ needMention, wakeUntil = 0, now = Date.now() } = {}) {
  if (needMention !== true) return { speak: true, reason: 'free' }
  if (Number(wakeUntil) > Number(now)) return { speak: true, reason: 'open' }
  return { speak: false, reason: 'closed' }
}

/**
 * 交什么。两头都留个上限，取**最新的**那几条（老的已经没人在接了）。
 *
 * @param {object} o
 * @param {string[]} [o.pending] 该回却被压住的
 * @param {string[]} [o.context] 这期间别人说的话（只当上下文）
 * @param {number} [o.maxPending]
 * @param {number} [o.maxContext]
 * @returns {{ pending: string[], context: string[], total: number }}
 */
export function hotEndLines({
  pending = [],
  context = [],
  maxPending = PENDING_MAX,
  maxContext = CONTEXT_MAX,
} = {}) {
  const keep = (arr, max) => {
    const list = Array.isArray(arr) ? arr.filter(Boolean) : []
    const cap = Math.max(1, Math.round(Number(max) || 1))
    return list.length > cap ? list.slice(list.length - cap) : list
  }
  const p = keep(pending, maxPending)
  const c = keep(context, maxContext)
  return { pending: p, context: c, total: p.length + c.length }
}

/**
 * 交出去的那段话。
 *
 * 三种口气分得很清楚，因为它们在模型眼里是三种东西：
 *   · 该回没回的 → 有人在等我
 *   · 别人的闲聊 → 只是知道一下，不一定要接
 *   · 出口 → 接了续热窗 / [SILENT] 进冷窗（这条是姐姐 2026-11-04 要的那句）
 */
export function hotEndText({ label = '', pending = [], context = [] } = {}) {
  const words = []
  if (pending.length > 0) {
    words.push('[这几句是冲你来的 / 你还压着没回的：]', ...pending.map((line) => `- ${line}`))
  }
  if (context.length > 0) {
    if (words.length > 0) words.push('')
    words.push(
      '[这期间群里说的——不一定是在叫你，只是让你知道刚才在聊什么：]',
      ...context.map((line) => `- ${line}`),
    )
  }
  words.push(
    '',
    '热窗到点了，走之前就这一下：想接就接一句，说出口热窗就接着续上；',
    '不想接、或者这会儿插不进嘴，就只回 [SILENT]——那我就进冷窗待着。',
    '一句就够，别解释、别总结刚才聊了啥。',
  )
  return words.join('\n')
}

/**
 * 对话窗口到期（@ 之后那段免 @ 期走完）的交待。
 *
 * 姐姐 2026-11-04 的原话：「到点以后会触发回复，但发给它的消息就只叫它说再见，
 * 而不带缓冲区消息。应该让它把缓冲区的回复一下，然后再告别」。
 *
 * 所以顺序在这儿钉死：**先回话，再收尾**。以前那版把缓冲当注脚塞在最前面，
 * 主体指令是"说一句你要去忙了"，于是它经常只念了告别，那几句再也没人回。
 *
 * 有「冲你来的」那几句时不给沉默出口 —— 既然已经决定了要走，也得先把话接完；
 * 只有别人闲聊 / 什么都没攒时，才允许它 [SILENT] 悄悄收摊。
 */
export function farewellText({ pending = [], context = [] } = {}) {
  const words = ['[你跟这个群说话的那一段到点了]']
  const hasPending = pending.length > 0
  if (hasPending) {
    words.push(
      '',
      '[走之前先把这几句回掉（有人正等着，这次不给沉默出口）：]',
      ...pending.map((line) => `- ${line}`),
    )
  }
  if (context.length > 0) {
    words.push(
      '',
      '[这期间群里说的，看一眼就行，不一定都要接：]',
      ...context.map((line) => `- ${line}`),
    )
  }
  words.push(
    '',
    hasPending ? '先回话，再告别：回完这几句，' : '',
    '最后说一句你要去忙 / 休息了，有事再 @ 你。',
    '回完就收摊，别再顺着往下聊。一句就够，别解释、别总结刚才聊了啥。',
    hasPending ? '这次不给沉默出口 —— 先把话接完再走。' : '实在没什么想说的就回 [SILENT]，悄悄收摊。',
  )
  return words.filter(Boolean).join('\n')
}
