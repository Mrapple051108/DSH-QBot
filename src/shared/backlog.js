/**
 * 群消息的两个缓冲账本：`backlog`（别人的话）和 `pending`（该回却被压住的）。
 *
 * 为什么分开 —— 2026-11-03 姐姐报的事故：
 *   「770375717 那个群我设置的 @ 后回话为 600 秒，为什么过了 20 分钟它还在回复我」
 *
 * 查日志：23:01:58 @ 它 → 600 秒的窗口本该 23:11:58 关掉；
 * 23:21:51 / 23:22:03 群友发了三个文件（**没 @ 它**）→ 按规则该跳过；
 * 23:23:39 热窗到点，`flushBuffersOnHotEnd` 把 backlog 整桶当成
 * 「你压着还没回的话」端到它面前，还配了句「想接就接一句」——
 * 于是它把别人的话顺口接了。窗口没问题，是收尾那一手张冠李戴。
 *
 * 从这儿起语义钉死：
 *   · backlog  —— 没叫我的、被规则跳过的。只当**上下文**补给它看，跳过 ≠ 要回。
 *   · pending  —— 真该回、只是被回复间隔 / 窗口额度挡住的。热窗收尾时**才**交出去。
 *
 * 两个账都是消费型的：收到就塞，取走就空，不会越攒越多。
 */

const BACKLOG_MAX = 30

/** 群号 -> 行数组（上下文账） */
const backlog = new Map()
/** 群号 -> Map<行, 剩余条数>（待回账；元素是 backlog 里的同一批字符串，用计数是因为同一句话可能被压两次） */
const pending = new Map()

/**
 * 记一行。
 *
 * @param {string|number} groupId 群号
 * @param {string} entry 已经拼好的一行（带时间戳和说话人）
 * @param {number} [limit] 容量，默认 30
 * @param {{ pending?: boolean }} [opts] `pending: true` = 这条该回，只是被压住了
 */
export function keepBacklog(groupId, entry, limit, opts) {
  if (!groupId || !entry) return
  const cap = Math.max(1, Number(limit) || BACKLOG_MAX)
  const arr = backlog.get(groupId) ?? []
  arr.push(entry)
  const dropped = arr.length > cap ? arr.splice(0, arr.length - cap) : []
  backlog.set(groupId, arr)
  if (!opts?.pending) return
  const counts = pending.get(groupId) ?? new Map()
  counts.set(entry, (counts.get(entry) ?? 0) + 1)
  // 被挤出容量的老行，从待回账里一起扣掉，不然永远取不到、还会误配
  for (const gone of dropped) {
    const c = counts.get(gone) ?? 0
    if (c <= 1) counts.delete(gone)
    else counts.set(gone, c - 1)
  }
  if (counts.size > 0) pending.set(groupId, counts)
  else pending.delete(groupId)
}

/** 取走全部并清空（上下文用：补进上下文一次就够，别每次都倒一遍陈年旧账）。 */
export function drainBacklog(groupId) {
  const arr = backlog.get(groupId) ?? []
  backlog.delete(groupId)
  pending.delete(groupId)
  return arr
}

/**
 * 只摘「该回却被压住」的那几条，其余原样留在 backlog 里当上下文。
 *
 * @returns {{ pending: string[], rest: string[] }}
 */
export function drainPending(groupId) {
  const counts = pending.get(groupId)
  pending.delete(groupId)
  const arr = backlog.get(groupId) ?? []
  if (!counts || counts.size === 0) return { pending: [], rest: arr }
  const hit = []
  const rest = []
  for (const line of arr) {
    // 同文按登记的条数认领：两句一样的话被压住，这里就该还两句
    const c = counts.get(line) ?? 0
    if (c > 0) {
      hit.push(line)
      counts.set(line, c - 1)
      continue
    }
    rest.push(line)
  }
  if (rest.length > 0) backlog.set(groupId, rest)
  else backlog.delete(groupId)
  return { pending: hit, rest }
}

/** 测试和状态页用：现在攒着多少条。 */
export function backlogSize(groupId) {
  let wait = 0
  for (const c of (pending.get(groupId) ?? new Map()).values()) wait += c
  return {
    backlog: (backlog.get(groupId) ?? []).length,
    pending: wait,
  }
}

/** 测试用：把账本清空，免得用例之间互相串。 */
export function resetBacklog() {
  backlog.clear()
  pending.clear()
}
