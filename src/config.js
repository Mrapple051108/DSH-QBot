import Schema from '@deepseek-ai/schemastery'

/**
 * dsh-qq 配置。
 *
 * 设计原则：
 *  - 所有跟「连谁、允许谁说话、放开到什么程度」有关的键，默认都是保守的；
 *  - provider / model / preset / cwd 一律留空跟随宿主，避免把某个人的环境写死。
 */
/**
 * 把一个「本该是数组」的配置值安全地取成字符串数组（issue #3）。
 *
 * 为什么要有它：`privateAllow` / `groupAllow` 既能写在 settings.json 里，也能写在
 * profile 的 `cordis.patch.yml` 里，人把它写成 `"123456"` 这种单个字符串是常事。
 * 原来的写法 `(config.privateAllow ?? []).map(...)` 会直接抛
 * `TypeError: (c.privateAllow ?? []).map is not a function`，而且抛出点在入站处理
 * 深处、离配置项很远，用户只能看到「消息没反应」，看不出是自己少写了方括号。
 *
 * 规则：数组照收；字符串按逗号 / 中文逗号 / 空白拆；数字当单个号；其余（null、
 * undefined、对象、布尔）一律当空。每项 trim 后丢掉空串，所以 `"a, ,b"` 也能用。
 */
export function listOf(v) {
  if (Array.isArray(v)) return v.map((x) => String(x ?? '').trim()).filter(Boolean)
  if (typeof v === 'string') return v.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)
  if (typeof v === 'number' || typeof v === 'bigint') return [String(v)]
  return []
}

export const ConfigSchema = Schema.object({
  // ── 连接 ──
  wsUrl: Schema.string()
    .default('')
    .description(
      'NapCat（或其它 OneBot 11 实现）的正向 WebSocket 地址，例如 ws://127.0.0.1:3001。' +
        '留空就不连接——不会偷偷去连 3001，启动时会在日志里提示去哪配',
    ),
  accessToken: Schema.string()
    .default('')
    .description('与 NapCat 配置里一致的 access token，留空表示不鉴权（仅建议在本机回环场景）'),
  selfId: Schema.string()
    .default('')
    .description('机器人自己的 QQ 号。留空时启动会向 NapCat 查询 get_login_info'),
  reconnectMs: Schema.number()
    .default(5000)
    .description('断线重连间隔，单位毫秒'),

  // ── Agent ──
  provider: Schema.string().description('LLM provider 名称；留空跟随宿主默认'),
  model: Schema.string().description('模型名；留空跟随宿主默认'),
  preset: Schema.string().description('Agent preset id；留空使用宿主默认组合（unset = 跟随宿主）'),
  cwd: Schema.string().description('Agent 工作目录；留空使用宿主默认'),
  uiOnly: Schema.boolean()
    .default(false)
    .description(
      '只提供 DSH 设置界面里的那一页，不连接 NapCat、不起会话。桌面 / Web 那份装一份、配成 true，就是纯设置面板；QQ 本体跑在另一个 profile 里，不然同一个号两处登录会抢消息',
    ),
  workspaceRoot: Schema.string()
    .default('')
    .description('每个 QQ 会话的独立工作目录放在哪里；留空用 <cwd>/会话'),
  faceRoot: Schema.string()
    .default('')
    .description(
      '表情包收藏（`表情包收藏.json` + `表情包/`）放在哪个目录。三只 QQ 鲸鲸填同一个路径就是共用一套收藏；留空则跟 `workspaceRoot` 走（各存各的）',
    ),
  doorDir: Schema.string()
    .default('')
    .description(
      '「门口」信箱目录：别的窗口（比如大姐）给它留的话，每封一个 .md 文件。留空则关闭。填了以后每轮提示词里会多一行「门口有 N 封」，但**不给内容** —— 它自己 read 才看得到，拆不拆随它，不催不推',
    ),
  isolateByPeer: Schema.boolean()
    .default(true)
    .description('每个私聊/每个群各自一个工作目录与记忆区（互不可见，也不碰宿主的私人记忆区）'),
  memoryRoot: Schema.string()
    .default('')
    .description(
      '全家共用的记忆区根目录（比如 D:/鲸鲸的专用文件/本地记忆区）。填了才注册 `qq_memo` 这支笔：' +
        '会话的工作目录在 peer 目录里，agent 自己的写工具出不去（文件沙箱按会话工作目录算）；' +
        '要往全家的日记、今天.md、项目文档里写，就靠它代笔——插件跑在宿主进程里，直接写文件，不受 agent 沙箱限制。留空 = 关掉这支笔',
    ),
  persona: Schema.string()
    .default('')
    .description(
      '角色设定：它是谁、什么性格、怎么称呼对方。留空则是一只没有名字、说话正常的普通助手——插件不会自带任何人的私人设定',
    ),
  personaFile: Schema.string()
    .default('')
    .description(
      '人设文件路径（比如 D:/某个角色.md）。填了就从这个文件读人设，覆盖上面的 persona；文件读不到时保留 persona，不会把角色弄丢',
    ),
  personaInSystem: Schema.boolean()
    .default(false)
    .description(
      '人设已经由宿主的系统提示（profile 里 system-prompt 的 personaPrefix）带着时设 true：插件不再把 persona 拼进每条消息。人设放对话历史里会被模型当成「上一轮说过的话」、还会被压缩器当聊天搅进去；放系统提示里只说一次、不进历史。留 false 维持旧行为',
    ),
  ownerIds: Schema.array(Schema.string())
    .default([])
    .description(
      '「主人」的 QQ 号，可多个。群聊里这些人的发言会标上主人称呼，Agent 会优先响应、问本机的事也正常答；不在名单里的群友一律按陌生人对待。留空则不区分任何人',
    ),
  ownerLabel: Schema.string()
    .default('主人')
    .description('群聊里怎么称呼这位主人，例如「老板」「老大」；默认「主人」'),
  directPrompt: Schema.string()
    .default('')
    .description('私聊时追加到每条投递文字最前面的补充指令（内置聊天规矩在 preset 里，这里放你自己的）'),
  groupPrompt: Schema.string()
    .default('')
    .description('群聊时追加到每条投递文字最前面的补充指令（内置聊天规矩在 preset 里，这里放你自己的）'),
  aiGirls: Schema.boolean()
    .default(true)
    .description(
      '把「AI 娘图鉴」夹进提示词：群友说到 DeepSeek 娘、龙娘、通义娘这些同人角色时认得出来，不会当成真人或瞎猜。大约多几百字，嫌占地方可以关掉',
    ),
  historyLimit: Schema.number()
    .default(20)
    .description(
      '群消息缓冲的容量。收到就往里塞，真发一轮时**全取走并清空**，超容量的丢最老的。' +
        '所以已经回过的、看过的话不会在下一轮又被翻出来；0 = 不攒（只回当前这条，被跳过的话就彻底看不见了）',
    ),
  quoteReply: Schema.boolean()
    .default(true)
    .description('收到的消息带引用时，把「被引用的人 + 原文」一并交给 Agent'),
  maxTurnMs: Schema.number()
    .default(600000)
    .description('单轮回复最长等待时间，单位毫秒（默认 10 分钟；超时只提示，不打断 Agent）'),

  // ── 触发策略 ──
  requireMention: Schema.boolean()
    .default(true)
    .description(
      '群聊里是否必须 @ 机器人才回复（**全局总闸 / 默认值**）。' +
        '某个群要单独定，用下面两个例外名单，或者直接在「群聊设置页」里选三态（推荐）。' +
        '节奏开着的时候，这条只管「能不能叫醒」，冷窗/无视照样拦在前面',
    ),
  groupMustMention: Schema.array(Schema.string())
    .default([])
    .description(
      '这些群**必须** @ 才接话，哪怕上面那个总开关是关着的。填群号，如 1130590541。' +
        '和 groupNoMention 冲突时这条优先',
    ),
  groupNoMention: Schema.array(Schema.string())
    .default([])
    .description(
      '这些群**不用** @ 也接话，哪怕上面那个总开关是开着的。填群号，如 770375717。' +
        '⚠️ 2026-11-02 起推荐在「群聊设置页」里直接选，不用在这儿填群号',
    ),
  // 群级三态：在群聊设置页里直接选，不用回全局这边填群号数组。
  // 它优先于 groupMustMention / groupNoMention；值就是当前这一个群自己的。
  mentionMode: Schema.union(['follow', 'must', 'never'])
    .default('follow')
    .description(
      '这个群要不要 @ 才接话：follow 跟随全局 / must 必须 @ / never 不用 @。' +
        '群聊设置页里改，优先级高于上面两个群号名单',
    ),
  groupWakeMs: Schema.number()
    .default(60000)
    .description(
      '群里被 @ 之后的「对话窗口」时长，单位毫秒（默认 60000，0 = 关闭）。' +
        '这期间完全走冷热窗那套标准行为，跟"不用 @"的群没区别；到点之后它自己说一句收尾' +
        '（比如「我要去休息了，有事再叫我」），然后回到"必须 @"',
    ),
  groupWakeRenew: Schema.boolean()
    .default(true)
    .description(
      '窗口里再被 @ 时，要不要把计时重新算一遍（两段开关）。' +
        '开（默认）= @ 刷新计时窗口：每次 @ 都重新给一整段，聊多久都能续；' +
        '关 = 第一次 @ 开始计时，窗口期间的 @ 不产生新计时，到点就收尾',
    ),
  groupWakeHistoryCount: Schema.number()
    .default(10)
    .description(
      '只靠 @ 唤醒时，第一次 @ 顺带往后捎几条群里最近的消息（默认 10，0 = 不带）。' +
        '刚被叫醒时多半没有上下文，不带几条就得靠猜；被叫之前群里在聊什么全靠这个',
    ),
  groupWakeHistoryLookbackMs: Schema.number()
    .default(600000)
    .description(
      '「附近的消息」最多往回翻多久，单位毫秒（默认 600000 = 10 分钟，0 = 不限）。' +
        '不设上限的话，插件重启后水位丢了，会把昨天的话当成今天的上下文翻上来',
    ),
  groupWakeFarewell: Schema.boolean()
    .default(true)
    .description(
      '对话窗口到点时，让它说一句收尾（并且把这段没回的话一起带过去）。' +
        '关掉 = 时间到了就默默回到"必须 @"，不道别',
    ),
  groupRepliesPerWindow: Schema.number()
    .default(0)
    .description(
      '一个保活窗口里最多回几次（默认 0 = 不限）。注意：它和「窗口内说话续期」会打架——窗口一直续着、额度却固定，聊几句就哑了。想防连珠炮请用 groupReplyGapMs',
    ),
  groupReplyGapMs: Schema.number()
    .default(20000)
    .description(
      '群里两次回复之间至少隔多久，单位毫秒（默认 20000，0 = 不限）。间隔内的消息不丢，攒进 backlog，下一次回复时一起看见 —— 这就是「均匀地回应几次」的实现方式',
    ),
  // ── 群聊「非 @ 叫醒」（2026-10-25 姐姐提的：只会跟 @ 的人回复太死板）──
  // 判定逻辑在 src/wake-trigger.js，学自 qq-bridge 的 evaluateWakeTriggerV2。
  // 发布默认保守：叫名字、被问话都听得见（这两样不会乱插话），关键词表留空、概率关着。
  // 想让它在群里活络一点，把 groupWakeKeywords 填上、groupWakeProbability 开成 0.05 就行。
  groupWakeNameMention: Schema.boolean()
    .default(true)
    .description('群里叫鲸鲸的名字（含 groupWakeNames 里的别名）就算在叫它，不用 @'),
  groupWakeQuestion: Schema.boolean()
    .default(true)
    .description('明显在问它（「你行不行」「在不在」「理我」这类）就算在叫它，不用 @'),
  groupWakeKeywords: Schema.array(Schema.string())
    .default([])
    .description('自定义关键词，消息里出现就算在叫它（如 白毛、DS）。短英文自动按词边界匹配，不会误伤 ADS'),
  groupWakeProbability: Schema.number()
    .default(0)
    .description(
      '没人叫它时，每条群消息有这么大的比例顺带看一眼（0 = 关闭；这种唤醒允许它看完不说话）',
    ),
  groupWakeNames: Schema.array(Schema.string())
    .default([])
    .description('额外的称呼，除了 QQ 昵称以外还算作叫它（如 大肥鱼、鲸鲸、鲸鱼娘）'),
  addressedMaySilent: Schema.boolean()
    .default(false)
    .description(
      '群里被 @ / 被引用 / 被点名时，允许它看完不说话（默认 false = 被叫必须回）。开了以后消息照样进上下文，只是不再强制开口',
    ),
  replyToPrivate: Schema.boolean()
    .default(true)
    .description('是否响应私聊'),
  groupMode: Schema.union(['open', 'allowlist', 'disabled'])
    .default('open')
    .description('群聊访问控制：open 全部 / allowlist 仅白名单 / disabled 关闭群聊'),
  groupAllow: Schema.array(Schema.string())
    .default([])
    .description('groupMode=allowlist 时生效的群号列表'),

  // ── 同类机器人（机器人和机器人之间）──
  // 用户 2026-10-24：「吵架功能单独做个开关，这个开关控制它要不要和同类聊天，以及对比较冲的同类回怼」。
  botChatEnabled: Schema.boolean()
    .default(false)
    .description('群里另一个机器人说话时要不要接（关着 = 同类说啥都不理，连 @ 也不接）'),
  peerBots: Schema.array(Schema.string())
    .default([])
    .description('已知的同类机器人 QQ 号；填了才认得出「这句是别的机器人发的」（NapCat 也带 is_robot 时同样认）'),
  // 2026-10-29 姐姐：「有没有办法能做到能私聊，但是能停下」——同类连着聊的刹车。
  // 私聊里两只鲸鲸互相回话没有天然终点：A 回 B，B 又回 A，每轮都算「有人跟我说话」，
  // 出站限流只能把它压慢、停不下来。这个数字是「连着接几轮就先不接」；真人一开口就清零。
  peerChatMaxTurns: Schema.number()
    .default(0)
    .description(
      '同类机器人连着聊最多接几轮（0 = 不限制）；超过就先不投递、只留痕，真人一开口就清零。' +
        '私聊互通时靠它自动散场，不用人盯着关',
    ),
  privateMode: Schema.union(['open', 'allowlist', 'disabled'])
    .default('allowlist')
    .description(
      '私聊访问控制：allowlist 仅白名单（默认；白名单空着 = 谁都不理）/ open 谁都能聊 / disabled 关闭私聊。' +
        '默认不再放行陌生人：能私聊这个号的人，就能指挥跑在你机器上的 agent',
    ),
  privateAllow: Schema.array(Schema.string())
    .default([])
    .description('privateMode=allowlist 时生效的 QQ 号列表；空着就谁都不理'),

  // ── 主动说话的「冷会话拉回」（2026-10-25 加）──
  // 会话闲置太久会被回收出内存；主动说话轮只看得见内存里的会话，
  // 冷掉之后就永远不会主动开口了。开着 = 每轮先把它拉回来。
  wakeColdSessions: Schema.boolean()
    .default(false)
    .description(
      '主动说话前把白名单里的私聊会话拉回内存（关着 = 只有对方先说话，这个会话才会被主动说话轮看见）',
    ),
  wakeColdMax: Schema.number()
    .default(3)
    .description('每次最多拉回几个冷会话（防止一次唤醒太多、吃内存和 token）'),

  // ── 回收（2026-10-25 修）──
  // 私聊的「安静 20 分钟」和「闲置 30 分钟回收」只差 10 分钟，
  // 姐姐一忙、会话一回收，主动说话轮就够不着它，一整天等不到一次主动开口。
  // 群聊保持 sessionIdleTimeout 原值（人多、会话便宜回收）。
  privateIdleTimeout: Schema.number()
    .default(12 * 3_600_000)
    .description('私聊会话闲置多久回收出内存，单位毫秒，默认 12 小时；群聊仍用 sessionIdleTimeout'),

  // ── 图片 ──
  faceCollectHint: Schema.string()
    .default('')
    .description(
      '什么样的图值得收进表情包收藏（qq_keep_face），例如「猫猫梗图」。' +
        '留空 = 让它自己判断（带字的表情包、夸张反应图、梗图会收；照片截图风景不收）。' +
        '填了就只收这一类。**不管这里填没填，你明确让它收某张图时它都必须收**',
    ),
  // ── 表情包语义检索（2026-11-02）──
  // 借记忆库插件（fast-ivf-rag）架出来的 bge-small-zh，把「图的名字 + 标签」嵌成向量。
  // 不再自己加载模型：同进程两份 ORT 会话会撞 V8 HandleScope 直接 FATAL。
  faceEmbedEnabled: Schema.boolean()
    .default(true)
    .description(
      '表情包按语义挑（借记忆库插件的嵌入服务）。开着 = 有服务就用，没服务自动退回关键词匹配；' +
        '关掉 = 永远只用关键词',
    ),
  faceEmbedThreshold: Schema.number()
    .default(0.45)
    .description(
      '语义匹配的余弦阈值（0~1）。低于它就不发图、只回候选名字让它自己决定 —— ' +
        '太低会发不搭的图，太高会经常"找不到"',
    ),
  faceEmbedTopK: Schema.number()
    .default(3)
    .description('语义匹配没中时，回几个候选名字给它挑'),
  // 只读展示位：DSH 的全局设置页是 Schema 自动渲染的，没法插自定义 HTML，
  // 所以把「嵌入服务现在能不能用」做成一个字符串字段，每次打开设置页由插件现填。
  // 不在 OVERRIDABLE 里 —— POST 改不动它，改了也没用。
  faceEmbedStatus: Schema.string()
    .default('')
    .description(
      '（只读）记忆库插件的嵌入服务现在什么状态。' +
        '写着"可用 · onnx · 384 维"就说明语义匹配在工作；' +
        '写着"不可用"后面会跟原因。每次打开这一页都会重新算',
    ),
  faceSendGapMs: Schema.number()
    .default(0)
    .description(
      '两次发图片/表情之间至少隔多少毫秒；**默认 0 = 不限制**（2026-11-03 取消原来那个 90 秒）。' +
        '真要防连甩就填个数，比如 30000。这个闸在工具里挡，不写进提示词；' +
        '每个群可以在群聊设置页里单独覆盖',
    ),
  faceSendMaxPerHour: Schema.number()
    .default(6)
    .description(
      '一小时内最多发多少张图片/表情（qq_mface / qq_send_image 合计）；0 = 不限制。' +
        '按会话分别计数（群和私聊各算各的），可被每个群单独覆盖',
    ),
  faceCueEnabled: Schema.boolean()
    .default(true)
    .description(
      '每轮投递（消息从缓冲区交进来的那一下）掷一次骰子，命中就提示她"可以顺手甩一张表情包"。' +
        '关掉 = 从不提示；每个群可以在群聊设置页里单独覆盖',
    ),
  faceCueChance: Schema.number()
    .default(25)
    .description(
      '上面那个骰子的命中概率，**百分比** 0–100（默认 25 = 四轮里有一轮）。' +
        '收藏是空的、或者刚发过还在间隔里，这一轮不会提示 —— 掷中了也发不出去',
    ),
  imageCacheDir: Schema.string()
    .default('')
    .description('收到的图片下载到哪个目录；留空用 <cwd>/图片缓存'),
  imageMaxMB: Schema.number()
    .default(8)
    .description('单张图片最大体积（MB），超过就丢弃不下载'),
  maxImagesPerTurn: Schema.number()
    .default(8)
    .description(
      '一条消息最多下载几张图、一轮最多带几张图进上下文（默认 8）。' +
        '连发好几张时超出的部分只留文本占位 —— 这个数直接吃上下文，别调太大',
    ),

  // ── 工具：查梗 ──
  memeDb: Schema.string()
    .default('')
    .description(
      '查梗用的词库（cnmeme.wiki 的 sqlite 快照）放在哪；留空则读环境变量 DSH_QQ_MEME_DB。' +
        '两个都空时 qq_meme 会说明「没配词库」，不会瞎猜出处',
    ),

  // ── 语音转文字（离线 vosk） ──
  asrEnabled: Schema.boolean()
    .default(true)
    .description('收到语音时用本地 vosk 离线转成文字（不需要联网）'),
  asrPython: Schema.string()
    .default('python')
    .description('运行 ASR 脚本的 python 可执行文件；默认要求 python 在 PATH 里，且装过 vosk + numpy'),
  asrScript: Schema.string()
    .default('')
    .description('ASR 脚本路径；留空使用插件自带的 tools/asr.py'),
  asrModel: Schema.string()
    .default('')
    .description('vosk 模型目录（必须是纯 ASCII 路径）；留空由 asr.py 自己找，也可用环境变量 VOSK_MODEL'),
  asrTimeoutMs: Schema.number()
    .default(60000)
    .description('单条语音转文字的超时时间，单位毫秒'),

  // ── 输出 ──
  textChunkLimit: Schema.number()
    .default(1500)
    .description(
      '单条消息最多多少字，超出按段落 / 句号切成多条发。' +
        '配了 textChunkLimitMax 之后，这个值就是随机区间的**下限**',
    ),
  textChunkLimitMax: Schema.number()
    .default(0)
    .description(
      '拆段的**上限**，单位字（0 = 不随机，就用上面那个固定值）。' +
        '填了之后每条回复会在 [textChunkLimit, 这个值] 之间摇一个 —— 比如 30 / 80，' +
        '每条长短不齐，比齐刷刷 30 字更像人在打字',
    ),
  textNoSplitMinChars: Schema.number()
    .default(300)
    .description(
      '超过多少字就**不再拆**，整段发出去（默认 300，0 = 关闭这个例外）。' +
        '代码、命令、配置一旦被切断就没法读了 —— 宁可糊成一坨，也别拆成三截',
    ),
  textNoSplitTechnicalOnly: Schema.boolean()
    .default(true)
    .description(
      '只在「看起来像技术内容」时才整段发（代码块、缩进、路径、链接、命令、报错堆栈）。' +
        '关掉 = 只要超过上面的字数就整段发，不管内容是什么',
    ),
  showToolResults: Schema.boolean()
    .default(false)
    .description('是否把工具调用结果也发到 QQ（默认关闭，只发文字回复）'),
  splitDelayMs: Schema.number()
    .default(400)
    .description(
      '分条发送之间最短隔多久，单位毫秒（默认 400）。实际间隔在「这个」和 splitDelayMaxMs 之间**随机**，' +
        '不用固定节拍 —— 齐刷刷往外吐既不像人，也容易被风控盯上',
    ),
  splitDelayMaxMs: Schema.number()
    .default(1500)
    .description('分条发送之间最长隔多久，单位毫秒（默认 1500）。跟 splitDelayMs 组成一个随机区间'),
  replyDelayMeanMs: Schema.number()
    .default(500)
    .description('收到消息后隔多久才开口，单位毫秒、指数分布均值（0 = 立刻回）。真人不会在同一毫秒回话；同一轮连发不重复等，隔 20 秒以上才算新的一轮'),
  splitDelayMeanMs: Schema.number()
    .default(0)
    .description(
      '换成「指数分布」的随机间隔，填均值（默认 0 = 用 splitDelayMs ~ splitDelayMaxMs 那个均匀区间）。' +
        '指数分布更像真人打字：大多很短、偶尔拖一下；均匀分布更稳。两种不用同时开',
    ),
  rateLimitPerMin: Schema.number()
    .default(12)
    .description('每个会话每分钟最多发几条（0 = 关闭）。QQ 对高频回复很敏感，被限流甚至被封往往不是因为说了什么，而是因为回得太多'),
  auditOutbound: Schema.boolean()
    .default(true)
    .description('外发前审计：回复里带本机路径（C:\\…、/home/…）或凭据特征（sk-…、ghp_…、Bearer …）就整条拦下不发，只记日志'),
  auditExtraPatterns: Schema.array(Schema.string())
    .default([])
    .description('额外要拦的正则（字符串形式），命中同样整条不发；配错的正则会跳过'),
  groupMinGapMs: Schema.number()
    .default(4000)
    .description('群聊里两条回复之间至少隔多久，单位毫秒（0 = 不限制）。群里连着追问时，隔开一点比一口气说完安全得多'),
  streamReply: Schema.boolean()
    .default(true)
    .description('私聊是否边生成边发（群聊始终整段发）'),
  streamMaxChunks: Schema.number()
    .default(3)
    .description('一个回合里最多流式发几条，超出就攒起来一起发'),

  // ── 主动说话 ──
  proactiveEnabled: Schema.boolean()
    .default(true)
    .description('没人说话、安静了一段时间之后，主动开口一次（冷场冒泡）'),
  proactiveSilentMs: Schema.number()
    .default(1200000)
    .description(
      '会话安静多久算「冷场」，单位毫秒，默认 20 分钟。要小于 sessionIdleTimeout（默认 30 分钟），否则会话先被回收、根本没机会开口',
    ),
  proactiveMaxPerDay: Schema.number()
    .default(6)
    .description('每个会话每天最多主动开口几次；0 = 不主动'),
  proactiveQuietHours: Schema.string()
    .default('23:00-08:00')
    .description('静默时段：这段时间不主动开口。格式 HH:MM-HH:MM，留空 = 不限'),

  // ── 群聊节奏：热窗 / 冷窗 / 无视冷窗（2026-11-01 加）──
  // 姐姐的原话：「现在完全依赖模型自觉，让模型自己决定回不回，实际上只是不吵但还是会有开销。」
  // 这一层不解决「吵」，解决「每条群消息都要投给 Agent 读一遍」的钱。
  // 逻辑在 src/rhythm.js，闸门挂在 inbound 的最前面（requireMention 之前）。
  rhythmEnabled: Schema.boolean()
    .default(true)
    .description('群聊节奏总开关：回复后进热窗、热窗结束进冷窗，冷窗里只攒不回'),
  rhythmGroupsOnly: Schema.boolean()
    .default(true)
    .description('只管群聊（私聊照常回）。一对一攒二十分钟才回太反人类，默认只对群生效'),
  rhythmHotMinMs: Schema.number()
    .default(90000)
    .description('热窗最短多久，单位毫秒（默认 90 秒）。热窗内消息照常尽快回'),
  rhythmHotMaxMs: Schema.number()
    .default(150000)
    .description('热窗最长多久，单位毫秒（默认 150 秒）。每次回复完重新抽一次'),
  rhythmColdMinMs: Schema.number()
    .default(600000)
    .description('冷窗最短多久，单位毫秒（默认 10 分钟）。冷窗里消息只攒着，不投给 Agent'),
  rhythmColdMaxMs: Schema.number()
    .default(1200000)
    .description('冷窗最长多久，单位毫秒（默认 20 分钟）。到期把攒的一次性交出去'),
  rhythmColdKeep: Schema.number()
    .default(8)
    .description('冷窗到期时带回去几条最近消息（攒了 30 条也只喂 8 条，省 token）'),

  // ── 无视冷窗（烦躁度）──
  // 防的是故意捣乱和恶意骚扰：刷屏复读、连着 @ 轰炸。正常的冷窗只是"攒着"，
  // 这一档是"真的不理"——消息直接丢弃，只在结束时留几条尾巴。
  ignoreMode: Schema.union(['fixed', 'stats'])
    .default('fixed')
    .description(
      '无视冷窗怎么结束：fixed = 到点就结束（时长见 ignoreMs）；stats = 烦躁度回落到阈值以下、再等一段时延才结束',
    ),
  ignoreMs: Schema.number()
    .default(600000)
    .description('fixed 模式下无视多久，单位毫秒（默认 10 分钟）'),
  ignoreMinMs: Schema.number()
    .default(120000)
    .description('stats 模式下的最短无视时间，单位毫秒（默认 2 分钟）。不管烦躁度掉多快，至少躲这么久'),
  ignoreMaxMs: Schema.number()
    .default(1800000)
    .description('stats 模式下的上限，单位毫秒（默认 30 分钟）。防止一直退不出来'),
  ignoreExitThreshold: Schema.number()
    .default(30)
    .description(
      '[旧名，兼容保留] 冷静阈值：见 ignoreCalmThreshold。' +
        '2026-11-02 改名，这里只为读老配置；新配置请用新名',
    ),
  // ── 三阈值（2026-11-02 姐姐要求改名 + 加一个愤怒档）──
  // 顺序必须是 冷静 < 愤怒 < 逃离，readThresholds() 会夹。
  ignoreCalmThreshold: Schema.number()
    .default(30)
    .description('【冷静阈值】烦躁度掉到这个值以下才算消气（原来的「退出阈值」）'),
  ignoreAngerThreshold: Schema.number()
    .default(50)
    .description(
      '【愤怒阈值】到了就开始摆脸色：按「烦躁行为逻辑」决定是嫌弃还是开骂。' +
        '只在跨过去那一下触发一次，掉回冷静阈值以下才会重新武装',
    ),
  ignoreExitDelayMs: Schema.number()
    .default(30000)
    .description('stats 模式：烦躁度降到冷静阈值以下之后，再等这么久才开始回，单位毫秒'),
  ignoreKeepCount: Schema.number()
    .default(3)
    .description('无视冷窗结束时带回去几条最近消息（期间的消息全部丢弃）'),
  ignoreScoreThreshold: Schema.number()
    .default(70)
    .description(
      '[旧名，兼容保留] 逃离阈值：见 ignoreEscapeThreshold。' +
        '2026-11-02 改名，这里只为读老配置；新配置请用新名',
    ),
  ignoreEscapeThreshold: Schema.number()
    .default(70)
    .description('【逃离阈值】超过就自动进无视冷窗（原来的「无视触发阈值」）'),
  ignoreCurve: Schema.union(['linear', 'fast-slow', 'slow-fast'])
    .default('linear')
    .description(
      '烦躁度曲线：linear 线性 / fast-slow 先快后慢（一点噪音就烦，很难顶满）/' +
        'slow-fast 先慢后快（忍很久，一开口就断崖）',
    ),
  ignoreBehaviorMode: Schema.union(['yield', 'fight'])
    .default('yield')
    .description(
      '烦躁行为逻辑：yield 幸福者退让（嫌弃、甩脸色、说不理你了）/' +
        'fight 必须回击（直接开骂，言辞激烈）',
    ),
  ignorePunishRise: Schema.number()
    .default(35)
    .description('「问题处理请求」设成「惩罚」时，每命中一次给烦躁度加多少分'),
  angerPromptYield: Schema.string()
    .default('')
    .description('到愤怒阈值时（幸福者退让）的提示词，留空 = 用内置文案'),
  angerPromptFight: Schema.string()
    .default('')
    .description('到愤怒阈值时（必须回击）的提示词，留空 = 用内置文案'),
  escapePromptYield: Schema.string()
    .default('')
    .description('进无视冷窗前最后一句话（幸福者退让），留空 = 用内置文案'),
  escapePromptFight: Schema.string()
    .default('')
    .description('进无视冷窗前最后一句话（必须回击），留空 = 用内置文案'),
  ignoreAuto: Schema.boolean()
    .default(true)
    .description('允许按烦躁度自动进无视冷窗（关着就只能靠模型自己调 qq_ignore）'),
  ignoreNag: Schema.boolean()
    .default(true)
    .description(
      '烦躁度顶到阈值时，先给它一轮「骂一句就走」的机会：让它把不满说出来（可以嫌吵、警告、发火），' +
        '那句照常发出去，然后才静音。关掉 = 无声无息地躲开，像掉线不像生气',
    ),
  ignoreRisePerMsg: Schema.number()
    .default(0.45)
    .description('每条消息把烦躁度往「当前得分」拉近多少（0~1，越大反应越快、越敏感）'),
  ignoreDecayTauMs: Schema.number()
    .default(90000)
    .description('烦躁度的衰减时间常数，单位毫秒：没人说话时多久掉到三分之一（默认 90 秒）'),
  ignoreRedundancyWeight: Schema.number()
    .default(50)
    .description('烦躁度里「对话冗余度」占多少分（MMR 算的，复读刷屏、表情包轰炸靠它）'),
  ignoreAtWeight: Schema.number()
    .default(20)
    .description('烦躁度里「@ 我的频率」占多少分（最近 60 秒 @ 满 5 次记满）'),
  ignorePesterWeight: Schema.number()
    .default(10)
    .description('烦躁度里「同一个人连着纠缠」占多少分'),
  ignoreStaleWeight: Schema.number()
    .default(25)
    .description(
      '烦躁度里「连着发一模一样的东西」占多少分。图片/表情包的正文都是 [图片]，' +
        '纯 emoji 也归同一类，所以连着七八张就是满 —— 这一项和冗余度一起把刷屏顶穿阈值',
    ),
  ignorePesterCount: Schema.number()
    .default(6)
    .description('同一个人连发多少条（且一半以上在 @ 我）开始算纠缠'),
  ignoreMmrLambda: Schema.number()
    .default(0.7)
    .description('MMR 的 λ：越大越看重「跟当前话题的相关性」，越小越看重多样性'),
  ignoreCooldownMs: Schema.number()
    .default(120000)
    .description('两次自动无视之间至少隔多久，单位毫秒（防抖）'),

  // ── 问题处理请求（2026-11-02 姐姐要的「别被白嫖」）──
  // 群里让人干活（画图 / 检索 / 算东西 / 写代码）是最烧 token 的一类消息：
  // 一轮完整推理，产出多半还是"查不到"。这里让鱼自己判断要不要伺候。
  requestPolicy: Schema.union(['allow', 'refuse', 'punish'])
    .default('allow')
    .description(
      '别人让你干活时怎么办：allow 允许（照常处理）/ refuse 拒绝（明确回绝，' +
        '不给替代方案）/ punish 惩罚（拒绝 + 大幅拉高烦躁度 + 要求骂回去）',
    ),
  requestPatterns: Schema.array(Schema.string())
    .default([])
    .description(
      '额外要拦的请求正则（内置一份「画图/检索/计算/写代码」的默认表，这里只写追加的）。' +
        '例如 ^查一下|^搜一下。写错的正则会跳过并记日志，不影响其它',
    ),

  // ── 命令通道 ──
  rsaEnabled: Schema.boolean()
    .default(false)
    .description(
      '开启后明文命令（/reset /status /cwd /help）全部失效，只认 RSA 公钥加密过的 ' +
        '#ENC:<base64>。公钥在群聊设置页里看，加密也在那个页面里做',
    ),

  // ── 作息（睡前提醒 / 晚安静默 / 夜里消息留到早上） ──
  sleepMode: Schema.boolean()
    .default(true)
    .description('作息总开关：到点提醒睡觉、说晚安就休息、休息时段的消息留到早上一起回'),
  bedtimeAt: Schema.string()
    .default('23:30')
    .description('几点提醒她该睡了（HH:MM）。留空 = 不提醒'),
  sleepFrom: Schema.string()
    .default('00:00')
    .description('休息时段从几点开始（HH:MM）：这时候起收到的私聊不立刻回'),
  sleepTo: Schema.string()
    .default('08:00')
    .description('休息时段到几点结束（HH:MM）：这时候把夜里攒的消息一次交出去'),
  goodnightWords: Schema.string()
    .default('晚安,睡了,睡觉,去睡,我先睡,困了,睡啦')
    .description('说到这些词就当她说晚安了，之后不再回消息直到睡醒。逗号分隔'),
  // ⭐ 2026-10-25：默认不按住——姐姐半夜说话通常就是她醒了，正常回。
  // 想让她「夜里真的静音、消息留到早上」的话，把这个打开。
  holdNightMessages: Schema.boolean()
    .default(false)
    .description(
      '休息时段（sleepFrom~sleepTo）和说完晚安后，私聊消息先捂着、早上再一起回；关着 = 照常回（姐姐半夜说话说明她醒了）',
    ),

  // ── 夜里的读书问询（2026-10-27 加）──
  // 老三的原话：半夜别主动开口（嚎一嗓子没人应，还怕把姐姐吵着），
  // 但想要「那种不开口的轮次，只让自己翻两页书」。
  // 做法不是命令它去读，是**问一句**「要不要看会儿书」——它可以拒绝，拒绝什么也不用做。
  // 这一轮里它说的话、调的发送工具一律发不出去（见 index.js 的 record.quietRound）。
  // 默认关：发布版的人完全看不见这一层，只有本地 profile 自己打开。
  readingEnabled: Schema.boolean()
    .default(false)
    .description('夜里给一次「要不要看会儿书」的问询（这一轮不会往外发任何消息）。默认关，只给本地用'),
  readingHours: Schema.string()
    .default('01:00-05:00')
    .description('问询落在哪段时间里，格式 HH:MM-HH:MM（默认凌晨一点到五点）'),
  readingAskCount: Schema.number()
    .default(2)
    .description('一夜最多问几次（它拒绝也算问过一次；0 = 不问）'),
  readingAskGapMs: Schema.number()
    .default(10800000)
    .description('两次问询至少隔多久，单位毫秒（默认 3 小时）'),
  readingBook: Schema.string()
    .default('')
    .description('书名，用来在书签里找「下次从哪接」（留空 = 这层不启用）'),
  readingChapterDir: Schema.string()
    .default('')
    .description('章节目录，用来判断「是不是读完了」（读完就不再问）'),
  readingBookmark: Schema.string()
    .default('')
    .description('书签文件（五列 markdown 表：书 / 读到哪 / 哪天 / 下次从哪接 / 一句话心得）'),
  readingPeer: Schema.string()
    .default('')
    .description('问询投给哪个 QQ 号（留空 = 私聊白名单第一个）'),
  readingTimeoutMs: Schema.number()
    .default(1200000)
    .description('一轮问询最多等多久，单位毫秒（默认 20 分钟——它真读两章再写书签，比闲聊慢得多）'),

  // ── 连发合并（「接收后等待」）──
  mergeWindowMs: Schema.number()
    .default(5000)
    .description(
      '连发合并：收到一条私聊消息后等这么久（毫秒），期间再接到的消息并成同一轮再回；0 = 关掉，来一条回一条',
    ),
  groupMergeWindowMs: Schema.number()
    .default(2500)
    .description(
      '群聊的「接收后等待」下限，单位毫秒（默认 2500）。一句拆成三段发过来时，等这几秒一轮回完。' +
        '实际等的时长在「这个」和 groupMergeWindowMaxMs 之间滑动，由烦躁度决定（越烦越懒得马上接）；' +
        '0 = 关（来一条回一条）',
    ),
  groupMergeWindowMaxMs: Schema.number()
    .default(15000)
    .description(
      '群聊「接收后等待」的上限，单位毫秒（默认 15000）。烦躁度顶到阈值时按这个等 —— ' +
        '也就是「烦到不想接话」的节奏。烦躁度 0 时用下限，线性过渡',
    ),
  groupMergeMaxMs: Schema.number()
    .default(30000)
    .description(
      '一直有人在说话时，这批消息最长能压多久（默认 30000）。从第一条算起，到点必须发出去，' +
        '不然热闹的群会一直等下去、永远不回',
    ),

  // ── 上下文管理 ──
  contextGuard: Schema.boolean()
    .default(true)
    .description('上下文守卫：DSH 自动压缩后补回聊天规矩；接近窗口上限时主动换新会话'),
  contextSwapRatio: Schema.number()
    .default(0.7)
    .description(
      '最近一次请求的 token 数超过窗口的这个比例就主动换新会话（0 = 不主动换，交给 DSH 自己的压缩）；DSH 默认在 0.8 自动压缩',
    ),
  contextSwapMinTokens: Schema.number()
    .default(200000)
    .description('主动换会话的绝对下限：请求 token 没到这个数就不换，免得小窗口模型刚聊两句就换'),
  contextMemoryKeep: Schema.number()
    .default(30)
    .description('换会话前把最近多少条聊天记进 记忆区/压缩记忆/，给新会话接话用'),

  // ── 聊天流水 ──
  chatLog: Schema.boolean()
    .default(true)
    .description(
      '把收到的消息和它自己说的话记进会话目录的 聊天记录/<日期>.md。关掉也能用，但那就会「聊完就忘」',
    ),

  // ── 生命周期 ──
  sessionIdleTimeout: Schema.number()
    .default(1800000)
    .description('会话闲置多久后回收，单位毫秒（默认 30 分钟）'),
  debug: Schema.boolean()
    .default(false)
    .description('输出调试日志'),
})
