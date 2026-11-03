/**
 * 面板情绪档位自检：烦躁度 → 平静 / 烦躁 / 愤怒 / 跑路。
 *   node test/mood.test.mjs
 */
import assert from 'node:assert/strict'
import { moodOf } from '../src/settings.js'

let pass = 0
const ok = (label) => {
  pass += 1
  console.log(`${label}  ✅`)
}

const T = { calm: 30, anger: 50, escape: 70 }

/* 四档边界：低于阈值算下一档，等于阈值就已经进档 */
{
	const cases = [
		[0, 'calm', '平静'],
		[29, 'calm', '平静'],
		[30, 'annoyed', '烦躁'],
		[49, 'annoyed', '烦躁'],
		[50, 'angry', '愤怒'],
		[69, 'angry', '愤怒'],
		[70, 'escape', '跑路'],
		[100, 'escape', '跑路'],
	]
	for (const [v, key, label] of cases) {
		const m = moodOf({ ignite: v, phase: 'hot' }, T)
		assert.equal(m.key, key, `${v} 应该是 ${key}，实际 ${m.key}`)
		assert.equal(m.label, label)
		assert.equal(m.value, v)
	}
	ok('① 四档边界对（<calm / ≥calm / ≥anger / ≥escape）')
}

/* 已经在无视冷窗里：不管分值多少都显示跑路中 */
{
	const m = moodOf({ ignite: 0, phase: 'ignore' }, T)
	assert.equal(m.key, 'gone')
	assert.equal(m.label, '跑路中')
	assert.match(m.hint, /无视/)
	ok('② 无视冷窗里显示「跑路中」')
}

/* 阈值缺省 / 乱序都要稳：不能算出「愤怒 < 烦躁」这种倒挂 */
{
	const m1 = moodOf({ ignite: 40 }, {})
	assert.equal(m1.key, 'annoyed', '没给阈值时用默认 30/50/70')

	const weird = moodOf({ ignite: 40 }, { calm: 60, anger: 20, escape: 90 })
	assert.ok(weird.key !== 'angry', 'calm 比 anger 还大时不能判成愤怒')
	ok('③ 缺省阈值、乱序阈值都不倒挂')
}

/* 空输入不炸 */
{
	assert.equal(moodOf(undefined, undefined).label, '平静')
	assert.equal(moodOf({ ignite: 'abc' }, T).value, 0)
	ok('④ 空输入不炸')
}

console.log(`\n全部通过（${pass} 组）`)
