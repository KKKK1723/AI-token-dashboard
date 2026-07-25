# AI-token监控面板

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/ai-usage/ai-usage-dark.svg">
  <img src="./assets/ai-usage/ai-usage-light.svg" width="500" height="300" alt="AI token usage over the last 30 days">
</picture>

基于 CCSwitch 本地使用统计生成的 GitHub Native SVG 看板，每天更新一次最近 30 个自然日的数据。

## 监控指标

- 总 Token：Input、Output、Cache Read 与 Cache Creation Token 之和
- 总成本：使用 CCSwitch 记录的 `total_cost_usd`
- 请求数：统计窗口内的请求总量
- Top 3 模型：按 Token 使用量排序并展示占比

## 数据来源

默认读取：

```text
C:\Users\20524\.cc-switch\cc-switch.db
```

生成器只读取模型、Token、成本和时间戳字段，不读取请求正文、API Key、Session ID 或 Provider ID。

## 生成看板

要求 Python 3.10 或更高版本，无第三方依赖。

```powershell
python .\tools\ai-usage-dashboard\generate.py
```

生成结果：

```text
assets/ai-usage/ai-usage-light.svg
assets/ai-usage/ai-usage-dark.svg
```

## 每日更新

注册每天 `03:10 CST` 执行的本地任务：

```powershell
powershell -ExecutionPolicy Bypass -File `
  .\tools\ai-usage-dashboard\scripts\install-scheduled-task.ps1
```

需要同时提交并推送 SVG 时使用：

```powershell
powershell -ExecutionPolicy Bypass -File `
  .\tools\ai-usage-dashboard\scripts\install-scheduled-task.ps1 `
  -Publish
```

详细配置与故障处理见 [`tools/ai-usage-dashboard/README.md`](./tools/ai-usage-dashboard/README.md)。