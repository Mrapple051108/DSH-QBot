/**
 * 表情包收藏的管理口（设置页那一片）：显示 / 改描述 / 增 / 删 / 预览越界。
 *   node test/faces-admin.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
	keepFace,
	facesSnapshot,
	updateFace,
	removeFace,
	addFaceFromDataUrl,
	faceImagePath,
	facesDir,
	faceKeyOf,
} from '../src/faces.js'

let pass = 0
const ok = (label) => {
	pass += 1
	console.log(`${label}  ✅`)
}

const tmp = mkdtempSync(join(tmpdir(), 'faces-'))
const config = { workspaceRoot: tmp, faceRoot: '' }
const PNG_1X1 =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

try {
	/* ① 加两张（其中一张描述为空） */
	{
		const a = join(tmp, 'a.png')
		const b = join(tmp, 'b.png')
		writeFileSync(a, Buffer.from('89504e470d0a1a0a', 'hex'))
		writeFileSync(b, Buffer.from('89504e470d0a1a0a', 'hex'))
		// embed 传 null：只测落盘和清单，不碰模型
		const r1 = await keepFace(config, { path: a, summary: '猫猫干饭', tags: ['猫', '干饭'] }, null)
		const r2 = await keepFace(config, { path: b, summary: '' }, null)
		assert.equal(r1.ok, true)
		assert.equal(r2.ok, true)

		const snap = facesSnapshot(config)
		assert.equal(snap.total, 2)
		assert.equal(snap.list.length, 2)
		assert.equal(snap.withVec, 0, '没有 embed 就不该有向量')
		const first = snap.list[0]
		assert.equal(first.summary, '猫猫干饭')
		assert.deepEqual(first.tags, ['猫', '干饭'])
		assert.ok(first.preview.startsWith('/api/dsh-qq/face-file?id='), '图片条目要给预览地址')
		assert.ok(first.file.endsWith('.png'))
		assert.equal(first.hasVec, false)
		assert.equal(first.missing, false)
		ok('① 能列出收藏（摘要 / 标签 / 预览地址 / 有没有向量）')
	}

	/* ② 改描述：写盘成功，且 id 不变 */
	{
		const before = facesSnapshot(config).list[0]
		const r = await updateFace(config, before.id, { summary: '猫抱着饭碗干饭', tags: ['猫', '饭'] }, null)
		assert.equal(r.ok, true)
		const after = facesSnapshot(config).list[0]
		assert.equal(after.id, before.id, '改描述不该改 id')
		assert.equal(after.summary, '猫抱着饭碗干饭')
		assert.deepEqual(after.tags, ['猫', '饭'])
		ok('② 改描述和标签（id 稳定）')
	}

	/* ③ 删一条：条目没了，本地文件也删了 */
	{
		const list = facesSnapshot(config).list
		const target = list.find((f) => f.summary === '')
		const fileBefore = join(facesDir(config), target.file)
		assert.equal(existsSync(fileBefore), true, '删之前文件应该在')
		const r = removeFace(config, target.id)
		assert.equal(r.ok, true)
		assert.equal(r.removed, true)
		assert.equal(existsSync(fileBefore), false, '删条目要连文件一起删')
		assert.equal(facesSnapshot(config).total, 1)
		ok('③ 删一条：条目和本地图片一起删')
	}

	/* ④ 网页上传：dataURL → 落盘 → 进收藏 */
	{
		const r = await addFaceFromDataUrl(config, { name: '上传的.png', dataUrl: PNG_1X1, summary: '一个小方块' }, null)
		assert.equal(r.ok, true, r.error)
		assert.equal(r.added, true)
		const snap = facesSnapshot(config)
		assert.equal(snap.total, 2)
		assert.ok(snap.list.some((f) => f.summary === '一个小方块'))
		ok('④ 上传 dataURL 能进收藏')
	}

	/* ⑤ 拒收：不是图 / 空图 */
	{
		const bad1 = await addFaceFromDataUrl(config, { dataUrl: 'data:text/plain;base64,aGk=' }, null)
		assert.equal(bad1.ok, false)
		const bad2 = await addFaceFromDataUrl(config, { dataUrl: 'data:image/png;base64,' }, null)
		assert.equal(bad2.ok, false)
		ok('⑤ 只认图片 dataURL，空图拒收')
	}

	/* ⑥ 预览接口的越界校验 */
	{
		const snap = facesSnapshot(config)
		const one = snap.list.find((f) => f.kind === 'image')
		assert.ok(faceImagePath(config, one.id), '自己目录里的图要放行')

		// 伪造一条指向收藏目录外面的条目
		const cfgFile = join(tmp, '表情包收藏.json')
		const list = JSON.parse(readFileSync(cfgFile, 'utf8'))
		list.push({ kind: 'image', path: join(tmp, '外面.png'), summary: '越界' })
		writeFileSync(cfgFile, JSON.stringify(list, null, 2))
		writeFileSync(join(tmp, '外面.png'), Buffer.from('x'))
		assert.equal(faceImagePath(config, faceKeyOf(list[list.length - 1])), '', '目录外的文件不许读')
		ok('⑥ 预览只放行「表情包/」目录里的文件')
	}
} finally {
	rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n全部通过（${pass} 组）`)
