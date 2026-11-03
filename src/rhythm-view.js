import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 烦躁度可视化页（`GET /api/dsh-qq/rhythm-view`）。
 *
 * 为什么单独放一个 html 文件、不塞进 JS 字符串里：
 *   这页有 300 多行 SVG 绘图的 DOM 操作，写成模板字符串要把每个反引号和 ${} 都转义，
 *   改一次错一次。放成静态文件就能当普通网页改，也还能在浏览器里直接开。
 *
 * 缓存 5 秒：页面自己每 5 秒刷一次数据，别为了读一个没变过的文件每次都砸盘。
 */
const VIEW_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'view', 'rhythm.html')

let cached = { at: 0, text: '' }

export function rhythmViewHtml() {
  const now = Date.now()
  if (cached.text && now - cached.at < 5000) return cached.text
  try {
    cached = { at: now, text: readFileSync(VIEW_FILE, 'utf8') }
  } catch (err) {
    cached = {
      at: now,
      text:
        '<!doctype html><meta charset="utf-8">' +
        '<body style="font:14px/1.7 system-ui;background:#0e1116;color:#d7dee8;padding:24px">' +
        '<h3>可视化页面读不到</h3>' +
        `<p style="color:#ff7b72">${String(err?.message ?? err)}</p>` +
        `<p style="color:#8b98a9">文件应该在：<code>${VIEW_FILE}</code></p>`,
    }
  }
  return cached.text
}

export const RHYTHM_VIEW_FILE = VIEW_FILE
