/**
 * 这个群要不要 @ 才接话。
 *
 * 2026-11-01 姐姐要的：「必须 @ 才接话」改成按群选。
 * 与其做一个「每个群一个开关」的面板（得先知道有哪些群、还得跟着群列表变），
 * 不如给两个例外名单 —— 语义清楚，也不用维护群列表：
 *
 *   1. `groupMustMention`：这些群**必须** @（哪怕全局关着）
 *   2. `groupNoMention`：这些群**不用** @（哪怕全局开着）
 *   3. 都不在名单里 → 走全局的 `requireMention`
 *
 * 两个名单冲突时 must 优先 —— 宁可漏接一句，也别在不该插嘴的地方插嘴。
 *
 * 单独放一个文件是为了能直接被测试 import：挂在 inbound.js 里的话，
 * 一条 `@deepseek-ai/dsh-llm` 的依赖就能让裸 node 跑不起来。
 */

const toSet = (v) => new Set((Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean))

export function needMention(config, groupId) {
  const id = String(groupId ?? '').trim()
  const fallback = config?.requireMention !== false
  // ① 群级三态（2026-11-02）：在群聊设置页里直接选，不用去全局那边填群号数组。
  //    follow = 跟随全局（走下面那套），must = 这个群必须 @，never = 这个群不用 @。
  const mode = String(config?.mentionMode ?? 'follow')
  if (mode === 'must') return true
  if (mode === 'never') return false
  // ② 全局的群号数组（老配置照旧生效）
  if (!id) return fallback
  if (toSet(config?.groupMustMention).has(id)) return true
  if (toSet(config?.groupNoMention).has(id)) return false
  return fallback
}
