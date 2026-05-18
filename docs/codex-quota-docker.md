# Codex 余量面板 Docker 部署说明

这份文档面向不熟悉代码构建的用户。部署后可以在浏览器里查看 Codex 账号余量、恢复时间、账号池估算、启用/停用账号，并清除失败调用记录。

## 一、准备条件

你需要先准备好：

1. 已经运行的 CLIProxyAPI。
2. CLIProxyAPI 的 Codex 账号文件目录，也就是一组 `.json` 账号文件所在目录。
3. Docker Desktop 或 Docker Engine。
4. 一个你自己设置的 Management Key。

不要把账号 JSON、`.env`、数据库、日志上传到 GitHub 或发给别人。

## 二、下载配置文件

把下面两个文件放到同一个空目录里：

- `docker-compose.codex-quota.yml`
- `.env.example`

然后复制一份配置：

```bash
cp .env.example .env
```

编辑 `.env`，至少修改这几项：

```env
CPA_MANAGEMENT_KEY=your-own-key
CPA_CODEX_AUTH_PATH=/absolute/path/to/your/auths
CPA_UPSTREAM_URL=http://cli-proxy-api:8317
```

如果 CLIProxyAPI 跑在宿主机上，而不是同一个 Docker 网络里，通常可以改成：

```env
CPA_UPSTREAM_URL=http://host.docker.internal:8317
```

## 三、启动

在配置文件所在目录执行：

```bash
docker compose -f docker-compose.codex-quota.yml --env-file .env up -d
```

启动后打开：

```text
http://127.0.0.1:18317/management.html#/codex-quota
```

如果你改了端口，例如 `CPA_MANAGER_PORT=19017`，访问地址就是：

```text
http://127.0.0.1:19017/management.html#/codex-quota
```

## 四、账号池估算参数

账号池余量看板使用本地估算参数，不是官方固定额度。默认值：

```env
CODEX_QUOTA_ESTIMATE_TOKENS=4000000
CODEX_QUOTA_ESTIMATE_COST_USD=4
CODEX_QUOTA_ESTIMATE_CALLS=34
```

含义：

- `CODEX_QUOTA_ESTIMATE_TOKENS`：一个账号周期估算可用 Tokens。
- `CODEX_QUOTA_ESTIMATE_COST_USD`：一个账号周期估算价值。
- `CODEX_QUOTA_ESTIMATE_CALLS`：一个账号周期估算可承接调用次数。

如果你的使用习惯不同，可以直接改 `.env` 后重启：

```bash
docker compose -f docker-compose.codex-quota.yml --env-file .env up -d
```

## 五、升级

拉取新镜像并重启：

```bash
docker compose -f docker-compose.codex-quota.yml --env-file .env pull
docker compose -f docker-compose.codex-quota.yml --env-file .env up -d
```

数据保存在 Docker volume `cpa-manager-data` 中，账号文件来自你本机挂载的 `CPA_CODEX_AUTH_PATH`，不会被打进镜像。

## 六、维护者发布镜像

如果你要把镜像发布给其他人使用，建议使用独立的公开发布标签：

```bash
docker build -f Dockerfile.usage-service -t ghcr.io/yifengai/cpa-manager:codex-quota .
docker push ghcr.io/yifengai/cpa-manager:codex-quota
```

发布前先检查构建上下文，确认没有账号、密钥、数据库、报告文件：

```bash
git status --short
git grep -n "CPA_MANAGEMENT_KEY\\|/Users/\\|auths/" -- ':!docs/codex-quota-docker.md'
docker build -f Dockerfile.usage-service -t cpa-manager:privacy-check .
```

`.dockerignore` 已默认排除 `.env`、`auths/`、`data/`、`reports/`、SQLite 数据库和日志文件。即便如此，发布前仍建议在一个干净目录里构建镜像。

## 七、安全建议

1. 不要把服务直接暴露到公网。
2. 不要共享你的 Management Key。
3. 不要提交 `.env` 文件。
4. 不要提交 `auths/`、`data/`、`reports/`、`*.sqlite`。
5. 如果需要远程访问，建议使用 VPN 或带登录认证的反向代理。

## 八、常见问题

### 打开页面后没有账号

检查 `.env` 里的 `CPA_CODEX_AUTH_PATH` 是否指向真实账号目录。

### 页面能打开，但刷新失败

检查 `CPA_UPSTREAM_URL` 是否能从容器内访问到 CLIProxyAPI。

### 提示未授权

确认页面登录时填写的 Management Key 与 `.env` 里的 `CPA_MANAGEMENT_KEY` 一致。

### 容器启动失败

查看日志：

```bash
docker compose -f docker-compose.codex-quota.yml --env-file .env logs -f
```
