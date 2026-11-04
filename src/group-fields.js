/**
 * 群聊设置页的字段表。
 *
 * 为什么要单独一份元数据、不直接从 Schema 生成：
 *   Schema 里是一堆 `.description()` 的自然语言，长度、单位、范围都得靠猜；
 *   页面要的是「标签 + 控件类型 + 单位 + 步长 + 缩放」。手写一份反而更短更准。
 *
 * `scale` 的意思：页面显示「秒」，存的是毫秒 —— 显示值 = 存值 / scale。
 * 只有时间类字段需要它。
 *
 * ⚠️ 这里出现的 key 必须同时在 `GROUP_OVERRIDABLE` 里（group-settings.js），
 *    否则保存时会被 sanitize 丢掉。下面有一道自检。
 */
import { CURVES, BEHAVIORS, REQUEST_POLICIES, GROUP_OVERRIDABLE } from './group-settings.js'
import { LONG_REPLY_CURVES } from './shared/long-reply.js'

const S = 1000 // 秒 → 毫秒
const M = 60_000 // 分 → 毫秒

export const GROUP_FIELDS = [
  // ── 触发 ──
  // mentionMode 自带「跟随全局」这一档，所以 noFollow：页面上不给它画那个勾选框
  // （否则会出现「跟随全局」勾着、里面又选「跟随全局」的套娃）。
  //
  // 2026-11-03 00:2x 姐姐指出来：「这两个选项它不重复吗」。
  // 确实重复 —— 原来下面还有一行 `requireMention`（布尔「必须 @ 才接话」），
  // 跟这个三态管的是同一件事，而且是**从属关系**：
  //   must  → 必须 @（布尔开不开都轮不到它）
  //   never → 不用 @（同上）
  //   follow→ 才去看全局的 requireMention + 两个群号名单
  // 两行并排放，等于给同一个开关画了两个插头，还互相能打架。
  // 所以删掉布尔那行，**三态是唯一入口**；requireMention 留在全局设置页当总闸。
  // 顺带：GROUP_OVERRIDABLE 里仍留着 'requireMention'，老配置里存过这个键的照样读得出来。
  {
    g: '触发',
    key: 'mentionMode',
    label: '要不要 @ 才接话',
    type: 'select',
    noFollow: true,
    options: [
      { value: 'follow', label: '跟随全局' },
      { value: 'must', label: '必须 @ 才接话' },
      { value: 'never', label: '不用 @ 也接话' },
    ],
    hint: '唯一入口。「跟随全局」= 用全局那个「必须 @」总闸，外加两个群号例外名单',
  },
  { g: '触发', key: 'groupWakeMs', label: '被 @ 后的对话窗口', type: 'number', unit: '秒', scale: S, min: 0, max: 3600, step: 5 },
  { g: '触发', key: 'groupWakeRenew', label: '@ 时刷新计时窗口', type: 'boolean' },
  { g: '触发', key: 'groupWakeHistoryCount', label: '首次 @ 带几条群消息', type: 'number', unit: '条', min: 0, max: 50, step: 1 },
  { g: '触发', key: 'groupWakeHistoryLookbackMs', label: '「附近的消息」最多往回翻', type: 'number', unit: '分钟', scale: M, min: 0, max: 240, step: 1 },
  { g: '触发', key: 'groupWakeFarewell', label: '窗口到点说一句收尾', type: 'boolean' },

  // ── 节奏 ──
  { g: '节奏', key: 'rhythmEnabled', label: '启用冷热窗节奏', type: 'boolean' },
  { g: '节奏', key: 'rhythmHotMinMs', label: '热窗最短', type: 'number', unit: '秒', scale: S, min: 10, max: 600, step: 5 },
  { g: '节奏', key: 'rhythmHotMaxMs', label: '热窗最长', type: 'number', unit: '秒', scale: S, min: 10, max: 900, step: 5 },
  { g: '节奏', key: 'rhythmColdMinMs', label: '冷窗最短', type: 'number', unit: '分钟', scale: M, min: 1, max: 60, step: 1 },
  { g: '节奏', key: 'rhythmColdMaxMs', label: '冷窗最长', type: 'number', unit: '分钟', scale: M, min: 1, max: 120, step: 1 },
  { g: '节奏', key: 'rhythmColdKeep', label: '冷窗结束带回来几条', type: 'number', unit: '条', min: 1, max: 30, step: 1 },

  // ── 烦躁度 ──
  { g: '烦躁度', key: 'ignoreCalmThreshold', label: '冷静阈值', type: 'number', unit: '/100', min: 1, max: 98, step: 1, hint: '掉到这以下才算消气' },
  { g: '烦躁度', key: 'ignoreAngerThreshold', label: '愤怒阈值', type: 'number', unit: '/100', min: 2, max: 99, step: 1, hint: '到了开始摆脸色，只触发一次' },
  { g: '烦躁度', key: 'ignoreEscapeThreshold', label: '逃离阈值', type: 'number', unit: '/100', min: 3, max: 100, step: 1, hint: '超过就进无视冷窗' },
  { g: '烦躁度', key: 'ignoreCurve', label: '烦躁度曲线', type: 'select', options: CURVES },
  { g: '烦躁度', key: 'ignoreBehaviorMode', label: '烦躁行为逻辑', type: 'select', options: BEHAVIORS },
  { g: '烦躁度', key: 'ignoreAuto', label: '允许自动进无视冷窗', type: 'boolean' },
  { g: '烦躁度', key: 'ignoreNag', label: '进无视前骂一句再走', type: 'boolean' },
  { g: '烦躁度', key: 'ignoreRisePerMsg', label: '每条消息拉近多少', type: 'number', unit: '', min: 0.05, max: 1, step: 0.05, hint: '越大越敏感' },
  { g: '烦躁度', key: 'ignoreDecayTauMs', label: '没人说话时衰减', type: 'number', unit: '秒', scale: S, min: 10, max: 600, step: 5, hint: '多久掉到三分之一' },
  { g: '烦躁度', key: 'ignorePunishRise', label: '惩罚一次加多少', type: 'number', unit: '/100', min: 0, max: 100, step: 5 },

  // 长文本回复惩罚（2026-11-04）：前面都在数「别人怎么吵」，这五项数的是自己说太长。
  // 这一组下面接一张小图（rhythm.html 里画），选完参数能立刻看到「连着第几次会顶多少」。
  { g: '烦躁度', key: 'longReplyPenalty', label: '连续长文本回复惩罚', type: 'boolean', hint: '说长话也算账：连着几次超字数就往上顶烦躁度' },
  { g: '烦躁度', key: 'longReplyPerTurn', label: '按一轮累计', type: 'boolean', hint: '一轮里分几次发也先加起来算，一轮最多罚一次；关掉就每次投递单独判' },
  {
    g: '烦躁度',
    key: 'longReplyChars',
    label: '长文本字数判定',
    type: 'number',
    unit: '字',
    min: 20,
    max: 5000,
    step: 20,
    hint: '去空白后超过这么多字算一次长文本；空格和换行不计',
  },
  { g: '烦躁度', key: 'longReplyBase', label: '基础连续长文本惩罚值', type: 'number', unit: '/100', min: 0, max: 60, step: 1, hint: '第 2 次起每一击的基础分' },
  { g: '烦躁度', key: 'longReplyCurve', label: '惩罚方式', type: 'select', options: LONG_REPLY_CURVES, hint: '连续次数越多，每一次加得越多' },
  { g: '烦躁度', key: 'longReplyGamma', label: '增长力度', type: 'number', unit: '', min: 1.05, max: 3, step: 0.05, hint: '只对幂函数 / 指数函数有效' },

  // ── 提示词（留空 = 用内置文案）──
  { g: '提示词', key: 'angerPromptYield', label: '愤怒时（幸福者退让）', type: 'textarea', hint: '留空用内置；{v} 会换成当前烦躁度' },
  { g: '提示词', key: 'angerPromptFight', label: '愤怒时（必须回击）', type: 'textarea', hint: '留空用内置' },
  { g: '提示词', key: 'escapePromptYield', label: '走人前（幸福者退让）', type: 'textarea', hint: '留空用内置' },
  { g: '提示词', key: 'escapePromptFight', label: '走人前（必须回击）', type: 'textarea', hint: '留空用内置' },

  // ── 表情包 ──
  // 2026-11-03 姐姐要的：每来一条消息抽个随机数，命中就提示她发一张。
  // 开关和概率都按群可覆盖；默认跟随全局（全局默认 开 / 25%）。
  { g: '表情包', key: 'faceCueEnabled', label: '每轮掷骰子提示发表情包', type: 'boolean', hint: '命中才提示；提示只是"可以发"，发不发她自己定' },
  { g: '表情包', key: 'faceCueChance', label: '掷中概率', type: 'number', unit: '%', min: 0, max: 100, step: 5, hint: '25 = 四轮里大概一轮；收藏为空或刚发过时这一轮不提示' },
  // 发送闸：在工具里挡，不写进提示词（2026-11-03 23:0x）
  { g: '表情包', key: 'faceSendGapMs', label: '两张之间至少隔', type: 'number', unit: '秒', scale: S, min: 0, max: 3600, step: 5, hint: '0 = 不限制（默认）。给工具挡，不写进提示词' },
  { g: '表情包', key: 'faceSendMaxPerHour', label: '一小时最多几张', type: 'number', unit: '张', min: 0, max: 60, step: 1, hint: '0 = 不限制；按会话分别计数' },

  // ── 白嫖请求 ──
  { g: '白嫖请求', key: 'requestPolicy', label: '别人让你干活时', type: 'select', options: REQUEST_POLICIES, hint: '惩罚 = 拒绝 + 拉烦躁度 + 骂回去' },
  { g: '白嫖请求', key: 'requestPatterns', label: '额外要拒绝的正则', type: 'lines', hint: '一行一条，写错的行会被跳过' },

  // ── 命令 ──
  { g: '命令', key: 'rsaEnabled', label: '允许 RSA 密钥命令', type: 'boolean', hint: '开了之后明文 /reset 之类全部失效' },
]

/**
 * 自检：字段表里的 key 必须都能按群覆盖，否则保存时会被 sanitize 悄悄丢掉，
 * 页面表现为「改了没反应」—— 这种坑查起来最费时间，所以在模块加载时就喊出来。
 */
{
  const allowed = new Set(GROUP_OVERRIDABLE)
  const bad = GROUP_FIELDS.filter((f) => !allowed.has(f.key)).map((f) => f.key)
  if (bad.length > 0) {
    // 不 throw：一个字段写错不该让整个插件起不来
    console.warn(`[dsh-qq] 群聊设置字段里有不能按群覆盖的键：${bad.join(', ')}`)
  }
}

/** 按分组整理好，页面直接遍历。 */
export function groupFieldsBySection() {
  const out = []
  for (const f of GROUP_FIELDS) {
    const last = out[out.length - 1]
    if (last && last.name === f.g) last.fields.push(f)
    else out.push({ name: f.g, fields: [f] })
  }
  return out
}

/** key → 字段（存值时要按 scale 还原）。 */
export const FIELD_BY_KEY = new Map(GROUP_FIELDS.map((f) => [f.key, f]))
