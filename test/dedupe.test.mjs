/**
 * 回归测试：同一条消息不能被处理两遍。
 *
 * 事故（2026-11-02）：群里一整段 prompt（时间戳 + 引用 + 群历史）原样出现两遍，
 * 日志里同一条 `← 群 …` 同一毫秒打两行。根因是旧 socket 没关 + 插件被重复 apply，
 * 两个连接/两个实例各收一份 NapCat 推送。这里锁住兜底那层的去重账本。
 */
import assert from 'node:assert/strict'
import { createSeenTracker, inboundKey } from '../src/shared/dedupe.js'

let n = 0
const ok = (msg) => console.log(`${String(++n).padStart(2)} ${msg}  ✅`)

/* ① 同一条消息第二次必须被挡 */
{
  const t = createSeenTracker()
  assert.equal(t.mark('g:1:100'), true, '第一次放行')
  assert.equal(t.mark('g:1:100'), false, '第二次丢掉')
  assert.equal(t.mark('g:1:101'), true, '换一条 id 又能进')
  assert.equal(t.mark('g:1:100'), false, '再来一次还是挡')
  ok('同一 message_id 只放行一次')
}

/* ② 空 key 一律放行（宁可重复，也别把没 id 的消息全吞了） */
{
  const t = createSeenTracker()
  assert.equal(t.mark(''), true)
  assert.equal(t.mark(''), true)
  assert.equal(t.mark(undefined), true)
  ok('没有 message_id 的消息不拦')
}

/* ③ 过期之后同一个 id 又放行（QQ 的 id 不是全局唯一，留太久会误杀） */
{
  let clock = 1_000_000
  const t = createSeenTracker({ ttl: 1000, now: () => clock })
  assert.equal(t.mark('k'), true)
  clock += 500
  assert.equal(t.mark('k'), false, 'TTL 内算同一条')
  clock += 600 // 累计 1100 > ttl
  assert.equal(t.mark('k'), true, '过 TTL 后重新放行')
  ok('过 TTL 后 id 复用不会被误杀')
}

/* ④ 账本有界：塞爆之后不会无限涨 */
{
  let clock = 0
  const t = createSeenTracker({ ttl: 10, max: 5, now: () => clock })
  for (let i = 0; i < 100; i += 1) {
    clock += 1
    t.mark(`k${i}`)
  }
  assert.ok(t.size() <= 5, `账本应该被压到 ≤5，实际 ${t.size()}`)
  ok('账本有上限，不会无限涨')
}

/* ⑤ 键怎么拼：不同群、不同人、不同消息类型都要分开 */
{
  const a = { message_type: 'group', group_id: 111, message_id: 7 }
  const b = { message_type: 'group', group_id: 222, message_id: 7 }
  const c = { message_type: 'private', user_id: 111, message_id: 7 }
  assert.equal(inboundKey(a), 'group:111:7')
  assert.equal(inboundKey(b), 'group:222:7')
  assert.equal(inboundKey(c), 'private:111:7')
  assert.notEqual(inboundKey(a), inboundKey(b), '不同群同一个 id 不能混为一谈')
  ok('群号 / 私聊号 / 消息类型都进键里')

  const t = createSeenTracker()
  assert.equal(t.mark(inboundKey(a)), true)
  assert.equal(t.mark(inboundKey(b)), true, '别的群里同号 id 不该被挡')
  assert.equal(t.mark(inboundKey(a)), false)
  ok('跨群同号 id 互不干扰')
}

/* ⑥ 缺字段 / 驼峰写法 */
{
  assert.equal(inboundKey(undefined), '')
  assert.equal(inboundKey({}), '')
  assert.equal(inboundKey({ messageId: 9, group_id: 1 }), ':1:9')
  assert.ok(inboundKey({ messageId: 9, message_type: 'group', group_id: 1 }).endsWith(':1:9'))
  ok('缺字段不炸，messageId 驼峰也认')
}

/* ⑦ 两个实例共享同一本账的效果（模拟"模块级"语义） */
{
  const shared = createSeenTracker()
  const instanceA = (ev) => (shared.mark(inboundKey(ev)) ? 'handled' : 'dropped')
  const instanceB = (ev) => (shared.mark(inboundKey(ev)) ? 'handled' : 'dropped')
  const ev = { message_type: 'group', group_id: 770375717, message_id: 424242 }
  assert.equal(instanceA(ev), 'handled')
  assert.equal(instanceB(ev), 'dropped', '第二个实例必须放手')
  ok('两个 client 实例同时收到同一条 → 只处理一次')
}

console.log('\n全部通过')
