/**
 * 掷骰子提示发表情包（2026-11-03）。
 *   node test/face-cue.test.mjs
 */
import assert from 'node:assert/strict'
import { rollFaceCue, shouldCueFace, appendFaceCue, FACE_CUE_HINT } from '../src/shared/face-cue.js'

let pass = 0
const ok = (label) => {
  pass += 1
  console.log(`${label}  ✅`)
}

/* ① 边界：0 / 100 / 关掉 */
{
	assert.equal(rollFaceCue({ chance: 0, random: () => 0 }), false, '0% 掷中说明算错了')
	assert.equal(rollFaceCue({ chance: 100, random: () => 0.999 }), true, '100% 必须中')
	assert.equal(rollFaceCue({ enabled: false, chance: 100, random: () => 0 }), false, '开关关了就永不中')
	assert.equal(rollFaceCue({ chance: 25, random: () => 0.2499 }), true, '0.2499 < 0.25 该中')
	assert.equal(rollFaceCue({ chance: 25, random: () => 0.25 }), false, '0.25 不该中（左闭右开）')
	assert.equal(rollFaceCue({ chance: 25, random: () => 0.99 }), false)
	ok('① 0% / 100% / 关掉 / 边界值')
}

/* ② 脏输入不炸 */
{
	assert.equal(rollFaceCue({ chance: 'abc' }), false, '非数字当 0')
	assert.equal(rollFaceCue({ chance: -5, random: () => 0 }), false, '负数当 0')
	assert.equal(rollFaceCue({ chance: 150, random: () => 0.9 }), true, '超过 100 当 100')
	assert.equal(typeof rollFaceCue({}), 'boolean', '没参数也要给个布尔')
	const boom = () => {
		throw new Error('random 炸了')
	}
	assert.equal(typeof rollFaceCue({ chance: 50, random: boom }), 'boolean', 'random 抛错要能兜住')
	ok('② 脏输入 / 抛错的 random 都不炸')
}

/* ③ 三个闸：收藏空、发不出去、开关 */
{
	assert.equal(shouldCueFace({ chance: 100, facesCount: 0, random: () => 0 }), false, '收藏是空的就别提示')
	assert.equal(shouldCueFace({ chance: 100, facesCount: 3, sendAllowed: false, random: () => 0 }), false, '刚发过就别提示')
	assert.equal(shouldCueFace({ chance: 100, facesCount: 3, sendAllowed: true, random: () => 0 }), true)
	assert.equal(shouldCueFace({ enabled: false, chance: 100, facesCount: 3, random: () => 0 }), false)
	ok('③ 收藏空 / 发不出去 / 开关关了都不提示')
}

/* ④ 拼正文 */
{
	const body = '好吧，那就这样。'
	const out = appendFaceCue(body)
	assert.ok(out.startsWith(body), '原文要在前面')
	assert.ok(out.includes(FACE_CUE_HINT), '提示段要接在后面')
	assert.equal(appendFaceCue('', 'X'), 'X', '空正文就只剩提示')
	assert.equal(appendFaceCue('a', ''), 'a', '空提示不动正文')
	ok('④ 提示段接在正文后面')
}

/* ⑤ 概率真的是 25%（统计口径，允许 ±3%） */
{
	let hit = 0
	const N = 40000
	for (let i = 0; i < N; i++) if (rollFaceCue({ chance: 25 })) hit += 1
	const rate = (hit / N) * 100
	assert.ok(Math.abs(rate - 25) < 3, `25% 跑出来是 ${rate.toFixed(2)}%，偏太多`)
	console.log(`     实测 ${rate.toFixed(2)}%（n=${N}）`)
	ok('⑤ 25% 的概率确实落在 25% 附近')
}

console.log(`\n全部通过（${pass} 组）`)
