/**
 * 「这个工具发出去的东西，算不算这一轮说的话」。
 *
 * 为什么要有这张表：一个 turn 里 assistant 可能既调工具、又写正文。
 * 如果工具已经把某句话发给 QQ 了，正文再自动转发一遍，群里就会出现
 * 「同样一句话连着两条」的鬼影 —— 所以要认得出哪些工具是在说话。
 *
 * 但**发图 != 说话**。她完全可以「甩一张表情包 + 接着补一句」，
 * 这两样都应该送到对方眼前。
 *
 * 2026-11-02 修：以前把 qq_mface / qq_face / qq_send_image / qq_send_file 也塞进这张表，
 * 于是这一轮只要发过表情包，`outbound` 看到 `selfSent` 已置位就把后面**所有文本**
 * 当成"已经说过了"整条 return 掉 —— 群里看到的就是「表情包正常出来了，话没了」。
 * 判断标准和注释里早就写过的一样：互动 / 发图不是发言，只有 qq_reply、qq_send 是。
 */

/** 真的在说话的工具：它们发出去的文字就是正文，别再转发一遍。 */
export const SELF_SENDING_TOOLS = new Set(['qq_reply', 'qq_send'])

/**
 * 这个工具发了东西之后，本轮的正文还能不能自动转发。
 * @param {string} name 工具名
 * @returns {boolean} true = 工具已经把话说了，正文别再发
 */
export function toolSaysItself(name) {
  return SELF_SENDING_TOOLS.has(String(name ?? '').trim())
}

/**
 * 「只会发图、不会发字」的工具。
 *
 * outbound 里还有一道闸：`hasToolUse(message)` 为真就整条不发 —— 那是为了
 * 掐掉「我查一下」「好，我看看」这种动手前的过场话。可它不分工具：
 * 一条消息里写着「嘿嘿，好看吧」又顺手调 qq_mface，正文照样被整条吞掉。
 * 所以纯视觉类工具要单独放行。
 */
export const VISUAL_TOOLS = new Set(['qq_mface', 'qq_face', 'qq_send_image', 'qq_send_file'])

/** 把一条消息里的工具名都揪出来（宿主用 tool-call 块，名字在 toolName 上）。 */
export function toolNamesOf(message) {
  const content = message?.content
  if (!Array.isArray(content)) return []
  const out = []
  for (const part of content) {
    if (!part || !/tool|function/i.test(String(part.type ?? ''))) continue
    const name = String(part.toolName ?? part.name ?? part.tool?.name ?? '').trim()
    if (name) out.push(name)
  }
  return out
}

/**
 * 这条消息带着的 tool-call 是不是清一色「只发图」。
 * 是 → 正文不是过场话，是正经要说的话，不能因为带 tool-call 就丢掉。
 */
export function toolsAreVisualOnly(message) {
  const names = toolNamesOf(message)
  return names.length > 0 && names.every((n) => VISUAL_TOOLS.has(n))
}
