/**
 * 表情包语义检索：借记忆库插件（fast-ivf-rag）的嵌入器，把「图的名字」变成向量。
 *
 * 为什么不是自己加载模型：rag 的 `worker-embedder.js` 里写着 ——
 * 「主线程里不再加载 onnxruntime … 不会撞上『同进程两份 ORT 会话』的 V8 HandleScope FATAL」。
 * 我们要是再起一份，很可能直接把 DSH 进程带走。而且模型 22.9MB，白烧两遍内存。
 *
 * 所以这里只做两件事：
 *   ① 通过 `ctx.get('fastIvfEmbed')` 拿到 rag 架出来的那一个实例（拿不到就降级）
 *   ② 管向量本身的编解码和余弦
 *
 * 降级链：服务不可用 / 报错 / 超时 → 调用方退回关键词匹配（faces.js 的 pickFace）。
 */

/** 服务查找缓存：每次发图都 ctx.get 一遍没必要，但也不能一直钉着（宿主可能重启插件）。 */
const LOOKUP_TTL = 30_000

/** 向量转 base64（float32）。384 维 ≈ 2KB，比 JSON 数组小一半多。 */
export function vecToB64(vec) {
  try {
    const f = vec instanceof Float32Array ? vec : Float32Array.from(vec ?? [])
    if (f.length === 0) return ''
    return Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64')
  } catch {
    return ''
  }
}

/** base64 转回 Float32Array；坏数据返回 null。 */
export function b64ToVec(text) {
  try {
    const buf = Buffer.from(String(text ?? ''), 'base64')
    if (buf.length === 0 || buf.length % 4 !== 0) return null
    return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4)
  } catch {
    return null
  }
}

/** 余弦相似度。bge 的输出本来就是归一化的，但这里按完整算，换了模型也不会错。 */
export function cosine(a, b) {
  const x = a instanceof Float32Array ? a : Float32Array.from(a ?? [])
  const y = b instanceof Float32Array ? b : Float32Array.from(b ?? [])
  const n = Math.min(x.length, y.length)
  if (n === 0) return 0
  let dot = 0
  let nx = 0
  let ny = 0
  for (let i = 0; i < n; i += 1) {
    dot += x[i] * y[i]
    nx += x[i] * x[i]
    ny += y[i] * y[i]
  }
  if (nx === 0 || ny === 0) return 0
  return dot / (Math.sqrt(nx) * Math.sqrt(ny))
}

/**
 * 建一个面向表情包的嵌入代理。
 *
 * @param {{ctx:any, config:any, logger:any}} deps
 */
export function createFaceEmbed({ ctx, config, logger }) {
  let lookup = { svc: null, at: 0 }

  /** 页面上的开关：默认开（有服务就用，没有自动降级）。 */
  function enabled() {
    return config?.faceEmbedEnabled !== false
  }

  /** 拿 rag 架出来的实例；拿不到返回 null（正常情况，不是错误）。 */
  function service() {
    const now = Date.now()
    if (lookup.at && now - lookup.at < LOOKUP_TTL) return lookup.svc
    let svc = null
    try {
      svc = typeof ctx?.get === 'function' ? ctx.get('fastIvfEmbed') ?? null : null
    } catch {
      svc = null // 没 inject / 别人没 provide —— 都当不可用
    }
    lookup = { svc, at: now }
    return svc
  }

  /**
   * 给页面看的完整状态。
   * @returns {Promise<{enabled:boolean, available:boolean, dims:number, kind:string, modelDir:string, reason:string}>}
   */
  async function status() {
    if (!enabled()) {
      return { enabled: false, available: false, dims: 0, kind: '', modelDir: '', reason: '开关关着' }
    }
    const svc = service()
    if (!svc) {
      return {
        enabled: true,
        available: false,
        dims: 0,
        kind: '',
        modelDir: '',
        reason: '没找到记忆库插件（fast-ivf-rag）提供的嵌入服务',
      }
    }
    try {
      const st = typeof svc.status === 'function' ? await svc.status() : {}
      return {
        enabled: true,
        available: Boolean(st?.available),
        dims: Number(st?.dims) || 0,
        kind: String(st?.kind ?? ''),
        modelDir: String(st?.modelDir ?? ''),
        reason: String(st?.reason ?? '') || (st?.available ? '' : '嵌入器还没就绪'),
      }
    } catch (err) {
      return {
        enabled: true,
        available: false,
        dims: 0,
        kind: '',
        modelDir: '',
        reason: `嵌入服务报错：${err?.message ?? err}`,
      }
    }
  }

  /** 能不能真的算向量（开关 + 服务都在）。 */
  function usable() {
    return enabled() && Boolean(service())
  }

  async function embedQuery(text) {
    const svc = service()
    if (!svc || !enabled()) return null
    const s = String(text ?? '').trim()
    if (!s) return null
    try {
      const v = await svc.embedQuery(s)
      return v ? Float32Array.from(v) : null
    } catch (err) {
      logger?.warn?.(`[dsh-qq] 表情包嵌入查询失败（这次退回关键词）：${err?.message ?? err}`)
      return null
    }
  }

  async function embedPassages(texts) {
    const svc = service()
    if (!svc || !enabled()) return null
    const list = (Array.isArray(texts) ? texts : []).map((t) => String(t ?? '').trim())
    if (list.length === 0) return []
    try {
      const out = await svc.embedPassages(list)
      return (out ?? []).map((v) => (v ? Float32Array.from(v) : null))
    } catch (err) {
      logger?.warn?.(`[dsh-qq] 表情包嵌入失败（这条不收向量）：${err?.message ?? err}`)
      return null
    }
  }

  return { enabled, usable, status, embedQuery, embedPassages, cosine, reset: () => (lookup = { svc: null, at: 0 }) }
}
