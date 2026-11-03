/**
 * 表情包发送闸：按会话分开计数 + 按会话自己的配置 + 不写进提示词。
 *   node test/face-gate.test.mjs
 */
import assert from 'node:assert/strict'
import { faceSendState, markFaceSent } from '../src/faces.js'
import { faceStrategyRule } from '../src/prompts.js'

let pass = 0
const ok = (label) => {
  pass += 1
  console.log(`${label}  ✅`)
}

/* ① 默认不限制（90 秒那个冷却取消了） */
{
  const st = faceSendState({ faceSendGapMs: 0, faceSendMaxPerHour: 0 }, 'gap-a')
  assert.equal(st.allowed, true, '默认 gap=0 就不该挡')
  markFaceSent('gap-a')
  assert.equal(faceSendState({ faceSendGapMs: 0, faceSendMaxPerHour: 0 }, 'gap-a').allowed, true, '刚发过也不挡')
  ok('① 默认（gap=0）连发也不挡')
}

/* ② 配了间隔就挡，且倒计时按配的算 */
{
  markFaceSent('gap-b')
  const st = faceSendState({ faceSendGapMs: 30_000, faceSendMaxPerHour: 0 }, 'gap-b')
  assert.equal(st.allowed, false, '30 秒内该挡')
  assert.match(st.reason, /秒后才能再发/)
  ok('② 配了间隔就按间隔挡')
}

/* ③ 按会话分开：A 发过不影响 B */
{
  markFaceSent('peer-A')
  markFaceSent('peer-A')
  const cfg = { faceSendGapMs: 60_000, faceSendMaxPerHour: 2 }
  assert.equal(faceSendState(cfg, 'peer-A').allowed, false, 'A 刚发过，该挡')
  assert.equal(faceSendState(cfg, 'peer-B').allowed, true, 'B 没发过，不该被 A 牵连')
  ok('③ 群和私聊各算各的（不再一根全局账）')
}

/* ④ 每小时上限也按会话算 */
{
  const cfg = { faceSendGapMs: 0, faceSendMaxPerHour: 2 }
  markFaceSent('peer-C')
  markFaceSent('peer-C')
  assert.equal(faceSendState(cfg, 'peer-C').allowed, false, 'C 到上限了')
  assert.match(faceSendState(cfg, 'peer-C').reason, /这一小时已经发了 2 张/)
  assert.equal(faceSendState(cfg, 'peer-D').allowed, true, 'D 还是干净的')
  ok('④ 每小时上限也按会话分开')
}

/* ⑤ 提示词里不许出现任何频率限制 */
{
  const text = faceStrategyRule({ faceSendGapMs: 90_000, faceSendMaxPerHour: 6 }, { has: true })
  assert.ok(!text.includes('秒'), `不该出现"秒"：\n${text}`)
  assert.ok(!text.includes('每小时'), '不该出现"每小时"')
  assert.ok(!text.includes('硬限制'), '不该出现"硬限制"')
  // 注意：「回你 3 张最接近的描述」里的 3 是 topK 的协议行为，不是频率限制也不是收藏数量，保留
  ok('⑤ 频率限制不写进提示词（只在工具里挡）')
}

console.log(`\n全部通过（${pass} 组）`)
