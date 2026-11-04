#!/usr/bin/env node
/**
 * 长文本回复惩罚（2026-11-04 姐姐要的第五条烦躁度来源）。
 *
 * 要盯住的四件事：
 *   ① 四种惩罚方式各自的数值必须能对上（页面那张小图靠它，算错就是画错）；
 *   ② 第 1 次长回复**只记账不加分** —— 说一段长的很正常，连成串才是病因；
 *   ③ 中间插一句短的，连续计数必须断掉（不然"连续"就没意义了）；
 *   ④ 惩罚关掉时一分都不加，但计数照旧（面板上还看得到连着几次）。
 */
import assert from 'node:assert/strict'
import {
  LONG_REPLY_CURVES,
  isLongReply,
  isPlaceholderSaid,
  longReplyCharsOf,
  longReplySeries,
  longReplyStep,
  meetsLongReply,
  readLongReplyConfig,
} from '../src/shared/long-reply.js'
import { createRhythm } from '../src/rhythm.js'
import { GROUP_OVERRIDABLE } from '../src/group-settings.js'
import { GROUP_FIELDS, FIELD_BY_KEY } from '../src/group-fields.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try {
    fn()
    pass += 1
    console.log(`  ✔ ${name}`)
  } catch (err) {
    fail += 1
    console.log(`  ✘ ${name}: ${err?.message ?? err}`)
  }
}

/* ───────── 公式 ───────── */

console.log('\n[惩罚方式]')

const BASE = { base: 10, gamma: 1.5 }

ok('第 1 次长回复不加分', () => {
  assert.equal(longReplyStep(1, { ...BASE, curve: 'linear' }), 0)
  assert.equal(longReplyStep(0, { ...BASE, curve: 'exp' }), 0)
})

ok('固定惩罚：从第 2 次起每次都只加基础值', () => {
  const v = [2, 3, 4, 9].map((n) => longReplyStep(n, { ...BASE, curve: 'fixed' }))
  assert.deepEqual(v, [10, 10, 10, 10])
})

ok('线性增长：base × n', () => {
  assert.equal(longReplyStep(2, { ...BASE, curve: 'linear' }), 20)
  assert.equal(longReplyStep(5, { ...BASE, curve: 'linear' }), 50)
})

ok('幂函数增长：base × n^力度', () => {
  assert.equal(longReplyStep(2, { ...BASE, curve: 'power' }), 28.3) // 10 * 2^1.5 = 28.28
  assert.equal(longReplyStep(4, { ...BASE, curve: 'power' }), 80) // 10 * 4^1.5 = 80
})

ok('指数函数增长：base × 力度^(n-1)', () => {
  assert.equal(longReplyStep(2, { ...BASE, curve: 'exp' }), 15)
  assert.equal(longReplyStep(3, { ...BASE, curve: 'exp' }), 22.5)
  assert.equal(longReplyStep(4, { ...BASE, curve: 'exp' }), 33.8) // 33.75 四舍五入
})

ok('同样的次数：幂 > 线性 > 指数（前几次，力度 1.5）', () => {
  const n = 4
  const power = longReplyStep(n, { ...BASE, curve: 'power' })
  const linear = longReplyStep(n, { ...BASE, curve: 'linear' })
  const exp = longReplyStep(n, { ...BASE, curve: 'exp' })
  assert.ok(power > linear, `幂 ${power} 应该 > 线性 ${linear}`)
  assert.ok(linear > exp, `线性 ${linear} 应该 > 指数 ${exp}`)
})

ok('指数起步最慢，但过了第 4 次就开始反超线性', () => {
  // 力度 1.5：1.5^4 = 5.06 > 5 —— 交叉点在第 5 次，这是"忍几次之后突然爆"的手感
  const at4 = [longReplyStep(4, { ...BASE, curve: 'exp' }), longReplyStep(4, { ...BASE, curve: 'linear' })]
  const at5 = [longReplyStep(5, { ...BASE, curve: 'exp' }), longReplyStep(5, { ...BASE, curve: 'linear' })]
  assert.ok(at4[0] < at4[1], '第 4 次还比线性低')
  assert.ok(at5[0] > at5[1], '第 5 次已经比线性高')
})

ok('一击最多 100 分（base 再大也不越界）', () => {
  assert.equal(longReplyStep(9, { base: 60, curve: 'linear', gamma: 1.5 }), 100)
  assert.equal(longReplyStep(9, { base: 60, curve: 'exp', gamma: 3 }), 100)
})

ok('基础值是 0 → 一分不加（等于关掉）', () => {
  assert.equal(longReplyStep(6, { base: 0, curve: 'linear' }), 0)
})

/* ───────── 配置读取 ───────── */

console.log('\n[配置]')

ok('空配置给出能用的默认值', () => {
  const c = readLongReplyConfig({})
  assert.equal(c.enabled, true)
  assert.equal(c.chars, 400)
  assert.equal(c.base, 6)
  assert.equal(c.curve, 'linear')
  assert.equal(c.gamma, 1.5)
})

ok('惩罚开关：只有明确写 false 才算关', () => {
  assert.equal(readLongReplyConfig({ longReplyPenalty: false }).enabled, false)
  assert.equal(readLongReplyConfig({ longReplyPenalty: true }).enabled, true)
  assert.equal(readLongReplyConfig({ longReplyPenalty: 0 }).enabled, true)
})

ok('写错的方式退回线性，力度夹在 1.05~3', () => {
  assert.equal(readLongReplyConfig({ longReplyCurve: '瞎写' }).curve, 'linear')
  assert.equal(readLongReplyConfig({ longReplyGamma: 0.2 }).gamma, 1.05)
  assert.equal(readLongReplyConfig({ longReplyGamma: 99 }).gamma, 3)
})

ok('字数判定不会小到没法用（最小 20）', () => {
  assert.equal(readLongReplyConfig({ longReplyChars: 0 }).chars, 20)
  assert.equal(readLongReplyConfig({ longReplyChars: 'x' }).chars, 400)
})

ok('四种方式都在下拉选项里', () => {
  assert.deepEqual(
    LONG_REPLY_CURVES.map((c) => c.value),
    ['fixed', 'linear', 'power', 'exp'],
  )
})

ok('五个新字段都能按群覆盖（页面改了不会被静默丢掉）', () => {
  // 字段表里写了、白名单里没写 → 保存时被 sanitize 丢掉，页面表现为「改了没反应」。
  // 这种坑查起来最费时间，所以钉在测试里。
  const keys = ['longReplyPenalty', 'longReplyChars', 'longReplyBase', 'longReplyCurve', 'longReplyGamma']
  const allowed = new Set(GROUP_OVERRIDABLE)
  for (const k of keys) {
    assert.ok(allowed.has(k), `${k} 不在 GROUP_OVERRIDABLE 里`)
    assert.ok(GROUP_FIELDS.some((f) => f.key === k), `${k} 不在字段表里`)
    assert.equal(FIELD_BY_KEY.get(k)?.key, k)
  }
})

/* ───────── 字数判定 ───────── */

console.log('\n[长文本判定]')

ok('空格和换行不算字数', () => {
  // 真字数 4，靠空格凑到 200 也不算长
  const padded = '一 二\n\n三 四' + ' '.repeat(200)
  assert.equal(longReplyCharsOf(padded), 4)
  assert.equal(isLongReply(padded, { chars: 100 }), false)
})

ok('刚好等于阈值就算长', () => {
  const body = '字'.repeat(100)
  assert.equal(isLongReply(body, { chars: 100 }), true)
  assert.equal(isLongReply(body.slice(0, 99), { chars: 100 }), false)
})

ok('空串永远不算长', () => {
  assert.equal(isLongReply('', { chars: 20 }), false)
  assert.equal(isLongReply('   \n  ', { chars: 20 }), false)
})

/* ───────── 小图数据 ───────── */

console.log('\n[面板小图]')

ok('累计序列：第 1 次 0，之后逐次累加', () => {
  const s = longReplySeries(4, { base: 10, curve: 'linear', gamma: 1.5 })
  assert.deepEqual(
    s.map((x) => x.step),
    [0, 20, 30, 40],
  )
  assert.deepEqual(
    s.map((x) => x.total),
    [0, 20, 50, 90],
  )
})

ok('累计夹在 100（图上的柱子不会顶出画框）', () => {
  const s = longReplySeries(5, { base: 60, curve: 'fixed', gamma: 1.5 })
  assert.deepEqual(
    s.map((x) => x.total),
    [0, 60, 100, 100, 100],
  )
})

ok('关掉惩罚时序列全是 0（页面能画出"什么都不加"）', () => {
  const s = longReplySeries(3, { base: 0, curve: 'exp', gamma: 2 })
  assert.deepEqual(
    s.map((x) => x.total),
    [0, 0, 0],
  )
})

/* ───────── 跟节奏层接上 ───────── */

console.log('\n[节奏层]')

const LONG = '这是一段很长的回复'.repeat(20) // 180 字上下，远超过 100 的判定线
const SHORT = '嗯。'

function makeRig(over = {}) {
  const config = {
    rhythmEnabled: true,
    rhythmGroupsOnly: true,
    rhythmHotMinMs: 90_000,
    rhythmHotMaxMs: 150_000,
    rhythmColdMinMs: 600_000,
    rhythmColdMaxMs: 1_200_000,
    rhythmColdKeep: 8,
    ignoreCalmThreshold: 30,
    ignoreAngerThreshold: 50,
    ignoreEscapeThreshold: 70,
    ignoreAuto: false,
    ignoreRisePerMsg: 0.45,
    ignoreDecayTauMs: 90_000,
    longReplyChars: 100,
    longReplyPenalty: true,
    longReplyBase: 10,
    longReplyCurve: 'linear',
    longReplyGamma: 1.5,
    ...over,
  }
  const logger = { info: () => {}, warn: () => {}, debug: () => {} }
  const manager = { list: () => [] }
  const rhythm = createRhythm({ config, manager, logger, ownerIds: [] })
  const record = { scope: 'group', peerId: '999', label: '群 999' }
  return { config, rhythm, record }
}

ok('连着 3 次长回复：0 → +20 → +30', () => {
  const { rhythm, record } = makeRig()
  const t0 = Date.now()
  rhythm.noteReply(record, t0, LONG)
  assert.equal(rhythm.snapshot(record, t0).ignite, 0, '第 1 次不该加分')
  rhythm.noteReply(record, t0 + 1000, LONG)
  assert.equal(rhythm.snapshot(record, t0 + 1000).ignite, 20, '第 2 次 +20')
  rhythm.noteReply(record, t0 + 2000, LONG)
  assert.equal(rhythm.snapshot(record, t0 + 2000).ignite, 50, '第 3 次 +30')
  assert.equal(rhythm.snapshot(record, t0 + 2000).longStreak, 3)
})

ok('中间插一句短的，连续计数断掉', () => {
  const { rhythm, record } = makeRig()
  const t0 = Date.now()
  rhythm.noteReply(record, t0, LONG)
  rhythm.noteReply(record, t0 + 500, LONG) // +20
  rhythm.noteReply(record, t0 + 800, SHORT) // 断了
  assert.equal(rhythm.snapshot(record, t0 + 800).longStreak, 0)
  rhythm.noteReply(record, t0 + 1200, LONG) // 又是第 1 次 → 不加
  assert.equal(rhythm.snapshot(record, t0 + 1200).ignite, 20)
  assert.equal(rhythm.snapshot(record, t0 + 1200).longStreak, 1)
})

ok('隔太久也断：半小时后再说长话不接着算', () => {
  const { rhythm, record } = makeRig()
  const t0 = Date.now()
  rhythm.noteReply(record, t0, LONG)
  rhythm.noteReply(record, t0 + 30 * 60_000, LONG)
  // 间隔 > max(120s, tau*4=360s) → 重新从第 1 次算，一分没加
  assert.equal(rhythm.snapshot(record, t0 + 30 * 60_000).ignite, 0)
  assert.equal(rhythm.snapshot(record, t0 + 30 * 60_000).longStreak, 1)
})

ok('惩罚关掉：一分不加，也不留计数', () => {
  const { rhythm, record } = makeRig({ longReplyPenalty: false })
  const t0 = Date.now()
  for (let i = 0; i < 4; i += 1) rhythm.noteReply(record, t0 + i * 1000, LONG)
  assert.equal(rhythm.snapshot(record, t0 + 4000).ignite, 0)
  assert.equal(rhythm.snapshot(record, t0 + 4000).longStreak, 0)
})

ok('短回复一分都不加', () => {
  const { rhythm, record } = makeRig()
  const t0 = Date.now()
  for (let i = 0; i < 5; i += 1) rhythm.noteReply(record, t0 + i * 1000, SHORT)
  assert.equal(rhythm.snapshot(record, t0 + 5000).ignite, 0)
})

ok('连着说长话时，动态段会提醒它收一收', () => {
  const { rhythm, record } = makeRig()
  const t0 = Date.now()
  rhythm.noteReply(record, t0, LONG)
  rhythm.noteReply(record, t0 + 1000, LONG)
  const hint = rhythm.moodText('group', '999')
  assert.ok(hint.includes('连着 2 次'), `实际：${hint}`)
})

ok('不传正文（老调用）不影响热窗重抽', () => {
  const { rhythm, record } = makeRig()
  const t0 = Date.now()
  rhythm.noteReply(record, t0) // 老签名
  assert.equal(rhythm.snapshot(record, t0).phase, 'hot')
  assert.equal(rhythm.snapshot(record, t0).ignite, 0)
})

/* ───────── 按轮累计（2026-11-04 晚） ───────── */

console.log('\n[按轮累计]')

// 一轮 = 一次 runTurn。下面用 beginTurnReply / endTurnReply 手工模拟它的两头。
const HALF = LONG.slice(0, 60) // 60 字，单独不够 100 的线

ok('一轮里分两次发，字数加起来才判', () => {
  const { rhythm, record } = makeRig()
  const t0 = Date.now()
  rhythm.beginTurnReply(record)
  rhythm.noteReply(record, t0, HALF)
  rhythm.noteReply(record, t0 + 800, HALF)
  assert.equal(rhythm.snapshot(record, t0 + 800).ignite, 0, '轮还没结束，先不判')
  rhythm.endTurnReply(record, t0 + 1200)
  const s = rhythm.snapshot(record, t0 + 1200)
  assert.equal(s.longStreak, 1, '120 字 ≥ 100 → 算这一次长回复')
  assert.equal(s.ignite, 0, '第 1 次只记账')
})

ok('第二轮再累计够线 → 第 2 次，开始罚', () => {
  const { rhythm, record } = makeRig()
  const t0 = Date.now()
  for (const base of [0, 5_000]) {
    rhythm.beginTurnReply(record)
    rhythm.noteReply(record, t0 + base, HALF)
    rhythm.noteReply(record, t0 + base + 500, HALF)
    rhythm.endTurnReply(record, t0 + base + 900)
  }
  const s = rhythm.snapshot(record, t0 + 6_000)
  assert.equal(s.longStreak, 2)
  assert.equal(s.ignite, 20, 'base 10 × n=2')
})

ok('一轮里连发四段大话只算一次（不再叠成"连着四次"）', () => {
  const { rhythm, record } = makeRig()
  const t0 = Date.now()
  rhythm.beginTurnReply(record)
  for (let i = 0; i < 4; i += 1) rhythm.noteReply(record, t0 + i * 500, LONG + LONG)
  rhythm.endTurnReply(record, t0 + 3_000)
  const s = rhythm.snapshot(record, t0 + 3_000)
  assert.equal(s.longStreak, 1, '四段合成一轮，只算 1 次')
  assert.equal(s.ignite, 0)
})

ok('一轮什么都没发（只查了东西）不影响连续计数', () => {
  const { rhythm, record } = makeRig()
  const t0 = Date.now()
  rhythm.beginTurnReply(record)
  rhythm.noteReply(record, t0, LONG)
  rhythm.endTurnReply(record, t0 + 100)
  // 第二轮：一个字没说
  rhythm.beginTurnReply(record)
  rhythm.endTurnReply(record, t0 + 200)
  assert.equal(rhythm.snapshot(record, t0 + 200).longStreak, 1, '不该被清掉')
  // 第三轮：又长 → 第 2 次，开始罚
  rhythm.beginTurnReply(record)
  rhythm.noteReply(record, t0 + 300, LONG)
  rhythm.endTurnReply(record, t0 + 400)
  assert.equal(rhythm.snapshot(record, t0 + 400).ignite, 20)
})

ok('后面某一轮说得短 → 重新计数', () => {
  const { rhythm, record } = makeRig()
  const t0 = Date.now()
  rhythm.beginTurnReply(record)
  rhythm.noteReply(record, t0, LONG)
  rhythm.endTurnReply(record, t0 + 100)
  rhythm.beginTurnReply(record)
  rhythm.noteReply(record, t0 + 200, SHORT)
  rhythm.endTurnReply(record, t0 + 300)
  assert.equal(rhythm.snapshot(record, t0 + 300).longStreak, 0)
})

ok('上一轮的字数不会串到下一轮', () => {
  const { rhythm, record } = makeRig()
  const t0 = Date.now()
  rhythm.beginTurnReply(record)
  rhythm.noteReply(record, t0, LONG + LONG) // 360
  rhythm.endTurnReply(record, t0 + 100)
  rhythm.beginTurnReply(record)
  rhythm.noteReply(record, t0 + 200, SHORT) // 2 字
  rhythm.endTurnReply(record, t0 + 300)
  // 账没清的话 360+2 仍够线 → streak 会是 2
  assert.equal(rhythm.snapshot(record, t0 + 300).longStreak, 0)
})

ok('关掉「按一轮累计」就退回每次投递单独判', () => {
  const { rhythm, record } = makeRig({ longReplyPerTurn: false })
  const t0 = Date.now()
  rhythm.beginTurnReply(record)
  rhythm.noteReply(record, t0, HALF) // 60 字：单独不够
  rhythm.noteReply(record, t0 + 500, HALF) // 又 60 字：单独也不够
  rhythm.endTurnReply(record, t0 + 900) // 关着时轮末不再补判
  const s = rhythm.snapshot(record, t0 + 900)
  assert.equal(s.longStreak, 0)
  assert.equal(s.ignite, 0)
})

ok('中间发一张表情包（占位 → 空正文）不会断链', () => {
  const { rhythm, record } = makeRig()
  const t0 = Date.now()
  rhythm.beginTurnReply(record)
  rhythm.noteReply(record, t0, LONG)
  rhythm.endTurnReply(record, t0 + 100)
  // 第二轮只发了表情包：tools.js 会把占位串换成空正文
  rhythm.beginTurnReply(record)
  rhythm.noteReply(record, t0 + 200, '')
  rhythm.endTurnReply(record, t0 + 300)
  assert.equal(rhythm.snapshot(record, t0 + 300).longStreak, 1)
})

ok('按字数判定：刚好到线算，差一个字不算', () => {
  assert.equal(meetsLongReply(100, { chars: 100 }), true)
  assert.equal(meetsLongReply(99, { chars: 100 }), false)
  assert.equal(meetsLongReply(0, { chars: 100 }), false)
})

ok('占位记账被认出来（发图/发文件不算"说话"）', () => {
  assert.equal(isPlaceholderSaid('[图片]'), true)
  assert.equal(isPlaceholderSaid('[表情 1]'), true)
  assert.equal(isPlaceholderSaid('[文件] a.zip'), true)
  assert.equal(isPlaceholderSaid('[表情包] 抱着白饭碗干饭'), true)
  assert.equal(isPlaceholderSaid('嗯。'), false)
  assert.equal(isPlaceholderSaid('这张图挺好 [图片]'), false, '占位标记必须在开头')
  assert.equal(isPlaceholderSaid(''), false)
})

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
