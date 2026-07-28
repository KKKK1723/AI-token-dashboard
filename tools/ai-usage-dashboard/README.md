# SVG 生成与数据口径

这里保留原有 `500 x 300` 明暗两套 SVG 渲染器。布局、状态栏、最近 30 天窗口和 Top 3 排序均未改动；新后端只把输入从本机 CCSwitch SQLite 换成 Worker 返回的规范化 JSON。

## 远端快照

GitHub Actions 调用 `GET /v1/summary?days=30` 后执行：

```powershell
python tools\ai-usage-dashboard\generate.py `
  --snapshot-json .local\usage-summary.json `
  --output-dir assets\ai-usage
```

远端快照会校验日期窗口、总请求、四类 Token、成本及逐模型合计。数据为空或不一致时不会覆盖上一版 SVG。

## 一次性 CCSwitch 种子

迁移脚本只读取 `proxy_request_logs` 的应用类型、Token 语义、模型、四类 Token、成本和时间戳，不读取请求正文、API Key、Session ID 或 Provider ID。

```powershell
python tools\ai-usage-dashboard\export_sync_seed.py `
  --output .local\ccswitch-seed.json `
  --days 45 `
  --timezone Asia/Shanghai
```

自动截止点默认回退 120 秒，让 CCSwitch 的 60 秒后台导入完成。迁移时应先让 CCSwitch 至少同步一轮，再退出 CCSwitch 后执行导出。`cutoffAt` 之前使用种子绝对值，之后由原生日志采集，避免历史重复。

`--now` 用于固定截止点对账；显式指定时不会应用稳定延迟：

```powershell
python tools\ai-usage-dashboard\export_sync_seed.py `
  --output .local\seed-fixed.json `
  --now 2026-07-28T06:47:00Z
```

## CCSwitch 对账口径

- 时间范围：今天和前 29 个自然日，以 `Asia/Shanghai` 分桶。
- 总 Token：Fresh Input + Output + Cache Read + Cache Creation。
- Claude：按 `message.id` 去重，优先有 `stop_reason` 的快照，否则取较大的 Output。
- Codex：按线程 UUID 和 token-count 事件计算累计差值，Fresh Input 排除 Cached Input。
- 成本：使用 CCSwitch 3.18.0 的模型别名、价格表及四类 Token 费率；迁移种子保留 CCSwitch 已计算成本。
- Top 3：跨来源按模型名合并，再按总 Token、请求数和模型名稳定排序。

保留的本地 SQLite 模式可用于迁移前复核：

```powershell
python tools\ai-usage-dashboard\generate.py `
  --database $env:USERPROFILE\.cc-switch\cc-switch.db `
  --output-dir .local\ccswitch-check
```

## 验证

```powershell
python -m unittest discover -s tools/ai-usage-dashboard/tests -v
```

生成器只使用 Python 标准库，要求 Python 3.10 或更高版本。
