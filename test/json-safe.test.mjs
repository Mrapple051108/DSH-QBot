/**
 * 工具返回值必须「无损 JSON」。
 *   node test/json-safe.test.mjs
 *
 * 2026-11-04 事故：
 *   `tool "qq_keep_face" returned invalid output: value is not lossless JSON`
 * 根因是 `keepFace` 返回里有 `reason: saved ? undefined : '写盘失败'`。
 * 对象里带 `undefined`，`JSON.stringify` 会把这个键丢掉 —— "值"和"序列化后的值"
 * 对不上，宿主判失败。这个用例把同一类写法全钉住。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jsonSafe, safeToolOutput, conformToolOutput } from '../src/shared/json-safe.js'
import { keepFace } from '../src/faces.js'

let n = 0
const ok = (msg) => console.log(`${String(++n).padStart(2)} ${msg}  ✅`)

/** 「无损」的判据：序列化再解析回来，跟修完的值一模一样。 */
function lossless(value) {
  const text = JSON.stringify(value)
  assert.equal(typeof text, 'string', '序列化失败')
  assert.deepEqual(JSON.parse(text), value, '序列化再解析回来变样了')
  return text
}

/* ① 对象里的 undefined 直接不写（这就是 qq_keep_face 那个 bug） */
{
  const fixed = safeToolOutput({ ok: true, added: true, total: 3, reason: undefined })
  assert.deepEqual(fixed, { ok: true, added: true, total: 3 })
  lossless(fixed)
  ok('对象里的 undefined 不写（事故原样复现）')
}

/* ② 数组里的 undefined 变 null（位置不能塌） */
{
  const fixed = safeToolOutput({ list: ['a', undefined, 'c'] })
  assert.deepEqual(fixed, { list: ['a', null, 'c'] })
  lossless(fixed)
  ok('数组里的 undefined → null')
}

/* ③ NaN / Infinity → null */
{
  const fixed = safeToolOutput({ a: NaN, b: Infinity, c: -Infinity, d: 1.5 })
  assert.deepEqual(fixed, { a: null, b: null, c: null, d: 1.5 })
  lossless(fixed)
  ok('NaN / Infinity → null')
}

/* ④ BigInt → 字符串，日期 → ISO */
{
  const d = new Date('2026-11-04T06:00:00.000Z')
  const fixed = safeToolOutput({ big: 10n, at: d })
  assert.deepEqual(fixed, { big: '10', at: '2026-11-04T06:00:00.000Z' })
  lossless(fixed)
  ok('BigInt / Date 都能落地')
}

/* ⑤ Map / Set / TypedArray 转成普通结构（向量别直接扔给宿主） */
{
  const fixed = safeToolOutput({ m: new Map([['a', 1]]), s: new Set([1, 2]), v: new Float32Array([0.5, 0.25]) })
  assert.deepEqual(fixed, { m: { a: 1 }, s: [1, 2], v: [0.5, 0.25] })
  lossless(fixed)
  ok('Map / Set / TypedArray 转普通结构')
}

/* ⑥ 函数、symbol 丢掉；嵌套也修 */
{
  const fixed = safeToolOutput({ a: () => 1, b: Symbol('x'), deep: { c: undefined, d: NaN } })
  assert.deepEqual(fixed, { deep: { d: null } })
  lossless(fixed)
  ok('函数 / symbol 丢掉，嵌套照样修')
}

/* ⑦ 修的时候要报路径（日志里得看得出是哪个字段） */
{
  const hits = []
  jsonSafe({ ok: true, nested: { reason: undefined }, arr: [NaN] }, (path, what) => hits.push([path, what]))
  const paths = hits.map((h) => h[0])
  assert.ok(paths.includes('$.nested.reason'), `应该报出 $.nested.reason，实际：${paths}`)
  assert.ok(paths.includes('$.arr[0]'), `应该报出 $.arr[0]，实际：${paths}`)
  ok('修复点带路径')
}

/* ⑧ 整个返回是 undefined → null（别把 undefined 交给宿主） */
{
  assert.equal(safeToolOutput(undefined), null)
  assert.equal(safeToolOutput(() => 1), null)
  ok('顶层 undefined / 函数 → null')
}

/* ⑨ schema 一致性：声明的之外不许有，类型不对顺手纠 */
{
  const schema = {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      added: { type: 'boolean' },
      total: { type: 'integer' },
      vec: { type: 'boolean' },
      reason: { type: 'string' },
    },
    required: ['ok'],
    additionalProperties: false,
  }
  const fixes = []
  const out = conformToolOutput(
    { ok: true, added: 'true', total: '3.7', vec: 1, extra: '不该出现', reason: 200 },
    schema,
    (path, what) => fixes.push([path, what]),
  )
  assert.deepEqual(out, { ok: true, added: 'true', total: 3, vec: true, reason: '200' })
  assert.equal('extra' in out, false, '没声明的字段必须丢掉，否则宿主报 invalid output')
  lossless(out)
  assert.ok(fixes.some(([p]) => p === 'extra'), '丢字段要打日志')

  // keepFace 现在会回 vec，而老 schema 没声明它 —— 正是靠这层裁掉才不会炸
  assert.deepEqual(conformToolOutput({ ok: true, total: 1, vec: true }, { properties: { ok: {}, total: {} } }), {
    ok: true,
    total: 1,
  })
  ok('按 schema 裁掉多余字段、顺手纠类型')
}

/* ⑩ 真跑一次 keepFace：返回值必须能无损序列化，且没有 undefined */
{
  const dir = mkdtempSync(join(tmpdir(), 'qbot-face-'))
  try {
    const config = { faceRoot: dir }
    const img = join(dir, 'cat.png')
    writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    // 嵌入服务不可用（最常见的情况）→ vec 应该是 false，reason 干脆不存在
    const r1 = await keepFace(config, { path: img, summary: '干饭的猫' }, null)
    assert.equal(r1.ok, true)
    assert.equal(r1.added, true)
    assert.equal('reason' in r1, false, `不该有 reason 这个键：${JSON.stringify(r1)}`)
    const fixed1 = safeToolOutput(r1)
    assert.deepEqual(Object.keys(fixed1).sort(), ['added', 'ok', 'total', 'vec'])
    lossless(fixed1)

    // 再收一次同一张：走"已经收过"的分支
    const r2 = await keepFace(config, { path: img, summary: '干饭的猫' }, null)
    assert.equal(r2.added, false)
    lossless(safeToolOutput(r2))

    // 收一张不存在的图：这条分支带 reason（字符串），必须照样能用
    const r3 = await keepFace(config, { path: join(dir, 'nope.png') }, null)
    assert.equal(r3.ok, false)
    assert.equal(typeof r3.reason, 'string')
    lossless(safeToolOutput(r3))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  ok('keepFace 三条分支的返回值都能无损序列化')
}

console.log('\n全部通过')
