/**
 * 对话窗口到点那一下：先回话、再告别；告别不算「又热起来了」。
 *
 * 姐姐 2026-11-04 的三条：
 *   ①「到点以后会触发回复，但发给它的消息就只叫它说再见，而不带缓冲区消息 ——
 *      应该让它把缓冲区的回复一下，然后再告别」；
 *   ②「告别会触发热窗，而且似乎会让它又进入计时周期」（观察到的）；
 *   ③ 非 @ 消息是不是也会因此被接。
 *
 * ② 的根：告别也是一条真发出去的消息 → `send()` → `noteReply()` → 热窗重抽。
 * 修法：收尾轮挂 `farewellTurn`，`noteReply` 看见就跳过；说完再由 inbound 显式进冷窗。
 * ③ 是 ② 的下游 —— 热窗一旦续上，"这段时间照常接话"就成立了；冷窗之后才回到必须 @。
 */
import assert from 'node:assert/strict'
import { createRhythm } from '../src/rhythm.js'
import { farewellText } from '../src/shared/hot-end.js'

const silent = { info() {}, warn() {}, debug() {}, error() {} }
let n = 0
const ok = (msg) => console.log(`${String(++n).padStart(2)} ${msg}  ✅`)

function makeRhythm() {
  const rh = createRhythm({
    config: {
      rhythmEnabled: true,
      rhythmGroupsOnly: true,
      rhythmHotMinMs: 10_000,
      rhythmHotMaxMs: 10_000,
      rhythmColdMinMs: 30_000,
      rhythmColdMaxMs: 30_000,
      ignoreAuto: false,
    },
    manager: { obtain: async () => null, enqueue: () => {} },
    logger: silent,
    ownerIds: [],
    buildImageParts: async () => [],
  })
  rh.start()
  return rh
}

/* ① 文案：有「冲你来的」那几句 → 先回话、再告别，并且不给沉默出口 */
{
  const text = farewellText({
    pending: ['⟨小明 (10001) 12:00⟩ 那个方案你看了吗'],
    context: ['⟨小红 (10002) 12:01⟩ 今天好热'],
  })
  const atWord = text.indexOf('先把这几句回掉')
  const atBye = text.indexOf('最后说一句你要去忙')
  assert.ok(atWord > 0 && atBye > atWord, '顺序必须是先回话、再告别')
  assert.match(text, /先回话，再告别/)
  assert.match(text, /这次不给沉默出口/)
  assert.doesNotMatch(text, /\[SILENT\]/, '有活要干的时候不给沉默出口')
  ok('先回话、再告别，且不许沉默跳过去')
}

/* ② 文案：什么都没攒 → 允许它悄悄收摊 */
{
  const text = farewellText({})
  assert.match(text, /\[SILENT\]/)
  assert.doesNotMatch(text, /先把这几句回掉/)
  ok('没攒东西时允许 [SILENT]')
}

/* ③ 只有别人的闲聊：允许沉默，但要把话带上 */
{
  const text = farewellText({ context: ['⟨小红 (10002) 12:01⟩ 今天好热'] })
  assert.match(text, /不一定都要接/)
  assert.match(text, /\[SILENT\]/)
  ok('只有上下文时不强求回应')
}

/* ④ 收尾轮说完「我去忙了」不该把热窗续上 */
{
  const rh = makeRhythm()
  const t = Date.now()
  const rec = { scope: 'group', peerId: 'g1', label: '群 g1' }
  rh.gate({ scope: 'group', peerId: 'g1', label: '群 g1', text: '在吗' }, t)
  rh.tick(t + 11_000) // 热 → 冷
  assert.equal(rh.phaseOf('group', 'g1'), 'cold')
  // 普通回复：照旧重抽热窗
  rh.noteReply(rec, t + 12_000)
  assert.equal(rh.phaseOf('group', 'g1'), 'hot', '普通回复应该重抽热窗')
  // 收尾轮：不重抽
  rh.tick(t + 23_000) // 又冷下来
  assert.equal(rh.phaseOf('group', 'g1'), 'cold')
  rh.noteReply({ ...rec, farewellTurn: true }, t + 24_000)
  assert.equal(rh.phaseOf('group', 'g1'), 'cold', '告别不算重抽热窗')
  ok('告别不重抽热窗')
}

/* ⑤ settleCold：说完告别直接进冷窗，并且重新起一段冷窗计时 */
{
  const rh = makeRhythm()
  const t = Date.now()
  const rec = { scope: 'group', peerId: 'g2', label: '群 g2' }
  rh.gate({ scope: 'group', peerId: 'g2', label: '群 g2', text: '在吗' }, t)
  const snapHot = rh.snapshot(rec, t + 1000)
  assert.equal(snapHot.phase, 'hot')
  assert.equal(rh.settleCold(rec, t + 2000), true)
  const snap = rh.snapshot(rec, t + 2000)
  assert.equal(snap.phase, 'cold')
  assert.ok(snap.remainMs > 20_000, `冷窗要重新计时，实际剩 ${snap.remainMs}ms`)
  ok('收尾后直接进冷窗')
}

/* ⑥ 无视冷窗里不折腾（它正躲着，别把它拽出来） */
{
  const rh = makeRhythm()
  const t = Date.now()
  const rec = { scope: 'group', peerId: 'g3', label: '群 g3' }
  rh.gate({ scope: 'group', peerId: 'g3', label: '群 g3', text: '在吗' }, t)
  rh.forceIgnore(rec, { ms: 600_000, mode: 'fixed' }, t + 1000)
  assert.equal(rh.phaseOf('group', 'g3'), 'ignore')
  assert.equal(rh.settleCold(rec, t + 2000), false, '无视中不该被改成冷窗')
  assert.equal(rh.phaseOf('group', 'g3'), 'ignore')
  ok('无视冷窗里不被收尾影响')
}

/* ⑦ 私聊不走这套 */
{
  const rh = makeRhythm()
  const rec = { scope: 'private', peerId: '995', label: '私聊 995' }
  assert.equal(rh.settleCold(rec), false)
  ok('私聊不碰冷热窗')
}

console.log('\n全部通过')
