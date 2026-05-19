# CPA-Manager Codex 余量面板

这是 `codex-quota-panel` 分支的说明首页。打开这个分支时，优先看这份 README 就够了。

本分支基于 CPA-Manager / CPAMC 增强，重点新增了 **Codex 账号余量、重置时间、账号池余量估算、今日消耗、账号启停、失败记录清理** 等功能。它不包含 CLIProxyAPI 本体，需要你已经部署好 CLIProxyAPI。

![Codex 余量页面总览](img/codex-quota-dashboard-overview-20260519.png)

截图只替换了账号邮箱；账号池余量看板、筛选数量、今日消耗和其它状态信息保留页面原样。

## 适合谁

适合你：

- 已经部署了 CLIProxyAPI
- 有一批 Codex 账号 JSON 文件
- 想直观看每个账号的余量、重置时间、是否受限
- 想在页面里启用、停用、删除、批量操作账号
- 想把 Docker 面板分享给其他用户，但不暴露自己的账号和密钥

不适合你：

- 还没有部署 CLIProxyAPI
- 想把账号 JSON、数据库、密钥直接打进镜像
- 想在没有任何登录保护的情况下直接暴露公网

## 分支说明

| 分支                | 用途                                                |
| ------------------- | --------------------------------------------------- |
| `main`              | 跟随原 CPA-Manager / CPAMC 上游代码，不混入定制功能 |
| `codex-quota-panel` | 维护 Codex 余量面板、Docker 部署和配套使用文档      |

使用前请确认当前分支：

```bash
git checkout codex-quota-panel
```

## 功能概览

- Codex 账号余量和重置时间
- 账号池总余量估算
- 今日消耗 Tokens / 预估花费
- 账号状态筛选：全部、可调用、受限、异常、未知、启用、停用
- 余量分布筛选：0%、1-20%、21-50%、51-80%、81-90%、91-100%
- 重置时间筛选：已重置、今天、明天、2 天后至 7 天后、未知
- 存活周期筛选：`<1天`、`1-3天`、`3-7天`、`7-14天`、`14天以上`、未知
- 单账号刷新、启用、停用、归档删除
- 批量启用、批量停用、批量删除、刷新已选账号
- 清除失败调用记录
- Usage 用量统计、调用监控、模型费用估算
- 保留原 CPA 管理面板中的配置、AI 提供商、认证文件、OAuth、日志、中心信息等功能

## 安装部署方式

先说结论：

- 不想自己敲命令：选 **AI 安装**
- 想照着一步步做：选 **Docker 安装**
- 想自己改代码或重新打镜像：选 **源码构建安装**
- 已经装过旧版本：看 **升级方式**

## 方式一：AI 安装

把下面这句话发给 AI：

```text
请帮我在当前电脑上部署 CPA-Manager 的 codex-quota-panel 分支。使用 Docker 方式启动，保留我的账号文件和数据，不要读取、上传或提交 .env、auths、data、SQLite、日志和任何密钥。请根据我的 CLIProxyAPI 地址、Management Key 和 Codex auths 目录完成配置，启动后告诉我访问地址和是否启动成功。
```

你只需要准备 3 个信息：

| 信息             | 示例                           |
| ---------------- | ------------------------------ |
| CLIProxyAPI 地址 | `http://cli-proxy-api:8317`    |
| Management Key   | 你自己的管理密钥               |
| auths 目录       | 存放 Codex JSON 文件的本地目录 |

## 方式二：Docker 安装（推荐）

这是最适合普通用户的方法。你不需要编译代码。

### 第一步：新建部署目录

```bash
mkdir cpa-manager-codex
cd cpa-manager-codex
```

### 第二步：下载部署文件

```bash
curl -fsSL -o docker-compose.codex-quota.yml https://raw.githubusercontent.com/yifengai/CPA-Manager/codex-quota-panel/docker-compose.codex-quota.yml
curl -fsSL -o .env.example https://raw.githubusercontent.com/yifengai/CPA-Manager/codex-quota-panel/.env.example
cp .env.example .env
```

如果你的环境不能访问 raw.githubusercontent.com，也可以改用 Git：

```bash
git clone -b codex-quota-panel https://github.com/yifengai/CPA-Manager.git
cd CPA-Manager
cp .env.example .env
```

### 第三步：修改 `.env`

至少改这 3 项：

```env
CPA_MANAGEMENT_KEY=your-own-management-key
CPA_CODEX_AUTH_PATH=/absolute/path/to/your/auths
CPA_UPSTREAM_URL=http://cli-proxy-api:8317
```

字段说明：

| 字段                            | 必填 | 说明                                                            |
| ------------------------------- | ---- | --------------------------------------------------------------- |
| `CPA_MANAGER_IMAGE`             | 是   | 面板镜像地址，默认 `ghcr.io/yifengai/cpa-manager:codex-quota`   |
| `CPA_MANAGER_PORT`              | 是   | 面板访问端口，默认 `18317`                                      |
| `CPA_MANAGEMENT_KEY`            | 是   | CLIProxyAPI Management Key                                      |
| `CPA_CODEX_AUTH_PATH`           | 是   | 本机 Codex 账号 JSON 文件目录                                   |
| `CPA_UPSTREAM_URL`              | 是   | 容器内访问 CLIProxyAPI 的地址                                   |
| `CODEX_QUOTA_ESTIMATE_TOKENS`   | 否   | 单账号周期估算 Tokens，默认 `4000000`                           |
| `CODEX_QUOTA_ESTIMATE_COST_USD` | 否   | 单账号周期估算价值，默认按 GPT-5.5 输入价格 $5 / 1M tokens 估算 |
| `CODEX_QUOTA_ESTIMATE_CALLS`    | 否   | 单账号周期估算调用次数                                          |

### 第四步：选对 CLIProxyAPI 地址

如果 CPA-Manager 和 CLIProxyAPI 在同一个 Docker 网络中：

```env
CPA_UPSTREAM_URL=http://cli-proxy-api:8317
```

如果 CLIProxyAPI 跑在 Docker Desktop 宿主机上：

```env
CPA_UPSTREAM_URL=http://host.docker.internal:8317
```

如果 CLIProxyAPI 跑在另一台机器上：

```env
CPA_UPSTREAM_URL=http://your-server-ip:8317
```

### 第五步：启动

```bash
docker compose -f docker-compose.codex-quota.yml --env-file .env up -d
```

### 第六步：打开页面

本机访问：

```text
http://127.0.0.1:18317/management.html#/codex-quota
```

服务器部署时，把 `127.0.0.1` 换成服务器 IP 或域名。

## 方式三：源码构建安装

这种方式适合开发者，或者你想自己改页面、改文案、改功能后再打镜像。普通用户可以跳过。

需要准备：

- Node.js
- Docker
- docker compose

执行：

```bash
git clone -b codex-quota-panel https://github.com/yifengai/CPA-Manager.git
cd CPA-Manager
npm install
npm run build
docker build -f Dockerfile.usage-service -t cpa-manager:codex-quota-local .
cp .env.example .env
```

然后打开 `.env`，把镜像改成本地镜像：

```env
CPA_MANAGER_IMAGE=cpa-manager:codex-quota-local
```

再按 Docker 安装方式填写 `CPA_MANAGEMENT_KEY`、`CPA_CODEX_AUTH_PATH`、`CPA_UPSTREAM_URL`，最后启动：

```bash
docker compose -f docker-compose.codex-quota.yml --env-file .env up -d
```

## 升级方式

进入你的部署目录后执行：

```bash
docker compose -f docker-compose.codex-quota.yml --env-file .env pull
docker compose -f docker-compose.codex-quota.yml --env-file .env up -d
```

升级不会自动删除：

- `/data/usage.sqlite`
- `/data/deleted-auths`
- 你挂载的 auths 目录
- 你的 `.env`

## 首次使用

打开页面后，进入【Codex 余量】菜单。

建议第一次按这个顺序操作：

1. 确认页面能打开。
2. 点击【刷新余量】。
3. 等待账号列表加载完成。
4. 查看账号池余量看板。
5. 查看【账号状态】、【余量分布】、【重置时间】、【存活周期】筛选。
6. 对受限或异常账号执行停用、删除或批量操作。

## 页面说明

### 账号池余量看板

用于估算当前账号池还可以承接多少调用。

| 指标                  | 说明                                        |
| --------------------- | ------------------------------------------- |
| 可调用账号 / 库存账号 | 根据看板右上角【当前可用池 / 全部库存】切换 |
| 预估剩余 Tokens       | 根据每个账号剩余百分比估算                  |
| 预计可调用            | 按 `.env` 里的平均 Tokens/次参数估算        |
| 等价价值              | 按 `.env` 里的美元价值参数估算              |

默认估算参数：

```env
CODEX_QUOTA_ESTIMATE_TOKENS=4000000
CODEX_QUOTA_ESTIMATE_COST_USD=20
CODEX_QUOTA_ESTIMATE_CALLS=34
```

默认价值按 GPT-5.5 官方输入价格 $5 / 1M tokens 估算：4M Tokens 约等于 $20。这个值不是官方账号额度，只是本地估算基准。

### 今日消耗

【今日消耗】用于查看北京时间当天的 Usage 统计。数据会在进入页面时自动刷新，并写入浏览器缓存；再次点击【刷新余量】时也会同步更新。

| 指标        | 说明                             |
| ----------- | -------------------------------- |
| 总调用      | 今日请求总数                     |
| 调用成功率  | 成功请求占比，并显示平均响应时间 |
| 失败总数    | 今日失败调用数                   |
| 预估花费    | 按模型价格估算的今日成本         |
| 总 Tokens   | 今日总 Tokens，并显示推理 Tokens |
| 输入 Tokens | 今日输入 Tokens 和占比           |
| 输出 Tokens | 今日输出 Tokens 和占比           |
| 缓存 Tokens | 今日缓存 Tokens 和缓存命中率     |

### 账号状态

![可调用账号列表示例](img/codex-quota-callable-account-list-20260519.png)

| 标签   | 含义                                                               |
| ------ | ------------------------------------------------------------------ |
| 全部   | 所有 Codex 账号                                                    |
| 可调用 | 余量可查、未受限、未出现认证异常的账号                             |
| 受限   | 当前周期触发限制、余量为 0、`allowed=false` 或 `limitReached=true` |
| 异常   | Token 失效、登录凭证无效、认证失败等明确不可用状态                 |
| 未知   | 查询超时、数据不完整或暂时无法判断                                 |
| 启用   | 当前没有被标记为 disabled                                          |
| 停用   | 已停用，不进入调用池                                               |

停用账号仍然可以查询余量和重置时间，但不会进入调用池。

### 账号列表操作

![账号列表与批量操作](img/codex-quota-account-list-20260519.png)

账号列表支持：

| 操作     | 说明                                      |
| -------- | ----------------------------------------- |
| 刷新     | 只刷新当前账号                            |
| 启用     | 将账号 JSON 中的 `disabled` 改为 `false`  |
| 停用     | 将账号 JSON 中的 `disabled` 改为 `true`   |
| 删除     | 将账号文件移动到 `deleted-auths` 归档目录 |
| 批量启用 | 对已选账号批量启用                        |
| 批量停用 | 对已选账号批量停用                        |
| 批量删除 | 对已选账号批量归档删除                    |
| 刷新已选 | 只刷新勾选账号                            |

删除不是直接永久删除，而是归档到：

```text
/data/deleted-auths/<时间戳>/
```

## 隐私和安全

分享给别人前必须确认不要分享这些内容：

- `.env`
- `auths/`
- `data/`
- `reports/`
- `deleted-auths/`
- `*.sqlite`
- 日志文件
- 任何真实 Management Key
- 任何真实账号 JSON

本项目的 `.dockerignore` 已默认排除这些敏感文件。截图发布前也要确保邮箱、密钥、token、真实路径已经脱敏。

## 常见问题

### 页面打不开

先检查容器是否启动：

```bash
docker compose -f docker-compose.codex-quota.yml --env-file .env ps
```

再查看日志：

```bash
docker compose -f docker-compose.codex-quota.yml --env-file .env logs -f
```

### 登录提示未授权

检查 `.env` 中的 `CPA_MANAGEMENT_KEY` 是否和 CLIProxyAPI 的 Management Key 一致。

### 打开页面后没有账号

检查：

1. `CPA_CODEX_AUTH_PATH` 是否指向真实目录。
2. 目录里是否有 `.json` 文件。
3. JSON 文件中 `type` 是否为 `codex`。
4. Docker 是否有权限读取该目录。

### 刷新余量失败

检查：

1. 账号 JSON 是否包含可用 token。
2. 当前网络是否能访问 ChatGPT / Codex 相关接口。
3. 账号是否需要重新登录。
4. 容器时间是否正常。

### 调用监控没有数据

检查：

1. CLIProxyAPI 是否开启 `usage-statistics-enabled: true`。
2. `CPA_UPSTREAM_URL` 是否正确。
3. CPA-Manager 是否能访问 CLIProxyAPI。
4. 是否只有启动 CPA-Manager 之后的新调用才进入数据库。

## 更多文档

更完整的部署、备份、恢复和分享说明见：

[docs/codex-quota-docker.md](docs/codex-quota-docker.md)

## 推荐分享话术

你可以把下面这段发给其他用户：

```text
这是一个 CLIProxyAPI 的 Docker 管理面板，重点增强了 Codex 账号余量、重置时间、账号池估算、今日消耗和失败记录清理。

使用前需要准备：
1. 已运行的 CLIProxyAPI
2. CLIProxyAPI Management Key
3. Codex auth JSON 文件目录
4. Docker

按 README 选择 AI 安装或 Docker 安装，启动后打开：
http://127.0.0.1:18317/management.html#/codex-quota

注意：不要把 .env、auths、data、SQLite、日志文件发给别人。
```
