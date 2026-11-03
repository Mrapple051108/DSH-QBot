/**
 * RSA 命令通道。
 *
 * 2026-11-02 姐姐要的：群里（或私聊）不再响应明文 `/reset` 这类命令，
 * 只认用公钥加密过的 `#ENC:<base64>`。公钥在群聊设置页里看，加密也在那个页面里做。
 *
 * 防的是**群里其他人**：他们看得见密文，但没有私钥解不开，也伪造不出有效的。
 * 防不了这台机器上的人 —— 私钥就躺在本机明文 json 里，能在本机翻文件的人本来就能看所有东西。
 * 这一点写在文档里，别把它当成比本机权限更强的保护。
 *
 * 算法：RSA-2048 + OAEP(SHA-256)。选 OAEP 不选 PKCS#1 v1.5 —— 后者有已知的填充攻击，
 * 虽然这里不涉及"解密预言机"，但没必要用一个过时的填充方案。
 */
import { generateKeyPairSync, privateDecrypt, constants } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 命令前缀。写成 #ENC: 而不是 /enc —— 后者在群里太显眼，而且容易被别的机器人当命令。 */
export const ENC_PREFIX = '#ENC:'

/** 群号/QQ 号当文件名：只留数字，别的一律替换掉，防目录穿越。 */
function safeName(peerId) {
  const s = String(peerId ?? '').replace(/[^\d]/g, '')
  return s || 'default'
}

function keyFile(dir, peerId) {
  return join(dir, `${safeName(peerId)}.json`)
}

/**
 * 读已有的密钥对。
 * @returns {{publicKey:string, privateKey:string, createdAt:number, peerId:string}|null}
 */
export function readKeyPair(dir, peerId) {
  const file = keyFile(dir, peerId)
  try {
    if (!existsSync(file)) return null
    const j = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof j?.publicKey !== 'string' || typeof j?.privateKey !== 'string') return null
    return {
      publicKey: j.publicKey,
      privateKey: j.privateKey,
      createdAt: Number(j.createdAt) || 0,
      peerId: String(peerId ?? ''),
    }
  } catch {
    return null
  }
}

/** 生成一对新密钥并落盘（覆盖旧的）。旧的密文从此解不开，所以页面上要二次确认。 */
export function resetKeyPair(dir, peerId) {
  mkdirSync(dir, { recursive: true })
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const record = {
    peerId: String(peerId ?? ''),
    algorithm: 'RSA-2048/OAEP-SHA256',
    createdAt: Date.now(),
    publicKey,
    privateKey,
  }
  writeFileSync(keyFile(dir, peerId), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return { publicKey, privateKey, createdAt: record.createdAt, peerId: record.peerId }
}

/** 有就用，没有就生成。 */
export function ensureKeyPair(dir, peerId) {
  return readKeyPair(dir, peerId) ?? resetKeyPair(dir, peerId)
}

/**
 * 从一条消息里抠出密文。
 *
 * 认两种写法：单独的 `#ENC:xxx`，或者句子里夹着的（`#ENC:xxx` 前后有空格/中文都行）。
 * base64 里可能有 `+/=`，所以不能按空白切 —— 用正则吃到第一个非 base64 字符为止。
 *
 * @returns {string|null} base64（不含前缀）
 */
export function parseEncrypted(text) {
  const t = String(text ?? '')
  const at = t.indexOf(ENC_PREFIX)
  if (at < 0) return null
  const rest = t.slice(at + ENC_PREFIX.length)
  const m = rest.match(/^[A-Za-z0-9+/=\s]+/)
  if (!m) return null
  const b64 = m[0].replace(/\s+/g, '')
  return b64.length >= 16 ? b64 : null
}

/**
 * 解开一条密文命令。
 *
 * 解不开一律返回 `null` —— 调用方拿到 null 就该**静默忽略**，
 * 别回"解密失败"。回了就等于告诉对方"这条路是对的，继续猜"。
 *
 * @returns {string|null} 明文命令（已 trim）
 */
export function decryptCommand(dir, peerId, b64) {
  const pair = readKeyPair(dir, peerId)
  if (!pair) return null
  try {
    const buf = Buffer.from(String(b64 ?? ''), 'base64')
    if (buf.length === 0) return null
    const out = privateDecrypt(
      {
        key: pair.privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      buf,
    )
    const text = out.toString('utf8').trim()
    return text || null
  } catch {
    // 钥匙不对 / 密文被改 / 用了别的填充 —— 都是这一条
    return null
  }
}

/** 已经配了哪些群（页面上列出来方便管理）。 */
export function listKeyPeers(dir) {
  try {
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
  } catch {
    return []
  }
}

/**
 * 命令清单。页面上那个 help 按钮和 `/help` 命令共用这一份，
 * 免得两边对不上（改一处忘另一处是这类清单最常见的死法）。
 */
export const COMMAND_HELP = [
  { cmd: '/reset  #reset  /new  #new', desc: '清空上下文重新开始（会带一段交接，不是全忘）' },
  { cmd: '/status  #status', desc: '看一眼当前会话状态' },
  { cmd: '/cwd  #cwd', desc: '当前会话的目录在哪' },
  { cmd: '/help  #help', desc: '这份命令清单' },
]

/**
 * 生成给页面的加密提示（说明怎么用）。
 * 真正的加密在浏览器里用 WebCrypto 做，私钥不出机器。
 */
export function encExample() {
  return `${ENC_PREFIX}<base64>`
}
