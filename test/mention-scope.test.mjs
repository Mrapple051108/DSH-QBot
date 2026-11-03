#!/usr/bin/env node
/**
 * 「这个群要不要 @ 才接话」的按群规则。
 *
 * 由来（2026-11-01 姐姐）：原来是个全局开关，要么全群都得 @，要么全群都不用。
 * 她要的是「某些群必须 @、某些群随便说」—— 用两个例外名单做，不维护群列表。
 */
import assert from 'node:assert/strict'
import { needMention } from '../src/shared/mention.js'

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

const BASE = { requireMention: true, groupMustMention: [], groupNoMention: [] }

ok('全局开着、不在任何名单 → 要 @', () => {
  assert.equal(needMention(BASE, '111'), true)
})

ok('全局关着、不在任何名单 → 不要 @', () => {
  assert.equal(needMention({ ...BASE, requireMention: false }, '111'), false)
})

ok('全局关着，但这个群在 must 名单里 → 要 @', () => {
  const cfg = { ...BASE, requireMention: false, groupMustMention: ['1130590541'] }
  assert.equal(needMention(cfg, '1130590541'), true)
  assert.equal(needMention(cfg, '999'), false, '别的群仍然按全局走')
})

ok('全局开着，但这个群在 noMention 名单里 → 不要 @', () => {
  const cfg = { ...BASE, requireMention: true, groupNoMention: ['770375717'] }
  assert.equal(needMention(cfg, '770375717'), false)
  assert.equal(needMention(cfg, '999'), true, '别的群仍然要 @')
})

ok('两个名单都写了同一个群 → must 赢', () => {
  const cfg = { ...BASE, groupMustMention: ['1'], groupNoMention: ['1'] }
  assert.equal(needMention(cfg, '1'), true, '宁可漏接，也别在不该插嘴的地方插嘴')
})

ok('群号是数字也认（有的地方传的是 number）', () => {
  const cfg = { ...BASE, groupNoMention: ['770375717'] }
  assert.equal(needMention(cfg, 770375717), false)
})

ok('名单里有空格 / 空串也不误判', () => {
  const cfg = { ...BASE, groupNoMention: [' 770375717 ', '', '  '] }
  assert.equal(needMention(cfg, '770375717'), false)
  assert.equal(needMention(cfg, '111'), true)
})

ok('配置缺字段也不炸', () => {
  assert.equal(needMention({}, '1'), true, '默认要 @')
  assert.equal(needMention({ requireMention: false }, '1'), false)
  assert.equal(needMention(null, '1'), true)
})

/* ── 群级三态 mentionMode（2026-11-02）──
   在群聊设置页里直接选，不用回全局那边填群号数组。 */

ok('mentionMode=must → 不管全局开没开都得 @', () => {
  assert.equal(needMention({ requireMention: false, mentionMode: 'must' }, '1'), true)
  assert.equal(needMention({ requireMention: false, mentionMode: 'must', groupNoMention: ['1'] }, '1'), true)
})

ok('mentionMode=never → 不用 @ 也接', () => {
  assert.equal(needMention({ requireMention: true, mentionMode: 'never' }, '1'), false)
  assert.equal(needMention({ requireMention: true, mentionMode: 'never', groupMustMention: ['1'] }, '1'), false)
})

ok('mentionMode=follow / 缺省 → 走全局那套', () => {
  assert.equal(needMention({ requireMention: true, mentionMode: 'follow' }, '1'), true)
  assert.equal(needMention({ requireMention: false, mentionMode: 'follow' }, '1'), false)
  assert.equal(needMention({ requireMention: true, mentionMode: 'follow', groupNoMention: ['1'] }, '1'), false)
  assert.equal(needMention({ requireMention: false }, '1'), false, '没有 mentionMode 的老配置照旧')
})

ok('mentionMode 优先级高于两个群号名单', () => {
  const cfg = { requireMention: true, mentionMode: 'never', groupMustMention: ['1'] }
  assert.equal(needMention(cfg, '1'), false, '群级三态说了算')
  const cfg2 = { requireMention: false, mentionMode: 'must', groupNoMention: ['1'] }
  assert.equal(needMention(cfg2, '1'), true)
})

ok('乱填的 mentionMode 当 follow 处理，不炸', () => {
  assert.equal(needMention({ requireMention: true, mentionMode: '要' }, '1'), true)
  assert.equal(needMention({ requireMention: false, mentionMode: 123 }, '1'), false)
})

console.log(`\n通过 ${pass}，失败 ${fail}`)
if (fail > 0) process.exit(1)
