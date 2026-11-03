/**
 * 群聊「对话窗口」的计时开关。
 *
 * 2026-11-02 姐姐要的两段开关：@ 到底刷不刷新计时。
 *   开（默认）—— 每次 @ 都重新给一整段，聊多久都能续；
 *   关        —— 第一次 @ 开始计时，窗口期间的 @ 不产生新计时。
 *
 * 以前这段是硬编码在 inbound.js 里的"每次都续"，结果窗口永远关不掉，
 * 那句「我要去休息了」就会一段接一段地重复说。
 */

/**
 * 这一次 @ 该不该重新计时。
 *
 * @param {object} opts
 * @param {number} opts.openUntil 当前窗口的截止时间（0 / 过期 = 没开窗）
 * @param {number} opts.now       当前时间
 * @param {boolean} [opts.renew]  配置 groupWakeRenew；undefined 当"开"
 * @returns {boolean} true = 重新计时（开新窗或续期）
 */
export function shouldRenewWindow({ openUntil = 0, now = Date.now(), renew } = {}) {
  const open = Number(openUntil) > Number(now)
  // 没开窗：不管是哪个模式，这次 @ 都得把窗口开起来
  if (!open) return true
  // 开着：只有明确关了开关才不续 —— undefined / true 都按"刷新"处理，
  // 老配置文件里没这个键的时候行为保持不变
  return renew !== false
}

/**
 * 这次 @ 之后窗口是什么状态。给调用方判断"要不要顺带补几条附近的消息"。
 *
 * @returns {{ renewed: boolean, fresh: boolean }} fresh = 真的开了一个新窗口
 */
export function wakeByMention({ openUntil = 0, now = Date.now(), renew, ms = 0 } = {}) {
  if (Number(ms) <= 0) return { renewed: false, fresh: false }
  const fresh = Number(openUntil) <= Number(now)
  const renewed = shouldRenewWindow({ openUntil, now, renew })
  return { renewed, fresh: fresh && renewed }
}
