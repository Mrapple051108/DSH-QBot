/**
 * 可改动的提示词片段：**落文件，启动时读**。
 *
 * 2026-11-02 晚姐姐定的规矩：
 *   「人设这些可改动项应该分别存文件，重启拼接就行，怎么可能让 system 是动态的，
 *     必须静态」
 *
 * 所以这些内容不再从配置的每一轮现算，而是躺在磁盘上：
 *
 *   <DSH_HOME>/dsh-qq/prompt/
 *     rules.md    ── 追加在**内置硬规矩之后**（不能替换，免得把安全网拆了）
 *     persona.md  ── 人设，存在就优先于 config.persona / personaFile
 *     tail.md     ── 收尾自检，存在就整体替换内置那段
 *     extra.md    ── 附加规矩（等价于 groupPrompt / directPrompt 的补充位）
 *
 * 读取按 **mtime + size** 记忆：文件没动就不重读、不重算，
 * 保证同一个配置状态下 system 段逐字节一致（前缀缓存才能命中）。
 * 改文件之后要重启（或点设置页的「重载提示词」）才会被重新拼一次 ——
 * 这是**故意的**：每轮重拼就等于 system 每轮变，缓存全废。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homeDirOf } from './settings.js'

/** 白名单：名字直接拼路径，必须挡住目录穿越。 */
export const PROMPT_FILE_NAMES = ['rules', 'persona', 'tail', 'extra']

/** 每个文件的中文说明，给设置页用。 */
export const PROMPT_FILE_HINTS = {
  rules: '追加在“协议规矩”之后：她在这个群/这个私聊里额外要守的规矩。内置硬规矩不会被顶掉。',
  persona: '人设：她是谁、什么脾气、怎么称呼人。有这份就盖掉设置页里的“人设”文本框。',
  tail: '发出去之前那一段。留空就用内置的；写满替换内置（别把“别把思考写进正文”那条丢了）。',
  extra: '附加规矩：想补什么补什么，排在规矩之后、收尾之前。',
}

/** 单文件上限，防止有人把整本小说塞进 system。 */
const MAX_CHARS = 40000

const cache = new Map() // file -> { mtime, size, text }

function dirOf(ctx, logger) {
  return join(homeDirOf(ctx, logger), 'prompt')
}

export function promptDirOf(ctx, logger) {
  const dir = dirOf(ctx, logger)
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    logger?.warn?.(`[dsh-qq] 建提示词目录失败: ${err?.message ?? err}`)
  }
  return dir
}

function fileOf(ctx, logger, name) {
  const safe = PROMPT_FILE_NAMES.includes(name) ? name : ''
  if (!safe) return ''
  return join(promptDirOf(ctx, logger), `${safe}.md`)
}

/**
 * 读一个片段。读不到就返回空串（调用方回退内置默认），绝不抛。
 * @returns {{name:string, file:string, exists:boolean, text:string, chars:number, mtime:number}}
 */
export function readPromptFile(ctx, logger, name) {
  const file = fileOf(ctx, logger, name)
  const empty = { name, file, exists: false, text: '', chars: 0, mtime: 0 }
  if (!file) return empty
  try {
    if (!existsSync(file)) return empty
    const st = statSync(file)
    const key = `${st.mtimeMs}:${st.size}`
    const hit = cache.get(file)
    if (hit && hit.key === key) return { name, file, exists: true, text: hit.text, chars: hit.text.length, mtime: st.mtimeMs }
    const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim().slice(0, MAX_CHARS)
    cache.set(file, { key, text })
    return { name, file, exists: true, text, chars: text.length, mtime: st.mtimeMs }
  } catch (err) {
    logger?.warn?.(`[dsh-qq] 读提示词文件 ${name}.md 失败: ${err?.message ?? err}`)
    return empty
  }
}

/**
 * 四个片段一起读。
 * @returns {{dir:string, stamp:string, rules:string, persona:string, tail:string, extra:string,
 *            files: Record<string, {file:string, exists:boolean, chars:number, mtime:number}>}}
 */
export function readPromptFiles(ctx, logger) {
  const dir = promptDirOf(ctx, logger)
  const out = { dir, stamp: '', rules: '', persona: '', tail: '', extra: '', files: {} }
  const stamps = []
  for (const name of PROMPT_FILE_NAMES) {
    const one = readPromptFile(ctx, logger, name)
    out[name] = one.text
    out.files[name] = { file: one.file, exists: one.exists, chars: one.chars, mtime: one.mtime }
    stamps.push(`${name}:${one.mtime}:${one.chars}`)
  }
  out.stamp = stamps.join('|')
  return out
}

/**
 * 写一个片段。名字白名单，内容超长截断。
 * @returns {{ok:boolean, file?:string, chars?:number, error?:string}}
 */
export function writePromptFile(ctx, logger, name, text) {
  if (!PROMPT_FILE_NAMES.includes(name)) return { ok: false, error: `未知片段 ${name}` }
  const file = fileOf(ctx, logger, name)
  const body = String(text ?? '').replace(/\r\n/g, '\n').slice(0, MAX_CHARS)
  try {
    writeFileSync(file, body.trim() ? `${body.trimEnd()}\n` : '', 'utf8')
    cache.delete(file)
    return { ok: true, file, chars: body.trim().length }
  } catch (err) {
    logger?.warn?.(`[dsh-qq] 写提示词文件 ${name}.md 失败: ${err?.message ?? err}`)
    return { ok: false, error: String(err?.message ?? err) }
  }
}

/** 给设置页看的只读状态（不带正文，正文另走一次请求）。 */
export function promptFilesSnapshot(ctx, logger) {
  const all = readPromptFiles(ctx, logger)
  return {
    dir: all.dir,
    hints: PROMPT_FILE_HINTS,
    files: PROMPT_FILE_NAMES.map((name) => ({ name, ...all.files[name] })),
  }
}

/** 清掉读取缓存（写文件之后、或显式“重载提示词”时用）。 */
export function clearPromptFileCache() {
  cache.clear()
}
