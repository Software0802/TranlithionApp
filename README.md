# Tranlithion 字幕翻译

一个 **Manifest V3 Chrome 扩展**：在 YouTube 与 Netflix 网页上已显示、可访问的日文文本字幕上同步显示简体中文译文。

V1 的优先级是**观看稳定性和上下文一致性**，而不是把所有视频都强行转写。它不会绕过 DRM、站点访问限制或版权保护，也不会处理烧录字幕。

## 当前能力

- 优先读取 `HTMLVideoElement.textTracks` 的字幕轨道。
- 在 YouTube 上回退读取已显示的 `.ytp-caption-segment` 文本字幕。
- 在 Netflix 上回退读取已显示的公共字幕 DOM（如 `data-uia="player-subtitle-text"`）；不读取媒体请求、加密流或播放器内部数据。
- 统一为带起止时间的 `SubtitleCue`，避免同一句反复提交翻译。
- 双轨字幕：可选先由更快的通道立即上屏「草稿」（带下划线标记），主翻译服务返回后自动替换为正式译文。草稿通道可选 Chrome 内置本地翻译、DeepL API 或自定义 HTTP 机器翻译服务。草稿只会被更完整的结果覆盖，晚到的草稿不会把已定稿的字幕改回低质量文本；通道不可用时自动跳过，不影响原有流程。
- 字幕的结束判定跟随播放进度（`video.currentTime`）而非墙钟时间或 DOM 空白状态，因此暂停、倍速与拖动进度条时字幕行为与画面一致。
- 译文在其字幕结束后仍会短暂保留，避免因译文比原文晚到而被压缩掉阅读时间；下一句字幕出现时立即让位。
- 后台按观看会话串行翻译，携带近期 8 句上下文、用户术语表和已识别的人物名线索。术语表放在请求的 system 前缀中，使其在会话内保持稳定、便于服务端缓存命中。
- 使用 `chrome.storage.session` 保持当前会话上下文，即使 Manifest V3 Service Worker 休眠后也可恢复；页面离开时清理。
- 支持 OpenAI 兼容 Chat Completions API、自建 WebSocket，或清晰标记的离线演示模式。
- 视频 Overlay 支持中文主字幕、双语、字号、位置和背景不透明度设置；翻译开启时会视觉隐藏 YouTube 原生字幕以避免重叠，暂停后立即恢复。
- API Key 只存在当前 Chrome 配置文件中受信任扩展上下文可访问的存储区域，永远不会发送给视频网站或内容脚本。

## 架构

```text
YouTube / Netflix 文本字幕 / TextTrack
  → SubtitleCue 标准化
  → Manifest V3 Background Translation Agent
      ├─ 最近上下文
      ├─ 术语和人物名记忆
      ├─ 文本级译文缓存（Netflix 重复句即时命中）
      └─ 单会话顺序 / 最新优先队列
  → 中文字幕 Overlay（Netflix：粘性更新，会话内隐藏原生字幕）
```

## 本地开发

要求：Node.js 20+、Chrome 或 Chromium。

```bash
npm install
npm run verify
```

构建产物位于 `dist/`。在 Chrome 中加载：

1. 打开 `chrome://extensions`。
2. 打开“开发者模式”。
3. 选择“加载已解压的扩展程序”。
4. 选择本仓库的 `dist` 目录。
5. 固定 `Tranlithion 字幕翻译`，然后打开扩展设置。

开发时可运行：

```bash
npm run dev
```

它会监听 TypeScript/CSS 修改并更新 `dist/`；在 `chrome://extensions` 点击扩展的刷新按钮即可重新加载。

## 配置翻译服务

### OpenAI 兼容 API

在扩展设置页填写：

- API 地址，例如 `https://api.openai.com/v1`
- 模型，例如 `gpt-4.1-mini`
- 你的 API Key

点击“保存并测试「こんにちは」”时，Chrome 会请求连接该服务域名的可选网站权限。接受前请核对域名。

> API Key 以明文保存在 Chrome 的扩展存储中；扩展会将本地与会话存储限制为 `TRUSTED_CONTEXTS`，从而不向内容脚本开放读取权限。请使用专用、可撤销且权限最小化的 Key；不要把它同步到不受信任的 Chrome 配置文件。

### 自建 WebSocket

选择“自定义 WebSocket”后，服务应接受：

```json
{
  "type": "translate",
  "requestId": "uuid",
  "sourceLanguage": "ja",
  "targetLanguage": "zh-CN",
  "cue": { "id": "…", "text": "こんにちは" },
  "context": [{ "source": "…", "translation": "…" }],
  "terminology": [{ "source": "五条悟", "target": "五条悟", "kind": "name" }]
}
```

并返回：

```json
{
  "requestId": "uuid",
  "translation": "你好。",
  "entities": [{ "source": "五条悟", "target": "五条悟", "kind": "name" }]
}
```

`requestId` 必须原样返回；服务端错误可通过 `error` 字段返回。

## 在 Netflix 测试

不需要新增翻译服务配置：沿用已验证的 API Key 即可。更新扩展后：

1. 在 `chrome://extensions` 为 Tranlithion 点击“重新加载”。
2. 打开网页版 `https://www.netflix.com`，登录后播放内容。
3. 在 Netflix 播放器中选择**日文**字幕；不要选择中文或英文字幕作为输入。
4. 等待当前字幕出现。扩展会读取该页面上已显示的文本，并以中文 Overlay 替换视觉显示；暂停扩展会恢复 Netflix 原字幕。

**Netflix 显示策略（防闪 / 贴近实时）：**

- 翻译开启后，原生日文字幕在整段会话内保持视觉隐藏（`opacity: 0`），句与句之间**不会**闪回日文。
- Overlay 采用粘性更新：新一句到来时**不**清空中文；上一句中文留在屏上，直到本句草稿 / 流式 / 终稿就绪后再原地替换。
- 相同日文台词会命中文本级缓存（content 本地 + background 会话），重复句可即时上屏，无需再等网络往返。
- 流式 token 有轻量节流，避免逐字重绘造成字幕抖动。

Netflix 字幕会先等待约 **60 毫秒**的文本稳定期，再发送翻译；连续变化中的旧字幕请求会被取消，只保留最新一句。因此正常等待时间约为“稳定期 + 你的翻译服务响应时间”（缓存命中则为稳定期本身），而不是前面多句字幕的累计时间。开启草稿字幕后，草稿通道的译文会先行上屏，之后由主翻译服务的结果替换。翻译服务失败或超时会显示“翻译服务不可用”；若此时草稿或上一句中文已在屏幕上，则保留可读译文并在扩展弹窗中说明，不会把可读的译文换成错误提示。

字幕的出现与消失使用不同的判定，且消失以**播放进度**而非墙钟时间为准。新文本等待约 60 毫秒即提交翻译；而容器读到空白**不作为该句结束的依据**——Netflix 会在重绘同一句字幕时短暂清空容器，把第一次空白当作结束会导致字幕反复隐藏再出现。真正的结束条件是：容器持续为空，且 `video.currentTime` 相对该句最后一次可见时已前进约 **1200 毫秒**。播放器若用新的 DOM 节点重挂同一行字幕，适配器会识别相同文案并继续当前句，而不会先 end 再 start。

以播放进度计时使字幕行为与画面一致：暂停时 `currentTime` 不前进，译文保持在屏；倍速播放时保持时长按比例缩短；拖动进度条（前进或后退）会立即结束当前句。译文在其字幕结束后的保留时间同样以播放进度计算。

Netflix 适配仅作用于页面已经公开给浏览器 DOM 的字幕文本。它不会绕过 DRM、读取加密媒体流、下载字幕或捕获受保护音频。若弹窗显示“未检测到可读取的字幕”，请确认已开启日文字幕；若仍无效，说明该播放器版本没有向页面暴露可读取文本，需要等待兼容性更新。

## 验证路径

- `npm run typecheck`：严格 TypeScript 检查。
- `npm test`：字幕标准化、设置脱敏、会话上下文/队列、最新字幕优先取消、演示翻译、OpenAI 兼容请求序列化、草稿字幕降级路径、DeepL/自定义草稿请求格式、草稿密钥隔离与字幕阶段覆盖顺序测试。
- `npm run build`：生成可加载的 Manifest V3 扩展。
- `npm run verify`：执行全部上述检查。
- 加载扩展后，打开 `demo.html` 可查看 Overlay 的视觉演示；真实测试需在带日文 CC 的 YouTube 或 Netflix 网页播放器中进行。

已使用临时本地 Chromium 配置文件完成端到端回归：加载 `dist/`、配置演示翻译、读取实际 YouTube 日语字幕轨道，并确认 Overlay 同步、原生字幕抑制/恢复及播放器全屏重挂。Netflix 适配已在真实 `www.netflix.com` 页面上的非 DRM 字幕 DOM 夹具中验证：可读取可见日文、隐藏原字幕并显示中日 Overlay；以 120 毫秒间隔连续更新字幕时，只提交并显示最终一句，缺失 Key 时会显示可见错误反馈。实际登录后播放的 Netflix 字幕仍应由用户在其账号与地区可用的内容上回归确认。真实 API 的网络连通性应在用户保存自己的 Key 后通过设置页的测试按钮确认。

## 项目结构

```text
src/background/  翻译服务、上下文代理、Service Worker
src/content/     视频检测、字幕适配器、Overlay
src/popup/       扩展弹窗
src/options/     服务和字幕设置
src/shared/      Cue、设置、消息和会话模型
public/          Manifest 与扩展页面 HTML
tests/           无浏览器依赖的单元测试
```

## 已知范围与下一步

- 当前支持桌面网页版 YouTube 与 Netflix，源语言默认为日语，目标语言为简体中文。Netflix 仅匹配 `www.netflix.com` 与 `netflix.com` 页面。
- 仅处理网页可读取的文本字幕；OCR 烧录字幕、标签页音频捕获、VAD 和流式 ASR 不属于 V1。
- 草稿通道选择 Chrome 内置翻译时依赖 Translator API。该 API 是否向内容脚本所在的隔离环境暴露、以及日语→中文语言对是否可用，随 Chrome 版本与设备而变，**尚未在真实 Netflix 页面上确认**。不可用时草稿通道会静默关闭，字幕行为与开启前一致；此时可改用 DeepL 或自定义机器翻译服务通道。
- 英文字幕到中文是后续语言支持，不作为当前发布承诺。
- 已验证一条人工日语字幕轨道、Netflix DOM 适配夹具和全屏路径；真实网站兼容性仍应在更多人工/自动生成字幕、Netflix 播放器版本、不同地区内容、布局和网络条件下回归测试。
