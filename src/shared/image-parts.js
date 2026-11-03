import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'

/**
 * 把下载到本地的图片变成模型能直接看的 image content。
 *
 * 为什么非要走这条路：QQ 侧那个 agent 是 `agents.create` 建的，只拿到插件工具，
 * **preset 里的 tool-fs（含 read_image）根本没挂上来** —— 所以「把路径交给模型让它
 * 自己打开」在那边永远打不开，模型只能回一句「我看不见」。
 * 这里直接经 attachments 服务把图作为消息内容送进去，不依赖任何工具。
 *
 * 2026-11-01：从 inbound.js 里搬出来，因为群聊节奏（冷窗攒消息）也要用 ——
 * 攒着的那批图以前只留了 `[图片]` 占位，图本身丢在硬盘上没人看
 * （姐姐反馈「连发几张图只有一条被看见了」，就是这里）。
 */

const IMAGE_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

/** 默认一轮最多带几张图。一次塞太多会把上下文吃干净，而刷屏的图本来也没几张有用。 */
export const DEFAULT_MAX_IMAGES = 8

/**
 * @param {object} o
 * @param {object} o.ctx       cordis 上下文（用来 get('attachments')）
 * @param {object} [o.logger]
 * @param {() => number} [o.maxOf] 每轮最多带几张（每次现读，改设置立刻生效）
 * @returns {(paths: string[]) => Promise<object[]>}
 */
export function createImagePartsBuilder({ ctx, logger, maxOf }) {
  const limit = () => {
    try {
      const n = Number(maxOf?.())
      return Number.isFinite(n) && n >= 0 ? Math.min(32, Math.floor(n)) : DEFAULT_MAX_IMAGES
    } catch {
      return DEFAULT_MAX_IMAGES
    }
  }

  return async function buildImageParts(paths) {
    const out = []
    if (!Array.isArray(paths) || paths.length === 0) return out
    let attachments
    try {
      attachments = ctx?.get?.('attachments')
    } catch {
      attachments = undefined
    }
    if (!attachments?.saveImage) {
      logger?.debug?.('[dsh-qq] 没有 attachments 服务，图片只能给路径')
      return out
    }
    const cap = limit()
    if (cap === 0) return out
    // 超上限时留最近的几张：刷屏末尾通常才是"在问什么"
    const picked = paths.length > cap ? paths.slice(-cap) : paths
    for (const p of picked) {
      try {
        const mediaType = IMAGE_EXT[extname(p).toLowerCase()]
        if (!mediaType) continue
        const data = await readFile(p)
        const ref = await attachments.saveImage({ data, mediaType, name: basename(p) })
        out.push({
          type: 'image',
          attachment: {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            ...(ref.name === undefined ? {} : { name: ref.name }),
          },
        })
      } catch (err) {
        logger?.warn?.(`[dsh-qq] 图片转附件失败 ${p}: ${err?.message ?? err}`)
      }
    }
    if (out.length > 0) logger?.debug?.(`[dsh-qq] 已把 ${out.length} 张图塞进消息`)
    return out
  }
}
