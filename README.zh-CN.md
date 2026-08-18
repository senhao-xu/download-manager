# Download Manager（中文文档）

[English](README.md) | 中文

一个自托管的 Web 下载应用，支持多种来源：HTTP(S) 直链、YouTube 视频/播放列表
（可选清晰度）、哔哩哔哩视频/播放列表、以及 BitTorrent（磁力链 / .torrent 文件）。
粘贴链接、选择选项、开始下载。

- **后端**：Python + FastAPI，以库的形式内嵌 [yt-dlp](https://github.com/yt-dlp/yt-dlp)（nightly 版本）。
- **前端**：React (Vite) 单页应用，由后端直接托管。
- **下载** 在进程内线程池中运行，实时显示进度（SSE）；播放列表多选会打包成
  zip；HTTP 中继和 BitTorrent 各有独立的工作线程池。文件按 TTL 自动清理。
- **标签页**：**HTTP** 页（服务器作为中继的直接下载）、**YouTube** 页
  （Cookie/代理在页面内配置，并自动检测 Cookie 可用性）、**哔哩哔哩** 页
  （单视频 + 分P/合集，独立的 Cookie 用于 1080P+ / 大会员内容）、**BT** 页
  （通过 libtorrent 处理磁力链 / .torrent）。
- **历史记录**：按标签页分列、分页（每页 10 条），内嵌在各标签页下方。
- **主题与语言**：深色/浅色/跟随系统主题切换，以及中文/English 切换（右上角），
  选择会被记住。

## 快速开始（Docker）

GHCR 上有预构建镜像：

```bash
docker run -d -p 8000:8000 -v "$PWD/data:/data" \
  -e DATA_DIR=/data -e DOWNLOAD_DIR=/data/downloads \
  --name download-manager ghcr.io/senhao-xu/download-manager:latest
```

或从源码构建：

```bash
git clone https://github.com/senhao-xu/download-manager.git
cd download-manager
docker compose up -d --build
# 打开 http://localhost:8000，然后进入 YouTube 标签页配置 cookies/代理
```

下载的文件保存在 `./data/downloads/` 下，超过 `TTL_MINUTES` 后自动删除。

## ⚠️ YouTube 需要 Cookies（通常还需要代理）

YouTube 会用"登录以确认你不是机器人"的墙来拦截非住宅/数据中心 IP，并且在
部分地区无法直接访问。要让 YouTube 正常工作，请在 Web 界面中同时配置以下
两项：

1. 打开应用，切换到 **YouTube** 标签页，展开 URL 输入框上方的 **设置** 区块。
2. **Cookies** - 从已登录 YouTube 的浏览器会话导出 `cookies.txt`
   （可使用 "Get cookies.txt" 浏览器扩展），粘贴到 Cookies 输入框并点击
   **保存 Cookies**。保存后（以及每次进入 YouTube 标签页时）会自动验证
   Cookie 是否可用。
3. **代理** - 输入一个能访问 YouTube 的 HTTP/SOCKS 代理（例如宿主机上的代理
   可填 `http://host.docker.internal:7890`）并**保存**。
4. 用一个 YouTube 链接点击 **测试** 进行验证。

设置会持久化保存在 `DATA_DIR` 下（Docker 中为 `/data`，本地为 `./data`），
立即生效，无需重启。环境变量 `YTDLP_COOKIEFILE` / `YTDLP_PROXY` 是可选的
兜底配置。运行时要求 **node >= 22**（Docker 中通过 NodeSource 安装），用于
解决 YouTube 的 JS 挑战；yt-dlp-ejs 0.8.0 不支持 deno 2.x 和 node < 22。

不配置 cookies/代理时，YouTube 链接会返回明确的"被机器人拦截"错误；
yt-dlp 支持的非 YouTube 来源（如 archive.org）无需这些配置即可使用。

> 注意：yt-dlp 对 YouTube 的支持经常被破解/失效。镜像安装的是 **nightly**
> 版 yt-dlp。如果解析突然失败，请重新构建镜像或升级 yt-dlp：
> `pip install --pre -U yt-dlp`。

## 哔哩哔哩：配置 Cookie 解锁更高清晰度

B 站对**匿名**访问会限制在 720P 左右（实际往往更低）；**1080P 及以上画质，
以及大会员内容，需要登录账号**。要解锁，请切换到 **哔哩哔哩** 标签页，展开
**设置**，粘贴从已登录浏览器导出的 `cookies.txt`（必须包含 `bilibili.com`
域名，如 `SESSDATA`）。这些 Cookie 会存放在**独立**的文件中，与全局 YouTube
Cookie 分开。若未配置 B 站专用 Cookie，而全局 `cookies.txt` 已包含
`bilibili.com`，则会自动作为备用。分P（多 P）视频和合集支持通过勾选列表/
批量下载，体验与 YouTube 播放列表一致。

## 本地开发

```bash
# 后端（Python 3.11+）
cd backend
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
pip install --pre -U yt-dlp          # nightly
uvicorn app.main:app --reload --port 8000

# 系统依赖：ffmpeg、node >= 22（用于 yt-dlp-ejs / YouTube 的 JS 挑战）

# 前端（另开一个终端）
cd frontend
npm install
npm run dev      # http://localhost:5173（/api 代理到 :8000）
```

构建前端以供后端托管：

```bash
cd frontend && npm run build      # 输出到 frontend/dist/，由后端在 / 提供
```

## 配置

大部分 YouTube 相关设置在 **YouTube** 标签页的设置区块中在线编辑
（持久化到 `DATA_DIR`）。以下环境变量是默认值/兜底项：

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `PORT` | `8000` | 后端端口 |
| `DATA_DIR` | `./data` | 设置 + cookies + 下载根目录 |
| `DOWNLOAD_DIR` | `$DATA_DIR/downloads` | 下载文件存放位置 |
| `TTL_MINUTES` | `60` | 超过此时间的文件会被删除 |
| `MAX_CONCURRENT` | `3` | 并发下载工作线程数 |
| `YTDLP_COOKIEFILE` | _(无)_ | `cookies.txt` 的兜底路径（UI 优先） |
| `YTDLP_BILIBILI_COOKIEFILE` | _(无)_ | B 站 `cookies.txt` 的兜底路径（UI 优先） |
| `YTDLP_PROXY` | _(无)_ | 兜底 HTTP/SOCKS 代理（UI 优先） |
| `YTDLP_IMPERSONATE` | _(无)_ | 浏览器 TLS 伪装目标（如 `chrome`） |
| `YTDLP_SLEEP_INTERVAL` | `0` | 请求间延迟（防限流） |
| `BT_MAX_CONCURRENT` | `1` | BitTorrent 并发下载线程数（与 YouTube/HTTP 独立的线程池） |
| `BT_LISTEN_PORT` | `6881` | BT peer/DHT 的 TCP+UDP 端口（映射出去可提升连通性） |

## API

| 方法 | 路径 | 请求体 | 返回 |
|---|---|---|---|
| POST | `/api/info` | `{url}` | 视频格式列表或播放列表条目 |
| POST | `/api/download` | `{url, quality}` | `{job_id}` |
| POST | `/api/download-batch` | `{urls[], quality}` | `{job_id}` |
| POST | `/api/download-http` | `{urls[]}` | `{job_id}`（HTTP 中继下载） |
| POST | `/api/download-bt` | `{magnet}` | `{job_id}`（BitTorrent 磁力链） |
| POST | `/api/download-bt/file` | multipart `.torrent` | `{job_id}`（BitTorrent 种子文件） |
| POST | `/api/download-bilibili` | `{url, quality}` | `{job_id}`（哔哩哔哩视频） |
| POST | `/api/download-bilibili-batch` | `{urls[], quality}` | `{job_id}`（哔哩哔哩分P/合集） |
| GET | `/api/jobs/{id}` | - | 任务状态快照 |
| GET | `/api/jobs/{id}/events` | - | SSE 进度流 |
| GET | `/api/files/{id}` | - | 下载的文件或 zip |
| GET | `/api/files/{id}/{index}` | - | 多文件任务中的单个文件 |
| GET | `/api/history` | - | 历史下载及文件是否仍在磁盘上 |
| GET | `/api/settings` | - | 当前设置（不含 cookie 内容） |
| PUT | `/api/settings` | `{proxy, js_runtimes}` | 更新后的设置 |
| PUT | `/api/settings/cookies` | 原始 `cookies.txt` 文本 | `{cookies_configured}` |
| DELETE | `/api/settings/cookies` | - | `{cookies_configured}` |
| PUT | `/api/settings/bilibili-cookies` | 原始 `cookies.txt` 文本 | `{bilibili_cookies_configured}` |
| DELETE | `/api/settings/bilibili-cookies` | - | `{bilibili_cookies_configured}` |
| POST | `/api/settings/test` | `{url}` | `{ok, title, error}` 连接测试 |
| POST | `/api/settings/check-cookies` | `{url}` | `{state, title, detail}` Cookie 可用性检测 |
| POST | `/api/settings/bilibili-check-cookies` | `{url}` | `{state, title, detail}` B 站 Cookie 检测 |

`quality` 为 `"best"`（默认）或形如 `"1080"` 的分辨率高度。

## 功能特性

- **标签页** - **YouTube** 页（粘贴视频/播放列表链接，选择清晰度，下载）、
  **哔哩哔哩** 页（粘贴 `bilibili.com` / `b23.tv` 视频或分P/合集链接，
  选择清晰度；独立 Cookie 用于 1080P+ / 大会员内容）、**HTTP** 页
  （粘贴一条或多条 HTTP(S) 直链；服务器以中继方式流式下载并提供文件，
  带实时进度）、**BT** 页（粘贴磁力链或上传 `.torrent` 文件；通过
  BitTorrent 下载，带实时进度）。记住上次选择的标签页。
- **BitTorrent** - 通过 `libtorrent` 支持磁力链和 `.torrent` 文件（不做种：
  达到 100% 后立即停止任务）。BT 使用独立的工作线程池
  （`BT_MAX_CONCURRENT`），不会阻塞 YouTube/HTTP 下载；运行中的 BT 任务
  不受 TTL 清理影响。为获得更好的 peer/DHT 连通性，建议在 compose/run
  配置中映射 `BT_LISTEN_PORT`（TCP+UDP），例如添加
  `-p 6881:6881/tcp -p 6881:6881/udp`。
- **预览** - 完成的视频/音频下载可直接在页面内播放（HTTP 页还支持图片），
  无需重新下载。
- **历史记录** - 每个完成的下载都会记录到 `<DATA_DIR>/history.jsonl` 并
  显示在历史面板中；仍在磁盘上的文件可重新预览/下载，已过期的会置灰显示。
  历史记录在重启后保留。
- **主题** - 深色 / 浅色 / **跟随系统**（跟随系统偏好并实时切换）；
  语言切换 中文 / English。选择会被记住。

## 法律声明

YouTube 的服务条款禁止在 YouTube 未提供下载链接的情况下下载内容，哔哩哔哩
也通过自己的条款对其服务访问加以限制。本项目仅供**个人使用**。你有责任遵守
所在司法管辖区的适用法律及各平台的服务条款。
