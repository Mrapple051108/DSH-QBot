/**
 * 「这条消息已经处理过了」的账本。
 *
 * 2026-11-02 事故：一整段 prompt（时间戳 + 引用 + 群历史）在群里**原样出现两遍**，
 * 日志里同一条 `← 群 …` 也在同一毫秒打了两行。原因是同一条消息被处理了两次：
 *   ① `client.js` 的 `#connect()` 以前不关旧 socket，半开的旧连接和新连接一起收推送；
 *   ② 插件被重复 apply（热重载没走 dispose）时，两个 client 各连一次 NapCat。
 *
 * 两处都已经从源头修了，但去重这层还得留着 —— 上游什么时候再多给你一遍，
 * 这边不能再陪一遍。**放在模块级**：`②` 那种两个实例的情况，
 * 只有共享同一本账才挡得住。
 */

/**
 * 建一本账。
 *
 * @param {object} [opts]
 * @param {number} [opts.ttl]  多久之内算"同一条"（QQ 消息 id 会复用，别留太久）
 * @param {number} [opts.max]  账本上限，超了顺手清过期的
 * @param {() => number} [opts.now] 取时间，测试里可注入
 */
export function createSeenTracker({ ttl = 5 * 60_000, max = 800, now = () => Date.now() } = {}) {
  const seen = new Map()

  /** 清理过期的，别让 Map 无限涨。 */
  function sweep(t) {
    if (seen.size <= max) return
    for (const [k, v] of seen) {
      if (t - v > ttl) seen.delete(k)
    }
    // 全是新鲜的还超了 → 从最老的开始丢，保证有界
    if (seen.size > max) {
      const drop = seen.size - max
      let i = 0
      for (const k of seen.keys()) {
        seen.delete(k)
        if (++i >= drop) break
      }
    }
  }

  return {
    /**
     * 登记一条。
     * @param {string} key 去重键（空串直接算"没见过"，交给上层放行）
     * @returns {boolean} true = 第一次见（继续处理），false = 之前见过（丢掉）
     */
    mark(key) {
      if (!key) return true
      const t = now()
      const at = seen.get(key)
      if (at !== undefined && t - at < ttl) return false
      seen.set(key, t)
      sweep(t)
      return true
    },
    size: () => seen.size,
    clear: () => seen.clear(),
  }
}

/**
 * 从一条 OneBot 消息事件里取稳定的去重键。
 *
 * 多个机器人的消息 id 是各自编号的，所以必须带上会话 + 消息类型；
 * 拿不到 message_id（少见）就返回空串 —— 上层会当"没见过"放行，
 * 宁可重复也不能把没 id 的消息全吞了。
 */
export function inboundKey(event) {
  const id = String(event?.message_id ?? event?.messageId ?? '')
  if (!id) return ''
  const peer = event?.group_id ?? event?.user_id ?? ''
  return `${event?.message_type ?? ''}:${peer}:${id}`
}
