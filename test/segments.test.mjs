#!/usr/bin/env node
/**
 * 正文 → OneBot 消息段。
 *
 * 2026-11-01：之前这里只产出纯文本，插件**根本发不出 @**，
 * 模型写什么语法都会被当成字面文字发出去。姐姐和小鲸鲸在群里
 * 折腾了半小时找 32 位 openid —— 其实 OneBot 的 at 段要的是 **QQ 号**，
 * openid 是 qqbot（官方机器人）那套协议的东西，NapCat 这条腿用不上。
 */
import assert from 'node:assert/strict'
import { textSegments } from '../src/onebot/segment.js'

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

const text = (t) => ({ type: 'text', data: { text: t } })
const at = (qq) => ({ type: 'at', data: { qq } })

ok('纯文字原样变成一个 text 段', () => {
  assert.deepEqual(textSegments('今天天气不错'), [text('今天天气不错')])
})

ok('空串给空数组', () => {
  assert.deepEqual(textSegments(''), [])
  assert.deepEqual(textSegments(null), [])
})

ok('<@QQ号> 转成 at 段', () => {
  assert.deepEqual(textSegments('<@957295093> 在吗'), [at('957295093'), text(' 在吗')])
})

ok('qqbot 的完整写法也认', () => {
  assert.deepEqual(textSegments('<qqbot-at-user id="1718935283" /> 早'), [
    at('1718935283'),
    text(' 早'),
  ])
})

ok('CQ 码也认', () => {
  assert.deepEqual(textSegments('[CQ:at,qq=123456] hi'), [at('123456'), text(' hi')])
})

ok('@全体成员', () => {
  assert.deepEqual(textSegments('<@all> 开会了'), [at('all'), text(' 开会了')])
  assert.deepEqual(textSegments('[CQ:at,qq=all]'), [at('all')])
})

ok('夹在中间也能拆出来', () => {
  assert.deepEqual(textSegments('前面<@957295093>后面还有字'), [
    text('前面'),
    at('957295093'),
    text('后面还有字'),
  ])
})

ok('一句里两个 @', () => {
  assert.deepEqual(textSegments('<@111111> 和 <@222222> 都来'), [
    at('111111'),
    text(' 和 '),
    at('222222'),
    text(' 都来'),
  ])
})

ok('数字太短不当 QQ 号（防止误伤', () => {
  assert.deepEqual(textSegments('<@123>'), [text('<@123>')])
})

ok('没有 @ 时不掺空 text 段', () => {
  const r = textSegments('<@957295093>')
  assert.equal(r.length, 1)
  assert.equal(r[0].type, 'at')
})

console.log(`\n通过 ${pass}，失败 ${fail}`)
if (fail > 0) process.exit(1)
