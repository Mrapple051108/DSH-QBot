/**
 * 会话创建：并发只建一个壳 / 换壳有上限。
 *
 *   node test/session-obtain.test.mjs
 *
 * 2026-11-03 的事故：群里同一毫秒冒出一串
 * `1ab7e997-…-rmw0pvnj0 / j2 / j5 / j7 / ja / jc / je` —— 同一条路并发 obtain，
 * 每一路都自己走一遍「create 失败 → resume 失败 → 换壳重开」。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionManager } from '../src/session.js'

let pass = 0
const ok = (label) => {
  pass += 1
  console.log(`${label}  ✅`)
}

const silent = { info() {}, warn() {}, debug() {}, error() {} }
const tmp = mkdtempSync(join(tmpdir(), 'sess-'))
const config = { workspaceRoot: tmp, isolateByPeer: true, sessionIdleTimeout: 600000 }

function makeManager({ create } = {}) {
  const creates = []
  const agents = {
    get: () => undefined,
    resume: async () => {
      throw new Error('没有这个会话')
    },
    create: async ({ sessionId }) => {
      creates.push(sessionId)
      if (create) return create(sessionId, creates)
      // 默认行为：base id 一律「已存在」，只有 -r 开头的壳能建出来
      if (!sessionId.includes('-r')) throw new Error('session already exists')
      return { agent: { whenIdle: async () => {}, followup() {} }, dispose() {} }
    },
  }
  const m = new SessionManager({ agents, selfId: '10000', config, logger: silent, home: join(tmp, '.state') })
  return { m, creates }
}

try {
  /* ① 并发三次 obtain：只该建出一个壳 */
  {
    const { m, creates } = makeManager()
    const args = { scope: 'group', peerId: '770375717', label: '测试群' }
    const [a, b, c] = await Promise.all([m.obtain(args), m.obtain(args), m.obtain(args)])
    assert.equal(a, b, '三次并发应该拿到同一个 record')
    assert.equal(b, c, '三次并发应该拿到同一个 record')
    const shells = creates.filter((id) => id.includes('-r'))
    assert.equal(shells.length, 1, `只该建一个壳，实际建了 ${shells.length} 个：${shells.join(', ')}`)
    ok('① 并发 obtain 只建一个会话（single-flight）')
    m.stop()
  }

  /* ② 并发不同 peer：各建各的，互不干扰 */
  {
    const { m, creates } = makeManager()
    await Promise.all([
      m.obtain({ scope: 'group', peerId: '111', label: '群A' }),
      m.obtain({ scope: 'group', peerId: '222', label: '群B' }),
    ])
    const shells = creates.filter((id) => id.includes('-r'))
    assert.equal(shells.length, 2, '两个群各自一个壳')
    ok('② 不同会话互不影响')
    m.stop()
  }

  /* ③ 建不出来时换壳有上限，不会无限生 */
  {
    const { m, creates } = makeManager({
      create: async () => {
        throw new Error('一直建不出来')
      },
    })
    const args = { scope: 'group', peerId: '333', label: '坏群' }
    let lastErr = null
    for (let i = 0; i < 4; i++) {
      try {
        await m.obtain(args)
      } catch (err) {
        lastErr = err
      }
    }
    assert.ok(lastErr, '总该抛出一次错')
    const shells = creates.filter((id) => id.includes('-r'))
    assert.ok(shells.length <= 3, `换壳次数要有上限，实际建了 ${shells.length} 个壳`)
    ok('③ 换壳有上限（不会无限新建）')
    m.stop()
  }

  /* ④ 建出来之后，同一 peer 再 obtain 不再 create */
  {
    const { m, creates } = makeManager()
    const args = { scope: 'group', peerId: '444', label: '正常群' }
    const first = await m.obtain(args)
    const before = creates.length
    const again = await m.obtain(args)
    assert.equal(again, first, '第二次应该命中内存里的 record')
    assert.equal(creates.length, before, '第二次不该再 create')
    ok('④ 命中内存后不再新建')
    m.stop()
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n全部通过（${pass} 组）`)
