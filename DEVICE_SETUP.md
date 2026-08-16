# AI Token Dashboard 添加新设备

Cloudflare Worker、D1、GitHub OAuth App 和 npm 包部署完成后，新电脑只需要一条命令和一次 GitHub 登录，不需要复制配置、输入 `SYNC_KEY` 或修改 GitHub Secrets。

## 准备工作

- 安装 Node.js 20 或更高版本。
- 能访问 npm、GitHub 和 `https://ai-token-dashboard.tt122afadfa.workers.dev`。
- 使用允许的 GitHub 账号登录。当前 Worker 固定校验 GitHub 数字用户 ID `181867828`。
- 不要复制其他电脑的 `%LOCALAPPDATA%\ai-token-dashboard`。每台设备必须拥有独立的 `device_id` 和凭据。

## 添加步骤

### 1. 运行安装命令

在新设备打开 PowerShell：

```powershell
npx --yes @kkkk1723/ai-token-dashboard@latest setup
```

引导程序会从官方 npm registry 安装同版本 CLI，在 `127.0.0.1` 随机端口启动临时回调，并打印 GitHub 授权地址。正常情况下浏览器会自动打开。

### 2. 登录 GitHub

在浏览器选择允许的 GitHub 账号并授权。该 OAuth App 不申请仓库或账户 scope。Worker 会验证不可变的 GitHub 数字用户 ID，并撤销这次登录产生的临时 token；撤销成功后才签发设备专属 token。

浏览器显示 `Authorization complete` 后即可关闭页面。CLI 会继续：

- 生成随机 `device_id` 和当前主机名对应的设备名称。
- 使用 DPAPI（Windows）或权限为 `0600` 的配置文件（macOS/Linux）保存设备凭据。
- 安装每 60 秒运行一次的本地采集任务。
- 安装每 10 分钟运行一次的同步任务；数据没变化时不访问网络。
- 执行首次采集、最近 7 天全量对账和首次同步。

可指定设备名称和账户时区：

```powershell
npx --yes @kkkk1723/ai-token-dashboard@latest setup `
  --device-name laptop `
  --timezone Asia/Shanghai
```

### 3. 验证

```powershell
ai-token-dashboard --version
ai-token-dashboard status
ai-token-dashboard doctor
```

`status` 应显示 `credentialType: "github"`、本机 `deviceId`、`lastSyncAt` 和大于 0 的 `syncSequence`，并且 `pendingSequence` 为 `null`。`doctor` 应返回 `status: "ok"`；若日志本身存在异常，它会返回 `degraded` 并列出原因。

Windows 上可检查计划任务：

```powershell
Get-ScheduledTask -TaskName "AI-token Dashboard Collect","AI-token Dashboard Sync"
```

需要立即采集、同步或修复最近 7 天账本时：

```powershell
ai-token-dashboard collect
ai-token-dashboard sync
ai-token-dashboard doctor --repair
```

## 配对字符串回退

无法使用浏览器 OAuth 时，在持有主 `SYNC_KEY` 的原设备运行：

```powershell
ai-token-dashboard pair
```

再到新设备执行它输出的完整命令：

```powershell
npx --yes @kkkk1723/ai-token-dashboard@latest setup <pairing-string>
```

配对字符串有效 10 分钟且只能使用一次。该路径安装的设备会显示 `credentialType: "device"`，其采集和同步行为与 GitHub 登录设备相同。

## 常见问题

### 浏览器没有自动打开

复制终端打印的 `https://github.com/login/oauth/authorize...` 地址到本机浏览器。CLI 必须继续运行，授权结果才能回到它监听的 `127.0.0.1` 随机端口。

### GitHub 提示 callback 不匹配

OAuth App 的 Authorization callback URL 必须是：

```text
http://127.0.0.1/oauth/callback
```

不要登记 `localhost`，也不要固定 CLI 运行时随机选择的端口。

### 提示账号无权注册

退出 GitHub 的其他账号后重试，并确认使用数字用户 ID 为 `181867828` 的账号。Worker 按数字 ID 校验，不依赖可修改的用户名。

### 提示设备已经初始化

`setup` 不会覆盖现有配置。先运行 `ai-token-dashboard status` 判断这台电脑是否已正常接入；不要复制或手工修改另一台设备的 ID、token 或状态文件。

### 临时断网或电脑关机

采集只读本机文件，不依赖网络。同步失败时会保留完整快照，下次精确重试；恢复后最多约 10 分钟上传。Windows 任务启用了错过后补运行，也可手动执行 `ai-token-dashboard sync`。

### `doctor` 返回 degraded

查看输出中的 `diagnostics.issues` 和来源目录。日志目录缺失、文件不可读、JSON 损坏或未知 schema 都会降级；在来源不可信时，即使加 `--repair` 也不会把历史数据误删为零。

## 数据累计规则

每台设备只解析自己的 Claude Code 与 Codex 原生日志，并上传“日期 + 来源 + 模型”的绝对值。服务端按 `device_id` 分开保存，在公开面板查询时跨设备求和。

每个上传快照都有随机 `snapshotId`、递增 `sequence` 和明确日期窗口。D1 原子替换该设备窗口；精确重试不会重复累计，旧序列不会覆盖新数据，空快照也能清掉该窗口的旧桶。

统计无法覆盖未安装采集器的设备或已经永久删除且超出本地保留窗口的日志。Codex 的 ChatGPT 登录目前不提供账户级 token 总量 API，CLI 保存的额度快照只用于辅助诊断，明细正确性以原生日志重扫和本地对账为准。
