/**
 * 表情包查重。
 *   node test/face-dedupe.test.mjs
 *
 * 2026-11-04 姐姐要的：
 *   「保存表情包时，如果它的标签词向量跟已有向量余弦超过阈值，就在缩略图右上角打个黄圈感叹号；
 *    再给一键去重 / 添加时自动丢弃重复 / 阈值调整。注意在子线程且异步，
 *    不要提示智能体有没有重复，完全由插件捕获和处理。」
 *
 * 所以这里钉四件事：
 *   ① 余弦和分簇算得对（本体是最早入库的那条）；
 *   ② 走的是 worker（子线程），起不起来都能退回主线程算出同样结果；
 *   ③ 开了「自动丢弃」时真的不落盘、也不留孤儿文件；
 *   ④ 一键去重只删"跟着别人"的那些，本体留着。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cosine, scanPairs, b64ToVec } from '../src/shared/face-dedupe.js'
import { scanInWorker } from '../src/face-dedupe.js'
import { keepFace, dedupeFaces, facesSnapshotWithDedupe, dedupeThresholdOf } from '../src/faces.js'

let n = 0
const ok = (msg) => console.log(`${String(++n).padStart(2)} ${msg}  ✅`)

const b64 = (arr) => {
  const f = Float32Array.from(arr)
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64')
}
const near = b64([1, 0, 0, 0])
const near2 = b64([0.99, 0.01, 0, 0]) // 跟 near 余弦 ≈ 0.9999
const far = b64([0, 1, 0, 0])

/* ① 余弦本身 */
{
  assert.equal(Math.round(cosine(b64ToVec(near), b64ToVec(near)) * 1000) / 1000, 1)
  assert.equal(cosine(b64ToVec(near), b64ToVec(far)), 0)
  assert.equal(cosine(b64ToVec(near), null), 0, '空向量当"不像"')
  assert.equal(cosine(b64ToVec(near), Float32Array.from([1, 0])), 0, '长度不等当"不像"')
  ok('余弦：同向 1、正交 0、脏输入 0')
}

/* ② 两两扫描：a≈b，c 独立 —— 本体是最早那条 */
{
  const r = scanPairs(
    [
      { id: 'a', vec: near },
      { id: 'b', vec: near2 },
      { id: 'c', vec: far },
    ],
    0.95,
  )
  assert.equal(r.compared, 3)
  assert.equal(r.dupCount, 2)
  const byId = Object.fromEntries(r.flags.map((f) => [f.id, f]))
  assert.equal(byId.a.dup, true, 'a 也得标（界面上两张都要打黄圈）')
  assert.equal(byId.a.dupOf, '', 'a 是本体，不指向别人')
  assert.equal(byId.b.dupOf, 'a', 'b 指向更早的 a')
  assert.equal(byId.c.dup, false)
  assert.equal(r.pairs.length, 1)
  ok('像的两张都标记，dupOf 指向更早那条')
}

/* ③ 阈值起作用：0.9 相似的两张，阈值 0.95 不判重、0.85 就判重 */
{
  const mid = b64([0.9, 0.43589, 0, 0]) // 跟 near 的余弦 ≈ 0.9
  assert.ok(Math.abs(cosine(b64ToVec(near), b64ToVec(mid)) - 0.9) < 0.01)
  assert.equal(scanPairs([{ id: 'a', vec: near }, { id: 'b', vec: mid }], 0.95).dupCount, 0)
  assert.equal(scanPairs([{ id: 'a', vec: near }, { id: 'b', vec: mid }], 0.85).dupCount, 2)
  ok('阈值说了算（0.9 相似的，0.95 不判、0.85 判）')
}

/* ④ 三张成簇：都指向最早的 a */
{
  const r = scanPairs(
    [
      { id: 'a', vec: near },
      { id: 'b', vec: near2 },
      { id: 'c', vec: b64([0.995, 0.005, 0, 0]) },
    ],
    0.9,
  )
  const byId = Object.fromEntries(r.flags.map((f) => [f.id, f]))
  assert.equal(byId.b.dupOf, 'a')
  assert.equal(byId.c.dupOf, 'a')
  ok('一簇三张，dupOf 都收敛到本体')
}

/* ⑤ 走子线程；结果跟主线程算的一致 */
{
  const items = [
    { id: 'a', vec: near },
    { id: 'b', vec: near2 },
    { id: 'c', vec: far },
  ]
  const inWorker = await scanInWorker(items, 0.95, { timeoutMs: 3000 })
  const inline = scanPairs(items, 0.95)
  assert.equal(inWorker.dupCount, inline.dupCount)
  assert.deepEqual(
    inWorker.flags.map((f) => [f.id, f.dup, f.dupOf]),
    inline.flags.map((f) => [f.id, f.dup, f.dupOf]),
  )
  console.log(`     （这一次 ${inWorker.inline ? "退回主线程算的" : "在 worker 里算的"}）`)
  ok('子线程与主线程结果一致')
}

/* ⑥ 空列表 / 一条都没有向量：不炸、不判重 */
{
  const r = await scanInWorker([], 0.95, { timeoutMs: 2000 })
  assert.equal(r.dupCount, 0)
  assert.equal(r.compared, 0)
  ok('空收藏不炸')
}

/* ── 下面动真文件 ── */
const embedOf = (vec) => ({
  usable: () => true,
  embedPassages: async (texts) => texts.map(() => Float32Array.from(vec)),
  embedQuery: async () => null,
})
const IMG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/* ⑦ 开了「自动丢弃」：太像的那张根本不落盘，也不留孤儿文件 */
{
  const dir = mkdtempSync(join(tmpdir(), 'face-dedupe-'))
  try {
    const cfg = { faceRoot: dir, faceDedupeEnabled: true, faceDedupeThreshold: 0.95 }
    const a = join(dir, 'a.png')
    writeFileSync(a, IMG)
    const r1 = await keepFace(cfg, { path: a, summary: '干饭的猫' }, embedOf([1, 0, 0, 0]))
    assert.equal(r1.ok, true)
    assert.equal(r1.added, true, '第一张照收')

    const b = join(dir, 'b.png')
    writeFileSync(b, IMG)
    const r2 = await keepFace(cfg, { path: b, summary: '猫在干饭' }, embedOf([1, 0, 0, 0]))
    assert.equal(r2.ok, true)
    assert.equal(r2.added, false, '太像的那张不存')
    assert.equal(r2.reason, undefined, '**不能**告诉调用方"因为重复" —— 只当没加进去')
    assert.equal('dup' in r2, false, '工具返回值里不该出现 dup 这种线索')

    const files = readdirSync(join(dir, '表情包'))
    assert.equal(files.length, 1, `表情包目录里只该有 1 张，实际 ${files.join(',')}`)
    ok('自动丢弃：不落盘、不留孤儿、不给模型任何线索')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/* ⑧ 关着「自动丢弃」：照存，但列表接口会标黄圈 */
{
  const dir = mkdtempSync(join(tmpdir(), 'face-dedupe-'))
  try {
    const cfg = { faceRoot: dir, faceDedupeEnabled: false, faceDedupeThreshold: 0.95 }
    for (const [name, vec] of [
      ['a.png', [1, 0, 0, 0]],
      ['b.png', [1, 0, 0, 0]],
      ['c.png', [0, 1, 0, 0]],
    ]) {
      const p = join(dir, name)
      writeFileSync(p, IMG)
      await keepFace(cfg, { path: p, summary: name.replace('.png', '') }, embedOf(vec))
    }
    const snap = await facesSnapshotWithDedupe(cfg, {})
    assert.equal(snap.total, 3, '三张都存下来了')
    assert.equal(snap.dedupe.dupCount, 2)
    const flagged = snap.list.filter((f) => f.dup)
    assert.equal(flagged.length, 2, '那两张同向的要打黄圈')
    ok('不自动丢：照存，列表标黄圈')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/* ⑨ 一键去重：留最早那张，删后来的，连文件一起删 */
{
  const dir = mkdtempSync(join(tmpdir(), 'face-dedupe-'))
  try {
    const cfg = { faceRoot: dir, faceDedupeThreshold: 0.95 }
    for (const [name, vec] of [
      ['keep.png', [1, 0, 0, 0]],
      ['dup1.png', [1, 0, 0, 0]],
      ['other.png', [0, 1, 0, 0]],
      ['dup2.png', [1, 0, 0, 0]],
    ]) {
      const p = join(dir, name)
      writeFileSync(p, IMG)
      await keepFace(cfg, { path: p, summary: name.replace('.png', '') }, embedOf(vec))
    }
    const r = await dedupeFaces(cfg, {})
    assert.equal(r.ok, true)
    assert.equal(r.removed, 2, `该删 2 条，实际 ${r.removed}`)
    const left = readdirSync(join(dir, '表情包')).sort()
    assert.deepEqual(left, ['keep.png', 'other.png'], `留错了：${left.join(',')}`)
    ok('一键去重：留本体、删重复、文件一起清')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/* ⑩ 阈值读法：越界要夹回 0.8~0.999 */
{
  assert.equal(dedupeThresholdOf({ faceDedupeThreshold: 0.7 }), 0.8)
  assert.equal(dedupeThresholdOf({ faceDedupeThreshold: 1.5 }), 0.999)
  assert.equal(dedupeThresholdOf({}), 0.95)
  assert.equal(dedupeThresholdOf({ faceDedupeThreshold: '0.9' }), 0.9)
  ok('阈值夹在 0.8~0.999')
}

console.log('\n全部通过')
