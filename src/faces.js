/**
 * 表情包收藏夹。
 *
 * 两种条目：
 *  - `mface`：QQ 商城表情，靠 `emoji_id` + `emoji_package_id` 这一对身份证重发
 *  - `image`：一张本地图片（别人发过来、觉得以后想用的表情包），靠文件路径重发
 *
 * 为什么需要它：发商城表情必须同时给出 id，而 Agent 手上没有这份清单 ——
 * 它连「有哪些表情可发」都不知道，只能干瞪眼。所以在收到别人发表情包时，
 * 顺手把身份证记下来存盘；以后 `qq_mface` 不传 id 就从收藏里随机挑一个发。
 *
 * ⚠️ 收藏是有门槛的：默认什么都不收（faceCollectHint 留空 = 关），因为你希望只收某一类图，
 * 而不是把群里什么都存进来变成垃圾场。图片条目由 Agent 判断后主动调用
 * `qq_keep_face` 才进来，插件自己不自动保存图片。
 *
 * ⚠️ 图片必须复制进来，不能只记原路径：收到的图先落在 `图片缓存/` 里，
 * 那是会被 pruneCache 定时清理的地方（见 inbound.js）。只记路径的收藏，
 * 过几天就变成一堆 404 —— 所以 keepFace 会把文件搬进 `表情包/`。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { vecToB64, b64ToVec, cosine } from './face-embed.js'
import { scanInWorker } from './face-dedupe.js'

const MAX_KEEP = 200

/**
 * 收藏文件：放在 `faceRoot`（没填就退回会话根目录 workspaceRoot）下。
 * 表情包是攒出来的资产，不该跟着某一次私聊一起过期。
 * 2026-10-29：加了 `faceRoot` —— 三只 QQ 鲸鲸填同一个目录，就是共用一套收藏。
 */
export function facesPath(config) {
  const base =
    String(config?.faceRoot ?? '').trim() ||
    String(config?.workspaceRoot ?? '').trim() ||
    String(config?.cwd ?? '').trim() ||
    process.cwd()
  return join(base, '表情包收藏.json')
}

/** 图片条目的稳定落点：收藏清单旁边的 `表情包/` 目录。 */
export function facesDir(config) {
  return join(dirname(facesPath(config)), '表情包')
}

/**
 * 把图片复制进 `表情包/`，返回稳定路径。
 * 原图多半在 `图片缓存/` 里，那地方会被定时清理，所以收藏必须留自己的副本。
 */
function storeImage(config, file) {
  const target = join(facesDir(config), basename(file))
  if (resolve(file) === resolve(target)) return target
  mkdirSync(facesDir(config), { recursive: true })
  copyFileSync(file, target)
  return target
}

function load(config) {
  const file = facesPath(config)
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function save(config, list) {
  const file = facesPath(config)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(list.slice(-MAX_KEEP), null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/** mface 的稳定去重键 */
function mfaceKey(f) {
  return `m:${f.packageId}/${f.emojiId}`
}

/** image 的稳定去重键（按路径） */
function imageKey(f) {
  return `i:${f.path}`
}

/**
 * 收到商城表情时调用：把能用的 id 记下来。
 * 缺 emojiId 或 packageId 的一律丢弃 —— 存着也发不出去。
 * @returns {number} 这次新增了几条
 */
export function rememberFaces(config, mfacesLog) {
  if (!Array.isArray(mfacesLog) || mfacesLog.length === 0) return 0
  const usable = mfacesLog.filter((f) => f?.emojiId && f?.packageId)
  if (usable.length === 0) return 0

  const list = load(config)
  const seen = new Set(list.map((f) => (f.kind === 'image' ? imageKey(f) : mfaceKey(f))))
  let added = 0
  for (const f of usable) {
    const entry = {
      kind: 'mface',
      emojiId: String(f.emojiId),
      packageId: String(f.packageId),
      key: String(f.key ?? ''),
      summary: String(f.summary ?? ''),
      at: new Date().toISOString(),
    }
    const k = mfaceKey(entry)
    if (seen.has(k)) continue
    seen.add(k)
    list.push(entry)
    added += 1
  }
  if (added > 0) save(config, list)
  return added
}

/**
 * 把一张本地图片收进收藏（Agent 判断值得收、或 faceCollectHint 命中后主动调用）。
 *
 * 2026-11-02：顺手把「名字 + 标签」嵌成向量一起存 —— 以后要发图时就能按语义挑，
 * 不再只靠关键词。嵌不出来（服务没开 / 报错）就不存向量，退回关键词匹配，不影响收藏本身。
 *
 * @param {{ path: string, summary?: string, tags?: string[] }} input
 * @param {{ usable?: Function, embedPassages?: Function }} [embed] 可选，来自 face-embed.js
 * @returns {Promise<{ ok: boolean, added: boolean, total: number, reason?: string, vec?: boolean }>}
 */
export async function keepFace(config, input, embed) {
  const file = String(input?.path ?? '').trim()
  if (!file) return { ok: false, added: false, total: facesCount(config), reason: 'path 是空的' }
  if (!existsSync(file)) return { ok: false, added: false, total: facesCount(config), reason: `文件不存在：${file}` }

  const list = load(config)

  const tags = Array.isArray(input?.tags)
    ? input.tags.map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 8)
    : []

  const entry = {
    kind: 'image',
    path: '',
    summary: String(input?.summary ?? '').trim(),
    ...(tags.length > 0 ? { tags } : {}),
    at: new Date().toISOString(),
  }

  // 嵌的是「名字 + 标签」，不是图本身（bge 是文本模型）。
  // 算不出来就不存 —— 别写个空向量进去把语义检索搞坏。
  if (embed?.usable?.() === true) {
    const text = [entry.summary, ...tags].filter(Boolean).join(' ')
    if (text) {
      try {
        const vecs = await embed.embedPassages([text])
        const v = Array.isArray(vecs) ? vecs[0] : null
        if (v && v.length > 0) {
          entry.vec = vecToB64(v)
          entry.vecDim = v.length
        }
      } catch {
        /* 嵌不进去就当没有，关键词照用 */
      }
    }
  }

  // 2026-11-04：**先查重，再落盘**。顺序很重要 —— 落盘之后再决定丢弃，
  // `表情包/` 里就会留一张谁也查不到的孤儿图。
  //   ① 开了「添加时自动丢弃重复」：太像就直接不存，**也不告诉模型是重复**
  //      （工具那边只会显示「这个之前就收过了」，不解释原因）；
  //   ② 没开：照存，界面上的黄圈由列表接口现扫现标（不在 JSON 里留状态，
  //      免得阈值一改就全对不上）。
  let near = null
  if (entry.vec) {
    near = await nearestDuplicate(config, entry.vec, { excludePath: file })
    if (near && dedupeAutoOn(config)) {
      return { ok: true, added: false, total: list.length, vec: true }
    }
  }

  // 搬进表情包目录再登记：只记缓存路径的话，缓存一清就全废
  let stored
  try {
    stored = storeImage(config, file)
  } catch (err) {
    return { ok: false, added: false, total: list.length, reason: `复制到表情包目录失败：${err?.message ?? err}` }
  }
  entry.path = stored

  const k = imageKey(entry)
  const existing = list.find((f) => f.kind === 'image' && imageKey(f) === k)
  if (existing) {
    // 以前收过、但那会儿服务还没开 → 这次把向量补上
    if (!existing.vec && entry.vec) {
      existing.vec = entry.vec
      existing.vecDim = entry.vecDim
      if (entry.summary && !existing.summary) existing.summary = entry.summary
      if (entry.tags && !existing.tags) existing.tags = entry.tags
      const saved = save(config, list)
      return {
        ok: saved,
        added: false,
        total: list.length,
        vec: true,
        // 2026-11-04：别写「reason: undefined」—— 宿主判「无损 JSON」会直接报
        // value is not lossless JSON（工具那边已经有兜底，这里从源头就不写）
        ...(saved ? {} : { reason: '写盘失败' }),
      }
    }
    return { ok: true, added: false, total: list.length, vec: Boolean(existing.vec) }
  }
  if (list.length >= MAX_KEEP) list.shift()
  list.push(entry)
  const saved = save(config, list)
  return {
    ok: saved,
    added: saved,
    total: saved ? list.length : list.length - 1,
    vec: Boolean(entry.vec),
    ...(saved ? {} : { reason: '写盘失败' }),
  }
}

/**
 * 收藏里的查重阈值（0.80~0.999，默认 0.95）。
 * 「标签词向量太像」= 两句话说的是同一件事（同一张图换个描述、同一个梗的两张图）。
 */
export function dedupeThresholdOf(config) {
  const raw = Number(config?.faceDedupeThreshold)
  const n = Number.isFinite(raw) && raw > 0 ? raw : 0.95
  return Math.min(0.999, Math.max(0.8, n))
}

/** 「添加时自动丢弃重复」开关。默认关 —— 默认行为应该是不动别人的收藏。 */
export function dedupeAutoOn(config) {
  return config?.faceDedupeEnabled === true
}

/**
 * 跟收藏里已有的向量比一遍，找出最像的那一条（子线程里算）。
 *
 * @param {string} vecB64 候选向量（base64）
 * @param {{excludePath?:string, logger?:object}} [opts]
 * @returns {Promise<{id:string, score:number}|null>}
 */
export async function nearestDuplicate(config, vecB64, { excludePath = '', logger } = {}) {
  if (!vecB64) return null
  const items = load(config)
    .filter((f) => f.vec)
    .filter((f) => String(f.path ?? '') !== String(excludePath ?? ''))
    .map((f) => ({ id: faceKeyOf(f), vec: f.vec }))
    .filter((x) => x.vec)
  if (items.length === 0) return null
  items.push({ id: '__candidate__', vec: vecB64 })
  const scan = await scanInWorker(items, dedupeThresholdOf(config), { timeoutMs: 1500, logger })
  const me = scan.flags.find((f) => f.id === '__candidate__')
  if (!me?.dup || !me.dupOf) return null
  return { id: me.dupOf, score: me.score }
}

/**
 * 收藏全貌 + 查重标记（给设置页）。
 *
 * 标记**不落盘**：每次现扫。理由有两个 ——
 *   ① 阈值是可调的，落盘的标记一改阈值就全对不上；
 *   ② 换描述会重算向量，标记跟着变，存下来只会越来越脏。
 * 扫的是「名字 + 标签」的向量，n=200 时也就几十毫秒，还在子线程里。
 */
export async function facesSnapshotWithDedupe(config, { logger } = {}) {
  const snap = facesSnapshot(config)
  const threshold = dedupeThresholdOf(config)
  const items = load(config)
    .filter((f) => f.vec)
    .map((f) => ({ id: faceKeyOf(f), vec: f.vec }))
  const scan =
    items.length > 1
      ? await scanInWorker(items, threshold, { logger })
      : { flags: [], pairs: [], compared: 0, dupCount: 0, inline: true }
  const byId = new Map((scan.flags ?? []).map((f) => [f.id, f]))
  const list = snap.list.map((f) => {
    const g = byId.get(f.id)
    return { ...f, dup: Boolean(g?.dup), dupOf: g?.dupOf ?? '', dupScore: Number(g?.score) || 0 }
  })
  return {
    ...snap,
    list,
    dedupe: {
      enabled: dedupeAutoOn(config),
      threshold,
      dupCount: Number(scan.dupCount) || 0,
      pairs: (scan.pairs ?? []).length,
      compared: Number(scan.compared) || 0,
      inline: Boolean(scan.inline),
    },
  }
}

/**
 * 一键去重：每个"像"的簇里留最早入库的那条，删掉后来的。
 * 图片条目连文件一起删。
 *
 * @returns {Promise<{ok:boolean, removed:number, total:number, error?:string}>}
 */
export async function dedupeFaces(config, { logger } = {}) {
  const threshold = dedupeThresholdOf(config)
  const list = load(config)
  const items = list.filter((f) => f.vec).map((f) => ({ id: faceKeyOf(f), vec: f.vec }))
  if (items.length < 2) return { ok: true, removed: 0, total: list.length }
  const scan = await scanInWorker(items, threshold, { logger })
  // 只删"跟着别人"的那些（dupOf 非空）；簇里的本体保留
  const drop = new Set(
    (scan.flags ?? []).filter((f) => f.dup && f.dupOf).map((f) => String(f.id)),
  )
  if (drop.size === 0) return { ok: true, removed: 0, total: list.length }

  const keep = list.filter((f) => !drop.has(faceKeyOf(f)))
  const saved = save(config, keep)
  if (!saved) return { ok: false, removed: 0, total: list.length, error: '写盘失败' }
  for (const f of list) {
    if (!drop.has(faceKeyOf(f))) continue
    if (f.kind !== 'image' || !f.path) continue
    if (!isInsideFacesDir(config, f.path)) continue
    try {
      unlinkSync(f.path)
    } catch {
      /* 文件已经不在了也正常 */
    }
  }
  return { ok: true, removed: drop.size, total: keep.length }
}

/**
 * 按语义挑图（2026-11-02）。
 *
 * 收藏里每张图存了「名字 + 标签」的向量，这里拿查询向量比一遍余弦，从高到低排。
 * **分数不够就不发** —— 让调用方带着候选描述回去自己决定，比瞎发一张不搭的强。
 *
 * @param {Float32Array} queryVec
 * @param {{threshold?:number, topK?:number}} [opts]
 * @returns {{best:{face:any,score:number}|null, candidates:Array<{summary:string,score:number}>, covered:number, total:number}}
 */
export function pickFaceByVector(config, queryVec, { threshold = 0.45, topK = 3 } = {}) {
  const list = load(config)
  const scored = []
  for (const face of list) {
    const v = b64ToVec(face.vec)
    if (!v || v.length === 0) continue
    scored.push({ face, score: cosine(queryVec, v) })
  }
  scored.sort((a, b) => b.score - a.score)
  const n = Math.max(1, Math.min(10, Number(topK) || 3))
  return {
    best: scored[0] ?? null,
    candidates: scored.slice(0, n).map((x) => ({
      summary: String(x.face.summary ?? '') || '（没起名）',
      score: Math.round(x.score * 1000) / 1000,
      pass: x.score >= threshold,
    })),
    covered: scored.length,
    total: list.length,
    threshold,
  }
}

/** 收藏里有多少张带向量（页面/排查用）。 */
export function vectorCoverage(config) {
  const list = load(config)
  const withVec = list.filter((f) => Boolean(f.vec)).length
  return { total: list.length, withVec }
}

/** 比对名字时把标点、空白、大小写都抹平：「求求了…」和「求求了」得算同一张。 */
function normName(value) {
  return String(value ?? '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase()
}

/**
 * 按名字挑一张收藏；挑不到就随机。
 *
 * 四级匹配，从严到松（旧版只有「收藏名包含关键词」这一级，于是
 * 「求求了」会命中「求你们别再嘲笑这些回复了」，而「发个求求了那种」这种说法
 * 一个都命中不了 —— 模型只好盲挑，最后变成随机发图）：
 *   ① 完全同名（忽略标点）
 *   ② 收藏名包含想要的关键词
 *   ③ 想要的那句话里包含某个收藏名（同上，都按去掉标点后比）
 *   ④ 都没中 → 随机（保证有图可发）
 */
/**
 * 按名字/关键词挑一张（不做语义）。
 *
 * @param {string} summary 想找的名字或关键词
 * @param {{allowRandom?: boolean}} [opts]
 *   `allowRandom: false` → 没命中就返回 undefined，**不要随机兜底**。
 *   2026-11-03：以前最后一步是随机挑一张，"想要的那张没找到"和"随便发一张"
 *   在结果上分不开 —— 瞎发一张不搭的比不发更糟，所以给调用方一个不开随机口的选择。
 */
export function pickFace(config, summary, { allowRandom = true } = {}) {
  const list = load(config)
  if (list.length === 0) return undefined
  const wanted = normName(summary)
  if (wanted) {
    const named = list.filter((f) => normName(f.summary))
    const exact = named.find((f) => normName(f.summary) === wanted)
    if (exact) return exact
    const contains = named.find((f) => normName(f.summary).includes(wanted))
    if (contains) return contains
    // 反向：想要的话里提到了某张的名字（「发个求求了那种」→「求求了…」）；
    // 命中多张时取名字最长的那个，越具体越靠谱
    const hitBack = named
      .filter((f) => wanted.includes(normName(f.summary)))
      .sort((a, b) => normName(b.summary).length - normName(a.summary).length)[0]
    if (hitBack) return hitBack
    // 标签也算关键词：名字没写全但标签里有的，也该找得到
    const tagHit = list.find((f) =>
      (Array.isArray(f.tags) ? f.tags : []).some((t) => {
        const tag = normName(t)
        return tag && (tag.includes(wanted) || wanted.includes(tag))
      }),
    )
    if (tagHit) return tagHit
  }
  if (!allowRandom) return undefined
  return list[Math.floor(Math.random() * list.length)]
}

/**
 * 最近发过的图片/表情时间戳（只存内存），**按会话分开记**。
 *
 * 进程重启就清零 —— 这是防刷屏的软闸，不是计费账本，没必要落盘。
 * 姐姐的原话：「不能频繁使用这个，偶尔用用」。
 *
 * 2026-11-03：改成按 peerKey 分开。以前是一根全局数组，群里刚发过一张，
 * 私聊里立刻也被判「刚发过」—— 而间隔/上限现在是可以按群配的，账本不分家就白配了。
 */
const sentAt = new Map() // peerKey -> number[]

function bucketOf(peerKey) {
  const key = String(peerKey ?? '*') || '*'
  let list = sentAt.get(key)
  if (!list) {
    list = []
    sentAt.set(key, list)
  }
  return list
}

function pruneSent(list, now) {
  while (list.length > 0 && now - list[0] > 3600_000) list.shift()
}

/**
 * 现在能不能再发一张图/表情。
 *
 * @param {object} config 用**这个会话自己的**配置（按群覆盖过的），不是全局那份
 * @param {string} [peerKey] 会话键（群号/QQ 号）；不给就按全局那一桶算
 * @returns {{ allowed: boolean, reason?: string, sentLastHour: number }}
 */
export function faceSendState(config, peerKey = '*') {
  const now = Date.now()
  const list = bucketOf(peerKey)
  pruneSent(list, now)
  const gapMs = Math.max(0, Number(config?.faceSendGapMs ?? 0))
  const maxPerHour = Math.max(0, Number(config?.faceSendMaxPerHour ?? 0))
  const sentLastHour = list.length

  if (gapMs > 0 && list.length > 0) {
    const last = list[list.length - 1]
    if (now - last < gapMs) {
      const waitSec = Math.ceil((gapMs - (now - last)) / 1000)
      return {
        allowed: false,
        sentLastHour,
        reason: `刚发过一张了，${waitSec} 秒后才能再发（表情是点缀，不是刷屏用的）`,
      }
    }
  }
  if (maxPerHour > 0 && sentLastHour >= maxPerHour) {
    return {
      allowed: false,
      sentLastHour,
      reason: `这一小时已经发了 ${sentLastHour} 张，歇会儿 —— 这次先用文字说`,
    }
  }
  return { allowed: true, sentLastHour }
}

/** 记一次「发出去了」。 */
export function markFaceSent(peerKey = '*') {
  const now = Date.now()
  const list = bucketOf(peerKey)
  list.push(now)
  pruneSent(list, now)
}

/**
 * 给提示词用的收藏摘要：只给名字，不给路径/id。
 * 模型得先知道有哪些图可选，才谈得上「按场景挑」。
 * @returns {{ total: number, names: string[] }}
 */
export function facesForPrompt(config, max = 10) {
  const list = load(config).filter((f) => String(f.summary ?? '').trim())
  const names = list.slice(-Math.max(1, max)).map((f) => String(f.summary).trim())
  return { total: load(config).length, names }
}

/** 列出收藏（给工具描述/命令用）。 */
export function listFaces(config, limit = 30) {
  return load(config).slice(-limit)
}

export function facesCount(config) {
  return load(config).length
}

/* ───────────────────────── 管理界面（2026-11-03）─────────────────────────
 *
 * 姐姐要的：「能显示库里的表情包吗？并且允许修改表情包描述和增删表情包，
 * 就在表情包语义检索附近，表情包只能全局使用」。
 *
 * 所以这里补的不是工具，是**设置页的读写口**：
 *   · `facesSnapshot`  列表（带 id / 预览 URL / 有没有向量）
 *   · `updateFace`     改描述和标签，顺手重算向量
 *   · `removeFace`     删条目（图片条目连文件一起删）
 *   · `addFaceFromDataUrl`  从网页上传一张，走 keepFace 那套（复制 + 嵌向量）
 *   · `faceImagePath`  给图片预览接口用，带越界校验
 *
 * id 用收藏里的**稳定键**，不按下标 —— 删掉一条之后下标全变，
 * 前端拿着旧下标会改错图。
 */

/** 收藏条目的稳定 id（和去重键同一套）。 */
export function faceKeyOf(entry) {
  return entry?.kind === 'image' ? imageKey(entry) : mfaceKey(entry)
}

/** 图片条目必须真的落在 `表情包/` 里，才允许从设置页读出去。 */
function isInsideFacesDir(config, file) {
  try {
    const root = resolve(facesDir(config))
    const full = resolve(String(file ?? ''))
    return full === root ? false : full.startsWith(root + (process.platform === 'win32' ? '\\' : '/'))
  } catch {
    return false
  }
}

/**
 * 收藏全貌（给设置页）。
 * @returns {{dir:string, file:string, total:number, withVec:number, list:Array}}
 */
export function facesSnapshot(config) {
  const list = load(config)
  const dir = facesDir(config)
  let withVec = 0
  const out = list.map((f, index) => {
    const key = faceKeyOf(f)
    const path = String(f.path ?? '')
    let size = 0
    try {
      if (path && existsSync(path)) size = statSync(path).size
    } catch {
      size = 0
    }
    if (f.vec) withVec += 1
    const isImage = f.kind === 'image'
    return {
      index,
      id: key,
      kind: isImage ? 'image' : 'mface',
      summary: String(f.summary ?? ''),
      tags: Array.isArray(f.tags) ? f.tags.map(String) : [],
      at: String(f.at ?? ''),
      hasVec: Boolean(f.vec),
      file: path ? basename(path) : '',
      missing: isImage ? !existsSync(path) : false,
      size,
      preview: isImage ? `/api/dsh-qq/face-file?id=${encodeURIComponent(key)}` : '',
    }
  })
  return { dir, file: facesPath(config), total: out.length, withVec, list: out }
}

/**
 * 改一条的描述 / 标签，并重算它的向量。
 *
 * 改完不重嵌的话，语义检索还拿着旧名字的向量 —— 搜"猫"搜不到刚改成"猫"的那张。
 * @returns {Promise<{ok:boolean, vec?:boolean, error?:string}>}
 */
export async function updateFace(config, id, { summary, tags } = {}, embed) {
  const key = String(id ?? '')
  const list = load(config)
  const entry = list.find((f) => faceKeyOf(f) === key)
  if (!entry) return { ok: false, error: '没找到这条收藏（可能刚被删了）' }

  if (summary !== undefined) entry.summary = String(summary ?? '').trim().slice(0, 120)
  if (tags !== undefined) {
    entry.tags = Array.isArray(tags)
      ? tags.map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 8)
      : []
    if (entry.tags.length === 0) delete entry.tags
  }

  let vecOk = Boolean(entry.vec)
  if (embed?.usable?.() === true) {
    const text = [entry.summary, ...(entry.tags ?? [])].filter(Boolean).join(' ')
    if (text) {
      try {
        const vecs = await embed.embedPassages([text])
        const v = Array.isArray(vecs) ? vecs[0] : null
        if (v && v.length > 0) {
          entry.vec = vecToB64(v)
          entry.vecDim = v.length
          vecOk = true
        }
      } catch {
        /* 嵌不动就留着旧向量，至少还能按关键词挑 */
      }
    } else {
      delete entry.vec
      delete entry.vecDim
      vecOk = false
    }
  }

  const saved = save(config, list)
  return { ok: saved, vec: vecOk, ...(saved ? {} : { error: '写盘失败' }) }
}

/**
 * 删一条。图片条目连文件一起删（文件还在就是个孤儿，占地方还查不到）。
 * @returns {{ok:boolean, removed:boolean, error?:string}}
 */
export function removeFace(config, id) {
  const key = String(id ?? '')
  const list = load(config)
  const idx = list.findIndex((f) => faceKeyOf(f) === key)
  if (idx < 0) return { ok: false, removed: false, error: '没找到这条收藏' }
  const entry = list[idx]
  list.splice(idx, 1)
  const saved = save(config, list)
  if (!saved) return { ok: false, removed: false, error: '写盘失败' }
  if (entry.kind === 'image' && entry.path && isInsideFacesDir(config, entry.path)) {
    try {
      unlinkSync(entry.path)
    } catch {
      /* 文件已经不在了就算了，条目删掉才是主要的 */
    }
  }
  return { ok: true, removed: true }
}

/** 上传大小上限（字节）。表情包用不着大图。 */
export const FACE_UPLOAD_MAX_MB = 8

/**
 * 从网页上传一张塞进收藏。
 *
 * 前端读成 dataURL 传过来（不折腾 multipart），这里落盘再走 keepFace ——
 * 复制进 `表情包/`、嵌向量这些事就都只有一处实现了。
 *
 * @param {{name?:string, dataUrl:string, summary?:string, tags?:string[]}} input
 * @returns {Promise<{ok:boolean, added?:boolean, total?:number, error?:string}>}
 */
export async function addFaceFromDataUrl(config, input, embed) {
  const raw = String(input?.dataUrl ?? '')
  const m = /^data:image\/(png|jpe?g|gif|webp);base64,([\s\S]+)$/i.exec(raw)
  if (!m) return { ok: false, error: '只认 data:image/(png|jpeg|gif|webp);base64,…' }
  const ext = m[1].toLowerCase().replace('jpeg', 'jpg')
  let buf
  try {
    buf = Buffer.from(m[2], 'base64')
  } catch {
    return { ok: false, error: 'base64 解不开' }
  }
  if (!buf || buf.length === 0) return { ok: false, error: '图是空的' }
  if (buf.length > FACE_UPLOAD_MAX_MB * 1024 * 1024) {
    return { ok: false, error: `图太大了（上限 ${FACE_UPLOAD_MAX_MB}MB）` }
  }

  const safeBase = basename(String(input?.name ?? 'face')).replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 40) || 'face'
  const name = `${Date.now()}_${safeBase}.${ext}`
  const target = join(facesDir(config), name)
  try {
    mkdirSync(facesDir(config), { recursive: true })
    writeFileSync(target, buf)
  } catch (err) {
    return { ok: false, error: `落盘失败：${err?.message ?? err}` }
  }

  const r = await keepFace(
    config,
    { path: target, summary: input?.summary, tags: input?.tags },
    embed,
  )
  if (!r?.ok) return { ok: false, error: r?.reason ?? '收进收藏失败' }
  return { ok: true, added: Boolean(r.added), total: r.total, vec: Boolean(r.vec) }
}

/**
 * 图片条目的绝对路径（给预览接口）。
 * 只放行 `表情包/` 目录里的文件 —— 不然 `?id=i:..\\..\\settings.json` 就能读穿整个盘。
 */
export function faceImagePath(config, id) {
  const key = String(id ?? '')
  const entry = load(config).find((f) => faceKeyOf(f) === key)
  if (!entry || entry.kind !== 'image') return ''
  const file = String(entry.path ?? '')
  if (!file || !existsSync(file)) return ''
  if (!isInsideFacesDir(config, file)) return ''
  return file
}
