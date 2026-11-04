import { appendFileSync, mkdirSync, statSync, watchFile, unwatchFile } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema, listOf } from './config.js'
import { OneBotClient } from './onebot/client.js'
import { textSegments } from './onebot/segment.js'
import { SessionManager } from './session.js'
import { createInbound, historyLine, wakeInfoOf } from './inbound.js'
import { appendChatLog } from './chatlog.js'
import { SILENT_MARKER, personaLeaks, stripSilentMark } from './prompts.js'
import { createOutbound } from './outbound.js'
import { createBridge } from './bridge.js'
import { createPin } from './pin.js'
import { createWake } from './wake.js'
import { createSleep } from './sleep.js'
import { createRhythm } from './rhythm.js'
import { createGroupConfig } from './group-settings.js'
import { createFaceEmbed } from './face-embed.js'
import { installChatPromptSection, reloadChatPrompt } from './chat-prompt.js'
import { createReading } from './reading.js'
import { startLearning } from './learning.js'
import { createContextGuard } from './context-guard.js'
import { createImagePartsBuilder } from './shared/image-parts.js'
import { auditOutbound } from './audit.js'
import { splitText, sleep, keepWhole } from './shared/chunk.js'
import { registerTools } from './tools.js'
import { ApprovalChannel } from './approval.js'
import { QuestionChannel } from './questions.js'
import {
  applyOverrides,
  ensureSettingsFile,
  homeDirOf,
  installSettingsApi,
  loadOverrides,
  resolvePersonaFile,
  settingsFileOf,
} from './settings.js'
import { selfCheckClient } from './client-selfcheck.js'

export const name = 'dsh-qbot'
export const inject = ['agents', 'systemPrompt']
export const Config = ConfigSchema

/**
 * 当前活着的 OneBot client。
 *
 * 2026-11-02：热重载插件但没走 dispose 时，旧的 client 还连着 NapCat，
 * 新的一起连 —— 同一个 NapCat 会把每条消息**推给每个连接**，
 * 于是同一条群消息被处理两遍，发给模型的 prompt 整段重复两遍。
 * 建新实例前靠这个变量把旧的掐掉。
 */
let liveClient = null

const ensuredLogDirs = new Set()

function formatArg(a) {
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.stack ?? a.message
  return safeJson(a)
}

/** 日志时间戳用**本地时间**（带偏移），不用 toISOString()。
 * 用 UTC 的话，北京时间晚上 9 点会写成 13:22Z —— 翻日志的人（和模型自己）
 * 一眼看过去就是「下午一点」，判断全乱（2026-10-24 姐姐指出来过）。 */
function localStamp(d) {
  const p = (n) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const abs = Math.abs(off)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${off >= 0 ? '+' : '-'}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
}

/** 人味延迟：指数分布采样，均值 meanMs。
 * 为什么不用固定值——固定间隔发出去是「节拍器」，一眼看得出不是人。
 * 指数分布大部分落在均值以下、偶尔拉长，才像人一边想一边打
 * （2026-10-29 姐姐要求：每句话之间、收到消息到开口，都按均值 0.5 秒来）。
 * 两头夹住：太短等于没加、太长像卡了。 */
function humanDelay(meanMs) {
  const mean = Math.max(0, Number(meanMs) || 0)
  if (mean <= 0) return 0
  const jittered = -Math.log(1 - Math.random()) * mean
  return Math.min(Math.max(jittered, mean * 0.4), mean * 4)
}

function makeLogger(ctx, config) {
  const base = ctx?.logger ?? console
  const prefix = '[dsh-qq]'
  // 日志一定要落盘。宿主是 Electron 的 GUI 子进程，启动脚本那边就算做了
  // -RedirectStandardOutput，拿到的也是 0 字节——「它为什么不说话」这种问题
  // 只能靠插件自己写文件。按天一个，放 <workspaceRoot>/logs/，和部署脚本的 logs 同一个家。
  const dir = join(config?.workspaceRoot ?? process.cwd(), 'logs')
  const fileLog = (level, args) => {
    try {
      if (!ensuredLogDirs.has(dir)) {
        mkdirSync(dir, { recursive: true })
        ensuredLogDirs.add(dir)
      }
      const now = new Date()
      const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      appendFileSync(join(dir, `dsh-qq-${day}.log`), `${localStamp(now)} [${level}] ${args.map(formatArg).join(' ')}\n`, 'utf8')
    } catch {
      /* 日志失败不影响主流程 */
    }
  }
  const wrap = (level) => (fn) => (...args) => {
    fileLog(level, args)
    return typeof fn === 'function' ? fn(prefix, ...args) : undefined
  }
  return {
    info: wrap('info')(base.info?.bind(base)),
    warn: wrap('warn')(base.warn?.bind(base)),
    error: wrap('error')(base.error?.bind(base)),
    debug: config?.debug ? wrap('debug')((base.debug ?? base.info)?.bind(base)) : () => {},
  }
}

function safeJson(v) {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/**
 * 分离部署下的热生效：盯着 `settings.json`。
 *
 * 为什么需要（2026-10-25 姐姐发现）：
 * 设置页保存走的是 `POST /api/dsh-qq/settings`，`applyOverrides` 就地改的是
 * **处理那次请求的那个进程**里的 config。可这套部署是分开的——
 * desktop profile 里 dsh-qq 只有 `uiOnly: true`（设置面板），真正跑 QQ 的是
 * 另一个 `--profile qqbot` 的进程。面板改完，跑 QQ 那边根本收不到那次请求。
 *
 * 表现：用户在设置里改了群白名单 / 触发方式，机器人在线、却还是老规矩，
 * 必须手动重启 qqbot 宿主才生效。发布出去这一条会被当成「设置不生效」。
 *
 * 解法就是盯文件：另一个进程写盘 → 这里轮询到 mtime 变了 → 重读覆盖表 → 就地应用。
 * 用 `watchFile`（轮询）而不是 `fs.watch`，因为它**容忍文件不存在**（首次还没有
 * settings.json 时 watch 会直接报错），而且跨进程写盘在 Windows 上事件不可靠。
 */
export function watchSettingsFile(ctx, config, overridesRef, personaRef, logger, clientRef = null) {
  let file = ''
  try {
    file = settingsFileOf(ctx, logger)
  } catch (err) {
    logger?.warn?.('拿不到 settings.json 路径，跳过热加载:', err?.message ?? err)
    return
  }
  let lastMtimeMs = 0
  try {
    lastMtimeMs = statSync(file).mtimeMs
  } catch {
    /* 文件还不存在，正常 */
  }

  const reload = () => {
    try {
      const next = loadOverrides(ctx, logger)
      const applied = applyOverrides(config, next, logger)
      if (overridesRef?.current) {
        for (const key of Object.keys(overridesRef.current)) delete overridesRef.current[key]
        Object.assign(overridesRef.current, next)
      }
      if (personaRef) {
        personaRef.current = resolvePersonaFile(config, logger, { home: homeDirOf(ctx, logger) })
        try {
          const leak = personaLeaks(config?.persona)
          if (!leak.ok) {
            logger.warn(`人设里出现了工具用法（${leak.hits.join('、')}）——这些属于行为层，人设只该写「我是谁」。`)
          }
        } catch {
          /* ignore */
        }
      }
      logger.info(
        applied.length > 0
          ? `settings.json 变了，已就地应用: ${applied.join(', ')}（不用重启）`
          : 'settings.json 变了，但没有可覆盖的键',
      )

      // wsUrl 是唯一「填上之后必须立刻接上」的键：之前没配就没有 client 在连，
      // 这里得把它拉起来。已经连着同一个地址时不动，免得把好好的连接打断。
      const client = clientRef?.current
      if (client) {
        const want = String(config.wsUrl ?? '').trim()
        if (want && !client.connected && client.url !== want) {
          client.url = want
          client.start()
          logger.info(`wsUrl 改成了 ${want}，开始连接 NapCat`)
        }
      }
    } catch (err) {
      logger?.warn?.('重读 settings.json 失败:', err?.message ?? err)
    }
  }

  try {
    watchFile(file, { interval: 800 }, (cur) => {
      if (!cur || !cur.mtimeMs) return
      if (cur.mtimeMs === lastMtimeMs) return
      lastMtimeMs = cur.mtimeMs
      reload()
    })
  } catch (err) {
    logger?.warn?.('盯 settings.json 失败（热加载不可用）:', err?.message ?? err)
    return
  }

  // 插件卸载时把轮询停掉，别在宿主里留一个永远转的定时器
  try {
    if (typeof ctx.on === 'function') ctx.on('dispose', () => {
      try {
        unwatchFile(file)
      } catch {
        /* 已经没了就算了 */
      }
    })
  } catch {
    /* 没有 dispose 语义的极简宿主，忽略 */
  }
}

/**
 * 把 QQ（OneBot 11 / NapCat）当成 DSH 的一个前端：
 * 私聊 / 群聊各对应一个持久 Agent 会话，消息进来 followup，回复走 session/event 出去。
 */
export function apply(ctx, config) {
  // ⭐ 设置页存下来的覆盖**先于**其它一切生效：logger 的 debug 开关也吃这一层。
  //    这样「在设置里改人设 / 改记忆区路径」不用去碰 profile 的 cordis.patch.yml。
  const savedOverrides = loadOverrides(ctx)
  const appliedOverrides = applyOverrides(config, savedOverrides)
  const logger = makeLogger(ctx, config)
  if (appliedOverrides.length > 0) logger.info(`已应用设置页覆盖: ${appliedOverrides.join(', ')}`)

  // 第一次启动就落一份骨架 settings.json（设置页没上场时，用户手里唯一的入口）
  ensureSettingsFile(ctx, logger)
  // 客户端半端自检：id 对不上 / inject 为空时，宿主会**静默跳过整条 client bundle**，
  // 设置里就看不到 QQ（2026-10-25 踩过两次，issue #2 第 1 条）
  selfCheckClient(logger)
  // 设置页保存后要就地刷新这两份状态：persona 可能换了文件，覆盖表可能变了
  const overridesRef = { current: savedOverrides }
  const personaRef = { current: resolvePersonaFile(config, logger, { home: homeDirOf(ctx, logger) }) }

  // 两层提示词的边界检查：人设里混进工具名，日志留痕但不阻止（怎么写是人家的自由）。
  try {
    const leak = personaLeaks(config?.persona)
    if (!leak.ok) {
      logger.warn(
        `人设里出现了工具用法（${leak.hits.join('、')}）——这些属于行为层，人设只该写「我是谁」。` +
          '工具改名或换宿主时这段会变成错的指引。',
      )
    }
  } catch {
    /* ignore */
  }
  const agents = ctx?.agents

  // 另一个进程（设置面板）改了 settings.json 时，这边自己跟上，不用重启宿主。
  // clientRef 先占位：client 要到下面才建，热更新回调得能拿到它（填 wsUrl 后要自动接上）。
  const clientRef = { current: null }
  watchSettingsFile(ctx, config, overridesRef, personaRef, logger, clientRef)

  // 设置页接口：**运行时注入** webServer，而不是写进顶层 `export const inject`。
  // 有网页服务的宿主（Desktop / Web GUI）才会回调进来；headless 的 qqbot 永远不回调，
  // 于是插件照常激活、QQ 照常在线。顶层声明的话，headless 会一直等 provider →
  // 整个插件不激活 → 机器人直接掉线（2026-10-24 踩过）。
  //
  // 注意：把**父 ctx** 传下去，只借注入回调拿到的 webServer 实例。
  // 路由的 effect 必须挂在父 ctx 上；挂在注入回调那个子 ctx 上，回调一结束就被收走
  // —— 现象是 api-state 写 ok=true、前端却一直 404（2026-10-24 第二次踩）。
  const mountSettingsApi = (extra = {}) => {
    // 测试桩 / 极简宿主可能没有 ctx.inject，这时候跳过就好，别让整个插件崩
    if (typeof ctx.inject !== 'function') return
    // 2026-11-02：调用处一定得在 app 作用域里拿到需要的对象（faceEmbed 之类）。
    // 上次它被收进了一个 try 块，块外一引用就 ReferenceError，
    // 而 apply() 没人接住 —— 表现就是"插件在跑、设置页全 404"。
    // 这里包一层，至少把异常留下来，别再无声无息。
    ctx.inject(['webServer'], (sub) => {
      try {
        return installSettingsApi({ ctx, webServer: sub.webServer, config, logger, ...extra })
      } catch (err) {
        logger.warn?.('[dsh-qq] 设置接口挂载失败（/api/dsh-qq/* 会 404）:', err?.message ?? err)
        return false
      }
    })
  }

  // 只当「设置面板」用：桌面 / Web GUI 那份只提供这一页，不去连 NapCat。
  // 不然同一个 QQ 号在两处同时登录，消息会互相抢。
  if (config.uiOnly) {
    mountSettingsApi({ personaRef, overridesRef })
    logger.info('uiOnly：只提供设置页，不连接 NapCat')
    return
  }

  if (!agents) {
    logger.warn('宿主没有 agents 服务，dsh-qq 不启动')
    return
  }

  // 没配地址就别去连——空 url 会让 `new WebSocket('')` 抛 Invalid URL，然后静默重连到天荒地老；
  // 也不偷偷套一个 3001：那等于替用户做主，连不上还说不出为什么（issue #2 实测反馈）。
  const wsUrl = String(config.wsUrl ?? '').trim()
  if (!wsUrl) {
    logger.warn(
      `还没配 NapCat 的 WebSocket 地址（wsUrl），QQ 不会连上。` +
        `去设置 → QQ 里填，或改 ${settingsFileOf(ctx, logger)}（常见值 ws://127.0.0.1:3001）；` +
        `保存后约 800ms 自动接上，不用重启宿主。`,
    )
  }

  const client = new OneBotClient({
    url: wsUrl,
    token: config.accessToken,
    reconnectMs: config.reconnectMs,
    logger,
  })
  // 2026-11-02：插件被重复 apply（热重载没走 dispose）时，上一个 client 还连着 NapCat。
  // 两条 WS 各收一份推送 → 同一条群消息处理两遍、发给模型的 prompt 整段重复两遍。
  // 建新的之前先把旧的断开。
  if (liveClient && liveClient !== client) {
    try {
      liveClient.stop()
      logger.warn('[dsh-qq] 检测到上一个实例还连着，已断开它的连接（避免同一消息处理两遍）')
    } catch {
      /* 已经断了就算了 */
    }
  }
  liveClient = client
  clientRef.current = client

  let selfId = String(config.selfId ?? '')
  const manager = new SessionManager({ agents, selfId, config, logger, home: homeDirOf(ctx, logger) })
  manager.start()

  // 通道回执：断线 / 发送失败要让她知道（见 bridge.js 顶部那段起因）
  const bridge = createBridge({ config, logger, manager })
const pin = createPin({ config, logger })

  // 每个会话最近 60 秒的发消息时间戳 —— 防「回得太快」被风控
  const sentLog = new Map()

  function rateOk(key, limit) {
    const n = Number(limit) || 0
    if (n <= 0) return true // 0 = 关闭限流
    const now = Date.now()
    const arr = (sentLog.get(key) ?? []).filter((t) => now - t < 60_000)
    if (arr.length >= n) {
      sentLog.set(key, arr)
      return false
    }
    arr.push(now)
    sentLog.set(key, arr)
    return true
  }

  /**
   * 还要多久才够发下一条（毫秒）。0 = 现在就能发。
   *
   * 2026-11-02：限流原来是「超了就 break」，把后半截整段吃掉 ——
   * 姐姐说的「有时候发不出去、像是被截断了」就是它：一轮回复拆十几段，
   * 一分钟 20 条的名额用完，剩下的直接不发，人也收不到。
   * 现在改成等名额空出来再发，宁可慢一点也别丢话。
   */
  function rateWaitMs(key, limit) {
    const n = Number(limit) || 0
    if (n <= 0) return 0
    const now = Date.now()
    const arr = (sentLog.get(key) ?? []).filter((t) => now - t < 60_000)
    sentLog.set(key, arr)
    if (arr.length < n) return 0
    // arr 是按时间 push 的：最早那条滑出 60 秒窗口，就腾出一个名额
    const oldest = arr[arr.length - n] ?? now
    return Math.max(0, oldest + 60_000 - now)
  }

  /**
   * 分段之间等多久。
   *
   * 2026-11-02 姐姐要的：「0.3s 到 1.5s 之间随机选一个时间发下一段，避免被系统检查到」。
   * 原来固定 400ms，节拍太齐 —— 真人不会那样。`splitDelayMeanMs` 那套指数分布更自然，
   * 配了就用它；没配就在 [splitDelayMs, splitDelayMaxMs] 之间均匀摇一个。
   */
  function splitDelayFor(cfg) {
    const mean = Math.max(0, Number(cfg?.splitDelayMeanMs) || 0)
    if (mean > 0) return humanDelay(mean)
    const min = Math.max(0, Number(cfg?.splitDelayMs) || 0)
    const max = Math.max(min, Number(cfg?.splitDelayMaxMs ?? 1500))
    return min + Math.random() * (max - min)
  }

  /**
   * 这一轮按多少字拆段：在 [textChunkLimit, textChunkLimitMax] 之间摇一个整数。
   *
   * 「别把字数限死」—— 固定 30 字一段话要拆六条，像卡带；固定 80 又一坨砸下来。
   * 每条回复摇一次，配合 0.3~1.5 秒的随机间隔，节奏就不那么规整了。
   * 上限没配（0 或比下限还小）就退回固定值，跟加这个功能之前一模一样。
   */
  function chunkLimitFor(cfg) {
    const min = Math.max(16, Number(cfg?.textChunkLimit) || 1500)
    const max = Math.max(0, Number(cfg?.textChunkLimitMax) || 0)
    if (max <= min) return min
    return Math.round(min + Math.random() * (max - min))
  }

  const lastSentAt = new Map() // 群聊里上一条发出去的毫秒时间，用来拉开间隔

  /**
   * 自己发出去的话进历史 + 落聊天流水。正文（send）和工具出口（qq_send / qq_reply / 发图…）共用。
   *
   * 2026-10-27 补：以前只有正文这条记账，工具发出去的话既不进流水、也不进 history，
   * 结果她说过的话在记录里缺一句，下一轮自己也看不见，翻记录还会对不上。
   */
  function noteSelfSaid(record, said) {
    const text = String(said ?? '').trim()
    if (!record || !text) return
    const selfName = manager.selfName || '机器人'
    const entry = historyLine(null, text, { isSelf: true, selfName })
    // ⚠️ 2026-11-01：自己说的话**不进** record.history 了。
    //   那个缓冲现在是"你不在的时候群里说的"，下一轮原样塞回去；
    //   自己刚说的话进去，就会以"别人说的"的形式再出现在眼前一次。
    //   record.recent 照旧记 —— 那是换会话时给新会话接话用的，语义不同。
    record.recent.push(entry)
    const recentKeep = Math.max(80, (Number(config.contextMemoryKeep) || 30) * 3)
    if (record.recent.length > recentKeep) record.recent.splice(0, record.recent.length - recentKeep)

    // 聊天流水：自己说的话也落盘，不然翻记录时只有对方在自言自语
    if (config.chatLog !== false) {
      const myId = manager.selfId || config.selfId || ''
      const who = myId ? `${selfName}(${myId})` : selfName
      appendChatLog(record.dir, { who, text }, logger).catch(() => {})
    }
  }

  // 群聊节奏（热窗/冷窗/无视冷窗）。声明在这里是因为 send 里要用它 ——
  // 「真的发出去了」才算一次回复，才重新抽热窗；选了 [SILENT] 不算。
  let rhythm = null

  async function send(record, text) {
    // 夜里的读书问询：这一轮是给她自己待着的，不是给对话用的。
    // 提示词里已经写了「发不出去」，但光靠说会漏，这里硬拦一道。
    if (record?.quietRound) {
      logger.info(`[dsh-qq] ${record.label} 读书问询轮，这段不往外发`)
      return
    }
    // 「这次不接话」：模型只输出 [SILENT] 就当作它选择潜水 —— 不发、不进历史、不报错。
    // 出口只在「这条不一定是在叫它」时给（见 inbound.js 的 mustReply），
    // 被 @、被引用、私聊都不会走到这里。
    const trimmed = String(text ?? '').trim()
    // 2026-10-27 21:4x 修：原来只认「整条恰好就是 [SILENT]」，
    // 她要是写成「结束这轮，不再说话。[SILENT]」，标记根本不生效，前半句照发。
    // 现在先把标记剥掉：剥完只剩空白＝她选了潜水；还剩话＝照发剩下的。
    const spoken = stripSilentMark(trimmed)
    if (!spoken) {
      if (trimmed.includes(SILENT_MARKER)) {
        logger.info(`[dsh-qq] ${record.label} 选择不接话（${SILENT_MARKER}）`)
        // 沉默不该扣主动开口的额度：机会白给，她想开口的话下次还有（2026-10-26）
        wake.noteProactiveSilent(record)
      }
      return
    }
    // 长文不拆：技术内容一旦被切断就没法读 —— ``` 块断成三截、命令断在两个气泡里。
    // 两个条件都满足才整段发：超过阈值 + 像技术内容（见 chunk.js 的 keepWhole）。
    const keepWholeText = keepWhole(spoken, {
      minChars: Number(config.textNoSplitMinChars) || 0,
      technicalOnly: config.textNoSplitTechnicalOnly !== false,
    })
    // 这一轮按多少字拆段：在 [textChunkLimit, textChunkLimitMax] 之间摇一个。
    // 2026-11-02 姐姐说别把字数限死 —— 固定 30 字会把一段话拆成六条像卡带，
    // 固定 80 又容易一整坨砸下来。每条回复摇一次，长短自然不齐，反而更像人。
    const chunks = keepWholeText ? [spoken] : splitText(spoken, chunkLimitFor(config))
    if (chunks.length === 0) return

    // 外发审计：本机路径 / 凭据整条拦下。流式、整段、报错提示都从这里出去，
    // 所以闸放在 split 之后、真正调 OneBot 之前，一处堵死。
    if (config.auditOutbound !== false) {
      const verdict = auditOutbound(spoken, {
        extraPatterns: config.auditExtraPatterns ?? [],
      })
      if (!verdict.ok) {
        logger.warn(
          `[dsh-qq] ${record.label} 外发被审计拦下（${verdict.kind}）：${verdict.hit}`,
        )
        return
      }
    }
    const isGroup = record.scope === 'group'
    const action = isGroup ? 'send_group_msg' : 'send_private_msg'
    const target = isGroup ? { group_id: Number(record.peerId) } : { user_id: Number(record.peerId) }
    const rateKey = `${record.scope}:${record.peerId}`
    let sentAny = false

    // 群聊：两条回复之间拉开一点。一群人追着问的时候，
    // 连着往外吐最容易被人当成刷屏，也最容易被风控。
    const gapMs = record.scope === 'group' ? Math.max(0, Number(config.groupMinGapMs) || 0) : 0

    // 人味：隔了 20 秒以上才算「新的一轮」，开口前先"看一会儿消息"再打字。
    // 同一轮连发不加——一段一段往外吐的时候每段都卡半秒，反而像卡带。
    const replyMean = Math.max(0, Number(config.replyDelayMeanMs) || 0)
    if (replyMean > 0) {
      const sinceLast = Date.now() - (lastSentAt.get(rateKey) ?? 0)
      if (sinceLast > 20_000) await sleep(humanDelay(replyMean))
    }

    if (gapMs > 0) {
      const last = lastSentAt.get(rateKey) ?? 0
      const wait = last + gapMs - Date.now()
      if (wait > 0 && wait <= 30000) await sleep(wait)
    }
    lastSentAt.set(rateKey, Date.now())

    let failStreak = 0
    for (let index = 0; index < chunks.length; index += 1) {
      // 限流：等名额空出来再发，别把剩下的段直接吃掉。
      // 一秒都不愿意等的时候（罕见）才放弃剩下的。
      const waitMs = rateWaitMs(rateKey, config.rateLimitPerMin)
      if (waitMs > 0) {
        if (waitMs > 60_000) {
          logger.warn(
            `[dsh-qq] ${record.label} 限流要等 ${Math.ceil(waitMs / 1000)} 秒，剩下的 ${chunks.length - index} 段不发了`,
          )
          break
        }
        logger.info?.(
          `[dsh-qq] ${record.label} 触到每分钟上限，等 ${Math.ceil(waitMs / 1000)} 秒再发（剩 ${chunks.length - index} 段）`,
        )
        await sleep(waitMs + 150)
      }
      if (!rateOk(rateKey, config.rateLimitPerMin)) break
      try {
        const result = await client.call(action, { ...target, message: textSegments(chunks[index]) })
        // 记下自己发的消息 id，撤回工具要用
        const sentId = Number(result?.message_id ?? result?.data?.message_id ?? 0)
        if (sentId > 0) record.lastSentMessageId = sentId
        sentAny = true
        failStreak = 0
        // 真发出去了才算用掉一次主动开口的额度（回复不受影响：pending 只在主动轮有）
        wake.noteProactiveDelivered(record)
        logger.info(`→ ${record.label}: ${chunks[index].slice(0, 60)}`)
      } catch (err) {
        failStreak += 1
        logger.warn(
          `发送到 ${record.label} 失败（第 ${index + 1}/${chunks.length} 段）:`,
          err?.message ?? err,
        )
        // 回执：这句没送出去。下一轮投递时会告诉她「是通道断了，不是对方不理你」。
        bridge.noteSendFailure(record, chunks[index], err)
        // 单次失败就跳过着一段接着发后面的 —— 原来是一失败就 break，
        // 结果中间某段网络抖一下，后半截全没了。连丢两次才收手（那是通道真断了）。
        if (failStreak >= 2) {
          logger.warn(
            `[dsh-qq] ${record.label} 连着两次发不出去，剩下的 ${chunks.length - index - 1} 段放弃`,
          )
          break
        }
      }
      if (index < chunks.length - 1) {
        // 分条之间：0.3~1.5 秒之间随机，别用固定节拍（太像机器、也容易被风控认出来）
        await sleep(splitDelayFor(config))
      }
    }

    // 自己发出去的话也要进历史：不然下一轮它看不见「我说过什么」，
    // 群里口吻相近的别的机器人一开口，就会当成自己说的去道歉、去撤回。
    // 记 spoken 不记 trimmed —— 历史里不该留 [SILENT] 这个标记本身。
    if (sentAny) {
      // 2026-11-02：这两个以前是裸调用，前一个抛错就把后一个带走了 ——
      // 表现是"回了一句但热窗不重抽"，而且一点日志都不留（send 的调用方也吞异常）。
      // 拆开各自兜住：记账失败不该影响节奏，节奏失败也不该让回复发不出去。
      try {
        noteSelfSaid(record, spoken)
      } catch (err) {
        logger.warn?.(`[dsh-qq] ${record.label} 记账失败（不影响重抽热窗）:`, err?.message ?? err)
      }
      // 真开口了 → 重抽热窗（"每次回复后抽取热窗和冷窗"）。
      // 放在这里而不是 runTurn 结束：模型可能一句都没发出去（[SILENT]），那不算回复。
      // 第三个参数是**这一轮实际说了多少字**：连着说长话要计入烦躁度（2026-11-04）。
      // 传 spoken 而不是 chunks：拆分只是发送方式，字数是整段算的。
      try {
        rhythm?.noteReply?.(record, Date.now(), spoken)
      } catch (err) {
        logger.warn?.(`[dsh-qq] ${record.label} 重抽热窗失败:`, err?.message ?? err)
      }
    }

    // 发完了，取消「正在输入」
    if (!isGroup) {
      client.call('set_input_status', { user_id: Number(record.peerId), event_type: 0 }, 5000).catch(() => {})
    }
  }

  const approval = new ApprovalChannel({ manager, config, logger, send })
  approval.install(ctx)

  const questions = new QuestionChannel({ manager, config, logger, send })
  questions.install(ctx)

  const contextGuard = createContextGuard({ manager, config, logger })
  // 图片 → 消息内容（走 attachments）。inbound 和节奏层共用同一个，
  // 冷窗攒着的图才带得回去（以前那批只留了 `[图片]` 占位，图全丢）。
  const imagePartsOf = createImagePartsBuilder({
    ctx,
    logger,
    maxOf: () => Number(config.maxImagesPerTurn) || 8,
  })
  // 每群设置的合并视图：settings.json 里的 groupOverrides 叠在全局配置上。
  // 没配过的群拿到的是全局那份对象本身（=== 同一个），热路径没有额外开销。
  const groupConfig = createGroupConfig(config)

  // 群聊节奏：热窗/冷窗/无视冷窗。拦在 inbound 最前面，命中就一条都不投给 Agent。
  // 建在 wake 之前 —— 主动说话那层要问它「这个会话现在能不能开口」。
  // cfgFor：每群设置的合并视图（2026-11-02）。没配过的群直接拿全局那一份，零开销。
  rhythm = createRhythm({
    config,
    manager,
    logger,
    ownerIds: listOf(config.ownerIds),
    buildImageParts: imagePartsOf,
    cfgFor: (peerId) => groupConfig.for(peerId),
  })
  const wake = createWake({ config, manager, logger, bridge, pin, rhythm })
  const bedtime = createSleep({ config, manager, logger })
  // 夜里的读书问询：默认关，本地 profile 打开才有（见 config.js 的 reading* 一组）
  const reading = createReading({ config, manager, logger })
  // 睡着 / 攒着消息的会话都不回收：回收后 tick 遍历不到它，攒的那批就永远交不出去
  manager.keeper = (record) => bedtime.isHolding(record) || Boolean(rhythm?.isHolding?.(record))
  const inbound = createInbound({ ctx, config, manager, logger, client, send, approval, questions, contextGuard, wake, sleep: bedtime, bridge, pin, rhythm, imagePartsOf, cfgFor: (peerId) => groupConfig.for(peerId) })
  const outbound = createOutbound({ manager, config, logger, send, wake })

  // 群黑话 / 角色知识学习：每 20 分钟扫一次群聊记录，把「鲸鲸自己卡壳」的地方
  // 记进该群 记忆区/群词典.md 的「待确认」节（只追加、去重）。
  const disposeLearning = startLearning({
    workspaceRoot: config.workspaceRoot ?? process.cwd(),
    selfId: () => manager.selfId || config.selfId || '',
    logger,
  })

  const offSessionEvent = ctx.on('session/event', outbound)
  const offGuardEvent = ctx.on('session/event', contextGuard.onSessionEvent)

  client.on('event', (event) => {
    inbound(event).catch((err) => logger.warn('处理入站消息失败:', err?.message ?? err))
  })

  client.on('open', async () => {
    logger.info(`已连接 ${config.wsUrl}`)
    // 断过又连回来：只有「断线期间真丢过话」的会话才记一笔，等下一轮投递告知
    bridge.markUp()
    try {
      // 就算配置里写死了 selfId，也要问一次昵称：历史行里「你（昵称）」得写对，
      // 不然它认不出哪个是自己发的。
      const info = await client.call('get_login_info', {}, 10_000)
      if (info?.user_id) {
        if (!selfId) {
          selfId = String(info.user_id)
          manager.selfId = selfId
        }
        if (info.nickname) manager.selfName = String(info.nickname)
        logger.info(`登录账号 ${info.nickname ?? ''} (${info.user_id})`)
      }
    } catch (err) {
      logger.warn('获取登录账号失败，请手动填 selfId:', err?.message ?? err)
    }
  })

  // 断开日志用状态机：第一次断打一行带原因，之后只累计；持续断开时每小时最多一句汇总。
  // 逐条打的话，退避重连（5s→10s→20s→40s→60s）一小时能刷出约 120 行 warn，
  // 把真正重要的行全埋了（issue #2 实测反馈）。
  let downSince = 0
  let dropCount = 0
  let lastSummaryAt = 0
  const noteDown = (reason) => {
    const now = Date.now()
    dropCount += 1
    if (!downSince) downSince = now
    if (dropCount === 1) {
      lastSummaryAt = now
      logger.warn(
        `与 NapCat 断开${reason ? `（${reason}）` : ''}，稍后自动重连；后续重试不再逐条报，恢复时会通知`,
      )
      return
    }
    if (now - lastSummaryAt >= 3600_000) {
      lastSummaryAt = now
      const mins = Math.max(1, Math.round((now - downSince) / 60000))
      logger.warn(
        `与 NapCat 断开已持续约 ${mins} 分钟，累计重试 ${dropCount} 次，最近一次：${reason || '无详情'}`,
      )
    }
  }

  client.on('open', () => {
    if (downSince > 0) {
      const mins = Math.max(1, Math.round((Date.now() - downSince) / 60000))
      logger.info(`NapCat 连回来了（断了约 ${mins} 分钟，累计重试 ${dropCount} 次）`)
    }
    downSince = 0
    dropCount = 0
    lastSummaryAt = 0
  })
  client.on('close', () => {
    bridge.markDown()
    noteDown('')
  })
  client.on('error', (err) => {
    noteDown(String(err?.message ?? err ?? ''))
  })

  // 地址没配就别 start：OneBotClient 会对空 url 无限重试，日志刷屏还没结果。
  // 填上地址后由 watchSettingsFile 那个 clientRef 回调把它拉起来。
  if (wsUrl) {
    client.start()
  } else {
    logger.info('wsUrl 还没填，先不连接 NapCat（填好并保存后会自动接上）')
  }
  // 私聊门控：默认 allowlist，白名单空着 = 谁都不理。不说清楚，用户会以为「加了好友怎么没反应」。
  const privateAllow = listOf(config.privateAllow)
  if (config.replyToPrivate && config.privateMode === 'allowlist' && privateAllow.length === 0) {
    let where = ''
    try {
      where = settingsFileOf(ctx, logger)
    } catch {
      where = ''
    }
    logger.warn(
      '私聊白名单（privateAllow）是空的：现在任何人私聊都不会被回应。' +
        '要把谁放进来，去设置 → QQ 里填他的 QQ 号；想谁都聊就把 privateMode 改成 open。' +
        (where ? `也可以直接改这个文件：${where}（填 "privateAllow": ["你的号"]，保存约 800ms 生效）` : ''),
    )
  }
  wake.start()
  bedtime.start()
  reading.start()
  rhythm.start()

  // 表情包语义检索（2026-11-02）：借记忆库插件架出来的嵌入器。
  // 拿不到服务就自动降级成关键词匹配，功能不残废，只是挑得糙一点。
  // ⚠️ 必须定义在 try 外面：下面 mountSettingsApi 也要用它。
  //   （17:00 那版把它写进了 try 块里，块外引用直接 ReferenceError，
  //     导致 /api/dsh-qq/* 整片没挂上、设置页全 404。别再把作用域收窄。）
  const faceEmbed = createFaceEmbed({ ctx, config, logger })

  try {
    registerTools(ctx, {
      client,
      manager,
      config,
      logger,
      pin,
      wake,
      noteSelfSaid,
      rhythm,
      faceEmbed,
      cfgFor: (peerId) => groupConfig.for(peerId),
    })
  } catch (err) {
    logger.warn('QQ 互动工具注册失败（聊天本身不受影响）:', err?.message ?? err)
  }

  // ── 聊天规矩挂进系统提示词（2026-11-02）──────────────────────────────────
  // 以前是「塞进第一条用户消息 + 账本记一次」。问题：位置错（规则占了发言的位置）、
  // 重注会留两段一样的、改完要等下次重注才生效。
  //
  // 2026-11-02 深夜再改一层：**system 必须静态**。
  //   · 静态三段（规矩/人设/收尾）第一次算完就冻结，之后原样返回；
  //   · 每轮会变的东西（事实卡/群词典/话头/表情包）挪到 systemPrompt.context，
  //     宿主把它渲染成「真实 user 消息之前」那条 runtime-context 消息，不碰 system。
  // 为什么不能再懒省事：system 每轮是整块替换第一节点（agent-loop:1073 inHistory:false），
  // 里面有一个字变了，前缀缓存从第 0 字节起全废，连历史一起作废。
  //
  // 挂不上（老宿主没有 systemPrompt.section）就 manager.chatRulesInSystem 留 false，
  // inbound 那边继续用老的注入方式兜底。
  try {
    manager.chatRulesInSystem = installChatPromptSection({
      ctx,
      config,
      manager,
      logger,
      pin,
      rhythm,
    })
    // 设置页「重载提示词」按钮走这条：清掉冻结表，下一次 assemble 重拼一次。
    // 它是**受控动作**，不是每轮重算 —— 不点就不重拼，system 因此保持逐字节一致。
    //
    // ⚠️ 2026-11-03：光重排 section 不够 —— 人设是从 personaFile 读进 config.persona 的，
    // 那份是**启动时**读的。改了 md 文件点重载，得先把文件重新读一遍，
    // 否则拼出来的还是旧人设（姐姐改完骂人还是那么干净，就是这个）。
    manager.reloadChatPrompt = () => {
      try {
        const now = resolvePersonaFile(config, logger, { home: homeDirOf(ctx, logger) })
        if (personaRef) personaRef.current = now
        logger.info?.(`[dsh-qq] 重载提示词：人设 ${now?.ok ? `读自 ${now.file}` : '用配置里的文本框'}`)
      } catch (err) {
        logger.warn?.('[dsh-qq] 重载人设失败（继续用旧的那份）:', err?.message ?? err)
      }
      reloadChatPrompt()
    }
  } catch (err) {
    manager.chatRulesInSystem = false
    logger.warn('[dsh-qq] 挂系统提示词失败（继续用消息注入）:', err?.message ?? err)
  }

  // ── 设置页接口：/api/dsh-qq/* ─────────────────────────────────────────────
  // DSH 设置界面里那一页（client.js）打的就是这几个口。
  mountSettingsApi({ client, manager, personaRef, overridesRef, rhythm, groupConfig, faceEmbed, wakeInfo: wakeInfoOf })


  ctx.on('dispose', () => {
    try {
      offSessionEvent?.()
      offGuardEvent?.()
      disposeLearning?.()
    } catch {
      /* ignore */
    }
    client.stop()
    wake.stop()
    bedtime.stop()
    reading.stop()
    rhythm?.stop()
    manager.stop()
    approval.cancelAll()
    questions.cancelAll()
  })
}
