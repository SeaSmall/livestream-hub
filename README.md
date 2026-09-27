# livestream-hub · OBS 网页直播中枢

把 OBS 的画面推给一群人看，**同时满足这几个在普通直播平台很难同时做到的事**：

- 🎯 **同一个链接，自动分两条线路**：同一局域网的人走**直连**看原画（1080p60、毫秒级延迟、不耗流量），外面的人走**中转**看压缩流（720p、省流量）
- 🔒 **真名门禁**：观众必须输入名单里的真名才能进，否则直接被挡在门外
- 👤 **同名唯一**：同一个名字只允许一个人在线，防止两个人共用名字混进来
- 💬 **多用户聊天**：观众之间互相可见、可回复；主播端有一个**右下角始终置顶**的只读消息窗
- 📋 **在线名单**：观众和主播都能看到当前在线的都有谁、各自走的是直连还是隧道
- 🛡 **主播可管人**：在置顶消息窗里**点观众名字**就能禁言 / 踢出，观众伪造指令无效
- 📱 **手机全屏**：全屏后底部是仿 B 站的输入条，消息以弹幕形式飘过
- 🧹 **聊天不残留**：每次开播自动清空聊天（服务重启、或推流重新开始都会触发）
- 📉 **流量可控**：中转流量按需产生（没人在线就零开销），静止画面自动降码率，实时统计并带额度告警
- 🚀 **一键启动 + 开机自启**，桌面图标直接点

---

## 目录

- [它是怎么工作的](#它是怎么工作的)
- [快速开始](#快速开始)
- [OBS 设置（关键）](#obs-设置关键)
- [发给观众什么链接](#发给观众什么链接)
- [让外网也能看到](#让外网也能看到)
- [管理观众：禁言 / 踢人](#管理观众禁言--踢人)
- [配置文件说明](#配置文件说明)
- [常见问题](#常见问题)
- [排错](#排错)
- [目录结构](#目录结构)
- [第三方组件](#第三方组件)
- [许可](#许可)

---

## 它是怎么工作的

```
                    ┌──────────────── 局域网观众 ────────────────┐
                    │  WebRTC/WHEP (UDP 8189)  延迟 ~1ms         │
                    │  降级: LL-HLS                              │
                    └────────────────────▲──────────────────────┘
                                         │
  OBS ──WHIP──> MediaMTX [live] ─────────┤  1080p60 H264 + Opus 原画
                     │
                     └──按需转码──> [wan] ──LL-HLS──> 外网观众
                        720p/1.3Mbps                 (经隧道，计流量)
                        (有人看才启动，
                         最后一个观众走后 30 秒自动停)

                   ┌────── Node 中央服务 (:7000) ──────┐
                   │ 入口页 / 线路分流 / 真名门禁      │
                   │ 多用户聊天 (WebSocket)            │
                   │ HLS+WHEP 反代 + 流量统计          │
                   └───────────────────────────────────┘
```

**关键设计**：

| 设计 | 原因 |
|---|---|
| OBS 用 **WHIP** 而不是 RTMP | WebRTC 规范只认 **Opus** 音频。RTMP 推上来是 AAC，MediaMTX 会直接丢掉音轨（日志写 `skipping track 2 (MPEG-4 Audio)`），结果就是局域网观众**看得到画面但没有声音**。WHIP 推的是 Opus，问题自然消失 |
| 只对局域网暴露 2 个端口 | `7000/TCP`（网页+聊天+反代）、`8189/UDP`（WebRTC 媒体）。MediaMTX 的 8888/8889/1935/8554/9997 一律只绑 `127.0.0.1` |
| 外网档用 capped-VBR 而不是 CBR | 讲 PPT / 写代码时画面是静止的，码率会自动掉到几十 kbps。实测静止画面一个 1 秒分片只有 **2 KB** |
| 一键启动脚本做了幂等 | 重复点桌面图标**不会**打断正在进行的直播，只会在服务没起来时启动 |

---

## 快速开始

### 环境要求

| 依赖 | 说明 |
|---|---|
| Windows 10/11 | 脚本是 PowerShell |
| **Node.js 18+** | <https://nodejs.org/> |
| **ffmpeg** | 外网那路 720p 转码要用。`winget install Gyan.FFmpeg` |
| NVIDIA 显卡（可选） | 有的话转码走 `h264_nvenc`，几乎不吃 CPU；没有就改 `mediamtx.yml` 用 `libx264` |
| OBS Studio 30+ | 需要支持 WHIP 输出（插件目录里有 `obs-webrtc.dll` 即可） |

### 三步装好

```powershell
git clone https://github.com/SeaSmall/livestream-hub.git
cd livestream-hub
.\setup.ps1
```

`setup.ps1` 会：检查依赖 → 下载 MediaMTX → 生成配置（含随机 hostKey）→ 装 Node 依赖 → 建桌面快捷方式。

> 国内直连 GitHub 下载慢的话，加个加速前缀：
> ```powershell
> .\setup.ps1 -GithubMirror https://ghfast.top/
> ```

装完桌面上会有 **「开始直播」** 和 **「结束直播」** 两个图标。

### 然后

1. 编辑 `data\names.txt`，**换成你的观众名单**（一行一个真名）
2. 双击「开始直播」
3. 按下面的 [OBS 设置](#obs-设置关键) 配好，点「开始推流」

---

## OBS 设置（关键）

**设置 → 直播**

| 字段 | 值 |
|---|---|
| 服务 | **WHIP** |
| 服务器 | `http://127.0.0.1:8889/live/whip` |
| 承载令牌 / 串流密钥 | 留空 |

**设置 → 视频**：输出分辨率 `1920x1080`，FPS `60`（或 30）

**设置 → 输出**：比特率 `6000` Kbps 以上

> ⚠️ **必须用 WHIP。** 用 RTMP（`rtmp://127.0.0.1:1935/live`）也能推上去，但音轨会是 AAC，
> 局域网观众走 WebRTC 时**只剩画面没有声音**。
> 如果你只能用 RTMP：把 `data\config.json` 里的 `streamPaths.lan` 改成 `"lanav"`，
> 那条按需路径会把音轨转成 Opus（视频直接 copy，不重编码）。

---

## 发给观众什么链接

**只发一个链接，就是「外网入口」。** 页面会自己判断线路：

| 观众在哪 | 会发生什么 |
|---|---|
| 和你**同一局域网** | 点一下「我在校园网内」→ 之后自动走直连：1080p60 原画、毫秒级延迟、**不消耗任何中转流量** |
| 在**外面** | 什么都没发生，直接用中转线路看 720p |

### 为什么不能"全自动"？

不是实现问题，是**浏览器的安全策略**。Chrome / Edge 从 130 版开始有
「本地网络访问（Local Network Access）」管控：**公网页面访问私有网段必须用户授权，默认拒绝**。

实测（同一台机器，同一个目标地址 `http://<内网IP>:7000/probe`）：

| 页面来源 | 结果 |
|---|---|
| 公网地址 | `local-network-access` = **denied**，请求 **2 毫秒内**被拦掉 |
| 内网地址 | ✅ 成功 |

HTTP / HTTPS 都一样，绕不过去。但**顶层跳转（点链接）不受这个策略限制**，
所以做成了「**一次点击 + 永久记住**」——这是浏览器允许的最优解。

如果观众点「校园网内」打不开新标签页，说明他确实不在同一局域网，关掉继续用中转即可。

---

## 让外网也能看到

项目本身**不含任何穿透服务**，你需要在外面套一层。家用宽带有公网 IP 就直接端口映射，
没有的话用内网穿透（`frp` / `SakuraFrp` / `cloudflared` / `Tailscale` 都行）。

**需要穿透的只有一个端口：`7000/TCP`**（网页、聊天、HLS 全在这一个口上）。

几点经验（踩过的坑）：

| 坑 | 说明 |
|---|---|
| **国内节点通常拦截明文 HTTP** | 会返回一个 501 提示页（机房内容合规要求）。要么给入口页启用 HTTPS，要么把入口隧道放在境外节点上 |
| **隧道配置里的"本地地址"要填 `127.0.0.1`** | 别填具体内网 IP。DHCP 一续约 IP 就变了，隧道会静默失效 |
| **用了 TCP 隧道，服务端看到的来源 IP 全是 `127.0.0.1`** | 所以本项目**不靠 IP 判断内外网**，而是由入口页自己申报线路（`?via=lan|wan`），否则所有人都会被误判成局域网，流量统计也会错 |
| 配好之后 | 把地址填进 `data\config.json` 的 `publicUrl`，启动时会打印出来 |
| WebRTC 跨公网 | 需要 UDP 打洞或 TURN。**对称 NAT / 运营商级 NAT 下打洞必然失败**，这种情况外网观众只能走 HLS（延迟 2–3 秒），属正常现象 |

---

## 手机观看 / 全屏

观众页在手机上是「视频在上、聊天在下」的自适应布局，底部有个 **⛶ 全屏** 按钮。

进全屏后（仿 B 站）：

- 底部弹出半透明**输入条**，直接打字发送，不用退出全屏
- 消息以**弹幕**形式从右往左飘过；右上角可以一键关掉弹幕
- 点屏幕显示/隐藏控件，4 秒无操作自动隐藏
- 手机弹出软键盘时，输入条会自动上移（用了 `visualViewport`，纯 CSS 做不到）
- 顶部有「退出全屏」按钮（安卓返回键也能退）

**iOS Safari 的限制**：它不支持给普通网页元素全屏，脚本会自动退化为**视频原生全屏**
（此时没有底部输入条和弹幕，是浏览器的硬限制）。想要完整体验，
在 Safari 里「分享 → 添加到主屏幕」，从桌面图标打开即可。

---

## 聊天什么时候会被清空 / 什么时候要重新报名字

默认**每次开播都是全新的**，包含两件事：聊天内容清空，并且**观众要重新输入一次名字**。

| 时机 | 会发生什么 |
|---|---|
| 中央服务启动时 | 清空聊天 + 清空所有已登录会话（也就是每次双击「开始直播」） |
| **推流从离线变成在线时** | 清空聊天（服务一直开着，你停播再开播也会重置） |
| 名字被移出白名单 | 该名字的旧 token **立刻失效**，下次请求就会要求重新验证 |

清空聊天时所有在线观众会立刻收到通知，聊天区和弹幕层一起清掉，并显示「新一轮直播开始，聊天已重置」。
磁盘上的 `data\chat.jsonl` 也会被截断，所以**关掉服务聊天就没了**。

> **为什么要复查白名单**：会话是按 token 记的。如果只在进门的瞬间校验一次名字，
> 那么把某人移出名单之后，他手里的旧 token 在有效期内仍然能免检进入。
> 所以 `/api/me` 和聊天 WebSocket 握手时都会**再对一次当前白名单**。

两个开关（`data\config.json`）：

| 配置 | 默认 | 作用 |
|---|---|---|
| `clearChatOnStart` | `true` | 服务启动时清空聊天 |
| `clearSessionsOnStart` | `true` | 服务启动时清空所有会话（观众需重新报名字） |

停播再开播时的清空不受这两个开关影响，始终生效。

手动清空聊天（主机用）：

```powershell
$cfg = Get-Content data\config.json -Raw | ConvertFrom-Json
Invoke-RestMethod "http://127.0.0.1:$($cfg.port)/api/clear-chat?key=$($cfg.hostKey)" -Method POST
```

---

## 管理观众：禁言 / 踢人

不用离开直播画面，就在右下角那个置顶的「观众消息」小窗里操作：

**点一下观众名字** → 弹出菜单 → 选「禁言」或「踢出」。

| 操作 | 效果 |
|---|---|
| **禁言** | 对方的输入框立刻锁上、提示改成「你被禁言了」；他发消息会被**服务端**拦下并回一句「你被禁言了，暂时不能发言」（所以改前端代码也没用）。菜单里再点一次是「解除禁言」 |
| **踢出** | 连接立刻断开、他的登录会话同时作废，需要**重新输入名字**才能进来。会弹一次确认框，防手滑 |
| 系统提示 | 「某某已被禁言 / 已被移出」会广播给所有在线观众，谁被处理了大家都看得到，不会莫名其妙少人 |
| 在线条上的标记 | 被禁言的名字显示成虚线并带 🔇；走直连的是绿色、走隧道的是橙色 |

几点说明：

- **只有主机能操作**。聊天 WebSocket 里观众发的管理指令会被服务端直接丢掉（`ws.isHost` 校验），
  所以观众既踢不了人也禁言不了别人。
- **禁言名单只在内存里**，服务重启就清空 —— 和聊天一样，每次开播都是干净的。
- **踢人不是拉黑**。名字还在 `data\names.txt` 白名单里，对方重新输入名字就能再进来。
  真要彻底不让某人进：把那个名字从 `data\names.txt` 里删掉（热加载，存盘即生效，他的旧 token 也会立刻失效）。
- 如果你是从旧版本升级上来的，**右下角那个消息窗要关掉重开一次**（旧页面里没有这个菜单）。

---

## 配置文件说明

### `data/config.json`

```jsonc
{
  "port": 7000,              // 中央服务端口；隧道指到这里
  "hostKey": "...",          // 主机消息窗的密钥，setup.ps1 随机生成，别外泄
  "hlsPort": 8888,           // MediaMTX HLS 端口（本地）
  "webrtcPort": 8889,        // MediaMTX WebRTC 端口（本地）
  "quotaGB": 100,            // 中转流量月额度，超 70% 变黄、超 90% 变红
  "lanIfaces": [],           // 指定用哪些网卡当"局域网地址"；空=自动识别
  "excludeIfaces": ["VMnet", "VMware", "Bluetooth", "Loopback", "vEthernet", "WSL", "Virtual"],
  "clearChatOnStart": true,  // 启动时清空聊天（停播再开播始终会清，见上一节）
  "clearSessionsOnStart": true, // 启动时清空会话，观众需重新报名字
  "streamPaths": {
    "lan": "live",           // 局域网档；OBS 用 RTMP 推流时改成 "lanav"
    "wan": "wan"             // 外网档（按需转码）
  },
  "publicUrl": ""            // 外网入口，填了启动时会打印
}
```

改完**保存即生效**，不用重启。

### `data/names.txt`

```
# 一行一个真名，# 开头是注释，空行忽略
张三
李四
```

**保存即生效**（服务热加载）。名字区分大小写、按完全一致匹配。

---

## 常见问题

<details>
<summary><b>局域网观众有画面没声音</b></summary>

OBS 没用 WHIP 推流。改成 WHIP（见 [OBS 设置](#obs-设置关键)），或者把
`data\config.json` 的 `streamPaths.lan` 改成 `"lanav"`。
</details>

<details>
<summary><b>手机一直转圈 / 一直缓冲但出不来画面</b></summary>

最常见的原因是 **MediaMTX 的 HLS 防热链 cookie 校验**，在 iOS 上尤其容易踩。

MediaMTX 会给 HLS 下发一个带 `Secure` 的会话 cookie——纯 HTTP 下浏览器存不住；
前置代理只能自己维护一份 cookie 分桶，而走 TCP 隧道时所有观众在服务端看都是 `127.0.0.1`，
只能靠 User-Agent 区分。**iOS 原生 HLS 播放列表请求和分片请求的 UA 未必一致**，
分桶一分错，分片就 401，表现就是画面一直出不来。

正确做法是**启用 MediaMTX 的 CDN 密钥**：`setup.ps1` 会自动生成 32 位随机密钥，
同时写进 `mediamtx.yml` 的 `hlsCDNSecret` 和 `data\config.json` 的 `hlsSecret`。
之后代理对每个 HLS 请求都带 `Authorization: Bearer <secret>`，MediaMTX 直接跳过 cookie 校验。

> 如果你是手动部署的、没跑 `setup.ps1`，一定要自己补上这两处，否则手机上很可能播不出来。
> 验证方法：`Get-Content logs\mediamtx.log | Select-String 'created \(CDN\)'`，出现这行就对了。
</details>

<details>
<summary><b>刷新页面 / 手机切后台回来，提示"这个名字已经在线了"</b></summary>

正常情况下**不会**。同名唯一做了区分：

| 情况 | 行为 |
|---|---|
| **同一个 token** 重连（刷新、切后台回来、断线重连） | 认作同一个人，**自动顶掉旧连接放行新的** |
| **不同 token** 用同一个名字 | 才判定为第二个人，返回 409 |

所以手机切后台回来、页面刷新都能直接进，不会被自己上一次的残留连接挡住。

另外服务端有 **15 秒心跳**（WebSocket ping/pong）：浏览器切后台或网络断开时 TCP 连接
可能不会立刻关闭，心跳超时会把这类僵尸连接清掉，释放名字。

如果你**换了浏览器/清了站点数据**（token 没了）但对方还挂着，会看到 409 并附带一个
**「这是我本人，顶掉旧连接继续」** 按钮，点一下就接管。

如果不是你本人 —— 说明有人冒用了这个名字，请联系主讲人核对。
</details>

<details>
<summary><b>画面一直"缓冲中"，但状态显示已连接</b></summary>

如果你用的是较老的版本，这是 `video.srcObject` 没有清理导致的：

观众页在局域网会**先试 WebRTC**，失败后再降级到 HLS。WebRTC 会给 `<video>` 设置
`srcObject`，而浏览器的 `srcObject` 和 MSE 用的 `src` 是**互斥**的 —— 失败后如果不清掉
`srcObject`，hls.js 就挂不上去。表现就是**清单能解析成功（状态显示"已连接"）、但画面永远不动**。

v1.0.3 起在两处做了清理：WebRTC 失败时、以及挂 HLS 之前。
</details>

<details>
<summary><b>输完名字点「进入直播」，按钮变回原样，人却一直停在入口页</b></summary>

这是 **v1.0.3 的 bug**，请升级到 v1.0.4。

入口页在显示提示文字时用了一个**没定义的转义函数** `esc()`。现代浏览器的模块化脚本遇到
未定义标识符会直接抛 `ReferenceError: esc is not defined`，而报错正好发生在
`location.href = '/watch'` **之前**，所以：
名字是对的、后端也放行了、`localStorage` 里 token 都写好了，**页面就是不走**。

按 F12 打开控制台会看到 `Uncaught ReferenceError: esc is not defined`。
反过来，只要你在入口页看到这条错误，就是这个问题，升级即可。
</details>

<details>
<summary><b>观众页一直转圈</b></summary>

看 `logs\mediamtx.log`，确认 OBS 在推流。可以查：
```powershell
Invoke-RestMethod http://127.0.0.1:9997/v3/paths/list | % items | Select name,online,tracks
```
`live` 必须 `online=True`。
</details>

<details>
<summary><b>外网入口打不开</b></summary>

```powershell
curl http://<你的外网入口>/probe
```
返回 `ok` 才正常。返回 501 是隧道节点在拦明文 HTTP（见 [让外网也能看到](#让外网也能看到)）。
</details>

<details>
<summary><b>流量跑得飞快</b></summary>

1. 确认局域网观众走的是直连（主机消息窗底部有流量进度条）
2. 外网档已经用了 capped-VBR，静止画面会自动降码率；想更省可以把
   `mediamtx.yml` 里 `wan` 的 `-maxrate 1500k` 调小，或把 `-r 25` 调成 `-r 15`
3. 观众多的时候记得：**每个外网观众各占一份流量**，不是共享一份
</details>

<details>
<summary><b>主机消息窗不见了 / 想改大小</b></summary>

```powershell
.\host-window.ps1 -Width 460 -Height 320      # 重新打开并置顶
.\host-window.ps1 -Keep                        # 常驻看守置顶
.\host-window.ps1 -Close                       # 关闭
```
</details>

<details>
<summary><b>改了 .ps1 之后开机自启报错</b></summary>

**脚本必须存成 UTF-8 with BOM。** 无 BOM 的 UTF-8 会被 Windows PowerShell 5.1
按 ANSI(GBK) 解码，中文全变乱码 → 语法错误 → 计划任务失败（`LastTaskResult: 1`）。
VS Code 右下角编码选「UTF-8 with BOM」再保存。
</details>

---

## 排错

```powershell
# 服务在不在
Get-Process mediamtx, node

# 有没有流
Invoke-RestMethod http://127.0.0.1:9997/v3/paths/list | % items | Select name,online,tracks

# 配额用量
Invoke-RestMethod http://127.0.0.1:7000/api/stats

# 自测门禁 + 聊天（12 项）
cd server; node ..\tools\test-chat.js

# 自测管理功能：禁言 / 踢人（22 项）
# ⚠ 会真的用名单里的名字进入并踢人，别在有人看的时候跑
cd server; node ..\tools\test-mod.js

# 页面里按 F12 看控制台
#   WebRTC 自测页: http://127.0.0.1:7000/_selftest-whep.html?path=live

# 日志
Get-Content logs\mediamtx.log -Tail 50
Get-Content logs\server.log  -Tail 50
Get-Content logs\start-all.log -Tail 30
```

---

## 目录结构

```
livestream-hub/
├── setup.ps1                  一键安装
├── start-all.ps1              启动（幂等）
├── stop-all.ps1               停止
├── host-window.ps1            右下角置顶消息窗
├── install-autostart.ps1      开机自启
├── live.ico / stop.ico        图标
├── config/
│   ├── mediamtx.yml.template  MediaMTX 配置模板（含 {{ROOT}} / {{FFMPEG}} 占位符）
│   ├── config.example.json    中枢配置模板
│   └── names.example.txt      白名单模板
├── server/
│   ├── server.js              中央服务：入口分流 / 门禁 / 聊天 / 反代 / 流量统计
│   └── package.json
├── web/
│   ├── index.html             入口页（线路检测 + 姓名门禁）
│   ├── watch.html             观众页（播放器 + 聊天）
│   ├── host.html              主机消息窗（只读 + 点名字禁言/踢人）
│   ├── app.css
│   ├── hls.min.js             hls.js
│   └── _selftest-whep.html    WebRTC 自测页
└── tools/
    ├── make-icon.ps1          重新生成图标
    ├── test-chat.js           门禁 + 聊天自测
    └── test-mod.js            禁言 / 踢人自测
```

安装后还会多出（已在 `.gitignore` 里）：

```
bin/mediamtx/     setup.ps1 下载的媒体服务器
data/config.json  实际配置（含随机 hostKey）
data/names.txt    你的白名单
logs/             日志
```

---

## 第三方组件

| 组件 | 许可 | 说明 |
|---|---|---|
| [MediaMTX](https://github.com/bluenviron/mediamtx) | MIT | 媒体服务器，由 `setup.ps1` 下载，**不随仓库分发** |
| [hls.js](https://github.com/video-dev/hls.js) | Apache-2.0 | 浏览器 HLS 播放，随仓库分发 |
| [ws](https://github.com/websockets/ws) | MIT | Node WebSocket，`npm install` 获取 |

> 本仓库不含任何私有穿透服务的二进制或密钥。

---

## 许可

[MIT](LICENSE)
