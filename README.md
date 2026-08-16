# AI-token监控面板

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/ai-usage/ai-usage-dark.svg">
  <img src="./assets/ai-usage/ai-usage-light.svg" width="500" height="300" alt="AI token usage over the last 30 days">
</picture>

个人多设备 AI CLI 用量看板。运行时直接读取 Claude Code 和 Codex 的原生日志，不再依赖 CCSwitch；各设备定期将自己的绝对统计同步到 Cloudflare Worker + D1，再由 GitHub Actions 更新现有 SVG。公开看板的布局和指标保持不变。

前端和统计窗口保持不变：

- Total tokens：Fresh Input + Output + Cache Read + Cache Creation
- Total cost：按 CCSwitch 3.18.0 的模型价格与缓存计价语义计算
- Requests：最近 30 个自然日的请求总数
- Top 3 models：按总 Token 排序并展示占比

## 后端结构

```text
Claude/Codex 原生日志
        |
        | 每 60 秒，仅本地采集
        v
npm CLI 本地账本
        |
        | 每 10 分钟检查，有变化才同步绝对桶
        v
Cloudflare Worker + D1
        |
        | 每天 03:30，读取最近 30 天
        v
GitHub Actions -> 原 Python 渲染器 -> 现有 SVG
```

新设备运行一条命令并登录指定的 GitHub 账号即可注册：

```powershell
npx --yes @kkkk1723/ai-token-dashboard@latest setup
```

CLI 使用 GitHub OAuth Authorization Code + PKCE，通过 `127.0.0.1` 随机端口接收回调。Worker 只接受配置的 GitHub 数字用户 ID；临时 GitHub token 撤销成功后才签发独立设备凭据。OAuth 不申请仓库或账户 scope，也不会把 GitHub token 保存到本地或 D1。原来的 10 分钟一次性配对字符串仍作为无浏览器环境的回退方案。

服务端以 `device_id + 日期 + 来源 + 模型` 为唯一桶，并按设备同步序号原子覆盖一个明确日期窗口的绝对值；跨设备查询时再求和。因此网络重试不会翻倍、乱序请求不会回滚新数据、不同设备会正确累加。

## 开始使用

1. 按 [Worker 部署文档](./packages/worker/README.md)创建 D1、GitHub OAuth App 并部署 Worker。
2. 在原设备按 [CLI 迁移文档](./packages/cli/README.md)导出一次 CCSwitch 种子并初始化。
3. 其他设备只需运行 `npx --yes @kkkk1723/ai-token-dashboard@latest setup` 并登录 GitHub。
4. 在仓库 Secrets 中配置 `DASHBOARD_API_URL` 和 `DASHBOARD_READ_KEY`，手动运行一次 `Update AI usage dashboard` 工作流。

CCSwitch 只用于首次保留已有历史；种子完成后可以退出或卸载。

## 统计正确性

- Claude 流式事件按同一消息的最终 usage 快照计数，避免中间快照重复累计。
- Codex 累计计数按相邻事件增量计算；进程重置后的较小计数作为新基线处理。
- Codex `cache_write_input_tokens` 从普通输入拆分到 Cache Creation；`rate_limits` 只保存最新额度快照，不计入 token。
- 每天全量重扫最近 7 天并与增量账本对账；`ai-token-dashboard doctor --repair` 可手动检查和修复。
- 日志目录缺失、文件不可读或格式异常时诊断会降级，自动修复不会删除仍可能有效的历史数据。

统计来源是每台设备本机的 Claude Code/Codex 原生日志。没有安装采集器的设备、已被外部永久删除且不在保留窗口内的日志，无法由本项目补算。Codex 当前的 ChatGPT 登录方式也不提供账户级 token 总量 API，因此额度快照只能作为辅助诊断，不能替代本地明细对账。

SVG 右下角日期取本次汇总的 `generated_at`，表示看板生成时间；不再取最后一条 token 记录的时间，所以即使当天没有新请求也会正常更新。

## 验证

```powershell
npm test
npm run test:python
```

数据口径、迁移对账和 SVG 生成器说明见 [`tools/ai-usage-dashboard/README.md`](./tools/ai-usage-dashboard/README.md)。
