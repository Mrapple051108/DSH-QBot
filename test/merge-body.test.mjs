/**
 * 回归测试：连发合并时别把规矩念好几遍。
 *
 * 2026-11-02 姐姐的反馈：「多张图片进来会一直不停强调图片规矩，
 * 我觉得这个可以省一点，在最后一行留一个就行」。
 *
 * 原因：每条消息的正文都拼了一份 IMAGE_RULES + 一句「一共有 N 张图片」+ 收藏规则，
 * 合并窗口直接 join —— 三张图念三遍。现在先剥掉、最后按真实情况重拼一份。
 *
 * 顺带锁住收藏规则的默认行为：以前没配 faceCollectHint 就写「不要收藏图片」，
 * 于是默认一张都不收 —— 姐姐说的「它不会收藏我发的表情包」。
 */
import assert from 'node:assert/strict'
import { mergeBodies } from '../src/shared/merge-body.js'
import { faceCollectRule, IMAGE_RULES } from '../src/prompts.js'

let n = 0
const ok = (msg) => console.log(`${String(++n).padStart(2)} ${msg}  ✅`)

const imageBody = (count, path) =>
  [
    '[现在是 2026-11-02 周一 21:00]',
    '@小肥鱼 看这个',
    `[一共有 ${count} 张图片，图已经随这条消息一起给你了，直接看。]`,
    `  （原图：${path}）`,
    IMAGE_RULES,
  ].join('\n')

/* ① 单条不动 */
{
  const one = mergeBodies(['就一句'], {})
  assert.equal(one, '就一句')
  assert.equal(mergeBodies([]), '')
  ok('单条 / 空数组原样返回')
}

/* ② 三条图片消息合并：规矩只留一份 */
{
  const bodies = [
    imageBody(1, 'D:/a.jpg'),
    imageBody(1, 'D:/b.jpg'),
    imageBody(1, 'D:/c.jpg'),
  ]
  const merged = mergeBodies(bodies, { imageCount: 3 })
  const rules = merged.split(IMAGE_RULES).length - 1
  assert.equal(rules, 1, `图片规矩应该只出现一次，实际 ${rules} 次`)
  const sums = merged.match(/一共(?:有)? \d+ 张图片/g) ?? []
  assert.equal(sums.length, 1, `张数汇总应该只有一句，实际 ${sums.length} 句：${sums.join(' / ')}`)
  assert.ok(merged.includes('3 张图片'), `张数要按这一轮算（3），实际：${sums[0]}`)
  ok('三条图片消息 → 规矩和汇总各只留一份')
}

/* ③ 正文不会被吃掉 */
{
  const bodies = [imageBody(1, 'D:/a.jpg'), imageBody(1, 'D:/b.jpg')]
  bodies[0] = bodies[0].replace('@小肥鱼 看这个', '@小肥鱼 第一张')
  bodies[1] = bodies[1].replace('@小肥鱼 看这个', '@小肥鱼 第二张')
  const merged = mergeBodies(bodies, { imageCount: 2 })
  assert.ok(merged.includes('第一张'), '第一条正文要留着')
  assert.ok(merged.includes('第二张'), '第二条正文要留着')
  ok('合并只剥规矩，正文一句不少')
}

/* ④ 原图路径保留（转图失败时靠它 read_image 兜底） */
{
  const bodies = [imageBody(1, 'D:/a.jpg'), imageBody(1, 'D:/b.jpg')]
  const merged = mergeBodies(bodies, { imageCount: 2 })
  assert.ok(merged.includes('D:/a.jpg'), 'a 的路径要留着')
  assert.ok(merged.includes('D:/b.jpg'), 'b 的路径要留着')
  ok('（原图：…）都保留')
}

/* ⑤ 没有图时不追加图片规矩 */
{
  const merged = mergeBodies(['第一句', '第二句'], { imageCount: 0 })
  assert.ok(!merged.includes(IMAGE_RULES), '没图不该出现图片规矩')
  assert.ok(merged.includes('第一句') && merged.includes('第二句'))
  ok('没图的合并不加图片规矩')
}

/* ⑥ 收藏规则：合并后只留一份，且没图时不留 */
{
  const faceRule = faceCollectRule({})
  const bodies = [imageBody(1, 'D:/a.jpg'), imageBody(1, 'D:/b.jpg')]
  const merged = mergeBodies(bodies, { imageCount: 2, faceRule })
  assert.equal(merged.split(faceRule).length - 1, 1, '收藏规则应该只出现一次')

  const noImg = mergeBodies(['一句话'], { imageCount: 0, faceRule })
  assert.ok(!noImg.includes(faceRule), '没图不该提收藏')
  ok('收藏规则合并后只留一份')
}

/* ⑦ 收藏规则默认**允许**收，不再一上来就说"不要收藏" */
{
  const noHint = faceCollectRule({})
  assert.ok(!/不要收藏图片/.test(noHint), `默认不该禁止收藏：${noHint}`)
  assert.ok(/收/.test(noHint), '应该提到收藏')
  assert.ok(/主人/.test(noHint), '应该说明「主人让你收就必须收」')
  assert.ok(/表情包/.test(noHint), '应该说明什么算表情包')

  // 配了 hint 就只收那类
  const withHint = faceCollectRule({ faceCollectHint: '二次元猫猫表情' })
  assert.ok(withHint.includes('二次元猫猫表情'))
  assert.ok(/主人明确让你收/.test(withHint), '配了 hint 也要保留「主人让收必须收」')
  ok('收藏规则：默认自己能判断；配了 hint 就只收那类；两种情况都保留「主人让收必须收」')
}

/* ⑧ 连续空行压成一个 */
{
  const merged = mergeBodies(['a', 'b', 'c'], { imageCount: 0 })
  assert.ok(!/\n{3,}/.test(merged), `不该有连续三个换行：${JSON.stringify(merged)}`)
  ok('连续空行会被压掉')
}

console.log('\n全部通过')
