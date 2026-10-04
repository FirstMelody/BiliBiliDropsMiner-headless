# BiliBili Drops Miner · Linux Headless

基于 [mi0e/BiliBiliDropsMiner](https://github.com/mi0e/BiliBiliDropsMiner)
`0200d60` 的 Linux 无桌面守护器，默认监控守望先锋电竞直播间 `23612045`。
保留上游 MIT 许可与 Git 历史；原项目说明见 [README.upstream.md](README.upstream.md)。

本版本通过配置文件导入 Cookie 和刷新口令，自动发现活动、启动上游
`BilibiliWatchTimeMiner` 的 **4 个挂机会话**、查询进度、领取和回查奖励。
Chromium 始终 headless，只负责网页、活动发现和 Cookie 操作，不承担挂机计时。
不需要桌面、Xvfb、Windows、远端云电脑或开放 CDP 端口。

## Linux 安装

需要 Node.js 22+、Python 3.11+。以下命令在克隆后的仓库根目录执行：

```bash
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-headless.txt

# 浏览器下载到项目内；安装系统依赖可能需要 sudo。
export PLAYWRIGHT_BROWSERS_PATH="$PWD/downloads/browsers"
npx playwright-core install --with-deps chromium --no-shell

cp headless/config.example.json headless/config.json
chmod 600 headless/config.json
# 编辑 headless/config.json，填入 cookie 和 refreshToken。
npm start -- --check
npm start
```

Chromium 的安装和版本匹配采用 [Playwright 官方流程](https://playwright.dev/docs/browsers)。
如已安装 Chrome/Chromium，可在 `browserExecutable` 中填写其绝对路径。
使用 npm 下载的浏览器时，每次运行应保留相同的 `PLAYWRIGHT_BROWSERS_PATH`。

## 配置和 Cookie 刷新

示例配置见 [headless/config.example.json](headless/config.example.json)。
`cookie` 是 Cookie 请求头原文，至少包含 `SESSDATA` 和 `bili_jct`，建议同时提供
`DedeUserID`、`buvid3`。保留 Cookie 中的百分号编码，不进行二次解码。

**自动刷新还需要同次登录的 `ac_time_value`，仅 Cookie 无法生成刷新口令。**
在已登录 B 站的浏览器中，打开 `https://www.bilibili.com` 的开发者工具 →
Application / 应用 → Local Storage，复制 `ac_time_value` 到配置的 `refreshToken`。
不要把这些值放进命令行、Issue 或仓库文件。

| 配置项 | 含义 |
| --- | --- |
| `roomId` | 目标直播间，默认示例为守望先锋电竞 |
| `cookie` / `refreshToken` | 首次启动或明确重新导入时使用的凭据 |
| `dataDir` | 私有运行目录，相对配置文件解析，默认 `../data` |
| `pythonExecutable` | miner 所用 Python，默认 `../.venv/bin/python`；也可填 `python3` |
| `browserExecutable` | 可选的 Chromium/Chrome 二进制路径 |
| `pollIntervalMs` | 进度、登录、直播及领取检查间隔，默认一分钟 |
| `discoveryIntervalMs` | 新活动发现间隔，默认十分钟 |
| `refreshIntervalMs` | 续期检查间隔，默认一天，平台要求刷新才轮换 |
| `stallIntervalMs` | 观看进度停滞后的 miner 恢复间隔，默认十五分钟 |
| `notifications` | 可选的 Snowluma / OneBot 11 私聊通知配置 |

刷新采用 cookie/info → RSA-OAEP correspond → cookie/refresh → confirm/refresh。
新 Cookie、新口令和待确认旧口令先原子写入 `data/session.json` 并同步到磁盘，
然后确认作废旧口令。确认失败时保留待确认记录，重启后优先恢复确认流程。
**刷新不会改写输入配置**；后续启动优先读取运行目录中的最新会话，避免恢复旧 Cookie。

登录被强制注销时暂停挂机。重新获取同次登录的 Cookie 和刷新口令、编辑配置，
停止当前进程后重新导入：

```bash
npm start -- --import-session
# 自定义配置文件路径：
npm start -- --config /path/to/private-config.json
# 单轮检查后退出：
npm start -- --once
```

同一运行目录通过 Linux `flock` 锁防止重复启动；Python miner 还有独立进程锁。
守护器租约超过三分钟未更新时，miner 自动停止。SIGTERM/SIGINT 会停止挂机并关闭浏览器。

## 领取与监控

- 每分钟检查是否直播及是否有未完成任务；直播中启动四会话 miner，停播或完成时停止。
- 从官方活动页自动识别任务和分级奖励 ID，浏览器播放器暂停。
- 领取接口使用官方 `web_location` 和完整领奖页 Referer，至少间隔 2.5 秒；限流时退避。
- `mission/info` 状态 0 才提交，状态 6 才记为已领取。HTTP 成功或接口 code=0 均不能替代回查。
- 请求超时也先回查，避免服务器已处理后重复提交；失败每五分钟重试。
- 平台要求验证码时尝试官方页面流程，仍需交互则记为 `needs_attention`，每三十分钟最多重试一次。
  headless 无法代替人完成验证码；此时在可交互浏览器用同一账号完成官方领奖，再等待回查。
- 平台领取成功不等于游戏内物品已经到账，最终入库以游戏或战网账号为准。

`data/status.json` 为不含 Cookie 的运行状态，`data/miner-status.json` 记录实际活跃会话数量，
`data/events-*.jsonl` 和 `data/miner.log` 记录脱敏事件。运行目录权限 0700，凭据文件权限 0600。

## Snowluma / OneBot 通知

`notifications.enabled` 默认关闭。启用时填写 `websocketUrl`、`accessToken` 和收件人 QQ
`userId`，通过 OneBot 11 `send_private_msg` 发送私聊；没有硬编码的账号或机器人配置路径。

登录失效、缺失刷新口令、需要人工领奖、持续接口错误、四会话未恢复、领取五分钟未确认、
进度十五分钟停滞时通知。所有奖励经平台确认后发送一次完成通知；同一异常只通知一次，
恢复也通知，记录落盘后重启继续去重。发送失败在后续检查中重试，正常运行不刷屏。
本版本通知在同一进程中运行；整台 Linux 主机或该进程完全停止时，需要外部监控才能报警。

## Docker 模板

提供独立 [Dockerfile.headless](Dockerfile.headless) 和 [compose.headless.yaml](compose.headless.yaml)。
如后续需要部署，可执行：

```bash
cp headless/config.example.json headless/config.json
# 编辑凭据；确保运行用户 UID 1000 能读取配置、写入 data。
mkdir -p data
sudo chown 1000:1000 headless/config.json data
chmod 600 headless/config.json
chmod 700 data
docker compose -f compose.headless.yaml up -d --build
```

容器配置仍使用 `dataDir: "../data"`、`pythonExecutable: "../.venv/bin/python"`。
通知地址须从容器可访问，`127.0.0.1` 指向容器自身。配置只读挂载，刷新后的凭据写到持久 `data`。
镜像构建上下文排除实际配置与运行数据；不开放浏览器、CDP 或 Web 服务端口。
模板未在本任务中部署服务。

## systemd 模板

[headless/bilibili-drops-headless.service](headless/bilibili-drops-headless.service)
默认使用独立 `bilibili` 用户和 `/opt/bilibili-drops-headless` 路径。
部署时先自行创建用户、选择实际路径、安装依赖并设置配置与 data 的所有者，然后修改模板的
`WorkingDirectory`、`ExecStart`、`RequiresMountsFor` 和浏览器缓存路径。
先用服务账号通过 `--check`，再安装和启用 unit；本任务仅提供模板。

## 测试与脱敏

```bash
npm test
env -u DISPLAY PLAYWRIGHT_BROWSERS_PATH="$PWD/downloads/browsers" npm run test:integration
.venv/bin/python -m unittest tests.test_miner_login_guard tests.test_x25kn_worker tests.test_rewards
.venv/bin/python headless/integration/test_runtime.py
```

已验证 41 项 Node 测试、3 项真实 Chromium headless 端到端模拟、2 项 Linux 进程锁/退出测试及 18 项上游 Python 回归。
端到端测试使用合成凭据和拦截后的平台响应，不访问真实账号，覆盖刷新前落盘、Cookie 轮换、
官方领取请求及状态回查。Linux 当前版本未使用真实账号进行新一次领奖验收。
GitHub Actions 使用同样的 Linux 检查。

实际配置、运行会话、Cookie、刷新口令、通知令牌、SSH 密钥、私人部署地址和个人账号均不在本仓库中。
`headless/config.json`、`*.local.json`、`data/`、`.env*` 和依赖/下载目录已被 Git 忽略。
不要使用 `git add -f` 提交运行配置或浏览器数据。
