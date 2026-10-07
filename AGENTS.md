# 项目规则（Tranlithion 字幕翻译）

Manifest V3 Chrome 扩展：在 YouTube / Netflix / Google Meet 等页已显示、**可访问**的文本字幕上同步叠加译文；另有网页整页 / 划词 / 侧边栏翻译。语言对为 ja / en / zh-CN 三向互译（网页翻译按段自动识别这三种原文，译成设置的目标语言）。

## 阅读顺序

- 先读本文件，再读 **`README.md`**（能力、架构、配置、Netflix/YouTube 行为细节的操作真源）。
- 产品定位与设计原则：**`PRODUCT.md`**（冷静、低打扰；反仪表盘/反花哨特效）。
- 本机 LibreTranslate 草稿通道：`docs/local-libretranslate.md`。
- 会议模式（Google Meet）的启用步骤、译文通道、计时规则与本机记录保留策略：README「会议模式」章节。
- 网页翻译（整页 / 划词 / 侧边栏）的入口、防崩溃做法、通道与文字去向：README「网页翻译」章节。
- 改行为时同步更新 README / 本文件中过时的硬约束；不要只改代码不改文档。

## 仓库结构

| 路径 | 职责 |
| --- | --- |
| `src/content/` | 内容脚本：适配器、字幕控制器、Overlay、划词按钮；`page/` 为整页翻译（分段、占位标签、通道、调度、状态行） |
| `src/content/adapters/` | `text-track` / YouTube DOM / Netflix DOM / Meet DOM |
| `src/background/` | MV3 service worker：主译、草稿译、本地 MT |
| `src/popup/` `src/options/` `src/sidepanel/` | 弹窗、设置页、侧边栏翻译页 |
| `src/shared/` | 设置、语言对、消息、字幕类型、会话、会议记录、扩展上下文安全封装 |
| `src/demo/` | 演示页相关 |
| `public/manifest.json` | 扩展清单（构建写入 `dist/`） |
| `tests/` | Vitest |
| `scripts/build.mjs` | esbuild 打包到 `dist/` |

## 产品边界（禁止事项）

- **不**绕过 DRM、站点访问限制或版权保护。
- **不**处理烧录字幕；**不**读加密媒体流、不下载受保护音视频轨当 ASR 源。
- Netflix / Meet 等适配只读**页面已公开到 DOM / TextTrack 的文本**；读不到就如实失败，不 hack 播放器或会议客户端内部。
- 会议场景**不**碰音频：无 tabCapture、无麦克风、无 ASR、无会议 SDK、不录制会议。
- **不**伪造翻译成功：未配置服务、无字幕、超时/失败必须对用户说清楚（可保留已有可读草稿/上一句，避免把好译文换成吓人空白）。
- V1 优先 **观看稳定与上下文一致**，不是「所有视频都强行能译」。
- 网页翻译**只写页面已有文本节点的 `data`**：不新建、包裹、移动、删除任何节点（那正是 Chrome 自带翻译让 React 页面 `removeChild` 报错白屏的原因）；不碰表单控件、可编辑区、代码、`translate="no"` / `.notranslate` 与字幕区。页面反复改写的地方先降级为逐节点翻译，仍被改写就放手，不和页面抢。

## 安全与隐私

- API Key **只**存在当前 Chrome 配置文件、扩展信任上下文可访问的存储；**永远不要**发给视频网站或 **content script**。
- 存储读写须遵守 `TRUSTED_CONTEXTS` / 现有 settings 边界；新增存储字段不得扩大 content 可读密钥面。
- 内容脚本与 background 通信用 `src/shared/extension-context.ts` 的安全封装（`safeRuntimeSendMessage` 等）；扩展重载后 context invalidated 时 **安静降级**，禁止未捕获拒绝刷屏。
- 设置页「保存并测试」与「授权并启用 meet.google.com」会申请可选 host 权限：UI 须让用户看清目标域名。Meet 始终是 optional host，未授权前不注册内容脚本。
- 会议模式与会议本机记录**默认关闭**（`DEFAULT_SETTINGS.meetingMode` / `meetingTranscript` 为 false）：读会议字幕、写本机记录都必须由用户亲自勾选，已有的全站 host 授权不得代替这个同意。
- 会议本机记录（`chrome.storage.local`，一场会议一个 `meeting-transcript:<sessionId>` 键）保留 7 天并自动过期；单行写入不得改写整库。写入失败要如实告知用户，不能静默丢弃。设置页必须写清会议文本发往哪个服务、存多久、如何清除。不得在文档或 UI 中声称「完全不留痕」。
- 未勾选本机记录时，会话记忆**只在内存里留术语/重复句**：不得把原话或发言人姓名写进任何 `chrome.storage`（含 `storage.session` 的会话上下文）。这条对大模型通道同样成立，判定见 `keepsSpokenRecord`。取消勾选或清除会议记录时要**当场作废**这场会话记下的原话与发言人姓名（`forgetMeetingSessions` + 从 `storage.session` 上下文里剔除会议会话）；**只动会议会话**，别把影视标签页的上下文/缓存一起清掉（会话来源标在 `PersistedTranslationSession.meeting`）。取消勾选不删已写入的本机记录——那要按「立即清除全部会议记录」或等保留期到。会议三个机器翻译通道都先读会话记忆再发请求；它们不收术语表，由通道自己用 `applyTerminology`（严格大小写、仅 `asFinal`）把用户译名替换回译文——影视页草稿不得被改写。
- 会话记忆按语言对隔离（`TranslationSessionStore.useLanguagePair`）：中途改语言对必须整块作废，旧目标语的缓存/上下文/译名不得当成新语言的结果。
- 网页翻译默认 Chrome 内置本地翻译（文字不出本机）；换成 LibreTranslate / DeepL / 大模型时，设置页与弹窗须写明文字去向（`pageTextDestination`），通道没配好或额度用完要如实报错，**不得**偷偷换通道。侧边栏的内容只在侧边栏页面内存里、页面和后台的译文缓存只在内存里，不写入任何 `chrome.storage`。
- 文档与提交中禁止真实 Key；示例用占位符。

## 运行时行为要点

- 字幕线索统一为带起止时间的 `SubtitleCue`；避免同一句重复提交。
- **视频页的结束判定跟 `video.currentTime`**，不跟墙钟、不把 DOM 短暂空白当结束（Netflix 重绘会闪空）。时钟源抽象见 `src/content/clock.ts`。
- **会议页没有可用的播放时间轴**：用墙钟计时、Overlay 锚在视口（`SubtitleOverlay` 的 anchor 传 null）；空白同样不等于结束。
- 会议字幕是 ASR 流：只提交**未提交过的增量**并在句末标点/长度上限处切段；说话人切换或另起字幕块（按渲染节点判断，不比文本）即结束当前句。识别器收回已断句的文本时**原地更正**（在适配器内重开同一条 cue），不得把收回的措辞当成新的一句去翻译或记录。**已写入本机记录的行一律不回头删改**：更正只是后面新的一行，听到的与更正后的措辞都留着。去重按**定稿 cue 的身份**在提交侧做（每个 cue 只记一次），绝不按文本比对——同一场会里「Okay.」说两遍就是两行。
- Meet 字幕区靠语义选择器 + 结构校验定位（不读本地化 `aria-label`）；**解析出第一行之前不隐藏**原生字幕条，读不出来就把它放回来并如实报不可用。
- 翻译在 background **按观看会话最新优先**（`enqueueLatest`：新字幕取消旧请求，不排队积压），全部走流式；带近期上下文、术语表、人物名线索；术语宜放在稳定 system 前缀以利缓存。存储写入不得挡在译文返回前面。请求期间语言对变了，答复一律丢弃、不进缓存（`throwIfPairChanged`）。
- TextTrack 源提前预翻译后续几句（`src/background/cue-prefetcher.ts`，按顺序、一次一句）；屏上那句排在预翻译列表首位，后台用 `liveCueIds` 保证同一句**只请求一次**。页面 DOM 字幕在出现前不可知，不预翻译，也不为「提前拿到字幕」去读媒体请求。
- 连接预热（`WARM_UP_TRANSLATOR`）只发不带 Key、不带文本的 `HEAD`，且只对这一页实际会用到的通道（会议走机器翻译通道时不碰大模型）。自建 WebSocket 用连接池复用已答复的连接，但**每条连接同一时间只跑一句**，取消/超时照旧关闭该连接——服务端看到的必须仍是一问一答。
- 双轨：可选草稿（本地 / DeepL / 自定义 HTTP）先上屏，主译覆盖；**晚到的草稿不得盖掉已定稿**；草稿在屏时不让流式半句把它缩短。Netflix 只用 DeepL 时 DeepL 是终稿（`asFinal`：终稿时限、保留原样译文、套术语表），但 `meeting` 只由会议通道置位——影视会话不得被标成会议。Chrome 内置翻译对新语言对要求用户激活：`create()` 被拒后等页面上第一次点击/按键再建，不得因此永久关闭通道。
- 会议模式默认**单通道终稿**（机器翻译 / 本机 MT），大模型是可选项；通道没配好要如实报错，**不得**偷偷回落到大模型。
- YouTube：译开时可视觉隐藏原字幕，停译恢复。Netflix：会话内隐藏原字幕 + Overlay 粘性更新，防闪回日文。
- MV3 worker 休眠：会话上下文用 `chrome.storage.session` 等现有机制恢复；离页清理。
- 网页翻译按视口优先（IntersectionObserver，上下各 1.5 屏）、批量、去重；DeepL / 大模型通道用 `<t0>…</t0>` 占位标签整句翻译，标签顺序对不上就退回按片段，绝不移动节点。写回前核对节点仍是读到的原文。扫描按时间片（约 8ms）让出主线程。
- 入口（弹窗 / `Alt+T` / 右键菜单）靠 `activeTab` 按需注入内容脚本；内容脚本有单实例守卫，先注册消息监听再读设置。`sidePanel.open()` 只能在用户手势里调用：后台处理 `SHOW_IN_SIDE_PANEL` 和右键菜单时必须在任何 `await` 之前同步调用它。

## 技术栈与命令

- Node **≥20**；TypeScript；打包 esbuild；测试 Vitest。
- 安装与一次验全：

```bash
npm install
npm run verify   # typecheck + test + build
```

- 开发：`npm run dev`（watch → `dist/`），Chrome `chrome://extensions` 加载 **`dist/`**，改完点扩展刷新。
- 单项：`npm run typecheck` / `npm run test` / `npm run build`。

## 改代码时的落点

| 意图 | 优先看 |
| --- | --- |
| 新站点 / 读字幕方式 | `src/content/adapters/*`、`subtitle-controller.ts`、`clock.ts` |
| 会议模式（判定 / 文案 / 本机记录） | `src/shared/meeting.ts`、`meeting-transcript.ts` |
| 语言对与语言代码映射 | `src/shared/language.ts`（DeepL / LibreTranslate / Translator API 代码都在这里） |
| Overlay 显示与原生字幕显隐 | `src/content/overlay.ts` 及站点分支 |
| 主翻译协议 / 队列 / 缓存 / 预翻译 | `src/background/translator.ts`、`translation-session`、`cue-prefetcher.ts` |
| 草稿通道 | `draft-translator.ts`、`local-mt.ts`、`fast-translator.ts` |
| 设置与权限 UX | `src/options/*`、`src/shared/settings.ts` |
| 网页翻译 / 划词 / 侧边栏 | `src/content/page/*`、`selection-toolbar.ts`、`src/shared/page-translation.ts`（通道、语言识别、去向文案）、`src/background/page-translation.ts`、`src/sidepanel/*` |
| 消息形状 | `src/shared/messages.ts`、`types.ts` |

## 验证期望

- 逻辑变更：补或更新 `tests/` 中对应 vitest；`npm run verify` 通过。
- Netflix/YouTube/Meet 时序与「空白不结束」类行为：优先单测（见 `netflix-*.test.ts`、`meet-*.test.ts`），真机账号页回归由船长或任务说明要求时再做。
- 测试环境无 jsdom：DOM 夹具用 `tests/helpers/fake-dom.ts`，`document` 按 `*-cue-lifecycle.test.ts` 的方式 stub。
- 改 manifest 权限：说明为何需要，默认最小权限；可选 host 保持 optional。
- UI 文案与状态：符合 PRODUCT——直接、可行动；尊重 `prefers-reduced-motion`；不靠纯颜色传达状态。

## 明确不做（除非船长单独授权）

- 把 Key 下发到 content script 或页面 `window`。
- 为「读到更多字幕」而注入破解、抓媒体请求或绕过 DRM 的代码。
- 默认打开吵闹的调试 UI 抢占视频区（演示页须可关且不挡观看；划词按钮只在用户选中文字后出现，会议页默认关闭）。

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
