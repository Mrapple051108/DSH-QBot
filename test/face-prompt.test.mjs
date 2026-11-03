/**
 * 表情包：提示词不许列名单 + 挑图不许随机兜底。
 *   node test/face-prompt.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { faceStrategyRule } from '../src/prompts.js'
import { pickFace } from '../src/faces.js'

let pass = 0
const ok = (label) => {
  pass += 1
  console.log(`${label}  ✅`)
}

/* ① 提示段：不给名单，也不给数量 —— 只讲"能不能用 / 怎么点菜 / 会得到什么" */
{
  // 故意塞名单和总数进去，看它会不会漏出来（旧版就是直接 join 的）
  const text = faceStrategyRule({}, { total: 116, has: true, names: ['猫猫干饭', '橘子皱眉', '抱着小人偶一脸问号'] })
  assert.ok(!text.includes('猫猫干饭'), '收藏名字不能出现在提示词里')
  assert.ok(!text.includes('抱着小人偶'), '示例名字也不能出现 —— 会诱导它去猜名字')
  assert.ok(!/收藏里[^。]{0,24}\d/.test(text), `收藏相关的句子里不能带数字（收藏随时在变）：\n${text}`)
  assert.ok(!text.includes('116'), '具体数量不能出现')
  assert.ok(text.includes('query'), '要告诉它用 query 点菜')
  assert.ok(text.includes('直接发'), '要说清"够贴就直接发"')
  assert.ok(text.includes('3 张'), '要说明不够贴会回 3 张候选描述')
  ok('① 提示词不给名单、不给数量，只讲点菜规则')
}

/* ② 空收藏：直接说别发 */
{
  const text = faceStrategyRule({}, { has: false })
  assert.ok(text.includes('空的'))
  assert.ok(!text.includes('query'), '空的时候不用讲怎么点菜')
  ok('② 收藏为空时给的是「先别发」')
}

/* ③ pickFace：allowRandom=false 时挑不到就返回 undefined */
{
  const tmp = mkdtempSync(join(tmpdir(), 'facep-'))
  const file = join(tmp, '表情包收藏.json')
  writeFileSync(
    file,
    JSON.stringify([
      { kind: 'image', path: join(tmp, 'a.png'), summary: '猫猫干饭', tags: ['猫', '干饭'] },
      { kind: 'image', path: join(tmp, 'b.png'), summary: '橘子皱眉' },
    ]),
    'utf8',
  )
  const config = { workspaceRoot: tmp }

  assert.equal(pickFace(config, '根本不存在的名字', { allowRandom: false }), undefined, '名字不在收藏里就不该给一张');
  assert.equal(pickFace(config, '猫猫干饭', { allowRandom: false })?.summary, '猫猫干饭')
  assert.equal(pickFace(config, '干饭', { allowRandom: false })?.summary, '猫猫干饭', '名字包含也算命中')
  assert.equal(pickFace(config, '猫', { allowRandom: false })?.summary, '猫猫干饭', '标签命中')
  assert.ok(pickFace(config, ''), 'allowRandom 默认开时，空名字仍然随机给一张（旧行为）')
  assert.equal(pickFace(config, '', { allowRandom: false }), undefined, '关掉随机就不给')
  ok('③ 挑不到就说挑不到，不再随机兜底')

  mkdirSync(tmp, { recursive: true })
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n全部通过（${pass} 组）`)
