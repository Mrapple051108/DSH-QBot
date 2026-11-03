/**
 * 回归测试：烦躁度到底有没有反馈给模型。
 *
 * 2026-11-02 姐姐问的：「烦躁度是怎么反馈给它的，dsh 里我没看到发给它的消息里有相关提示？」
 * —— 问得对，以前只有两条路会带：冷窗到期回填、无视冷窗结束回填。
 * 热窗正常聊天里它压根不知道自己烦到哪儿了；更糟的是 gate 里算出来的愤怒提示
 * （`angerLine`）inbound 根本没接，生成了没人用。
 *
 * 现在每轮都问一句 `moodText()`，没到冷静阈值返回空串（不占 token）。
 */
import assert from 'node:assert/strict'
import { createRhythm } from '../src/rhythm.js'
import { readThresholds } from '../src/group-settings.js'

const silent = { info() {}, warn() {}, debug() {}, error() {} }
let n = 0
const ok = (msg) => console.log(`${String(++n).padStart(2)} ${msg}  ✅`)

function makeRhythm(extra = {}) {
  const rh = createRhythm({
    config: {
      rhythmEnabled: true,
      rhythmGroupsOnly: true,
      rhythmHotMinMs: 10_000,
      rhythmHotMaxMs: 10_000,
      rhythmColdMinMs: 30_000,
      rhythmColdMaxMs: 30_000,
      ignoreAuto: false, // 单独测阈值逻辑，别让它自动进无视
      // bump 上去的分不能被下一条消息的平滑拉下来（默认 0.45 会直接拉掉大半）
      ignoreRisePerMsg: 0.02,
      ignoreCalmThreshold: 30,
      ignoreAngerThreshold: 50,
      ignoreEscapeThreshold: 90,
      ...extra,
    },
    manager: { obtain: async () => null, enqueue: () => {} },
    logger: silent,
    ownerIds: [],
    buildImageParts: async () => [],
  })
  rh.start()
  return rh
}

const G = 'group'
const P = '770375717'

/* ① 没到冷静阈值 → 什么都不说 */
{
  const rh = makeRhythm()
  rh.bumpIgnite(G, P, 5)
  assert.equal(rh.moodText(G, P), '', '烦躁度 5 不该提醒')
  rh.bumpIgnite(G, P, 15) // 20
  assert.equal(rh.moodText(G, P), '', '20 还没到冷静阈值 30')
  ok('没到冷静阈值就不啰嗦（省 token）')
}

/* ② 过了冷静阈值 → 有播报，且带真实数值 */
{
  const rh = makeRhythm()
  rh.bumpIgnite(G, P, 40)
  const line = rh.moodText(G, P)
  assert.ok(line.length > 0, `应该有一句，实际 ${JSON.stringify(line)}`)
  assert.ok(line.includes('40'), `应该带上当前数值：${line}`)
  assert.ok(/烦躁度/.test(line))
  ok(`过了冷静阈值会播报：${line.slice(0, 30)}…`)
}

/* ③ 分档：愤怒阈值前后措辞不一样 */
{
  const rh = makeRhythm()
  rh.bumpIgnite(G, P, 35) // 冷静 30 ~ 愤怒 50 之间
  const mild = rh.moodText(G, P)
  rh.bumpIgnite(G, P, 20) // 55
  const hot = rh.moodText(G, P)
  assert.notEqual(mild, hot, '两个档位的措辞应该不同')
  assert.ok(/烦/.test(hot), `愤怒档要说得更重：${hot}`)
  ok('冷静档和愤怒档的措辞分开了')
}

/* ④ gate 跨过愤怒阈值时，会把「该炸了」的提示词带出来 */
{
  const rh = makeRhythm()
  rh.bumpIgnite(G, P, 60) // 60 ≥ 愤怒 50
  const v1 = rh.gate({ scope: G, peerId: P, label: '群 x', text: '哈哈哈', senderId: '1' })
  assert.equal(v1.action, 'pass')
  assert.equal(v1.angry, true, '第一次跨过阈值应该带 angry')
  assert.ok(typeof v1.angerLine === 'string' && v1.angerLine.length > 0, '还应该带提示词')
  assert.ok(/愤怒阈值/.test(v1.angerLine), `提示词里要点出愤怒阈值：${v1.angerLine.slice(0, 40)}`)
  ok('跨过愤怒阈值 → gate 返回 angry + 提示词（以前这份没人接）')
}

/* ⑤ 边沿触发：第二次不再炸，掉回去再上来能再炸 */
{
  const rh = makeRhythm()
  rh.bumpIgnite(G, P, 60)
  const a = rh.gate({ scope: G, peerId: P, text: '一', senderId: '1' })
  const b = rh.gate({ scope: G, peerId: P, text: '二', senderId: '1' })
  assert.equal(a.angry, true, '第一次触发')
  assert.ok(!b.angry, '第二次不该再触发（不能每句都骂）')

  rh.bumpIgnite(G, P, -50) // 掉到 10 < 冷静 30 → 重新武装
  assert.equal(rh.moodText(G, P), '', '掉下来了就不再播报')
  rh.bumpIgnite(G, P, 50) // 回到 60
  const c = rh.gate({ scope: G, peerId: P, text: '三', senderId: '1' })
  assert.equal(c.angry, true, '冷静下来之后要能重新触发')
  ok('边沿触发：只炸一次，掉回冷静阈值再重新武装')
}

/* ⑥ 每群各自的阈值：一个群调到 20，另一个还是 50 */
{
  // 每个群一份完整配置，只有愤怒阈值不同 —— cfgFor 返回的必须是**完整**配置，
  // 否则平滑系数之类的字段会掉回默认值（这正是真实里 Proxy 回落做的事）
  const base = {
    rhythmEnabled: true,
    rhythmGroupsOnly: true,
    ignoreAuto: false,
    ignoreRisePerMsg: 0.02,
    ignoreCalmThreshold: 30,
    ignoreAngerThreshold: 50,
    ignoreEscapeThreshold: 90,
  }
  const rh = createRhythm({
    config: base,
    manager: { obtain: async () => null, enqueue: () => {} },
    logger: silent,
    ownerIds: [],
    buildImageParts: async () => [],
    cfgFor: (peerId) =>
      peerId === 'A'
        ? { ...base, ignoreCalmThreshold: 10, ignoreAngerThreshold: 20 }
        : base,
  })
  rh.start()
  rh.bumpIgnite(G, 'A', 25)
  rh.bumpIgnite(G, 'B', 25)
  const a = rh.gate({ scope: G, peerId: 'A', text: 'x', senderId: '1' })
  const b = rh.gate({ scope: G, peerId: 'B', text: 'x', senderId: '1' })
  assert.equal(a.angry, true, 'A 的愤怒阈值 20，25 该炸')
  assert.ok(!b.angry, 'B 的愤怒阈值还是 50，25 不该炸')
  ok('阈值按群各算各的')
}

/* ⑥-b 愤怒阈值低于冷静阈值 → 自动夹到合法区间（页面乱填也不会出鬼状态） */
{
  const lv = readThresholds({ ignoreCalmThreshold: 30, ignoreAngerThreshold: 20, ignoreEscapeThreshold: 90 })
  assert.equal(lv.anger, 31, '愤怒必须大于冷静，20 会被夹到 31')
  assert.ok(lv.calm < lv.anger && lv.anger < lv.escape)
  ok('愤怒阈值填得比冷静还低 → 自动夹到 冷静+1')
}

/* ⑦ readThresholds 给的三档跟 moodText 用的是同一份 */
{
  const lv = readThresholds({ ignoreCalmThreshold: 25, ignoreAngerThreshold: 45, ignoreEscapeThreshold: 80 })
  assert.deepEqual(lv, { calm: 25, anger: 45, escape: 80 })
  const rh = makeRhythm({ ignoreCalmThreshold: 25, ignoreAngerThreshold: 45, ignoreEscapeThreshold: 80 })
  rh.bumpIgnite(G, P, 24)
  assert.equal(rh.moodText(G, P), '', '24 < 冷静 25')
  rh.bumpIgnite(G, P, 1)
  assert.ok(rh.moodText(G, P).length > 0, '25 到了就该说')
  ok('阈值由 readThresholds 统一算，页面上调的跟这里是同一份')
}

console.log('\n全部通过')
