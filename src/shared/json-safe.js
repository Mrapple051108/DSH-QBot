/**
 * json-safe.js —— 把工具返回值修成「一定能序列化成 JSON」的形状。
 *
 * 2026-11-04 姐姐报的：
 *   `tool "qq_keep_face" returned invalid output: value is not lossless JSON`
 *
 * 根因不在这个工具的逻辑，而在它的返回值里带了 `reason: undefined`
 * （`saved ? undefined : '写盘失败'` 那种写法）。宿主要求工具返回值**无损**
 * 等价于 JSON：`JSON.stringify` 会把对象里的 `undefined` 直接丢掉，
 * 于是"值"和"序列化之后的值"不是同一个东西 —— 宿主宁可直接报错。
 * 同理还有 NaN / Infinity / BigInt / 函数 / Map / Date 这些。
 *
 * 为什么做成一层统一兜底、而不是逐个工具手改：
 *   工具是插件里最容易被随手加的地方，谁都可能写一句 `xxx: cond ? undefined : y`。
 *   一处漏网就是"用户点收图，弹个红字"，而且错误信息完全看不出是哪个字段。
 *   所以在注册口包一层：能修的自己修掉，修的时候喊一声，别把问题吞了。
 */

/** 能直接进 JSON 的标量。 */
const isScalar = (v) =>
  v === null ||
  typeof v === 'string' ||
  typeof v === 'boolean' ||
  (typeof v === 'number' && Number.isFinite(v))

/**
 * 修一个值。
 *
 * @param {unknown} value
 * @param {(path:string, what:string)=>void} [onFix] 每修一处回调一次（用来打日志）
 * @param {string} [path] 当前路径，只给人看
 * @returns {unknown} 可以直接 JSON.stringify 的值
 */
export function jsonSafe(value, onFix, path = '$') {
  const note = (what) => {
    try {
      onFix?.(path, what)
    } catch {
      /* 日志失败不影响返回 */
    }
  }

  if (value === undefined) {
    note('undefined')
    return undefined // 交给上层决定：对象里丢掉、数组里变 null
  }
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value
    note(`非有限数（${String(value)}）→ null`)
    return null
  }
  if (typeof value === 'bigint') {
    note('BigInt → 字符串')
    return value.toString()
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    note(`${typeof value} 不能进 JSON，已丢弃`)
    return undefined
  }
  if (value instanceof Date) {
    note('Date → ISO 字符串')
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => {
      const v = jsonSafe(item, onFix, `${path}[${i}]`)
      return v === undefined ? null : v
    })
  }
  if (value instanceof Map) {
    note('Map → 对象')
    const out = {}
    for (const [k, v] of value) {
      const clean = jsonSafe(v, onFix, `${path}.${String(k)}`)
      if (clean !== undefined) out[String(k)] = clean
    }
    return out
  }
  if (value instanceof Set) {
    note('Set → 数组')
    return [...value].map((v, i) => {
      const clean = jsonSafe(v, onFix, `${path}[${i}]`)
      return clean === undefined ? null : clean
    })
  }
  if (ArrayBuffer.isView(value)) {
    // Float32Array / Uint8Array 之类：转普通数组，别让宿主拿到二进制
    note(`TypedArray（${value.constructor?.name ?? '?'}）→ 数组`)
    return Array.from(value, (n) => (Number.isFinite(n) ? n : 0))
  }
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      const clean = jsonSafe(v, onFix, `${path}.${k}`)
      // undefined / 函数 / symbol 的键直接不写 —— 这是 JSON 的语义，不是丢数据
      if (clean !== undefined) out[k] = clean
    }
    return out
  }
  note('未知类型，已丢弃')
  return undefined
}

/**
 * 给工具返回值套一层。`onFix` 里自己决定怎么喊（通常是 logger.warn）。
 *
 * @param {unknown} value
 * @param {(path:string, what:string)=>void} [onFix]
 */
export function safeToolOutput(value, onFix) {
  const clean = jsonSafe(value, onFix)
  return clean === undefined ? null : clean
}

/**
 * 再按**工具自己声明的 schema** 过一遍：多余字段丢掉、数量/布尔顺手纠一下。
 *
 * 为什么需要：工具声明的 `output.schema` 普遍带 `additionalProperties: false`。
 * 一旦实现里多返回一个字段（比如 `qq_keep_face` 顺手回了 `vec`），宿主就会报
 * `returned invalid output` —— 和 `undefined` 是同一类事故，只是原因不同。
 * 与其等它炸一次改一次，不如在这里按声明裁一遍。
 *
 * @param {unknown} value  已经过 jsonSafe 的值
 * @param {object} [schema] `spec.output.schema`
 * @param {(path:string, what:string)=>void} [onFix]
 */
export function conformToolOutput(value, schema, onFix) {
  const props = schema?.properties
  if (!props || !value || typeof value !== 'object' || Array.isArray(value)) return value
  const note = (path, what) => {
    try {
      onFix?.(path, what)
    } catch {
      /* ignore */
    }
  }
  const out = {}
  for (const [key, raw] of Object.entries(value)) {
    const field = props[key]
    if (!field) {
      note(key, 'schema 里没声明这个字段，已丢掉')
      continue
    }
    let v = raw
    const type = field.type
    // 轻量纠偏：数字写成字符串、布尔写成 0/1 这类，宿主也会判类型不符
    if ((type === 'integer' || type === 'number') && typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) {
      note(key, `字符串 "${v}" → 数字`)
      v = Number(v)
      if (type === 'integer') v = Math.trunc(v)
    } else if (type === 'boolean' && (v === 0 || v === 1)) {
      note(key, `${v} → 布尔`)
      v = Boolean(v)
    } else if (type === 'string' && (typeof v === 'number' || typeof v === 'boolean')) {
      note(key, `${typeof v} → 字符串`)
      v = String(v)
    }
    if (type === 'integer' && typeof v === 'number' && !Number.isInteger(v)) {
      note(key, `非整数 ${v} → 取整`)
      v = Math.trunc(v)
    }
    out[key] = v
  }
  for (const key of Array.isArray(schema?.required) ? schema.required : []) {
    if (!(key in out)) note(key, 'required 但没给，宿主可能判不合法')
  }
  return out
}
