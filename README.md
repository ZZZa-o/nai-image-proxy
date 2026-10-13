# NovelAI 生图中转（nai-image-proxy）

让 SillyTavern 生图插件把请求发到自己的地址，再转发至 **`https://image.novelai.net`**。提供两种部署方式：Cloudflare Worker 与 Render + Express。

```text
SillyTavern 生图插件 → https://<你的地址> → https://image.novelai.net
```

代理只处理下列生图接口，不实现登录、余额查询、文本模型或 OpenAI 协议转换。

| 方法 | 路径 | 转发方式 |
| --- | --- | --- |
| POST | `/ai/generate-image` | 原始响应流，通常为 ZIP |
| POST | `/ai/generate-image-stream` | 原始 SSE 流 |
| POST | `/ai/upscale` | 原始响应流 |
| POST | `/ai/augment-image` | 原始响应流 |
| GET | `/ai/generate-image/suggest-tags` | 原样保留查询参数和 JSON 返回 |
| GET / HEAD | `/healthz` | 本地健康检查，不调用 NovelAI |
| OPTIONS | 上述五个生图路径 | 本地处理浏览器跨域预检 |

## 部署方式怎么选

两种方式都不需要自备域名，各自免费提供一个 HTTPS 地址。

| | Cloudflare Worker | Render Web Service |
| --- | --- | --- |
| 免费地址 | `https://nai-image-proxy.<子域>.workers.dev` | `https://<服务名>.onrender.com` |
| 冷启动 | 无 | Free 实例闲置 15 分钟后休眠，唤醒约一分钟 |
| 出口 | Cloudflare 边缘网络 | Render 数据中心共享 IP |
| 免费额度 | 每日请求数与 CPU 时间 | 每月实例时数与带宽 |
| 前置条件 | Cloudflare 账号 | Render 账号，且代码已在 GitHub |

建议先部署 Worker。`workers.dev` 本身就是可用的 HTTPS 地址，不需要域名，也没有冷启动。只有在 Cloudflare 出口被 NovelAI 拒绝时，才改用 Render。

## 转发行为

- 请求体作为字节流传递，不调用 JSON 解析器，不重排字段，不改 Prompt、模型、种子、图片或其他参数。
- `Authorization: Bearer …` 使用客户端传来的值。服务端不保存、不替换 NovelAI Token，也不需要设置 `NAI_TOKEN` 环境变量。
- 保留请求路径、查询参数编码和重复参数；上游固定为 `image.novelai.net`，客户端无法选择其他上游。
- 不向 NovelAI 转发调用者的身份信息。`Host`、`Forwarded`、`X-Forwarded-For`、`X-Forwarded-Host`、`X-Forwarded-Proto`、`X-Forwarded-Port`、`X-Real-IP`、`True-Client-IP` 以及全部 `cf-*` 头（含 `CF-Connecting-IP`、`CF-IPCountry`、`CF-Ray`）在转发前删除，上游看不到调用者的地址、地区或边缘标识。
- 保留上游 HTTP 状态码、响应体和端到端响应头，包括 `Content-Type`、`Content-Disposition`、`Content-Encoding`、`Retry-After`、`x-correlation-id` 等。
- ZIP、PNG、WebP、gzip 和 SSE 均直接流式传递。Express 使用 Node HTTP 流，避免 `fetch()` 自动解压后仍携带旧的长度/编码头。
- 不缓存生成结果，不落盘、不记录 Prompt、图片内容或 Authorization。Worker 的应用日志、调用日志和追踪默认关闭。
- 不自动重试生成请求，也不跟随上游重定向。上游的 3xx、4xx、5xx 原样返回；在收到上游响应前发生连接失败时，代理返回固定文本的 502。响应开始后若连接中断，只能中断流，不能再修改状态码。

“保留响应头”指保留端到端 HTTP 语义。反向代理必须重建 `Host`，移除 `Connection`、`Transfer-Encoding` 等逐跳头及 `Connection` 指定的字段；浏览器请求还需要调整 CORS 头。Cloudflare/Render 边缘可能重建长度、压缩或加入平台头，不能保证两次 HTTP 传输的全部头部逐字相同。上游返回多个同名响应头时，除 `Set-Cookie` 保留为多个字段外，其余按 HTTP 语义合并为一个字段。

## 部署到 Cloudflare Worker

### 准备

需要 Node.js 22 或更新版本（推荐 24 LTS，仓库内 `.node-version` 已指定 24）、一个 Cloudflare 账号。只使用 `workers.dev` 时不需要域名；绑定自定义域名还需要该域名的 DNS 区域已在自己的 Cloudflare 账号中激活。

在本项目目录执行。Windows PowerShell 如遇 `npm.ps1` 执行策略问题，可用 `npm.cmd` / `npx.cmd`：

```sh
npm ci
npm test
npm run check:worker
npx wrangler login
npm run deploy
```

| 命令 | 作用 |
| --- | --- |
| `npm ci` | 按 `package-lock.json` 安装依赖 |
| `npm test` | 本地运行全部测试，不联网、不消耗额度 |
| `npm run check:worker` | 只检查和打包，不发布 |
| `npx wrangler login` | 在浏览器中登录 Cloudflare 账号 |
| `npm run deploy` | 发布到 Cloudflare |

`login` 会在浏览器中登录 Cloudflare，成功后凭据由 Wrangler 保存在本机，后续部署不必重复登录。

源码入口是 `src/worker.mjs`，共享路由及跨域逻辑在 `src/common.mjs`。Wrangler 会自动打包，不需要安装 Express，也不需要上传 `node_modules`。配置文件为 `wrangler.toml`，其中 `name = "nai-image-proxy"` 决定 `workers.dev` 地址里的名称部分。

### 验证

部署后 Wrangler 会打印类似地址：

```text
https://nai-image-proxy.<你的子域>.workers.dev
```

```sh
curl https://nai-image-proxy.<你的子域>.workers.dev/healthz
```

预期返回 `ok`。该检查只证明代理存活；出口是否被 NovelAI 接受，用“验证实际接口”一节的带 Token 请求判断。

### 可选：绑定自定义域名

有域名时按以下步骤绑定。将配置中的域名替换为自己的真实域名。在 `wrangler.toml` 顶层已有相应注释，取消那三行注释即可；保留在 `[vars]` 之前：

```toml
[[routes]]
pattern = "nai.example.com"
custom_domain = true
```

再次执行：

```sh
npm run deploy
curl https://nai.example.com/healthz
```

也可以通过 Cloudflare 控制台：**Workers & Pages → nai-image-proxy → Settings → Domains & Routes → Add → Custom Domain**，填写 `nai.example.com`。

Cloudflare 会建立 DNS 记录并签发 HTTPS 证书，无需把这个子域手动 CNAME 到 NovelAI。若同名子域已有 CNAME，先确认旧用途，再解决冲突。证书激活后再测试。使用控制台绑定的域名也建议写入 `wrangler.toml`，让后续部署配置一致。

### 跨域配置

默认 `ALLOWED_ORIGINS = "*"`，支持插件在浏览器中携带 Authorization 请求代理，预检会允许客户端申请的请求头。不要给 API 域名配置需要交互登录的 Cloudflare Access 页面或浏览器挑战，否则插件收到的会是 HTML。

若仅允许自己的酒馆网页调用，可改为：

```toml
[vars]
ALLOWED_ORIGINS = "http://127.0.0.1:8000,http://localhost:8000,https://tavern.example.com"
```

填浏览器实际的 Origin（协议、主机、端口，无末尾斜杠），然后重新部署。没有 `Origin` 的后端请求和 curl 仍允许通过。CORS 是浏览器访问约束，不是代理密码或客户端身份认证；每个调用者仍须提供自己的有效 NovelAI Token。浏览器直接调用应使用普通 Bearer 头，不依赖 Cookie 或 `credentials: 'include'`。

## 部署到 Render

适用于 Worker 出口被上游拒绝，或你更希望运行 Node 服务的情况。

### 准备仓库

先将本项目的源文件、`package.json`、`package-lock.json`、`render.yaml` 和 `.node-version` 推送到自己的 GitHub/GitLab/Bitbucket 仓库。不要上传真实 `request.json`、Token 或生成图片；`.gitignore` 已包含常见敏感文件和输出。

### 方式一：Blueprint

仓库已包含 `render.yaml`，用 Blueprint 可以一次配置到位：

1. 打开 [Render Dashboard](https://dashboard.render.com/)，选择 **New → Blueprint**。
2. 连接包含本仓库的 Git 账号，选择该仓库。
3. Render 解析 `render.yaml` 并列出将要创建的服务，核对后 Apply。

`render.yaml` 的默认内容：

```yaml
services:
  - type: web
    name: nai-proxy
    runtime: node
    plan: free
    region: singapore
    buildCommand: npm ci --omit=dev
    startCommand: npm start
    healthCheckPath: /healthz
    envVars:
      - key: NODE_VERSION
        value: "24"
      - key: NODE_ENV
        value: production
      - key: ALLOWED_ORIGINS
        value: "*"
```

已安装 Render CLI 时可先执行 `render whoami -o json` 检查登录、`render blueprints validate` 验证 Blueprint；未登录时执行 `render login`。本地未安装 CLI 时，用上面的 Dashboard 流程即可。

### 方式二：手动创建 Web Service

不使用 Blueprint 时，在 Dashboard 选择 **New → Web Service**，连接仓库后按下表填写：

| 项目 | 值 |
| --- | --- |
| Root Directory | 项目位于仓库根目录时留空 |
| Runtime | Node |
| Build Command | `npm ci --omit=dev` |
| Start Command | `npm start` |
| Health Check Path | `/healthz` |
| Instance Type | Free 起步，按实际用量调整 |
| Region | Singapore，也可选其他区域 |

环境变量：

| 名称 | 值 / 用途 |
| --- | --- |
| `NODE_VERSION` | `24`，与仓库内 `.node-version` 保持一致 |
| `NODE_ENV` | `production` |
| `ALLOWED_ORIGINS` | `*`，或逗号分隔的酒馆 Origin |
| `PORT` | 使用 Render 自动提供的值，无需手动设置；本地默认 3000 |

无需设置 NovelAI Token、数据库或存储。服务监听 `0.0.0.0:$PORT`。

### 区域、服务名与地址

`render.yaml` 默认使用 `singapore` 区域，离中国大陆较近。区域只在创建时确定，之后修改需要重建服务，最好第一次就选定。

免费实例的访问地址是 `https://<服务名>.onrender.com`。本项目把 Render 服务名设为较短的 `nai-proxy`，因此地址是 `https://nai-proxy.onrender.com`，方便填进插件。仓库名是 `nai-image-proxy`，与 Render 服务名不同，因为服务名会出现在日常要填的地址里。`onrender.com` 的子域在全平台唯一，若 `nai-proxy` 已被其他用户占用，Render 会自动加后缀，以控制台实际显示的地址为准。想换成更好记的名字，可在服务的 **Settings → Name** 中修改，地址会随之改变，插件里也要同步更新。

### 验证

部署完成后访问 `https://<你的地址>/healthz`，返回 `ok` 后再用带 Token 的请求测试。Free 实例首次访问需要唤醒，约一分钟，看到超时先等唤醒完成再判断。

### 出口 IP 的风险

Render 的出口是共享数据中心 IP，而 NovelAI 前置了 Cloudflare，数据中心 IP 被挑战或限流是常见情况。部署完成后先发一个不带 Token 的请求判断出口是否可用：

```sh
curl -i -X POST https://<你的地址>/ai/generate-image \
  -H 'Content-Type: application/json' \
  --data-binary '{}'
```

返回 NovelAI 的 401 JSON，说明出口通畅，只差 Token；返回 Cloudflare 的 HTML 挑战页面，说明出口被拦，此时调整应用配置没有意义，应改用另一种部署方式。

## SillyTavern 配置

在现有插件的 **NovelAI 生图 Base URL** 中填写部署得到的地址：

```text
https://nai-image-proxy.<你的子域>.workers.dev
```

或 Render 的 `https://nai-proxy.onrender.com`。有自定义域名时填自定义域名。

保持原来的 NovelAI Token 和生图参数。Base URL 不要带 `/ai/generate-image`、`/v1` 或 `/api`，由插件追加接口路径。如果插件字段明确要求的是“完整生成接口 URL”，则填写 `https://<你的地址>/ai/generate-image`。

本方案基于你所述插件能修改 NovelAI 生图 Base URL。不同插件的设置入口不同；若它仍硬编码官方地址，或把同一 Base URL 还用于账号/余额接口，需要另查插件实现，不能仅凭生图中转保证那些功能可用。本项目没有修改本地酒馆安装。

## 验证实际接口

先用一个无真实 Token 的请求检查路径和上游连通性。这不会产生有效生图：

```sh
curl -i -X POST https://<你的地址>/ai/generate-image \
  -H 'Content-Type: application/json' \
  --data-binary '{}'
```

通常会得到上游 401，具体状态和响应以官方为准。单独执行 `curl -X POST ...` 缺少 Token 和有效参数，不能作为生图成功测试。

### Windows PowerShell 真实生图

1. 将 `request.example.json` 复制为 `request.json`。示例使用 `nai-diffusion-3`；最好改用当前插件已能直连成功的完整 JSON，以匹配你使用的模型和参数。代理不会补齐或转换参数。
2. 在本机终端输入 Token，避免直接写进命令历史、源文件或聊天。Token 会在当前进程内短暂以明文提供给 curl：

```powershell
$naiSecureToken = Read-Host 'NovelAI Token（不含 Bearer 前缀）' -AsSecureString
$env:NAI_TOKEN = [System.Net.NetworkCredential]::new('', $naiSecureToken).Password

curl.exe --silent --show-error --max-time 600 `
  -D proxy.headers -o response.zip `
  -X POST 'https://<你的地址>/ai/generate-image' `
  -H "Authorization: Bearer $env:NAI_TOKEN" `
  -H 'Content-Type: application/json' `
  -H 'Accept: application/zip' `
  --data-binary '@request.json'

Get-Content -LiteralPath proxy.headers
```

如果已有自己的 `request.json`，跳过第 1 步的复制，避免覆盖。检查 HTTP 状态与 `Content-Type`：官方文档中生成成功是 **201**，不是固定的 200。只有成功且类型为 ZIP 时才应当按 ZIP 解压；错误 JSON 也会保存到 `response.zip`，不要把文件存在当作成功。

可用 `tar -tf response.zip` 检查 ZIP 目录，或使用 Windows 压缩包工具打开。如果选择其他 `Accept`，上游可能返回 JSON，代理同样原样转发。

测试后清除当前进程的 Token：

```powershell
Remove-Item Env:NAI_TOKEN
Remove-Variable naiSecureToken
```

### Bash / Linux / macOS

先准备好自己的 `request.json`，然后：

```bash
read -rs -p 'NovelAI Token: ' NAI_TOKEN
printf '\n'
curl --silent --show-error --max-time 600 \
  -D proxy.headers -o response.zip \
  -X POST https://<你的地址>/ai/generate-image \
  -H "Authorization: Bearer $NAI_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/zip' \
  --data-binary @request.json
unset NAI_TOKEN
```

### 直连对照及 SSE

直连对照时，将同一条命令的 URL 换成 `https://image.novelai.net/ai/generate-image`，另存为 `direct.headers`、`direct.zip`，并发送完全相同的请求体及相关头。每次成功生成都可能消耗 Anlas；这会发起两次独立生成。随机数、上游模型实现、ZIP 元数据和时间相关响应头都可能不同，不能用两次 ZIP 文件逐字相同作为唯一判据。比较成功状态、响应类型、可解压图片和生成参数是否正确。

要检查流式接口，把 URL 改为 `/ai/generate-image-stream`，去掉 ZIP 的 `Accept`、`-o`，添加 `-N` 禁用 curl 输出缓冲。返回应是增量 SSE。其他接口应使用对应官方请求结构；标签建议的 `model`、`prompt`、`lang` 查询参数会原样转发。

## 运行边界与排查

截至 2026-10-07 查询到的官方说明：

- Worker 内存为 128 MB，但转发直接使用流，不需要把整个响应放进内存。Cloudflare 没有强制响应体大小上限；上传请求受账号计划限制，Free/Pro 通常为 100 MB，域名区域也可能设置更低上限。
- Workers Free 有每日请求数及 CPU 限制；等待上游网络不计入 CPU 时间。HTTP 请求在客户端保持连接时无固定总执行时长上限，但客户端、上游及平台其他网络超时仍然有效。
- Render Free 在 15 分钟无入站流量后休眠，首次唤醒通常约一分钟，可能导致插件首次请求超时。Free 对带宽、实例时数及大量主动外连也有限制，持续生图中转应按实际情况评估实例计划。
- 两种部署的出口都由平台决定。Cloudflare 边缘与 Render 数据中心 IP 均可能被 NovelAI 前置的 Cloudflare 挑战，这与代码无关。
- `package.json` 的 `overrides` 把传递依赖 `sharp` 固定为 `0.35.5`。该依赖只由开发依赖 `miniflare` 引入，`npm ls sharp --omit=dev` 为空，不进入线上服务的依赖树，仅影响本地测试环境。升级 Wrangler/Miniflare 后应重新评估这条约束是否仍然必要。
- 应用不记录敏感内容。Cloudflare/Render 自身可能仍产生平台访问日志；尤其标签建议将 `prompt` 放在 URL 中。不要对真实请求开启 Wrangler Tail、完整 URL 访问日志、Logpush、第三方请求追踪或抓包。若账号层面已启用这些设施，应关闭对应记录或脱敏 URL 查询串；应用代码无法保证托管商不保留基础设施元数据。
- 不要给 API 配置“Cache Everything”等强制缓存规则。默认不使用 Worker Cache API，出站 `fetch` 使用 `no-store`；端到端上游响应头仍保留。

| 现象 | 检查方向 |
| --- | --- |
| `/healthz` 也打不开 | DNS、HTTPS 证书、本地网络到代理的连通性 |
| 404 / 405 | Base URL 是否多拼了 `/ai`、`/v1` 或接口路径；请求方法是否正确 |
| 上游 401 / 402 | Token、账号权限或余额；代理不会替换这些错误 |
| 403 或 HTML 挑战页面 | 分清代理域名的 Access/WAF 与 NovelAI 对代理出口的限制；必要时换部署方式 |
| 429 | 上游限流；等待后由用户重试，代理不自动重复扣费请求 |
| 固定文本 502 | 代理尚未收到上游响应就发生 DNS/TLS/连接失败 |
| 413 | 平台上传大小限制，特别是包含 base64 图片的请求 |
| curl 成功、浏览器失败 | OPTIONS、实际 Origin、CORS 配置或插件仍访问旧地址 |
| 压缩包损坏 | 先看状态码和 Content-Type，确认不是保存下来的 JSON/HTML 错误 |
| Render 首次请求慢 | Free 实例唤醒；先访问 `/healthz`，或评估常驻实例 |

## 署名与许可

作者：ZZZa-o。仓库地址：<https://github.com/ZZZa-o/nai-image-proxy>。

以 MIT 许可证发布，详见 `LICENSE`。

本项目只是转发层，与 NovelAI 无隶属关系。使用时仍须遵守 NovelAI 的服务条款，并自行承担账号与额度风险。

## 官方参考

- [NovelAI 生图 API 文档](https://image.novelai.net/docs/index.html)
- [NovelAI 当前 Swagger 定义](https://image.novelai.net/docs/doc.json)
- [Cloudflare Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare 自定义域名](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Cloudflare Fetch 与压缩直通](https://developers.cloudflare.com/workers/runtime-apis/fetch/)
- [Cloudflare Workers 日志](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Render Blueprint 规范](https://render.com/docs/blueprint-spec)
- [Render Free 限制](https://render.com/docs/free)
