/**
 * 回归测试：每群设置的地基。
 *
 * 2026-11-02 姐姐要的：全局设置之外，每个群能单独调脾气，
 * 每一项都可以「跟随全局」或者单独设。
 *
 * 语义只有一条：**该键在 groupOverrides[群号] 里不存在 = 跟随全局**。
 */
import assert from 'node:assert/strict'
import {
  createGroupConfig,
  canOverridePerGroup,
  readThresholds,
  shapeScore,
  GROUP_OVERRIDABLE,
} from '../src/group-settings.js'

let n = 0
const ok = (msg) => console.log(`${String(++n).padStart(2)} ${msg}  ✅`)

/* ① 没有覆盖 → 返回全局对象本身（热路径零开销，=== 断言） */
{
  const config = { groupWakeMs: 60000, groupOverrides: {} }
  const cfg = createGroupConfig(config)
  assert.equal(cfg.for('770375717'), config, '没覆盖时必须是同一个对象')
  assert.equal(cfg.for(undefined), config)
  assert.equal(cfg.for(''), config)
  ok('没有覆盖 → 原样返回全局 config（不是复制）')
}

/* ② 有覆盖 → 覆盖的键用群里的，其余跟全局 */
{
  const config = {
    groupWakeMs: 60000,
    rhythmHotMaxMs: 150000,
    groupOverrides: { 770375717: { groupWakeMs: 180000 } },
  }
  const cfg = createGroupConfig(config)
  const g = cfg.for('770375717')
  assert.equal(g.groupWakeMs, 180000, '群里的值优先')
  assert.equal(g.rhythmHotMaxMs, 150000, '没覆盖的跟全局')
  assert.equal(config.groupWakeMs, 60000, '不能改到全局')
  ok('群覆盖优先，其它字段跟全局')
}

/* ③ 另一个群不受影响 */
{
  const config = { groupWakeMs: 60000, groupOverrides: { 1: { groupWakeMs: 180000 } } }
  const cfg = createGroupConfig(config)
  assert.equal(cfg.for('1').groupWakeMs, 180000)
  assert.equal(cfg.for('2'), config, '别的群回到全局对象')
  ok('一个群的配置不会串到别的群')
}

/* ④ 缓存：同一份 patch 复用同一个 proxy；patch 换了要重建 */
{
  const patch = { groupWakeMs: 1 }
  const config = { groupWakeMs: 60000, groupOverrides: { 9: patch } }
  const cfg = createGroupConfig(config)
  const a = cfg.for('9')
  const b = cfg.for('9')
  assert.equal(a, b, '同一次配置应该复用 proxy')

  config.groupOverrides['9'] = { groupWakeMs: 2 }
  const c = cfg.for('9')
  assert.notEqual(a, c, 'patch 换掉之后要重建')
  assert.equal(c.groupWakeMs, 2)
  ok('proxy 有缓存，且 patch 变了会失效')
}

/* ⑤ isFollowing / overridesOf / hasAny / invalidate */
{
  const config = { groupOverrides: { 5: { groupWakeMs: 1000, requestPolicy: 'punish' } } }
  const cfg = createGroupConfig(config)
  assert.equal(cfg.isFollowing('5', 'groupWakeMs'), false)
  assert.equal(cfg.isFollowing('5', 'rhythmHotMaxMs'), true, '没配过的就是跟随')
  assert.equal(cfg.isFollowing('6', 'anything'), true, '没这个群也算跟随')
  assert.deepEqual(cfg.overridesOf('5'), { groupWakeMs: 1000, requestPolicy: 'punish' })
  assert.deepEqual(cfg.overridesOf('6'), {})
  assert.equal(cfg.hasAny(), true)
  assert.equal(createGroupConfig({ groupOverrides: {} }).hasAny(), false)
  cfg.invalidate()
  ok('isFollowing / overridesOf / hasAny / invalidate')
}

/* ⑥ 白名单管着「哪些能按群配」 */
{
  assert.equal(canOverridePerGroup('groupWakeMs'), true)
  assert.equal(canOverridePerGroup('requestPolicy'), true)
  assert.equal(canOverridePerGroup('rsaEnabled'), true)
  // 连接类不许按群配：改错一个群能把整只鱼搞崩
  assert.equal(canOverridePerGroup('wsUrl'), false)
  assert.equal(canOverridePerGroup('selfId'), false)
  assert.equal(canOverridePerGroup('personaFile'), false)
  assert.equal(canOverridePerGroup('workspaceRoot'), false)
  ok('连接类配置不允许按群覆盖')
}

/* ⑦ 三阈值夹逼：乱填也得是 冷静 < 愤怒 < 逃离 */
{
  assert.deepEqual(readThresholds({}), { calm: 30, anger: 50, escape: 70 })
  assert.deepEqual(
    readThresholds({ ignoreCalmThreshold: 10, ignoreAngerThreshold: 20, ignoreEscapeThreshold: 90 }),
    { calm: 10, anger: 20, escape: 90 },
  )
  // 全填 80：愤怒必须落回逃离下面，逃离必须落回 100 以内
  const wild = readThresholds({
    ignoreCalmThreshold: 80,
    ignoreAngerThreshold: 80,
    ignoreEscapeThreshold: 80,
  })
  assert.ok(wild.calm < wild.anger && wild.anger < wild.escape, JSON.stringify(wild))
  // 逃离比冷静还小
  const inv = readThresholds({ ignoreCalmThreshold: 60, ignoreEscapeThreshold: 40 })
  assert.ok(inv.calm < inv.escape, JSON.stringify(inv))
  // 负数 / NaN / 字符串
  const junk = readThresholds({ ignoreCalmThreshold: -5, ignoreAngerThreshold: 'x', ignoreEscapeThreshold: NaN })
  assert.ok(junk.calm >= 1 && junk.calm < junk.anger && junk.anger < junk.escape)
  ok('三阈值永远合法（冷静 < 愤怒 < 逃离）')
}

/* ⑧ 曲线：单调、端点固定、形状符合描述 */
{
  const pts = [0, 10, 25, 50, 75, 90, 100]
  for (const curve of ['linear', 'fast-slow', 'slow-fast']) {
    assert.equal(shapeScore(0, curve), 0, `${curve} 在 0 处应为 0`)
    assert.ok(Math.abs(shapeScore(100, curve) - 100) < 1e-9, `${curve} 在 100 处应为 100`)
    let prev = -1
    for (const p of pts) {
      const v = shapeScore(p, curve)
      assert.ok(v >= prev, `${curve} 应该单调不降：${p} → ${v}`)
      prev = v
    }
  }
  // 先快后慢：中间点要高于线性
  assert.ok(shapeScore(25, 'fast-slow') > 25, '先快后慢：小刺激就该明显')
  // 先慢后快：中间点要低于线性
  assert.ok(shapeScore(25, 'slow-fast') < 25, '先慢后快：小刺激不怎么在意')
  assert.equal(shapeScore(25, 'linear'), 25)
  // 脏输入
  assert.equal(shapeScore('abc'), 0)
  assert.equal(shapeScore(-10), 0)
  assert.equal(shapeScore(999, 'linear'), 100)
  ok('三种曲线单调、端点对齐、形状对得上名字')
}

/* ⑨ 白名单里没有重复项（复制粘贴最容易出的错） */
{
  assert.equal(new Set(GROUP_OVERRIDABLE).size, GROUP_OVERRIDABLE.length, '白名单有重复项')
  ok(`GROUP_OVERRIDABLE 共 ${GROUP_OVERRIDABLE.length} 项，无重复`)
}

console.log('\n全部通过')
