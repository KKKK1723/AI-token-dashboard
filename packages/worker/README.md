# AI Token Dashboard Worker

Cloudflare Worker 提供写入与最近 30 天汇总 API，D1 保存每台设备的每日绝对桶。

## 创建密钥

生成两个不同的 256 位随机值：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

- `SYNC_KEY`：只放到个人设备，用于写入。
- `READ_KEY`：只放到 GitHub Actions，用于读取汇总。

## 部署

```powershell
Set-Location packages\worker
npx wrangler login
npx wrangler d1 create ai-token-dashboard
```

把命令返回的 `database_id` 写入 [`wrangler.toml`](./wrangler.toml)，然后初始化远端 schema：

```powershell
npm run db:init:remote
npx wrangler secret put SYNC_KEY
npx wrangler secret put READ_KEY
npm run deploy
```

`DASHBOARD_TIMEZONE` 默认是 `Asia/Shanghai`。所有 CLI 设备必须使用同一时区，否则 Worker 会拒绝上传，避免跨设备日期边界不一致。

## GitHub Actions

在仓库 `Settings -> Secrets and variables -> Actions` 添加：

```text
DASHBOARD_API_URL=https://ai-token-dashboard.<account>.workers.dev
DASHBOARD_READ_KEY=<READ_KEY>
```

工作流每天 03:30 CST 拉取最近 30 天汇总，比设备默认的 03:10 上传晚 20 分钟。首次部署后可在 Actions 页面手动运行 `Update AI usage dashboard`。

## API

- `GET /health`：无需鉴权。
- `POST /v1/sync`：`Authorization: Bearer <SYNC_KEY>`。
- `GET /v1/summary?days=30`：`Authorization: Bearer <READ_KEY>`。

每个写入桶的主键是 `device_id + usage_date + source + model`。同设备仅有更大 `sequence` 能覆盖；不同设备保留独立行，汇总查询时相加。

## 本地验证

```powershell
npm run db:init:local
npm run dev -- --var SYNC_KEY:test-sync-key --var READ_KEY:test-read-key
```

本地 D1 存放在 `.wrangler`，不会提交到 Git。
