/**
 * 把长回复切成适合 QQ 单条发送的几块。
 *
 * 两条路：
 * 1) 模型自己用换行分了段 → **一行就是一条**，照它切（聊天场景就是这么用的）。
 * 2) 单行长文 → 按段落、换行、句末标点、逗号的顺序找切口，最后才硬切。
 *
 * 尽量不让一句话被拦腰砍断，看着像人说话，而不是断流的机器。
 */

/** 单行内部的切分：优先标点，最后硬切 */
function splitLongLine(source, max) {
  const chunks = []
  let rest = source
  while (rest.length > max) {
    const window = rest.slice(0, max)
    let cut = -1
    for (const sep of ['。', '！', '？', '；', '. ', '! ', '? ', '，', '、', ' ']) {
      const at = window.lastIndexOf(sep)
      if (at > max * 0.4) {
        cut = at + sep.length
        break
      }
    }
    if (cut <= 0) cut = max
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trimStart()
  }
  if (rest.trim()) chunks.push(rest.trim())
  return chunks.filter(Boolean)
}

export function splitText(text, limit = 1500) {
  const source = String(text ?? '')
  // 下限从 200 放到 16：聊天场景会把 textChunkLimit 调到 20~30 字，
  // 老的 200 会把整个设置按死，一条还是照发两百字。
  const max = Math.max(16, Number(limit) || 1500)
  if (!source.trim()) return []

  // 模型自己换行分好的段：一行一条，别再拼回去
  const lines = source
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (lines.length > 1) return lines.flatMap((line) => (line.length > max ? splitLongLine(line, max) : [line]))

  return splitLongLine(source.trim(), max)
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

/**
 * 这段话像不像技术内容（代码、命令、配置、路径、堆栈）。
 *
 * 用来决定「长文要不要整段发」：拆段是为了像人说话，可代码和命令被切断就是废的 ——
 * 一个 ``` 块断成三截、一条命令断在两个气泡里，人根本抄不全。
 * 2026-11-02 姐姐提的：「如果文本很长超过一个阈值，比如它真的在讲技术相关的，直接就不分段」。
 *
 * 判据故意收得紧一点：宁可把一段技术话当成普通话拆开（那也能读），
 * 也别把普通聊天当成技术整段糊上去（群里一大坨更难读）。
 */
export function looksTechnical(text) {
  const s = String(text ?? '')
  // 不在这里卡长度：调用方（keepWhole）已经要求「超过 N 字」才会问这一句。
  // 这里只管"像不像技术内容"，这样它也能单独用在别处。
  if (!s.trim()) return false
  // 代码围栏 / 行内代码
  if (/```/.test(s)) return true
  if (/`[^`\n]{2,}`/.test(s)) return true
  // 有缩进的行（代码、YAML、配置、日志）
  if (/(^|\n)[ \t]{2,}\S/.test(s)) return true
  // 路径（Windows / Unix）
  if (/[A-Za-z]:[\\/][^\s]{2,}/.test(s)) return true
  if (/(^|\s)~?\/[\w.-]+\/[\w./-]+/.test(s)) return true
  // 链接
  if (/https?:\/\/|wss?:\/\//i.test(s)) return true
  // shell / 交互提示
  if (/(^|\n)\s*[$>#]\s+\S/m.test(s)) return true
  // 打包 / 版本 / 远程这类命令词：在闲聊里出现率极低，出现就是真在说操作
  if (/\b(npm|pnpm|yarn|pip3?|git|sudo|curl|wget|docker|systemctl|node|python3?|bash|powershell)\b/i.test(s)) return true
  // 代码关键字还得配上代码味符号 —— 不然"那个函数写得挺烂"也算技术了
  if (
    /\b(function|const|let|class|import|export|return|async|await|def|struct|interface)\b/.test(s) &&
    /[{}();=]/.test(s)
  ) {
    return true
  }
  // JSON / YAML 片段
  if (/[{[][^\]}]{0,200}["'][\w-]+["']\s*:/.test(s)) return true
  // 报错 / 堆栈
  if (/\b(Error|Exception|Traceback|at\s+\S+\s*\(|errno|ENOENT|undefined is not)\b/.test(s)) return true
  return false
}

/**
 * 这一行是不是命令 / 代码 / 链接 / 配置。
 *
 * `outbound.js` 有条老规则「没有汉字的行整行丢掉」，本来是拦模型的英文自评
 * （`That's factual and short. Two lines is fine.`），结果把**人真正要抄的东西**一起杀了：
 * 命令、代码、URL 全是纯 ASCII。
 * 2026-11-02 姐姐反馈「第一条命令发不出来，群里只有『第一步：装 Node 和 CLI：』」，
 * 根因就是它 —— `curl -fsSL https://...` 没有汉字，被当自评吃掉。
 *
 * 判据：要么命中 looksTechnical（缩进 / 路径 / 链接 / 命令词 / 报错），
 * 要么是 `<工具> <参数>` 这种**全小写**的短行（`dsh web`、`sleep 30`）——
 * 要求小写开头就是为了不把 `Good. Two lines.` 这种英文自评捞回来。
 */
export function looksLikeCodeLine(text) {
  const t = String(text ?? '').trim()
  if (!t) return false
  if (looksTechnical(t)) return true
  if (!/^[a-z]/.test(t)) return false
  return /^[a-z][\w.@/-]{1,24}(\s+[-a-z0-9_.@/:]{1,24}){1,4}$/.test(t)
}

/**
 * 这一轮要不要整段发（不拆）。
 *
 * 两个条件都满足才整段：**够长**（超过阈值，短的本来就不用拆）且**像技术内容**。
 * `technicalOnly: false` 时就只按长度判 —— 所有超长文本都整段发。
 */
export function keepWhole(text, { minChars = 0, technicalOnly = true } = {}) {
  const s = String(text ?? '')
  const min = Math.max(0, Number(minChars) || 0)
  if (min <= 0 || s.length < min) return false
  return technicalOnly === false || looksTechnical(s)
}
