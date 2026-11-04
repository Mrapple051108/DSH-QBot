/**
 * 「对话窗口」（@ 之后那段免 @ 期）的开 / 关历史。
 *
 * 2026-11-04 姐姐的要求：
 *   「@ 之后不是会有一个计时器吗？到点以后应该在状态面板上显示，
 *     以及曲线也变成虚线」。
 *
 * 于是要两份东西：
 *   · **现在** —— 窗口还开着吗、还剩多久（面板上那行倒计时，到点变「已到点」）；
 *   · **过去** —— 哪些时段在窗口里、哪些不在（曲线上窗口外的部分画虚线：
 *     那几段它其实没有开口的资格，曲线起伏只是"群里有人在说话"，不是它在接话）。
 *
 * 只记「开 / 关」两个事件，区间现算，免得存两份还容易对不上。
 * 放成纯模块是为了能单独测 —— 这段判定跟节奏层一样，被改坏过一次就够呛。
 */

/** 群号 -> [{ at, kind: 'open' | 'close' }]，按时间顺序 */
const spans = new Map()

const CAP = 120

/**
 * 记一笔。
 *
 * 连续的「开」只留第一次：窗口续期（groupWakeRenew 开着时每次 @ 都续）
 * 不该把一段切成好几段，否则曲线上会冒出一堆没意义的竖线。
 */
export function noteWakeSpan(groupId, kind, at = Date.now()) {
  const gid = String(groupId ?? '').trim()
  if (!gid) return
  if (kind !== 'open' && kind !== 'close') return
  const arr = spans.get(gid) ?? []
  const last = arr[arr.length - 1]
  if (!(last && last.kind === 'open' && kind === 'open')) arr.push({ at, kind })
  if (arr.length > CAP) arr.splice(0, arr.length - CAP)
  spans.set(gid, arr)
}

/** 这个群的事件流水（副本，外面改不到内部状态）。 */
export function spansOf(groupId) {
  const arr = spans.get(String(groupId ?? '').trim())
  return arr ? arr.map((e) => ({ ...e })) : []
}

/**
 * 事件流水 → 「窗口开着的区间」。
 *
 * @param {Array<{at:number,kind:string}>} list
 * @param {number} [until] 现在还开着的那个窗口的到期时间（0 = 不知道）
 * @param {number} [now]
 * @returns {Array<[number, number]>} `[开, 关]`；还开着的那个 `关` = until
 */
export function spansToRanges(list, until = 0, now = Date.now()) {
  const ranges = []
  let openAt = 0
  for (const e of Array.isArray(list) ? list : []) {
    if (e?.kind === 'open') {
      if (!openAt) openAt = Number(e.at) || 0
    } else if (openAt) {
      ranges.push([openAt, Number(e.at) || openAt])
      openAt = 0
    }
  }
  if (openAt) ranges.push([openAt, Math.max(openAt, Number(until) || now)])
  return ranges.slice(-12)
}

/** 某一刻在不在窗口里（画曲线用）。 */
export function inAnyRange(ranges, t) {
  for (const r of Array.isArray(ranges) ? ranges : []) {
    if (t >= r[0] && t <= r[1]) return true
  }
  return false
}

/** 测试用：把账清空，免得用例之间串。 */
export function resetWakeSpans() {
  spans.clear()
}
