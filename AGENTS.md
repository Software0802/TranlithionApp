# 项目规则（Tranlithion 字幕翻译）

Manifest V3 Chrome 扩展：在 YouTube / Netflix 等页已显示、**可访问**的日文文本字幕上，同步叠加简体中文译文。

## 阅读顺序

- 先读本文件，再读 **`README.md`**（能力、架构、配置、Netflix/YouTube 行为细节的操作真源）。
- 产品定位与设计原则：**`PRODUCT.md`**（冷静、低打扰；反仪表盘/反花哨特效）。
- 本机 LibreTranslate 草稿通道：`docs/local-libretranslate.md`。
- 改行为时同步更新 README / 本文件中过时的硬约束；不要只改代码不改文档。

## 仓库结构

| 路径 | 职责 |
| --- | --- |
| `src/content/` | 内容脚本：适配器、字幕控制器、Overlay、页内/快译 |
| `src/content/adapters/` | `text-track` / YouTube DOM / Netflix DOM |
| `src/background/` | MV3 service worker：主译、草稿译、本地 MT |
| `src/popup/` `src/options/` | 弹窗与设置页 |
| `src/shared/` | 设置、消息、字幕类型、会话、扩展上下文安全封装 |
| `src/demo/` | 演示页相关 |
| `public/manifest.json` | 扩展清单（构建写入 `dist/`） |
| `tests/` | Vitest |
| `scripts/build.mjs` | esbuild 打包到 `dist/` |

## 产品边界（禁止事项）

- **不**绕过 DRM、站点访问限制或版权保护。
- **不**处理烧录字幕；**不**读加密媒体流、不下载受保护音视频轨当 ASR 源。
- Netflix 等适配只读**页面已公开到 DOM / TextTrack 的文本**；读不到就如实失败，不 hack 播放器内部。
- **不**伪造翻译成功：未配置服务、无字幕、超时/失败必须对用户说清楚（可保留已有可读草稿/上一句，避免把好译文换成吓人空白）。
- V1 优先 **观看稳定与上下文一致**，不是「所有视频都强行能译」。

## 安全与隐私

- API Key **只**存在当前 Chrome 配置文件、扩展信任上下文可访问的存储；**永远不要**发给视频网站或 **content script**。
- 存储读写须遵守 `TRUSTED_CONTEXTS` / 现有 settings 边界；新增存储字段不得扩大 content 可读密钥面。
- 内容脚本与 background 通信用 `src/shared/extension-context.ts` 的安全封装（`safeRuntimeSendMessage` 等）；扩展重载后 context invalidated 时 **安静降级**，禁止未捕获拒绝刷屏。
- 设置页「保存并测试」会申请可选 host 权限：UI 须让用户看清目标域名。
- 文档与提交中禁止真实 Key；示例用占位符。

## 运行时行为要点

- 字幕线索统一为带起止时间的 `SubtitleCue`；避免同一句重复提交。
- **结束判定跟 `video.currentTime`**，不跟墙钟、不把 DOM 短暂空白当结束（Netflix 重绘会闪空）。
- 翻译在 background **按观看会话串行**；带近期上下文、术语表、人物名线索；术语宜放在稳定 system 前缀以利缓存。
- 双轨：可选草稿（本地 / DeepL / 自定义 HTTP）先上屏，主译覆盖；**晚到的草稿不得盖掉已定稿**。
- YouTube：译开时可视觉隐藏原字幕，停译恢复。Netflix：会话内隐藏原字幕 + Overlay 粘性更新，防闪回日文。
- MV3 worker 休眠：会话上下文用 `chrome.storage.session` 等现有机制恢复；离页清理。

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
| 新站点 / 读字幕方式 | `src/content/adapters/*`、`subtitle-controller.ts` |
| Overlay 显示与原生字幕显隐 | `src/content/overlay.ts` 及站点分支 |
| 主翻译协议 / 队列 / 缓存 | `src/background/translator.ts`、`translation-session` |
| 草稿通道 | `draft-translator.ts`、`local-mt.ts`、`fast-translator.ts` |
| 设置与权限 UX | `src/options/*`、`src/shared/settings.ts` |
| 消息形状 | `src/shared/messages.ts`、`types.ts` |

## 验证期望

- 逻辑变更：补或更新 `tests/` 中对应 vitest；`npm run verify` 通过。
- Netflix/YouTube 时序与「空白不结束」类行为：优先单测（见现有 `netflix-*.test.ts` 等），真机账号页回归由船长或任务说明要求时再做。
- 改 manifest 权限：说明为何需要，默认最小权限；可选 host 保持 optional。
- UI 文案与状态：符合 PRODUCT——直接、可行动；尊重 `prefers-reduced-motion`；不靠纯颜色传达状态。

## 明确不做（除非船长单独授权）

- 把 Key 下发到 content script 或页面 `window`。
- 为「读到更多字幕」而注入破解、抓媒体请求或绕过 DRM 的代码。
- 默认打开吵闹的调试 UI 抢占视频区（吉祥物/演示须可关且不挡观看）。
