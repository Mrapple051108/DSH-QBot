/**
 * 设置页的「配置覆盖层」——**让 dsh-qq 的设置能在 DSH 设置界面里改**。
 * ============================================================================
 * 为什么要有这一层（而不是让设置页去改 profile 的 `cordis.patch.yml`）：
 *
 *   · profile 的 patch 是**整行替换 config**，手写 YAML、注释、别的插件都在里面，
 *     一个文本框改错就把整个 profile 弄哑；
 *   · 那个文件属于「宿主配置」，插件不该去动它（权限、热重载语义都不一样）。
 *
 * 所以改成抄 dsh-bili-scroll 的做法：**插件自己的家**里放一份 `settings.json`，
 * 只存「用户改过的键」。启动时用它覆盖 cordis 注入的默认值：
 *
 *     cordis 注入的 config  ←  settings.json 里用户改过的键
 *
 * 家在 `$DSH_HOME/dsh-qq/settings.json`（拿不到 DSH_HOME 就退回 `~/.dsh`）。
 * ⚠️ `ctx.get('dshHomePath')` 返回的是**函数**不是字符串 —— 见 dsh-bili-scroll/lib/state.mjs
 *    那段踩坑记录（当字符串用会把函数源码拼进路径，mkdir ENOENT，插件直接不激活）。
 * ============================================================================
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import { createServer } from 'node:http'
import { rhythmViewHtml } from './rhythm-view.js'
import { GROUP_OVERRIDABLE, canOverridePerGroup, readThresholds } from './group-settings.js'
import {
  vectorCoverage,
  facesSnapshot,
  facesSnapshotWithDedupe,
  dedupeFaces,
  updateFace,
  removeFace,
  addFaceFromDataUrl,
  faceImagePath,
  FACE_UPLOAD_MAX_MB,
} from './faces.js'
import { groupFieldsBySection, FIELD_BY_KEY } from './group-fields.js'
import { needMention } from './shared/mention.js'
import {
  ensureKeyPair,
  resetKeyPair,
  readKeyPair,
  listKeyPeers,
  ENC_PREFIX,
  COMMAND_HELP,
} from './rsa-channel.js'
import {
  PROMPT_FILE_NAMES,
  PROMPT_FILE_HINTS,
  readPromptFiles,
  writePromptFile,
} from './prompt-files.js'

/**
 * 设置页本地服务端口。
 * 插件自己拉起的「小工作台」——DSH 的 /api/dsh-qq 路由不通时，前端会自动回退到这里。
 * 只绑 127.0.0.1，外面访问不到。
 */
export const LOCAL_API_PORT = 34569

/**
 * 情绪档位：把烦躁度翻译成一句人话，面板上直接看「她现在什么心情」。
 *
 * 2026-11-03 姐姐要的：「根据烦躁度显示下智能体的情绪状态：平静、烦躁、愤怒、跑路之类的」。
 * 四档对三个阈值，别另起一套数：
 *   平静  < calm       正常聊
 *   烦躁  ≥ calm       有点吵，想顺口嫌一句
 *   愤怒  ≥ anger      该甩脸色就甩
 *   跑路  ≥ escape     到顶了（或已经在无视冷窗里）
 *
 * 阈值取自 readThresholds（已经夹逼过 calm < anger < escape），所以这里不再二次纠正顺序。
 */
export function moodOf(state, levels = {}) {
  const v = Math.max(0, Math.min(100, Math.round(Number(state?.ignite) || 0)))
  const escape = Math.max(1, Number(levels.escape) || 70)
  const calm = Math.max(0, Number(levels.calm) || 30)
  const anger = Math.max(calm, Number(levels.anger) || Math.round((calm + escape) / 2))
  if (String(state?.phase) === 'ignore') {
    return { key: 'gone', label: '跑路中', value: v, hint: '已经在无视冷窗里，谁叫都不理' }
  }
  if (v >= escape) return { key: 'escape', label: '跑路', value: v, hint: `到逃离阈值 ${escape} 了，再拱一下就进无视` }
  if (v >= anger) return { key: 'angry', label: '愤怒', value: v, hint: `过了愤怒阈值 ${anger}，该甩脸色就甩` }
  if (v >= calm) return { key: 'annoyed', label: '烦躁', value: v, hint: `过了冷静阈值 ${calm}，有点吵了` }
  return { key: 'calm', label: '平静', value: v, hint: '正常聊，没什么火气' }
}

/** 能在家目录里被覆盖的键。不在名单里的一律忽略（防止设置页把结构化字段改坏）。 */
export const OVERRIDABLE = [
  // 连接
  'wsUrl',
  'accessToken',
  'selfId',
  'reconnectMs',
  // 人设 / 称呼
  'persona',
  'personaFile',
  'ownerIds',
  'ownerLabel',
  'directPrompt',
  'groupPrompt',
  // 工作区与记忆
  'workspaceRoot',
  'isolateByPeer',
  'imageCacheDir',
  // 触发与节奏
  'requireMention',
  'groupMustMention',
  'groupNoMention',
  'groupWakeMs',
  'groupWakeRenew',
  'groupWakeHistoryCount',
  'groupWakeHistoryLookbackMs',
  'groupWakeFarewell',
  'groupReplyGapMs',
  'groupMinGapMs',
  'rateLimitPerMin',
  'historyLimit',
  'groupMode',
  'groupAllow',
  'addressedMaySilent',
  'privateMode',
  'privateAllow',
  'botChatEnabled',
  'peerBots',
  'peerChatMaxTurns',
  // 群聊节奏（热窗 / 冷窗）
  'rhythmEnabled',
  'rhythmGroupsOnly',
  'rhythmHotMinMs',
  'rhythmHotMaxMs',
  'rhythmColdMinMs',
  'rhythmColdMaxMs',
  'rhythmColdKeep',
  // 无视冷窗（烦躁度）
  'ignoreMode',
  'ignoreAuto',
  'ignoreNag',
  'ignoreMs',
  'ignoreMinMs',
  'ignoreMaxMs',
  'ignoreExitThreshold', // [旧名] 冷静阈值，见 ignoreCalmThreshold
  'ignoreExitDelayMs',
  'ignoreKeepCount',
  'ignoreScoreThreshold', // [旧名] 逃离阈值，见 ignoreEscapeThreshold
  'ignoreCooldownMs',
  // 三阈值（2026-11-02）
  'ignoreCalmThreshold',
  'ignoreAngerThreshold',
  'ignoreEscapeThreshold',
  'ignoreCurve',
  'ignoreBehaviorMode',
  'ignorePunishRise',
  // 长文本回复惩罚（2026-11-04）
  'longReplyPenalty',
  'longReplyPerTurn',
  'longReplyChars',
  'longReplyBase',
  'longReplyCurve',
  'longReplyGamma',
  'angerPromptYield',
  'angerPromptFight',
  'escapePromptYield',
  'escapePromptFight',
  // 问题处理请求
  'requestPolicy',
  'requestPatterns',
  // 命令通道
  'rsaEnabled',
  // 表情包语义检索（2026-11-02）
  'faceEmbedEnabled',
  'faceEmbedThreshold',
  'faceEmbedTopK',
  'faceDedupeEnabled',
  'faceDedupeThreshold',
  // 每群覆盖表：{ "<群号>": { key: value } }，在 sanitizeOverrides 里单独处理
  'groupOverrides',
  'ignoreRedundancyWeight',
  'ignoreAtWeight',
  'ignorePesterWeight',
  'ignoreStaleWeight',
  'ignoreRisePerMsg',
  // 输出
  'textChunkLimit',
  'textChunkLimitMax',
  'textNoSplitMinChars',
  'textNoSplitTechnicalOnly',
  'showToolResults',
  'splitDelayMs',
  'splitDelayMaxMs',
  'splitDelayMeanMs',
  'streamReply',
  'streamMaxChunks',
  // 表情包
  'faceCollectHint',
  'faceSendGapMs',
  'faceSendMaxPerHour',
  // 主动说话
  'proactiveEnabled',
  'proactiveSilentMs',
  'proactiveMaxPerDay',
  'proactiveQuietHours',
  // 作息
  'sleepMode',
  'bedtimeAt',
  'sleepFrom',
  'sleepTo',
  'goodnightWords',
  // 连发合并
  'mergeWindowMs',
  'groupMergeWindowMs',
  'groupMergeWindowMaxMs',
  'groupMergeMaxMs',
  // 语音
  'asrEnabled',
  'asrPython',
  'asrModel',
  // 其它
  'debug',
]

/**
 * 插件家目录。`ctx.get('dshHomePath')` 可能是函数也可能是字符串，两种都认。
 * @returns {string}
 */
export function homeDirOf(ctx, logger) {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p('dsh-qq')
      if (v) dir = String(v)
    } else if (typeof p === 'string' && p) {
      dir = join(p, 'dsh-qq')
    }
  } catch (err) {
    logger?.warn?.('取 dshHomePath 失败，退回 ~/.dsh:', err?.message ?? err)
  }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-qq')
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    logger?.warn?.('创建 dsh-qq 家目录失败:', err?.message ?? err)
  }
  return dir
}

export function settingsFileOf(ctx, logger) {
  return join(homeDirOf(ctx, logger), 'settings.json')
}

/**
 * 第一次启动就落一份**带说明的骨架** settings.json（issue #2 第 4 条）。
 *
 * 为什么：设置页没上场时（浏览器半端没加载），用户手里得有一样「看得到、
 * 改得动」的东西，而不是对着 README 自己拼路径。文件不存在才写，绝不覆盖；
 * 骨架里只有一条 `//` 说明键，**不写 wsUrl/accessToken 的默认值**——
 * 写了会把 profile 里 cordis.patch.yml 配好的连接覆盖掉（骨架变成事故）。
 * `//` 不在 OVERRIDABLE 名单里，读的时候会被静默忽略。
 */
export function ensureSettingsFile(ctx, logger) {
  const file = settingsFileOf(ctx, logger)
  try {
    if (existsSync(file)) return { ok: true, created: false, file }
    const skeleton = {
      '//':
        '这是 dsh-qq 的设置覆盖文件：只写你想改的键，下面的模板复制进这个对象就能用（把这一行 // 删掉）：\n' +
        '  "wsUrl": "ws://127.0.0.1:3001",\n' +
        '  "accessToken": "你自己的 token",\n' +
        '  "selfId": "机器人 QQ 号",\n' +
        '  "privateAllow": ["你的QQ号"]\n' +
        '改完保存，约 800ms 自动生效，不用重启宿主。\n' +
        '⚠ privateMode 默认是 allowlist（只有白名单里的人私聊才会被回应），\n' +
        '  privateAllow 空着就谁都不理——先把自己的号填进上面那行，或者把\n' +
        '  "privateMode": "open" 也写上（只建议在自己机器上、谁都够不着的时候用）。',
    }
    writeFileSync(file, `${JSON.stringify(skeleton, null, 2)}\n`, 'utf8')
    logger?.info?.(`已生成设置骨架 ${file}（文件不存在时才写，不覆盖已有配置）`)
    return { ok: true, created: true, file }
  } catch (err) {
    logger?.warn?.(`创建 ${file} 失败:`, err?.message ?? err)
    return { ok: false, created: false, file, error: err?.message ?? String(err) }
  }
}

/**
 * 旧名 → 新名。2026-11-02 把两个阈值改了名：
 *   ignoreScoreThreshold → ignoreEscapeThreshold（逃离阈值）
 *   ignoreExitThreshold  → ignoreCalmThreshold（冷静阈值）
 * 直接改名会让用户存过的值凭空读不到（表现就是"我明明调到 40 了怎么还是 70"），
 * 所以读的时候先补一份新名。写回时只写新名，旧键自然淘汰。
 */
export function migrateAliases(raw, logger) {
  if (!raw || typeof raw !== 'object') return raw
  const out = { ...raw }
  const move = (oldKey, newKey) => {
    if (out[newKey] !== undefined) return
    if (out[oldKey] === undefined) return
    out[newKey] = out[oldKey]
    logger?.debug?.(`设置里是旧名 ${oldKey}，自动当作 ${newKey}`)
  }
  move('ignoreScoreThreshold', 'ignoreEscapeThreshold')
  move('ignoreExitThreshold', 'ignoreCalmThreshold')
  return out
}

/** 读覆盖表；坏文件当空的，不让一个坏 JSON 把插件拖住。 */
export function loadOverrides(ctx, logger) {
  const file = settingsFileOf(ctx, logger)
  try {
    if (!existsSync(file)) return {}
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return sanitizeOverrides(migrateAliases(raw, logger), logger)
  } catch (err) {
    logger?.warn?.(`读 ${file} 失败，按没有覆盖处理:`, err?.message ?? err)
    return {}
  }
}

/**
 * 每群覆盖表的清洗：群号必须是纯数字，节点里只留 `GROUP_OVERRIDABLE` 里的键。
 *
 * 为什么不放在外面顺手做掉：这份表是**嵌套**的，顶层白名单只管到 `groupOverrides`
 * 这一层，里面那一层得单独过一遍，否则谁都能往里塞任意键。
 */
function sanitizeGroupOverrides(input, logger) {
  const out = {}
  if (!input || typeof input !== 'object') return out
  for (const [peerId, patch] of Object.entries(input)) {
    if (!/^\d+$/.test(peerId)) {
      logger?.debug?.(`groupOverrides 里的 "${peerId}" 不是群号，忽略`)
      continue
    }
    if (!patch || typeof patch !== 'object') continue
    const clean = {}
    for (const key of GROUP_OVERRIDABLE) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue
      const value = patch[key]
      if (value === undefined || value === null) continue
      clean[key] = value
    }
    if (Object.keys(clean).length > 0) out[peerId] = clean
  }
  return out
}

/** 只留名单里的键；顺手把 `undefined` / `null` 剔掉（null 表示「清掉这条覆盖」）。 */
export function sanitizeOverrides(input, logger) {
  const out = {}
  if (!input || typeof input !== 'object') return out
  for (const key of OVERRIDABLE) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue
    const value = input[key]
    if (value === undefined) continue
    if (value === null) continue
    if (key === 'groupOverrides') {
      out.groupOverrides = sanitizeGroupOverrides(value, logger)
      continue
    }
    out[key] = value
  }
  const dropped = Object.keys(input).filter((k) => !OVERRIDABLE.includes(k))
  if (dropped.length > 0) logger?.debug?.(`设置里有不认识的键，忽略: ${dropped.join(', ')}`)
  return out
}

/** 写覆盖表（整份覆盖，不做增量合并 —— 调用方给的是最终形态）。 */
export function saveOverrides(ctx, overrides, logger) {
  const file = settingsFileOf(ctx, logger)
  const clean = sanitizeOverrides(overrides, logger)
  try {
    writeFileSync(file, `${JSON.stringify(clean, null, 2)}\n`, 'utf8')
    return { ok: true, file, overrides: clean }
  } catch (err) {
    logger?.warn?.('写设置失败:', err?.message ?? err)
    return { ok: false, file, error: err?.message ?? String(err) }
  }
}

/**
 * 把覆盖应用到运行中的 config 上（就地改，所有下游模块共享同一个对象）。
 * @returns {string[]} 真正写进去的键
 */
export function applyOverrides(config, overrides, logger) {
  const applied = []
  if (!config || !overrides) return applied
  for (const [key, value] of Object.entries(overrides)) {
    try {
      config[key] = value
      applied.push(key)
    } catch (err) {
      logger?.warn?.(`覆盖 ${key} 失败:`, err?.message ?? err)
    }
  }
  return applied
}

/**
 * 「人设地址」：配了 `personaFile` 就从那个文件读人设，读到了就盖掉 `persona`。
 *
 * 读不到时两级兜底（2026-10-26 姐姐说「人设文件那个地方加个兜底」）：
 *   ① 文本框（`persona`）里还有字 → 继续用它；
 *   ② 文本框也是空的（常见：人设全放在文件里）→ 用**上次成功读到的那份缓存**
 *      `$DSH_HOME/dsh-qq/persona-cache.md`。没有这一级的话，文件名一改、一删，
 *      角色就悄无声息变回「一个没有名字的普通助手」，而日志里只有一行 warn。
 * @returns {{ ok: boolean, file?: string, chars?: number, error?: string, fromCache?: boolean }}
 */
export function resolvePersonaFile(config, logger, { home = '' } = {}) {
  const raw = String(config?.personaFile ?? '').trim()
  if (!raw) return { ok: false }
  const file = resolve(raw)
  const cacheFile = home ? join(home, 'persona-cache.md') : ''
  try {
    if (!existsSync(file)) throw new Error('文件不存在')
    const text = readFileSync(file, 'utf8').trim()
    if (!text) throw new Error('文件是空的')
    config.persona = text
    if (cacheFile) {
      try {
        mkdirSync(dirname(cacheFile), { recursive: true })
        writeFileSync(cacheFile, text, 'utf8')
      } catch {
        /* 缓存写不进去不影响这次的人设 */
      }
    }
    logger?.info?.(`人设从 ${file} 读入（${text.length} 字）`)
    return { ok: true, file, chars: text.length }
  } catch (err) {
    const msg = err?.message ?? String(err)
    let fromCache = false
    if (!String(config?.persona ?? '').trim() && cacheFile && existsSync(cacheFile)) {
      try {
        const cached = readFileSync(cacheFile, 'utf8').trim()
        if (cached) {
          config.persona = cached
          fromCache = true
        }
      } catch {
        /* 缓存坏了就当没有 */
      }
    }
    logger?.warn?.(
      `人设文件读不到（${file}）：${msg}` +
        (fromCache ? '，用的是上次读到的那份缓存（persona-cache.md）' : '，继续用 persona 字段'),
    )
    return { ok: false, file, error: msg, fromCache }
  }
}

/** 给设置页看的家目录状态。 */
export function settingsInfo(ctx, logger) {
  const home = homeDirOf(ctx, logger)
  const file = join(home, 'settings.json')
  let mtime = ''
  try {
    if (existsSync(file)) mtime = statSync(file).mtime.toISOString()
  } catch {
    /* 无所谓 */
  }
  return { home, file, exists: existsSync(file), mtime }
}

/**
 * 挂上 `/api/dsh-qq/*` —— 设置页（client.js）打的就是这几个口。
 *
 * @param {object} opts
 * @param {object} opts.ctx          cordis 上下文（**父 ctx**：effect 要挂在它上面才不被提前收掉）
 * @param {object} opts.webServer    由 `ctx.inject(['webServer'], cb)` 拿到的服务实例
 * @param {object} opts.config       运行中的 config（就地读写）
 * @param {object} opts.logger
 * @param {object} [opts.client]     OneBotClient；uiOnly 模式没有
 * @param {object} [opts.manager]    SessionManager；uiOnly 模式没有
 * @param {object} opts.personaRef   `{ current: {ok,file,chars} }`，保存后刷新这里
 * @param {object} opts.overridesRef `{ current: {} }`，设置页存下来的覆盖
 * @returns {boolean} 是否挂上
 */
export function installSettingsApi({ ctx, webServer: injectedWebServer, config, logger, client, manager, personaRef, overridesRef, rhythm, groupConfig, faceEmbed, wakeInfo }) {
  // 自证：这次到底有没有把路由挂上（排查「设置页 404」时不用靠猜）
  const noteApiState = (ok, detail) => {
    try {
      writeFileSync(join(homeDirOf(ctx, logger), 'api-state.txt'), `${new Date().toISOString()} ok=${ok} ${detail || ''}\n`, 'utf8')
    } catch { /* 写不了就算了，别影响注册 */ }
  }

  const sendJson = (res, status, body) => {
    try {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    } catch (err) {
      logger?.debug?.('回 JSON 失败:', err?.message ?? err)
    }
  }

  const readJsonBody = async (req, maxBytes = 2 * 1024 * 1024) => {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > maxBytes) throw new Error(`请求体太大（>${Math.round(maxBytes / 1024 / 1024)}MB）`)
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  /** 设置页看到的「当前生效值」——只给可改的键，不把整个 config 抖出去。 */
  const snapshot = () => {
    const values = {}
    for (const key of OVERRIDABLE) {
      if (config[key] !== undefined) values[key] = config[key]
    }
    return values
  }

  /**
   * 嵌入服务状态的一句话（给全局设置页那个只读字段用）。
   *
   * 为什么要缓存：`faceEmbed.status()` 会问到 rag 那边，而 rag 的 embedder()
   * 第一次调用可能要加载模型（几百毫秒到几秒）。设置页刷新一次就等几秒太难受，
   * 所以 10 秒内复用上一次的结果。
   */
  let embedStatusCache = { at: 0, text: '' }

  async function embedStatusText() {
    const now = Date.now()
    if (embedStatusCache.at && now - embedStatusCache.at < 10_000) return embedStatusCache.text
    let text = '未知（还没问过）'
    try {
      const st = await faceEmbed?.status?.()
      if (!st) text = '不可用 — 没接上嵌入模块'
      else if (!st.enabled) text = '已关闭 —— 只用关键词匹配'
      else if (st.available) {
        const bits = ['可用', String(st.kind || 'onnx'), `${st.dims || 0} 维`]
        text = bits.join(' · ') + (st.modelDir ? ` · ${st.modelDir}` : '')
      } else text = `不可用 — ${st.reason || '未知原因'}`
    } catch (err) {
      text = `读取失败：${err?.message ?? err}`
    }
    embedStatusCache = { at: now, text }
    return text
  }

  const statusOf = () => {
    const info = settingsInfo(ctx, logger)
    return {
      ok: true,
      uiOnly: Boolean(config.uiOnly),
      connected: Boolean(client?.connected),
      wsUrl: config.wsUrl,
      selfId: (manager?.selfId || String(config.selfId ?? '')) || '',
      selfName: manager?.selfName || '',
      persona: {
        ok: Boolean(personaRef?.current?.ok),
        fromFile: Boolean(personaRef?.current?.ok),
        fromCache: Boolean(personaRef?.current?.fromCache),
        file: personaRef?.current?.file ?? String(config.personaFile ?? ''),
        chars: String(config.persona ?? '').length,
        error: personaRef?.current?.error ?? '',
      },
      home: info.home,
      settingsFile: info.file,
      settingsExists: info.exists,
      overrides: Object.keys(overridesRef?.current ?? {}).length,
      // 提示词片段状态（只读展示）：文件在不在、多少字。正文走 /prompt-files。
      promptFiles: (() => {
        try {
          const all = readPromptFiles(ctx, logger)
          return {
            dir: all.dir,
            files: PROMPT_FILE_NAMES.map((name) => ({ name, ...all.files[name] })),
          }
        } catch {
          return { dir: '', files: [] }
        }
      })(),
    }
  }

  const handleApi = async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    // ⚠️ 宿主给 prefix 路由的 req.url 有两种形态：完整路径（/api/dsh-qq/status），
    //    或者已经被剥掉前缀的（/status）。两种都认，不然会一直 404。
    const raw = url.pathname
    const path = raw.startsWith('/api/dsh-qq')
      ? raw
      : '/api/dsh-qq' + (raw.startsWith('/') ? raw : '/' + raw)

    if (req.method === 'GET' && path === '/api/dsh-qq/status') {
      return sendJson(res, 200, statusOf())
    }

    // ── 烦躁度曲线（2026-11-01 姐姐要「便于观察和调整」）──
    // 设置页里塞不下一张图，所以只放一个链接跳到 rhythm-view，数据走这个口。
    if (req.method === 'GET' && path === '/api/dsh-qq/rhythm') {
      // 2026-11-02：三个阈值统一从 group-settings 的夹逼函数拿。
      // 以前读的是旧键 ignoreScoreThreshold / ignoreExitThreshold —— 改名之后
      // 页面上那条红线就不再跟着设置走了（改了 ignoreEscapeThreshold，线不动）。
      const levels = readThresholds(config)
      // 节奏层按「群号 / 私聊号」记状态，DSH 那边是另一套 sessionId —— 这里补一条映射，
      // 页面上就能同时看到「哪个群」和「哪个会话」，对日志时不用两头找。
      const byPeer = new Map()
      try {
        for (const r of manager?.list?.() ?? []) {
          if (!r?.sessionId) continue
          byPeer.set(`${r.scope}:${r.peerId}`, r.sessionId)
        }
      } catch {
        /* 没 manager（uiOnly）就算了 */
      }
      const sessions = (rhythm?.allSeries?.() ?? []).map((s) => {
        const cut = s.key.indexOf(':')
        const scope = cut >= 0 ? s.key.slice(0, cut) : 'group'
        const peerId = cut >= 0 ? s.key.slice(cut + 1) : ''
        // 2026-11-02：阈值按**这个群自己的**配置算。以前页面画的是全局那条线，
        // 改了某个群的阈值，图上的线纹丝不动 —— 姐姐说的"阈值水位线没有刷新"就是这个。
        const lv = readThresholds(groupConfig?.for(peerId) ?? config)
        // 对话窗口（2026-11-04 姐姐要的）：面板要显示「还剩多久 / 已到点」，
        // 曲线要按「这段在窗口里吗」决定实线还是虚线。数据由 inbound.wakeInfoOf 给。
        let wi = null
        try {
          wi = scope === 'group' && typeof wakeInfo === 'function' ? wakeInfo(peerId) : null
        } catch {
          wi = null
        }
        return {
          ...s,
          sessionId: byPeer.get(s.key) ?? '',
          // 这一轮会等多久再回：跟曲线上那条烦躁度用的是同一个公式（rhythm.mergeWindowOf）
          mergeWindow: rhythm?.mergeWindowOf ? Number(rhythm.mergeWindowOf(scope, peerId)) || 0 : 0,
          // 情绪档位（2026-11-03）：面板上直接看「她现在什么心情」，别让人对着数字猜
          mood: moodOf(s, lv),
          ...lv,
          // 对话窗口：until = 最晚一个窗口的到期时间，ranges = 开着的时段（画虚线要用）
          wakeUntil: Number(wi?.until) || 0,
          wakeLive: Boolean(wi?.live),
          wakeRanges: Array.isArray(wi?.ranges) ? wi.ranges : [],
          // 这个群是不是「必须 @ 才接话」——不是的话，窗口概念对它没意义，别乱画虚线
          mustAt: scope === 'group' ? needMention(groupConfig?.for(peerId) ?? config, peerId) : false,
        }
      })
      return sendJson(res, 200, {
        ok: true,
        // 三条线都给它：冷静 / 愤怒 / 逃离。可视化页分别画三条，曲线按逃离阈值分色。
        threshold: levels.escape,
        angerThreshold: levels.anger,
        exitThreshold: levels.calm,
        calm: levels.calm,
        anger: levels.anger,
        escape: levels.escape,
        // 关掉自动触发时，烦躁度照算（可视化要能看），只是不会自己进无视 —— 页面上要标出来
        ignoreAuto: config?.ignoreAuto !== false,
        mode: String(config?.ignoreMode ?? 'fixed'),
        enabled: config?.rhythmEnabled !== false,
        groupsOnly: config?.rhythmGroupsOnly !== false,
        hotMs: [Number(config?.rhythmHotMinMs) || 90000, Number(config?.rhythmHotMaxMs) || 150000],
        coldMs: [Number(config?.rhythmColdMinMs) || 600000, Number(config?.rhythmColdMaxMs) || 1200000],
        // 合并窗口的上下限：状态页要拿它标「2.5 秒 → 15 秒」
        mergeWindowMs: Number(config?.groupMergeWindowMs) || 0,
        mergeWindowMaxMs: Number(config?.groupMergeWindowMaxMs) || 0,
        mergeMaxMs: Number(config?.groupMergeMaxMs) || 0,
        sessions,
      })
    }

    // 可视化页本体。直接发 HTML，不走 sendJson。
    if (req.method === 'GET' && path === '/api/dsh-qq/rhythm-view') {
      try {
        const html = rhythmViewHtml()
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(html)
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`读可视化页面失败：${err?.message ?? err}`)
      }
      return
    }

    // ── 表情包语义检索（2026-11-02）──
    // 页面要显示「记忆库插件的嵌入服务现在可不可用」，不可用还得给原因。
    if (req.method === 'GET' && path === '/api/dsh-qq/embed') {
      let st = { enabled: false, available: false, dims: 0, kind: '', modelDir: '', reason: '没接上嵌入服务' }
      try {
        if (faceEmbed?.status) st = await faceEmbed.status()
      } catch (err) {
        st = { ...st, reason: String(err?.message ?? err) }
      }
      let cover = { total: 0, withVec: 0 }
      try {
        cover = vectorCoverage(config)
      } catch {
        /* 收藏文件坏了也不该让这个口 500 */
      }
      return sendJson(res, 200, {
        ok: true,
        ...st,
        threshold: Number(config?.faceEmbedThreshold) || 0.45,
        topK: Number(config?.faceEmbedTopK) || 3,
        ...cover,
      })
    }

    // ── 提示词片段（2026-11-02 深夜）──
    // 人设/规矩/收尾这些「可改动项」落文件，启动拼一次，之后 system 不再变。
    // 这个口只管读写文件；改完要重启（或点「重载提示词」）才重新拼。
    if (req.method === 'GET' && path === '/api/dsh-qq/prompt-files') {
      const all = readPromptFiles(ctx, logger)
      return sendJson(res, 200, {
        ok: true,
        dir: all.dir,
        hints: PROMPT_FILE_HINTS,
        files: PROMPT_FILE_NAMES.map((name) => ({
          name,
          ...all.files[name],
          text: all[name],
        })),
      })
    }

    if (req.method === 'POST' && path === '/api/dsh-qq/prompt-files') {
      const body = await readJsonBody(req)
      const patch = body?.patch && typeof body.patch === 'object' ? body.patch : body
      if (!patch || typeof patch !== 'object') return sendJson(res, 400, { ok: false, error: '要一个对象' })
      const pairs = body?.name ? [[String(body.name), body.text]] : Object.entries(patch)
      const written = []
      const errors = []
      for (const [name, text] of pairs) {
        if (!PROMPT_FILE_NAMES.includes(name)) {
          errors.push(`未知片段 ${name}`)
          continue
        }
        const r = writePromptFile(ctx, logger, name, text)
        if (r.ok) written.push({ name, chars: r.chars, file: r.file })
        else errors.push(`${name}: ${r.error}`)
      }
      // 显式重载：清掉冻结表，下一次 assemble 重新拼（不加这一下就得重启）
      if (written.length > 0 && body?.reload !== false) {
        try {
          manager?.reloadChatPrompt?.()
        } catch (err) {
          errors.push(`重载失败: ${err?.message ?? err}`)
        }
      }
      return sendJson(res, 200, {
        ok: errors.length === 0,
        written,
        errors,
        restartRequired: written.length > 0 && body?.reload === false,
      })
    }

    // ── 表情包收藏（2026-11-03）──
    // 姐姐要的：「显示库里的表情包 + 改描述 + 增删，就在语义检索附近；只能全局用」。
    // 表情包本来就没有按群的概念（faceRoot 是全局一份），所以这几个口不带 group 参数。
    if (req.method === 'GET' && path === '/api/dsh-qq/faces') {
      let snap = { dir: '', file: '', total: 0, withVec: 0, list: [] }
      try {
        // 2026-11-04：带上查重标记（黄圈）。扫描在子线程里做，慢的是它、不是这个接口。
        snap = await facesSnapshotWithDedupe(config, { logger })
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: `读收藏失败：${err?.message ?? err}` })
      }
      return sendJson(res, 200, { ok: true, ...snap, uploadMaxMB: FACE_UPLOAD_MAX_MB })
    }

    if (req.method === 'POST' && path === '/api/dsh-qq/faces') {
      let body
      try {
        // 上传走 dataURL（不折腾 multipart），所以放宽到 12MB；单张图本身还有 8MB 上限
        body = await readJsonBody(req, 12 * 1024 * 1024)
      } catch (err) {
        return sendJson(res, 413, { ok: false, error: String(err?.message ?? err) })
      }
      const action = String(body?.action ?? '').trim()
      try {
        if (action === 'update') {
          const r = await updateFace(config, body?.id, { summary: body?.summary, tags: body?.tags }, faceEmbed)
          return sendJson(res, r.ok ? 200 : 400, { ok: r.ok, ...r })
        }
        if (action === 'delete') {
          const r = removeFace(config, body?.id)
          return sendJson(res, r.ok ? 200 : 400, { ok: r.ok, ...r })
        }
        if (action === 'add') {
          const r = await addFaceFromDataUrl(config, body, faceEmbed)
          return sendJson(res, r.ok ? 200 : 400, { ok: r.ok, ...r })
        }
        // 一键去重（2026-11-04）：每个"像"的簇留最早那张，删掉后来的，连文件一起删
        if (action === 'dedupe') {
          const r = await dedupeFaces(config, { logger })
          if (r.ok) {
            logger.info?.(`[dsh-qq] 表情包去重：删掉 ${r.removed} 条，剩 ${r.total} 条`)
          }
          return sendJson(res, r.ok ? 200 : 500, { ok: r.ok, ...r })
        }
        return sendJson(res, 400, { ok: false, error: `未知操作 ${action || '(空)'}` })
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: String(err?.message ?? err) })
      }
    }

    // 图片预览：只放行「表情包/」目录里的文件（faceImagePath 里做了越界校验）
    if (req.method === 'GET' && path === '/api/dsh-qq/face-file') {
      const id = String(url.searchParams.get('id') ?? '')
      const file = faceImagePath(config, id)
      if (!file) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('没有这张图（或者它不在表情包目录里）')
        return
      }
      try {
        const buf = readFileSync(file)
        const ext = file.toLowerCase().split('.').pop()
        const type =
          ext === 'png' ? 'image/png'
            : ext === 'gif' ? 'image/gif'
              : ext === 'webp' ? 'image/webp'
                : 'image/jpeg'
        res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=60' })
        res.end(buf)
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`读图失败：${err?.message ?? err}`)
      }
      return
    }

    // ── 每群设置（2026-11-02）──
    // 全局设置页仍然走 /api/dsh-qq/settings（Schema 自动渲染那一页）；
    // 这两个口只服务「群聊状态页」里新加的设置 tab。
    if (req.method === 'GET' && path === '/api/dsh-qq/group-settings') {
      const group = String(url.searchParams.get('group') ?? '').trim()
      if (!/^\d+$/.test(group)) return sendJson(res, 400, { ok: false, error: '需要一个群号' })
      const eff = groupConfig?.for(group) ?? config
      // 页面上看的是「秒 / 分钟 / 条」，存的是毫秒 —— scale 负责来回换
      const view = (field, value) => {
        const n = Number(value)
        if (field.type === 'number' && field.scale) {
          return Number.isFinite(n) ? Math.round(n / field.scale) : 0
        }
        return value
      }
      const sections = groupFieldsBySection().map((sec) => ({
        name: sec.name,
        fields: sec.fields.map((f) => ({
          ...f,
          global: view(f, config?.[f.key]),
          value: view(f, eff?.[f.key]),
          following: groupConfig?.isFollowing(group, f.key) ?? true,
        })),
      }))
      return sendJson(res, 200, {
        ok: true,
        group,
        sections,
        overrides: groupConfig?.overridesOf(group) ?? {},
        label: (manager?.list?.() ?? []).find?.((r) => String(r.peerId) === group)?.label ?? '',
      })
    }

    if (req.method === 'POST' && path === '/api/dsh-qq/group-settings') {
      const body = await readJsonBody(req)
      const group = String(body?.group ?? '').trim()
      const key = String(body?.key ?? '').trim()
      if (!/^\d+$/.test(group)) return sendJson(res, 400, { ok: false, error: '需要一个群号' })
      if (!canOverridePerGroup(key)) {
        return sendJson(res, 400, { ok: false, error: `${key} 不能按群单独设` })
      }

      // value === null / undefined → 恢复「跟随全局」（把这个键从群节点里删掉）
      const value = body?.value
      const next = { ...(overridesRef?.current ?? {}) }
      const all = { ...(next.groupOverrides ?? {}) }
      const patch = { ...(all[group] ?? {}) }
      if (value === null || value === undefined) {
        delete patch[key]
      } else {
        const field = FIELD_BY_KEY.get(key)
        // 页面给的秒/分钟要换回毫秒再存
        patch[key] = field?.scale ? Number(value) * field.scale : value
      }
      if (Object.keys(patch).length > 0) all[group] = patch
      else delete all[group]
      next.groupOverrides = all

      const saved = saveOverrides(ctx, next, logger)
      if (!saved.ok) return sendJson(res, 500, { ok: false, error: saved.error, file: saved.file })

      if (overridesRef) {
        for (const k of Object.keys(overridesRef.current ?? {})) delete overridesRef.current[k]
        Object.assign(overridesRef.current, saved.overrides)
      }
      applyOverrides(config, saved.overrides, logger)
      // proxy 缓存要清掉，否则页面读回来还是旧值
      groupConfig?.invalidate()
      // ⚠️ 2026-11-02 改：**这里不清聊天规矩**。
      //   群聊设置里改的全是行为类（阈值、时长、策略），一条都不影响 buildChatPrompt
      //   拼出来的那段话。以前每存一次就整本作废 → 下一轮重新塞两千多字，
      //   姐姐在设置页把阈值从 0.45 拖到 0.40 都能触发一次 —— 纯浪费 token。
      //   真改了影响规矩的东西（人设、群词典），去全局设置那边改，那边会清。

      const stillFollowing = !Object.prototype.hasOwnProperty.call(patch, key)
      logger.info?.(
        `[dsh-qq] 群 ${group} 的 ${key} ${stillFollowing ? '恢复跟随全局' : `改为 ${JSON.stringify(patch[key])}`}`,
      )
      return sendJson(res, 200, {
        ok: true,
        group,
        key,
        following: stillFollowing,
        overrides: groupConfig?.overridesOf(group) ?? {},
      })
    }

    // ── RSA 命令通道（2026-11-02）──
    // 私钥落在 `<home>/rsa/<群号>.json`，不进 settings.json：
    // 那是明文可读的配置，钥匙不该跟它混在一起。
    if (req.method === 'GET' && path === '/api/dsh-qq/rsa') {
      const group = String(url.searchParams.get('group') ?? '').trim()
      if (!/^\d+$/.test(group)) return sendJson(res, 400, { ok: false, error: '需要一个群号' })
      const dir = join(homeDirOf(ctx, logger), 'rsa')
      const pair = readKeyPair(dir, group)
      return sendJson(res, 200, {
        ok: true,
        group,
        hasKey: Boolean(pair),
        publicKey: pair?.publicKey ?? '',
        createdAt: pair?.createdAt ?? 0,
        algorithm: 'RSA-2048/OAEP-SHA256',
        peers: listKeyPeers(dir),
        prefix: ENC_PREFIX,
        commands: COMMAND_HELP,
        enabled: Boolean(groupConfig?.for(group)?.rsaEnabled),
      })
    }

    if (req.method === 'POST' && path === '/api/dsh-qq/rsa') {
      const body = await readJsonBody(req)
      const group = String(body?.group ?? '').trim()
      if (!/^\d+$/.test(group)) return sendJson(res, 400, { ok: false, error: '需要一个群号' })
      const action = String(body?.action ?? 'ensure')
      const dir = join(homeDirOf(ctx, logger), 'rsa')
      const pair = action === 'reset' ? resetKeyPair(dir, group) : ensureKeyPair(dir, group)
      logger.info?.(
        `[dsh-qq] 群 ${group} 的 RSA 密钥${action === 'reset' ? '已重置（旧密文全部失效）' : '已就绪'}`,
      )
      return sendJson(res, 200, {
        ok: true,
        group,
        publicKey: pair.publicKey,
        createdAt: pair.createdAt,
        prefix: ENC_PREFIX,
      })
    }

    if (req.method === 'GET' && path === '/api/dsh-qq/settings') {
      const info = settingsInfo(ctx, logger)
      const values = snapshot()
      // 只读状态：全局设置页要能直接看到「记忆库那个嵌入服务现在能不能用」，
      // 不然光有一个开关，人在全局页根本不知道开了有没有效果。
      // 它不在 OVERRIDABLE 里（POST 改不动），每次 GET 现算一份。
      try {
        values.faceEmbedStatus = await embedStatusText()
      } catch {
        /* 状态算不出来也不该让整个设置页 500 */
      }
      return sendJson(res, 200, {
        ok: true,
        values,
        overrides: { ...(overridesRef?.current ?? {}) },
        meta: { ...info, personaFromFile: Boolean(personaRef?.current?.ok), overridable: OVERRIDABLE },
      })
    }

    if (req.method === 'POST' && path === '/api/dsh-qq/settings') {
      const body = await readJsonBody(req)
      const patch = body?.patch && typeof body.patch === 'object' ? body.patch : body
      if (!patch || typeof patch !== 'object') return sendJson(res, 400, { ok: false, error: '要一个对象' })

      // 值是 null = 清掉这条覆盖，回到 cordis 里的默认值
      const next = { ...(overridesRef?.current ?? {}) }
      for (const [key, value] of Object.entries(patch)) {
        if (!OVERRIDABLE.includes(key)) continue
        if (value === null) delete next[key]
        else next[key] = value
      }

      const saved = saveOverrides(ctx, next, logger)
      if (!saved.ok) return sendJson(res, 500, { ok: false, error: saved.error, file: saved.file })

      // 就地应用：下游模块拿的就是这同一个 config 对象，所以绝大多数键立刻生效
      if (overridesRef) {
        for (const key of Object.keys(overridesRef.current ?? {})) delete overridesRef.current[key]
        Object.assign(overridesRef.current, saved.overrides)
      }
      applyOverrides(config, saved.overrides, logger)
      const personaNow = resolvePersonaFile(config, logger, { home: homeDirOf(ctx, logger) })
      if (personaRef) personaRef.current = personaNow

      // 只有**真的改了聊天规矩**才作废注入账本，让会话下一轮重新注一份。
      //
      // 2026-11-02 改：原来是"任何设置一存就清"。可绝大多数键（阈值、时长、限速、
      // 表情包间隔…）根本不进 buildChatPrompt，清一次就等于把两千多字的人设+规矩
      // 再往历史里塞一遍 —— 姐姐在设置页拖个滑块都能触发，纯浪费 token。
      // 现在只认这几个键：它们才是 buildChatPrompt 真的会读的。
      const PROMPT_AFFECTING = [
        'persona',
        'personaFile',
        'directPrompt',
        'groupPrompt',
        'ownerLabel',
        'faceCollectHint',
        'faceSendGapMs',
        'faceSendMaxPerHour',
        'groupWakeNames',
        'addressedMaySilent',
      ]
      const touchedPrompt = Object.keys(patch).some((k) => PROMPT_AFFECTING.includes(k))
      if (touchedPrompt) {
        try {
          manager?.forgetChatPrompt?.()
        } catch {
          /* uiOnly 没 manager */
        }
      }

      const touched = (key) => Object.prototype.hasOwnProperty.call(patch, key)
      const needReconnect = ['wsUrl', 'accessToken'].some(touched)
      const needRestart = ['reconnectMs', 'selfId', 'workspaceRoot', 'isolateByPeer', 'asrPython'].some(touched)

      return sendJson(res, 200, {
        ok: true,
        values: snapshot(),
        file: saved.file,
        persona: personaNow,
        needReconnect,
        needRestart,
      })
    }

    // 改了 wsUrl / token 之后不用重启整个宿主，把客户端重开一次就行
    if (req.method === 'POST' && path === '/api/dsh-qq/reconnect') {
      if (!client) return sendJson(res, 400, { ok: false, error: '这一份只提供设置页（uiOnly），QQ 连接在另一个进程里；去那边重启' })
      try {
        client.stop()
        client.url = config.wsUrl
        client.token = config.accessToken
        client.start()
        return sendJson(res, 200, { ok: true, wsUrl: client.url })
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) })
      }
    }

    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
  }

  // 统一的请求处理体：两条路（DSH 路由 / 本地服务）共用同一份逻辑。
  const routeHandler = async (req, res) => {
    try {
      await handleApi(req, res)
    } catch (err) {
      logger?.warn?.('设置页接口出错:', err?.message ?? err)
      sendJson(res, 500, { ok: false, error: err?.message ?? String(err) })
    }
  }

  let mounted = false

  // ── 路 1：DSH 自带的 webServer ───────────────────────────────────────────
  // 能挂就挂（同源、免 CORS，最好用）。挂了但请求 404 也不影响下面那条兜底。
  if (injectedWebServer) {
    try {
      ctx.effect(
        () =>
          injectedWebServer.register({
            kind: 'prefix',
            path: '/api/dsh-qq',
            handler: routeHandler,
          }),
        'dsh-qq: /api/dsh-qq 设置页接口',
      )
      mounted = true
    } catch (err) {
      logger?.warn?.('DSH 路由没挂上（还有本地服务兜底）:', err?.message ?? err)
    }
  }

  // ── 路 2：插件自己的本地小服务（2026-10-24 加的兜底）─────────────────────
  // 为什么要有它：DSH 那边的路由实测会「register 成功、请求却 404」，
  // 调了两轮都没绕过去。插件自己监听 127.0.0.1 就完全不依赖宿主内部机制，
  // 这也是官方教程里说的插件形态（「插件在本地拉起一个 web 工作台」）。
  // 只绑 127.0.0.1，外面访问不到；CORS 放开是给 DSH 页面里的 client 用。
  try {
    const local = createServer(async (req, res) => {
      res.setHeader('access-control-allow-origin', '*')
      res.setHeader('access-control-allow-headers', 'content-type')
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }
      await routeHandler(req, res)
    })
    local.on('error', (err) => {
      logger?.warn?.(`本地设置服务起不来（端口 ${LOCAL_API_PORT}）: ${err?.message ?? err}`)
    })
    local.listen(LOCAL_API_PORT, '127.0.0.1', () => {
      logger?.info?.(`设置页本地服务: http://127.0.0.1:${LOCAL_API_PORT}/api/dsh-qq`)
    })
    ctx.effect(
      () => () => {
        try {
          local.close()
        } catch {
          /* 收摊 */
        }
      },
      'dsh-qq: 本地设置服务',
    )
    mounted = true
  } catch (err) {
    logger?.warn?.('本地设置服务没起来:', err?.message ?? err)
  }

  noteApiState(
    mounted,
    `${injectedWebServer ? 'DSH 路由已尝试' : '没有 DSH 路由'} + 本地服务 ${LOCAL_API_PORT}`,
  )
  // 2026-11-02：这条是给"设置页全 404"准备的。
  // 那次是 apply() 里一个作用域写错（faceEmbed 被收进 try 块），报错被吞了，
  // 只能靠翻 api-state.txt 的时间戳才看出 installSettingsApi 压根没跑。
  // 现在每次挂载都留一行，重启后扫一眼日志就知道接口到底上没上。
  if (mounted) {
    logger?.info?.(`[dsh-qq] 设置接口已挂载：/api/dsh-qq/*（本地 ${LOCAL_API_PORT}）`)
  } else {
    logger?.warn?.('[dsh-qq] 设置接口没挂上：/api/dsh-qq/* 会全部 404')
  }
  return mounted
}

/**
 * 读「事实卡」（P1）：`<QQ会话根>/事实卡.md` 里属于这个会话的那几节。
 *
 * 为什么放 `QQ会话/` 根目录而不是每个会话目录里：姐姐 2026-10-25 定的——
 *   一个文件两节（`## 全局` + `## 会话 <label>`），改一处全会话可见，
 *   不会出现「私聊里改了称呼、群里还是旧的」。
 * 只放「压丢会出事」的东西，一页以内；这里不做长度截断，靠人写的时候克制。
 *
 * 读失败（文件没有/没权限）一律返回空串——事实卡丢了也不能耽误聊天。
 */
/**
 * 这个会话自己写的「便签」——换会话时接话用。
 * 空文件/只有标题的不算。
 *
 * 2026-10-26：原来叫 `交接.md`，姐姐说「太像遗书了」。改成 `便签.md` 优先；
 * 旧名继续读，别把之前已经写下的东西丢掉。
 */
export function loadHandoffFor(record) {
  const dir = String(record?.dir ?? '').trim()
  if (!dir) return ''
  for (const name of ['便签.md', '交接.md']) {
    try {
      const file = join(dir, name)
      if (!existsSync(file)) continue
      const text = readFileSync(file, 'utf8').trim()
      if (text.replace(/^#.*$/gm, '').trim().length >= 20) return text
    } catch {
      // 读失败就换下一个名字；两个都读不到也不是大事，退回原文兜底
    }
  }
  return ''
}

/** 事实卡文件的完整路径（会话目录的上一级）。发布版不写死某台机器的路径。 */
export function factsFileFor(record) {
  const dir = String(record?.dir ?? '').trim()
  return dir ? join(dirname(dir), '事实卡.md') : ''
}

export function loadFactsFor(record) {
  const dir = String(record?.dir ?? '').trim()
  if (!dir) return ''
  try {
    const file = factsFileFor(record)
    if (!existsSync(file)) return ''
    // ⚠️ 2026-10-25 修：`record.label` 是「私聊 某某(1234567)」这种给人看的，
    // 不是目录名「私聊_1234567」。拿 label 去匹配只匹配到「全局」节，
    // 会话节整节丢掉（LLM 看到的卡断在「姐姐最近在忙」那行）。目录名才是稳定键。
    return pickFacts(readFileSync(file, 'utf8'), basename(dir))
  } catch {
    return ''
  }
}

/** 群词典文件的完整路径。跟 `learning.js` 写入的位置必须是同一个，改这里也要改那边。 */
export function glossaryFileFor(record) {
  const dir = String(record?.dir ?? '').trim()
  return dir ? join(dir, '记忆区', '群词典.md') : ''
}

/**
 * 把群词典压缩成能念的一小段。
 * 头部那几行 `>` 是写给姐姐看的说明，念给它听纯占字数，去掉；
 * 超过 `limit` 字就断在整行，并留一句「想看全文 read 那个文件」。
 */
export function clipGlossary(text, limit = 700) {
  const body = String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!body) return ''
  if (body.length <= limit) return body
  return `${body.slice(0, limit).replace(/\n[^\n]*$/, '')}\n（后面的没念完，要看全文就 read）`
}

/** 群聊时把本群那本词典念一小段；私聊、文件不存在、内容为空都返回 ''。 */
export function loadGlossaryFor(record, { limit = 700 } = {}) {
  const file = glossaryFileFor(record)
  if (!file) return ''
  try {
    if (!existsSync(file)) return ''
    return clipGlossary(readFileSync(file, 'utf8'), limit)
  } catch {
    return ''
  }
}

/** 从日记里挑一行 `> 一句话：…` 这类头信息。抽不到返回 ''。 */
export function pickDigestLine(text, label) {
  const re = new RegExp(`^>\\s*${label}\\s*[：:]\\s*(.+)$`, 'm')
  const m = re.exec(String(text ?? ''))
  return m ? m[1].trim() : ''
}

function clipLine(s, limit) {
  const t = String(s ?? '').trim()
  if (!limit || t.length <= limit) return t
  return `${t.slice(0, limit)}…`
}

/** 聊天记录一行的样子：`- 00:08:57 · 昵称(10002)：说话内容`。 */
const CHAT_LINE_RE = /^- (\d{2}:\d{2}:\d{2}) · (.+?)\((\d{3,12})\)[：:]\s*(.*)$/

/**
 * 从一个群的聊天记录里抽「尾巴」：最后谁说了话，以及有没有人点了她名她没应。
 * ============================================================================
 * 老三 2026-10-27 11:43 原话：「头两行只够闻个味，一天的肉都在后半段。不如给我尾巴：
 * 谁最后说话、有没人点我名我没应着，这种我才真想知道。量不用加，换个位置就行。」
 *    → 她要的不是「今天聊了啥」，是「现在有没有我的事」——那在结尾。
 *
 * @param {string} text 聊天记录全文
 * @param {{ gid?: string, me?: string, tailCount?: number, limit?: number }} opts
 * @returns {string[]} 最多两行
 */
function tailLinesFromChat(text, { gid = '', me = '', tailCount = 2, limit = 240 } = {}) {
  const recs = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const m = CHAT_LINE_RE.exec(raw.trim())
    if (!m) continue
    recs.push({ at: m[1], who: m[2].trim(), id: m[3], said: m[4].trim() })
  }
  const others = recs.filter((r) => r.id !== me)
  if (!others.length) return []

  const last = others[others.length - 1]
  const atMe = me ? others.filter((r) => r.said.includes(`@${me}`)).pop() : null
  const stripAt = (s) => String(s ?? '').split(`@${me}`).join('').trim()

  const out = []
  if (atMe === last) {
    // 最后一句就是点她名：这行本身最要紧，别再重复一遍
    out.push(`· 群 ${gid}：最后 ${last.at} ${last.who} 点了你名「${clipLine(stripAt(last.said), limit)}」——你没应`)
    return out
  }
  out.push(`· 群 ${gid}：最后 ${last.at} ${last.who} 说「${clipLine(last.said, limit)}」`)
  if (tailCount > 1 && others.length > 1) {
    const prev = others[others.length - 2]
    if (prev !== atMe) out.push(`  ↑前一句 ${prev.at} ${prev.who}：「${clipLine(prev.said, limit)}」`)
  }
  if (atMe) out.push(`  ⚠ ${atMe.at} ${atMe.who} 点过你名：「${clipLine(stripAt(atMe.said), 120)}」`)
  return out
}

/**
 * 私聊时递的「纸条」：别的群**今天**的尾巴。
 * ============================================================================
 * 读的是 `聊天记录/<今天>.md` 的结尾，不是日记头两行（2026-10-27 按老三的要求换的）。
 * 当天群里没人说话时，才退回日记的 `> 一句话：`。
 *
 * 切法为什么这么定：日记正文和聊天记录正文都是第一人称/大段叙事，让她跨窗口读到
 * 另一个自己写的东西，会有「这是谁写的 / 这不像我」的风险——2026-10-27 09:42 已经
 * 出过一次（同一个窗口、只跨了一个轮次，她就不认识自己写的日记了）。
 * 而「最后谁说了话、有没有人点我名」是纯事实，谁写都一样，递过去不会晃她。
 *
 * 关键区别：这是**插件递过来的纸条**，不是她去翻本子。她什么都没「读」过。
 *
 * @param {{ workspaceRoot?: string, today?: string, selfId?: string }} opts
 * @returns {string} 多行文本；没有群、没有记录时返回 ''
 */
export function loadGroupDigest({ workspaceRoot, today, selfId = '' } = {}, { limit = 240, tailCount = 2 } = {}) {
  const root = String(workspaceRoot ?? '').trim()
  const day = String(today ?? '').trim()
  if (!root || !day) return ''
  let names = []
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^群_/.test(d.name))
      .map((d) => d.name)
      .sort()
  } catch {
    return ''
  }
  const me = String(selfId ?? '').trim()
  const rows = []
  for (const name of names) {
    const gid = name.replace(/^群_/, '')
    const dir = join(root, name)
    let lines = []
    // ① 先看聊天记录的尾巴——她要的「谁最后说话、有没有人点我名」都在这儿
    try {
      const chat = join(dir, '聊天记录', `${day}.md`)
      if (existsSync(chat)) lines = tailLinesFromChat(readFileSync(chat, 'utf8'), { gid, me, tailCount, limit })
    } catch {
      // 单个群读坏了（编码、锁、半截文件）不该连累别的群
    }
    // ② 今天群里没人说话，才退回日记的「一句话」
    if (!lines.length) {
      try {
        const file = join(dir, '记忆区', '日记', `${day}.md`)
        if (existsSync(file)) {
          const gist = pickDigestLine(readFileSync(file, 'utf8'), '一句话')
          if (gist) lines = [`· 群 ${gid}（今天没人说话）：${clipLine(gist, limit)}`]
        }
      } catch {
        // 同上，坏一个不连累别的
      }
    }
    rows.push(...lines)
  }
  return rows.join('\n')
}

/** 群词典的空骨架（第一次写时铺这份）。 */
export const GLOSSARY_SKELETON = `# 群词典 · 群聊黑话与角色

> 群鲸鲸自己卡壳的地方。**待确认** = 它没接住的；弄明白意思后自己挪到**已确认**。
> 这本是它自己的笔记，别借别人的词硬编。

## 待确认

## 已确认

| 词 / 说法 | 意思 | 谁说的 | 日期 |
| --- | --- | --- | --- |
`

function mdCell(s, limit = 40) {
  const t = String(s ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()
  return t.length > limit ? `${t.slice(0, limit)}…` : t
}

/** 本地时区的今天。别用 toISOString —— UTC 在 +08 的凌晨会算成昨天。 */
function localDayStr() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 把「弄明白了的一个词」写进某个群词典的「已确认」，顺手清掉对应的「待确认」条目。
 * ============================================================================
 * 2026-10-27 给老三造的「笔」。她在私聊里够不到 `群_<gid>/记忆区/群词典.md`
 * （沙箱只圈自己那块地），群聊里够得到、可她当时想不起来要填。
 *
 * **这只笔只有一个落点**：`<workspaceRoot>/群_<纯数字>/记忆区/群词典.md`。
 * 参数里没有路径，群号必须是纯数字且目录已存在——她就算想问「写群日记」
 * 也没地方填。不靠她自觉，靠函数签名就写不了别的。
 *
 * @returns {{ file: string, text: string }}
 */
export function upsertGlossaryTerm({ workspaceRoot, group, word, meaning, who = '', date = '' }) {
  const root = String(workspaceRoot ?? '').trim()
  if (!root) throw new Error('没配 workspaceRoot，找不到群目录')
  const gid = String(group ?? '').trim()
  if (!/^\d{3,20}$/.test(gid)) throw new Error(`群号得是纯数字，收到：${gid || '(空)'}`)
  const w = String(word ?? '').trim()
  const m = String(meaning ?? '').trim()
  if (!w) throw new Error('要填的词不能是空的')
  if (!m) throw new Error('意思不能是空的')
  const peerDir = join(root, `群_${gid}`)
  if (!existsSync(peerDir)) throw new Error(`群 ${gid} 的目录不存在：${peerDir}`)
  const file = join(peerDir, '记忆区', '群词典.md')

  let text = ''
  try {
    text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  } catch {
    text = ''
  }
  if (!text.trim()) text = GLOSSARY_SKELETON

  // ① 清掉「待确认」里跟这个词对上的那条（含它下面那行 ↳ 说明）
  const lines = text.split(/\r?\n/)
  const kept = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^- \[ \]/.test(line) && line.includes(w)) {
      const next = lines[i + 1] ?? ''
      if (/^\s{2,}↳/.test(next)) i += 1
      continue
    }
    kept.push(line)
  }
  text = kept.join('\n')

  // ② 追加进「已确认」的表格末尾
  const row = `| ${mdCell(w)} | ${mdCell(m, 80)} | ${mdCell(who, 24)} | ${mdCell(date || localDayStr(), 12)} |`
  const at = text.indexOf('## 已确认')
  if (at < 0) {
    text = `${text.trimEnd()}\n\n## 已确认\n\n| 词 / 说法 | 意思 | 谁说的 | 日期 |\n| --- | --- | --- | --- |\n${row}\n`
  } else {
    const head = text.slice(0, at)
    const rows = text.slice(at).split('\n')
    let lastTable = -1
    for (let i = 0; i < rows.length; i += 1) if (/^\|/.test(rows[i])) lastTable = i
    if (lastTable >= 0) rows.splice(lastTable + 1, 0, row)
    else rows.push('', '| 词 / 说法 | 意思 | 谁说的 | 日期 |', '| --- | --- | --- | --- |', row)
    text = head + rows.join('\n')
  }

  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
  return { file, text }
}

/** 从事实卡全文里挑出「全局」+「会话 <label>」两节；标题允许带不带「会话 」前缀。 */export function pickFacts(text, label) {
  const want = new Set(['全局'])
  const tag = String(label ?? '').trim()
  if (tag) {
    want.add(`会话 ${tag}`)
    want.add(tag)
  }
  const out = []
  let cur = null
  const isWanted = (name) =>
    want.has(name) || [...want].some((w) => name === w || name.endsWith(` ${w}`))
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^##\s+(.+?)\s*$/.exec(line)
    if (m) {
      cur = m[1]
      continue
    }
    if (cur && isWanted(cur)) out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 往事实卡里加一行（P1 的写入口，只有 `qq_facts` 工具会调）。
 *
 * 规则：只加、不改、不删。找 `## 会话 <label>` 那一节，加在节尾；
 * 没有这一节就补一节。姐姐说「记一下」才该动到这里。
 * @returns {{ok:boolean, file:string, section:string}}
 */
export function appendFact(file, label, line) {
  const add = `- ${String(line ?? '').trim()}`
  if (add === '-') throw new Error('appendFact: 要记的内容是空的')
  let text = ''
  try {
    if (existsSync(file)) text = readFileSync(file, 'utf8')
  } catch {
    text = ''
  }
  if (!text.trim()) {
    text = `# QQ 鲸鲸的事实卡\n\n> 只放「压缩掉会出事」的东西，一页以内。\n\n`
  }

  const heading = `## 会话 ${String(label ?? '').trim() || '未知'}`
  const idx = text.indexOf(heading)
  if (idx === -1) {
    text = `${text.replace(/\s*$/, '')}\n\n${heading}\n\n${add}\n`
  } else {
    const after = text.slice(idx + heading.length)
    const nextRel = after.search(/^##\s/m)
    const bodyEnd = nextRel === -1 ? text.length : idx + heading.length + nextRel
    const before = text.slice(0, bodyEnd).replace(/\s*$/, '')
    const rest = nextRel === -1 ? '' : `\n${text.slice(bodyEnd).replace(/^\s*/, '')}`
    text = `${before}\n${add}\n${rest}`
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
  return { ok: true, file, section: heading }
}
