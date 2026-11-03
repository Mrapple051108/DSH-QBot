/**
 * 群消息缓冲：收到就往里塞，真发一轮时**全取走并清空**。
 *
 * 2026-11-01 姐姐改的语义：
 *   原来是「最近 N 条的滑动窗」—— 每个回合都把同样那 N 条原样再塞一遍，
 *   哪怕它上一轮刚看过、刚回过。既白烧 token，又让它以为人家在重复说。
 *   现在是消费型缓冲：`limit` 从"带几条"变成"最多存几条"，取走就空。
 *
 * 单独放一个文件是为了能直接被测试 import —— 挂在 inbound.js 里的话，
 * 一条 `@deepseek-ai/dsh-llm` 的依赖就能让裸 node 跑不起来。
 */

/** 兜底上限：`historyLimit` 配成 0 时也不能让缓冲无限涨。 */
export const HISTORY_HARD_MAX = 200

export function pushHistory(record, entry, limit) {
  if (!record || !entry) return 0
  if (!Array.isArray(record.history)) record.history = []
  const keep = Math.max(0, Number(limit) || 0) || HISTORY_HARD_MAX
  record.history.push(entry)
  if (record.history.length > keep) {
    record.history.splice(0, record.history.length - keep)
  }
  return record.history.length
}

/** 取走全部并清空。返回值就是这一轮要摆到它眼前的那批。 */
export function takeHistory(record) {
  if (!record || !Array.isArray(record.history) || record.history.length === 0) return []
  return record.history.splice(0)
}

/**
 * 把连续的相同行压成一行带 `×N`。
 *
 * 2026-11-01 姐姐发的截图：群里连发四张图，缓冲里就是四行一模一样的
 * `⟨苹果三块一斤 (1718935283) · 老大 11-01 周日 20:44（晚上）⟩ [图片]` ——
 * 模型看不出是「一张发了四遍」还是「四张不同的图」，只看见一坨重复。
 * 压成 `…⟩ [图片] ×4`：数量还在，噪音没了。
 *
 * 只压**紧挨着**的完全相同行 —— 中间夹了别人的话就不压，那是两波刷屏。
 */
export function compactLines(list) {
  const out = []
  for (const line of list ?? []) {
    const last = out[out.length - 1]
    if (last && last.text === line) {
      last.n += 1
      continue
    }
    out.push({ text: line, n: 1 })
  }
  return out.map((x) => (x.n > 1 ? `${x.text} ×${x.n}` : x.text))
}
