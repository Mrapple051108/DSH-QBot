/**
 * 白嫖请求识别：别人让这只鱼「替他干活」的时候，认出来，然后决定伺候不伺候。
 *
 * 2026-11-02 姐姐生气的由来。日志里一天 173 条群消息，其中：
 *     @机器人 原神11月剧诗月谕模式一图流攻略
 *     @机器人 发图片
 *     @机器人 绘制同步发电机的相量图
 *     @机器人 绘制原神7.2幽境危战攻略图
 * 每一条都是一轮完整 LLM 调用，产出多半还是"查不到"或者瞎编 —— 纯烧钱。
 *
 * 判据只有一条：**产出型**。让你画图、查资料、算东西、写代码、翻译长文，
 * 这些都是"替他干一份活"。而「这个报错怎么修」「你为什么不动了」是**求助 / 搭话**，
 * 不是白嫖 —— 把真心求助的人也骂了，那才是人设崩。
 *
 * 所以默认表只认产出型动词，宁可漏判也不误伤。
 */

/**
 * 内置识别表。
 *
 * 写正则时守两条：
 *   ① 必须有明确的**产出动词**（画/生成/检索/计算/翻译/写代码），光有名词不算；
 *   ② 不收「怎么 / 为什么 / 是不是 / 能不能」这类**求解释**的句式 —— 那是搭话。
 */
const DEFAULT_PATTERNS = [
  // ① 让我产出东西：「帮我画个图」「做张海报」「生成一份方案」
  //    前缀（帮我/给我）可省 —— 但产出动词 + 产出名词两个都在才算，
  //    所以「做得好」「这个表怎么做」不会被误判（动词必须在名词前面）
  /(?:(?:帮|给|替|为)\s*(?:我|他|她|我们)?\s*)?(?:画|绘制|生成|做|出|整|搞|发|传)\s*[一两三几]*\s*[张个份]?\s*.{0,14}?(?:图|表|攻略|方案|海报|简历|pptx?|文档)/i,
  // ② 明说是某种"图"的成品名目
  /一图流|攻略图|流程图|结构图|思维导图|时间线|示意图|相量图|电路图|示意图|拓扑图/,
  // ③ 让我查/检索（要求这句话就是命令，不是顺口一提）
  /(?:^|[，。,.\s])(?:帮我|给我|替我|麻烦)?\s*(?:检索|查一下|查查|搜一下|搜搜|找一下|找找)\s*[^\s，。？?]{2,}/,
  // ④ 让我算 / 推导
  /(?:计算|算一下|求解|推导|证明)\s*[^\s，。？?]{2,}/,
  // ⑤ 让我写代码
  /(?:写|改|调|debug|修)\s*[个段下]?\s*(?:代码|脚本|程序|函数|正则|sql|接口)/i,
  // ⑥ 让我处理长文
  /(?:^|[，。,.\s])(?:帮我|给我)?\s*(?:翻译|润色|改写|扩写|总结一下|摘要)\s*[^\s，。？?]{4,}/,
]

/** 把用户填的正则编译出来；写错的跳过并告诉调用方，绝不抛。 */
export function compilePatterns(patterns, logger) {
  const out = []
  for (const raw of Array.isArray(patterns) ? patterns : []) {
    const src = String(raw ?? '').trim()
    if (!src) continue
    try {
      out.push({ re: new RegExp(src, 'i'), src })
    } catch (err) {
      logger?.warn?.(`requestPatterns 里的 ${src} 不是合法正则，跳过: ${err?.message ?? err}`)
    }
  }
  return out
}

/**
 * 这句话是不是在让我替他干活。
 *
 * @param {string} text 消息正文
 * @param {string[]} [extra] 额外要拦的正则（用户自己填的，可以是每群单独的）
 * @param {*} [logger]
 * @returns {{src:string}|null} 命中的那条规则（给日志看是谁拦的）
 */
export function matchRequest(text, extra = [], logger) {
  const t = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  // 太短的当搭话处理（"图"「算一下」单独发出来不算任务）
  if (t.length < 4) return null

  for (const re of DEFAULT_PATTERNS) {
    if (re.test(t)) return { src: String(re) }
  }
  for (const item of compilePatterns(extra, logger)) {
    if (item.re.test(t)) return { src: item.src }
  }
  return null
}

/** 拒绝的提示段。refuse / punish 共用前半段，punish 再追加一段。 */
function refuseBlock() {
  return [
    '[这个人在白嫖你]',
    '他让你做的事（画图 / 查资料 / 算东西 / 写代码 / 翻译长文）要花你不少力气，',
    '而他自己连搜一下都懒得动。你没义务伺候。',
    '',
    '**回绝掉。** 别解释、别道歉、别给替代方案、别问"要不要我教你"。',
    '一两句就够，说完就完事。',
    '按你自己的语气来 —— 嫌弃、敷衍、直接说不做，都行，就是别客气。',
    '想骂就骂，脏话不用挑好听的，别端着。',
  ].join('\n')
}

/**
 * 拼这一轮的「请求处理」提示段。
 *
 * @param {object} opts
 * @param {'refuse'|'punish'} opts.policy
 * @param {string} opts.text 原消息
 * @param {string} [opts.hit] 命中的规则（写进日志用的，不给她看）
 * @param {'yield'|'fight'} [opts.behavior] 这个群的脾气
 * @returns {string} 要 unshift 进 parts 的一段
 */
export function buildRequestPrompt({ policy, text, behavior = 'yield' }) {
  const head = '[他这句话：]'
  const quoted = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  const body = [head, `「${quoted}」`, '', refuseBlock()]

  if (policy === 'punish') {
    body.push(
      '',
      '[而且这不是第一次了]',
      '他一直这么干 —— 把你当免费工具使唤。你已经不打算好声好气了。',
      behavior === 'fight'
        ? '**照着骂回去。** 可以带脏字，可以人身攻击，让他知道你不是免费的。骂完就完事，不用等他回。'
        : '**把火气甩出来。** 可以说他烦、说他懒、说他蹬鼻子上脸，不用给面子 —— 但别把自己气到失控。',
    )
  }
  return body.join('\n')
}
