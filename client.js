/**
 * dsh-qbot —— 浏览器半端（**「设置」里的一页**）
 * ============================================================================
 * ⭐ client bundle 不是 ESM，是自注册脚本（DSH 的约定，抄 dsh-bili-scroll）：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                    // 必须等于 package.json 的 name
 *       factory: (require) => { ... return { inject: [...], apply(ctx) {...} } },
 *     })
 *
 * ⭐ 怎么进「设置」：往 `settings.section` 槽里注册一节，
 *    第一个参数的 `label` 就是设置页左侧导航里那一项。
 *
 * ⭐ 数据都走 `/api/dsh-qq/*`（后端在 src/index.js 里注册）：
 *    后端把改动写进 `$DSH_HOME/dsh-qq/settings.json`（**不动 profile 的 cordis.patch.yml**），
 *    并就地改运行中的 config，所以大部分项保存即生效。
 *
 * ⚠️ API 前缀和配置目录仍是 `dsh-qq`：这是内部标识，改了会跟老版本的
 *    配置/数据目录对不上。包名和插件显示名是 `dsh-qbot`，两者不冲突。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  // ⚠️ 这里的 id 必须等于 package.json 的 name（浏览器模块身份 = manifest 包名）。
  // 1.0.0 起包名从 dsh-qq 改成 dsh-qq-onebot，这里漏改，0.2.x 上整条 client row
  // 就对不上、设置页不出现。别再手滑。
  // 1.3.2 起本仓库 fork 成 dsh-qbot，三处（package.json / 这里 / cordis.patch.yml）一起改。
  id: 'dsh-qbot',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    // 数据来源两条路（自动选第一个通的）：
    //   1) DSH 自己的 /api/dsh-qq —— 宿主 webServer 愿意把路由挂出来时用这条
    //   2) 插件自己在 127.0.0.1:34569 起的小服务 —— 2026-10-24 加的兜底：
    //      DSH 那边的路由表会「注册成功但请求 404」，实测绕不过去，
    //      所以插件自己做一块本地工作台（这也是官方教程里说的插件形态）。
    const API = '/api/dsh-qq'
    const LOCAL_API = 'http://127.0.0.1:34569/api/dsh-qq'
    let apiBase = null

    const resolveBase = async () => {
      if (apiBase) return apiBase
      const probe = async (base) => {
        try {
          const r = await fetch(base + '/status', { credentials: 'same-origin' })
          return r.ok ? base : null
        } catch {
          return null // 网络错 / 跨域 / 没起来，都算这条不通
        }
      }
      apiBase = (await probe(API)) || (await probe(LOCAL_API)) || API
      return apiBase
    }

    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
      // 把响应体也带上：404 时能分清「路由没挂上」和「路径写错了」
      let extra = ''
      try {
        const text = await res.text()
        if (text) extra = ' · ' + text.replace(/\s+/g, ' ').slice(0, 180)
      } catch { /* 读不出来就算了 */ }
      throw new Error('HTTP ' + res.status + why + extra)
    }
    const jget = async (p) => asJson(await fetch((await resolveBase()) + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch((await resolveBase()) + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-qq-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 8px;max-width:680px;}
[data-qq-sec]{display:flex;flex-direction:column;gap:8px;}
[data-qq-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-qq-row]{display:flex;align-items:center;gap:10px;}
[data-qq-col]{display:flex;flex-direction:column;gap:6px;}
[data-qq-grow]{flex:1;min-width:0;}
[data-qq-label]{font-size:13px;flex:none;min-width:168px;white-space:nowrap;}
@media (max-width:560px){[data-qq-row]{flex-wrap:wrap;}[data-qq-label]{min-width:100%;}}
[data-qq-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-qq-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-qq-sw][data-on]{background:#3b82f6;}
[data-qq-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-qq-sw][data-on] i{left:19px;}
[data-qq-sw][disabled]{opacity:.45;cursor:default;}
[data-qq-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-qq-input]:focus{outline:none;border-color:#3b82f6;}
[data-qq-input][data-mono]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;}
[data-qq-area]{width:100%;box-sizing:border-box;min-height:90px;resize:vertical;padding:8px 9px;border-radius:8px;
  font-size:12px;line-height:18px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-qq-area]:focus{outline:none;border-color:#3b82f6;}
[data-qq-num]{width:104px;text-align:center;}
[data-qq-btn]{padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:inherit;}
[data-qq-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-qq-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-qq-btn][disabled]{opacity:.5;cursor:default;}
[data-qq-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;word-break:break-all;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-qq-msg][data-warn]{color:#f59e0b;}
[data-qq-msg][data-good]{color:#22c55e;}
[data-qq-kv]{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9aa0a6);word-break:break-all;}
[data-qq-dot]{flex:none;width:8px;height:8px;border-radius:50%;background:#9aa0a6;}
[data-qq-dot][data-on]{background:#22c55e;}
[data-qq-pill]{font-size:11px;padding:2px 7px;border-radius:999px;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.16));
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
`

    /** 逗号 / 换行 / 空格分隔 → 数组；空串 → [] */
    const toList = (text) => String(text ?? '')
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    const fromList = (arr) => (Array.isArray(arr) ? arr.join(', ') : '')

    function Switch({ on, disabled, title, onToggle }) {
      return h('button', {
        'data-qq-sw': '', 'data-on': on ? '' : undefined, disabled: disabled ? '' : undefined,
        title: title || '', type: 'button',
        onClick: () => !disabled && onToggle(!on),
      }, h('i'))
    }

    function Row({ label, hint, children }) {
      return h('div', { 'data-qq-col': '' },
        h('div', { 'data-qq-row': '' },
          h('div', { 'data-qq-label': '' }, label),
          h('div', { 'data-qq-grow': '' }, children)),
        hint ? h('div', { 'data-qq-note': '' }, hint) : null)
    }

    // 人设文件读没读到要常驻显示：读不到最容易「悄悄变普通助手」，
    // 只留一句日志 warn 的话，人在设置页上是看不见的。
    function personaNote(p) {
      if (!p || !p.file) return null
      return h('div', { 'data-qq-note': '' },
        p.ok
          ? `✓ 当前从 ${p.file} 读入 ${p.chars} 字（上面的文本框不生效）`
          : p.fromCache
            ? `⚠️ 这个文件读不到（${p.error || '文件不存在'}），用的是上次读到的那份缓存（${p.chars} 字）`
            : `⚠️ 这个文件读不到（${p.error || '文件不存在'}），现在用的是上面的文本框`)
    }

    function Panel() {
      const [st, setSt] = useState(null)
      const [val, setVal] = useState(null)
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState(null)
      const [draft, setDraft] = useState({})
      const [persona, setPersona] = useState(null)
      // 可视化页的地址：主推插件自己起的本地服务（127.0.0.1:34569，端口固定），
      // 备胎是同源 /api/dsh-qq —— 宿主端口每次重启都变，粘出去第二天就废了。
      const [viewUrls, setViewUrls] = useState(null)
      useEffect(() => {
        let same = ''
        try {
          same = window.location.origin + '/api/dsh-qq/rhythm-view'
        } catch {
          same = '/api/dsh-qq/rhythm-view'
        }
        setViewUrls({ primary: LOCAL_API + '/rhythm-view', same })
      }, [])

      const load = useCallback(async () => {
        try {
          const [s, cfg] = await Promise.all([jget('/status'), jget('/settings')])
          setSt(s)
          setVal(cfg.values)
          setDraft({})
          setPersona(cfg.persona ?? null)
        } catch (e) {
          setMsg({ text: '读设置失败：' + e.message, tone: 'warn' })
        }
      }, [])

      useEffect(() => { load() }, [load])

      // 每 15 秒刷一次连接状态（别太勤，设置页不需要实时）
      useEffect(() => {
        const t = setInterval(async () => {
          try { setSt(await jget('/status')) } catch { /* 忽略 */ }
        }, 15000)
        return () => clearInterval(t)
      }, [])

      const patch = async (body, label) => {
        setBusy('save')
        setMsg(null)
        try {
          const r = await jpost('/settings', { patch: body })
          setVal(r.values)
          setDraft({})
          if (r.persona) setPersona({ ...r.persona })
          const tail = r.needReconnect ? '（点右边「重连」生效）' : r.needRestart ? '（有几项要重启宿主才生效）' : ''
          let text = `${label} 已保存${tail}`
          if (r.persona && r.persona.file) {
            text += r.persona.ok ? `，人设从文件读入 ${r.persona.chars} 字` : `，人设文件读不到（${r.persona.error}），先用着原来的`
          }
          setMsg({ text, tone: r.persona && r.persona.file && !r.persona.ok ? 'warn' : 'good' })
          setSt(await jget('/status'))
        } catch (e) {
          setMsg({ text: '保存失败：' + e.message, tone: 'warn' })
        } finally {
          setBusy('')
        }
      }

      const reconnect = async () => {
        setBusy('reconnect')
        setMsg(null)
        try {
          const r = await jpost('/reconnect')
          setMsg({ text: '已按 ' + r.wsUrl + ' 重连', tone: 'good' })
          setTimeout(load, 1200)
        } catch (e) {
          setMsg({ text: '重连失败：' + e.message, tone: 'warn' })
        } finally {
          setBusy('')
        }
      }

      if (!val) {
        return h('div', { 'data-qq-page': '' },
          h('div', { 'data-qq-note': '' }, msg ? msg.text : '读取中…'))
      }

      const v = (key) => (draft[key] !== undefined ? draft[key] : val[key])
      const setV = (key, value) => setDraft((d) => ({ ...d, [key]: value }))
      const num = (key, fallback = 0) => {
        const n = Number(v(key))
        return Number.isFinite(n) ? n : fallback
      }

      /** 文本 / 数字：失焦才存（边打边存会把半截词写进去） */
      const textField = (key, label, { hint, placeholder, mono, type = 'text', wrap }) => Row({
        label, hint,
        children: wrap
          ? null
          : h('input', {
            'data-qq-input': '', 'data-mono': mono ? '' : undefined, type: type === 'number' ? 'number' : 'text',
            'data-qq-num': type === 'number' ? '' : undefined,
            value: v(key) ?? '',
            placeholder: placeholder || '',
            onChange: (e) => setV(key, e.target.value),
            onBlur: (e) => {
              const raw = e.target.value
              const next = type === 'number' ? (raw === '' ? 0 : Number(raw)) : raw
              if (String(next) !== String(val[key] ?? '')) patch({ [key]: next }, label)
              else setDraft((d) => { const c = { ...d }; delete c[key]; return c })
            },
          }),
      })

      const areaField = (key, label, { hint, rows = 4, mono } = {}) => h('div', { 'data-qq-col': '' },
        h('div', { 'data-qq-label': '' }, label),
        hint ? h('div', { 'data-qq-note': '' }, hint) : null,
        h('textarea', {
          'data-qq-area': '', 'data-mono': mono ? '' : undefined,
          rows,
          value: v(key) ?? '',
          onChange: (e) => setV(key, e.target.value),
          onBlur: (e) => {
            if (String(e.target.value) !== String(val[key] ?? '')) patch({ [key]: e.target.value }, label)
            else setDraft((d) => { const c = { ...d }; delete c[key]; return c })
          },
        }))

      const listField = (key, label, { hint, placeholder } = {}) => Row({
        label, hint,
        children: h('input', {
          'data-qq-input': '', value: draft[key] !== undefined ? draft[key] : fromList(val[key]),
          placeholder: placeholder || '用逗号分隔',
          onChange: (e) => setV(key, e.target.value),
          onBlur: (e) => {
            const list = toList(e.target.value)
            if (toList(fromList(val[key])).join(',') !== list.join(',')) patch({ [key]: list }, label)
            else setDraft((d) => { const c = { ...d }; delete c[key]; return c })
          },
        }),
      })

      const boolField = (key, label, hint) => h('div', { 'data-qq-row': '' },
        h('div', { 'data-qq-grow': '' },
          h('div', { 'data-qq-label': '' }, label),
          hint ? h('div', { 'data-qq-note': '' }, hint) : null),
        h(Switch, { on: Boolean(val[key]), onToggle: (next) => patch({ [key]: next }, label) }))

      const modeField = (key, label, hint) => Row({
        label, hint,
        children: h('select', {
          'data-qq-input': '', style: { width: 150, flex: 'none' },
          value: v(key) ?? 'open',
          onChange: (e) => patch({ [key]: e.target.value }, label),
        },
        h('option', { value: 'open' }, '全都接'),
        h('option', { value: 'allowlist' }, '只接名单里的'),
        h('option', { value: 'disabled' }, '关掉')),
      })

      const connected = Boolean(st && st.connected)

      return h('div', { 'data-qq-page': '' },
        /* ── 状态 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-row': '' },
            h('div', { 'data-qq-dot': '', 'data-on': connected ? '' : undefined }),
            h('div', { 'data-qq-label': '', 'data-qq-grow': '' },
              connected ? '已连上 NapCat' : '没连上 NapCat'),
            st ? h('span', { 'data-qq-pill': '' }, st.selfName ? `${st.selfName} (${st.selfId})` : (st.selfId || '未登录')) : null),
          h('div', { 'data-qq-kv': '' },
            '地址：', st ? st.wsUrl : '',
            st && st.home ? h('span', null, h('br'), '家目录：', st.home) : null,
            st && st.settingsFile ? h('span', null, h('br'), '设置文件：', st.settingsFile, '（', st.overrides, ' 条覆盖）') : null),
          h('div', { 'data-qq-row': '' },
            h('button', { 'data-qq-btn': '', disabled: busy === 'reconnect', onClick: reconnect }, '重连'),
            h('button', { 'data-qq-btn': '', onClick: load }, '重新读一遍')),
          msg ? h('div', { 'data-qq-msg': '', 'data-warn': msg.tone === 'warn' ? '' : undefined, 'data-good': msg.tone === 'good' ? '' : undefined }, msg.text) : null),

        /* ── 连接 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '连接'),
          textField('wsUrl', 'NapCat 的 WebSocket 地址', {
            hint: 'OneBot 11 正向 WebSocket。NapCat 里开的「正向 WS」默认是 ws://127.0.0.1:3001。改完点上面的「重连」。',
            mono: true,
          }),
          textField('accessToken', 'access token', {
            hint: '跟 NapCat 配置里那一串要一致。只在本机回环可以留空。',
            mono: true,
          }),
          textField('selfId', '机器人自己的 QQ 号', {
            hint: '留空就启动时自动问 NapCat 要（一般不用填）。',
          })),

        /* ── 它是谁 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '它是谁（人设）'),
          areaField('persona', '人设', {
            hint: '名字、性格、怎么称呼对方、有什么小习惯，都写这儿。留空 = 一个没名字、说话正常的普通助手（插件不自带任何角色）。',
            rows: 6,
          }),
          textField('personaFile', '人设文件（地址）', {
            hint: '填了就从文件读人设，盖掉上面的文本框 —— 想让人设跟某个 .md 一起改就填这里。文件读不到时不会把角色弄没，会继续用文本框里的。',
            mono: true,
            placeholder: 'D:/某个角色.md（留空 = 只用上面的文本框）',
          }),
          personaNote(persona),
          textField('ownerLabel', '在群里怎么称呼主人', { hint: '例如「老板」「老大」。', placeholder: '主人' })),

        /* ── 补充提示词 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '补充提示词（追加在内置聊天规矩后面）'),
          areaField('directPrompt', '私聊补充', { rows: 4 }),
          areaField('groupPrompt', '群聊补充', { rows: 6 })),

        /* ── 记忆区 / 工作区 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '记忆区与工作区'),
          textField('workspaceRoot', '会话目录根（记忆区在这儿）', {
            hint: '每个私聊 / 每个群在这里各有一个子目录（群_123456 / 私聊_10001），里面的「记忆区/」就是这个会话自己的日记和大纲。留空 = <工作目录>/会话。改完要重启宿主。',
            mono: true,
            placeholder: 'D:/QQ会话（留空就用默认）',
          }),
          boolField('isolateByPeer', '每个会话各自一个目录与记忆区', '关掉的话所有群聊共用宿主的工作目录，别关。改完要重启宿主。')),

        /* ── 群里怎么说话 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '群里怎么说话'),
          boolField('requireMention', '默认必须 @ 才接话', '这是**默认值**。想按群单独设，用下面两个名单：一个强制要 @，一个免 @。不改名单的群都听这个开关。'),
          listField('groupMustMention', '这些群必须 @ 才接（例外）', {
            hint: '填群号，逗号分隔，如 1130590541。哪怕上面那个开关关着，这几个群也只认 @。',
          }),
          listField('groupNoMention', '这些群不用 @ 也接（例外）', {
            hint: '填群号，逗号分隔，如 770375717。哪怕上面那个开关开着，这几个群也照常接话。两边都填了，以「必须 @」为准。',
          }),
          textField('groupWakeMs', '被 @ 之后的对话窗口（毫秒）', {
            hint: '默认 60000。被 @ 后开一段固定时长：这期间跟"不用 @"的群没两样，走冷热窗那套标准节奏；到点它自己说一句收尾，然后回到必须 @。窗口不续期，只有再被 @ / 被引用 / 被点名才重新给一整段。0 = 关掉这个窗口（被 @ 只回一次）。',
            type: 'number',
          }),
          boolField('groupWakeFarewell', '窗口到点时让它说一句收尾', '默认开。会把这段没回的话一起带过去，让它自己组织那句告别（比如「我要去休息了，有事再叫我」），不想说可以回 [SILENT]。关掉 = 时间到了默默回到"必须 @"。'),
          textField('groupReplyGapMs', '同一个人两次回复至少隔多久（毫秒）', {
            hint: '默认 20000。中间来的消息不丢，攒着下次一起看见——这就是「均匀地回几次」。0 = 不限。',
            type: 'number',
          }),
          textField('groupMinGapMs', '群里两条消息之间至少隔多久（毫秒）', {
            hint: '默认 4000，防风控。',
            type: 'number',
          }),
          textField('rateLimitPerMin', '每分钟最多发几条', { hint: '默认 12。超了会**等名额空出来再发**，不再直接丢弃后半截（以前就是这么把话吃掉的）。0 = 不限。被风控往往不是说了什么，是回得太多。', type: 'number' }),
          textField('historyLimit', '群消息缓冲容量', {
            hint: '默认 20。收到就进缓冲，真发一轮时全取走并清空，超容量的丢最老的 —— 所以回过的、看过的话不会再被翻出来。0 = 不攒（只回当前这条，被跳过的话就彻底看不见了）。',
            type: 'number',
          })),

        /* ── 群聊节奏：热窗 / 冷窗 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '群聊节奏（热窗 / 冷窗）'),
          h('div', { 'data-qq-note': '' },
            '回复完进热窗，热窗里照常尽快接话；热窗过完进冷窗，这段时间的群消息只攒着、一条都不投给模型（省的就是那一轮的钱），到期一次性交回去。冷窗里**必须 @ 才醒**，主人也不例外。'),
          boolField('rhythmEnabled', '启用群聊节奏', '关掉 = 完全退回原版行为：每条群消息都会投一轮，回不回由它自己判断（也就是只做到「不吵」，但照烧 token）。'),
          boolField('rhythmGroupsOnly', '只管群聊', '私聊不受节奏影响（一对一攒二十分钟才回太反人类）。'),
          textField('rhythmHotMinMs', '热窗最短（毫秒）', { hint: '默认 90000（90 秒）。每次回复完重新抽一次。', type: 'number' }),
          textField('rhythmHotMaxMs', '热窗最长（毫秒）', { hint: '默认 150000（150 秒）。', type: 'number' }),
          textField('rhythmColdMinMs', '冷窗最短（毫秒）', { hint: '默认 600000（10 分钟）。冷窗里消息只攒不投。', type: 'number' }),
          textField('rhythmColdMaxMs', '冷窗最长（毫秒）', { hint: '默认 1200000（20 分钟）。到期把攒的一次性交回去。', type: 'number' }),
          textField('rhythmColdKeep', '冷窗到期带回去几条', { hint: '默认 8。攒了 30 条也只喂 8 条。', type: 'number' })),

        /* ── 无视冷窗（烦躁度）── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '无视冷窗（防刷屏 / 防骚扰）'),
          h('div', { 'data-qq-note': '' },
            '比冷窗更狠的一档：期间的消息**直接丢弃**（只在结束时留几条尾巴），除了主人 @ 它以外谁都叫不动。两个入口——它自己调 qq_ignore，或者烦躁度超阈值自动开。'),
          boolField('ignoreAuto', '按烦躁度自动开无视', '关掉 = 只能靠它自己调 qq_ignore。烦躁度是「对话冗余度（MMR）+ @ 我的频率 + 同一个人纠缠 + 连着发一样的东西」四项加权，没人说话时会自己衰减。'),
          boolField('ignoreNag', '顶到阈值时先让它骂一句再走', '默认开。烦躁度到上限时，先给它一轮说话的机会：可以嫌吵、警告、发火，那句照常发出去，然后才静音。关掉 = 无声无息地躲开，像掉线不像生气。'),
          textField('ignoreScoreThreshold', '烦躁度超过多少自动开', { hint: '0~100，默认 70。', type: 'number' }),
          Row({
            label: '无视怎么结束',
            hint: 'fixed = 到点就结束（时长见下）；stats = 烦躁度回落到阈值以下、再等一段时延才结束（还在刷屏就一直躲着）。',
            children: h('select', {
              'data-qq-input': '', style: { width: 150, flex: 'none' },
              value: v('ignoreMode') ?? 'fixed',
              onChange: (e) => patch({ ignoreMode: e.target.value }, '无视怎么结束'),
            },
            h('option', { value: 'fixed' }, '固定时长'),
            h('option', { value: 'stats' }, '看烦躁度')),
          }),
          textField('ignoreMs', '固定模式躲多久（毫秒）', { hint: '默认 600000（10 分钟）。', type: 'number' }),
          textField('ignoreMinMs', '统计模式最短躲多久（毫秒）', { hint: '默认 120000（2 分钟）。不管烦躁度掉多快，至少躲这么久。', type: 'number' }),
          textField('ignoreMaxMs', '统计模式最长躲多久（毫秒）', { hint: '默认 1800000（30 分钟）。防止一直退不出来。', type: 'number' }),
          textField('ignoreExitThreshold', '统计模式：烦躁度降到多少算消停', { hint: '默认 30。', type: 'number' }),
          textField('ignoreExitDelayMs', '统计模式：消停后再等多久（毫秒）', { hint: '默认 30000。', type: 'number' }),
          textField('ignoreKeepCount', '结束时留几条给它看', { hint: '默认 3。期间其它消息全丢。', type: 'number' }),
          textField('ignoreCooldownMs', '两次自动无视至少隔多久（毫秒）', { hint: '默认 120000。防抖，别刚出来又进去。', type: 'number' }),
          textField('ignoreRisePerMsg', '每条消息把烦躁度拉多快（0~1）', {
            hint: '默认 0.45。越大越敏感，刷屏几下就顶上去；越小越迟钝。',
            type: 'number',
          }),
          textField('ignoreRedundancyWeight', '冗余度占多少分（0~100）', {
            hint: '默认 50。复读和表情包轰炸靠这一项——图片的正文都是「[图片]」，纯 emoji 归同一类。',
            type: 'number',
          }),
          textField('ignoreStaleWeight', '连击占多少分（0~100）', {
            hint: '默认 25。连着发一模一样的东西（含连着几张图）才计分，2 条不算、7 条拉满。',
            type: 'number',
          }),
          h('div', { 'data-qq-row': '', style: { alignItems: 'flex-start' } },
            h('div', { 'data-qq-grow': '' },
              h('div', { 'data-qq-label': '' }, '群聊状态与设置'),
              h('div', { 'data-qq-note': '' },
                '单开一个网页看：上半页是状态（按会话选，横轴时间、纵轴烦躁度 0~100，衬着热窗 / 冷窗 / 无视的色带和触发阈值），下半页是这个群的设置（每一项都能跟随全局）。观察几分钟就知道阈值该调多少。',
              ),
              h('input', {
                readOnly: true,
                value: viewUrls ? viewUrls.primary : '',
                'data-qq-input': '',
                'data-mono': '',
                title: '点一下全选，然后 Ctrl+C 粘到浏览器',
                style: { width: '100%', marginTop: '6px', cursor: 'text' },
                onClick: (e) => {
                  try { e.target.select() } catch { /* 选不中也不影响 */ }
                },
              }),
              h('div', { 'data-qq-note': '', style: { marginTop: '4px', wordBreak: 'break-all' } },
                viewUrls
                  ? '34569 是插件自己起的本地服务，端口固定、不跟宿主重启变。万一打不开，用这条：' + viewUrls.same
                  : '')),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', flex: 'none' } },
              h('a', {
                'data-qq-btn': '',
                'data-primary': '',
                href: viewUrls ? viewUrls.primary : '#',
                target: '_blank',
                rel: 'noopener noreferrer',
                style: { textDecoration: 'none', display: 'inline-block', textAlign: 'center' },
              }, '打开'),
              h('button', {
                'data-qq-btn': '',
                disabled: !viewUrls,
                title: '有些环境不让页面自己弹窗，复制地址粘到浏览器里就行',
                onClick: async () => {
                  try {
                    await navigator.clipboard.writeText(viewUrls.primary)
                    setMsg({ text: '地址已复制：' + viewUrls.primary, tone: 'good' })
                  } catch {
                    setMsg({ text: '复制失败：手动点一下上面那个框，Ctrl+C', tone: 'warn' })
                  }
                },
              }, '复制链接')))),

        /* ── 谁能跟它说话 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '谁能跟它说话'),
          modeField('privateMode', '私聊', '「只接名单里的」时要填下面的私聊白名单。'),
          listField('privateAllow', '私聊白名单', { hint: 'QQ 号，用逗号分隔。' }),
          modeField('groupMode', '群聊', '「关掉」= 群里完全不理它。'),
          listField('groupAllow', '群聊白名单', { hint: '群号，用逗号分隔。' }),
          listField('ownerIds', '谁是主人（QQ 号）', {
            hint: '这些人在群里说话会标上「主人」的称呼，问本机的事也正常答；其他人一律当陌生人。留空 = 不区分。',
          })),

        /* ── 同类机器人 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '同类机器人（另一个 bot）'),
          boolField('botChatEnabled', '允许它和同类聊天 / 回怼', '默认关：同类说啥都不理，连 @ 也不接。打开之后才会顶嘴——被骂了先看是不是在说它自己。'),
          listField('peerBots', '同类机器人的 QQ 号', { hint: '填了才认得出「这句是别的机器人发的」。' })),

        /* ── 主动说话 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '主动说话（冷场时给一次开口的机会）'),
          boolField('proactiveEnabled', '安静久了允许它主动说一句', '默认开。打开后，会话安静到「安静多久」那个时长，给它一次主动开口的机会——说不说自己判断，不想说就零成本跳过。'),
          textField('proactiveSilentMs', '安静多久之后给机会（毫秒）', {
            hint: '默认 1200000（20 分钟）。说完一句话会重新计时，不会隔几分钟又问一遍。',
            type: 'number',
          }),
          textField('proactiveMaxPerDay', '每天最多主动几次', { hint: '默认 6。连着 3 次没人接就当天闭嘴。', type: 'number' }),
          textField('proactiveQuietHours', '静默时段（这期间不主动）', {
            hint: '默认 23:00-08:00。格式「开始-结束」，24 小时制。',
            mono: true,
          }),
          textField('mergeWindowMs', '连发合并窗口（毫秒）', {
            hint: '默认 5000。同一个人一口气发三条，等这么一会儿并成一轮再回，别回三遍。只在私聊生效。',
            type: 'number',
          }),
          textField('groupMergeWindowMs', '群里等几秒再回（下限，毫秒）', {
            hint: '默认 2500。一句拆成三段发过来时，等这几秒一轮回完，而不是回三遍。实际等的时长在这个下限和下面那个上限之间滑动，由烦躁度决定 —— 越烦越懒得马上接。0 = 关（来一条回一条）。',
            type: 'number',
          }),
          textField('groupMergeWindowMaxMs', '群里等几秒再回（上限，毫秒）', {
            hint: '默认 15000。烦躁度顶到阈值时按这个等，所以这就是「烦到不想接话」的节奏。烦躁度 0 时用上面的下限，中间线性过渡。',
            type: 'number',
          }),
          textField('groupMergeMaxMs', '最多压多久必须发（毫秒）', {
            hint: '默认 30000。热闹的群一直有人说话时，从第一条算起到这个点必须发出去，不然永远等不到停顿、也就永远不回。',
            type: 'number',
          })),

        /* ── 作息 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '作息（几点犯困、几点睡）'),
          boolField('sleepMode', '启用作息', '关掉 = 它不分白天黑夜，什么时候都正常回。'),
          textField('bedtimeAt', '几点提醒它去睡', { hint: '默认 23:30。每个会话每天只提醒一次。', mono: true }),
          textField('sleepFrom', '夜里从几点开始不按住消息', {
            hint: '默认 00:00。这段里收到的私聊先攒着，出时段时一次性交出去（附「昨晚你发来这几条」）。',
            mono: true,
          }),
          textField('sleepTo', '攒到几点交出去', { hint: '默认 08:00。', mono: true })),

        /* ── 其它 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '其它'),
          boolField('debug', '输出调试日志', '日志落在会话目录根的 dsh-qq-debug.log（带 UTC 时间戳）。'),
          textField('textChunkLimit', '单条消息最多多少字（下限）', {
            hint: '超出按段落 / 句号切成多条发。配了下面那个上限之后，这个值就是随机区间的下限。',
            type: 'number',
          }),
          textField('textChunkLimitMax', '单条消息最多多少字（上限）', {
            hint: '默认 0 = 不随机，就用上面那个固定值。填 80 就是每条回复在 30~80 字之间摇一个 —— 长短不齐比齐刷刷拆段更像人打字。',
            type: 'number',
          }),
          textField('textNoSplitMinChars', '超过多少字就整段发、不拆（0 = 关）', {
            hint: '默认 300。代码、命令、配置一旦被切断就没法读 —— 宁可糊成一坨，也别拆成三截让人抄不全。',
            type: 'number',
          }),
          boolField('textNoSplitTechnicalOnly', '只在「像技术内容」时整段发', '默认开：代码块、缩进、路径、链接、命令、报错堆栈这些才整段发，普通闲聊照样拆。关掉 = 只要超字数就不拆，不管什么内容。'),
          textField('splitDelayMs', '分条之间最短隔多久（毫秒）', {
            hint: '默认 300。跟下面那个组成一个随机区间 —— 每段之间摇一个，别用固定节拍：齐刷刷往外吐不像人，也容易被风控盯上。',
            type: 'number',
          }),
          textField('splitDelayMaxMs', '分条之间最长隔多久（毫秒）', {
            hint: '默认 1500。实际间隔在 300~1500 之间随机。想要更像打字机就拉大上限（大多短、偶尔顿一下，可用 splitDelayMeanMs 换指数分布）。',
            type: 'number',
          })),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-qq')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-qq: 设置页样式')

        // 0.2.1 里服务直接挂在 ctx 上（官方插件写的就是 ctx.slots）；ctx.get 只作旧式兜底。
        const slots = ctx.slots || (typeof ctx.get === 'function' ? ctx.get('slots') : undefined)
        if (!slots) {
          console.error('[dsh-qq] slots 服务不可用，设置页挂不上去')
          return
        }
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'dsh-qq', order: 40, label: 'QQ' },
          () => h(Panel),
        ))
      },
    }
  },
})
