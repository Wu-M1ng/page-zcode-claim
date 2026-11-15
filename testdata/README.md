# testdata

真实流量的原样抓包，给解析器当回归样本用。

| 文件 | 抓的是什么 | 里面有什么值得记住的 |
| --- | --- | --- |
| `touch-1030-wk.json` | 10-30 的 `GET /api/v1/marketing/touch` 回复 | 一条 banner 投递：`banner.campaign_id` / `priority`，**`buttons[0]` 是「关闭」，`buttons[1]` 才是 `claim_zcode_plan`**；卡名、到期、权益挂在同一条 delivery 的 `banner.background.args.zcode_plan`（`ends_at` 是秒）；`success_popup` 里是客户端领取成功后给的可复制文案 |
| `client-configs-1107.json` | 11-07 的 `GET /api/v1/client/configs` 回复 | 安全验证场景：`configs.captcha` 的 `enabled` / `prefix` / `region` / `sceneId` |

两份文件原样取自 [magpie-community/plugins](https://github.com/magpie-community/plugins) 的 `packages/zcode/testdata/`，
MIT，Copyright (c) 2026 magpie-community contributors，未做修改。

用途：把 `ZCODE_CLAIM_BASE` 指向本地假上游，让假上游直接回这两份数据，就能在没有真实活动卡的情况下
跑通「解析 → 取票 → 领取 → 落记录」整条链路，见 README 的「自测」一节。
