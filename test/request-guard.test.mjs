/**
 * 回归测试：白嫖请求识别。
 *
 * 事故（2026-11-02）：群里一天 173 条消息，其中一堆「帮我画个图」「检索一下」，
 * 每条都是一轮完整 LLM 调用，产出多半是查不到 —— 纯烧钱。
 *
 * 判据只有一条：**产出型**。让人画图 / 查资料 / 算东西 / 写代码 / 翻译长文，那是替他干活；
 * 「这个报错怎么修」「你为什么不理我」是求助和搭话，**不能**一起打死 ——
 * 把真心求助的人也骂了，那才是人设崩。
 */
import assert from 'node:assert/strict'
import { matchRequest, compilePatterns, buildRequestPrompt } from '../src/request-guard.js'

let n = 0
const ok = (msg) => console.log(`${String(++n).padStart(2)} ${msg}  ✅`)
const hit = (t) => Boolean(matchRequest(t))
const miss = (t) => !matchRequest(t)

/** 11-02 日志里那几条真实的白嫖请求 —— 必须全部命中 */
const REAL = [
  '@机器人 原神11月剧诗月谕模式一图流攻略',
  '@机器人 发图片',
  '@机器人 绘制同步发电机的相量图',
  '@机器人 绘制原神7.2幽境危战攻略图',
]

/* ① 真实日志回归：至少 3/4 命中（"发图片"是让我发图不是画图，属于发送不是产出） */
{
  const hits = REAL.filter(hit)
  console.log(`   命中 ${hits.length}/${REAL.length}：`)
  for (const t of REAL) console.log(`     ${hit(t) ? '✔' : '✘'} ${t}`)
  assert.ok(hits.length >= 3, `真实请求至少要命中 3 条，实际 ${hits.length}`)
  assert.ok(hit('@机器人 绘制同步发电机的相量图'), '"绘制…相量图" 必须命中')
  assert.ok(hit('@机器人 绘制原神7.2幽境危战攻略图'), '"绘制…攻略图" 必须命中')
  assert.ok(hit('@机器人 原神11月剧诗月谕模式一图流攻略'), '"一图流攻略" 必须命中')
  ok('11-02 日志里的真实请求能认出来')
}

/* ② 各种换着说法的产出型请求 */
{
  const cases = [
    '帮我画个流程图',
    '帮我生成一份方案',
    '做张海报',
    '给张思维导图',
    '查一下今天的天气',
    '搜一下这个报错',
    '计算一下这个积分',
    '推导一下这个公式',
    '写段代码给我',
    '帮我翻译一下这段英文',
    '总结一下这篇文章',
  ]
  for (const t of cases) assert.ok(hit(t), `应该命中：${t}`)
  ok(`产出型请求 ${cases.length} 条全部命中`)
}

/* ③ 求助 / 搭话 / 闲聊 —— 一条都不许命中 */
{
  const cases = [
    '这个报错怎么修',
    '你为什么不动了',
    '今天好热啊',
    '在吗',
    '哈哈哈哈',
    '我昨天晚上加的一些东西应该算是读取到了',
    '记忆库当检索工具用',
    '这个群里面要 @ 才会触发，到点就跑路后面不回了',
    'u r lying!',
    '图',
    '算一下',
    '你觉得这个怎么样',
    '能不能便宜点',
  ]
  for (const t of cases) assert.ok(miss(t), `不该命中：${t}`)
  ok(`求助/搭话 ${cases.length} 条全部不命中（不误伤）`)
}

/* ④ 太短的一律当搭话 */
{
  assert.equal(matchRequest('画图'), null, '两个字太短')
  assert.equal(matchRequest(''), null)
  assert.equal(matchRequest(null), null)
  assert.equal(matchRequest(undefined), null)
  ok('空 / 太短的消息不判为白嫖')
}

/* ⑤ 用户自己填的正则：能生效、写错了不炸 */
{
  assert.equal(matchRequest('给我来一段相声', []), null, '没配额外正则时不该命中')
  const extra = ['来一段相声']
  assert.ok(matchRequest('给我来一段相声啊', extra), '额外正则应生效')
  const bad = compilePatterns(['([', '正常'], { warn() {} })
  assert.equal(bad.length, 1, '坏正则要被跳过')
  assert.doesNotThrow(() => matchRequest('说点什么', ['(['], { warn() {} }))
  ok('额外正则生效；写错的正则跳过且不抛')
}

/* ⑥ 提示词：三种策略各自的关键句 */
{
  const refuse = buildRequestPrompt({ policy: 'refuse', text: '帮我画个图' })
  assert.ok(refuse.includes('帮我画个图'), '要引用原话')
  assert.ok(refuse.includes('白嫖'), '要点明白嫖')
  assert.ok(refuse.includes('别给替代方案'), '不许给替代方案')
  assert.ok(!refuse.includes('骂回去'), 'refuse 不该要求骂人')

  const punishYield = buildRequestPrompt({ policy: 'punish', text: '帮我画个图', behavior: 'yield' })
  assert.ok(punishYield.includes('甩出来'), 'yield 惩罚：把火气甩出来')
  assert.ok(!punishYield.includes('脏字'), 'yield 不提脏字')

  const punishFight = buildRequestPrompt({ policy: 'punish', text: '帮我画个图', behavior: 'fight' })
  assert.ok(punishFight.includes('脏字'), 'fight 惩罚：允许脏字')
  assert.ok(punishFight.includes('人身攻击'), 'fight 惩罚：允许人身攻击')
  ok('三策略的提示词各自到位')
}

console.log('\n全部通过')
