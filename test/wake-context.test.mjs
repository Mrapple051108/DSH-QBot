/**
 * 回归测试：「附近的消息」不能翻旧账。
 *
 * 事故（2026-11-02）：昨天让她「记一下，这个咕咕嘎嘎是个坏蛋」，今天又被翻上来了。
 * 原因是补上下文那条路只靠 `record.lastDeliverAt` 做水位 —— 那是内存字段，
 * 插件一重启就归零，于是从聊天流水里往回翻，把昨天的「附近的消息」端到她眼前。
 * 顺带还有第二个洞：流水里既有别人也有她自己，补回来就变成她读自己的台词。
 */
import assert from 'node:assert/strict'
import { pickWakeLines } from '../src/shared/wake-context.js'

let n = 0
const ok = (msg) => console.log(`${String(++n).padStart(2)} ${msg}  ✅`)

const SELF = '2559736813'
const T = Date.parse('2026-11-02T18:00:00') // 本地时区

/* ① 自己的话不能补进来 */
{
  const rows = [
    { uid: SELF, at: T - 60_000, name: 'Miss.Fish', text: '我先去待机了' },
    { uid: '1718935283', at: T - 50_000, name: '老大', text: '这个报错怎么修' },
  ]
  const got = pickWakeLines(rows, { selfId: SELF, floor: 0, limit: 10 })
  assert.deepEqual(got, ['老大：这个报错怎么修'], `实际 ${JSON.stringify(got)}`)
  ok('跳过自己说过的话')
}

/* ② 早于 floor 的不要 —— 这就是"昨天的话又被翻上来" */
{
  const rows = [
    { uid: '1', at: T - 86_400_000, name: '咕咕嘎嘎', text: '记一下，这个咕咕嘎嘎是个坏蛋' },
    { uid: '2', at: T - 120_000, name: '老大', text: '你现在挂的哪个记忆库' },
    { uid: '3', at: T - 30_000, name: '老大', text: '绘制同步发电机的相量图' },
  ]
  const got = pickWakeLines(rows, { selfId: SELF, floor: T - 600_000, limit: 10 })
  assert.equal(got.length, 2, `昨天的应该被挡掉，实际 ${JSON.stringify(got)}`)
  assert.ok(!got.some((l) => l.includes('坏蛋')), '昨天那句不该出现')
  assert.ok(got[0].includes('记忆库'))
  ok('早于时间闸的消息被挡掉（昨天的话不会再翻上来）')
}

/* ③ 流水行尾的 #msg= 要剥掉 */
{
  const rows = [{ uid: '1', at: T, name: '苹果', text: 'hi #msg=836006135' }]
  assert.deepEqual(pickWakeLines(rows, { selfId: SELF, floor: 0, limit: 5 }), ['苹果：hi'])
  ok('剥掉消息编号尾巴')
}

/* ④ 重复行只留一条（重放会留下同款） */
{
  const rows = [
    { uid: '1', at: T - 2000, name: '苹果', text: 'hi' },
    { uid: '1', at: T - 1000, name: '苹果', text: 'hi' },
    { uid: '1', at: T, name: '苹果', text: 'hi' },
  ]
  assert.deepEqual(pickWakeLines(rows, { selfId: SELF, floor: 0, limit: 10 }), ['苹果：hi'])
  ok('相同的行只留一条')
}

/* ⑤ 只取最近 limit 条 */
{
  const rows = Array.from({ length: 20 }, (_, i) => ({
    uid: String(i + 2),
    at: T - (20 - i) * 1000,
    name: `人${i}`,
    text: `第${i}句`,
  }))
  const got = pickWakeLines(rows, { selfId: SELF, floor: 0, limit: 3 })
  assert.equal(got.length, 3)
  assert.deepEqual(got.map((l) => l.split('：')[1]), ['第17句', '第18句', '第19句'])
  ok('只带最近的 limit 条，顺序不乱')
}

/* ⑥ 脏输入不炸 */
{
  assert.deepEqual(pickWakeLines(null), [])
  assert.deepEqual(pickWakeLines(undefined), [])
  assert.deepEqual(pickWakeLines([]), [])
  assert.deepEqual(pickWakeLines([null, undefined, {}]), [])
  assert.deepEqual(pickWakeLines([{ text: '   ' }]), [])
  // 没时间的放行：宁可多带一条，别因为没时间戳把新消息漏了
  assert.deepEqual(pickWakeLines([{ name: 'a', text: 'x' }], { floor: T }), ['a：x'])
  // 没名字就用 uid 顶
  assert.deepEqual(pickWakeLines([{ uid: '999', text: 'y' }]), ['999：y'])
  ok('空值 / 缺字段 / 缺时间戳都不炸')
}

/* ⑦ 一轮真实场景：重启后 lastDeliverAt 归零，只有 lookback 兜底 */
{
  const lookback = 600_000 // 默认 10 分钟
  const now = T
  const rows = [
    { uid: '1', at: T - 86_400_000, name: '咕咕嘎嘎', text: '昨天那句"坏蛋"' },
    { uid: '2', at: T - 300_000, name: '老大', text: '五分钟前说的话' },
    { uid: '3', at: T - 5_000, name: '老大', text: '刚刚说的话' },
  ]
  const got = pickWakeLines(rows, { selfId: SELF, floor: now - lookback, limit: 10 })
  assert.equal(got.length, 2)
  assert.ok(!got.some((l) => l.includes('坏蛋')), '重启后也不会把昨天的翻上来')
  ok('水位归零时，lookback 单独也能挡住昨天')
}

console.log('\n全部通过')
