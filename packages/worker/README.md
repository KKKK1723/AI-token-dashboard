# AI Token Dashboard Worker

Cloudflare Worker 提供 GitHub 设备注册、同步和最近 30 天汇总 API，D1 保存每台设备的每日绝对桶。

## 创建密钥

生成两个不同的 256 位随机值：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

- `SYNC_KEY`：只保留在原设备，用于直接写入和签发一次性配对字符串。
- `READ_KEY`：只放到 GitHub Actions，用于读取汇总。

默认情况下，新设备通过指定 GitHub 账号登录并领取独立设备 token；一次性配对字符串只作为回退。两种方式都不会把 `SYNC_KEY` 下发到新设备。

## 创建 GitHub OAuth App

在 GitHub `Settings -> Developer settings -> OAuth Apps -> New OAuth App` 创建 OAuth App：

```text
Homepage URL:
https://github.com/KKKK1723/AI-token-dashboard

Authorization callback URL:
http://127.0.0.1/oauth/callback
```

CLI 实际监听随机端口，例如 `http://127.0.0.1:49152/oauth/callback`。GitHub 对 loopback callback 允许运行时端口不同；主机必须保持为 `127.0.0.1`。

把 Client ID 写入 `wrangler.toml` 的 `[vars]`，并固定允许登录的 GitHub 数字用户 ID：

```toml
[vars]
DASHBOARD_TIMEZONE = "Asia/Shanghai"
GITHUB_ALLOWED_USER_ID = "181867828"
GITHUB_OAUTH_CLIENT_ID = "<OAuth App Client ID>"
```

Client ID 会由公开配置接口返回，不是秘密。Client secret 必须使用 Worker secret：

```powershell
npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
```

OAuth 请求不包含 `scope`。Worker 会拒绝 GitHub 返回的任何非空 scope，校验数字用户 ID，并撤销临时 GitHub token；只有撤销成功后才创建设备凭据。

## 部署

```powershell
Set-Location packages\worker
npx wrangler login
npx wrangler d1 create ai-token-dashboard
```

把命令返回的 `database_id` 写入 [`wrangler.toml`](./wrangler.toml)，再应用迁移、设置 secret 并部署：

```powershell
npm run db:migrate:remote
npx wrangler secret put SYNC_KEY
npx wrangler secret put READ_KEY
npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
npm run deploy
```

已有部署升级时不需要重建 D1 或修改 `SYNC_KEY`、`READ_KEY`。先在 GitHub 创建 OAuth App、配置 Client ID/secret，再运行：

```powershell
npm run db:migrate:remote
npm run deploy
```

迁移会保留已有日桶，并补齐设备凭据与 `sync_runs`。后者记录 `snapshotId`、序号、payload 哈希和同步窗口，用于强幂等与乱序保护。

`DASHBOARD_TIMEZONE` 默认是 `Asia/Shanghai`。所有 CLI 设备必须使用同一时区，否则 Worker 会拒绝上传，避免跨设备日期边界不一致。

## GitHub Actions

在仓库 `Settings -> Secrets and variables -> Actions` 添加：

```text
DASHBOARD_API_URL=https://ai-token-dashboard.<account>.workers.dev
DASHBOARD_READ_KEY=<READ_KEY>
```

工作流每天 03:30 CST 拉取最近 30 天汇总。设备每 10 分钟检查并上传变化，因此正常情况下工作流读取到的是最近一次本地变更；首次部署后可在 Actions 页面手动运行 `Update AI usage dashboard`。

## API

- `GET /health`：无需鉴权。
- `GET /v1/oauth/github/config`：返回公开 Client ID 和 GitHub 授权地址。
- `POST /v1/oauth/github/exchange`：交换 PKCE 授权码、验证唯一 GitHub 用户并签发设备 token。
- `POST /v1/pairing-codes`：主 `SYNC_KEY` 鉴权，签发 10 分钟一次性配对码。
- `POST /v1/pair`：使用一次性配对码领取独立设备 token。
- `POST /v1/sync`：接受主 `SYNC_KEY` 或已经绑定的设备 token。
- `GET /v1/summary?days=30`：`READ_KEY` 鉴权。

D1 只保存配对码和设备 token 的 SHA-256 摘要，不保存原文。OAuth token 在签发时直接绑定 `device_id`；配对 token 首次同步时绑定，之后不能用于其他设备 ID。

每个写入桶的主键是 `device_id + usage_date + source + model`。schema v2 在单个 D1 `batch()` 中登记快照、清理声明窗口并写入全部绝对桶。同一快照精确重试幂等成功，旧序列或内容冲突返回 409；不同设备保留独立行，汇总查询时相加。

## 本地验证

```powershell
npm run db:migrate:local
npm run dev -- --var SYNC_KEY:test-sync-key --var READ_KEY:test-read-key
```

本地 D1 存放在 `.wrangler`，不会提交到 Git。
