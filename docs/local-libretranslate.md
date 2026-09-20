# 本机 LibreTranslate（全页 / 选区翻译）

视频字幕（Netflix 等）继续走 DeepL。
网页全文与选中文字默认走本机 LibreTranslate，不经过云端大模型。
会议模式也可以把本机 LibreTranslate 选作会议译文通道：启用步骤、地址是否为回环地址决定的文本去向，见 README「会议模式」章节。

## 要求

- Windows 10/11
- **二选一**：
  - [Docker Desktop](https://www.docker.com/products/docker-desktop/) 已安装并在运行；或
  - 本机有 `py` / `python`（脚本会自动建 `tools/libretranslate/.venv`）

本机若无 Docker，脚本会自动走 Python 方式。

## 一键启动

在仓库根目录 PowerShell：

```powershell
.\scripts\start-libretranslate.ps1
```

首次安装依赖并下载 ja→en / en→zh 语言模型会较慢，之后启动很快。
日→中无直连包，经英语中转（Argos 官方模型如此）。

默认地址：`http://127.0.0.1:5000/translate`

浏览器打开 `http://127.0.0.1:5000` 能看到 LibreTranslate 页面即表示成功。

Python 模式日志：`tools/libretranslate/libretranslate.out.log` / `.err.log`

## 扩展里怎么配

1. 打开 Tranlithion **选项**
2. 开启 **本机翻译服务（LibreTranslate）**
3. 地址保持 `http://127.0.0.1:5000/translate`（一般不用改）
4. 保存；若 Chrome 询问访问 `127.0.0.1` → **允许**
5. 重新加载扩展，刷新要翻译的网页

## 停止

```powershell
.\scripts\stop-libretranslate.ps1
```

或 Docker：

```powershell
docker stop libretranslate
docker start libretranslate
```

## 说明

- LibreTranslate 是开源第三方软件；本机运行时，译文请求只打到你自己的电脑。
- 日→中质量取决于其自带模型，通常够用浏览；要精翻难句仍可用 DeepSeek。
- `tools/libretranslate/.venv` 体积较大，已加入 `.gitignore`，勿提交。
