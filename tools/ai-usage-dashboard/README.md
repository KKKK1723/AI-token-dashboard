# AI-token监控面板

这是主页右侧 GitHub Native 看板的本地数据管道。它从 CCSwitch 的 SQLite
数据库读取最近 30 个自然日的统计，生成不依赖外部服务的 `500 x 300` 明暗两套 SVG。

## 数据口径

- 时间范围是今天加前 29 个自然日，例如今天是 7 月 25 日就统计 6 月 26 日至 7 月 25 日。
- 数据来自 `proxy_request_logs` 的模型、四类 Token、成本和时间戳字段。
- 总 Token = Input + Output + Cache Read + Cache Creation。
- Top 3 模型按总 Token 排序。
- 成本使用 CCSwitch 已计算的 `total_cost_usd`，保留自定义价格和倍率。
- 不读取请求正文、Session ID、Provider ID 或任何 API Key。

## 本地生成

要求 Python 3.10 或更高版本。项目只使用 Python 标准库，不需要安装依赖。

```powershell
python tools\ai-usage-dashboard\generate.py
```

生成文件：

```text
assets/ai-usage/ai-usage-light.svg
assets/ai-usage/ai-usage-dark.svg
```

可以用固定时间做检查：

```powershell
python tools\ai-usage-dashboard\generate.py `
  --now 2026-07-25T15:10:00+08:00
```

## 每日更新

本地 CCSwitch 数据库不在 GitHub Actions 的运行环境中，因此每日读取必须在本机执行。

只生成本地 SVG：

```powershell
powershell -ExecutionPolicy Bypass -File `
  tools\ai-usage-dashboard\scripts\install-scheduled-task.ps1
```

生成后提交并推送到主页仓库：

```powershell
powershell -ExecutionPolicy Bypass -File `
  tools\ai-usage-dashboard\scripts\install-scheduled-task.ps1 -Publish
```

任务默认每天 03:10 执行，错过后会在下次登录时补跑。发布模式要求仓库工作区干净，
并使用当前 Git 的 SSH Key 或 Credential Manager，不会把凭据写入脚本。

移除任务：

```powershell
powershell -ExecutionPolicy Bypass -File `
  tools\ai-usage-dashboard\scripts\remove-scheduled-task.ps1
```

## 验证

```powershell
python -m unittest discover -s tools\ai-usage-dashboard\tests -v
```

生成器在写入 SVG 前会解析 XML，并使用临时文件原子替换；数据库暂时不可读或统计为空时，
会保留上一版看板，不发布空数据。
