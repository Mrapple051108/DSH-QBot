/**
 * 「这轮要不要顺手发张表情包」—— 掷骰子。
 *
 * 2026-11-03 姐姐要的：每来一条消息（从缓冲区交进来的那一下）抽个随机数，
 * 命中就提示它发一张表情包；概率可配，全局一份、每个群也能单独覆盖。
 *
 * 为什么掷在这里、而不是写进 system 提示词里让它"自己看心情"：
 *   · system 里的规矩是**静态**的（见 chat-prompt.js），掷骰子必须每轮不同；
 *   · 而且提示只该出现在"真的轮到它说话"的那一轮 —— 搁进历史里会一直挂着。
 * 所以这一句是跟着**这一轮投递的正文**走的，一次一跳，不沉淀。
 *
 * 掷骰子和拼文案拆成两个纯函数，是为了能直接跑测试（不拖宿主依赖）。
 */

/** 抽中之后附在正文后面的那一小段。 */
export const FACE_CUE_HINT = `[这轮可以顺手甩一张表情包]
要发就发一张，挑贴现在气氛的；配字最多一小句，别解说为什么发这张。不想发就算了，不用解释。`

/**
 * 掷一次骰子。
 *
 * @param {object} opts
 * @param {boolean} [opts.enabled=true] 开关（false 时永远不中）
 * @param {number}  [opts.chance=25]    命中概率，**百分比** 0–100
 * @param {() => number} [opts.random]  随机源，默认 Math.random（测试里可以钉死）
 * @returns {boolean} 命中没有
 */
export function rollFaceCue({ enabled = true, chance = 25, random = Math.random } = {}) {
  if (enabled === false) return false
  const p = Number(chance)
  if (!Number.isFinite(p) || p <= 0) return false
  if (p >= 100) return true
  let r
  try {
    r = Number(typeof random === 'function' ? random() : Math.random())
  } catch {
    r = Math.random()
  }
  if (!Number.isFinite(r)) r = Math.random()
  // r ∈ [0,1)，p=25 时命中区间是 [0, 0.25)
  return r * 100 < p
}

/**
 * 该不该在这一轮挂提示。
 *
 * 除了掷骰子，还得确认**现在真发得出去**：收藏是空的、或者刚发过一张还在间隔里，
 * 提示它就是让它去撞墙（工具会回一句"刚发过了"，白烧一轮）。
 *
 * @param {object} opts
 * @param {boolean} [opts.enabled]
 * @param {number}  [opts.chance]
 * @param {number}  [opts.facesCount]   收藏里有多少张能用
 * @param {boolean} [opts.sendAllowed]  faceSendState().allowed
 * @param {() => number} [opts.random]
 * @returns {boolean}
 */
export function shouldCueFace({ enabled = true, chance = 25, facesCount = 0, sendAllowed = true, random } = {}) {
  if (enabled === false) return false
  if (!(Number(facesCount) > 0)) return false
  if (sendAllowed === false) return false
  return rollFaceCue({ enabled, chance, random })
}

/** 把提示段接到正文后面（正文为空时就是它自己）。 */
export function appendFaceCue(body, hint = FACE_CUE_HINT) {
  const text = String(body ?? '').trim()
  const tail = String(hint ?? '').trim()
  if (!tail) return text
  return text ? `${text}\n\n${tail}` : tail
}
