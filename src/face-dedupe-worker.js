/**
 * face-dedupe-worker.js —— 在**子线程**里算「收藏里有没有彼此太像的」。
 *
 * 2026-11-04 姐姐明确要求：「注意在子线程且异步」。
 * 这件事是 O(n²) 的余弦：200 张 × 200 张 × 384 维 ≈ 760 万次乘加，
 * 压在主线程上就是"存一张图，整个宿主卡一下"——群消息还等着呢。
 *
 * 只吃 `workerData`、只 `postMessage` 一次，不碰盘、不碰宿主对象。
 * 父进程那边有超时兜底，算不完就退回主线程同步算（见 src/face-dedupe.js）。
 */
import { parentPort, workerData } from 'node:worker_threads'
import { scanPairs } from './shared/face-dedupe.js'

try {
  const items = Array.isArray(workerData?.items) ? workerData.items : []
  const threshold = Number(workerData?.threshold) || 0.95
  parentPort?.postMessage({ ok: true, ...scanPairs(items, threshold) })
} catch (err) {
  parentPort?.postMessage({ ok: false, error: String(err?.message ?? err) })
}
