# dsh-qbot

把 **QQ** 接成 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 的一个前端：私聊、群聊都能和同一个 Agent 聊；它听得懂语音、看得见图片，会发表情包，也会烦、会闹、会甩脸色。

底层走 [OneBot v11](https://github.com/botuniverse/onebot-11) 协议，默认搭配 [NapCat](https://napneko.github.io/)。不用公网 IP、不用备案、不用企业主体。

![群聊状态与设置：相位、烦躁度、情绪、换档倒计时、接话节奏，以及底下的曲线](docs/screenshots/01-status.png)

> ⚠️ **先说清楚**：NapCat 属于「QQ 协议端」，跑在你自己登录的 QQ 客户端上，**不符合腾讯的用户协议**。用小号、别和常用号同一台设备、别发垃圾消息，账号有被风控或封禁的可能。插件只负责把 OneBot 消息转给 Agent，协议端本身怎么合规、怎么稳，由你自己负责。场景能用 [QQ 官方机器人](https://bot.q.qq.com/) 的，优先用官方的。

> 📢 **这是个人自用改出来的版本**：MIT，随便取用、改、再发。没有客服、没有 SLA。
> 提 issue 或贴日志之前，请先把 **token、真实 QQ 号、本机路径** 抹掉——发出去就收不回来了。

---

## 关于这个 fork

**本插件不是从零写的。** 它 fork 自 [**dsh-qq-onebot**](https://github.com/2710586329/dsh-qq.git)（早期名 `dsh-qq`），原作者 **xier**，MIT 许可。

上游把「OneBot 11 / NapCat ↔ DSH Agent」这条链路的骨架搭得很扎实——WebSocket 连接与重连、私聊/群聊各一条持久会话、每会话独立工作目录、语音转写、图片落地、审批与问答通道、长文本分条、限速与间隔，这些**都是原作者的功劳**。这个 fork 站在上面继续改。

改它的原因很朴素：我把它当日常在用的机器人养，养出了原版没有的一堆需求，于是一层层加上去，最后长成了现在这样。

| 方向 | 这个 fork 做了什么 |
| --- | --- |
| **提示词分层** | system 完全静态化：只留 `rules` / `persona` / `tail` 三段，首轮算完逐字节冻结；每轮会变的事实卡、群词典、话头、表情包策略、当前烦躁度全部搬到 runtime-context，不再每轮把 system 顶掉、不再让前缀缓存整块失效 |
| **群聊脾气** | 烦躁度曲线（线性 / 先快后慢 / 先慢后快）、三档阈值（冷静·愤怒·逃离）、两种行为模式（幸福者退让 / 必须回击）、无视冷窗；四段提示词模板可按群改写；面板里能看实时曲线 |
| **群聊设置页** | 三十多项**按群单独覆盖**，默认跟随全局：触发、节奏、烦躁度、提示词、表情包、白嫖请求、命令通道；一次保存立刻生效 |
| **表情包** | 从「按名字四级匹配」换成**语义检索**：每张图有描述和向量，按意思挑图；发不发的闸从提示词搬进工具管道（两张间隔 / 每小时上限，全局 + 按群配）；收藏可视化——四列缩略图、点开改描述重算向量、增删、上传 |
| **对话窗口** | 按「群 + 人」开窗，时长可分群设，续期开关两段式；到点收尾只交「该回却没回」的消息，不会把别人的闲聊顺手接走 |
| **热窗 / 冷窗** | 换档用精确 `setTimeout` 而不是 15 秒轮询；冷窗攒消息连图一起带回来；热窗收尾只冲刷被压住的那几句 |
| **提示词片段落文件** | `<DSH_HOME>/dsh-qq/prompt/{rules,persona,tail,extra}.md`，设置页四个文本框 + 「保存并重载」，不改代码就能调规矩 |
| **每会话独立工作区** | 每个群 / 每个私聊一份 `AGENTS.md` + `记忆区/`，日记、群词典、话头都在里面，互相看不见 |

**内部标识没跟着改名**：日志前缀 `[dsh-qq]`、HTTP 路由 `/api/dsh-qq/*`、配置目录 `$DSH_HOME/dsh-qq/`、提示词 section 名 `dsh-qq:*` 沿用上游。这是故意的——从上游换过来时，旧的设置文件、表情包收藏、会话目录能直接复用，不用搬家。**包名和插件显示名是 `dsh-qbot`，跟这些内部标识不冲突。**

上游的 bug、想给上游提 PR，请去 [原仓库](https://github.com/2710586329/dsh-qq.git)；这个 fork 特有的东西在这里说。

---

## 它能干什么

| 特性 | 说明 |
| --- | --- |
| 一个 QQ 会话 = 一个持久 Agent 会话 | 有历史、有记忆，不会聊两句就忘 |
| 每个会话一个独立工作目录 | 自带 `AGENTS.md` 和 `记忆区/`，彼此看不见，也碰不到宿主自己的私人记忆 |
| 语音转文字 | 本地 vosk 离线识别，不联网、不上传，结果直接进对话 |
| 群里默认 @ 才理 | 被 @ 过一次后开一段对话窗口，窗口内不用再 @（窗口按「群 + 人」算，别人蹭不到） |
| 分得清谁在跟自己说话 | 引用算叫我、`[SILENT]` 可以不接、同类机器人单独开关、跳过的话也进上下文 |
| 有脾气 | 烦躁度是一个连续量，可以一直看曲线；过阈值会摆脸色、会进无视冷窗 |
| 会发表情包 | 语义检索挑图，按意思找；发不发由它自己定 |
| 不会把自己聊丢 | 窗口快满时补回聊天规矩；再撑满就换新会话，旧的最近聊天先落盘再接上 |
| 十几个互动工具 | `qq_send` / `qq_reply` / `qq_send_image` / `qq_send_file` / `qq_mface` / `qq_face` / `qq_faces` / `qq_keep_face` / `qq_poke` / `qq_react` / `qq_like` / `qq_recall` / `qq_images` / `qq_group_history` / `qq_glossary` / `qq_facts` / `qq_pin` / `qq_meme` |
| 问答能转回 QQ | `ask_user_question` 抛的问题会变成一条 QQ 消息，回个数字就行 |

---

## 界面一览

DSH 侧栏里有一页「**群聊状态与设置**」，两个 tab。截图里的群号、QQ 号、本机路径都换成了假值，表情包缩略图打了马赛克。

### 状态：这一刻它在想什么

![状态 tab](docs/screenshots/01-status.png)

六张卡片，都是实时值：

- **当前相位** —— 热窗还是冷窗，这一档抽到了多长时间，区间是多少；
- **烦躁度** —— 0~100 的连续量，底下写着「本条打分 28.1 · 阈值 75」，能看出是哪句话把它顶上去的；
- **情绪** —— 由烦躁度换算成的档位：平静 / 烦躁 / 愤怒 / 跑路 / 跑路中；
- **换档倒计时** —— 精确到秒，到点真的会变（不再靠 15 秒轮询）；
- **攒着 / 丢弃** —— 冷窗里压着几条没交出去、丢过几条；
- **接话节奏** —— 这一轮它打算等多久再回（跟烦躁度走，越烦越拖）。

底下的曲线 15 秒落一个点，相位切换时额外补一个；三条横线就是三个阈值。**它是纯观测量**——关掉「按烦躁度自动开无视」只是不再自动进冷窗，分数照算，曲线照画。

### 群设置：每一项都能只对这一个群生效

![群设置：触发与节奏](docs/screenshots/02-settings-trigger.png)

左边那一列勾选框是「**跟随全局**」。勾着的时候读全局值、改不动；取消勾选才落到这个群的 `groupOverrides` 里，保存即刻生效，不用重启。

覆盖不是深合并，是**按 key 缺省**：没写就是跟随，写了就以这个群为准。

![群设置：表情包 / 白嫖请求 / 命令](docs/screenshots/03-settings-faces-request.png)

### 表情包收藏：全局一份

![表情包收藏](docs/screenshots/04-faces.png)

所有群和私聊共用同一份收藏——表情包没有按群的概念。四列缩略图，点任意一张打开详情。

![表情包详情](docs/screenshots/06-face-detail.png)

详情里能改**描述**和标签，保存时会**重算这张图的语义向量**，下次按意思挑图就按新描述找。描述留空的图语义检索挑不到，只能靠手动指定。删除会连本地图片一起删掉；商城表情只删这份登记，不影响 QQ 里的表情。

### 提示词片段：不改代码也能调规矩

![提示词片段](docs/screenshots/05-prompt.png)

四个文件摊在页面上，改完点「保存并重载」，下一次请求就按新内容拼。空着就用内置的。

---

## 设计介绍

这一节讲它是怎么搭的，以及几个绕不过去的取舍。

### 一、四层结构

```
你的 QQ 客户端  ←→  NapCat（协议端，注入 QQ）
                        ↕  OneBot v11 WebSocket（array 格式）
        ┌───────────────┴──────────────────────────────────┐
        │  dsh-qbot（跑在 DSH 宿主进程里）                   │
        │                                                   │
        │  ① 连接层   src/onebot/      WS、重连、段解析、echo 匹配 │
        │  ② 闸门层   src/inbound.js   去重 → 谁在说话 → 节奏 → 投递 │
        │  ③ 节奏层   src/rhythm.js    热窗/冷窗/无视 + 烦躁度     │
        │  ④ 会话层   src/session.js   一人一 agent、single-flight │
        └───────────────┬──────────────────────────────────┘
                        ↕  进程内 ctx.agents
                  你的 Agent（你自己的预设、工具、记忆）
```

拆层的原则只有一条：**能不同步进 Agent 的判断，全放在 ②③ 之前**。群里每句话都是一次模型调用，闸门多拦一句就省一轮的 system prompt + 历史。

### 二、一条群消息要走过的门

顺序是刻意排的，换一步都会出错：

| # | 关卡 | 位置 | 拦住了什么 |
| --- | --- | --- | --- |
| 1 | 去重 | `shared/dedupe.js` | 插件被 apply 两次时同一句被处理两遍 |
| 2 | 同类机器人 | `inbound.js` | 群里另一只机器人，开关关着就完全不接 |
| 3 | 图片 / 文件落地 | 必须早于节奏闸 | 否则冷窗里攒下的只剩一行 `[图片]`，图永远到不了它眼前 |
| 4 | 节奏 `gate()` | `rhythm.js` | `hold`（冷窗攒着，零 token）/ `drop`（无视冷窗，直接丢）/ `pass` |
| 5 | 要不要 @ | `shared/mention.js` | 三态：必须 @ / 跟随全局 / 不用 @；引用我、点名、叫名字都算被叫 |
| 6 | 开对话窗口 | `shared/wake-window.js` | 只有真被叫了才计时；窗口按「群 + 人」开，别人蹭不到也续不了 |
| 7 | 均匀回应 | `groupReplyGapMs` | 距上次回复太近就先攒着，到点自己醒 |
| 8 | 窗口额度 | `groupRepliesPerWindow` | 一个窗口最多回几次（默认不限） |
| 9 | 合并窗口 | `rhythm.mergeWindowOf` | 一轮等多久再回，跟烦躁度走 |
| 10 | 分条发送 | `shared/chunk.js` | 长回复按段落拆开，中间留真实停顿 |

第 7、8 道压住的消息进 `pending` 账；第 5 道跳过的进 `backlog` 账。**这两个账是分开的**——前者「该回但没回」，后者只是「别人的话，留个底当上下文」。热窗收尾只交 `pending`，不然窗口早关了它还在替人接话。

### 三、提示词的三层

宿主每轮会把 system 的第一个节点**整块替换**，里面变一个字，前缀缓存就全废。所以：

| 层 | 挂哪儿 | 内容 | 变化频率 |
| --- | --- | --- | --- |
| **静态** | `systemPrompt.section` | `chat-rules`（行为规矩）/ `chat-persona`（人设）/ `chat-tail`（收尾规矩） | 首轮算完**冻结**，逐字节不变 |
| **动态** | `systemPrompt.context` | `chat-dynamics`：事实卡、群词典、话头、群纸条、表情包策略、当前烦躁度 | 每轮重建，作为 runtime-context 塞在用户消息**之前**，不进 system、不进历史 |
| **文件** | `$DSH_HOME/dsh-qq/prompt/*.md` | rules / persona / tail / extra 四个片段 | 点「保存并重载」时重读 |

`dsh-context-ctl` 这类压缩插件也不会把 runtime-context 当成用户发言摘进摘要——它是按 `source.kind` 认的。

### 四、三套时间尺度，别搞混

机器人「什么时候说话」在这个插件里由三个独立的量控制，各管一段：

1. **对话窗口**（`groupWakeMs`，按群可设）——「被 @ 之后多久之内还理你」。固定时长，到点收尾，可配是否每次 @ 都刷新。
2. **热窗 / 冷窗**（`rhythmHotMs` / `rhythmColdMs`）——「它现在是竖起耳朵还是去忙别的」。热窗里正常回，冷窗里只攒消息，攒到冷窗结束一次性交出去（连图一起）。
3. **合并窗口**（`rhythm.mergeWindowOf`）——「这一轮它等多久再开口」。随烦躁度变长：越烦越拖，从几秒拖到几十秒。

三者叠在一起的效果：被 @ 之后（窗口开着）它进入热窗，热窗里说的话按合并窗口的节奏回，热窗到点进冷窗开始攒，攒够了或有人 @ 再醒。

### 五、烦躁度：一个能看的连续量

```
本条打分 = 50·冗余度 + 20·@ 频率 + 10·纠缠度 + 25·复读连击      （clamp 0~100）
        ↓ 先按性格曲线塑形（linear / fast-slow / slow-fast）
        ↓ 再按 ignoreRisePerMsg 平滑进 ignite
ignite  ← 没人说话时按 ignoreDecayTauMs 指数衰减
```

三个阈值读出后会被夹成 `冷静 < 愤怒 < 逃离`，页面乱填也不会出现「永远处于愤怒」这种鬼状态：

- **≥ 愤怒**：只触发一次（边沿触发），按 `ignoreBehaviorMode` 决定是「幸福者退让」还是「必须回击」，文案可以用 `{v}` 换成当前分数；
- **≥ 逃离**：进无视冷窗，期间消息**直接丢**（连 backlog 都不留），出窗口时长按 `ignoreMode` 或 `ignoreShouldEnd` 判定；
- **掉回冷静以下**：愤怒档重新武装，下次爬上来会再炸一次。

`ignoreAuto` 只管「要不要自动进冷窗」，关掉之后分数和曲线照算——否则可视化就是一条死平的线。

### 六、表情包：按意思找，不按名字找

每张收藏有 `summary`（描述）+ `tags` + `vec`（向量）。挑图时给一个自然语言 `query`：

```
embed(query) ──余弦──> 所有收藏
                          ├─ 最高分 ≥ faceEmbedThreshold(0.45) → 直接发
                          └─ 不够贴 → 回 top3 候选描述，且**不发**
```

提示词里**不列名单、不给数量**——只告诉它「可以检索」和「怎样会直接发、怎样会拿到候选」。名单一旦进提示词，它就退化成背名字挑图，还白占几百 token。

发不发的闸在**工具管道**里，不在提示词里：`faceSendGapMs`（两张间隔）和 `faceSendMaxPerHour`（每小时上限），计数按会话分开，全局可配、每个群可覆盖。之所以搬出提示词——写在第 60 行和第 600 行的同一句话，它记住的概率不一样，而工具调用是硬拦。

### 七、会话与上下文

- 同一个人 / 同一个群永远落回同一个 agent 会话，`obtain()` 是 single-flight 的：并发几路只会建一个壳；
- 上下文接近窗口上限时，先把最近几十条聊天落盘，再重置会话，新会话第一轮带上便签 + 最后几句原话接上；
- 被压缩之后（`compaction/end`）会重新注入一次聊天规矩——压缩把规矩卷走了，它就会变成一只彬彬有礼的客服。

### 八、模块地图

`src/` 下按职责分，`shared/` 下都是能脱离宿主单独测的纯函数：

| 文件 | 干什么 |
| --- | --- |
| `index.js` | 插件入口：接线、注册工具、启动各个 tick |
| `inbound.js` | 入站总闸（最大的一个文件，门都在这儿） |
| `outbound.js` | 出站：流式、分条、去重、剥元话语 |
| `rhythm.js` | 冷热窗、烦躁度、合并窗口 |
| `session.js` | 会话获取、换壳、回收 |
| `prompts.js` | 提示词拼装 |
| `chat-prompt.js` | 静态三段 + 动态段的挂载与冻结 |
| `prompt-files.js` | 四个提示词片段的读写 |
| `faces.js` / `face-embed.js` | 收藏、上传、删除、向量、检索 |
| `group-fields.js` / `group-settings.js` | 群设置项定义与「全局 + 覆盖」视图 |
| `settings.js` | 设置页的 HTTP 接口 |
| `tools.js` | 全部 `qq_*` 工具 |
| `shared/*` | 去重、分条、mention、backlog、wake-window、合并正文……都能单测 |

测试：`npm test` → 56 个文件，逐个子进程跑，不依赖 `node --test` 的进程池。

---

## 三步跑通

### 1. 装 NapCat，登录小号

下载 **Windows 一键版**（`NapCat.Shell.Windows.OneKey.zip`），解压运行 `NapCatInstaller.exe`——它装一份独立的 QQ，**不会碰你现有的 QQ**。登录小号，打开 WebUI（默认 `http://127.0.0.1:6099`），在「网络配置」里新建 **WebSocket 服务器**：

| 项 | 填什么 |
| --- | --- |
| 地址 | `127.0.0.1` |
| 端口 | `3001`（被占用就换一个，记住它） |
| Token | 自己编一串，比如 `my-token-2026` |
| 消息格式 | `array`（重要，别选 string） |

> ⚠️ **NapCat 的 QQ 和你桌面的 QQ 是两套程序。** 重装 / 重启 NapCat 时别用 `Get-Process -Name QQ | Stop-Process` 一把全杀——那会把自己正在用的 QQ 也踢下线。按进程路径挑，或者在 NapCat 自己的托盘 / WebUI 里退。

### 2. 装插件

**先把 DSH 完全退出**（托盘也要退掉，插件文件被占用会装到一半失败）。

```powershell
# 装本地包
dsh plugin --profile desktop add "D:\dist\dsh-qbot-1.3.2-20261103.zip"

# 或直接装源码目录（目录名要跟包名一致）
dsh plugin --profile desktop add "D:\dsh-chat\dsh-qbot"
```

三个容易踩的坑：

- **必须用 DSH 自带的 `dsh`，不能 `npx @deepseek-ai/dsh`。** `desktop` 这份 profile 由桌面端独占管理，npx 会直接报 `profile "desktop" is managed exclusively by the Electron application`。PATH 里找不到 `dsh` 就用完整路径：
  ```powershell
  & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "D:\dsh-chat\dsh-qbot"
  ```
- **`--profile` 不能省**，省了直接报 `error: --profile <name> is required`。
- **写绝对路径**，相对路径是按你敲命令那一刻的当前目录算的；目录名要跟包名一致（`dsh-qbot`），否则加载条目解析不到。

装完它会自动写进 `$DSH_HOME/profiles/desktop/package.json` 的 `dsh.profile.bundles`（默认就启用），启动后 **设置 → 插件** 里显示的名字是 **`dsh-qbot`**。想确认：

```powershell
dsh plugin --profile desktop why dsh-qbot
```

### 3. 重启 DSH，填连接信息

重新打开 DSH → **设置 → QQ**，把 `wsUrl` 和 `accessToken` 填进去就行（几十项都在那个面板上，改完即时生效）。

> **设置里没看到 QQ 这一项？** 别慌，两条路都能救。
>
> **① 直接写设置文件**（不用重启宿主）：`$DSH_HOME/dsh-qq/settings.json`，Windows 一般是 `C:\Users\<用户名>\.dsh\dsh-qq\settings.json`。插件第一次启动时会在那儿放一份带说明的骨架，改成：
>
> ```json
> {
>   "wsUrl": "ws://127.0.0.1:3001",
>   "accessToken": "my-token-2026"
> }
> ```
>
> 保存后约 **800ms 自动生效**。
>
> **② 看日志找原因**：插件启动时会自检浏览器半端，日志里有 `客户端半端自检通过：id=...` 就是好的；如果是 `客户端半端自检失败（client-id-mismatch / no-inject ...）`，那句话本身就说明了设置页为什么没出现。日志在 `<workspaceRoot>/logs/dsh-qq-<日期>.log`。也可以看 `$DSH_HOME/dsh-qq/` 下有没有东西——**一个文件都没有**，通常就是浏览器半端根本没被加载。

想直接写 profile 配置也可以，改 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 里 `dsh-qbot` 那一段（整段替换，不是往下叠）：

```yaml
- id: dsh-qbot
  name: dsh-qbot
  config:
    wsUrl: ws://127.0.0.1:3001
    accessToken: my-token-2026
    cwd: D:/my-agent                     # Agent 工作目录，不填用进程 cwd
    workspaceRoot: D:/my-agent/QQ会话    # 每个会话的独立目录（不填用 <cwd>/会话）
    persona: |                           # 它是谁、什么脾气（不填就是个普通助手）
      你叫小满，是个住在电脑里的助手。说话简短、带点懒，被夸的时候会嘴硬。
    provider: deepseek-official          # 想指定模型时才填
    model: deepseek-flash
```

日志里看到 `已连接 ws://127.0.0.1:3001` 就成了，给小号发条私聊试试。

---

## 最常改的几个配置

| 配置 | 默认 | 什么时候改 |
| --- | --- | --- |
| `persona` / `personaFile` | 空 | 想让它有名字、有性格、有称呼 |
| `ownerIds` / `ownerLabel` | `[]` / `主人` | 想在群里认出主人，优先响应 |
| `requireMention` | `true` | 群里不 @ 也想让它接话（或按群用 `mentionMode` 单配） |
| `groupWakeMs` | `60000` | 被 @ 之后理你多久 |
| `rhythmHotMinMs` / `rhythmHotMaxMs` | `90s` / `150s` | 热窗多长（截图里是 90 / 120，那份配置单独调过） |
| `rhythmColdMinMs` / `rhythmColdMaxMs` | `10min` / `20min` | 冷窗多长（截图里是 6 / 15） |
| `groupMode` / `privateMode` | `open` / `allowlist` | 只想在指定群 / 指定人那里开；私聊默认只认白名单 |
| `groupReplyGapMs` | `20000` | 觉得回得太密（防刷屏、防风控） |
| `rateLimitPerMin` | `12` | 每个会话每分钟最多发几条 |
| `contextGuard` | `true` | 不想要自动换会话就关掉 |
| `chatLog` | `true` | 不想记原始流水就关掉 |

**全部配置项见 [docs/configuration.md](docs/configuration.md)。**

## 想深入看哪块

| 想看 | 去哪 |
| --- | --- |
| 它是谁、群里怎么认主人、上下文守卫、认时间、引用与沉默判断 | [docs/persona.md](docs/persona.md) |
| 所有配置项的默认值和含义 | [docs/configuration.md](docs/configuration.md) |
| 长期跑、看门狗、定时写日记、开机自启 | [docs/deployment.md](docs/deployment.md) |
| 改代码、跑测试、目录结构 | [docs/development.md](docs/development.md) |
| 测试怎么做、踩坑记录、排障 | [TESTING.md](TESTING.md) · [tools/README.md](tools/README.md) |

## 在 DSH 设置里调它

不想手改 YAML 的话，**设置 → QQ** 那一节就是个面板：

| 分组 | 能改什么 |
| --- | --- |
| 状态 | 连接点、登录账号、家目录、设置文件；「重连」「重新读一遍」两个按钮 |
| 连接 | `wsUrl`、`accessToken`、`selfId` |
| 它人设 | `persona`、`personaFile`、`ownerLabel` |
| 补充提示 | `directPrompt`、`groupPrompt` |
| 记忆区与工作区 | `workspaceRoot`、`isolateByPeer` |
| 群里怎么说话 | `requireMention`、`groupWakeMs`、`groupReplyGapMs`、`groupMinGapMs`、`rateLimitPerMin`、`historyLimit` |
| 谁能跟它说话 | `privateMode`、`privateAllow`、`ownerIds`、`groupMode`、`groupAllow` |
| 同类机器人 | `botChatEnabled`、`peerBots` |
| 其它 | `debug`、`textChunkLimit`、`splitDelayMs` |

改完立刻生效（`wsUrl` / `accessToken` 要点「重连」；`reconnectMs` / `selfId` / `workspaceRoot` / `isolateByPeer` / `asrPython` 要重启宿主）。设置写在 `$DSH_HOME/dsh-qq/settings.json`，只覆盖你显式设过的键，清空就回默认——**不动 profile 的 `cordis.patch.yml`**。

按群的那些在侧栏「**群聊状态与设置** → 设置」里改，见上面[界面一览](#界面一览)。

### 谁能跟它说话（⚠️ 默认只认白名单）

私聊默认 `privateMode: allowlist`，而 `privateAllow` 默认是空的——**装好之后，谁私聊它都不理**。这是故意的：能私聊这个号的人，就能指挥跑在你机器上的 agent（读文件、跑命令都算）。

要放人进来：

```yaml
privateMode: 'allowlist'
privateAllow:
  - '你的QQ号'
```

想谁都聊就写 `privateMode: 'open'`（风险自担），彻底关掉私聊写 `disabled`。

同一个 QQ 号不能两处同时登录（会互相抢消息），所以桌面 / Web GUI 那份配 `uiOnly: true`：只提供设置页，不连 NapCat；真正干活的是 `--profile qqbot` 那个宿主。

## 和别的 OneBot 插件共存

一台 NapCat 的 WebSocket 一般只该被**一个** Agent 连着。社区的 `dsh-onebot-hub` 之类也连同一台 NapCat 时，两边都会收到同一条消息、各自回一遍——表现是「回复错乱」「一条消息两份回复」，不是任何一边的 bug。

**只留一个：**

```powershell
dsh plugin --profile desktop remove dsh-onebot-hub
# 再确认 profile 的 package.json 里 dsh.profile.bundles 已经没有它
```

搬过来时顺手清一下旧家的状态目录（不清也不影响，只是留着占地方）。dsh-qbot 的家是 `$DSH_HOME/dsh-qq/`（内部标识沿用上游，方便直接复用老配置），卸载插件时这个目录**不会**自动删，设置、日志、覆盖表都在里面，留着下次重装能直接用。

---

## 常见问题

**设置里没有「QQ」这一项**
浏览器半端没被加载。最常见两个原因：插件版本太老（1.1.1 之前的 `dsh.client.inject` 写了宿主要么没有的包），或者装的是改过包名却没跟着改 `client.js` 里 `id` 的版本。**现在不用等更新**：只连 NapCat 的话，改 `$DSH_HOME/dsh-qq/settings.json` 就够了，QQ 本身不依赖设置页。插件启动日志里搜 `客户端半端自检`，它会把原因写在里面。

**连不上 / 一直重连**
先看 `wsUrl` 填没填——留空就完全不连接，日志里会明说「wsUrl 还没填」，不会对着 3001 空转。填了还连不上，看 NapCat 的 WebUI 里 WS 服务器是不是「启用」、端口对不对、Token 两边是否一模一样。

**配置看着没问题，但就是发不出去**
NapCat 的 **WS 和 HTTP 是两个不同的 token**，填错不报错，只是安静地发不出去。另外别让 PowerShell 把配置写出 BOM——一个看不见的字节能让所有判断歪掉。

**收得到消息但 Agent 不回**
群里先确认 @ 了；私聊看 `privateMode` 是不是 `allowlist` 却没把自己加进 `privateAllow`；再看它是不是正处在无视冷窗里（状态页能看到「跑路中」）；都没问题就看 DSH 那边是不是还在跑。

**过了对话窗口还在回话**
1.3.2 之前有这个问题：热窗收尾会把「别人的闲聊」当成「它压着没回的话」一起交出去。现在两个账分开了，只有真被压住的那几句才会被交出去。如果还遇到，看日志里 `热窗结束，把攒着的 N 条一次性交出去` 这一行前后的消息对不对。

**消息重复发两遍**
一般是两个宿主同时连着 NapCat（日志里每行出现两次）。用 `tools/start-bot.cmd` 起，它会先掐掉旧的宿主。

**语音没转出文字**
先确认 `asrPython -c "import vosk"` 能过，再手动跑一次 `<asrPython> <asrScript> <音频文件> [模型目录]`。模型目录必须是**纯 ASCII 路径**（vosk 的 C++ 层不认中文路径）。

**记忆存在哪 / 会不会和宿主串**
默认 `isolateByPeer: true`：私聊在 `<workspaceRoot>/会话/私聊_<QQ号>/`，群在 `群_<群号>/`，第一次用自动铺好 `AGENTS.md` + `记忆区/`。想共用宿主目录就设 `false`。

**能不能群发 / 主动推消息**
不做群发。**冷场时会主动开口**：会话安静满 `proactiveSilentMs`（默认 20 分钟）之后，它有机会自己说一句，说不说由它判断（不想说就 `[SILENT]`）。有静默时段、每天次数上限、以及「连着几次没人接就闭嘴」三道闸。

## 装之前

| 需要 | 版本 |
| --- | --- |
| DeepSeek Harness | ≥ 0.2.0 |
| Node.js | ≥ 18（插件零编译依赖） |
| NapCat | v4.x（推荐 `NapCat.Shell.Windows.OneKey` 独立版） |
| 一个 QQ 小号 | 别用主号，真的 |
| （可选）vosk + numpy | 只有想让语音自动转文字才要；不装也行，语音会标成「没听清」 |

## 放出去之前，逐条确认

1. **别把 token 提交进仓库。** NapCat 的 access token、模型 API key 都放配置里，别写进代码或 commit。
2. **别手改 profile 的 `package.json` / `pnpm-lock.yaml` / `node_modules`。** 装插件用 `dsh plugin --profile <名字> add`，而且要在 DSH 完全退出时做。手改 lockfile 会让 pnpm 重排包、撞到被占用的文件，最坏是整个桌面端报「web 缺失或文件损坏」。
3. **杀进程按路径挑，别 `Get-Process -Name QQ | Stop-Process` 一把全杀。** NapCat 的 QQ 和你桌面的 QQ 是两套程序。
4. **它会花你的 token。** 群里每句话都是一次模型调用，先用 `rateLimitPerMin`、`groupReplyGapMs`、`groupWakeMs` 把节奏压住。
5. **它会读写你指定的工作区。** `workspaceRoot` 指到哪，它就能在哪读写文件。
6. **上下文会被压缩或换会话。** 重要的事要落盘，别指望它一直记得。
7. **人多的地方它可能说错话。** 先用 `groupMode: 'allowlist'` 缩到测试群，稳了再放开。
8. **账号风控不是插件的问题。** 频繁换设备登录、短时间大量发消息都可能被判风险，遇到了去手机 QQ 做安全恢复。

## 出问题了去哪问

**分清楚是哪一半**：连接、重连、会话、语音这些上游骨架的毛病，去 [上游仓库的 Issues](https://github.com/2710586329/dsh-qq/issues) 搜一搜，多半已经有人踩过；本 fork 特有的东西（群聊设置页、烦躁度、表情包检索、提示词片段、热窗/冷窗）在这里说就行。

提之前带上：插件版本、DSH 版本、日志里相关的几行、复现步骤。**别贴 token 和真实 QQ 号。**

日志在哪：`<workspaceRoot>/logs/dsh-qq-<日期>.log`（一天一个文件）。

---

## 许可证与致谢

MIT，见 [LICENSE](LICENSE)。

- 上游 [**dsh-qq-onebot**](https://github.com/2710586329/dsh-qq.git)（早期名 `dsh-qq`），作者 **xier**，版权归原作者所有；
- 本 fork 的改动在同一许可下发布。

用出问题、账号被风控，谁都不承担责任——协议端本来就是灰色地带，用之前想清楚。
