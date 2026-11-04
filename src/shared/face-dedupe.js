/**
 * face-dedupe.js —— 「这张是不是跟收藏里某张太像了」的纯计算层。
 *
 * 2026-11-04 姐姐要的：保存表情包时，如果它的**标签词向量**跟已有向量余弦相似度超过阈值，
 * 就在缩略图右上角打个黄圈感叹号；再给「一键去重 / 添加时自动丢弃重复 / 阈值调整」。
 *
 * 三个约束写在最前面，免得后来改错：
 *   ① **不提示智能体**。判断完全由插件做，不进工具返回值、不进提示词；
 *   ② **子线程 + 异步**。比对是 O(n²) 的余弦，别压在消息链上（200 张 × 384 维 ≈ 8M 次乘加，
 *      不快，而且会话正忙的时候它不该抢主线程）；
 *   ③ 纯函数。不读盘、不碰 config —— 测试能直接喂一组向量。
 *
 * 这里只放「解码 + 余弦 + 两两扫描」，worker 和调用方都复用它。
 */

/** base64 → Float32Array（和 face-embed.js 的 vecToB64 是一套编码）。坏数据返回 null。 */
export function b64ToVec(text) {
  try {
    const buf = Buffer.from(String(text ?? ''), 'base64')
    if (buf.length === 0 || buf.length % 4 !== 0) return null
    return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4)
  } catch {
    return null
  }
}

/**
 * 余弦相似度。bge 的输出本来就是归一化的，但这里按完整公式算 —— 换了模型也不会错。
 * 任一向量为空 / 长度不等 → 0（当成"不像"）。
 */
export function cosine(a, b) {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]
    const y = b[i]
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na <= 0 || nb <= 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** 并查集：把"像"的连成一簇。 */
function makeUnion(n) {
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (i) => {
    let x = i
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const union = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra === rb) return
    // 小的当根：根天然就是"簇里最早入库的那条"
    if (ra < rb) parent[rb] = ra
    else parent[ra] = rb
  }
  return { find, union }
}

/**
 * 两两扫描：超过阈值的两两连成一簇，簇里**最早入库的那条**是"本体"，其余都是疑似重复。
 *
 * `dupOf` 一律指向簇里的本体 —— 一键去重要靠它：留最早的、删后来的，
 * 这样"当时先收的那张"不会被删掉。
 *
 * @param {Array<{id:string, vec:string|Float32Array}>} items  vec 是 base64 或已解码的向量
 * @param {number} threshold 0~1
 * @returns {{flags: Array<{id:string,dup:boolean,dupOf:string,score:number}>, pairs: Array<{a:string,b:string,score:number}>, compared:number, dupCount:number}}
 */
export function scanPairs(items, threshold = 0.95) {
  const list = (Array.isArray(items) ? items : [])
    .map((it) => ({
      id: String(it?.id ?? ''),
      v: it?.vec instanceof Float32Array ? it.vec : b64ToVec(it?.vec),
    }))
    .filter((it) => it.id && it.v && it.v.length > 0)

  const thr = Math.min(1, Math.max(0, Number(threshold) || 0))
  const { find, union } = makeUnion(list.length)
  /** 记下每条跟谁最像（同一个簇里无所谓，只用来给界面写"跟谁像"） */
  const best = list.map(() => ({ id: '', score: 0 }))
  const pairs = []
  let compared = 0

  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      compared += 1
      const s = cosine(list[i].v, list[j].v)
      if (s < thr) continue
      union(i, j)
      pairs.push({ a: list[i].id, b: list[j].id, score: Math.round(s * 1000) / 1000 })
      if (s > best[i].score) best[i] = { id: list[j].id, score: s }
      if (s > best[j].score) best[j] = { id: list[i].id, score: s }
    }
  }

  // 簇里最早的那条 = 本体（根）
  const sizes = new Map()
  for (let i = 0; i < list.length; i += 1) {
    const r = find(i)
    sizes.set(r, (sizes.get(r) ?? 0) + 1)
  }

  const flags = list.map((it, i) => {
    const root = find(i)
    if ((sizes.get(root) ?? 0) < 2) return { id: it.id, dup: false, dupOf: '', score: 0 }
    const head = list[root].id
    return {
      id: it.id,
      dup: true,
      dupOf: head === it.id ? '' : head,
      score: Math.round((best[i].score || 0) * 1000) / 1000,
    }
  })

  return { flags, pairs, compared, dupCount: flags.filter((f) => f.dup).length }
}
