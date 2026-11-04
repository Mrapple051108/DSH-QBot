/**
 * 热窗收尾：该不该交、交什么、交出去怎么说。
 *
 * 2026-11-04 姐姐报的两个毛病，都落在这几个纯函数上：
 *   ①「热窗换到冷窗时没有发送消息，原本是有热窗换冷窗会把缓冲区的消息发给它的，
 *      回了就继续热窗，选择不回就切冷窗」
 *   ②「抽中的时间没人说话，到点以后却没有收到消息，然后一直顶到上限才回」
 *
 * 根因：1.3.2 把收尾改成「只交 pending」，而热窗里 pending 永远是空的，
 * 于是收尾一次都没发生过。
 */
import assert from 'node:assert/strict'
import { hotEndStanding, hotEndLines, hotEndText, CONTEXT_MAX } from '../src/shared/hot-end.js'

let n = 0
const ok = (msg) => console.log(`${String(++n).padStart(2)} ${msg}  ✅`)

const NOW = 1_700_000_000_000

/* ① 必须 @ 的群 + 窗口已经关了 → 闭嘴（1.1.3 那次「关窗 12 分钟了还在回」的底线） */
{
  const v = hotEndStanding({ needMention: true, wakeUntil: NOW - 1, now: NOW })
  assert.equal(v.speak, false)
  assert.equal(v.reason, 'closed')
  ok('窗口关了就不开口')
}

/* ② 必须 @ 的群 + 窗口还开着 → 交 */
{
  const v = hotEndStanding({ needMention: true, wakeUntil: NOW + 60_000, now: NOW })
  assert.equal(v.speak, true)
  assert.equal(v.reason, 'open')
  ok('窗口还开着就交出去')
}

/* ③ 不用 @ 的群 → 本来就能主动接话，不看窗口 */
{
  const v = hotEndStanding({ needMention: false, wakeUntil: 0, now: NOW })
  assert.equal(v.speak, true)
  assert.equal(v.reason, 'free')
  ok('不用 @ 的群不看窗口')
}

/* ④ 窗口刚好在这一毫秒到期 = 关了（边界不倒戈） */
{
  const v = hotEndStanding({ needMention: true, wakeUntil: NOW, now: NOW })
  assert.equal(v.speak, false)
  ok('到期那一刻就算关了')
}

/* ⑤ 交什么：该回的 + 别人的话分开，各留上限，取最新的 */
{
  const pending = ['A: 在吗', 'B: 问你个事']
  const context = Array.from({ length: 20 }, (_, i) => `C: 闲聊 ${i + 1}`)
  const out = hotEndLines({ pending, context })
  assert.deepEqual(out.pending, pending, '该回的不能截')
  assert.equal(out.context.length, CONTEXT_MAX, `上下文应截到 ${CONTEXT_MAX}`)
  assert.equal(out.context.at(-1), 'C: 闲聊 20', '截断要留最新的')
  assert.equal(out.total, 2 + CONTEXT_MAX)
  ok('两头都留上限，老的先扔')
}

/* ⑥ 空进空出 —— 没人说话就什么都不交（安静进冷窗是正常情况） */
{
  const out = hotEndLines({ pending: [], context: [] })
  assert.equal(out.total, 0)
  ok('缓冲是空的就什么都不交')
}

/* ⑦ 文案：两种来源分开写，出口写清「接了续热窗 / [SILENT] 进冷窗」 */
{
  const text = hotEndText({
    pending: ['⟨小明 (10001) 12:00⟩ 在吗'],
    context: ['⟨小红 (10002) 12:01⟩ 今天吃啥'],
  })
  assert.match(text, /冲你来的/)
  assert.match(text, /不一定是在叫你/)
  assert.match(text, /想接就接一句，说出口热窗就接着续上/)
  assert.match(text, /\[SILENT\]/)
  // 只有上下文、没有 pending 时不该出现「冲你来的」那一段
  const onlyCtx = hotEndText({ context: ['⟨小红 (10002) 12:01⟩ 今天吃啥'] })
  assert.doesNotMatch(onlyCtx, /冲你来的/)
  // 两种都没有时也只有出口，没有空标题
  const bare = hotEndText({})
  assert.match(bare, /\[SILENT\]/)
  ok('文案分得清「在等你」和「只是聊聊」')
}

/* ⑧ 一行不重复也不吞：pending 里的顺序原样交出去（时间线不能乱） */
{
  const out = hotEndLines({ pending: ['1', '2', '3'], context: [] })
  assert.deepEqual(out.pending, ['1', '2', '3'])
  ok('顺序不变')
}

console.log('\n全部通过')
