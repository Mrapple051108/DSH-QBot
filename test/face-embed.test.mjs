/**
 * 回归测试：表情包语义检索的底座。
 *
 * 2026-11-02 姐姐定的方案 A：「让记忆库暴露一个服务，两个插件联动复用，没有服务就自动降级」。
 *
 * 这里锁住四件事：
 *   ① 向量编解码不会丢精度、坏数据不炸
 *   ② 余弦算得对（同向 1、正交 0、零向量 0）
 *   ③ 服务拿不到 / 开关关掉时的降级行为
 *   ④ 服务报错时**不抛**，只返回 null 让调用方退回关键词
 */
import assert from 'node:assert/strict'
import { createFaceEmbed, vecToB64, b64ToVec, cosine } from '../src/face-embed.js'

let n = 0
const ok = (msg) => console.log(`${String(++n).padStart(2)} ${msg}  ✅`)
const silent = { warn() {}, info() {}, debug() {} }

/* ① 向量往返 */
{
  const v = new Float32Array([0.1, -0.25, 0.333333, 1, -1, 0])
  const b = vecToB64(v)
  const back = b64ToVec(b)
  assert.equal(back.length, v.length)
  for (let i = 0; i < v.length; i += 1) {
    assert.ok(Math.abs(back[i] - v[i]) < 1e-6, `第 ${i} 位不一致：${back[i]} vs ${v[i]}`)
  }
  assert.equal(vecToB64([]), '')
  assert.equal(b64ToVec(''), null)
  assert.equal(b64ToVec('!!!'), null)
  assert.equal(b64ToVec(null), null)
  ok('float32 → base64 → float32 无损；空/坏数据返回空')
}

/* ② 余弦 */
{
  assert.equal(Math.round(cosine([1, 0, 0], [1, 0, 0]) * 1000) / 1000, 1)
  assert.equal(cosine([1, 0, 0], [0, 1, 0]), 0)
  assert.ok(Math.abs(cosine([1, 1, 0], [1, 1, 0]) - 1) < 1e-9, '同向不等长也算 1')
  assert.equal(cosine([0, 0, 0], [1, 0, 0]), 0, '零向量不能除出 NaN')
  assert.equal(cosine([], []), 0)
  assert.equal(cosine(null, null), 0)
  // 真实一点：384 维随机向量，跟自己的余弦必须是 1
  const v = Float32Array.from({ length: 384 }, (_, i) => Math.sin(i))
  assert.ok(Math.abs(cosine(v, v) - 1) < 1e-6)
  ok('余弦：同向 1 / 正交 0 / 零向量和空值都不炸')
}

/* ③ 没有服务时的降级 */
{
  const ctx = { get: () => undefined }
  const fe = createFaceEmbed({ ctx, config: {}, logger: silent })
  assert.equal(fe.enabled(), true, '默认开')
  assert.equal(fe.usable(), false, '没服务就算不可用')

  const st = await fe.status()
  assert.equal(st.enabled, true)
  assert.equal(st.available, false)
  assert.ok(/没找到记忆库|fast-ivf-rag/.test(st.reason), `原因要说清楚：${st.reason}`)
  assert.equal(await fe.embedQuery('无语'), null, '没服务返回 null')
  assert.equal(await fe.embedPassages(['a']), null)
  ok('没有 rag 服务 → 标记不可用 + 原因；嵌入返回 null（调用方降级）')
}

/* ④ 开关关掉 */
{
  const ctx = { get: () => ({ status: async () => ({ available: true, dims: 384 }) }) }
  const fe = createFaceEmbed({ ctx, config: { faceEmbedEnabled: false }, logger: silent })
  assert.equal(fe.enabled(), false)
  assert.equal(fe.usable(), false)
  const st = await fe.status()
  assert.equal(st.enabled, false)
  assert.equal(st.available, false)
  assert.ok(/开关/.test(st.reason))
  assert.equal(await fe.embedQuery('x'), null)
  ok('开关关掉 → 明确说"开关关着"，嵌入不跑')
}

/* ⑤ 有服务时透传 */
{
  const svc = {
    status: async () => ({ available: true, dims: 384, kind: 'onnx', modelDir: 'C:/m' }),
    embedQuery: async (t) => Float32Array.from([t.length, 1, 0]),
    embedPassages: async (list) => list.map((t) => Float32Array.from([t.length, 1, 0])),
  }
  const ctx = { get: (name) => (name === 'fastIvfEmbed' ? svc : undefined) }
  const fe = createFaceEmbed({ ctx, config: {}, logger: silent })
  assert.equal(fe.usable(), true)
  const st = await fe.status()
  assert.equal(st.available, true)
  assert.equal(st.dims, 384)
  assert.equal(st.modelDir, 'C:/m')
  const v = await fe.embedQuery('无语')
  assert.equal(v[0], 2, '中文两个字')
  const vs = await fe.embedPassages(['a', 'bb'])
  assert.equal(vs.length, 2)
  assert.equal(vs[1][0], 2)
  ok('有服务时状态和嵌入都透传')
}

/* ⑥ 服务报错 → 不抛，返回 null */
{
  const svc = {
    status: async () => {
      throw new Error('模型没加载')
    },
    embedQuery: async () => {
      throw new Error('ORT 崩了')
    },
    embedPassages: async () => {
      throw new Error('ORT 崩了')
    },
  }
  const ctx = { get: () => svc }
  const warns = []
  const fe = createFaceEmbed({ ctx, config: {}, logger: { warn: (m) => warns.push(m) } })
  const st = await fe.status()
  assert.equal(st.available, false)
  assert.ok(/模型没加载/.test(st.reason), `要把原因带出来：${st.reason}`)
  assert.equal(await fe.embedQuery('x'), null, '报错也不能抛')
  assert.equal(await fe.embedPassages(['x']), null)
  assert.ok(warns.length >= 1, '应该记一条日志说明降级了')
  ok('服务报错 → 不抛、返回 null、记日志（调用方退回关键词）')
}

/* ⑦ ctx.get 本身抛错（没 inject 的服务）也要吞掉 */
{
  const ctx = {
    get: () => {
      throw new Error('cannot get service without inject')
    },
  }
  const fe = createFaceEmbed({ ctx, config: {}, logger: silent })
  assert.equal(fe.usable(), false)
  const st = await fe.status()
  assert.equal(st.available, false)
  ok('ctx.get 抛错也当作"没这个服务"')
}

console.log('\n全部通过')
