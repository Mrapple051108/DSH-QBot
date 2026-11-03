/**
 * 把连发的几条正文并成一轮。
 *
 * 2026-11-02 姐姐的反馈：「多张图片进来会一直不停强调图片规矩，我觉得这个可以省一点，
 * 在最后一行留一个就行」。
 *
 * 原因：每条消息的正文里都拼了一份 `IMAGE_RULES`、一句「一共有 N 张图片」、
 * 还有一句收藏规则。合并窗口把它们直接 join 起来，三张图就念三遍 —— 模型被同一段话
 * 反复糊脸，既费 token 又容易把注意力带偏。
 *
 * 所以这里先把这些**固定规矩行**全部剥掉，最后按这一轮的真实情况重新拼一份。
 * `（原图：…）` 那几行保留：每条路径不同，剥了就没法 read_image 兜底。
 */
import { IMAGE_RULES } from '../prompts.js'

const IMG_SUMMARY_LINE = /^\s*\[(?:这一轮)?一共有 \d+ 张图片/
const IMG_RULE_LINE = /^\s*\[图片规矩/
const FACE_RULE_LINE = /^\s*\[(?:只有这类图值得收|不要收藏图片|碰到表情包可以自己收)/

/**
 * @param {string[]} bodies 每条消息各自拼好的正文
 * @param {{imageCount?:number, faceRule?:string}} [opts]
 * @returns {string}
 */
export function mergeBodies(bodies, { imageCount = 0, faceRule = '' } = {}) {
  const list = (bodies ?? []).map((b) => String(b ?? ''))
  if (list.length <= 1) return list[0] ?? ''

  const out = []
  for (const body of list) {
    for (const line of body.split('\n')) {
      if (IMG_SUMMARY_LINE.test(line) || IMG_RULE_LINE.test(line)) continue
      if (line === faceRule || FACE_RULE_LINE.test(line)) continue
      out.push(line)
    }
  }

  // 规矩只在最后留一份；张数按这一轮真的收了多少算，不是某一条的
  if (imageCount > 0) {
    out.push('', `[这一轮一共 ${imageCount} 张图片，图已经随消息一起给你了，直接看。]`, IMAGE_RULES)
    if (faceRule) out.push(faceRule)
  }

  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
