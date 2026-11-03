/**
 * 回归测试：发表情包不该把这一轮的话吞掉。
 *
 * 事故（2026-11-02）：outbound 的 SELF_SENDING_TOOLS 里塞了 qq_mface / qq_face /
 * qq_send_image / qq_send_file。只要这一轮调过其中任何一个，`selfSent` 就置位，
 * assistant/message 分支直接 `return` —— 后面所有文本被当成"已经说过了"整条丢掉。
 * 群里看到的就是「表情包正常发出来了，话没了」。
 *
 * 判据只有一条：**发图不是发言**。
 */
import assert from 'node:assert/strict'
import {
  SELF_SENDING_TOOLS,
  toolSaysItself,
  toolNamesOf,
  toolsAreVisualOnly,
} from '../src/shared/self-send.js'

let n = 0
const ok = (msg) => console.log(`${String(++n).padStart(2)} ${msg}  ✅`)

/* ① 真说话的工具：正文别再转发一遍 */
for (const name of ['qq_reply', 'qq_send']) {
  assert.equal(toolSaysItself(name), true, `${name} 应该算发言`)
}
ok('qq_reply / qq_send 算发言')

/* ② 发图发文件 ≠ 发言 —— 这就是本次修的四个 */
for (const name of ['qq_mface', 'qq_face', 'qq_send_image', 'qq_send_file']) {
  assert.equal(toolSaysItself(name), false, `${name} 不该算发言`)
}
ok('qq_mface / qq_face / qq_send_image / qq_send_file 不算发言')

/* ③ 互动类本来就不该拦正文 */
for (const name of ['qq_poke', 'qq_react', 'qq_like', 'qq_recall']) {
  assert.equal(toolSaysItself(name), false, `${name} 是互动不是发言`)
}
ok('qq_poke / qq_react / qq_like / qq_recall 不拦正文')

/* ④ 查资料类更不该拦 */
for (const name of ['qq_meme', 'qq_faces', 'qq_images', 'qq_group_history', 'qq_pin', 'qq_facts']) {
  assert.equal(toolSaysItself(name), false, `${name} 只是查东西`)
}
ok('查询类工具不拦正文')

/* ⑤ 脏输入不炸 */
assert.equal(toolSaysItself(undefined), false)
assert.equal(toolSaysItself(null), false)
assert.equal(toolSaysItself(''), false)
assert.equal(toolSaysItself('  '), false)
assert.equal(toolSaysItself('  qq_send  '), true, '前后空格要能容错')
assert.equal(toolSaysItself('QQ_SEND'), false, '大小写不匹配就当不认识，别乱拦')
ok('空值 / 空格 / 大小写都按"不认识"处理')

/* ⑥ 白名单本身只有两个 */
assert.deepEqual([...SELF_SENDING_TOOLS].sort(), ['qq_reply', 'qq_send'])
ok('白名单只有 qq_reply 和 qq_send 两项')

/* ⑦ 走一遍那一轮的时序：发表情包 → 再说一句话 */
{
  const selfSent = new Set()
  const seen = []
  for (const name of ['qq_mface', 'qq_send_image']) {
    if (toolSaysItself(name)) selfSent.add('s1')
  }
  // assistant/message 落定时看 selfSent
  if (!selfSent.has('s1')) seen.push('看见没？')
  assert.deepEqual(seen, ['看见没？'], '发表情包之后，正文必须还能发出去')
  ok('发表情包后的那句文本能正常发出（本次修复的核心）')

  // 对照：qq_send 说过话，正文就该闭嘴
  const s2 = new Set()
  if (toolSaysItself('qq_send')) s2.add('s2')
  assert.equal(s2.has('s2'), true, 'qq_send 发过话，正文不该再转发一遍')
  ok('qq_send 说过话后，正文照旧不重复（老行为没被破坏）')
}

/* ⑨ 第二道闸：带 tool-call 的消息默认整条不发，但「只发图」的要放行 */
{
  const msg = (parts) => ({ role: 'assistant', content: parts })
  const text = { type: 'text', text: '嘿嘿，好看吧' }
  const call = (toolName) => ({ type: 'tool-call', toolName })

  assert.deepEqual(toolNamesOf(msg([text, call('qq_mface')])), ['qq_mface'])
  assert.equal(toolsAreVisualOnly(msg([text, call('qq_mface')])), true, '纯表情包 → 正文该放行')
  assert.equal(toolsAreVisualOnly(msg([text, call('qq_send_image')])), true)
  assert.equal(
    toolsAreVisualOnly(msg([text, call('qq_mface'), call('qq_face')])),
    true,
    '多个都只发图也算纯视觉',
  )

  // 只要混进一个"会说话 / 会动手"的，就退回老规矩：整条不发
  assert.equal(
    toolsAreVisualOnly(msg([text, call('qq_mface'), call('qq_send')])),
    false,
    '混了说话类 → 不例外',
  )
  assert.equal(
    toolsAreVisualOnly(msg([text, call('web_search')])),
    false,
    '查资料类照旧整条不发（过场话）',
  )
  assert.equal(toolsAreVisualOnly(msg([text])), false, '没有 tool-call 就谈不上例外')
  assert.deepEqual(toolNamesOf(msg([text])), [])
  ok('带表情包的正文被放行；混了别的工具照旧整条不发')

  // 字段名容错：宿主用 toolName，别的实现可能叫 name / tool.name
  assert.deepEqual(toolNamesOf(msg([{ type: 'tool-call', name: 'qq_mface' }])), ['qq_mface'])
  assert.deepEqual(toolNamesOf(msg([{ type: 'function', tool: { name: 'qq_face' } }])), ['qq_face'])
  assert.deepEqual(toolNamesOf({ content: 'not-an-array' }), [])
  assert.deepEqual(toolNamesOf(null), [])
  ok('toolName / name / tool.name 都能取到，脏输入不炸')
}

console.log('\n全部通过')
