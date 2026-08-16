# AI Token Dashboard CLI

本地采集 Claude Code 与 Codex 原生日志，并把多设备绝对统计同步到个人 Worker。CCSwitch 仅在首次迁移已有历史时使用，日常运行不依赖 CCSwitch。

## 安装

要求 Node.js 20 或更高版本。

仓库内安装：

```powershell
npm install --global .\packages\cli
```

npm 包发布后：

```powershell
npm install --global @kkkk1723/ai-token-dashboard
```

## 原设备首次迁移

1. 启动 CCSwitch 3.18.0，等待至少两分钟，让后台会话同步完成。
2. 退出 CCSwitch，避免导出过程中继续向 SQLite 补写历史时间戳。
3. 在看板仓库导出一次 45 天种子。

```powershell
python tools\ai-usage-dashboard\export_sync_seed.py `
  --output .local\ccswitch-seed.json `
  --days 45 `
  --timezone Asia/Shanghai
```

4. 使用部署 Worker 时设置的 `SYNC_KEY` 初始化。

```powershell
ai-token-dashboard init `
  --api-url https://ai-token-dashboard.<account>.workers.dev `
  --key <SYNC_KEY> `
  --seed .local\ccswitch-seed.json `
  --timezone Asia/Shanghai
```

初始化会立即执行一次同步，并安装两个当前用户任务：

- 每 60 秒执行 `collect`，只读取本机日志并更新本地账本，不访问网络。
- 每 10 分钟执行 `sync`；只有本地数据变化或存在待重试快照时才访问 Worker。

`sync` 每天还会全量重扫最近 7 天，与增量账本对账并在数据源可信时自动修复。每次上传覆盖最近 45 天的明确日期窗口。

种子只能在一个原设备上导入一次。把同一份种子导入多个 `device_id` 会让历史数据被多设备相加。

## 增加其他设备

在新设备打开 PowerShell，运行：

```powershell
npx --yes @kkkk1723/ai-token-dashboard@latest setup
```

`setup` 会完成以下工作：

- 从官方 npm registry 安装与引导程序相同版本的 CLI。
- 在 `127.0.0.1` 随机端口启动临时回调，并打开 GitHub 授权页；浏览器没有自动打开时可使用终端打印的地址。
- 使用 Authorization Code + PKCE 验证 GitHub 账号，不申请任何 OAuth scope。
- 生成随机 `device_id`，领取只属于该设备的凭据。
- 安装每 60 秒采集和每 10 分钟按需同步任务。
- 执行首次采集、最近 7 天对账和首次同步。

Worker 只允许部署时配置的 GitHub 数字用户 ID。它会在撤销 GitHub 临时 token 成功后才签发设备凭据；GitHub token 不会保存到 CLI 或 D1。新设备不需要 Cloudflare 登录、GitHub Secrets 或主 `SYNC_KEY`。

可选参数：

```powershell
npx --yes @kkkk1723/ai-token-dashboard@latest setup `
  --device-name laptop `
  --timezone Asia/Shanghai
```

### 配对字符串回退

浏览器 OAuth 不可用时，可在持有主 `SYNC_KEY` 的原设备运行：

```powershell
ai-token-dashboard pair
```

然后在 10 分钟内到新设备执行输出的完整命令：

```powershell
npx --yes @kkkk1723/ai-token-dashboard@latest setup <pairing-string>
```

配对字符串只能使用一次。不要复制另一台机器的 CLI 配置目录或设备凭据；每台设备必须使用自己的凭据和随机 `device_id`。

## 命令

```text
ai-token-dashboard pair
ai-token-dashboard setup [pairing-string]
ai-token-dashboard collect
ai-token-dashboard sync
ai-token-dashboard status
ai-token-dashboard doctor [--repair] [--days <1-30>]
ai-token-dashboard uninstall
```

`uninstall` 只移除定时任务，保留配置与本地账本。持有主 `SYNC_KEY` 的原设备确实需要更换设备 ID 时可执行：

```powershell
ai-token-dashboard init --new-device --api-url <url> --key <SYNC_KEY>
```

配对设备不能复用已经绑定的设备 token 来更换 `device_id`。如果配对设备丢失本地状态，应先备份并清理该设备的本地配置，再由原设备重新运行 `pair`，使用新的配对命令初始化。

## 诊断与修复

```powershell
ai-token-dashboard doctor
ai-token-dashboard doctor --repair
ai-token-dashboard doctor --repair --days 14
```

`doctor` 全量扫描指定天数的原生日志并与本地账本比较，输出来源目录、schema 异常、损坏 JSON、计数器异常、额度快照和对账结果。只有所有相关日志源都可读且扫描可信时，`--repair` 才会替换该窗口的账本；缺失日志目录不会被解释成零用量。

## 累计正确性

上传单位是“日期 + 来源 + 模型”的绝对值，不是自上次以来的增量：

- 本地在上传前持久化完整 payload 和 `sequence`。
- 断网或响应丢失时，下次原样重放同一 payload。
- payload 带随机 `snapshotId`、严格递增 `sequence` 和明确的起止日期。
- D1 在一个原子 batch 中接受新序号、清理该设备窗口并写入全部桶。
- 同一快照精确重试返回幂等成功；内容冲突或旧序列不会覆盖新数据。
- 空快照会清理该设备在声明窗口内的旧桶，不留下幽灵数据。
- 查询时才把不同 `device_id` 的绝对桶相加。
- 服务端强制所有设备使用相同账户时区。

服务器确认后，本地只保留最近 45 天的请求账本。面板始终查询最近 30 天。

Claude 以同一消息的最终 usage 快照替换流式中间快照。Codex 的累计计数按增量计算，计数下降按进程重置处理；`cache_write_input_tokens` 从普通输入拆分到 Cache Creation，`rate_limits` 只保存最新额度快照而不计入 token。格式异常会写入诊断，不会静默伪造成零用量。

## CCSwitch 兼容

采集器复刻 CCSwitch 3.18.0 的模型归一化、缓存语义和价格规则，并直接解析 Claude Code 与 Codex 的原生事件。首次种子可保证切换时已有面板数值不跳变。

当前原生采集范围是安装本 CLI 的设备上的 Claude Code 和 Codex。未知新模型仍统计 Token 与请求，但成本暂记为 0，并写入 `sync.log`；更新 CLI 价格表后再处理。没有安装采集器的设备或已永久删除且超出保留窗口的日志无法补算。Codex 的 ChatGPT 登录目前也不允许读取账户级 token 用量 API，所以配额数据只用于辅助诊断。

## 本地文件与密钥

Windows 默认目录：

```text
%LOCALAPPDATA%\ai-token-dashboard
```

macOS 使用 `~/Library/Application Support/ai-token-dashboard`，Linux 使用 `$XDG_STATE_HOME/ai-token-dashboard`。测试时可用 `AI_TOKEN_DASHBOARD_HOME` 改写。

Windows 使用当前用户 DPAPI 加密主密钥或设备 token；macOS/Linux 将凭据保存在权限为 `0600` 的配置文件中。生产 API 必须使用 HTTPS，只有 localhost 测试地址允许 HTTP。OAuth 回调只监听 `127.0.0.1`，使用随机 `state`、PKCE S256 和 5 分钟超时。
