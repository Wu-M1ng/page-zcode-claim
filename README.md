# page-zcode-claim · ZCode 领卡中心

magpie 的一个页面插件（个人项目，非 magpie 社区包）：把 ZCode（z.ai / 智谱）每个账号**能领的赠卡**列出来，点一下，用 ZCode 客户端自己那套
阿里云无痕验证取票，票到手立刻携票领取。

```text
账号行 ──「领取」──► 读营销 feed 拿 plan_id ──► 弹窗
                                                 ├ 自动无痕试一次
                                                 └ 不通就摆出官方组件，等你点滑块
                                                      └ 出票（≈280 字符）──► 立刻提交
                                                                              └ 结果就地显示
```

## 装

从仓库装（magpie 支持 git 地址）：

```sh
magpie plugin add https://github.com/<owner>/page-zcode-claim
```

或者本地路径 / 开发时直接指到目录：

```sh
magpie plugin add ./page-zcode-claim
```

也可以手动在 magpie 的 `~/.config/magpie/plugins/package.json` 里加 `"file:<本包路径>"`，再重启 magpie。
装完打开侧栏 Plugins › ZCode Claim。

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

## 一次领取会发生什么

```text
读可领卡  ─► 解析（按 plan_id 归并元数据）+ 算窗口状态
     │
     ├ 未开窗 / 已结束 ─► 直接 409，一个 claim 都不发（省掉 1005 / 1004）
     │
     ├ 今天还没报过 ─► 补报 app_launch + app_daily_active（一天一次）
     │
     └ 要验证 ─► 取票 ─► POST claim
                        │
                        └ 成功 ─► POST marketing/touch/action（回执）
                                  └ 复查一次 feed（只作备注）
```

**时间窗口。** `starts_at` / `ends_at` 一律按毫秒读（上游混着给秒），窗口三态：未开窗、可领、已结束。
未开窗的卡不发 claim，只告诉你「北京时间 X 开启」；上游没给时间就按可领处理。
判定用的是**上游的钟**：feed 里的 `server_time` 与本机对一下，偏差超过 30 秒就采信上游（本机时间不准也不会误判窗口）。

**营销回执。** 领取成功（含 1003）后向活动位回一条 `confirm`，再复查一次 feed。这两步都是备注：
失败不会推翻一次服务端已经确认的领取，失败原因写在下方记录里。

**活跃上报。** 官方客户端启动 / 日活时会报 `app_launch` 与 `app_daily_active`，运营侧据此发资格。
页面插件不是那个客户端，所以**每天自动补一轮**（北京时间 08:00–09:00 之间随机一分钟，
服务端定时器，页面不开也跑）；另外**第一次领取前**还会顺手补一次。同一账号按北京时间每天只报一次。
该接口不带 Authorization，身份取自 JWT 载荷里的用户标识。
上报**失败也算报过**（4xx 重试也救不回来，反复打只会把账号打成高频），原因写进记录；
真要补救用下面的手动端点，它不受开关与「今天已报」限制。

“随机一分钟”是用**北京日期字符串当种子**算出来的，不是 `Math.random()`：
magpie 重载插件很频繁，每次重启都重摇的话，一个总被重载的进程可能整天都等不到那一刻。
同一天怎么重启都是同一分钟；换一天才换一个时刻。每天只跑「今天还没报过」的号，
所以手动点过「活跃」的号不会一天报两次。

| 环境变量 | 默认 | 作用 |
| --- | --- | --- |
| `ZCODE_CLAIM_ACTIVATION` | `1` | 设为 `0` 关掉「点领取时顺带报」 |
| `ZCODE_CLAIM_AUTO_ACTIVE` | `1` | 设为 `0` 关掉「每天 08:00–09:00 定时报」（与上一项独立） |
| `ZCODE_CLAIM_APP_VERSION` | `3.18.0` | 客户端版本头（UA / `X-ZCode-App-Version` / 上报里的 `app_version` 同一个源） |
| `ZCODE_CLAIM_TZ` | 系统时区 | 上报里的 `client_timezone`，可强制成 `unknown` |
| `ZCODE_CLAIM_SCREEN` | `2560x1440` | 上报里的 `screen_resolution`（Node 里读不到屏幕尺寸） |

每个账号卡片右侧的「活跃」按钮可以随时手动补报一次（不受上面的开关与「今天已报」限制）。
报成功会变成「活跃 ✓」，失败是「活跃 ✗」（tooltip 带原因），下方记录里落一条「活跃事件」。
双击 / 浏览器重试不会把号打成高频：5 秒内的重复请求直接复用上一次结果。

命令行也能补（排查用）：

```sh
curl -s -X POST 'http://127.0.0.1:3527/api/activation?k=<页面口令>' \
  -H 'content-type: text/plain' -d '{"account":"zcode#你的账号"}'
```

## 顶栏上的「每日活跃」开关

它就是个开关，不用去碰环境变量：

- 小绿灯 + 「每日活跃 08:28」= 开，后面那串是**今天**排的时刻（每天换一个）。
- 「每日活跃 关」= 没在跑，点一下打开，点一下关。
- 「每日活跃 已锁」+ 置灰 = 环境变量 `ZCODE_CLAIM_AUTO_ACTIVE=0` 把定时锁死了，
  页面上解不开（这是故意的：那个 env 是给测试和“彻底安静”用的硬开关）。

开关状态写在 `<配置目录>/zcode-claim/settings.json`（0600，只有 `auto_active` 一个布尔值），
不在数据目录之外留痕。

### 跑完你看得见

服务端把上一轮写进 `zcode-claim/auto-active.json`（`last_run` / `day` / `ok` / `failed`）。
页面每 60 秒看一眼 `/api/settings`（**本地端点，不碰上游**），`auto_last` 变了就整页重画，
再弹一句「每日活跃：N 个账号已自动补报」；有失败时是「…M 个失败」且弹窗变红。
页面在后头不轮询，切回来时立刻看一次。

### 卡片上可能是「活跃 ✗」

按钮三态：

| 显示 | 含义 |
| --- | --- |
| `活跃` | 今天还没报过（自动还没到点 / 定时关了 / 手动没点） |
| `活跃 ✓` | 今天报过且**成功** |
| `活跃 ✗` | 今天报过但**失败**——一天只试一次不会重试，点一下手动重试 |

为什么会有 ✗：上报失败也照样标「今天已报」（4xx 重试救不回来，反复打只会把号
打成高频），所以只看「报过没」会把失败也显示成 ✓。接口里是两个字段：
`activation_today`（报过没）+ `activation_ok`（成没成），`activation_note` 带失败原因。

## 领取记录

面板只展示**最近 10 条**（顶部写「最近 10 条 · 共 N 条」）——它是“刚才发生了什么”，
不是审计台账。要看得多在地址上带 `?limit=200`（服务端把上限钉在 200）。

记录**不会随插件重载消失**：启动时从 `claim-log.jsonl` 尾部捞回 200 条进内存
（用 `open` + `fstat` + `readSync` 只读尾部 256 KiB，内存里永远只有这么多）。
以前 `recent` 纯内存，magpie 重载一次插件页面上的记录就全没了。

日志超过 2 MiB 会轮转一次（切成 `claim-log.jsonl.1`，只留一份备份），不会无限长下去。

自动活跃只在**全成功时写一条汇总**，有失败才逐条列；开关的切换不进记录——
那会把真正要看的领取记录从 10 条的窗口里挤出去。

## 「领到了」和「账单里看得见」是两件事

`billing/preview` 只列**已生效**的卡。实测有 23:00 才生效的卡：领完之后账单里是空的，
`/api/plans` 也是空的，页面上只剩一句「当前没有可领的卡」——于是查的人以为领取失败。

所以 feed 为空时页面会先看**今天领到过没有**：`/api/accounts` 每个账号带一个
`claimed_today`（服务端从 `claim-log.jsonl` 数今天 `ok:true` 的条数），有就直接说
「今天这个号已领到 N 张……要是账单里还看不到，多半是没到生效时间——不是没领到」。

不显示具体「几点生效」是有意的：feed 里的 `starts_at` 是**领取窗口的开始**，
能领的时候它必然已经过去，拿它算「还没生效」永远是 0。宁可只报事实，不猜时刻。

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
| `not_open` / `expired` | 本地时间窗守卫：没开窗 / 已结束，**一个 claim 都不发**（只对刚读过列表的卡生效） |
| 回包读不懂 | 只算「没确认」，绝不当成功 |

## 踩过的坑（改代码前先看）

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
4. **领取按钮不是 `buttons[0]`**。真实抓包里 `banner.buttons[0]` 是「关闭」，`claim_zcode_plan`
   在第二个，卡名与权益挂在同一条 delivery 的 `banner.background.args.zcode_plan`（`ends_at` 是**秒**）。
   只看第一个按钮就会得出「没有可领卡」的假结论。
5. **拒收假票**。SDK 初始化失败时仍会 fire 一个 76 字符的 `success`，内容只有 `{certifyId, sceneId, isSign}`；
   真票约 280 字符且带 `securityToken`。`lib/server.mjs` 的 `ticketOf()` 会挡掉假票，否则白烧一次领取机会。
6. **一条 delivery 里可能有好几张卡**。元数据按 `plan_id` 归并，不能「第一个 `zcode_plan` 套给所有卡」——
   旧写法会让第二张卡顶着第一张卡的名字、到期时间和权益。`testdata/touch-multi-plan.json` 是这个场景的回归用例。
7. **窗口不能用本机钟判**。虚拟机、双系统、久未同步的机器都会偏；feed 每次都带 `server_time`，
   用它算偏差再判 `starts_at` / `ends_at`（`clockSkew()`，偏差超 30 秒才采信）。
   活跃上报同理：`device_mid` 必须落盘（`zcode-claim/device.json`），每次重启换一个号等于每次都是新设备。
8. **全屏遮罩的 `z-index` 不能高过验证码**。阿里云 SDK 的 popup 容器实测写死 `z-index: 10000001`
   （`AliyunCaptcha.js` 里唯一一处 z-index）。弹窗容器之前是 `2147483000`，高一个数量级，
   验证码就被盖在遮罩底下——**用户能看见弹窗、能看见提示，就是点不到那个滑块**。现在是 `999999`。
9. **超时不能只兑现外层 promise**。`openClaimDialog` 的主循环在 `await solve()` 上；只 resolve 外层
   `outcome` 的话，主循环不会继续，`finally` 不跑，全屏遮罩与 `state.busy` 就永久留着——
   症状是「这个号一直显示领取中，别的按钮也点不动」。所有退出路径（取消 / 超时 / 页面卸载）
   必须收敛到同一个 `teardown()`，并把那个悬挂的 resolve 一并兑现。
10. **锁不要挂在会被替换的节点上**。`refreshCard()` 是整张卡片 `replaceWith`，锁在 `button` 上
    等于锁在了游离节点上，新渲染的按钮永远是「未锁」的样子。锁挂在 `#accounts` 容器的 class 上，
    容器不会被替换。
11. **按钮文案和请求参数要对得上**。按钮写「再查一次」而点击传 `force=false`，点下去读的还是缓存，
    用户看到的就是「再查一次也没用」。按钮带 `data-force`，文案是「再查一次」就一定发 `force=1`。
12. **深浅色兜底用系统色，不要写死十六进制**。`.toast` 原来背景兜底是 `#2a2a2a` 且没设 `color`，
    浅色窗口下就是「深灰底 + 黑字」，看上去就是一块黑。用 `Canvas` / `CanvasText`，
    和 `.zclaim-dialog` 的面板同一套变量。
13. **只能装在内存里的东西，重启就没了**。`recent` 原来纯内存，magpie 重载一次插件
    （很频繁）页面上「领取记录」就整页空——用户看到的是「记录被自动刷新掉了」。
    现在启动时从 `claim-log.jsonl` 尾部捞回 200 条（只读尾 512 KiB，不解析整个文件）。
    半截行（进程被杀时写了半个）直接跳过，不要 try 一次就整份放弃。
14. **记录面板是 10 条的窗口，不是审计台账**。高频但不重要的东西（开关切换、
    自动活跃的每一步）一律不进 `claim-log`：一轮自动活跃写 5 条就能把真正要看的
    领取记录挤出去。自动活跃改成「全成功一条汇总，有失败才逐条」。
    「今日已领」也不能由页面从这 10 条里数——让服务端算 `claimed_today`。

## 为什么取票可能需要你点一下

阿里云的无痕验证会按设备/出口判风险。同一台机器上，自动 `startTracelessVerification()` 常被判 `F001`（风控拒绝），
而人工点一下滑块就能出真票。所以弹窗**自动试一次，不通就停下来等你**，不自动重试、不循环。

## 上游异常怎么处理

判断口径参考了社区包 `@magpie-community/opencode-zcode-auth`（那个是社区包，本包不是）：


**「没有」和「读不懂」严格分开**。`deliveries` 字段缺失 = 上游确实没有投递；字段存在但不是数组、或者整条 feed 结构不对 = **读不懂**，页面会说「上游回包读不懂，没确认是否真的没有卡」，不会冒充「当前没有可领的卡」。这两种在 `unread` 里也各带原因。

**安全验证配置三态**。`client/configs` 里 `captcha` 缺失 = 上游不要验证；不是对象 = **未知**；其余一律按「要验证」处理。未知时一个 claim 都不发（没票的 claim 只会白吃一次 3007），页面提示先取票。

**限流的本地 hold**。收到 429 / `code 3002` 之后，这个账号在等待期内不再发任何请求：上游给了 `Retry-After` 就按它等（上限 6 小时），没给就从 30 分钟起翻倍。`code 3012`（风控封号）直接停 6 小时。hold 只在进程内存里，重启 magpie 即忘，页面显示到点时间。

**空结果 30 分钟节流**。查过一次是空的，30 分钟内再点直接回上次的答案（上游的赠卡是白天不定时投放的，狂点只会把账号打进限流）。要立刻再查，页面上有「仍要查询」。

**边缘防火墙**。本机 IP 被厂商的边缘防火墙拦时，上游回的是 HTML 拦截页而不是 JSON。这种情况识别为「IP 被拦」并说清楚，不当成解析失败。

## 票据约束

单次使用、90 秒内有效（`F008` / `F018` / `F019` = 重放或过期）。因此：一卡一票、出票即提交、票不落盘、不进日志。

## 营销 feed 没有轮询

营销 feed 不轮询：只在点「领取」/「刷新」时才读，避免把账号打进 `429` / `F010` / `F011`。
唯一常驻的定时器是**每日自动活跃**（每天一次，一天一个号最多一条），它打的是活跃上报接口，
不是 feed，也不会因为读得勤而触发限流。`ZCODE_CLAIM_AUTO_ACTIVE=0` 可以彻底安静下来。

## 发布（自己的仓库 / 自己的 npm）

这是个人项目，**不属于 magpie 社区**，所以发布也只走自己的仓库。上传前把三处身份改掉：

```jsonc
// package.json
"name": "page-zcode-claim",          // 或你自己的 scope：@<你的npm名>/page-zcode-claim
"author": "<你的名字>",
"repository": { "type": "git", "url": "git+https://github.com/<owner>/page-zcode-claim.git" }
```

```text
// LICENSE 第 3 行
Copyright (c) 2026 <你的名字>
```

`magpie` 字段原样保留（magpie 靠它识别页面、`page.service`、选项和图标），`files` 也别动。
从仓库装的人不需要 npm 发布；要发布 npm 的话 `npm publish` 即可，包名不要用 `@magpie-community/*`
（那个 scope 不是你的）。

**不要**去改 `registry.json` 或加 `"community": true` —— 那是社区仓库的入口，只收社区自己的包。

## 安全

- 默认只监听 `127.0.0.1`（`bind` 可以改，见上）。`Host` 必须落在「本进程实际端口的 `127.0.0.1` / `localhost`」、
  「端口就是本进程监听端口」或「带 `x-forwarded-*` 头」三者之一，其余 403（挡 DNS 重绑定）。
- 页面框架是不透明来源，`Origin` 是字面量 `null`：API 一律要每次启动随机生成、只注入本实例 HTML 的页面口令。
- **插件不写凭据**：只读 `plugin-auth.json`，也没有任何接口接受页面提交的 jwt（早先那个导入通道已删掉）。
- 领取记录写在 `<配置目录>/zcode-claim/claim-log.jsonl`（0600），不含 jwt、不含票据。

## 独立调试

```sh
node lib/serve.mjs --port 3502                 # 打开 http://127.0.0.1:3502/ 即可，口令已注入页面
node lib/serve.mjs --port 3502 --key           # 需要命令行调接口时才把口令打出来
node lib/serve.mjs --port 3502 --host 0.0.0.0  # 让局域网/反代访问（调试服务器上的页面时用）
```

独立调试要 **Node ≥ 18**（用了 `AbortSignal.timeout`、`Array.at`、`??=`）。在 magpie 里跑的是它自己的
Bun 宿主，不受这条限制。

要把整条链路在没有真实活动卡的情况下跑一遍，用假上游：

```sh
ZCODE_CLAIM_BASE=http://127.0.0.1:3600 MAGPIE_CONFIG_DIR=./tmp-cfg node lib/serve.mjs --port 3502
```

`ZCODE_CLAIM_BASE` 只改上游基址，不改变任何领取语义；`MAGPIE_CONFIG_DIR` 让你用一份假账号，
不会碰真实登录信息，也不会写进真实的领取记录。

## 验证到哪一步

**实测过（真 Chromium + 真上游，用开发者本地的抓包样本和假上游跑回归）**：阿里云组件在 magpie 页面里出票（真票约 280 字符）；同一张卡
无票提交被上游回 `3007`、带真票提交通过验证闸门（回 `1001 target not found`，说明票被接受了）；
国内站（bigmodel）账号走同一套业务接口；magpie web / 反代下的 CSP 与 CORS；端口被占时的顺延。

**还没遇到**：真实的 `code 0` 领取成功 —— 写这段的时候营销 feed 里没有 `ZCODE GLOBAL BUILD` /
`ZCODE WEEKEND BUILD` 的卡。等有卡时第一次领取就能确认，`code 0` 与 `code 200` 都按成功处理。

**明确没做**：`1001` 时按卡名从新 feed 自动换 `plan_id` 重试；邀请奖励（`/api/v1/incentive/referral/summary`）
那条来源；jwt 过期自动续期（过期就显示「ZCode 登录已过期」，去 magpie 重新登录）。

## 目录

仓库里只有插件本体：开发时用的假上游、状态矩阵和真实抓包样本不随仓库发布。

```text
index.mjs           宿主入口 export default { id, server(input, options) }
lib/server.mjs      HTTP 服务、票据校验、路由、静态页面
lib/store.mjs       账号来源（plugin-auth.json 只读）
lib/zcode.mjs       上游四个接口：验证场景 / 营销 feed / 余额预览 / 携票领取
page/               带路页：把框架导航到服务（bridge 不可用时也不卡）
ui/                 真页面：账号列表、领取记录、取票弹窗
ui/sandbox-shim.js  cookie / localStorage 垫片（必须最先加载）
```
