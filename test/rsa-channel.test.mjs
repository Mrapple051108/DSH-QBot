/**
 * 回归测试：RSA 命令通道。
 *
 * 2026-11-02 姐姐要的：群里不响应明文 `/reset`，只认公钥加密过的 `#ENC:<base64>`。
 *
 * 三条铁律：
 *   ① 密文解不开就**静默忽略** —— 回一句"解密失败"等于告诉对方"这条路是对的"；
 *   ② 换个群号解不开（每个群一对钥匙）；
 *   ③ 明文命令压根不产生 token（`parseEncrypted` 返回 null），由调用方丢掉。
 */
import assert from 'node:assert/strict'
import { publicEncrypt, constants } from 'node:crypto'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  resetKeyPair,
  readKeyPair,
  ensureKeyPair,
  decryptCommand,
  parseEncrypted,
  listKeyPeers,
  ENC_PREFIX,
  COMMAND_HELP,
} from '../src/rsa-channel.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-rsa-'))
let n = 0
const ok = (msg) => console.log(`${String(++n).padStart(2)} ${msg}  ✅`)

const enc = (pem, plain) =>
  publicEncrypt(
    { key: pem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(plain, 'utf8'),
  ).toString('base64')

try {
  /* ① 生成 / 读取 / 复用 */
  const pair = resetKeyPair(dir, '770375717')
  assert.ok(pair.publicKey.startsWith('-----BEGIN PUBLIC KEY-----'))
  assert.ok(pair.privateKey.includes('BEGIN PRIVATE KEY'))
  assert.equal(pair.peerId, '770375717')
  assert.ok(existsSync(join(dir, '770375717.json')))

  const again = ensureKeyPair(dir, '770375717')
  assert.equal(again.publicKey, pair.publicKey, 'ensure 不能重新生成')
  assert.equal(readKeyPair(dir, '770375717').publicKey, pair.publicKey)
  assert.equal(readKeyPair(dir, 'nope'), null, '没配过的群返回 null')
  ok('生成 / 读取 / 复用都对')

  /* ② 加解密往返 */
  const token = enc(pair.publicKey, '/reset')
  assert.equal(decryptCommand(dir, '770375717', token), '/reset')
  const cn = enc(pair.publicKey, '/status 顺便看看')
  assert.equal(decryptCommand(dir, '770375717', cn), '/status 顺便看看', '中文也要能过')
  ok('加解密往返（含中文）')

  /* ③ 换群解不开 —— 每个群一对钥匙 */
  assert.equal(decryptCommand(dir, '1130590541', token), null, '别的群没有这把钥匙')
  ok('换个群号解不开')

  /* ④ 坏输入一律 null，绝不抛 */
  for (const bad of ['AAAA', '', 'not-base64!!!', 'x'.repeat(500)]) {
    assert.equal(decryptCommand(dir, '770375717', bad), null, `坏密文应该返回 null：${bad.slice(0, 12)}`)
  }
  ok('坏密文 / 空串都不抛，返回 null')

  /* ⑤ 密文被改动一位就解不开 */
  {
    const buf = Buffer.from(token, 'base64')
    buf[10] = buf[10] ^ 0xff
    assert.equal(decryptCommand(dir, '770375717', buf.toString('base64')), null)
    ok('密文被篡改就解不开')
  }

  /* ⑥ 明文字符串压根抽不出 token */
  for (const plain of ['/reset', '#reset', '/help', '帮我画个图', '']) {
    assert.equal(parseEncrypted(plain), null, `明文不该抽出 token：${plain}`)
  }
  ok('明文消息抽不出 token（调用方据此丢弃）')

  /* ⑦ 从带前后的句子里抽 */
  {
    const msg = `喂 ${ENC_PREFIX}${token} 快跑`
    assert.equal(parseEncrypted(msg), token)
    assert.equal(decryptCommand(dir, '770375717', parseEncrypted(msg)), '/reset')
    ok('夹在句子中间也能抽出来')
  }

  /* ⑧ 前后有空格 / 换行的 base64 要能拼回来 */
  {
    const broken = `${ENC_PREFIX}${token.slice(0, 100)}\n${token.slice(100)}`
    assert.equal(decryptCommand(dir, '770375717', parseEncrypted(broken)), '/reset')
    ok('密文被换行拆开也能还原')
  }

  /* ⑨ 重置之后旧密文作废、新密文可用 */
  {
    const before = resetKeyPair(dir, '770375717')
    const oldToken = enc(pair.publicKey, '/reset') // 用旧公钥加的
    assert.equal(decryptCommand(dir, '770375717', oldToken), null, '重置后旧密文必须失效')
    const newToken = enc(before.publicKey, '/reset')
    assert.equal(decryptCommand(dir, '770375717', newToken), '/reset')
    ok('重置钥匙后旧密文作废、新密文可用')
  }

  /* ⑩ 群号当文件名：非数字要被洗掉，防目录穿越 */
  {
    resetKeyPair(dir, '../../evil')
    const listed = listKeyPeers(dir)
    assert.ok(
      listed.every((name) => /^\d+$|^default$/.test(name)),
      `文件名只能剩数字：${listed.join(',')}`,
    )
    assert.ok(!listed.some((name) => name.includes('..')), '不能出现目录穿越')
    ok('非数字群号被洗掉，不会穿越目录')
  }

  /* ⑪ 命令清单跟 /help 是同一份 */
  assert.ok(Array.isArray(COMMAND_HELP) && COMMAND_HELP.length >= 4)
  assert.ok(COMMAND_HELP.some((c) => c.cmd.includes('/reset')))
  assert.ok(COMMAND_HELP.every((c) => c.cmd && c.desc))
  ok(`命令清单 ${COMMAND_HELP.length} 条，cmd/desc 都齐`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n全部通过')
