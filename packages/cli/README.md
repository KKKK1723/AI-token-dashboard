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
  --timezone Asia/Shanghai `
  --at 03:10
```

初始化会立即执行一次同步，并安装两个当前用户任务：

- 每 60 秒执行 `collect`，只读取本机日志并更新本地账本，不访问网络。
- 每天 03:10 执行 `sync`，向 Worker 上传最近 45 天的绝对桶。

种子只能在一个原设备上导入一次。把同一份种子导入多个 `device_id` 会让历史数据被多设备相加。

## 增加其他设备

在已经完成初始化、持有主 `SYNC_KEY` 的原设备运行：

```powershell
ai-token-dashboard pair
```

命令会输出一条只在 10 分钟内有效、只能使用一次的新设备安装命令。在新设备直接运行它：

```powershell
npx --yes @kkkk1723/ai-token-dashboard@latest setup <pairing-string>
```

`setup` 会自动完成正式 npm 包的全局安装、领取独立设备凭据、生成随机 `device_id`、安装本地采集与每日同步任务，并执行首次同步。新设备不需要登录 Cloudflare、配置 GitHub Secrets，也不会拿到长期主 `SYNC_KEY`。

可选参数：

```powershell
npx --yes @kkkk1723/ai-token-dashboard@latest setup <pairing-string> `
  --device-name laptop `
  --at 03:10
```

不要复制另一台机器的 CLI 配置目录或配对后的设备凭据。每台设备必须使用自己领取的凭据和随机 `device_id`。

## 命令

```text
ai-token-dashboard pair
ai-token-dashboard setup <pairing-string>
ai-token-dashboard collect
ai-token-dashboard sync
ai-token-dashboard status
ai-token-dashboard uninstall
```

`uninstall` 只移除定时任务，保留配置与本地账本。持有主 `SYNC_KEY` 的原设备确实需要更换设备 ID 时可执行：

```powershell
ai-token-dashboard init --new-device --api-url <url> --key <SYNC_KEY>
```

配对设备不能复用已经绑定的设备 token 来更换 `device_id`。如果配对设备丢失本地状态，应先备份并清理该设备的本地配置，再由原设备重新运行 `pair`，使用新的配对命令初始化。

## 累计正确性

上传单位是“日期 + 来源 + 模型”的绝对值，不是自上次以来的增量：

- 本地在上传前持久化完整 payload 和 `sequence`。
- 断网或响应丢失时，下次原样重放同一 payload。
- D1 仅接受同设备更大的序号；同序号重试不重复累加。
- 同设备的新序号覆盖旧绝对值，不做加法。
- 查询时才把不同 `device_id` 的绝对桶相加。
- 服务端强制所有设备使用相同账户时区。

服务器确认后，本地只保留最近 45 天的请求账本。面板始终查询最近 30 天。

## CCSwitch 兼容

采集器复刻 CCSwitch 3.18.0 的 Claude、Codex、模型归一化、缓存语义和价格规则。本地 60 秒采集周期也与 CCSwitch 一致，避免 Claude 长请求的流式中间快照产生不同统计。首次种子可保证切换时已有面板数值不跳变。

当前原生采集范围是 Claude Code 和 Codex。未知新模型仍统计 Token 与请求，但成本暂记为 0，并写入 `sync.log`；更新 CLI 价格表后再处理。

## 本地文件与密钥

Windows 默认目录：

```text
%LOCALAPPDATA%\ai-token-dashboard
```

macOS 使用 `~/Library/Application Support/ai-token-dashboard`，Linux 使用 `$XDG_STATE_HOME/ai-token-dashboard`。测试时可用 `AI_TOKEN_DASHBOARD_HOME` 改写。

Windows 使用当前用户 DPAPI 加密 `SYNC_KEY`；macOS/Linux 将其保存在权限为 `0600` 的配置文件中。生产 API 必须使用 HTTPS，只有 localhost 测试地址允许 HTTP。
