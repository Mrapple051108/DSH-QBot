#!/usr/bin/env node
/**
 * 拆段 vs 整段发。
 *
 * 2026-11-02 姐姐要的两条：
 *   ① 别把字数限死 —— 每条回复在 [textChunkLimit, textChunkLimitMax] 之间摇一个
 *   ② 超过阈值又像技术内容的，整段发，别拆（代码断成三截就没法读了）
 */
import assert from 'node:assert/strict'
import { looksTechnical, keepWhole, splitText, looksLikeCodeLine } from '../src/shared/chunk.js'

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

console.log('\n[像不像技术内容]')

ok('代码块', () => {
  assert.equal(looksTechnical('给你看下这段：\n```js\nconst a = 1\n```\n就这样'), true)
})

ok('行内代码', () => {
  assert.equal(looksTechnical('把这个 `dsh-qq` 目录删了就行，别的别动，记得先备份'), true)
})

ok('带缩进的配置', () => {
  assert.equal(looksTechnical('改成这样：\n  wsUrl: ws://127.0.0.1:3001\n  selfId: "123"'), true)
})

ok('Windows 路径', () => {
  assert.equal(looksTechnical('文件在 C:\\Users\\17189\\.dsh\\profiles\\desktop 下面，打开看看'), true)
})

ok('链接', () => {
  assert.equal(looksTechnical('你看这个 http://127.0.0.1:34569/api/dsh-qq/rhythm-view 能不能开'), true)
})

ok('命令', () => {
  assert.equal(looksTechnical('先跑 npm install，再 npm test 看看过不过，过不了把日志贴我'), true)
})

ok('报错堆栈', () => {
  assert.equal(looksTechnical('它报的是 Error: ENOENT no such file，路径写错了'), true)
})

ok('普通聊天不算', () => {
  assert.equal(looksTechnical('我今天真的太累了，一整天都在改那个破插件，眼睛都花了，明天再说吧'), false)
})

ok('普通聊天里提到代码但没代码味', () => {
  assert.equal(looksTechnical('那个函数写得挺烂的，不过能跑就行，别改了'), false)
})

ok('空串不算', () => {
  assert.equal(looksTechnical(''), false)
  assert.equal(looksTechnical('   '), false)
})

console.log('\n[要不要整段发]')

ok('不够长 → 照常拆', () => {
  assert.equal(keepWhole('```js\nconst a = 1\n```', { minChars: 300 }), false)
})

ok('够长 + 技术 → 整段发', () => {
  const text = `看这个：\n\`\`\`js\n${'const a = 1\n'.repeat(40)}\`\`\`\n就这样`
  assert.ok(text.length > 300)
  assert.equal(keepWhole(text, { minChars: 300 }), true)
})

ok('够长但不像技术 → 照常拆', () => {
  const text = '今天真的好累啊，'.repeat(50)
  assert.ok(text.length > 300)
  assert.equal(keepWhole(text, { minChars: 300 }), false)
})

ok('technicalOnly=false → 够长就整段发', () => {
  const text = '今天真的好累啊，'.repeat(50)
  assert.equal(keepWhole(text, { minChars: 300, technicalOnly: false }), true)
})

ok('minChars=0 → 关掉这个例外', () => {
  const text = `\`\`\`js\n${'x\n'.repeat(400)}\`\`\``
  assert.equal(keepWhole(text, { minChars: 0 }), false)
})

console.log('\n[没有汉字的行：命令救回 / 自评丢弃]')

ok('curl 那条救命命令要留', () => {
  assert.equal(looksLikeCodeLine('curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -'), true)
})

ok('apt / npm 要留', () => {
  assert.equal(looksLikeCodeLine('sudo apt install -y nodejs'), true)
  assert.equal(looksLikeCodeLine('sudo npm i -g @deepseek-ai/dsh pnpm'), true)
})

ok('两三个词的小命令要留', () => {
  assert.equal(looksLikeCodeLine('dsh web'), true)
  assert.equal(looksLikeCodeLine('sleep 30'), true)
  assert.equal(looksLikeCodeLine('pip install foo'), true)
})

ok('模型的英文自评照样丢', () => {
  assert.equal(looksLikeCodeLine("That's factual and short. Two lines is fine."), false)
  assert.equal(looksLikeCodeLine('Good. Two lines.'), false)
  assert.equal(looksLikeCodeLine('Hmm, maybe shorter.'), false)
})

console.log('\n[拆段本身没坏]')

ok('一行一段', () => {
  assert.deepEqual(splitText('第一行\n第二行'), ['第一行', '第二行'])
})

ok('长行会在标点处切', () => {
  const r = splitText('啊'.repeat(20) + '。' + '啊'.repeat(20), 25)
  assert.ok(r.length >= 2)
  assert.equal(r.join(''), '啊'.repeat(20) + '。' + '啊'.repeat(20))
})

console.log(`\n通过 ${pass}，失败 ${fail}`)
if (fail > 0) process.exit(1)
