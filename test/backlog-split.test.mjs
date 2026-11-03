/**
 * 回归测试：热窗收尾只能交「该回却没回」的，不能把别人的闲话当成待回复。
 *
 * 事故（2026-11-03）：「770375717 那个群我设置的 @ 后回话为 600 秒，
 * 为什么过了 20 分钟它还在回复我」
 *
 * 日志对得上：23:01:58 @ 它（600 秒窗口 → 23:11:58 关）；
 * 23:21:51 / 23:22:03 群友发了三个文件，**没 @ 它**，按规则该跳过；
 * 23:23:39 热窗到点，`flushBuffersOnHotEnd` 把整桶 backlog 当成
 * 「你压着还没回的话」端出去，还配了「想接就接一句」→ 它就把别人的话接了。
 */
import assert from 'node:assert/strict'
import {
  keepBacklog,
  drainBacklog,
  drainPending,
  backlogSize,
  resetBacklog,
} from '../src/shared/backlog.js'

let n = 0
const ok = (msg) => console.log(`${String(++n).padStart(2)} ${msg}  ✅`)

const line = (t, who, text) => `[${t}] ${who}: ${text}`

/* ① 事故复现：三条没 @ 我的文件消息进了 backlog，收尾时一条都不该交出去 */
{
  resetBacklog()
  const g = '770375717'
  // 23:21:51 和 23:22:03，两个群友丢文件，都没 @ 我
  keepBacklog(g, line('23:21:51', 'PB给我收银', '[文件 ]'), 16)
  keepBacklog(g, line('23:21:51', 'PB给我收银', '[文件 ]'), 16)
  keepBacklog(g, line('23:22:03', 'PB给我收银', '[文件 ]'), 16)
  const { pending, rest } = drainPending(g)
  assert.deepEqual(pending, [], `没 @ 我的一句都不该交出去，实际 ${JSON.stringify(pending)}`)
  assert.equal(rest.length, 3, '三句都该留在 backlog 里当上下文')
  assert.deepEqual(backlogSize(g), { backlog: 3, pending: 0 })
  ok('没叫我的消息不会被热窗收尾端出去')
}

/* ② 被回复间隔压住的那句，才是收尾该交的 */
{
  resetBacklog()
  const g = '770375717'
  keepBacklog(g, line('23:20:00', '路人', '随便说一句'), 16)
  keepBacklog(g, line('23:20:05', '主人', '@我 这句该回'), 16, { pending: true })
  const { pending, rest } = drainPending(g)
  assert.deepEqual(pending, [line('23:20:05', '主人', '@我 这句该回')])
  assert.deepEqual(rest, [line('23:20:00', '路人', '随便说一句')])
  ok('被压住的该回消息能单独摘出来，别人的话留在原地')
}

/* ③ 取过之后 pending 清空、其余还能被下次投递当上下文用 */
{
  resetBacklog()
  const g = 'g3'
  keepBacklog(g, line('t1', 'A', '甲'), 16)
  keepBacklog(g, line('t2', 'B', '乙'), 16, { pending: true })
  drainPending(g)
  const { pending, rest } = drainPending(g)
  assert.deepEqual(pending, [], 'pending 是消费型的，摘一次就空')
  assert.deepEqual(rest, [line('t1', 'A', '甲')], '上下文那条还在')
  const all = drainBacklog(g)
  assert.deepEqual(all, [line('t1', 'A', '甲')])
  assert.deepEqual(backlogSize(g), { backlog: 0, pending: 0 })
  ok('两个账都是消费型的，不会越攒越多')
}

/* ④ 同文只认领一次 */
{
  resetBacklog()
  const g = 'g4'
  const dup = line('t', 'A', '复读')
  keepBacklog(g, dup, 16, { pending: true })
  keepBacklog(g, dup, 16, { pending: true })
  keepBacklog(g, dup, 16)
  const { pending, rest } = drainPending(g)
  assert.equal(pending.length, 2, `两条 pending，实际 ${pending.length}`)
  assert.equal(rest.length, 1, '剩下那条还得当上下文留着')
  ok('两条一模一样的话只按登记的条数认领')
}

/* ⑤ drainBacklog 会把待回账一并清掉（免得集合残留误配下次） */
{
  resetBacklog()
  const g = 'g5'
  keepBacklog(g, line('t', 'A', 'X'), 16, { pending: true })
  drainBacklog(g)
  assert.deepEqual(backlogSize(g), { backlog: 0, pending: 0 })
  assert.deepEqual(drainPending(g).pending, [])
  ok('drainBacklog 之后不会再有幽灵 pending')
}

/* ⑥ 容量裁剪：掉出 backlog 的老行不能在 pending 里继续挂着 */
{
  resetBacklog()
  const g = 'g6'
  keepBacklog(g, line('t0', 'A', '老'), 2, { pending: true })
  keepBacklog(g, line('t1', 'A', '中'), 2)
  keepBacklog(g, line('t2', 'A', '新'), 2)
  const { pending, rest } = drainPending(g)
  assert.deepEqual(pending, [], '「老」已经被挤出容量，不该还能取到')
  assert.deepEqual(rest, [line('t1', 'A', '中'), line('t2', 'A', '新')])
  ok('容量裁剪后 pending 跟着收缩')
}

/* ⑦ 空群号 / 空内容不炸 */
{
  resetBacklog()
  keepBacklog('', 'x')
  keepBacklog('g7', '')
  keepBacklog('g7', null)
  assert.deepEqual(backlogSize('g7'), { backlog: 0, pending: 0 })
  ok('空参数静默忽略')
}

console.log('\n全部通过')
