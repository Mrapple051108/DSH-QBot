/**
 * 「你被叫之前，群里最近在聊什么」—— 挑几条给模型垫着。
 *
 * 2026-11-02 事故（姐姐的截图）：昨天让她「记一下，这个咕咕嘎嘎是个坏蛋」，
 * 今天又被翻上来了。原因是补上下文那条路没设时间上限：
 *   - `record.lastDeliverAt` 是内存字段，插件一重启就没了 → 水位当作 0；
 *   - 于是从聊天流水里往回翻，翻到昨天的「附近的消息」端到她眼前。
 * 同时还有第二个洞：流水里**既有别人也有她自己**（`noteSelfSaid` 也写流水），
 * 补回来就变成她读自己的台词，还以为群友这么说过。
 *
 * 所以这里的四条过滤缺一不可：
 *   ① 跳过自己（uid === selfId）
 *   ② 早于 floor 的不要（floor = 投递水位 与「往回翻多久」取更严的那个）
 *   ③ 空文本不要
 *   ④ 完全相同的行只留一条（重放 / 重复投递会留下一样的）
 */

/**
 * @param {Array<{uid?:string|number, at?:number, name?:string, text?:string}>} rows
 * @param {{selfId?:string, floor?:number, limit?:number}} [opts]
 * @returns {string[]} 形如 `名字：内容`，按原顺序，最多 limit 条
 */
export function pickWakeLines(rows, { selfId = '', floor = 0, limit = 10 } = {}) {
  const self = String(selfId ?? '').trim()
  const low = Number(floor) || 0
  const cap = Math.max(0, Number(limit) || 0)
  const out = []
  const seen = new Set()

  for (const row of rows ?? []) {
    if (!row) continue
    // ① 自己的话不是"附近在聊的"
    if (self && String(row.uid ?? '') === self) continue
    // ② 时间闸（at 缺失的放行：宁可多带一条，别因为没时间戳把新消息漏了）
    const at = Number(row.at) || 0
    if (low > 0 && at > 0 && at <= low) continue
    // ③ 流水行尾挂着 `#msg=123456`（给 qq_images 事后捞图用的），补上下文得剥掉 ——
    //    不然模型眼前全是消息编号，还以为那是聊天内容。
    const text = String(row.text ?? '')
      .replace(/\s*#msg=\d+\s*$/, '')
      .trim()
    if (!text) continue
    const line = `${String(row.name ?? '').trim() || row.uid || '?'}：${text}`
    // ④ 重放留下的同款行
    if (seen.has(line)) continue
    seen.add(line)
    out.push(line)
  }

  return cap > 0 ? out.slice(-cap) : out
}
