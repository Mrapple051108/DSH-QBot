/**
 * 「对话窗口」账本：开 / 关事件 → 区间 → 曲线虚线的判据。
 *
 * 2026-11-04 姐姐要的：
 *   「@ 之后不是会有一个计时器吗？到点以后应该在状态面板上显示，
 *     以及曲线也变成虚线」。
 */
import assert from 'node:assert/strict'
import {
  noteWakeSpan,
  spansOf,
  spansToRanges,
  inAnyRange,
  resetWakeSpans,
} from '../src/shared/wake-spans.js'

let n = 0
const ok = (msg) => console.log(`${String(++n).padStart(2)} ${msg}  ✅`)

const T0 = 1_700_000_000_000
resetWakeSpans()

/* ① 开一次、关一次 → 一个区间 */
{
  noteWakeSpan('1', 'open', T0)
  noteWakeSpan('1', 'close', T0 + 600_000)
  const r = spansToRanges(spansOf('1'))
  assert.deepEqual(r, [[T0, T0 + 600_000]])
  ok('开→关 得到一个区间')
}

/* ② 窗口续期（连续多次「开」）不该切成好几段 */
{
  noteWakeSpan('2', 'open', T0)
  noteWakeSpan('2', 'open', T0 + 60_000)
  noteWakeSpan('2', 'open', T0 + 120_000)
  noteWakeSpan('2', 'close', T0 + 300_000)
  const r = spansToRanges(spansOf('2'))
  assert.equal(r.length, 1, `续期不该切成 ${r.length} 段`)
  assert.equal(r[0][0], T0, '起点应该是第一次 @ 那一刻')
  ok('续期只留一段，起点不漂')
}

/* ③ 还开着的窗口：区间的终点用 until */
{
  resetWakeSpans()
  noteWakeSpan('3', 'open', T0)
  const r = spansToRanges(spansOf('3'), T0 + 600_000, T0 + 10_000)
  assert.deepEqual(r, [[T0, T0 + 600_000]], '还开着的窗口终点 = 到期时间')
  const r2 = spansToRanges(spansOf('3'), 0, T0 + 10_000)
  assert.deepEqual(r2, [[T0, T0 + 10_000]], '没有 until 就画到"现在"')
  ok('还开着的窗口按 until 收尾')
}

/* ④ 开 → 关 → 开 → 关：两段，中间那段是虚线区 */
{
  resetWakeSpans()
  noteWakeSpan('4', 'open', T0)
  noteWakeSpan('4', 'close', T0 + 600_000)
  noteWakeSpan('4', 'open', T0 + 900_000)
  noteWakeSpan('4', 'close', T0 + 1_500_000)
  const r = spansToRanges(spansOf('4'))
  assert.equal(r.length, 2)
  assert.equal(inAnyRange(r, T0 + 1000), true)
  assert.equal(inAnyRange(r, T0 + 700_000), false, '关掉之后那段不在窗口里 → 虚线')
  assert.equal(inAnyRange(r, T0 + 1_000_000), true, '重新开了 → 实线')
  ok('中间关掉的那段落在窗口外')
}

/* ⑤ 只开没关、又没 until：也不会把区间算成 Open 之外的空 */
{
  resetWakeSpans()
  noteWakeSpan('5', 'close', T0) // 没开就关：忽略，不能产生 [0, T0] 这种假区间
  assert.deepEqual(spansToRanges(spansOf('5')), [])
  ok('没开过的「关」被忽略')
}

/* ⑥ 脏输入不炸 */
{
  resetWakeSpans()
  noteWakeSpan('', 'open')
  noteWakeSpan('6', 'whatever', T0)
  assert.deepEqual(spansOf('6'), [])
  assert.deepEqual(spansToRanges(null), [])
  assert.equal(inAnyRange(null, T0), false)
  ok('空群号 / 未知事件 / null 都静默通过')
}

/* ⑦ 区间只留最近 12 段（面板不必画一整天） */
{
  resetWakeSpans()
  for (let i = 0; i < 20; i += 1) {
    noteWakeSpan('7', 'open', T0 + i * 10_000)
    noteWakeSpan('7', 'close', T0 + i * 10_000 + 5000)
  }
  assert.equal(spansToRanges(spansOf('7')).length, 12)
  ok('区间最多留 12 段')
}

resetWakeSpans()
console.log('\n全部通过')
