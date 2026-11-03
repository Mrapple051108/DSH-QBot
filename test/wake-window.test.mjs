/**
 * 回归测试：@ 到底刷不刷新对话窗口（groupWakeRenew 两段开关）。
 *
 * 起因（2026-11-02）：窗口以前是硬编码"每次 @ 都续期"，
 * 群里聊得勤就永远关不掉，那句「我要去休息了」一段接一段重复说。
 * 现在两个模式：
 *   开（默认）—— @ 刷新计时窗口；
 *   关        —— 第一次 @ 开始计时，窗口期间的 @ 不产生新计时。
 */
import assert from 'node:assert/strict'
import { shouldRenewWindow, wakeByMention } from '../src/shared/wake-window.js'

const T = 1_700_000_000_000 // 假"现在"
let n = 0
const ok = (msg) => console.log(`${String(++n).padStart(2)} ${msg}  ✅`)

/* ① 没开窗：哪个模式都得开 */
assert.equal(shouldRenewWindow({ openUntil: 0, now: T, renew: true }), true)
assert.equal(shouldRenewWindow({ openUntil: 0, now: T, renew: false }), true)
assert.equal(shouldRenewWindow({ openUntil: T - 1, now: T, renew: false }), true, '过期的窗口当作没开')
ok('没开窗 / 窗口过期 → 一定开')

/* ② 窗口开着 + 刷新模式 → 续期 */
assert.equal(shouldRenewWindow({ openUntil: T + 60_000, now: T, renew: true }), true)
ok('窗口开着 + renew=true → 继续续')

/* ③ 窗口开着 + 不刷新 → 一动不动，这就是"第一次 @ 说了算" */
assert.equal(shouldRenewWindow({ openUntil: T + 60_000, now: T, renew: false }), false)
ok('窗口开着 + renew=false → 不产生新计时')

/* ④ 老配置里没这个键（undefined）按"刷新"处理，行为不变 */
assert.equal(shouldRenewWindow({ openUntil: T + 60_000, now: T, renew: undefined }), true)
assert.equal(shouldRenewWindow({ openUntil: T + 60_000, now: T }), true)
ok('没配 renew 的老配置 → 跟以前一样刷新')

/* ⑤ wakeByMention：fresh 只在"真的开了新窗"时为真，补上下文靠它 */
{
  const first = wakeByMention({ openUntil: 0, now: T, renew: false, ms: 60_000 })
  assert.deepEqual(first, { renewed: true, fresh: true }, '第一次 @ 要算新窗')
  const again = wakeByMention({ openUntil: T + 60_000, now: T, renew: false, ms: 60_000 })
  assert.deepEqual(again, { renewed: false, fresh: false }, '窗口里的 @ 不算新窗')
  const renewOn = wakeByMention({ openUntil: T + 60_000, now: T, renew: true, ms: 60_000 })
  assert.deepEqual(renewOn, { renewed: true, fresh: false }, '刷新模式续期，但不是新窗')
  ok('fresh 只在第一个 @ 时为真 → 不会每次都去拉群历史')

  const off = wakeByMention({ openUntil: 0, now: T, renew: true, ms: 0 })
  assert.deepEqual(off, { renewed: false, fresh: false }, 'groupWakeMs=0 等于关功能')
  ok('groupWakeMs=0 → 窗口功能整体关闭')
}

/* ⑥ 场景走一遍：renew=false 时，窗口内疯狂 @ 也不会把截止时间往后推 */
{
  const ms = 60_000
  let openUntil = 0
  const hits = [0, 5_000, 20_000, 55_000] // 四次 @，全在第一个窗口里
  for (const at of hits) {
    const now = T + at
    const { renewed, fresh } = wakeByMention({ openUntil, now, renew: false, ms })
    if (renewed) openUntil = now + ms
    assert.equal(fresh, at === 0, `${at}ms 处 fresh 应为 ${at === 0}`)
  }
  assert.equal(openUntil, T + ms, '截止时间不能被后面的 @ 推后')
  ok('renew=false：窗口内四次 @，截止时间原地不动')

  // 到点之后再 @ → 重新开一段
  const late = T + ms + 1
  const again = wakeByMention({ openUntil, now: late, renew: false, ms })
  assert.deepEqual(again, { renewed: true, fresh: true })
  ok('窗口关掉之后 @ → 重新开一段')
}

console.log('\n全部通过')
