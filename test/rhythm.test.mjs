#!/usr/bin/env node
/**
 * 群聊节奏（热窗/冷窗/无视冷窗）的测试。
 *
 * 这里最要紧的两条：
 *   ① 冷窗里**必须 @ 才醒** —— 主人不 @ 也得等着（2026-11-01 姐姐特意定的）；
 *   ② 无视冷窗只认主人的 @，别的谁 @ 都不算。
 * 这两条要是反了，行为会变成"谁一喊就凑上去"，正是这套东西要治的病。
 */
import assert from 'node:assert/strict'
import { createRhythm, tokensOf, bagOf, cosine, mmrRedundancy } from '../src/rhythm.js'

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
async function okAsync(name, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  ✔ ${name}`)
  } catch (err) {
    fail += 1
    console.log(`  ✘ ${name}: ${err?.message ?? err}`)
  }
}

/* ───────── 词袋 / MMR ───────── */

console.log('\n[分词与相似度]')

ok('中文按 2-gram 切，虚词被滤掉', () => {
  const t = tokensOf('你们在干什么')
  assert.ok(t.includes('在干'), `切出来是 ${JSON.stringify(t)}`)
  assert.ok(!t.includes('你们'), '你们应该被当停用词滤掉')
})

ok('一模一样的两句余弦是 1', () => {
  const a = bagOf('今天我来打个卡')
  const b = bagOf('今天我来打个卡')
  assert.ok(cosine(a, b) > 0.999)
})

ok('完全不相干的两句余弦接近 0', () => {
  const a = bagOf('今天我来打个卡')
  const b = bagOf('服务器的 CPU 温度过高')
  assert.ok(cosine(a, b) < 0.2, `实际 ${cosine(a, b)}`)
})

ok('少于 3 条不判刷屏', () => {
  const bags = [bagOf('同一句话'), bagOf('同一句话')]
  assert.equal(mmrRedundancy(bags), 0)
})

ok('复读刷屏冗余度趋近 1', () => {
  const bags = Array.from({ length: 10 }, () => bagOf('前排出售瓜子花生矿泉水'))
  const r = mmrRedundancy(bags)
  assert.ok(r > 0.95, `实际 ${r}`)
})

ok('各说各话的冗余度很低', () => {
  const lines = [
    '今天天气不错适合出去走走',
    '我昨天买的显卡终于到货了',
    '老板又在群里发通知了',
    '中午吃什么有没有人一起',
    '这个 bug 我看了半天没找到',
    '晚点开会记得带电脑',
    '新来的同事好像挺厉害的',
    '周末有人去爬山吗',
    '地铁又晚点了烦死了',
    '这个赛季的版本更新好大',
    '刚点了个外卖等半小时',
  ]
  const r = mmrRedundancy(lines.map(bagOf))
  assert.ok(r < 0.5, `实际 ${r}`)
})

/* ───────── 闸门 ───────── */

function makeRig(over = {}, extra = {}) {
  const config = {
    rhythmEnabled: true,
    rhythmGroupsOnly: true,
    rhythmHotMinMs: 90_000,
    rhythmHotMaxMs: 150_000,
    rhythmColdMinMs: 600_000,
    rhythmColdMaxMs: 1_200_000,
    rhythmColdKeep: 8,
    ignoreMode: 'fixed',
    ignoreMs: 600_000,
    ignoreMinMs: 120_000,
    ignoreMaxMs: 1_800_000,
    ignoreExitThreshold: 30,
    ignoreExitDelayMs: 30_000,
    ignoreKeepCount: 3,
    ignoreScoreThreshold: 70,
    ignoreAuto: true,
    ignoreRisePerMsg: 0.45,
    ignoreDecayTauMs: 90_000,
    ignoreRedundancyWeight: 50,
    ignoreAtWeight: 20,
    ignorePesterWeight: 10,
    ignoreStaleWeight: 25,
    ignorePesterCount: 6,
    ignoreMmrLambda: 0.7,
    ignoreCooldownMs: 120_000,
    ...over,
  }
  const delivered = []
  const manager = {
    async obtain({ scope, peerId, label }) {
      const rec = {
        scope,
        peerId,
        label: label || `${scope}:${peerId}`,
        delivered: [],
        agent: {
          followup(payload) {
            delivered.push({ peerId, payload })
          },
          async whenIdle() {},
        },
      }
      return rec
    },
    enqueue(_rec, fn) {
      Promise.resolve().then(fn)
      return true
    },
  }
  const logger = { info: () => {}, warn: () => {}, debug: () => {} }
  const rhythm = createRhythm({ config, manager, logger, ownerIds: ['1001'], ...extra })
  // tick 在 start 之前是空转的（stopped 初值 true），测试里手动推时间必须先开。
  // 它起的 setInterval 已经 unref，不会把测试进程拖住。
  rhythm.start()
  return { config, rhythm, delivered, manager }
}

const OWNER = '1001'
const OTHER = '2002'
const G = { scope: 'group', peerId: '999', label: '群 999' }

function msg(over = {}) {
  return {
    ...G,
    text: '随便说一句',
    senderId: OTHER,
    name: '路人',
    atMe: false,
    ...over,
  }
}

console.log('\n[热窗]')

ok('刚起来的会话是热窗，消息直接放行', () => {
  const { rhythm } = makeRig()
  const now = Date.now()
  const v = rhythm.gate(msg(), now)
  assert.equal(v.action, 'pass')
  assert.equal(rhythm.snapshot({ scope: 'group', peerId: '999' }, now).phase, 'hot')
})

ok('私聊不管节奏，一律放行', () => {
  const { rhythm } = makeRig()
  const v = rhythm.gate({ scope: 'private', peerId: '1001', text: 'hi', senderId: OWNER }, Date.now())
  assert.equal(v.action, 'pass')
})

console.log('\n[冷窗]')

ok('热窗到期后转冷窗，消息攒着不投递', () => {
  const { rhythm } = makeRig()
  const t0 = Date.now()
  rhythm.gate(msg({ text: '第一条' }), t0)
  rhythm.tick(t0 + 200_000) // 热窗肯定过了
  const v = rhythm.gate(msg({ text: '第二条' }), t0 + 200_001)
  assert.equal(v.action, 'hold')
})

ok('冷窗里没人 @ 就一直攒，攒够上限也不投', () => {
  // 关掉自动无视：这条测的是"冷窗攒消息"，不是"刷屏触发无视" ——
  // 一串 `刷屏第 N 条` 在词袋里本来就很像，会把烦躁度顶上去，那是另一条测试的事。
  const { rhythm } = makeRig({ ignoreAuto: false })
  const t0 = Date.now()
  rhythm.tick(t0 + 200_000)
  let last = null
  for (let i = 0; i < 50; i += 1) {
    last = rhythm.gate(msg({ text: `第 ${i} 句` }), t0 + 200_001 + i)
  }
  assert.equal(last.action, 'hold')
})

ok('冷窗里被 @ 就醒，把攒的一起带出来', () => {
  const { rhythm } = makeRig()
  const t0 = Date.now()
  rhythm.tick(t0 + 200_000)
  rhythm.gate(msg({ text: '攒着的一' }), t0 + 200_001)
  rhythm.gate(msg({ text: '攒着的二' }), t0 + 200_002)
  const v = rhythm.gate(msg({ text: '@你 在吗', atMe: true, senderId: OWNER }), t0 + 200_003)
  assert.equal(v.action, 'pass')
  assert.equal(v.flushed, 'cold')
  assert.deepEqual(
    v.flush.map((m) => m.text),
    ['攒着的一', '攒着的二'],
  )
  assert.equal(rhythm.snapshot({ scope: 'group', peerId: '999' }, t0 + 200_003).phase, 'hot')
})

ok('冷窗里主人不 @ 也叫不动（姐姐 2026-11-01 定的）', () => {
  const { rhythm } = makeRig()
  const t0 = Date.now()
  rhythm.tick(t0 + 200_000)
  const v = rhythm.gate(msg({ text: '我先说一句', senderId: OWNER, atMe: false }), t0 + 200_001)
  assert.equal(v.action, 'hold')
})

ok('冷窗到期由 tick 统一交出去', async () => {
  const { rhythm, delivered } = makeRig()
  const t0 = Date.now()
  rhythm.tick(t0 + 200_000)
  rhythm.gate(msg({ text: '攒着的一' }), t0 + 200_001)
  rhythm.gate(msg({ text: '攒着的二' }), t0 + 200_002)
  rhythm.tick(t0 + 200_000 + 1_300_000) // 冷窗上限也过了
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(delivered.length, 1, '应该投递一次')
  const text = delivered[0].payload.content[0].text
  assert.ok(text.includes('攒着的一'), text)
  assert.ok(text.includes('攒着的二'), text)
})

console.log('\n[无视冷窗]')

ok('模型主动开无视：之后的消息全丢', () => {
  const { rhythm } = makeRig()
  const t0 = Date.now()
  rhythm.forceIgnore({ scope: 'group', peerId: '999', label: '群 999' }, { ms: 600_000 }, t0)
  const v = rhythm.gate(msg({ text: '有人吗' }), t0 + 1000)
  assert.equal(v.action, 'drop')
})

ok('无视期间别人 @ 也不理', () => {
  const { rhythm } = makeRig()
  const t0 = Date.now()
  rhythm.forceIgnore({ scope: 'group', peerId: '999' }, { ms: 600_000 }, t0)
  const v = rhythm.gate(msg({ text: '@你', atMe: true, senderId: OTHER }), t0 + 1000)
  assert.equal(v.action, 'drop')
})

ok('无视期间主人 @ 能叫醒，并带走留的尾巴', () => {
  const { rhythm } = makeRig()
  const t0 = Date.now()
  rhythm.forceIgnore({ scope: 'group', peerId: '999' }, { ms: 600_000 }, t0)
  rhythm.gate(msg({ text: '尾巴一' }), t0 + 1000)
  rhythm.gate(msg({ text: '尾巴二' }), t0 + 2000)
  const v = rhythm.gate(msg({ text: '@你', atMe: true, senderId: OWNER }), t0 + 3000)
  assert.equal(v.action, 'pass')
  assert.equal(v.flushed, 'ignore')
  assert.equal(v.flush.length, 2)
})

ok('fixed 模式：到点自己出来', async () => {
  const { rhythm, delivered } = makeRig()
  const t0 = Date.now()
  rhythm.forceIgnore({ scope: 'group', peerId: '999' }, { ms: 60_000 }, t0)
  rhythm.gate(msg({ text: '留一条' }), t0 + 1000)
  rhythm.tick(t0 + 61_000)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(rhythm.snapshot({ scope: 'group', peerId: '999' }, t0 + 61_000).phase, 'hot')
  assert.equal(delivered.length, 1, '结束时要把留的尾巴交出去')
})

ok('stats 模式：没到最短时间就出不来', () => {
  const { rhythm } = makeRig({ ignoreMode: 'stats', ignoreMinMs: 120_000, ignoreMaxMs: 600_000 })
  const t0 = Date.now()
  rhythm.forceIgnore({ scope: 'group', peerId: '999' }, { mode: 'stats' }, t0)
  rhythm.tick(t0 + 60_000) // 才过一分钟
  assert.equal(rhythm.snapshot({ scope: 'group', peerId: '999' }, t0 + 60_000).phase, 'ignore')
})

ok('stats 模式：烦躁度不降就继续躲（还在刷屏）', () => {
  const { rhythm } = makeRig({ ignoreMode: 'stats', ignoreMinMs: 10_000, ignoreMaxMs: 3_600_000 })
  const t0 = Date.now()
  rhythm.forceIgnore({ scope: 'group', peerId: '999' }, { mode: 'stats' }, t0)
  // 一直刷同样的句子，烦躁度上不去才怪
  for (let i = 0; i < 40; i += 1) rhythm.gate(msg({ text: '复读机复读机复读机' }), t0 + 11_000 + i)
  rhythm.tick(t0 + 20_000)
  assert.equal(rhythm.snapshot({ scope: 'group', peerId: '999' }, t0 + 20_000).phase, 'ignore')
})

ok('stats 模式：安静够久 + 过时延才出来', () => {
  const { rhythm } = makeRig({ ignoreMode: 'stats', ignoreMinMs: 10_000, ignoreMaxMs: 3_600_000, ignoreExitDelayMs: 30_000 })
  const t0 = Date.now()
  rhythm.forceIgnore({ scope: 'group', peerId: '999' }, { mode: 'stats' }, t0)
  // 没人说话，光靠时间衰减把烦躁度压下去
  rhythm.tick(t0 + 20_000)
  rhythm.tick(t0 + 120_000)
  rhythm.tick(t0 + 200_000)
  assert.equal(rhythm.snapshot({ scope: 'group', peerId: '999' }, t0 + 200_000).phase, 'hot')
})

ok('回复会重抽热窗', () => {
  const { rhythm } = makeRig()
  const t0 = Date.now()
  rhythm.tick(t0 + 200_000) // 进冷窗
  rhythm.noteReply({ scope: 'group', peerId: '999', label: '群 999' }, t0 + 200_001)
  assert.equal(rhythm.snapshot({ scope: 'group', peerId: '999' }, t0 + 200_001).phase, 'hot')
})

console.log('\n[烦躁度]')

ok('复读刷屏会把烦躁度顶上去', () => {
  const { rhythm } = makeRig({ ignoreScoreThreshold: 200 }) // 先别自动触发，只看分
  const t0 = Date.now()
  let last = 0
  for (let i = 0; i < 8; i += 1) {
    rhythm.gate(msg({ text: '前排出售瓜子花生矿泉水' }), t0 + i * 100)
    last = rhythm.snapshot({ scope: 'group', peerId: '999' }, t0 + i * 100).ignite
  }
  assert.ok(last > 25, `8 条复读之后烦躁度应该明显上去了，实际 ${last}`)
})

ok('连着 @ 也会顶上去', () => {
  const { rhythm } = makeRig({ ignoreScoreThreshold: 200 })
  const t0 = Date.now()
  let last = 0
  for (let i = 0; i < 6; i += 1) {
    rhythm.gate(msg({ text: `第 ${i} 句完全不一样的话术编号 ${i}`, atMe: true, senderId: OTHER }), t0 + i * 100)
    last = rhythm.snapshot({ scope: 'group', peerId: '999' }, t0 + i * 100).ignite
  }
  assert.ok(last > 20, `实际 ${last}`)
})

ok('阈值够低的话会自动进无视', () => {
  const { rhythm } = makeRig({ ignoreScoreThreshold: 20 })
  const t0 = Date.now()
  let entered = false
  for (let i = 0; i < 12; i += 1) {
    const v = rhythm.gate(msg({ text: '复读复读复读复读', atMe: true }), t0 + i * 100)
    if (v.reason === 'ignite') {
      entered = true
      break
    }
  }
  assert.ok(entered, '应该自动触发')
})

console.log('\n[刷屏：图片 / 表情包]')

ok('图片消息在词袋里是同一句（正文都是 [图片]）', () => {
  assert.ok(cosine(bagOf('[图片]'), bagOf('[图片]')) > 0.999)
  assert.ok(bagOf('[图片]').size > 0, '不能是空 bag，否则冗余度里看不见')
})

ok('纯 emoji 也有词袋（哨兵 token，不是空的）', () => {
  assert.ok(bagOf('😂😂😂').size > 0)
  assert.ok(cosine(bagOf('😂😂😂'), bagOf('🎉🎉')) > 0.999, '不同的纯表情互相也算同一类')
})

ok('连发 3 条一样的还不算刷屏（量不够）', () => {
  const { rhythm } = makeRig()
  const t0 = Date.now()
  for (let i = 0; i < 3; i += 1) rhythm.gate(msg({ text: '[图片]' }), t0 + i * 1000)
  const s = rhythm.snapshot({ scope: 'group', peerId: '999' }, t0 + 3000)
  assert.ok(s.ignite < 30, `3 条图不该把烦躁度顶起来，实际 ${s.ignite}`)
})

ok('一直发图会自己进无视冷窗（不用谁 @ 它）', () => {
  const { rhythm } = makeRig()
  const t0 = Date.now()
  let entered = false
  let at = 0
  for (let i = 0; i < 40; i += 1) {
    const v = rhythm.gate(msg({ text: '[图片]', senderId: OTHER }), t0 + i * 1000)
    if (v.reason === 'ignite') {
      entered = true
      at = i + 1
      break
    }
  }
  assert.ok(entered, '连着发图应该自己进无视')
  assert.ok(at >= 5 && at <= 30, `触发得太早或太晚：第 ${at} 张`)
})

ok('纯表情轰炸也能触发', () => {
  const { rhythm } = makeRig()
  const t0 = Date.now()
  let entered = false
  for (let i = 0; i < 40; i += 1) {
    const v = rhythm.gate(msg({ text: '😂😂😂😂', senderId: OTHER }), t0 + i * 1000)
    if (v.reason === 'ignite') {
      entered = true
      break
    }
  }
  assert.ok(entered, '纯 emoji 复读也该触发')
})

ok('正常聊天（每句都不一样）不会因为条数多就触发', () => {
  const { rhythm } = makeRig()
  const t0 = Date.now()
  const lines = [
    '今天天气不错适合出去走走',
    '我昨天买的显卡终于到货了',
    '老板又在群里发通知了',
    '中午吃什么有没有人一起',
    '这个 bug 我看了半天没找到',
    '晚点开会记得带电脑',
    '新来的同事好像挺厉害的',
    '周末有人去爬山吗',
    '地铁又晚点了烦死了',
    '这个赛季的版本更新好大',
    '刚点了个外卖等半小时',
    '晚上一起打排位不',
  ]
  let entered = false
  for (let i = 0; i < lines.length; i += 1) {
    const v = rhythm.gate(msg({ text: lines[i], senderId: OTHER }), t0 + i * 2000)
    if (v.reason === 'ignite') entered = true
  }
  assert.equal(entered, false, '各说各话不该被判成刷屏')
  const s = rhythm.snapshot({ scope: 'group', peerId: '999' }, t0 + 30_000)
  assert.ok(s.ignite < 40, `正常聊天烦躁度不该高，实际 ${s.ignite}`)
})

console.log('\n[骂一句就走]')

await okAsync('烦躁度顶到阈值时，先投一条「说一句就走」的提示', async () => {
  const { rhythm, delivered } = makeRig({ ignoreScoreThreshold: 20 })
  const t0 = Date.now()
  let hit = false
  for (let i = 0; i < 20; i += 1) {
    const v = rhythm.gate(msg({ text: '[图片]', senderId: OTHER }), t0 + i * 1000)
    if (v.reason === 'ignite') {
      hit = true
      break
    }
  }
  assert.ok(hit, '应该触发')
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(delivered.length >= 1, '应该投了一条抱怨提示')
  const text = delivered[0].payload.content[0].text
  assert.ok(/烦躁度\s*\d+\/100/.test(text), `提示里要有具体分数：${text}`)
  assert.ok(text.includes('静音') || text.includes('说一句就走'), text)
  // 这时候已经在无视冷窗里了：后面的消息全丢
  assert.equal(rhythm.gate(msg({ text: '还在吗' }), t0 + 60_000).action, 'drop')
})

await okAsync('ignoreNag 关掉就无声无息地躲（不投提示）', async () => {
  const { rhythm, delivered } = makeRig({ ignoreScoreThreshold: 20, ignoreNag: false })
  const t0 = Date.now()
  for (let i = 0; i < 20; i += 1) {
    const v = rhythm.gate(msg({ text: '[图片]', senderId: OTHER }), t0 + i * 1000)
    if (v.reason === 'ignite') break
  }
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(delivered.length, 0)
})

await okAsync('冷窗到期带回来的那批也带烦躁度', async () => {
  const { rhythm, delivered } = makeRig({ ignoreAuto: false })
  const t0 = Date.now()
  rhythm.tick(t0 + 200_000) // 进冷窗
  for (let i = 0; i < 5; i += 1) rhythm.gate(msg({ text: `第 ${i} 句话` }), t0 + 200_001 + i)
  await rhythm.flushKey('group:999', 'cold')
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(delivered.length >= 1, '应该交出去了')
  const text = delivered[0].payload.content[0].text
  assert.ok(/烦躁度\s*\d+\/100/.test(text), `交回去时也要报分数：${text}`)
})

await okAsync('冷窗攒着的图会随 flush 一起交回去（不能只剩一行 [图片]）', async () => {
  const built = []
  const { rhythm, delivered } = makeRig(
    { ignoreAuto: false },
    {
      buildImageParts: async (paths) => {
        built.push(...paths)
        return paths.map((p) => ({ type: 'image', attachment: { attachmentId: p } }))
      },
    },
  )
  const t0 = Date.now()
  rhythm.tick(t0 + 200_000) // 进冷窗
  rhythm.gate(msg({ text: '[图片]', images: ['/a.png'] }), t0 + 200_001)
  rhythm.gate(msg({ text: '[图片]', images: ['/b.png'] }), t0 + 200_002)
  rhythm.gate(msg({ text: '[图片]', images: ['/c.png'] }), t0 + 200_003)
  await rhythm.flushKey('group:999', 'cold')
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(built, ['/a.png', '/b.png', '/c.png'], '三张图的路径都要交给转图器')
  assert.equal(delivered.length, 1, '只投一次')
  const parts = delivered[0].payload.content
  assert.equal(parts.length, 4, '一段文字 + 三张图')
  assert.equal(parts[0].type, 'text')
  assert.equal(parts.filter((p) => p.type === 'image').length, 3)
})

await okAsync('冷窗里被 @ 打断时，图和消息一起带回来', async () => {
  const { rhythm, delivered } = makeRig({}, { buildImageParts: async () => [{ type: 'image' }] })
  const t0 = Date.now()
  rhythm.tick(t0 + 200_000)
  rhythm.gate(msg({ text: '[图片]', images: ['/x.png'] }), t0 + 200_001)
  const v = rhythm.gate(msg({ text: '@你', atMe: true, senderId: OWNER }), t0 + 200_002)
  assert.equal(v.flushed, 'cold')
  assert.deepEqual(v.flushImages, ['/x.png'], 'gate 要把图片路径一起还回来')
})

console.log('\n[不变量]')

ok('ignoreAuto 关掉就不会自动触发', () => {
  const { rhythm } = makeRig({ ignoreAuto: false, ignoreScoreThreshold: 1 })
  const t0 = Date.now()
  for (let i = 0; i < 30; i += 1) {
    const v = rhythm.gate(msg({ text: '复读复读复读', atMe: true }), t0 + i * 100)
    assert.notEqual(v.reason, 'ignite')
  }
})

ok('ignoreAuto 关掉仍然在算烦躁度（可视化要看得到）', () => {
  const { rhythm } = makeRig({ ignoreAuto: false, ignoreScoreThreshold: 1 })
  const t0 = Date.now()
  for (let i = 0; i < 12; i += 1) {
    rhythm.gate(msg({ text: '复读复读复读', atMe: true, senderId: OTHER }), t0 + i * 100)
  }
  const s = rhythm.snapshot({ scope: 'group', peerId: '999' }, t0 + 1200)
  assert.ok(s.ignite > 10, `关掉自动触发之后烦躁度照样该涨，实际 ${s.ignite}`)
  assert.equal(s.phase, 'hot', '但不该进无视冷窗')
})

ok('igniteOf 现读烦躁度（合并窗口靠它算要等多久）', () => {
  const { rhythm } = makeRig({ ignoreAuto: false })
  const t0 = Date.now()
  for (let i = 0; i < 10; i += 1) rhythm.gate(msg({ text: '[图片]' }), t0 + i * 100)
  assert.ok(rhythm.igniteOf('group', '999') > 5, '连发图之后应该读到分数')
  assert.equal(rhythm.igniteOf('group', '没这个群'), 0, '没见过的群给 0，别崩')
})

console.log('\n[接话节奏：越烦等得越久]')

ok('刚起来没烦躁度 → 用下限', () => {
  const { rhythm } = makeRig({ ignoreAuto: false })
  assert.equal(rhythm.mergeWindowOf('group', '999'), 2500, '烦躁度 0 应该用 groupMergeWindowMs')
})

ok('烦躁度上去了就等更久，且不超过上限', () => {
  const { rhythm } = makeRig({ ignoreAuto: false })
  const t0 = Date.now()
  const before = rhythm.mergeWindowOf('group', '999')
  for (let i = 0; i < 20; i += 1) rhythm.gate(msg({ text: '[图片]' }), t0 + i * 100)
  const after = rhythm.mergeWindowOf('group', '999')
  assert.ok(after > before, `烦躁度涨了应该等更久：${before} → ${after}`)
  assert.ok(after <= 15_000, `不能超过 groupMergeWindowMaxMs：${after}`)
})

ok('合并窗口配成 0 就是真关掉（不会因烦躁度高又开回来）', () => {
  const { rhythm } = makeRig({ ignoreAuto: false, groupMergeWindowMs: 0 })
  const t0 = Date.now()
  for (let i = 0; i < 20; i += 1) rhythm.gate(msg({ text: '[图片]' }), t0 + i * 100)
  assert.equal(rhythm.mergeWindowOf('group', '999'), 0)
})

ok('采样点会记下来（可视化靠它画线）', () => {
  const { rhythm } = makeRig()
  const t0 = Date.now()
  rhythm.gate(msg({ text: '随便说一句' }), t0)
  rhythm.tick(t0 + 15_000)
  rhythm.tick(t0 + 30_000)
  const all = rhythm.allSeries()
  assert.equal(all.length, 1, '应该只有这一个群')
  assert.ok(all[0].points.length >= 2, `采样点太少：${all[0].points.length}`)
  for (const p of all[0].points) {
    assert.equal(typeof p.v, 'number')
    assert.equal(typeof p.p, 'string')
    assert.equal(typeof p.t, 'number')
  }
})

ok('攒着东西的会话不会被回收', () => {
  const { rhythm } = makeRig()
  const t0 = Date.now()
  rhythm.tick(t0 + 200_000)
  rhythm.gate(msg({ text: '攒着' }), t0 + 200_001)
  assert.equal(rhythm.isHolding({ scope: 'group', peerId: '999' }), true)
})

console.log(`\n通过 ${pass}，失败 ${fail}`)
if (fail > 0) process.exit(1)
