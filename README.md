# @magpie-community/page-zcode-claim · ZCode 领卡中心

magpie 的一个页面插件：把 ZCode（z.ai / 智谱）每个账号**能领的赠卡**列出来，点一下，用 ZCode 客户端自己那套
阿里云无痕验证取票，票到手立刻携票领取。

```text
账号行 ──「领取」──► 读营销 feed 拿 plan_id ──► 弹窗
                                                 ├ 自动无痕试一次
                                                 └ 不通就摆出官方组件，等你点滑块
                                                      └ 出票（≈280 字符）──► 立刻提交
                                                                              └ 结果就地显示
```

## 装

```sh
magpie plugin add @magpie-community/page-zcode-claim
```

或在 magpie 的 `~/.config/magpie/plugins/package.json` 里加 `"file:<本包路径>"` 后重启 magpie。
打开侧栏 Plugins › ZCode Claim。

## 选项

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `port` | `3527` | 页面服务端口 |
| `bind` | `127.0.0.1` | 监听地址。默认只听本机回环；服务器 / Docker 里要让局域网浏览器打开时设成 `0.0.0.0` |

页面按 `magpie.page.service` 声明的端口启动服务。**声称的端口被占用时**：先原地重试一次（上一次的服务进程
常常还在退，等一秒它就走），还占着就顺着往后找最多 15 个端口，服务照常起来，日志里写明实际端口 ——
这时候请把选项改成那个端口，带路页只能按声明的端口跳。

端口按安装改：

```sh
magpie plugin options page-zcode-claim '{"port":3528}'   # 名字也可以是短名 page-zcode-claim
```

也可以编辑 magpie 配置目录下 `plugins.json` 里这一项的 `"options"`。改完重启插件（`on/off` 或重载）生效。

## 在服务器上打开（Docker、局域网、magpie web）

页面分两层：magpie 里的**带路页**（`page/`，跑在框架的 sandbox 里，策略是 `connect-src 'none'`，
不能 fetch、也不能探测）负责跳转；真正干活的**领卡中心**是插件服务提供的页面（自己的策略，
能 fetch、能开框架跑阿里云组件）。所以「跳到哪」这件事必须找对：

| 怎么打开 | 带路页跳向 | 要做什么 |
| --- | --- | --- |
| magpie 桌面窗口 | `http://127.0.0.1:3527/` | 什么都不用做 |
| 同机浏览器 / SSH 端口转发 | `http://127.0.0.1:3527/` | 什么都不用做 |
| 局域网 / 反代 | `http://<当前主机名>:3527/` | 把 `bind` 设成 `0.0.0.0`，并把 3527 放行（或经反代转发） |
| magpie web | magpie 给的服务地址（同源，最稳） | 什么都不用做；拿不到地址时按上面两行退 |

```sh
magpie plugin options page-zcode-claim '{"port":3527,"bind":"0.0.0.0"}'
```

两个已知会「看起来卡住」的场景，现在都会明说原因而不是干等：

- **页面是 https，服务是 http**：浏览器按混合内容拦掉跳转。带路页会直接说明，请改用运行 magpie 那台机器的窗口，或用 http 地址访问。
- **桥接不回**（服务器上没有窗口时 `magpie.ready` 可能永远不 resolve）：带路页里每个桥接调用都限时（900 ms / 600 ms），超时就按默认值继续跳，绝不把跳转押在桥上。

安全性没有因此放开：默认只听 `127.0.0.1`；`bind` 到其他地方时，API 仍要每次启动随机生成的页面口令，
`Host` 必须是「端口对得上」或带反代头，`Origin` 必须是页面自己的源。别把端口直接暴露到公网。

## 账号从哪来

1. **magpie 的登录**（首选）：读 `<配置目录>/plugin-auth.json` 里的 `zcode#*` 条目，解析 `refresh` 里的
   `jwt` / `device` / `key` / `plan`。只读，不写回 magpie 的文件。
2. **页面里粘贴**（兜底）：`{"zcode#name": {"type":"oauth","refresh":"{…}","accountId":"…"}}`，
   宿主给了 `client.auth.set` 就写进 magpie，否则落到 `<配置目录>/zcode-claim/accounts.json`（0600）。

保存后页面只看得到 email / 套餐 / 是否有效，**看不到 jwt 本体**；jwt 只在服务端用于请求上游。

## 领取语义（上游 code 直接映射）

| 上游 | 页面 |
| --- | --- |
| `code 0` | 已领取 |
| `code 1003` | 视为已领（幂等） |
| `code 1001` | 套餐不存在或已下架（多见于 plan_id 过期） |
| `code 1004` | 当前账号不可领取（常见于客户端版本头过期） |
| `code 200` | 同 `code 0`（上游有的接口用它表示成功） |
| `code 3007` | 安全验证未通过 → 换新票重试一次，仍失败则转人工 |
| `code 3012` | 账号被风控拦下 → 停手 6 小时，不再试 |
| `429` / `code 3002` | 请求过于频繁 → 停手，按 `Retry-After` 退避（见下） |
| 回包读不懂 | 只算「没确认」，绝不当成功 |

## 五个踩过的坑（改代码前先看）

0. **带路页不要 `await` 桥接**。`magpie.ready` 在没有窗口的场景（服务器、magpie web）可能**永远不 resolve**，
   于是页面永远停在「正在连接本地领卡服务…」——不是策略拦的，是自己等死的。桥接调用一律限时，
   语言先用 `navigator.language` 猜，超时就按默认值跳。

1. **CSP 里 `'self'` 和完整源一个都不能少**。页面框架是 `sandbox="allow-scripts"`，桌面窗口里 `'self'`
   可能什么都匹配不上，所以策略要写服务的完整源；而走 magpie web（局域网、Docker、反代）时，
   magpie 会把响应头里**每个 `'self'` 补成服务的真实地址**（`<meta>` 里的不补）。只写完整源的后果，
   在 web 模式下就是**样式全丢 + 脚本不执行**：页面只剩无样式的静态骨架，看着像「脚本没能启动」。
   `lib/server.mjs` 的 `cspFor()` 现在两者都写，并按请求的 `Host` / `x-forwarded-*` 再推一份源，
   所以 `Host`、`Origin` 的校验也跟着放宽到「页面自己的源」——反代下 API 才不会齐刷刷 403。
2. **CSP 必须放行 `*.aliyuncs.com`**。SDK 的上报域名是 `aliyuncs.com`（多一个 s），漏掉它的症状不是报错，
   而是「点开始验证没反应」——初始化被拦、实例建不起来。命中域名：`no8xfe.captcha-open.aliyuncs.com`、
   `*.captcha-open-b.aliyuncs.com`、`upload.captcha-open.aliyuncs.com`、`cloudauth-device-dualstack.cn-shanghai.aliyuncs.com`、
   `cn-shanghai.device.saf.aliyuncs.com`（脚本本身在 `o.alicdn.com` / `g.alicdn.com`）。
3. **页面必须垫 cookie / localStorage**。magpie 的页面框架是 `sandbox="allow-scripts"`，文档是 opaque origin，
   `document.cookie` 与 `localStorage` 都会抛 `SecurityError`；SDK 两样都用。`ui/sandbox-shim.js` 必须在
   SDK 之前加载（`ui/index.html` 里已排在 `app.js` 前）。
4. **拒收假票**。SDK 初始化失败时仍会 fire 一个 76 字符的 `success`，内容只有 `{certifyId, sceneId, isSign}`；
   真票约 280 字符且带 `securityToken`。`lib/server.mjs` 的 `ticketOf()` 会挡掉假票，否则白烧一次领取机会。

## 为什么取票可能需要你点一下

阿里云的无痕验证会按设备/出口判风险。同一台机器上，自动 `startTracelessVerification()` 常被判 `F001`（风控拒绝），
而人工点一下滑块就能出真票。所以弹窗**自动试一次，不通就停下来等你**，不自动重试、不循环。

## 上游异常怎么处理（和 `@magpie-community/opencode-zcode-auth` 同一套判断）

**「没有」和「读不懂」严格分开**。`deliveries` 字段缺失 = 上游确实没有投递；字段存在但不是数组、或者整条 feed 结构不对 = **读不懂**，页面会说「上游回包读不懂，没确认是否真的没有卡」，不会冒充「当前没有可领的卡」。这两种在 `unread` 里也各带原因。

**安全验证配置三态**。`client/configs` 里 `captcha` 缺失 = 上游不要验证；不是对象 = **未知**；其余一律按「要验证」处理。未知时一个 claim 都不发（没票的 claim 只会白吃一次 3007），页面提示先取票。

**限流的本地 hold**。收到 429 / `code 3002` 之后，这个账号在等待期内不再发任何请求：上游给了 `Retry-After` 就按它等（上限 6 小时），没给就从 30 分钟起翻倍。`code 3012`（风控封号）直接停 6 小时。hold 只在进程内存里，重启 magpie 即忘，页面显示到点时间。

**空结果 30 分钟节流**。查过一次是空的，30 分钟内再点直接回上次的答案（上游的赠卡是白天不定时投放的，狂点只会把账号打进限流）。要立刻再查，页面上有「仍要查询」。

**边缘防火墙**。本机 IP 被厂商的边缘防火墙拦时，上游回的是 HTML 拦截页而不是 JSON。这种情况识别为「IP 被拦」并说清楚，不当成解析失败。

## 自测用的真实样本

`testdata/touch-1030-wk.json`、`testdata/client-configs-1107.json` 是从真实流量里留下的原样抓包（10-30、11-07），解析器的回归就靠它们。用它们当假上游：

```sh
ZCODE_CLAIM_BASE=http://127.0.0.1:3600 MAGPIE_CONFIG_DIR=./tmp-cfg node lib/serve.mjs --port 3502
```

样本里有个细节值得记住：`banner.buttons[0]` 是「关闭」，领取按钮在第二个 —— 所以领取按钮必须遍历整条 delivery 去找，不能只看第一个。

## 票据约束

单次使用、90 秒内有效（`F008` / `F018` / `F019` = 重放或过期）。因此：一卡一票、出票即提交、票不落盘、不进日志。

## 没有轮询

插件不跑定时任务：营销 feed 由你点「领取」/「刷新」时才读，避免把账号打进 `429` / `F010` / `F011`。

## 发布

**提到社区仓库**（`@magpie-community/plugins`，放 `packages/page-zcode-claim`）：包名、`repository`
都不用改，推 `main` 触发版本发布，并在 `registry.json` 加一条：

```json
{
  "package": "@magpie-community/page-zcode-claim",
  "name": "ZCode Claim",
  "kind": "page",
  "community": true,
  "summary": {
    "en": "ZCode's gift plans, per account: what the marketing feed says you can claim, claimed with the Aliyun verification the ZCode app itself passes — you click the slider once, the ticket is used at once.",
    "zh": "ZCode 的赠卡，按账号列出来：营销 feed 说能领的都在这里，用 ZCode 客户端自己那套阿里云验证取票——你点一下滑块，票立刻用掉。"
  }
}
```

**发到自己的仓库/npm**：改 `name`（`@magpie-community/*` 这个 scope 不属于你）、`repository.url`、
`LICENSE` 里的版权人，其余不用动；`magpie` 字段原样保留，magpie 靠它识别页面。

## 安全

- 服务只监听 `127.0.0.1`，`Host` 只认本进程实际端口上的 `127.0.0.1` / `localhost`（挡 DNS 重绑定）。
- 页面框架是不透明来源，`Origin` 是字面量 `null`：API 一律要每次启动随机生成、只注入本实例 HTML 的页面口令。
- 领取记录写在 `<配置目录>/zcode-claim/claim-log.jsonl`（0600），不含 jwt、不含票据。

## 独立调试

```sh
node lib/serve.mjs --port 3502      # 打开 http://127.0.0.1:3502/ 即可，口令已注入页面
node lib/serve.mjs --port 3502 --key  # 需要命令行调接口时才把口令打出来
```

要把整条链路在没有真实活动卡的情况下跑一遍，用假上游：

```sh
ZCODE_CLAIM_BASE=http://127.0.0.1:3600 MAGPIE_CONFIG_DIR=./tmp-cfg node lib/serve.mjs --port 3502
```

`ZCODE_CLAIM_BASE` 只改上游基址，不改变任何领取语义；`MAGPIE_CONFIG_DIR` 让你用一份假账号，
不会碰真实登录信息，也不会写进真实的领取记录。

## 目录

```text
index.mjs           宿主入口 export default { id, server(input, options) }
lib/server.mjs      HTTP 服务、票据校验、路由、静态页面
lib/store.mjs       账号来源（plugin-auth.json 只读 / 本插件导入）
lib/zcode.mjs       上游四个接口：验证场景 / 营销 feed / 余额预览 / 携票领取
page/               带路页：把框架导航到 127.0.0.1:<port>
ui/                 真页面：账号列表、领取记录、导入、取票弹窗
ui/sandbox-shim.js  cookie / localStorage 垫片（必须最先加载）
```
