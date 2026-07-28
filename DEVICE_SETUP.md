# AI Token Dashboard 添加新设备

这份说明只用于以后给自己的其他电脑接入同一个统计面板。Cloudflare Worker、D1 和 npm 包已经部署完成，添加设备时不需要再次配置 Cloudflare、GitHub Secrets 或 `SYNC_KEY`。

## 准备工作

- 主设备：当前已经正常同步、持有主密钥的电脑。
- 新设备：安装 Node.js 20 或更高版本，并能正常访问 npm 和 Worker。
- 不要复制其他电脑的 `%LOCALAPPDATA%\ai-token-dashboard` 目录。每台设备必须拥有独立的 `device_id` 和设备凭据。

## 添加步骤

### 1. 在主设备生成配对命令

打开 PowerShell，执行：

```powershell
ai-token-dashboard pair
```

该命令不会弹出网页或窗口，而是直接在终端打印一条类似下面的命令：

```powershell
npx --yes @kkkk1723/ai-token-dashboard@latest setup <pairing-string>
```

整行复制到新设备。配对信息有效 10 分钟且只能使用一次；过期或使用失败时，回到主设备重新运行 `ai-token-dashboard pair`。

### 2. 在新设备完成安装

在新设备打开 PowerShell，执行主设备刚才输出的完整 `npx` 命令。

它会自动完成：

- 安装最新版 `@kkkk1723/ai-token-dashboard` CLI。
- 创建该设备专属的随机 `device_id` 和设备凭据。
- 安装每 60 秒运行一次的本地采集任务。
- 安装每天 03:10 运行一次的同步任务。
- 执行第一次采集和同步。

新设备不需要登录 Cloudflare，也不需要输入主 `SYNC_KEY`。

### 3. 验证新设备

```powershell
ai-token-dashboard --version
ai-token-dashboard status
```

`status` 中应能看到 `deviceId`、`apiUrl`、`lastSyncAt` 和 `syncSequence`，并且 `pendingSequence` 应为 `null`。

需要立即重新采集或同步时，可以执行：

```powershell
ai-token-dashboard collect
ai-token-dashboard sync
```

Windows 上可用下面的命令检查计划任务：

```powershell
Get-ScheduledTask -TaskName "AI-token Dashboard Collect","AI-token Dashboard Sync"
```

## 常见问题

### 没有弹出登录页或扫码页

这是正常现象。`pair` 在主设备输出命令，`setup` 在新设备直接完成安装，全程不需要浏览器授权。

### 提示配对码无效、已过期或已使用

在主设备重新执行 `ai-token-dashboard pair`，然后在 10 分钟内到新设备执行新生成的命令。不要重复使用旧命令。

### 提示设备已经初始化

不要直接覆盖配置，也不要复制其他设备的配置目录。先确认当前设备是否已经在正常同步；确实需要重新配对时，再从主设备生成新的配对命令。

### 电脑在 03:10 没有开机

任务启用了错过后补运行。下次登录且任务调度器可用时会继续同步，也可以手动执行 `ai-token-dashboard sync`。

## 数据累计规则

每台设备上传自己的绝对统计值，服务端按 `device_id` 分开保存，并在查询面板时跨设备求和。同一设备重试会覆盖该设备的旧绝对值，不会重复累加；不同设备必须使用各自独立的配对凭据。
