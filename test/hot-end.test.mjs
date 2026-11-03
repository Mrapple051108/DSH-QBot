/**
 * 回归测试：热窗到点那一刻要喊一声，别把缓冲硬切进冷窗。
 *
 * 事故（2026-11-02）：姐姐观察到「有概率热窗期间有消息但被回复延时卡住直接进冷窗，
 * 应该在切换时缓冲区有消息就全传给智能体，没有就进冷窗」。
 * 以前 `tick` 里只有 `enterCold(st, now)`，顺手把 `st.hold` 清空，
 * inbound 那边的 backlog / history 也没人管 —— 刚好卡在边界上的那几句
 * 要等冷窗结束（十几分钟）才被端出来。
 */
import assert from 'node:assert/strict'
import { createRhythm } from '../src/rhythm.js'

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
      ignoreAuto: false,
      ...extra,
    },
    manager: { obtain: async () => null, enqueue: () => {} },
    logger: silent,
    ownerIds: [],
    buildImageParts: async () => [],
  })
  // tick 在 stopped 时直接 return，测试里得先把它跑起来（interval 是 unref 的，不会挂住进程）
  rh.start()
  return rh
}

/* ① 热窗到期 → 回调被叫，参数带得出 scope / peerId / label */
{
  const rh = makeRhythm()
  const calls = []
  rh.setHotEndHandler((info) => calls.push(info))
  rh.gate({ scope: 'group', peerId: '770375717', label: '群 770375717', text: '在吗' })
  rh.tick(Date.now() + 11_000)
  assert.equal(calls.length, 1, `应该叫一次，实际 ${calls.length}`)
  assert.deepEqual(calls[0], { scope: 'group', peerId: '770375717', label: '群 770375717' })
  ok('热窗到点会通知 inbound')
}

/* ② 进了冷窗之后不能再叫（不然每 15 秒都收一次尾） */
{
  const rh = makeRhythm()
  let calls = 0
  rh.setHotEndHandler(() => {
    calls += 1
  })
  rh.gate({ scope: 'group', peerId: '1', text: 'hi' })
  const t = Date.now()
  rh.tick(t + 11_000) // 热 → 冷，叫一次
  rh.tick(t + 20_000) // 冷窗中途
  rh.tick(t + 30_000) // 还在冷窗里（coldMin=30s，但 untilAt 是进冷窗时 +30s）
  assert.equal(calls, 1, `冷窗期间不该再叫，实际叫了 ${calls} 次`)
  ok('冷窗期间不会重复叫')
}

/* ③ 冷窗结束回热窗，再到期时要能再叫一次 */
{
  const rh = makeRhythm()
  let calls = 0
  rh.setHotEndHandler(() => {
    calls += 1
  })
  rh.gate({ scope: 'group', peerId: '2', text: 'hi' })
  const t = Date.now()
  rh.tick(t + 11_000) // 热→冷 (1)
  rh.tick(t + 45_000) // 冷→热
  rh.tick(t + 60_000) // 热→冷 (2)
  assert.equal(calls, 2, `两轮应该叫两次，实际 ${calls}`)
  ok('下一轮热窗到期还能再叫')
}

/* ④ 没设回调也不能炸 */
{
  const rh = makeRhythm()
  rh.gate({ scope: 'group', peerId: '3', text: 'hi' })
  rh.tick(Date.now() + 11_000)
  ok('没注册回调时静默通过')
}

/* ⑤ 传 null 能把回调摘掉 */
{
  const rh = makeRhythm()
  let calls = 0
  rh.setHotEndHandler(() => {
    calls += 1
  })
  rh.setHotEndHandler(null)
  rh.gate({ scope: 'group', peerId: '4', text: 'hi' })
  rh.tick(Date.now() + 11_000)
  assert.equal(calls, 0)
  ok('setHotEndHandler(null) 能摘掉回调')
}

/* ⑥ 私聊不建 state（groupsOnly），自然也不会叫 */
{
  const rh = makeRhythm()
  let calls = 0
  rh.setHotEndHandler(() => {
    calls += 1
  })
  rh.gate({ scope: 'private', peerId: '995', text: '睡了' })
  rh.tick(Date.now() + 11_000)
  assert.equal(calls, 0)
  ok('私聊不走冷热窗，不会触发收尾')
}

console.log('\n全部通过')
