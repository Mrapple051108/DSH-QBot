import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { readMessage } from './onebot/segment.js'
import { rememberFaces, facesCount, facesForPrompt, faceSendState } from './faces.js'
import { buildChatPrompt, faceCollectRule, IMAGE_RULES, QUOTE_DIRECTION_HINT, SILENT_HINT } from './prompts.js'
import { evaluateWakeTrigger, rollWakeProbability } from './wake-trigger.js'
import { doorLine } from './door.js'
import {
  factsFileFor,
  glossaryFileFor,
  loadFactsFor,
  loadGlossaryFor,
  loadGroupDigest,
  loadHandoffFor,
  homeDirOf,
} from './settings.js'
import { resolvePeerWorkspace } from './workspace.js'
import { listOf } from './config.js'
import { appendChatLog, CHATLOG_DIR, UNAUTHORIZED_LOG_DIR, dayOf } from './chatlog.js'
import { parseChatLog } from './learning.js'
import { shouldRenewWindow } from './shared/wake-window.js'
import { createSeenTracker, inboundKey } from './shared/dedupe.js'
import { pickWakeLines } from './shared/wake-context.js'
import { matchRequest, buildRequestPrompt } from './request-guard.js'
import { parseEncrypted, decryptCommand, ENC_PREFIX, COMMAND_HELP } from './rsa-channel.js'
import { mkdir, writeFile, readdir, unlink, readFile } from 'node:fs/promises'
import { join, extname, basename } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** 插件自带的 ASR 脚本；配置里没写 asrScript 时用它。 */
const DEFAULT_ASR_SCRIPT = fileURLToPath(new URL('../tools/asr.py', import.meta.url))

/**
 * 跑一次离线 ASR：python asr.py <wav> [model] → {ok, text}
 * 任何异常都吞掉返回空串，绝不让语音把主链路拖死。
 */
function runAsr(config, wavPath) {
  return new Promise((resolve) => {
    const py = config.asrPython || 'python'
    const script = config.asrScript || DEFAULT_ASR_SCRIPT
    if (!script) return resolve('')
    const model = String(config.asrModel ?? '').trim()
    let out = ''
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    let child
    try {
      child = spawn(py, model ? [script, wavPath, model] : [script, wavPath], { windowsHide: true })
    } catch {
      return resolve('')
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      finish('')
    }, Number(config.asrTimeoutMs) || 60000)
    child.stdout?.on('data', (d) => {
      out += d.toString('utf8')
    })
    child.stderr?.on('data', () => {})
    child.on('error', () => {
      clearTimeout(timer)
      finish('')
    })
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const line = out.trim().split('\n').filter(Boolean).pop() || ''
        const json = JSON.parse(line)
        finish(json.ok ? String(json.text || '') : '')
      } catch {
        finish('')
      }
    })
  })
}

function allowPrivate(config, userId) {
  if (!config.replyToPrivate) return false
  if (config.privateMode === 'disabled') return false
  if (config.privateMode === 'allowlist') {
    return listOf(config.privateAllow).includes(String(userId))
  }
  return true
}

function allowGroup(config, groupId) {
  if (config.groupMode === 'disabled') return false
  if (config.groupMode === 'allowlist') {
    return listOf(config.groupAllow).includes(String(groupId))
  }
  return true
}

/**
 * 「@ 之后保活」：有人在群里 @ 过它一次之后，接下来一小段时间里不用每条都 @ 也能接话。
 * 真人在群里也是这样的——被点到名之后，后续那几句话自然会跟着说。
 *
 * 2026-10-24：窗口键从「群号」改成「群号 + 人」。原来按群记，只要有人 @ 一次，
 * 45 秒内群里任何人说话都算数——别人 @ 另一个人、或者跟别人聊天，它也会冲上去接。
 * QLark（src/qlark/chat/keepalive.py）把窗口键做成 (会话, 用户) 元组，注释写得很清楚：
 * 「别人说话既不能续期，也不能蹭用你的窗口」。咱们照抄这一条。
 *
 * 纯内存 Map，进程重启就清空，不落盘。
 */
const groupWakeUntil = new Map()

/** 每个保活窗口里已经回了几次（键同窗口：群:人）。
 *  用户 2026-10-24 转述群友的设计：「@ 之后保活一分钟，发消息刷新保活时间，
 *  群友在限定时间内均匀的拆成固定回几次」—— 光有窗口没有次数上限，就是一被点亮就
 *  每句都插嘴；次数上限让它「均匀地回应几次」而不是复读机。
 *  注意：这条和「窗口内说话续期」会打架（窗口一直续着、额度却固定），默认 0 = 不限。 */
const groupReplies = new Map()

/** 同类机器人「连着聊」的计数（键：对面那个号）。
 *  2026-10-29 姐姐要「能私聊，也能停」：私聊里两只鲸鲸互相回话没有天然终点——
 *  A 回 B，B 又回 A，每轮都算「有人跟我说话」，出站限流只能把它压慢、停不下来。
 *  这里数「连着接了几轮」，超过 peerChatMaxTurns 就先不接；真人一开口整张表清空。
 *  纯内存，进程重启就没了 —— 它管的是「正在连聊」，不跨重启也算数。 */
const peerChatTurns = new Map()

/** 连聊计数的有效期：半小时没动静就重新算。半夜聊两句，别让白天的账还挂着。 */
const PEER_CHAT_TURN_WINDOW_MS = 30 * 60_000

/** 每个「群:人」上次回复的时间。用来做「均匀回应」：两条回复之间至少隔 groupReplyGapMs，
 *  间隔里来的消息不丢，攒进 backlog 等下一次一起看见 —— 比「一个窗口只准回 N 次」温和，
 *  也不会跟「窗口内说话续期」打架（用户 2026-10-24 发现的冲突）。 */
const groupLastReplyAt = new Map()

/** 每个群上次收尾的时间：同一分钟里只收一次（见 fireFarewell）。 */
const farewellAt = new Map()

/** 被 groupReplyGapMs 压住的消息：到点自己醒一次。
 *  没有它，「攒着」就是永久沉默 —— 2026-10-25 群 123456789 实况：
 *  @ 回过一句、下一句在 20 秒内被压进 backlog，姐姐不再开口，就再没动静。 */
const gapReplayTimers = new Map()

/**
 * 这个群要不要 @ 才接话 —— 定义搬到 shared/mention.js 了，
 * 一来能单独测（不拖 inbound 的宿主依赖），二来逻辑就那几行，放明处好改。
 */
import { needMention } from './shared/mention.js'
export { needMention }

/**
 * 距上次回复够不够久。0/负数 = 不限，永远够。
 *
 * 2026-11-01 晚上：热窗里那道闸撤了（姐姐说「热窗内只会生效一次回复，取消掉」），
 * 现在这个只服务于**节奏关着**或**不在热窗**的情况 —— 也就是原版行为。
 * 热窗里"多久才回一次"完全由合并窗口决定（那个跟烦躁度走）。
 */
function gapReady(config, groupId, userId) {
  const gap = Number(config.groupReplyGapMs) || 0
  if (gap <= 0) return true
  const last = groupLastReplyAt.get(wakeKey(groupId, userId)) ?? 0
  return Date.now() - last >= gap
}

/** 这条消息是不是「同类」（群里另一个机器人）发的。
 *  两条判断：`sender.is_robot`（NapCat 对群机器人会带，但不是每只都带），
 *  以及配置里的 `peerBots` 名单（QQ 号）——名单最可靠，兜底。 */
function isPeerBot(config, senderId, event) {
  const id = String(senderId ?? '')
  if (!id) return false
  if ((config?.peerBots ?? []).map(String).includes(id)) return true
  return event?.sender?.is_robot === true
}

/** 保活窗口的键：群 + 人。别人 @ 我，不该给群里其他人开窗。 */
function wakeKey(groupId, userId) {
  return `${groupId}:${userId}`
}

function wakeAlive(groupId, userId) {
  const until = groupWakeUntil.get(wakeKey(groupId, userId)) ?? 0
  return until > Date.now()
}

/**
 * 对话窗口到期的定时器。
 *
 * 2026-11-01 姐姐要的：「被 @ 之后开一个定时，这个期间完全走冷热窗那套标准行为，
 * 只是定时到了之后回最后一条、并发一句『我要去休息了，有事再叫我』」。
 *
 * 所以窗口是**固定时长**、不续期（窗口内接着聊也不延长）——
 * 续期的话窗口永远关不掉，"到点收尾"这件事就永远不会发生。
 * 只有再被 @ / 被引用 / 被点名才重新给一整段。
 */
const wakeTimers = new Map()
/** 由 createInbound 注入：到点了要做的那件事（它会拿到 manager / logger / rhythm）。 */
let onWakeExpire = null

/**
 * 2026-11-03 姐姐报：「反复出现计时提醒，提醒一个就行了，可能是反复 @ 反复创建计时器」。
 *
 * 旧版的键是 `群:人`（`wakeKey`），于是群里 A、B、C 各 @ 一次就是三个定时器，
 * 到点各自喊一遍「收个尾」—— 同一条提醒刷三次。
 *
 * 现在拆成两件事：
 *   · **窗口**（groupWakeUntil / groupReplies）仍按人：谁被开了窗才接谁的话，这部分不动；
 *   · **收尾定时器**按群，`wakeTimers` 只留一个：到点只喊一次。
 * 续期时（groupWakeRenew 开）清掉旧的重设成「该群最晚那个到期时间」；
 * 不续期时（关）压根不重设，第一次 @ 的计时说了算。
 */
function clearWakeTimer(groupId) {
  const key = String(groupId)
  const t = wakeTimers.get(key)
  if (t) {
    clearTimeout(t)
    wakeTimers.delete(key)
  }
}

/** 这个群所有窗口里最晚的到期时间（一个活窗口都没有 → 0）。 */
function groupUntilAt(groupId) {
  const prefix = `${groupId}:`
  let max = 0
  for (const [k, v] of groupWakeUntil) {
    if (k.startsWith(prefix) && v > max) max = v
  }
  return max
}

/**
 * 「对话窗口」的开 / 关历史 —— 只给可视化用（2026-11-04 姐姐要的）。
 *
 * 她原话：「@ 之后不是会有一个计时器吗？到点以后应该在状态面板上显示，
 * 以及曲线也变成虚线」。
 *
 * 账本和区间换算都搬到 `shared/wake-spans.js` 了（纯模块，能单独测）；
 * 这里只负责把「窗口什么时候开、什么时候关」这两个时刻记下来。
 */
export function wakeInfoOf(groupId, now = Date.now()) {
  const gid = String(groupId)
  const until = groupUntilAt(gid)
  const list = spansOf(gid)
  return {
    until,
    live: until > now,
    ranges: spansToRanges(list, until, now),
    spans: list.slice(-40),
  }
}

/** 把该群里已经过期的窗口清掉，返回还剩几个活的。 */
function pruneGroupWindows(groupId, now = Date.now()) {
  const prefix = `${groupId}:`
  let alive = 0
  for (const [k, v] of groupWakeUntil) {
    if (!k.startsWith(prefix)) continue
    if (v > now) {
      alive += 1
      continue
    }
    groupWakeUntil.delete(k)
    groupReplies.delete(k)
  }
  return alive
}

function armWakeTimer(config, groupId) {
  if (config?.groupWakeFarewell === false) return
  clearWakeTimer(groupId)
  const until = groupUntilAt(groupId)
  // 一个活窗口都没有：没什么可等的，别排一个 1 秒后必然误触发的定时器
  if (until <= Date.now()) return
  const wait = Math.max(1000, until - Date.now())
  const timer = setTimeout(() => {
    wakeTimers.delete(String(groupId))
    // 这期间又被 @ 了 → 那边重新 arm 过，这里什么都别做
    if (groupUntilAt(groupId) > Date.now()) return
    pruneGroupWindows(groupId)
    // 可视化用：这一刻关窗（曲线上从这儿开始画虚线）
    noteWakeSpan(groupId, 'close')
    try {
      onWakeExpire?.(groupId)
    } catch {
      /* 收尾失败不影响收窗口 */
    }
  }, wait)
  timer.unref?.()
  wakeTimers.set(String(groupId), timer)
}

/** 当场关窗：人已经停下来了，别再等着接下一句。 */
function closeWake(config, groupId, userId) {
  const key = wakeKey(groupId, userId)
  groupWakeUntil.delete(key)
  groupReplies.delete(key)
  const alive = pruneGroupWindows(groupId)
  if (alive > 0) armWakeTimer(config, groupId)
  else {
    clearWakeTimer(groupId)
    noteWakeSpan(groupId, 'close')
  }
}

/**
 * 开窗 / 续期。返回值 `true` 表示**这一次真的开了一个新窗口**
 * （调用方拿它决定要不要顺带补几条附近的消息）。
 *
 * 2026-11-02 姐姐要的两段开关（groupWakeRenew）：
 *   开（默认）—— 每次 @ 都把计时重新算一遍，聊多久都能续；
 *   关       —— 第一次 @ 开始计时，窗口期间的 @ 不产生新计时。
 * 以前这里硬编码成"每次都续"，窗口永远关不掉，那句告别就会一段接一段地重复说。
 */
function refreshWake(config, groupId, userId) {
  const key = wakeKey(groupId, userId)
  const ms = Number(config.groupWakeMs) || 0
  if (ms <= 0) {
    groupWakeUntil.delete(key)
    groupReplies.delete(key)
    clearWakeTimer(groupId)
    return false
  }
  const now = Date.now()
  const openUntil = groupWakeUntil.get(key) ?? 0
  const isNewWindow = openUntil <= now
  // 不刷新的模式：窗口还开着就什么都不动 —— 计时不延长、回复额度不清零、
  // 定时器也不重挂。第一次 @ 开的那个计时说了算。
  if (!shouldRenewWindow({ openUntil, now, renew: config.groupWakeRenew })) return false
  if (isNewWindow) groupReplies.set(key, { startedAt: now, count: 0 })
  groupWakeUntil.set(key, now + ms)
  // 可视化用：窗口（重新）开了 —— 从这一刻起它在群里可以主动开口
  noteWakeSpan(groupId, 'open', now)
  // 到点收尾：这一段固定时长走完，让它自己说一句「我要去休息了」。
  // ⚠️ 定时器按**群**排，一个群只有一个（见 armWakeTimer 上面那段注释）。
  armWakeTimer(config, groupId)
  // 顺手清掉过期的，别让 Map 越攒越大
  if (groupWakeUntil.size > 200) {
    for (const [k, v] of groupWakeUntil) {
      if (v <= now) {
        groupWakeUntil.delete(k)
        groupReplies.delete(k)
      }
    }
  }
  return isNewWindow
}

/** 这个窗口里还剩几次回复额度（0 = 不限）。用户 2026-10-24 转述群友方案：
 *  「@ 之后保活一分钟…群友在限定时间内均匀的拆成固定回几次」—— 别一被点亮就连珠炮。 */
function repliesLeft(config, groupId, userId) {
  const max = Number(config.groupRepliesPerWindow) || 0
  if (max <= 0) return Infinity
  const rs = groupReplies.get(wakeKey(groupId, userId))
  if (!rs) return max
  if ((groupWakeUntil.get(wakeKey(groupId, userId)) ?? 0) <= Date.now()) return max
  return Math.max(0, max - rs.count)
}

function countReply(groupId, userId) {
  const key = wakeKey(groupId, userId)
  const rs = groupReplies.get(key)
  if (rs) rs.count += 1
  else groupReplies.set(key, { startedAt: Date.now(), count: 1 })
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 一天里的大概时段，用来说「下午/晚上」时不用模型自己换算。 */
function periodOf(hour) {
  if (hour < 5) return '凌晨'
  if (hour < 8) return '早上'
  if (hour < 11) return '上午'
  if (hour < 13) return '中午'
  if (hour < 17) return '下午'
  if (hour < 19) return '傍晚'
  if (hour < 23) return '晚上'
  return '深夜'
}

const pad2 = (n) => String(n).padStart(2, '0')

/** 本地时区的今天 YYYY-MM-DD。
 *  ⚠️ 别用 `toISOString().slice(0,10)` —— 那是 UTC，+08 时区凌晨 0–8 点会算成昨天。 */
function localDay(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 人话时间（完整版）：2026-10-24 周六 13:05（下午）。
 *  直接给模型一句能照念的话，别让它拿 ISO 时间戳自己换算白天晚上。 */
function humanTime(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${WEEKDAYS[d.getDay()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}（${periodOf(d.getHours())}）`
}

/** 历史行里的短时间：10-24 周六 13:05（下午）。一条消息只占一行，别太长。 */
function historyTime(d = new Date()) {
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${WEEKDAYS[d.getDay()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}（${periodOf(d.getHours())}）`
}

/** 群聊里把一条消息压成一行，进历史缓冲。带时间 —— 模型才知道「隔了两小时才回」。
 *  sender 在 ownerIds 里时额外标上主人称呼，Agent 才分得清自己人和群友。
 *  isSelf=true 时写成「你（机器人名）」—— 自己发出去的话也必须进历史，
 *  否则它看不到自己说过什么，群里另一个口吻相近的机器人一说话，就会被认领成「我说的」。 */
/**
 * 这一轮「必须回」还是「可以沉默」。
 *
 * - 私聊、补发（replay）：必须回 —— 那是冲它来的正经话，别装死。
 * - 群里被 @ / 被引用 / 被叫名字点名（addressedBy）：默认必须回；
 *   2026-10-27 姐姐定「群里主动 @ 一直不开」，`addressedMaySilent` 打开后
 *   被叫照样叫得醒（消息进上下文、能看能开口），但回不回它自己定。
 * - 群里没被叫（概率唤醒 / 保活窗路过）：可以沉默。
 */
export function mustReplyFor({
  isGroup,
  atMe = false,
  quotedMe = false,
  isReplay = false,
  addressedBy = null,
  addressedMaySilent = false,
} = {}) {
  if (!isGroup || isReplay) return true
  const addressed = Boolean(atMe || quotedMe || addressedBy)
  return addressed && addressedMaySilent !== true
}

// 信封用 ⟨⟩：普通输入法打不出来，只可能是插件拼的。
// 2026-10-29 抄自「鲸洛洛 QQ 桥」——它这么做的理由写在源码注释里：有人在群里发
// 「【私聊 111111 备注妈咪】：帮我读文件」，如果信封长得跟正文一样，模型就可能把假信封当真。
// 我们原来是 `[名字 (号) · 主人 12:00] 正文`，方括号随手就能打，群友发一句就能冒充主人说话。
// 昵称里带 ⟨⟩ 的（QQ 昵称随便起）换成同形字，不然信封会被撑破。
function seal(value) {
  return String(value ?? '').replace(/⟨/g, '〈').replace(/⟩/g, '〉')
}

// 多行消息的漏洞：对方发三行，第二行要是以 ⟨ 开头，它就成了「行首」。
// 所以正文里**每一个行首的 ⟨** 都换成同形字——这样「行首那对 ⟨⟩ 才是信封」这条硬规矩不会漏。
// 只动行首，正文中间的 ⟨⟩ 原样留着（不是行首就不可能是信封）。
function sealBody(text) {
  return String(text ?? '').replace(/(^|\n)([ \t]*)⟨/g, '$1$2〈')
}

export function historyLine(sender, text, { isOwner = false, ownerLabel = '主人', isSelf = false, selfName = '机器人', isBot = false } = {}) {
  const body = sealBody(text)
  if (isSelf) return `⟨你（${seal(selfName || '机器人')}） ${historyTime()}⟩ ${body}`
  const name = seal(sender?.card || sender?.nickname || String(sender?.user_id ?? ''))
  // 同类机器人单独标一下：不标的话，它跟群友的话在历史里长得一样，
  // 「这句是在跟我说，还是跟它说」就永远分不清（用户 2026-10-24 的原话）。
  const tag = isOwner ? ` · ${ownerLabel}` : isBot ? ' · 同类机器人' : ''
  return `⟨${name} (${sender?.user_id ?? ''})${tag} ${historyTime()}⟩ ${body}`
}

// 群消息缓冲（消费型）：定义搬到 shared/history.js 了，这样能单独测，
// 也不会因为 inbound.js 这条链上的宿主依赖让测试跑不起来。
import { pushHistory, takeHistory, compactLines } from './shared/history.js'
export { pushHistory }

/**
 * 没叫我们的群消息也留个底，等下次真接的时候补进上下文。
 *
 * 2026-10-24 实况：群友 A 说了个梗，这句没 @ 我们 → 直接 return 掉；
 * 两分钟后群友 B 接了这个梗 → 它却顺着 B 那句话编，因为它根本不知道梗是谁说的、什么意思。
 * 跳过归跳过（不叫醒它），但这些话得让它看得见 —— 不然接话全靠猜。
 *
 * 2026-11-03 拆成两个账（上下文 / 待回），实现搬到 shared/backlog.js 了 ——
 * 一来那儿能单独测，二来这个 bug 就是「两种东西混在一个桶里」引起的。
 */
import { keepBacklog, drainBacklog, drainPending } from './shared/backlog.js'
export { keepBacklog, drainBacklog, drainPending }

/**
 * 热窗收尾的判定与文案（2026-11-04）。纯函数放在 shared 里，
 * 一是这里能单独测「窗口关没关、该交哪些」，二是这段判定被改坏过一次（1.3.2）。
 */
import { hotEndStanding, hotEndLines, hotEndText, farewellText } from './shared/hot-end.js'
/** 对话窗口的开 / 关账本（面板要显示「到点」、曲线要画虚线）。 */
import { noteWakeSpan, spansOf, spansToRanges } from './shared/wake-spans.js'

/**
 * 同一条消息只处理一次。见 shared/dedupe.js 的注释。
 * 放在模块级而不是 per-client：插件被重复 apply 出两个实例时，
 * 也只有共享同一本账才挡得住。
 */
const seenInbound = createSeenTracker()

function alreadySeen(event) {
  return !seenInbound.mark(inboundKey(event))
}

/**
 * 连发合并时把重复的规矩行收成一份 —— 实现见 shared/merge-body.js。
 * （以前这里是本地的一份，挪出去是为了能单独测。）
 */
import { mergeBodies } from './shared/merge-body.js'
import { shouldCueFace, appendFaceCue } from './shared/face-cue.js'

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
}

function guessExt(url, mime) {
  const byMime = EXT_BY_MIME[mime]
  if (byMime) return byMime
  const fromUrl = extname(new URL(url, 'http://x').pathname || '').toLowerCase()
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(fromUrl) ? fromUrl : '.png'
}

const FORWARD_MAX_ITEMS = 30
const FORWARD_MAX_CHARS = 2000

/**
 * 合并转发（群里那张「聊天记录」卡片）展开成纯文本。
 *
 * OneBot 的 forward 段只带一个 id，内容要另外调 get_forward_msg 取。
 * 不展开的话，agent 在群里只看得见「[合并转发]」四个字——等于那段话没说过。
 * 取不到就如实标出来，别装成看见了。
 */
export async function expandForwards(client, forwards, { logger } = {}) {
  if (!Array.isArray(forwards) || forwards.length === 0) return ''
  const out = []

  for (const f of forwards) {
    if (!f?.id) {
      out.push('[合并转发·拿不到 id]')
      continue
    }

    let res
    try {
      // NapCat 认 message_id，标准 OneBot 写 id——两个都递过去，谁认谁接
      res = await client.call('get_forward_msg', { message_id: f.id, id: f.id })
    } catch (err) {
      logger?.debug?.(`[dsh-qq] 合并转发取不到（${f.id}）：${err?.message || err}`)
      out.push('[合并转发·展开失败]')
      continue
    }

    const list = Array.isArray(res?.messages) ? res.messages : res?.message ? [res] : []
    if (list.length === 0) {
      out.push('[合并转发·空的]')
      continue
    }

    const lines = []
    let used = 0
    for (const item of list) {
      if (lines.length >= FORWARD_MAX_ITEMS || used >= FORWARD_MAX_CHARS) {
        lines.push(`…（还差 ${list.length - lines.length} 条没放进来，太长了）`)
        break
      }
      const who = String(item?.sender?.card || item?.sender?.nickname || item?.sender?.user_id || '?')
      const body = readMessage(item?.message, {}).text || '[无文字]'
      const line = `${who}：${body}`
      used += line.length
      lines.push(line)
    }
    out.push(`[合并转发 ${list.length} 条]\n${lines.join('\n')}`)
  }

  return out.join('\n')
}

/**
 * 第一次被 @ 时，把群里最近几条捞出来垫在下面。
 *
 * 2026-11-02 姐姐要的：「群聊中仅 @ 唤醒时，第一次 @ 带几条群聊消息（默认十条），
 * 避免首次 @ 时没有附近的消息」。刚被叫醒那一刻 backlog 里往往只有零星几条
 * —— 窗口开着的时候别人说话是直接投递的、不进 backlog —— 接话全靠猜。
 *
 * 两条路，按可靠度排：
 *   ① OneBot 的 get_group_msg_history —— 能拿到插件启动之前的话；
 *   ② 插件自己写的聊天流水 —— 接口不认的时候兜底，一定在。
 * 两条都空就返回空，绝不因为"补上下文"把这一轮投递拖垮。
 */
async function fetchWakeContext(client, groupId, count, { logger, dir, selfId = '', since = 0, lookbackMs = 0 } = {}) {
  const want = Math.max(0, Math.min(50, Number(count) || 0))
  if (want <= 0) return []
  // 两道时间闸取更严的那个：
  //   since   —— 上次投递的水位（内存里的，重启会丢）；
  //   lookback —— 往前翻多久（默认 10 分钟）。重启后水位没了，就靠它兜住，
  //              不然「附近的消息」会把昨天的话当成刚才的聊的天翻上来（11-02 那次）。
  const lookback = Math.max(0, Number(lookbackMs) || 0)
  const floor = Math.max(Number(since) || 0, lookback > 0 ? Date.now() - lookback : 0)

  let api = []
  if (typeof client?.call === 'function') {
    try {
      const res = await client.call(
        'get_group_msg_history',
        // 不传 reverse_order：go-cqhttp / NapCat 的默认就是从旧到新，
        // 各家对蛇形还是驼峰的拼法不一致，少传一个参数就少一个坑。
        { group_id: Number(groupId), count: want + 1 },
        8000,
      )
      const list = Array.isArray(res?.messages)
        ? res.messages
        : Array.isArray(res?.data?.messages)
          ? res.data.messages
          : []
      api = pickWakeLines(
        list
          // 最后一条通常就是刚 @ 我这个动作本身 —— 正文已经在 parts 里了，别重复摆一遍
          .slice(0, -1)
          .map((item) => ({
            uid: String(item?.sender?.user_id ?? ''),
            at: Number(item?.time) > 0 ? Number(item.time) * 1000 : 0,
            name: String(item?.sender?.card || item?.sender?.nickname || item?.sender?.user_id || '?'),
            text: String(readMessage(item?.message, {}).text || '').trim() || '[无文字]',
          })),
        { selfId, floor, limit: want },
      )
    } catch (err) {
      logger?.debug?.(`[dsh-qq] 拉群历史失败 ${groupId}: ${err?.message || err}`)
    }
  }
  if (api.length >= want) return api.slice(-want)

  const local = await readLocalWakeContext(dir, want, { selfId, since: floor })
  return local.length > api.length ? local : api
}

/**
 * 从本地聊天流水里取最近的几条（`<会话目录>/聊天记录/YYYY-MM-DD.md`）。
 * 今天和昨天都翻：凌晨被 @ 的时候，附近的消息有一半还留在昨天那个文件里。
 *
 * 过滤规则全在 `pickWakeLines` 里（跳过自己 / 时间闸 / 空文本 / 重复行），
 * 这里只负责把流水行还原成 {uid, at, name, text}。
 */
async function readLocalWakeContext(dir, count, { selfId = '', since = 0 } = {}) {
  const want = Math.max(0, Math.min(50, Number(count) || 0))
  if (!dir || want <= 0) return []
  const rows = []
  for (const at of [new Date(), new Date(Date.now() - 86_400_000)]) {
    const day = dayOf(at)
    const file = join(dir, CHATLOG_DIR, `${day}.md`)
    let raw
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      continue // 没这个文件就算了
    }
    for (const row of parseChatLog(raw, selfId)) {
      // 流水只有 HH:MM:SS，补上当天日期还原成时间戳（本地时区）
      const atMs = Date.parse(`${day}T${row.time}`)
      rows.push({
        uid: row.uid,
        at: Number.isFinite(atMs) ? atMs : 0,
        name: row.name,
        text: row.text,
      })
    }
  }
  return pickWakeLines(rows, { selfId, floor: since, limit: want })
}

/**
 * 下载一张图到本地缓存，返回绝对路径；失败返回 null。
 * 只接受 http(s) 和 base64:// 两种来源。
 *
 * export 出去是因为 `qq_images`（tools.js）也要用同一条下载路径：
 * 按消息 id 现取图的时候，落到跟收消息一样的缓存目录里，用完能一起被清。
 */
export async function downloadImage(url, cacheDir, maxMB) {
  try {
    if (!url) return null

    // base64:// 直接落盘
    if (url.startsWith('base64://')) {
      const buf = Buffer.from(url.slice('base64://'.length), 'base64')
      if (buf.length > maxMB * 1024 * 1024) return null
      const p = join(cacheDir, `qq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`)
      await writeFile(p, buf)
      return p
    }

    if (!/^https?:\/\//i.test(url)) return null

    const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > maxMB * 1024 * 1024) return null

    const ext = guessExt(url, res.headers.get('content-type') ?? '')
    const p = join(cacheDir, `qq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`)
    await writeFile(p, buf)
    return p
  } catch {
    return null
  }
}

/** 清掉缓存里太老的图，避免堆成垃圾场。 */
async function pruneCache(cacheDir, keepFiles = 200) {
  try {
    const names = (await readdir(cacheDir)).filter((n) => n.startsWith('qq-'))
    if (names.length <= keepFiles) return
    const stats = await Promise.all(
      names.slice(0, names.length - keepFiles).map(async (n) => {
        const p = join(cacheDir, n)
        try {
          const { stat } = await import('node:fs/promises')
          const s = await stat(p)
          return { p, mtime: s.mtimeMs }
        } catch {
          return null
        }
      }),
    )
    for (const item of stats.filter(Boolean).slice(0, 20)) {
      await unlink(item.p).catch(() => {})
    }
  } catch {
    /* 清缓存失败不影响主链路 */
  }
}

/**
 * 入站：OneBot 消息事件 → agent.followup()。
 *
 * 触发规则全部走配置，插件自己不做「猜你还想聊」这种自作聪明的事。
 */
export function createInbound({ ctx, config, manager, logger, client, send, approval, questions, contextGuard, wake, sleep, bridge, pin, rhythm, imagePartsOf, cfgFor }) {
  // 没配 imageCacheDir 时落在工作目录下的「图片缓存」；每个会话再各占一层子目录（见下）
  const baseCacheDir =
    String(config.imageCacheDir ?? '').trim() ||
    join(String(config.cwd ?? '').trim() || process.cwd(), '图片缓存')
  const maxMB = Number(config.imageMaxMB) || 8
  // RSA 命令通道的私钥目录（每群一个 json）。跟设置文件放一起，不进 settings.json。
  const rsaDir = join(homeDirOf(ctx, logger), 'rsa')
  // 谁是主人：群聊里用 QQ 号打标，私聊不影响（私聊本来就在白名单里）
  const ownerIds = new Set((Array.isArray(config.ownerIds) ? config.ownerIds : []).map(String))
  const ownerLabel = String(config.ownerLabel ?? '').trim() || '主人'

  // 连发合并：同一个 peer 的几条消息攒在一起回。
  // 键是「谁发的」，值是正在等的这一批（bodies 是各自已经拼好的正文）。
  const mergeBatches = new Map()

  /**
   * 把下载到本地的图片变成模型能直接看的 image content。
   *
   * 2026-11-01 搬到 shared/image-parts.js 了 —— 群聊节奏（冷窗攒消息）那边也要用：
   * 攒着的图以前只留了 `[图片]` 占位，图本身躺在硬盘上没人看，姐姐反馈的
   * 「连发几张图只有一条被看见了」就是这个。这里留一层转发，调用点不用改。
   */
  const buildImageParts = imagePartsOf

  /**
   * 对话窗口到期：让它收个尾。
   *
   * 2026-11-01 姐姐要的：「定时到了之后回最后一条，并发一句『我要去休息了，有事再叫我』」。
   * 所以这里不硬塞台词 —— 把还没回的话摆到它面前，让它自己组织那句告别
   * （按人设来，比模板像人）。不想说就 [SILENT]，没人逼它开口。
   *
   * 无视冷窗里直接跳过：它正躲着，这时候"主动告别"等于自己抽自己。
   */
  async function fireFarewell(groupId) {
    try {
      if (rhythm?.phaseOf?.('group', groupId) === 'ignore') {
        logger.debug?.(`[dsh-qq] 群 ${groupId} 对话窗口到期，但它在无视冷窗里，不打扰`)
        return
      }
      // 兜底：同一个群一分钟内只收尾一次。
      // 2026-11-03 姐姐报「反复出现计时提醒」——定时器已经按群收敛成一个，
      // 这里再压一道，防止边界情况下（进程重启、窗口被重开）同一条提醒刷两遍。
      const lastAt = Number(farewellAt.get(String(groupId))) || 0
      if (Date.now() - lastAt < 60_000) {
        logger.debug?.(`[dsh-qq] 群 ${groupId} 一分钟内已经收过尾，跳过`)
        return
      }
      farewellAt.set(String(groupId), Date.now())
      let record
      try {
        record = await manager.obtain({ scope: 'group', peerId: groupId, label: `群 ${groupId}` })
      } catch (err) {
        logger.warn?.(`[dsh-qq] 窗口到点取会话失败 ${groupId}: ${err?.message ?? err}`)
        return
      }
      // 2026-11-04：以前这里把缓冲当注脚塞在最前面，主体只叫它「说句再见」，
      // 于是它常常只念了告别，那几句就再也没人回 —— 姐姐说的「只叫它说再见，
      // 而不带缓冲区消息」。现在顺序钉死：**先回话，再收尾**（文案见 farewellText）。
      const { pending } = drainPending(groupId)
      const contextLines = drainBacklog(groupId)
      const lines = hotEndLines({
        pending,
        context: contextLines,
        maxContext: Math.max(1, Number(config.historyLimit) || 16),
      })
      const text = farewellText({ pending: lines.pending, context: lines.context })
      logger.info?.(
        `[dsh-qq] 群 ${groupId} 对话窗口到期：先回 ${lines.pending.length} 条该回的 + ` +
          `${lines.context.length} 条上下文，再收尾`,
      )
      manager.enqueue(record, async () => {
        // 收尾这一轮说完「我去忙了」，不该把热窗又续上（姐姐观察到的「告别会触发热窗，
        // 又进入计时周期」就是这个）。标记在这儿挂上，`rhythm.noteReply` 看到就跳过。
        record.farewellTurn = true
        try {
          record.agent.followup(
            createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
          )
          await Promise.race([
            Promise.resolve(record.agent.whenIdle?.()).then(() => 'idle'),
            new Promise((resolve) => {
              const t = setTimeout(() => resolve('timeout'), 120_000)
              t.unref?.()
            }),
          ])
        } catch (err) {
          logger.warn?.(`[dsh-qq] 收尾投递失败 ${groupId}: ${err?.message ?? err}`)
        } finally {
          record.farewellTurn = false
          // 说完就收摊：直接进冷窗，别停在热窗里让下一条消息接着聊
          try {
            rhythm?.settleCold?.(record)
          } catch (err) {
            logger.debug?.(`[dsh-qq] 收尾后切冷窗失败 ${groupId}: ${err?.message ?? err}`)
          }
        }
      })
    } catch (err) {
      logger.warn?.(`[dsh-qq] 收尾失败 ${groupId}: ${err?.message ?? err}`)
    }
  }

  // 模块级的定时器只能回调一个函数，这里把「到点做什么」接上
  onWakeExpire = (groupId) => {
    void fireFarewell(groupId)
  }

  /**
   * 热窗到点：手里的缓冲先交出去，别让它们烂到冷窗里等十几分钟。
   *
   * 姐姐 2026-11-02 原话：「有概率热窗期间有消息但被回复延时卡住直接进冷窗，
   * 应该在切换时缓冲区有消息就全传给智能体，没有就进冷窗」。
   *
   * 2026-11-04 她报的两个毛病，都是这一段被改坏后的连锁反应：
   *
   *   ①「热窗换到冷窗时没有发送消息，原本是有热窗换冷窗会把缓冲区的消息
   *      发给它的，回了就继续热窗，选择不回就切冷窗」
   *      → 1.3.2 只交 `pending`，可热窗里根本没有间隔闸（`skipGap` 让它失效）、
   *        额度也默认不限，`pending` 永远是空的，于是每次都在第一行 return。
   *
   *   ②「抽中的时间没人说话，到点以后却没有收到消息，然后一直顶到上限才回」
   *      → 同一个原因：收尾没发生，那几句就躺在冷窗里，等冷窗到期（6~15 分钟）
   *        才被 `flushKey('cold')` 端出来，看起来就是"憋到上限才回"。
   *
   * 现在的判据换成**「它现在有没有开口的资格」**（判据在 shared/hot-end.js）：
   *   · 必须 @ 才接话的群：只有 @ 开出来的窗口**还开着**才交 —— 窗口早关了还冒出来
   *     接话，正是 1.3.2 要修的那次事故，这条底线没丢；
   *   · 不用 @ 的群：本来就允许它主动接话，照交。
   *
   * 交出去的内容分两种：`pending`（冲它来的）和 `backlog` 剩下的（别人在聊什么）。
   * 剩下的就交给它自己：接了 → `noteReply` 重抽热窗，接着续上；
   * 只回 [SILENT] → 什么都不发，安静进冷窗。这正是姐姐要的那两段语义。
   */
  async function flushBuffersOnHotEnd({ scope, peerId, label }) {
    if (String(scope) !== 'group') return
    const gcfg = cfgFor?.(peerId) ?? config
    // ① 先看资格。窗口已经关了 → 一句都别交，也别白建会话。
    const standing = hotEndStanding({
      needMention: needMention(gcfg, peerId),
      wakeUntil: groupUntilAt(peerId),
    })
    if (!standing.speak) {
      logger.debug?.(
        `[dsh-qq] ${label} 热窗结束，但对话窗口早就关了（必须 @ 的群），不开口，直接进冷窗`,
      )
      return
    }
    // ② 两个账一起取：pending = 该回却被压住的；剩下的 = 这期间别人说的话（上下文）。
    //    取走就空（消费型），不会下一轮再喂一遍。
    const { pending } = drainPending(peerId)
    const contextLines = drainBacklog(peerId)
    const lines = hotEndLines({
      pending,
      context: contextLines,
      maxContext: Math.max(1, Number(config.historyLimit) || 16),
    })
    // ③ 真的是空的 → 安静进冷窗。这是正常情况（没人说话），不该凭空多说一句。
    //    以前这儿先 obtain 再判空，于是每个群新状态的第一轮热窗都白建一次会话
    //    （宿主重启后群里第一句话必然触发一次）—— 日志里那串「会话就绪」就是它。
    if (lines.total === 0) {
      logger.debug?.(`[dsh-qq] ${label} 热窗结束，缓冲是空的，直接进冷窗`)
      return
    }
    let record = null
    try {
      record = await manager.obtain({ scope: 'group', peerId, label: label || `群 ${peerId}` })
    } catch (err) {
      logger.warn?.(`[dsh-qq] 热窗收尾取会话失败 ${peerId}: ${err?.message ?? err}`)
      return
    }
    if (!record) return
    // history 是消费型缓冲：取走 = 这一轮已经交给它了，不会下一轮再来一遍
    const kept = Array.isArray(record.history) ? compactLines(takeHistory(record)) : []
    const text = hotEndText({
      label,
      pending: lines.pending,
      context: [...lines.context, ...kept],
    })
    logger.info?.(
      `[dsh-qq] ${label} 热窗结束，交出去 ${lines.pending.length} 条该回的 + ` +
        `${lines.context.length + kept.length} 条上下文（${standing.reason === 'free' ? '这个群不用 @' : '对话窗口还开着'}），让它自己决定接不接`,
    )
    manager.enqueue(record, async () => {
      try {
        record.agent.followup(
          createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
        )
        await Promise.race([
          Promise.resolve(record.agent.whenIdle?.()).then(() => 'idle'),
          new Promise((resolve) => {
            const t = setTimeout(() => resolve('timeout'), 60_000)
            t.unref?.()
          }),
        ])
      } catch (err) {
        logger.warn?.(`[dsh-qq] 热窗收尾投递失败 ${label}: ${err?.message ?? err}`)
      }
    })
  }

  rhythm?.setHotEndHandler?.((info) => {
    void flushBuffersOnHotEnd(info).catch((err) =>
      logger.warn?.(`[dsh-qq] 热窗收尾失败: ${err?.message ?? err}`),
    )
  })

  /**
   * 投递一轮。单条消息和「连发合并」后的整段，走的是同一条路。
   */
  /**
   * 这一轮要不要挂「可以顺手发张表情包」的提示（2026-11-03）。
   *
   * 姐姐的原话：「每次来消息以后（从缓冲区发进来）抽一个随机数（25% 的概率）
   * 提示它发送一张表情包，这个概率可配置，可全局配置也可以按群聊配置」。
   *
   * 三个闸一起看，别只顾着掷骰子：
   *   ① 开关 / 概率（按群覆盖，没配就跟随全局）；
   *   ② 收藏里有没有图 —— 空的时候提示它发图，它只会去撞墙；
   *   ③ 现在发不发得出去（`faceSendState`：间隔 + 每小时上限），刚发过就别提示。
   * 提示只是"可以发"，发不发由它自己定；正文里不解释、不配解说。
   */
  function withFaceCue(body, { peerId, isGroup }) {
    try {
      const cfg = cfgFor?.(peerId) ?? config
      if (cfg?.faceCueEnabled === false) return body
      let have = 0
      try {
        have = Number(facesCount(config)) || 0
      } catch {
        have = 0
      }
      let allowed = true
      try {
        // 按会话自己的配置 + 按会话分开计数（2026-11-03）
        allowed = faceSendState(cfg, peerId).allowed !== false
      } catch {
        allowed = true
      }
      const hit = shouldCueFace({
        enabled: cfg?.faceCueEnabled !== false,
        chance: cfg?.faceCueChance,
        facesCount: have,
        sendAllowed: allowed,
      })
      if (!hit) return body
      logger.debug?.(`[dsh-qq] ${isGroup ? '群' : '私聊'} ${peerId} 这轮掷中表情包提示（概率 ${cfg?.faceCueChance}%）`)
      return appendFaceCue(body)
    } catch (err) {
      logger.debug?.(`[dsh-qq] 表情包提示失败（跳过）: ${err?.message ?? err}`)
      return body
    }
  }

  function runTurn({ record, label, peerId, isGroup, client, body, imageParts = [], maxTurnMs }) {
    const message = createUserMessage({
      content: [{ type: 'text', text: body }, ...imageParts],
      source: { kind: 'user' },
    })
    const startedAt = Date.now()

    manager.enqueue(record, async () => {
      let timer = null
      // 一轮的账从这儿开（2026-11-04 晚）：本轮说出去的每个字先记在 `record.replyTurn` 上，
      // 跑完由 endTurnReply 一次性判「这一轮算不算一大段」。
      // 为什么放在 enqueue 回调里而不是外面：排队等着的轮不能共用同一本账。
      try {
        rhythm?.beginTurnReply?.(record)
      } catch (err) {
        logger.debug?.(`[dsh-qq] ${label} 开轮账失败: ${err?.message ?? err}`)
      }
      try {
        // 私聊回一句「正在输入」，让对方知道这边在敲字（群聊没有这个概念，跳过）
        if (!isGroup && client) {
          client
            .call('set_input_status', { user_id: Number(peerId), event_type: 1 }, 5000)
            .catch(() => {})
        }
        record.agent.followup(message)

        const outcome = await Promise.race([
          Promise.resolve(record.agent.whenIdle?.()).then(() => 'idle'),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve('timeout'), maxTurnMs)
          }),
        ]).finally(() => {
          if (timer) clearTimeout(timer)
        })

        if (outcome === 'timeout') {
          // 只放开队列，不打断 Agent —— 它跑完的回复照样会从 outbound 发出去
          const seconds = Math.round((Date.now() - startedAt) / 1000)
          logger.warn(`[dsh-qq] ${label} 本轮已跑 ${seconds}s 仍未结束，先放开队列`)
          // 先把这一轮的字数交掉，再发那句提示 —— 否则下面这句话会被算进"本轮说了多少"，
          // 变成自己给自己加字（虽然只有二三十字，但账要干净）。
          try {
            rhythm?.endTurnReply?.(record)
          } catch {
            /* 交不交得掉都不影响后面发提示 */
          }
          if (typeof send === 'function') {
            await send(
              record,
              `（这轮我还在弄，已经跑了 ${seconds} 秒，你先忙别的，好了我叫你）`,
            ).catch(() => {})
          }
        }
      } catch (err) {
        logger.warn?.(`[dsh-qq] 投递给 ${label} 失败:`, err)
      } finally {
        // 超时也算这一轮结束：字已经发出去了，账得交掉（交完就清空）。
        // 注意 send 失败、抛错、超时这三条路都要走到这儿 —— 不然账会挂着，
        // 下一轮的字数被加进上一轮，惩罚会串。
        try {
          rhythm?.endTurnReply?.(record)
        } catch (err) {
          logger.debug?.(`[dsh-qq] ${label} 交轮账失败: ${err?.message ?? err}`)
        }
      }
    })
  }

  return async function onEvent(event) {
    if (event?.post_type !== 'message') return
    // 补回：这条是「被间隔压住、到点自己醒过来」的重放，不是新消息。
    // 重放要跳过所有前置闸（@/保活/间隔/额度），否则又会被压一轮，永远出不来。
    const isReplay = event?.__replay === true
    // 同一条消息只处理一次。重放是内部自己构造的、message_id 跟原消息一样，
    // 所以必须放行 —— 不然被压住的那句永远补不回来。
    if (!isReplay && alreadySeen(event)) {
      logger.debug?.(`[dsh-qq] 同一条消息重复推送，丢掉（message_id=${event?.message_id}）`)
      return
    }

    // 到点自己醒一次：间隔一过就把压住的那句补回去（否则就是永久沉默）。
    const scheduleGapReplay = (evt, gid, uid) => {
      const key = wakeKey(gid, uid)
      const gap = Number(config.groupReplyGapMs) || 0
      const last = groupLastReplyAt.get(key) ?? 0
      const wait = Math.max(800, gap - (Date.now() - last) + 400)
      const prev = gapReplayTimers.get(key)
      if (prev) clearTimeout(prev)
      const timer = setTimeout(() => {
        gapReplayTimers.delete(key)
        // 这期间要是有新消息把 backlog 取走了，重放自己会 no-op（拿不到正文）。
        Promise.resolve(onEvent({ ...evt, __replay: true })).catch((err) => {
          logger.debug?.(`[dsh-qq] 补回被压住的消息失败: ${err?.message || err}`)
        })
      }, wait)
      timer.unref?.()
      gapReplayTimers.set(key, timer)
    }

    const selfId = String(event.self_id ?? manager.selfId ?? '')
    if (event.self_name) manager.selfName = String(event.self_name)
    if (event.user_id !== undefined && String(event.user_id) === selfId) return

    const isGroup = event.message_type === 'group'
    const scope = isGroup ? 'group' : 'private'
    const peerId = String(isGroup ? event.group_id : event.user_id)
    const sender = event.sender ?? {}
    const senderName = sender.card || sender.nickname || peerId
    const label = isGroup ? `群 ${peerId}` : `私聊 ${senderName}(${peerId})`
    const ownerInfo = { isOwner: ownerIds.has(String(event.user_id ?? '')), ownerLabel }
    // 2026-10-29 姐姐：「有没有办法能做到能私聊，但是能停下」——同类判定不再锁在群里，
    // 私聊也按 peerBots 名单认。于是 botChatEnabled 变成全局总闸：关掉 = 私聊里的同类也不接。
    const peerBot = isPeerBot(config, event.user_id, event)
    if (peerBot) ownerInfo.isBot = true

    const allowed = isGroup ? allowGroup(config, peerId) : allowPrivate(config, peerId)
    const info = readMessage(event.message, { selfId, selfName: event.self_name ?? '机器人' })

    // 合并转发：卡片里的内容真的取出来，摆进正文，别只留一个「[合并转发]」。
    // 取不到就保留占位——至少让人知道这里本来有东西。
    if (info.forwards.length > 0) {
      const expanded = await expandForwards(client, info.forwards, { logger })
      if (expanded) info.text = info.text ? `${info.text}\n${expanded}` : expanded
    }

    // 聊天流水：跳过的消息也先记下来——「它怎么突然接不上话」全靠这段回查。
    // 只落盘、不参与投递，写失败也不影响聊天。
    // 白名单外的落到 `聊天记录/_未开通/`（2026-10-26 姐姐定的）：留痕，不投递。
    if (config.chatLog !== false) {
      const logDir = resolvePeerWorkspace(config, scope, peerId)
      const who = `${senderName}(${event.user_id})`
      appendChatLog(
        logDir,
        { who, text: info.text || '[图片]', msgId: event.message_id },
        logger,
        allowed ? undefined : join(CHATLOG_DIR, UNAUTHORIZED_LOG_DIR),
      ).catch(() => {})
    }

    if (!allowed) {
      logger.debug?.(`[dsh-qq] 忽略未授权 ${label}`)
      return
    }

    // 纯图 / 纯语音 / 纯文件 / 纯表情包（没有文字）也要处理
    if (
      !info.text &&
      info.images.length === 0 &&
      info.records.length === 0 &&
      info.files.length === 0 &&
      info.mfaces.length === 0
    ) {
      return
    }

    const senderId = String(event.user_id ?? '')

    // 2026-11-01：原来这里记「这个人上一条消息的时间」，用来做「停太久就关窗」。
    // 现在窗口是固定时长、由定时器收尾，这个统计没用了，连同 groupWakeIdleMs 一起撤了。

    // ── 引用：先查一次「这句在接谁的话」。
    // 一次 get_msg 同时干两件事：判断这条是不是在跟我说话（下面），以及给正文加引用提示（再下面）。
    // 只有真带引用才发请求，群里引用不常见，不会拖慢平时。
    let quoteInfo = null
    if (info.replyId && client) {
      try {
        const quoted = await client.call('get_msg', { message_id: Number(info.replyId) }, 8000)
        const quotedUserId = String(quoted?.sender?.user_id ?? '')
        const quotedName =
          quoted?.sender?.card || quoted?.sender?.nickname || quotedUserId || '某人'
        const quotedInfo = readMessage(quoted?.message, {
          selfId,
          selfName: event.self_name ?? '机器人',
        })
        quoteInfo = {
          userId: quotedUserId,
          name: quotedName,
          text: (quotedInfo.text || '[非文字内容]').replace(/\s+/g, ' ').slice(0, 80),
          ok: true,
        }
      } catch (err) {
        logger.debug?.(`[dsh-qq] 取引用原文失败: ${err?.message || err}`)
        // 取不到就当没有引用：不知道该接谁的话，宁可不接，也别猜。
        quoteInfo = { userId: '', name: '', text: '', ok: false }
      }
    }
    // 引用的是我自己 → 等于在叫我（qq-bridge 的 quoteTargetIsSelf）
    const quotedMe = Boolean(quoteInfo?.ok && quoteInfo.userId && quoteInfo.userId === selfId)

    // 补回时：这一句自己还躺在 backlog 里，先摘掉，免得同一句在上下文里出现两次。
    // 按「结尾正文」匹配，不按整行 —— 行首带秒级时间戳，重放时早就对不上了。
    if (isReplay) {
      const myText = `] ${info.text || '[图片]'}`
      const arr = drainBacklog(peerId)
      const idx = arr.findLastIndex((line) => line.endsWith(myText))
      if (idx >= 0) arr.splice(idx, 1)
      for (const line of arr) keepBacklog(peerId, line)
    }

    // 同类机器人（群里另一个机器人）：开关关着就完全不接，连 @ 也不接。
    // 用户 2026-10-24：「吵架功能单独做个开关，这个开关控制它要不要和同类聊天，以及对比较冲的同类回怼」。
    // 关着的时候它说什么都跟我们无关 —— 同类之间的帐先不算。
    if (peerBot && !config.botChatEnabled) {
      logger.debug?.(`[dsh-qq] ${label} 是同类机器人发言，「和同类聊天」没开，跳过`)
      // 不接它的话，但它说了什么得留下 —— 下次真接的时候，得知道它刚讲过什么。
      keepBacklog(peerId, historyLine(sender, info.text || '[图片]', ownerInfo), config.historyLimit)
      return
    }

    // 同类机器人连着聊：到上限就散场（2026-10-29 姐姐定：「能私聊，但要能停」）。
    // 为什么要这一层：私聊里两只鲸鲸互相回话没有天然终点——A 回 B，B 又回 A，
    // 每轮都算「有人跟我说话」，出站限流只能把它压慢。真人一开口就清零（下面的 else），
    // 所以有人在场时不受这个上限管，只有它们自己转圈时才刹车。
    if (peerBot) {
      // 冷启动补历史（isReplay）不算连聊：那不是它们在聊，是我们在补记录，
      // 记进轮次会把「补三条」误算成「连聊三轮」，第 5 条就被拦掉。
      const maxTurns = isReplay ? 0 : Number(config.peerChatMaxTurns) || 0
      if (maxTurns > 0) {
        const now = Date.now()
        const prev = peerChatTurns.get(peerId)
        const count = prev && now - prev.at < PEER_CHAT_TURN_WINDOW_MS ? prev.count + 1 : 1
        peerChatTurns.set(peerId, { count, at: now })
        if (count > maxTurns) {
          logger.info(`[dsh-qq] ${label} 同类连聊到第 ${count} 轮（上限 ${maxTurns}），先不接`)
          keepBacklog(peerId, historyLine(sender, info.text || '[图片]', ownerInfo), config.historyLimit)
          return
        }
      }
    } else {
      // 真人开口 = 有人在场了，自动对话的额度全部重置。
      peerChatTurns.clear()
    }

    // ── 图片：先落地（必须排在节奏闸门前面）──
    // 2026-11-01 的教训：闸门要把图片路径一起攒进缓冲，不然冷窗里攒的图
    // flush 时只剩一行 `[图片]`，图一张都到不了它眼前。
    // 但只有**带图的消息**才提前 obtain —— obtain 会真的建 agent + 会话日志，
    // 不能为了这个让群里每条闲聊都给那个群开一个会话。
    let record = null
    let imagePaths = []
    if (info.images.length > 0 && !isReplay) {
      try {
        record = await manager.obtain({ scope, peerId, label })
        wake?.noteInbound?.(record)
      } catch (err) {
        logger.warn?.(`[dsh-qq] 提前取会话失败，图先落公共缓存: ${err?.message ?? err}`)
      }
      const dir = record?.dir ? join(record.dir, '图片缓存') : baseCacheDir
      await mkdir(dir, { recursive: true }).catch(() => {})
      imagePaths = (
        await Promise.all(
          info.images
            .slice(0, Math.max(1, Number(config.maxImagesPerTurn) || 8))
            .map((u) => downloadImage(u, dir, maxMB)),
        )
      ).filter(Boolean)
      if (imagePaths.length > 0) pruneCache(dir)
      else logger.warn?.(`[dsh-qq] 图片下载失败（${info.images.length} 张）`)
    }

    // ── 群聊节奏：热窗 / 冷窗 / 无视冷窗（2026-11-01 姐姐定的）──
    // 站在这儿而不是更后面，是因为冷窗要攒的是**所有**群消息 —— 包括没叫我的那些。
    // 可 requireMention 会把没叫我的当场 return 掉，所以这一道必须抢在它前面。
    // 命中 hold / drop 就一条消息都不投给 Agent：省下的正是那一轮的 system prompt + 历史。
    let rhythmFlush = null
    let rhythmFlushImages = []
    // 刚跨过愤怒阈值那一下，gate 会把「这一轮必须表态」的提示词塞在返回值里。
    // 以前这里压根没接 —— 生成了没人用，等于白算一次。
    let rhythmVerdict = null
    if (rhythm?.gate && !isReplay) {
      const verdict = rhythm.gate({
        scope,
        peerId,
        label,
        text: info.text || '[图片]',
        senderId,
        name: senderName,
        atMe: Boolean(info.atMe) || quotedMe,
        // 图片路径也交给节奏层：冷窗攒着的时候得把图一起存下来，
        // 不然 flush 只还回来一行 `[图片]`，图永远到不了它眼前。
        images: imagePaths,
      })
      rhythmVerdict = verdict
      if (verdict?.action === 'drop') {
        // 无视冷窗期间的消息**直接丢**：连 backlog 都不留 —— 它的定义就是"当它们不存在"，
        // 结束时 rhythm 会挑最后几条给它，不需要这里再备份一份（备份了下一轮又会重复喂一遍）。
        logger.debug?.(`[dsh-qq] ${label} 节奏丢弃（${verdict.reason}），不投递`)
        return
      }
      if (verdict?.action === 'hold') {
        // 冷窗攒着的那批在 rhythm 自己的缓冲里，到期由它一次性交出去。
        // 这里再 keepBacklog 一份的话，flush 之后下一轮 runTurn 会把同样的话再喂一遍。
        logger.debug?.(`[dsh-qq] ${label} 冷窗攒着，不投递`)
        return
      }
      if (Array.isArray(verdict?.flush) && verdict.flush.length > 0) {
        rhythmFlush = verdict.flush
        rhythmFlushImages = Array.isArray(verdict.flushImages) ? verdict.flushImages : []
      }
    }

    // 群聊：默认要 @ 才理；@ 过一次之后有一小段「保活期」，不用再 @
    // addressedBy：没 @ 但被「叫名字 / 点名提问 / 关键词」叫住的理由（2026-10-25）。
    // 这种算「有人冲它来了」，必须回，不给 [SILENT] 出口。
    let addressedBy = null
    // 这个群自己的那份配置（全局 + groupOverrides 合并）。
    // 2026-11-02：设置页能按群单独调脾气，下面凡是行为类的读取都走它。
    // 没配过的群拿到的是全局对象本身，没有额外开销。
    const gcfg = cfgFor?.(peerId) ?? config

    if (isGroup && needMention(gcfg, peerId) && !info.atMe && !isReplay) {
      // 没 @ 我、却 @ 了别人（包括群里另一个机器人）：那明显不是跟我说话，
      // 保活期也不算 —— 否则别人一句「@ 那个谁 来帮我测一下」它也会冲上去接。
      if (info.atNames.length > 0) {
        logger.debug?.(`[dsh-qq] 群 ${peerId} @ 的是别人，跳过`)
        keepBacklog(peerId, historyLine(sender, info.text || '[图片]', ownerInfo), config.historyLimit)
        return
      }

      // ── 非 @ 叫醒（学 qq-bridge 的 evaluateWakeTriggerV2）──
      // 「@」只是叫人的一种方式：群里叫名字、点名问它、催一句「在不在」，
      // 都是在叫它，不该因为少个 @ 就装没听见。
      // 只拿本条消息自己的文字判，不拿带引用原文的拼接文本 —— 否则引用一条
      // 恰好提到昵称的旧消息，也会被当成在叫它。
      addressedBy = evaluateWakeTrigger({
        plainText: info.text || '',
        atMe: info.atMe,
        quotedMe,
        names: [manager.selfName, event?.self_name, ...(config.groupWakeNames ?? [])].filter(Boolean),
        triggers: {
          nameMention: config.groupWakeNameMention,
          question: config.groupWakeQuestion,
          keywords: config.groupWakeKeywords,
        },
      })
      if (addressedBy) {
        logger.debug?.(`[dsh-qq] 群 ${peerId} 没 @ 但命中 ${addressedBy}，按叫我处理`)
      }

      // 保活窗口只认「当初 @ 我的那个人」：别人说话既不能续期、也不能蹭用。
      // 2026-10-24 取消了「主人永久免 @」—— 试完反馈「只回我确实看着怪」：
      // 群友要 @ 才理，主人却随时都接，一是不公平，二是「唤醒一次后超时也没停」。
      // 2026-11-01 去掉了「停太久当场关窗」那套（groupWakeIdleMs）：
      // 窗口现在是**固定时长**，到点由定时器收尾，中途停不停都一样。
      if (!quotedMe && !addressedBy && !wakeAlive(peerId, senderId)) {
        // 概率唤醒：没人叫它，但有很小概率顺带看一眼。
        // 这种「路过」不强制回 —— 下面 mustReply 会是 false，自动带上 [SILENT] 出口。
        if (rollWakeProbability(config.groupWakeProbability)) {
          logger.debug?.(
            `[dsh-qq] 群 ${peerId} 概率唤醒（${config.groupWakeProbability}），顺带看一眼`,
          )
        } else {
          logger.debug?.(`[dsh-qq] 群 ${peerId} 未 @ 且不在对话窗口里，跳过`)
          // 这句没叫我们，但它是上下文的一部分：下一句很可能就在接它。
          keepBacklog(peerId, historyLine(sender, info.text || '[图片]', ownerInfo), config.historyLimit)
          return
        }
      }
      if (quotedMe) logger.debug?.(`[dsh-qq] 群 ${peerId} 引用了我，按叫我处理`)
    }
    // 只有**真被叫了**才重新计时（@ / 引用 / 点名）。
    // 续不续期看 groupWakeRenew（两段开关，2026-11-02）：
    //   开（默认）= @ 刷新计时窗口，每次 @ 都重新给一整段；
    //   关       = 第一次 @ 开始计时，窗口期间的 @ 不产生新计时，到点就收尾。
    // wakeOpened 只在新窗口真的开出来的那一刻为 true —— 下面靠它补"附近的消息"。
    let wakeOpened = false
    if (isGroup && (info.atMe || quotedMe || addressedBy)) {
      wakeOpened = refreshWake(gcfg, peerId, senderId) === true
    }

    // 均匀回应：距上次回复太近就先攒着（消息进 backlog，下次一起看见），别连珠炮。
    // 但「攒着」得有兜底：间隔一过就自己醒一次，不然这句就永远躺在 backlog 里。
    // ⭐ 2026-11-01 晚上改：热窗里**不再用这道闸**。
    //    姐姐的原话：「热窗回复后就会刷新时间，实际上热窗内只会生效一次回复，把它取消掉」。
    //    取而代之的是下面那个随烦躁度变长的合并窗口 —— 它才是"多久才回一次"的唯一开关。
    //    两道闸叠在一起只会互相打架：gap 用 20 秒挡着，窗口调多短都没意义。
    const skipGap = rhythm?.inHot?.(scope, peerId) === true
    if (isGroup && !isReplay && !skipGap && !gapReady(config, peerId, senderId)) {
      logger.debug?.(
        `[dsh-qq] 群 ${peerId} 距上次回复不到 ${Number(config.groupReplyGapMs) || 0}ms，先攒着（到点补回）`,
      )
      // pending：这条是该回的，只是被间隔压住了 —— 热窗收尾要把它交出去
      keepBacklog(peerId, historyLine(sender, info.text || '[图片]', ownerInfo), config.historyLimit, {
        pending: true,
      })
      scheduleGapReplay(event, peerId, senderId)
      return
    }

    // 窗口内回复额度（可选，默认 0 = 不限；和「续期」一起用要注意，别设太小）
    if (isGroup && !isReplay && repliesLeft(config, peerId, senderId) <= 0) {
      logger.debug?.(
        `[dsh-qq] 群 ${peerId} 这个保活窗口已经回过 ${config.groupRepliesPerWindow} 次，先歇着`,
      )
      // pending：额度用完了，但这条是该回的 —— 留到热窗收尾或下个窗口
      keepBacklog(peerId, historyLine(sender, info.text || '[图片]', ownerInfo), config.historyLimit, {
        pending: true,
      })
      return
    }

    // 带图的消息在上面的闸门之前已经 obtain 过了（图要落到会话目录里）；
    // 没图的在这儿补一次 —— 不能为了图片那条路给每条闲聊都白建会话。
    if (!record) {
      record = await manager.obtain({ scope, peerId, label })
      // 有人说话了：冷场计时要清零，主动说话那层也知道「这会儿不缺人」
      wake?.noteInbound?.(record)
    }
    // 这个会话自己的缓存目录（隔离模式下一会话一目录；关掉隔离就共用 baseCacheDir）
    const cacheDir = record.dir ? join(record.dir, '图片缓存') : baseCacheDir

    // ── 先看这句是不是在回答一条待审批的请求；是的话就吃掉，不投给 Agent ──
    const rawText = (info.text || '').trim()
    if (rawText && approval?.tryResolve?.(record, rawText)) {
      logger.info?.(`[dsh-qq] 已消化审批回复 ${label}`)
      return
    }

    // ── 再看是不是在回答一条待答的问题 ──
    if (rawText && questions?.tryResolve?.(record, rawText)) {
      logger.info?.(`[dsh-qq] 已消化问答回复 ${label}`)
      return
    }

    // ── 斜杠命令不打搅 Agent（全角斜杠「／」、前后空格都认）──
    // 2026-11-02 加 RSA 通道：开了之后明文命令一律不执行、不投递、不回话。
    //   - 明文 /reset：直接丢掉（丢给模型它会开始解释"我不能帮你 reset"，等于把闸口告诉别人）
    //   - 密文解不开：也是静默丢掉，别给探测反馈
    //   - 密文解开：当成正常命令走下面那套
    let cmd = rawText.toLowerCase().replace(/[／]/g, '/').trim()
    if (gcfg?.rsaEnabled) {
      const token = parseEncrypted(rawText)
      if (!token) {
        if (/^[#/／]/.test(rawText.trim())) {
          logger.debug?.(`[dsh-qq] ${label} 明文命令被 RSA 通道挡下：${cmd.slice(0, 40)}`)
          return
        }
      } else {
        const plain = decryptCommand(rsaDir, peerId, token)
        if (!plain) {
          logger.debug?.(`[dsh-qq] ${label} 密文命令解不开，静默忽略`)
          return
        }
        cmd = plain.toLowerCase().replace(/[／]/g, '/').trim()
        logger.info?.(`[dsh-qq] ${label} RSA 命令解开：${cmd.slice(0, 40)}`)
      }
    }
    if (cmd === '/reset' || cmd === '#reset' || cmd === '/new' || cmd === '#new') {
      // ⭐ 2026-10-25 P2：/reset 也带上交接，别让「重新来过」真把刚才聊的忘干净。
      const handoff = loadHandoffFor(record)
      const seed = handoff
        ? ['[这是你刚才自己留的便签（不是姐姐说的话）——接着聊就行，不用从头解释]', handoff]
        : null
      const ok = manager.reset(record, seed)
      logger.info?.(`[dsh-qq] 收到 /reset（${label}），reset=${ok}，交接=${handoff ? '有' : '无'}`)
      await send(record, handoff ? '好，刚才聊到哪我记下了。重新来过吧。' : '好，之前聊的我不记得了。重新来过吧。')
      return
    }
    if (cmd === '/status' || cmd === '#status') {
      await send(
        record,
        [
          `会话：${record.label}`,
          `id：${record.sessionId}`,
          `待带缓冲：${record.history?.length ?? 0} 条`,
          `我这边：${record.busy > 0 ? '还在忙' : '空闲'}`,
        ].join('\n'),
      )
      return
    }
    if (cmd === '/cwd' || cmd === '#cwd') {
      await send(
        record,
        [`id：${record.sessionId}`, `目录：${record.dir || '(未隔离，仍用公共 cwd)'}`, `待带缓冲：${record.history?.length ?? 0} 条`].join(
          '\n',
        ),
      )
      return
    }
    if (cmd === '/help' || cmd === '#help') {
      await send(
        record,
        [
          '能用的命令：',
          ...COMMAND_HELP.map((item) => `${item.cmd} — ${item.desc}`),
          ...(gcfg?.rsaEnabled ? ['', `（这个群开了 RSA：明文不认，要发 ${ENC_PREFIX}<base64>）`] : []),
        ].join('\n'),
      )
      return
    }

    // 给互动工具留线索：戳谁、给哪条消息贴表情、撤回哪条
    record.lastSenderId = Number(event.user_id) || record.lastSenderId || null
    record.lastSenderName = senderName
    record.lastMessageId = Number(event.message_id) || record.lastMessageId || null
    record.lastMessageAt = Date.now()
    if (record.lastSenderName) record.label = label

    // 图片已经在节奏闸门之前下好并落到 imagePaths 了（那里才拿得到路径给缓冲用），
    // 这里不再重复下载 —— 重复下会白跑一遍网络和写盘。

    // ── 文件：下载到本地，把路径交给 agent ──
    let filePaths = []
    if (info.files.length > 0) {
      await mkdir(cacheDir, { recursive: true }).catch(() => {})
      for (const f of info.files.slice(0, 3)) {
        const src = f.url || f.file || ''
        if (!src) continue
        const p = await downloadImage(src, cacheDir, 64)
        if (p) filePaths.push({ path: p, name: f.name || p.split(/[\\/]/).pop() })
      }
      if (filePaths.length === 0) logger.warn?.(`[dsh-qq] 文件下载失败（${info.files.length} 个）`)
    }

    // ── 语音：转 wav → 本地 vosk 离线识别 ──
    let voiceTexts = []
    if (info.records.length > 0) {
      if (!config.asrEnabled) {
        voiceTexts.push('[语音]')
      } else {
        for (const rec of info.records.slice(0, 2)) {
          const file = rec.file || rec.path || ''
          if (!file) {
            voiceTexts.push('[语音，但拿不到文件]')
            continue
          }
          try {
            const res = await client.call('get_record', { file, out_format: 'wav' }, 20000)
            let wavPath = ''
            if (res?.file && /^[A-Za-z]:[\\/]/.test(String(res.file))) {
              wavPath = String(res.file)
            } else if (res?.base64) {
              await mkdir(cacheDir, { recursive: true }).catch(() => {})
              wavPath = join(cacheDir, `voice-${Date.now()}.wav`)
              await writeFile(wavPath, Buffer.from(String(res.base64), 'base64'))
            } else if (res?.url) {
              wavPath = (await downloadImage(String(res.url), cacheDir, 32)) || ''
            }
            if (!wavPath) {
              voiceTexts.push('[语音，转码失败]')
              continue
            }
            const text = await runAsr(config, wavPath)
            voiceTexts.push(text ? `[语音转文字] ${text}` : '[语音，没听清]')
          } catch (err) {
            logger.warn?.(`[dsh-qq] 语音识别失败: ${err?.message || err}`)
            voiceTexts.push('[语音，识别失败]')
          }
        }
      }
    }

    // ── 引用提示：让 agent 知道这句话在接谁的话（被引用的原文上面已经查过了，这里不再请求）──
    let quoteLine = ''
    if (info.replyId && config.quoteReply && client) {
      if (!quoteInfo || !quoteInfo.ok) {
        quoteLine = '[引用了一条消息，但没查到原文]'
      } else if (quoteInfo.userId === selfId) {
        quoteLine = `[引用 我自己：${quoteInfo.text}]`
      } else {
        quoteLine = `[引用 ${quoteInfo.name} (${quoteInfo.userId})：${quoteInfo.text}]`
      }
    }

    // ── 上下文压力太大就先换新会话：把最近聊天记进记忆区，新会话带 seed 接话 ──
    if (contextGuard) {
      const seed = await contextGuard.maybeSwap(record)
      if (seed) {
        const prev = record
        record = await manager.obtain({ scope, peerId, label })
        wake?.forget?.(prev)
        wake?.noteInbound?.(record)
        record.swapSeed = seed.length > 0 ? seed : null
        // 工具靠这些字段认「给谁回、撤回哪条」，换会话不能丢
        record.lastSenderId = prev.lastSenderId ?? null
        record.lastSenderName = prev.lastSenderName ?? null
        record.lastMessageId = prev.lastMessageId ?? null
        record.lastMessageAt = prev.lastMessageAt ?? null
      }
    }

    // ── 组装交给 agent 的那段文字 ──
    const parts = []
    // 当前时间：每条消息都带在最前面，跟着正文走 —— 会话压缩、历史被裁掉，这行也不会丢
    parts.push(`[现在是 ${humanTime()}]`)
    if (quoteLine) {
      parts.push(quoteLine, QUOTE_DIRECTION_HINT)
    }
    let head = info.text || ''
    if (isGroup) head = historyLine(sender, info.text || '[图片]', ownerInfo)
    else if (ownerInfo.isOwner && head) head = `[${ownerLabel}] ${head}`
    if (head) parts.push(head)

    // 群聊里没被 @、也不是引用着我的：给一个「可以不接」的出口。
    // 私聊、被 @、被引用回复这三种情况必须回，就不给出口 —— 该说话的时候别装死。
    // 2026-10-25 补：被叫名字 / 点名提问 / 关键词叫住的（addressedBy）也算被点名，同样必须回；
    // 只有「概率唤醒」那种路过看一眼的，才留 [SILENT] 出口。
    // 2026-10-27 姐姐定：群里「主动 @ 一直不开」——`addressedMaySilent` 打开后，
    // 被叫照样叫得醒（消息进上下文、能看能开口），但不再非答不可，回不回它自己定。
    // 规则本体在 mustReplyFor()，这里只负责把当前这一条的实况递进去。
    const mustReply = mustReplyFor({
      isGroup,
      atMe: info.atMe,
      quotedMe,
      isReplay,
      addressedBy,
      addressedMaySilent: config.addressedMaySilent,
    })
    if (!mustReply) parts.push(SILENT_HINT)

    // 图先转成消息内容（走 attachments），再决定跟模型怎么说 ——
    // 转成功了就说「图在消息里」，转不成功才退回「给你路径，自己想办法」。
    // ⚠️ 2026-11-01：冷窗/无视放行时带回来的那批图也要一起塞进来。
    //   以前只带当前这一条的 imagePaths，攒在缓冲里的图全丢 ——
    //   姐姐说的「连发几张图只有一条被看见」就是这个。
    const allImagePaths = rhythmFlushImages.length > 0 ? [...rhythmFlushImages, ...imagePaths] : imagePaths
    const imageParts = allImagePaths.length > 0 ? await buildImageParts(allImagePaths) : []
    if (imageParts.length > 0) {
      parts.push(
        `[一共有 ${imageParts.length} 张图片，图已经随这条消息一起给你了，直接看。]`,
        ...allImagePaths.map((p) => `  （原图：${p}）`),
        IMAGE_RULES,
      )
    } else if (allImagePaths.length > 0) {
      parts.push(
        `[一共有 ${allImagePaths.length} 张图片，已存到本机，可以直接用 read_image 打开：]`,
        ...allImagePaths.map((p) => `  ${p}`),
        IMAGE_RULES,
      )
    } else if (info.images.length > 0) {
      parts.push('[用户发了图片，但没能下载下来]')
    }
    if (imageParts.length > 0) {
      const hint = faceCollectRule(config)
      if (hint) parts.push(hint)
    }

    if (voiceTexts.length > 0) parts.push(...voiceTexts)

    if (info.mfaces.length > 0) {
      // 顺手把表情包的身份证存进收藏夹，以后 qq_mface 就能拿来用
      const added = rememberFaces(config, info.mfaces)
      const total = facesCount(config)
      parts.push(
        '[对方发来表情包。表情包是说话的语气，不是让你鉴赏的画面——顺着这个情绪接话就好，不要描述图里画了什么，也不要问"这是谁"。]',
      )
      if (added > 0) parts.push(`[已顺手收进表情包收藏，现在一共 ${total} 个；想发就用 qq_mface，不填 id 会从收藏里随机挑一个。]`)
    }

    if (filePaths.length > 0) {
      parts.push(
        `[用户发了 ${filePaths.length} 个文件，已存到本机：]`,
        ...filePaths.map((f) => `  ${f.name} -> ${f.path}`),
      )
    }

    // ── 群里你不在的时候说了什么（消费型缓冲，2026-11-01 改）──
    // 以前是「固定取最近 N 条」：每个回合都把同样那 N 条重新塞一遍，
    // 哪怕它上一轮刚看过、刚回过。现在改成缓冲 —— 收到就塞，
    // **发一轮就全取走并清空**，溢出容量的丢最老的。
    // 于是"已经回过的"不会再来，"太老的"自己掉出去，token 只花在真没见过的话上。
    if (isGroup) {
      // 之前跳过的群消息（没 @ 我 / 保活窗外的）在这时候一并交出去，交完就空
      const backlogLines = drainBacklog(peerId)
      // 刚被 @ 醒的那一下，backlog 里常常是空的 —— 窗口开着的时候别人说话是直接
      // 投递进来的，根本进不了 backlog。这时候往 QQ 要几条最近的消息垫在下面，
      // 免得第一句就接不上话（groupWakeHistoryCount，默认 10 条）。
      if (wakeOpened) {
        const want = Math.max(0, Math.min(50, Number(gcfg.groupWakeHistoryCount) || 0))
        const need = want - backlogLines.length
        if (need > 0) {
          const older = await fetchWakeContext(client, peerId, need, {
            logger,
            dir: record.dir,
            // 自己的话不算"附近在聊的"；已投递过的（早于水位 / 早于 lookback）也不再端第二遍。
            selfId: manager.selfId || config.selfId || '',
            since: Number(record.lastDeliverAt) || 0,
            lookbackMs: Number(gcfg.groupWakeHistoryLookbackMs) || 0,
          })
          if (older.length > 0) {
            logger.debug?.(`[dsh-qq] 群 ${peerId} 首次唤醒，补了 ${older.length} 条附近的消息`)
          }
          for (const line of older) pushHistory(record, line, config.historyLimit)
        }
      }
      for (const line of backlogLines) pushHistory(record, line, config.historyLimit)
    }
    if (isGroup && Array.isArray(record.history) && record.history.length > 0) {
      const pending = compactLines(takeHistory(record)) // 取走 = 消费掉；连续相同的压成 ×N
      parts.unshift(
        '[你不在的时候群里说的——看完就过去了，不用逐条回]',
        ...pending,
        '[以上就是你还没看到的]',
      )
    }

    // 聊天规矩（内置中性版 + 可选 persona + directPrompt/groupPrompt）只在本会话第一次投递时
    // 注入一次，别每条都重复占 token；会话被回收或 /reset 后会重新注入一遍。
    // 2026-11-02：规矩已经挂进系统提示词了（manager.chatRulesInSystem），
    // 这条老路只在挂不上时兜底 —— 宿主太老、没有 systemPrompt.section 那种情况。
    if (!record.chatPromptInjected && !manager?.chatRulesInSystem) {
      // 话头：它自己钉住的、还没接上的。**不每轮硬塞** —— 老三自己说的：「每轮开头硬塞五条，
      // 聊得正顺的时候反倒碍眼；真到换地方的时候，开头给一次就够。」平时想翻用 qq_pin list。
      const pinLines = pin?.view?.(record) ?? []
      if (pinLines.length > 0) parts.unshift(...pinLines, '')
      const chatPrompt = buildChatPrompt(config, {
        isGroup,
        isOwner: ownerInfo.isOwner,
        // 只给「有没有图」：数量/名单不进提示词（2026-11-03 姐姐要求）
      faces: { has: facesCount(config) > 0 },
        facts: loadFactsFor(record),
        factsFile: factsFileFor(record),
        // 群词典：这个群自己的黑话。私聊传空串，别把某个群的词带进私聊。
        glossary: isGroup ? loadGlossaryFor(record) : '',
        glossaryFile: glossaryFileFor(record),
        // 纸条：私聊时告诉她「别的群今天的尾巴」——最后谁说了话、有没有人点她名没应。
        //    群聊不传——她在那个群里，用不着有人替她讲。正文字一个字都不给。
        groupDigest: isGroup
          ? ''
          : loadGroupDigest({
              workspaceRoot:
                String(config.workspaceRoot ?? '').trim() ||
                join(String(config.cwd ?? '').trim() || process.cwd(), '会话'),
              today: localDay(),
              // 判断「哪条不是她发的」「有没有人 @ 她」，都要她自己的号
              selfId: String(config.selfId ?? '').trim(),
            }),
      })
      if (chatPrompt) parts.unshift(chatPrompt, '')
      // 主动换过会话：把上一段聊天的尾巴放最前面，让它知道刚聊到哪
      if (Array.isArray(record.swapSeed) && record.swapSeed.length > 0) {
        parts.unshift(
          '[你刚才自己留的便签 / 最近几句话——还是你，换了个地方接着聊，不是死了，是换个海洋接着游，不用从头解释]',
          ...record.swapSeed,
          '[刚才那段聊到这里]',
          '',
        )
      }
      record.swapSeed = null
      // ⭐ 2026-10-26 姐姐说「不能每次都发那么长一截」：标记也记到盘上。
      // 宿主重启 / 闲置回收后 record 重建，靠 manager 的账本记住「这个会话注过了」。
      if (typeof manager?.markChatPromptInjected === 'function') manager.markChatPromptInjected(record)
      else record.chatPromptInjected = true
      // 2026-11-02：记一笔注入量。姐姐在 DSH 里看到"一大段规矩"时会怀疑是不是出错了，
      // 有这行就能对上：那一段是**故意**塞进第一条消息里的，每个会话只塞一次。
      if (chatPrompt) {
        logger.info?.(
          `[dsh-qq] ${label} 注入聊天规矩 ${String(chatPrompt).length} 字（这个会话第一次投递，之后不再重复）`,
        )
      }
    }

    // 错过睡前提醒的补刀：会话是有人说话才建的，23:30 那一刻内存里可能一个会话都没有，
    // tick 的提醒就白丢了。等真的有人说话时补一句，塞进这一轮的提示词里，不多开一轮。
    const lateBed = sleep?.takeLateBedtime?.(record)
    if (lateBed) parts.unshift(lateBed, '')

    // 通道回执：桥断过 / 上一句话没送出去，得让她知道。
    // 放在最前面 —— 不然她会把「没收到回应」读成对方的态度。
    const bridgeLines = bridge?.take?.(record) ?? []
    if (bridgeLines.length > 0) parts.unshift(...bridgeLines, '')

    // 门口：大姐鲸鲸捎的话。只报「有几封、在哪」，内容她自己 read 才看。
    // 2026-10-26 姐姐定的：不敲门、不占主动额度，只在她本来就要开口的这一轮里多一行。
    const doorNotice = doorLine(config)
    if (doorNotice) parts.unshift(doorNotice, '')

    // 节奏放行时带回来的那批（冷窗被 @ 打断 / 无视冷窗被主人打断）：
    // 放在最前面 —— 它刚"缺席"过一段，不先把这段摆出来，它会接错话。
    if (Array.isArray(rhythmFlush) && rhythmFlush.length > 0) {
      const lines = rhythmFlush.map((m) => {
        const d = new Date(Number(m.at) || Date.now())
        const hh = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
        return `- ${hh} ${m.name || '有人'}：${String(m.text ?? '').slice(0, 120)}`
      })
      parts.unshift(
        '[你刚才不在场，这期间这里有人说过这些——不是让你逐条回，是别接错话]',
        ...lines,
        '',
      )
    }

    // ── 当前烦躁度（2026-11-02，2026-11-03 收窄）──
    // 姐姐 11-03 报：「烦躁度提示每一条消息都会去提示，应该只留截止发给它时的烦躁度」。
    // 原因是这段被拼进了**每一条**投递的正文，而每一条都会变成会话历史里的一条 user 消息
    // —— 聊上十轮，上下文里就躺着十份「烦躁度 38/100」，还都是过期的。
    //
    // 现在常态那行搬到 chat-prompt 的**动态段**（runtime-context，每轮重建、只留最新一份，
    // 不进历史）。这里只保留「刚跨过愤怒阈值」这个**事件**：它必须跟着这一轮走一次，
    // 带进历史也无所谓，因为 angerFired 是边沿触发，不会重复。
    try {
      if (isGroup && rhythmVerdict?.angry && rhythmVerdict.angerLine) {
        parts.push('', rhythmVerdict.angerLine)
      }
    } catch (err) {
      logger.debug?.(`[dsh-qq] 拼愤怒提示失败: ${err?.message ?? err}`)
    }

    // ── 白嫖请求（2026-11-02）──
    // 认出「让他干活的」那句话，按这个群的策略决定伺候不伺候。
    // 放在拼完 parts、投递之前：提示段要压在正文后面，模型最容易注意到的地方。
    try {
      const policy = String(gcfg?.requestPolicy ?? 'allow')
      if (isGroup && policy !== 'allow') {
        const hit = matchRequest(
          info.text || '',
          Array.isArray(gcfg?.requestPatterns) ? gcfg.requestPatterns : [],
          logger,
        )
        if (hit) {
          const behavior = String(gcfg?.ignoreBehaviorMode ?? 'yield') === 'fight' ? 'fight' : 'yield'
          parts.push('', buildRequestPrompt({ policy, text: info.text || '', behavior }))
          logger.info?.(`[dsh-qq] ${label} 白嫖请求命中（${policy} / ${behavior}）：${hit.src}`)
          if (policy === 'punish') {
            // 惩罚：直接重击烦躁度。走 bumpIgnite 而不是等平滑，
            // 一次性的火不该被 0.45 的系数吃掉八成。
            rhythm?.bumpIgnite?.('group', peerId, Number(gcfg?.ignorePunishRise) || 35)
          }
        }
      }
    } catch (err) {
      logger.warn?.(`[dsh-qq] 请求识别失败: ${err?.message ?? err}`)
    }

    // 提示段可能刚被追加进 parts，正文要在最后才拼
    const body = parts.join('\n')

    // 投递水位：记下这一轮把上下文摆到哪儿了。补「附近的消息」时靠它避开
    // 已经给她看过的话 —— 不然同一批内容会被原样再端一遍（2026-11-02 那次）。
    record.lastDeliverAt = Date.now()

    logger.info?.(`[dsh-qq] ← ${label}: ${(info.text || '[图片]').slice(0, 60)}`)

    // ⚠️ 2026-11-01：这条**不再**塞进 record.history。
    //   它就是本轮正文（已经随这条消息给它了），再进缓冲的话下一轮会重复一遍，
    //   而下一轮 agent 自己的会话历史里本来就有 —— 三份重复。
    //   缓冲现在只装"没走正常投递的消息"：被 mention 规则跳过的、被间隔压住的。
    const historyEntry = historyLine(sender, info.text || '[图片]', ownerInfo)
    // 记一笔「这个窗口回过一次」，额度用完就停（见上面 repliesLeft）
    if (isGroup) {
      countReply(peerId, senderId)
      groupLastReplyAt.set(wakeKey(peerId, senderId), Date.now())
    }
    // 私聊也留一份最近聊天：换会话时靠它给新会话接话
    record.recent.push(historyEntry)
    const recentKeep = Math.max(80, (Number(config.contextMemoryKeep) || 30) * 3)
    if (record.recent.length > recentKeep) {
      record.recent.splice(0, record.recent.length - recentKeep)
    }

    const maxTurnMs = Number(config.maxTurnMs) || 600000
    // 「接收后等待」怎么算（2026-11-01 晚上定，姐姐的原话：
    //   「5000 那个间隔也跟烦躁度挂钩，设最低值和最高值，烦躁度越高越等越久，
    //     烦躁到阈值就发完最后一轮直接走掉」）：
    //
    //   烦躁度 0        → groupMergeWindowMs（默认 2.5 秒）—— 对方一句话拆三段，等这么点就回
    //   烦躁度 = 阈值   → groupMergeWindowMaxMs（默认 15 秒）—— 懒得马上接
    //   中间线性过渡。
    //
    // 公式在 rhythm.mergeWindowOf 里：状态页显示的也是它，两边不会分叉。
    // 到阈值那一刻 rhythm 会进无视冷窗并投一轮「骂一句就走」，所以这个最长窗口
    // 基本就是"最后一轮"的等待：等完，说一句，走人。
    // 热窗里也不再额外加一遍 groupReplyGapMs —— 窗口才是唯一的节奏开关。
    let windowMs = Math.max(0, Number(config.mergeWindowMs ?? 5000))
    if (isGroup) {
      windowMs = rhythm?.mergeWindowOf
        ? Number(rhythm.mergeWindowOf(scope, peerId)) || 0
        : Math.max(0, Number(config.groupMergeWindowMs ?? 2500))
    }

    // 作息：休息时段（或在说了晚安之后）收到的私聊先记着，不回 —— 早上一起交出去。
    // 放在合并之前，因为「等待 5 秒」对一条要等到明早的消息没有意义。
    if (sleep?.shouldHold?.(record)) {
      sleep.hold(record, info.text || '[图片]')
      return
    }
    // 说了晚安：这条仍然正常回（得有人应一句），但之后不再回。
    sleep?.noteText?.(record, info.text || '')

    // 连发合并：收下之后等一小会儿，期间再来就并进同一轮；窗口一过整段一次性投递。
    if (windowMs > 0) {
      const key = `${scope}:${peerId}`
      let batch = mergeBatches.get(key)
      if (!batch) {
        batch = { bodies: [], images: [], meta: null, timer: null, firstAt: Date.now(), lastFrom: '' }
        mergeBatches.set(key, batch)
      }
      // 一直有人在说话也别无限等：从这一批的第一条算起，最长 groupMergeMaxMs 就得发。
      const hardMs = Math.max(windowMs, Number(config.groupMergeMaxMs ?? 30000))
      // 2026-11-04：**只有同一个人接着补话才续窗**。
      // 以前每条消息都清掉旧定时器重设，于是群里只要一直有人说话，这一轮就永远
      // 排不到窗口，得顶到 `groupMergeMaxMs`（默认 30 秒）才发出去 ——
      // 姐姐的原话就是「一直顶到我设置的回复上限才回」。
      // 现在：同一个人把一句话拆成三段 → 续窗（还是等等他说完）；
      //       别人插一句 → 只并进这一批，**不动原来的截止时间**。
      const from = String(senderId ?? '')
      const sameSender = batch.bodies.length > 0 && from && from === String(batch.lastFrom ?? '')
      batch.lastFrom = from || batch.lastFrom
      batch.bodies.push(body)
      if (imagePaths.length > 0) batch.images.push(...imagePaths)
      // 用最新的 record（上下文换过会话的话，投给新那个）
      batch.meta = { record, label, peerId, isGroup, client }

      const fire = () => {
        try {
          // 队列里还有活（上一轮还在跑）→ 现在投出去也只是排在后面，屏幕上就是
          // 「接话节奏显示 4 秒，4 秒到了没动静」。
          // 2026-11-03 姐姐报的就是这个：先慢后快那条曲线下烦躁度低 → 窗口短（4 秒），
          // 最容易撞上「上一轮还没跑完」，于是 4 秒变成「4 秒 + 排上一轮」。
          // 改法：窗口到点时若队列忙，把这一批**留着**，每 300ms 再看一眼，
          // 等队列空了立刻投 —— 等待时间因此真的等于窗口 + 一点点。
          const live = batch.meta?.record
          if (live?.busy > 0) {
            const waitedMore = Date.now() - batch.firstAt
            // 兜底：最多再多等一分钟，别因为队列一直忙就把这批话吞了
            if (waitedMore < hardMs + 60_000) {
              if (batch.timer) clearTimeout(batch.timer)
              batch.timer = setTimeout(fire, 300)
              logger.debug?.(`[dsh-qq] ${label} 窗口到了但上一轮还没跑完，先攒着（已等 ${Math.round(waitedMore / 1000)}s）`)
              return
            }
            logger.warn?.(`[dsh-qq] ${label} 队列忙了太久，先把这一批投进去排队`)
          }
          mergeBatches.delete(key)
          if (batch.timer) clearTimeout(batch.timer)
          const count = batch.bodies.length
          const spent = Date.now() - batch.firstAt
          if (count > 1) logger.info?.(`[dsh-qq] ${label} 连发 ${count} 条，合并成一轮回`)
          // 真的等超了（队列忙 / 一直被顶到上限）就留一行，别让人对着"说 4 秒、40 秒才回"猜
          if (spent > windowMs + 1500) {
            logger.info?.(
              `[dsh-qq] ${label} 这一轮实际等了 ${(spent / 1000).toFixed(1)}s（窗口 ${Math.round(windowMs / 1000)}s，硬上限 ${Math.round(hardMs / 1000)}s）`,
            )
          }
          const faceRule = faceCollectRule(config)
          // 规矩合并成一份，别每条念一遍（姐姐：「在最后一行留一个就行」）
          const mergedBody = mergeBodies(batch.bodies, { imageCount: batch.images.length, faceRule })
          const cued = withFaceCue(mergedBody, { peerId: batch.meta?.peerId, isGroup: batch.meta?.isGroup })
          void buildImageParts(batch.images).then((imageParts) =>
            runTurn({ ...batch.meta, body: cued, imageParts, maxTurnMs }),
          )
        } catch (err) {
          // 2026-11-04：以前 fire 里任何一步抛错都是"消息凭空消失"——
          // batch 已经删了、错误进了 unhandled，群里就是没人回。
          logger.warn?.(`[dsh-qq] ${label} 合并投递失败（这一批 ${batch.bodies.length} 条没能发出去）: ${err?.message ?? err}`)
        }
      }

      if (!batch.timer || sameSender) {
        if (batch.timer) clearTimeout(batch.timer)
        const waited = Date.now() - batch.firstAt
        const delay = Math.max(400, Math.min(windowMs, hardMs - waited))
        batch.timer = setTimeout(fire, delay)
        logger.debug?.(
          `[dsh-qq] ${label} 这一轮等 ${delay}ms 再回（烦躁度 ${Math.round(rhythm?.igniteOf?.(scope, peerId) ?? 0)}${sameSender ? '，同一个人补话续窗' : ''}）`,
        )
      } else {
        // 别人插话：并进这一批，但不动截止时间 —— 不然群里一热闹就永远等不到窗口
        logger.debug?.(
          `[dsh-qq] ${label} 别人也说了话，并进这一批但不续窗（还剩 ${Math.max(0, Math.round(hardMs - (Date.now() - batch.firstAt)))}ms 到硬上限）`,
        )
      }
      return
    }

    runTurn({ record, label, peerId, isGroup, client, body: withFaceCue(body, { peerId, isGroup }), imageParts, maxTurnMs })
  }
}
