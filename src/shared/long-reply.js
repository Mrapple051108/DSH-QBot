/**
 * 长文本回复惩罚（2026-11-04 姐姐要的第五条烦躁度来源）。
 *
 * 以前的烦躁度只由**别人说的话**驱动：冗余度、@ 频率、同一个人纠缠、复读连击。
 * 但自己一口气甩一大段同样费力 —— 姐姐的原话：
 *   「如果连续多次回复长文本也去增加烦躁度」。
 *
 * 所以这里是第三条腿：**自己的输出**也记账。连着第 n 次长回复给多少分，
 * 由「惩罚方式」决定：
 *
 *   fixed   固定惩罚     —— 每次都给基础值（不涨）
 *   linear  线性增长     —— 第 n 次给 base × n
 *   power   幂函数增长   —— 第 n 次给 base × n^力度
 *   exp     指数函数增长 —— 第 n 次给 base × 力度^(n-1)
 *
 * ⚠️ 纯函数，不读盘不碰 config：`rhythm.js` 传一份配置进来，测试直接喂参数。
 *    `view/rhythm.html` 里有一份同样的公式（页面要跟着输入框实时重算，拿不到模块），
 *    改这边记得同步那边 —— 两边都写了注释。
 */

const CURVES = ['fixed', 'linear', 'power', 'exp']

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0))

/** 惩罚方式（设置页下拉用）。 */
export const LONG_REPLY_CURVES = [
  { value: 'fixed', label: '固定惩罚（每次都加基础值）' },
  { value: 'linear', label: '线性增长（第 n 次 × n）' },
  { value: 'power', label: '幂函数增长（第 n 次 × n^力度）' },
  { value: 'exp', label: '指数函数增长（第 n 次 × 力度^(n-1)）' },
]

/**
 * 把配置读成一组干净的参数。
 *
 * 默认值挑的是「不吓人但有用」：400 字算长、基础 6 分、线性。
 * 线性下第 2 次 +12、第 3 次 +18、第 4 次 +24 —— 连着说四段长话
 * 累计 54 分，差不多刚好从平静顶到愤怒档，正是想要的手感。
 */
export function readLongReplyConfig(cfg = {}) {
  const n = (v, d) => {
    const x = Number(v)
    return Number.isFinite(x) ? x : d
  }
  return {
    enabled: cfg?.longReplyPenalty !== false,
    chars: Math.max(20, Math.round(n(cfg?.longReplyChars, 400))),
    base: clamp(n(cfg?.longReplyBase, 6), 0, 100),
    curve: CURVES.includes(String(cfg?.longReplyCurve)) ? String(cfg.longReplyCurve) : 'linear',
    gamma: clamp(n(cfg?.longReplyGamma, 1.5), 1.05, 3),
  }
}

/**
 * 这段文本算不算「长」。
 *
 * 字数按**去掉空白**之后算：中文没空格，但 markdown 表格、代码缩进、换行
 * 都会把原始长度撑起来 —— 一段三十行的配置贴过来，"看起来"两千字，
 * 真正读进去的信息量可能就几百。去空白更接近「这一口气说了多少」。
 */
export function isLongReply(text, opts = {}) {
  const chars = Math.max(20, Math.round(Number(opts.chars) || 400))
  const body = String(text ?? '').replace(/\s+/g, '')
  return body.length >= chars
}

/** 字数（去空白），日志和面板都用它，别两处各算一遍。 */
export function longReplyCharsOf(text) {
  return String(text ?? '').replace(/\s+/g, '').length
}

/**
 * 这些字数够不够算一次长文本。
 *
 * 2026-11-04 晚：判定单位从「一次投递」改成「一轮」，所以入口从**文本**换成**字数** ——
 * 一轮里可能发了好几次（分段正文 + 几次 `qq_send`），调用方自己把字数加起来再问这句话。
 */
export function meetsLongReply(chars, opts = {}) {
  const need = Math.max(20, Math.round(Number(opts.chars) || 400))
  return Math.max(0, Math.round(Number(chars) || 0)) >= need
}

/**
 * 占位记账：`[图片]`、`[表情 1]`、`[文件] a.zip`、`[表情包] 无语`。
 *
 * 这些是插件自己往流水里写的「发了点什么」，不是"说话"。
 * 它们又短又不带内容，扔进长文本判定会被当成「这一轮说得很短」——
 * 于是连着两段长话之间发一张表情包，连续计数就被清了。发图和说话是两件事。
 *
 * 这里只认**开头**（`[文件] 前面那段是文件名`、`[表情包] 后面是描述` 都算占位）：
 * 模型的正文几乎不可能以这几种方括号标记开头 —— 那是插件自己的流水格式。
 * `tools.js` 里另外还显式传了 `{ speak: false }`，两道保险。
 */
const PLACEHOLDER_SAID = /^\s*\[(?:图片|表情包|表情|文件)[^\]]*\]/

export function isPlaceholderSaid(text) {
  return PLACEHOLDER_SAID.test(String(text ?? ''))
}

/**
 * 连续第 `streak` 次长回复，这一击加多少分。
 *
 * **第 1 次返回 0**：说一段长的很正常，那一下只记账不罚（"连续多次"才是病因）。
 * 从第 2 次起才真正往上顶。
 *
 * @param {number} streak 这一次是连续第几次长回复（1 起）
 * @param {{base?:number, curve?:string, gamma?:number}} opts readLongReplyConfig 的结果
 * @returns {number} 0~100 的分
 */
export function longReplyStep(streak, opts = {}) {
  const n = Math.round(Number(streak) || 0)
  if (n <= 1) return 0
  const base = Math.max(0, Number(opts.base) || 0)
  if (base <= 0) return 0
  const curve = CURVES.includes(String(opts.curve)) ? String(opts.curve) : 'linear'
  const gamma = clamp(Number(opts.gamma) || 1.5, 1.05, 3)
  let v = base
  if (curve === 'linear') v = base * n
  else if (curve === 'power') v = base * Math.pow(n, gamma)
  else if (curve === 'exp') v = base * Math.pow(gamma, n - 1)
  return Math.round(clamp(v, 0, 100) * 10) / 10
}

/**
 * 面板上那张小图的数据：第 n 次各加多少、累计到多少（累计夹在 100）。
 *
 * @param {number} maxN 画到第几次（默认 8）
 * @param {object} opts readLongReplyConfig 的结果
 * @returns {Array<{n:number, step:number, total:number}>}
 */
export function longReplySeries(maxN = 8, opts = {}) {
  const out = []
  let total = 0
  const cap = Math.max(1, Math.round(Number(maxN) || 8))
  for (let n = 1; n <= cap; n += 1) {
    const step = longReplyStep(n, opts)
    total = clamp(total + step, 0, 100)
    out.push({ n, step, total: Math.round(total * 10) / 10 })
  }
  return out
}
