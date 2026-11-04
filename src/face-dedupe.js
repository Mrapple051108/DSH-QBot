/**
 * face-dedupe.js —— 把「查重」这件事从主线程挪走。
 *
 * 2026-11-04 姐姐的要求：「注意在子线程且异步，不要提示智能体有没有重复，
 * 完全由插件捕获和处理」。
 *
 * 这一层只做三件事：
 *   1. 起一个 worker 把向量丢进去算（`scanPairs` 在 shared/face-dedupe.js，纯函数）；
 *   2. 超时 / worker 起不来 / worker 报错 → **退回主线程同步算**。
 *      查重是"提示性"的活，算不出来最多是没打黄圈，不能因此让收藏页打不开；
 *   3. 结果里带 `inline` / `timeout` / `error`，方便日志里看出这一次走的是哪条路。
 *
 * 为什么不常驻一个 worker：收藏页是低频操作，一次一个 worker 的启动开销（~20ms）
 * 比维护常驻 worker 的生命周期、崩溃重启简单得多。真正在图库里频繁触发的是
 * `keepFace` 的"添加时查重"，那边只比一条 vs N 条，量更小。
 */
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { scanPairs } from './shared/face-dedupe.js'

const WORKER_FILE = fileURLToPath(new URL('./face-dedupe-worker.js', import.meta.url))

/**
 * @param {Array<{id:string, vec:string}>} items
 * @param {number} threshold
 * @param {{timeoutMs?:number, logger?:object}} [opts]
 * @returns {Promise<{flags:Array, pairs:Array, compared:number, dupCount:number, inline:boolean, timeout?:boolean, error?:string}>}
 */
export function scanInWorker(items, threshold, { timeoutMs = 2000, logger } = {}) {
  const fallback = (why) => {
    try {
      return { ...scanPairs(items, threshold), inline: true, ...why }
    } catch (err) {
      logger?.warn?.(`[dsh-qq] 查重回退也失败了: ${err?.message ?? err}`)
      return { flags: [], pairs: [], compared: 0, dupCount: 0, inline: true, ...why }
    }
  }

  return new Promise((resolve) => {
    let worker = null
    let done = false
    let timer = null

    const finish = (value) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      try {
        worker?.terminate()
      } catch {
        /* 已经退出了 */
      }
      resolve(value)
    }

    try {
      worker = new Worker(WORKER_FILE, { workerData: { items, threshold } })
    } catch (err) {
      // 某些受限环境（沙箱、装不了 worker 的宿主）起不来子线程 —— 直接主线程算
      logger?.debug?.(`[dsh-qq] 查重子线程起不来，改主线程：${err?.message ?? err}`)
      finish(fallback({ error: String(err?.message ?? err) }))
      return
    }

    timer = setTimeout(() => {
      logger?.debug?.(`[dsh-qq] 查重子线程超时（${timeoutMs}ms），改主线程`)
      finish(fallback({ timeout: true }))
    }, Math.max(200, Number(timeoutMs) || 2000))
    timer.unref?.()

    worker.once('message', (msg) => {
      if (!msg || msg.ok !== true) {
        finish(fallback({ error: String(msg?.error ?? 'worker 没给结果') }))
        return
      }
      finish({ ...msg, inline: false })
    })
    worker.once('error', (err) => {
      logger?.warn?.(`[dsh-qq] 查重子线程报错，改主线程：${err?.message ?? err}`)
      finish(fallback({ error: String(err?.message ?? err) }))
    })
    worker.once('exit', (code) => {
      // 正常情况 message 先到；走到这儿说明它没给结果就没了
      finish(fallback({ error: `worker 退出（code ${code}）` }))
    })
  })
}
