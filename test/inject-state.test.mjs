/**
 * 回归测试：注入账本。
 *
 * 2026-11-02 姐姐的反馈：「设置回击以后也没有对我进行攻击，应该是系统提示词没有重新注入」。
 *
 * 聊天规矩（`buildChatPrompt`）里带着人设和脾气，而它是「一个会话只注一次」。
 * 改了人设 / 脾气 / 阈值，历史里那份旧的还在 —— 模型看到的永远是老版本。
 * 所以保存设置时要把它整本作废，下一轮每个会话重新注一份。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInjectState } from '../src/inject-state.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-inj-'))
const file = join(dir, 'inject.json')
const silent = { warn() {} }
let n = 0
const ok = (msg) => console.log(`${String(++n).padStart(2)} ${msg}  ✅`)

try {
  /* ① 基本读写 */
  {
    const st = createInjectState(file, silent)
    assert.equal(st.has('s1'), false)
    st.mark('s1')
    assert.equal(st.has('s1'), true)
    st.forget('s1')
    assert.equal(st.has('s1'), false)
    ok('mark / has / forget')
  }

  /* ② clear：全作废，且落盘 */
  {
    const st = createInjectState(file, silent)
    st.mark('a')
    st.mark('b')
    st.mark('c')
    assert.equal(st.has('a'), true)
    const cleared = st.clear()
    assert.equal(cleared, 3, `应该清掉 3 条，实际 ${cleared}`)
    assert.equal(st.has('a'), false)
    assert.equal(st.has('b'), false)
    assert.equal(st.has('c'), false)
    ok('clear() 把账本清空并返回条数')
  }

  /* ③ clear 之后重开文件，还是空的（真的落盘了） */
  {
    const again = createInjectState(file, silent)
    assert.equal(again.has('a'), false, '重读不能把旧的读回来')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(raw, {}, `文件里应该是空的，实际 ${JSON.stringify(raw)}`)
    ok('clear() 落盘了，重启不会复活')
  }

  /* ④ clear 之后再 mark 照常工作（不是只读一次就废） */
  {
    const st = createInjectState(file, silent)
    st.mark('d')
    assert.equal(st.has('d'), true)
    st.clear()
    st.mark('e')
    assert.equal(st.has('e'), true)
    assert.equal(st.has('d'), false)
    ok('clear 之后还能继续记新的')
  }

  /* ⑤ 空 id / 脏输入不炸 */
  {
    const st = createInjectState(file, silent)
    assert.doesNotThrow(() => st.mark(''))
    assert.doesNotThrow(() => st.mark(null))
    assert.equal(st.has(''), false)
    assert.equal(st.has(null), false)
    assert.doesNotThrow(() => st.forget('不存在'))
    ok('空值 / 不存在的 key 都不炸')
  }

  /* ⑥ 文件坏了当没注过（宁可多注一次，也别让新会话光着） */
  {
    const bad = join(dir, 'bad.json')
    const { writeFileSync } = { writeFileSync: (await import('node:fs')).writeFileSync }
    writeFileSync(bad, '{ 这不是 json', 'utf8')
    const st = createInjectState(bad, silent)
    assert.equal(st.has('anything'), false)
    st.mark('x')
    assert.equal(st.has('x'), true)
    ok('账本文件坏了当空的处理，仍能继续用')
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n全部通过')
