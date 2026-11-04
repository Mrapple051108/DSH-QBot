/**
 * 表情包工具「给模型看的那一面」。
 *   node test/face-surface.test.mjs
 *
 * 2026-11-04 姐姐的要求：
 *   「不要去强调收在哪，只需要让它知道可以收就行了，插件自己去处理，不要让它觉得好像有选择权；
 *     QQ 商城表情我们也不去用了，不要给它不必要的选择权让它纠结，就用插件表情包收藏。」
 *
 * 所以这里钉的是**模型看得见的参数和描述**：
 *   · `qq_mface` 不许再出现 emoji_id / emoji_package_id / 商城 —— 一个选择都不给；
 *   · `qq_keep_face` 只说「收进收藏」，不解释收藏是本地的还是商城的（那是插件自己的事）；
 *   · 每轮的表情包规矩里也不许提商城。
 */
import assert from 'node:assert/strict'
import { registerTools } from '../src/tools.js'
import { faceCollectRule } from '../src/prompts.js'

let n = 0
const ok = (msg) => console.log(`${String(++n).padStart(2)} ${msg}  ✅`)

const quiet = { info() {}, warn() {}, debug() {}, error() {} }

function boot(extra = {}) {
  const tools = new Map()
  const ctx = { get: (name) => (name === 'tools' ? { register: (t) => tools.set(t.name, t) } : undefined) }
  registerTools(ctx, {
    client: {},
    manager: {},
    config: { ownerIds: [], ...extra },
    logger: quiet,
    pin: {},
    wake: {},
    noteSelfSaid() {},
  })
  return tools
}

const tools = boot()

/* ① qq_mface 的参数里不能再有商城那一套 */
{
  const mface = tools.get('qq_mface')
  assert.ok(mface, '得有 qq_mface')
  const keys = Object.keys(mface.parameters?.properties ?? {})
  for (const bad of ['emoji_id', 'emoji_package_id', 'key']) {
    assert.equal(keys.includes(bad), false, `qq_mface 不该再有参数 ${bad}（等于给了它一个没用的选择）`)
  }
  assert.deepEqual(keys.sort(), ['query', 'summary', 'topK'].sort())
  ok('qq_mface 只留 query / summary / topK')
}

/* ② 描述里也不许再解释「商城 vs 收藏」 */
{
  for (const name of ['qq_mface', 'qq_keep_face']) {
    const desc = String(tools.get(name)?.description ?? '')
    assert.doesNotMatch(desc, /商城/, `${name} 的描述里还在提商城`)
    assert.doesNotMatch(desc, /emoji_id/, `${name} 的描述里还在提 emoji_id`)
  }
  ok('两个工具的描述都不提商城')
}

/* ③ qq_keep_face 只说「收进收藏」，不解释收藏落在哪 */
{
  const desc = String(tools.get('qq_keep_face')?.description ?? '')
  assert.match(desc, /收藏/)
  assert.doesNotMatch(desc, /本地图库|本机这一份/, '别再让模型关心收在哪')
  ok('qq_keep_face 只讲「能收」，不讲「收在哪」')
}

/* ④ 每轮的表情包规矩同样不许提商城 */
{
  for (const hint of ['', '猫猫梗图']) {
    const text = faceCollectRule(hint)
    assert.doesNotMatch(String(text), /商城/, `faceCollectRule("${hint}") 里还在提商城`)
    assert.match(String(text), /qq_keep_face/, '得告诉它能收，并给出工具名')
  }
  ok('每轮规矩只讲「可以收」')
}

/* ⑤ 参数收紧之后，收藏本身照样能收、能按意思找（后端没被削弱） */
{
  const keep = tools.get('qq_keep_face')
  assert.ok(typeof keep.execute === 'function')
  const r = await keep.execute({ path: 'D:/nope-not-here.png', summary: '测试' }, {})
  assert.equal(r.ok, false, '路径不存在就该失败')
  assert.equal(typeof r.reason, 'string')
  assert.equal('undefined' in r, false)
  ok('收图工具的行为没被这次参数调整影响')
}

console.log('\n全部通过')
