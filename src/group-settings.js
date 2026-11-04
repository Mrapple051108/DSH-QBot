/**
 * 每群设置：把「全局配置 + 这个群的覆盖」合成一个只读视图。
 *
 * 2026-11-02 姐姐要的：全局设置之外，每个群能单独调脾气。
 * 语义只有一条：**该键在 groupOverrides[群号] 里不存在 = 跟随全局**。
 * 不存 `null` 表示跟随 —— `sanitizeOverrides` 会把 `null` 当"清掉覆盖"直接剔掉，
 * 用"缺键"表达同一个意思更干净，也省得每次判空。
 *
 * 为什么用 Proxy 而不是 `{...config, ...patch}`：
 *   `gate()` 是每条群消息都要跑的热路径，全场摊一次对象太亏。
 *   Proxy 只在真正读某个字段时才会绕一下；而且**没有覆盖的群直接返回原 config**，
 *   零开销 —— 大多数群都是这种。
 */

/**
 * 允许**按群单独配**的白名单。
 *
 * 只放行为类。连接类（wsUrl / selfId / personaFile / workspaceRoot）不放：
 * 那些改了会串味，某一个群的错误配置能把整只鱼搞崩。
 *
 * 这份名单同时是 `sanitizeOverrides` 过滤每群节点的依据 ——
 * 名单外的键写进来会被丢掉，所以加新配置项时记得同步这里。
 */
export const GROUP_OVERRIDABLE = [
  // 触发
  'requireMention',
  'mentionMode',
  'groupWakeMs',
  'groupWakeRenew',
  'groupWakeHistoryCount',
  'groupWakeHistoryLookbackMs',
  'groupWakeFarewell',
  // 节奏（热窗 / 冷窗）
  'rhythmEnabled',
  'rhythmHotMinMs',
  'rhythmHotMaxMs',
  'rhythmColdMinMs',
  'rhythmColdMaxMs',
  'rhythmColdKeep',
  // 烦躁 / 行为
  'ignoreCalmThreshold',
  'ignoreAngerThreshold',
  'ignoreEscapeThreshold',
  'ignoreCurve',
  'ignoreBehaviorMode',
  'ignoreRisePerMsg',
  'ignoreDecayTauMs',
  'ignorePunishRise',
  // 长文本回复惩罚（2026-11-04）
  'longReplyPenalty',
  'longReplyPerTurn',
  'longReplyChars',
  'longReplyBase',
  'longReplyCurve',
  'longReplyGamma',
  'ignoreAuto',
  'ignoreNag',
  // 四段提示词模板（空 = 用内置）
  'angerPromptYield',
  'angerPromptFight',
  'escapePromptYield',
  'escapePromptFight',
  // 问题处理请求
  'requestPolicy',
  'requestPatterns',
  // 表情包（2026-11-03：每轮掷骰子提示发一张）
  'faceCueEnabled',
  'faceCueChance',
  // 表情包发送闸（2026-11-03 23:0x：从提示词搬到工具管道，按群可配）
  'faceSendGapMs',
  'faceSendMaxPerHour',
  // 命令通道
  'rsaEnabled',
]

const GROUP_SET = new Set(GROUP_OVERRIDABLE)

/** 这个键能不能按群配。 */
export function canOverridePerGroup(key) {
  return GROUP_SET.has(String(key ?? ''))
}

/**
 * 建一个「按群取配置」的解析器。
 *
 * @param {object} config 运行中的全局配置（applyOverrides 已经写进去的那个对象）
 */
export function createGroupConfig(config) {
  // peerId -> { patch, proxy }。patch 变了就重建，避免读到旧的。
  const cache = new Map()

  function patchOf(peerId) {
    const all = config?.groupOverrides
    if (!all || typeof all !== 'object') return null
    const p = all[String(peerId ?? '')]
    if (!p || typeof p !== 'object' || Object.keys(p).length === 0) return null
    return p
  }

  return {
    /**
     * 拿某个群的合并视图。
     *
     * 没有覆盖时**返回全局 config 本身** —— 大多数群走这条，调用方拿到的
     * 就是原来那个对象，行为和加这个功能之前一模一样。
     *
     * @param {string|number} peerId 群号（或私聊对象号）
     */
    for(peerId) {
      const patch = patchOf(peerId)
      if (!patch) return config
      const id = String(peerId)
      const hit = cache.get(id)
      if (hit && hit.patch === patch) return hit.proxy
      const proxy = new Proxy(config, {
        get(target, key) {
          if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(patch, key)) {
            return patch[key]
          }
          return target[key]
        },
        has(target, key) {
          if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(patch, key)) return true
          return key in target
        },
      })
      cache.set(id, { patch, proxy })
      return proxy
    },

    /** 这一项是不是还在跟随全局（页面上的勾选框靠它）。 */
    isFollowing(peerId, key) {
      const p = patchOf(peerId)
      if (!p) return true
      return !Object.prototype.hasOwnProperty.call(p, String(key))
    },

    /** 这个群当前有哪些覆盖（给页面回显用）。 */
    overridesOf(peerId) {
      return { ...(patchOf(peerId) ?? {}) }
    },

    /** 有没有任何一个群配过东西（没有的话整条热路径都退回原 config）。 */
    hasAny() {
      const all = config?.groupOverrides
      return Boolean(all && typeof all === 'object' && Object.keys(all).length > 0)
    },

    /** 配置或覆盖被改过之后清缓存（改设置、applyOverrides 之后调一下）。 */
    invalidate() {
      cache.clear()
    },
  }
}

/**
 * 夹一下三阈值：冷静 < 愤怒 < 逃离，而且拉开距离。
 *
 * 用户在页面上可以把三个数字乱填（冷静 80、逃离 80、愤怒 90），
 * 直接拿去比大小会得到"永远处于愤怒"这种鬼状态。这里统一夹成合法区间，
 * 读配置的人不需要各自再判一次。
 *
 * @returns {{calm:number, anger:number, escape:number}}
 */
export function readThresholds(cfg = {}) {
  const num = (v, d) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : d
  }
  const calm = Math.max(1, Math.min(98, num(cfg.ignoreCalmThreshold, 30)))
  const escape = Math.max(calm + 2, Math.min(100, num(cfg.ignoreEscapeThreshold, 70)))
  const rawAnger = num(cfg.ignoreAngerThreshold, Math.round((calm + escape) / 2))
  const anger = Math.min(escape - 1, Math.max(calm + 1, rawAnger))
  return { calm, anger, escape }
}

/**
 * 烦躁度曲线：把原始分（0~100）按性格捏一下再进平滑。
 *
 *   linear     —— 现状，一条直线
 *   fast-slow  —— 先快后慢：一点噪音就上去了，但很难真正顶满
 *   slow-fast  —— 先慢后快：前面忍很久，一旦开始烦就断崖式上升
 */
export function shapeScore(raw, curve = 'linear') {
  const v = Math.max(0, Math.min(100, Number(raw) || 0))
  const x = v / 100
  if (curve === 'fast-slow') return 100 * Math.pow(x, 0.55)
  if (curve === 'slow-fast') return 100 * Math.pow(x, 1.8)
  return v
}

/** 曲线选项（页面下拉用）。 */
export const CURVES = [
  { value: 'linear', label: '线性' },
  { value: 'fast-slow', label: '非线性（先快后慢）' },
  { value: 'slow-fast', label: '非线性（先慢后快）' },
]

/** 行为模式（页面下拉用）。 */
export const BEHAVIORS = [
  { value: 'yield', label: '幸福者退让' },
  { value: 'fight', label: '必须回击！' },
]

/** 请求策略（页面下拉用）。 */
export const REQUEST_POLICIES = [
  { value: 'allow', label: '允许' },
  { value: 'refuse', label: '拒绝' },
  { value: 'punish', label: '惩罚' },
]
