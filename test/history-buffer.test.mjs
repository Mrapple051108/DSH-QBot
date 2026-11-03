#!/usr/bin/env node
/**
 * 群消息缓冲：塞、截断、取走清空。
 *
 * 改这个的直接原因是姐姐说的那句：
 *   「每次发送都会固定找几条，哪怕本来就在记忆里或者回复过」——
 *   缓冲现在必须是消费型的，看过的那批不能再回到眼前。
 */
import assert from 'node:assert/strict'
import { pushHistory, takeHistory, compactLines, HISTORY_HARD_MAX } from '../src/shared/history.js'

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

ok('按容量截断，丢最老的', () => {
  const rec = { history: [] }
  for (let i = 0; i < 30; i += 1) pushHistory(rec, `第 ${i} 条`, 20)
  assert.equal(rec.history.length, 20)
  assert.equal(rec.history[0], '第 10 条', '最老的 10 条应该掉出去')
  assert.equal(rec.history.at(-1), '第 29 条')
})

ok('容量内不截断', () => {
  const rec = { history: [] }
  for (let i = 0; i < 5; i += 1) pushHistory(rec, `第 ${i} 条`, 20)
  assert.equal(rec.history.length, 5)
})

ok('limit=0 走兜底上限，不会无限涨', () => {
  const rec = { history: [] }
  for (let i = 0; i < HISTORY_HARD_MAX + 50; i += 1) pushHistory(rec, `x${i}`, 0)
  assert.equal(rec.history.length, HISTORY_HARD_MAX)
})

ok('取走之后就是空的（消费语义）', () => {
  const rec = { history: [] }
  pushHistory(rec, 'a', 20)
  pushHistory(rec, 'b', 20)
  const taken = takeHistory(rec)
  assert.deepEqual(taken, ['a', 'b'])
  assert.equal(rec.history.length, 0, '取走就得清空，下一轮不该再看见')
})

ok('再取一次是空的', () => {
  const rec = { history: [] }
  pushHistory(rec, 'a', 20)
  takeHistory(rec)
  assert.deepEqual(takeHistory(rec), [])
})

ok('没有 history 字段时也不炸', () => {
  const rec = {}
  pushHistory(rec, 'a', 20)
  assert.deepEqual(rec.history, ['a'])
  assert.deepEqual(takeHistory({}), [])
})

console.log('\n[连续相同的行压成 ×N]')

ok('四张一样的图压成一行 ×4', () => {
  const line = '⟨苹果三块一斤 (1718935283) · 老大 11-01 周日 20:44（晚上）⟩ [图片]'
  assert.deepEqual(compactLines([line, line, line, line]), [`${line} ×4`])
})

ok('中间夹了别人的话就不压（那是两波）', () => {
  const a = '⟨甲⟩ [图片]'
  const b = '⟨乙⟩ 在吗'
  assert.deepEqual(compactLines([a, a, b, a]), [`${a} ×2`, b, a])
})

ok('每句都不一样时原样返回', () => {
  const list = ['a', 'b', 'c']
  assert.deepEqual(compactLines(list), list)
})

ok('空列表返回空', () => {
  assert.deepEqual(compactLines([]), [])
  assert.deepEqual(compactLines(null), [])
})

console.log(`\n通过 ${pass}，失败 ${fail}`)
if (fail > 0) process.exit(1)
