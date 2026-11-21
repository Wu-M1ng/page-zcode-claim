// ZCode 上游接口：验证场景、可领卡（营销 feed）、余额预览（兜底）、携票领取、
// 营销回执、活跃事件补报。
//
// 这里几条判定对齐 @magpie-community/opencode-zcode-auth 已经踩过的结论：
//  1) 版本头是硬门槛：旧版本头下 marketing/touch 回空 feed、领取回 1004（11-04 六账号齐刷刷 1004）。
//  2) 「读不懂」与「没有」严格分开：deliveries 缺失 = 确实没有；缺 deliveries 数组/结构不对 = 读不懂，
//     绝不降级成「没有卡」，否则用户会以为真没活动。
//  3) 安全验证配置用三态：缺失 = 不需要验证；不是对象 = 未知；其余按「要验证」处理。
//     未知时一个 claim 都不发 —— 没有票的 claim 只会白吃一次 3007。
//  4) 领取按钮不在 buttons[0]（真实样本里第一个是 close），所以要整条 delivery 递归找。
//
// 解析与窗口这块对齐 ZCode-Daily 的 zcode_cn_daily.py（同一套上游协议的另一份实现）：
//  - 元数据按 plan_id 归并，不是「每条 delivery 只留第一份」——一条 delivery 挂两张卡时，
//    旧写法会让第二张卡退化成裸 id、没有名字和到期时间（_walk_marketing_delivery）；
//  - starts_at / ends_at 一律归到毫秒（_epoch_seconds），秒/毫秒混着来会让 UI 自己算错；
//  - entitlements 结构化（_parse_entitlements），否则界面只能显示「有权益」但说不出是什么；
//  - 窗口三态 future / active / expired（plan_window_state），未开窗就不发 claim。
import { randomUUID } from 'node:crypto'
import { release } from 'node:os'

// 客户端版本号：UA / X-ZCode-App-Version / 配置查询 / 上报 body 全读这一个源，
// 四处必须同时变，所以只留一个入口。
//
// 取值优先级：
//   1. 环境变量 ZCODE_CLAIM_APP_VERSION —— 自测与回滚用，**设了就锁死**，插件选项改不动它
//      （和 ZCODE_CLAIM_AUTO_ACTIVE 的锁同一个道理：能远程/脚本改的东西不能被界面悄悄盖掉）；
//   2. 插件选项 app_version —— 页面「设置」里可改，像 port 一样；
//   3. 内置默认 DEFAULT_APP_VERSION。
const DEFAULT_APP_VERSION = '3.18.2'
// 只认 3.18.2 这种形态。版本号要拼进请求头，放任意字符串进去等于把脏数据甩给上游。
const VERSION_RE = /^\d{1,3}\.\d{1,3}(\.\d{1,3})?$/
const ENV_VERSION = (() => {
  const fromEnv = String(process.env.ZCODE_CLAIM_APP_VERSION || '').trim()
  return VERSION_RE.test(fromEnv) ? fromEnv : ''
})()
let appVersion = ENV_VERSION || DEFAULT_APP_VERSION

/** 当前实际使用的客户端版本号。 */
export const appVersionOf = () => appVersion
/** 环境变量是否把版本号锁死了（锁了之后插件选项不再生效）。 */
export const appVersionLocked = () => Boolean(ENV_VERSION)
/**
 * 设置客户端版本号（供插件选项调用）。
 * @returns {boolean} 是否被接受；被环境变量锁定、或格式不合法时返回 false
 */
export function setAppVersion(value) {
  if (ENV_VERSION) return false
  const text = String(value ?? '').trim()
  if (!VERSION_RE.test(text)) return false
  if (text === appVersion) return true
  appVersion = text
  // 版本变了，验证场景配置要重新取：scene_id 与 prefix 可能跟客户端版本走，
  // 沿用旧缓存会拿旧场景的票去提交，白烧一次领取。
  resetScene()
  return true
}
// marketing/touch 有最低版本要求，低于它就是空 feed —— 与其发一次注定空手而归的请求，
// 不如把原因说出来（脚本 MARKETING_MIN_APP_VERSION 的同一件事）。
const MIN_MARKETING_VERSION = '3.17.1'
// ZCODE_CLAIM_BASE 只在自测时用：指向本地假上游，就能在没有真实活动卡的情况下跑通整条链路。
const ZCODE = process.env.ZCODE_CLAIM_BASE || 'https://zcode.z.ai'
const uaOf = () => 'ZCode/' + appVersion

const platform = () => `${process.platform}-${process.arch}`

// 没拿到 device 时也要带一个：上游把缺这个头当参数错（真客户端的 anyDevice 是同一思路）。
// 但它必须「跨重启稳定」：活跃上报按 user_id + device_mid 认设备，每次重启换一个号
// 就等于每次都是一台新设备。服务端启动时用 setDeviceStore 注入一个按账号落盘的存取器。
const anyDevice = randomUUID()
let deviceStore = null
export function setDeviceStore(store) {
  deviceStore = store && typeof store.get === 'function' && typeof store.set === 'function' ? store : null
}
export const deviceOf = (account) => {
  const own = String(account?.device || '')
  if (own) return own
  const id = String(account?.id || '')
  if (id && deviceStore) {
    const saved = deviceStore.get(id)
    if (saved) return saved
    const fresh = randomUUID()
    deviceStore.set(id, fresh)
    return fresh
  }
  return anyDevice
}

// 上游只认客户端的两种界面语言（zh-CN / en-US），别的取值按 en-US 归
function clientLanguage() {
  let locale = ''
  try {
    locale = Intl.DateTimeFormat().resolvedOptions().locale || ''
  } catch { /* 拿不到就用默认 */ }
  return /^zh\b/i.test(locale) ? 'zh-CN' : 'en-US'
}

function headersFor(account, extra = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': uaOf(),
    'X-ZCode-App-Version': appVersion,
    'X-Platform': platform(),
    'X-Client-Language': clientLanguage(),
    'X-Device-Mid': deviceOf(account),
  }
  if (account?.jwt) headers.Authorization = 'Bearer ' + account.jwt
  return { ...headers, ...extra }
}

// 营销 feed 一侧的配套动作（touch/action、复查询）用的是极简头：脚本实测这一套可用，
// 也不带 UA / X-Platform —— 那两处是客户端「界面」的特征，feed 侧不参与判定。
function feedHeaders(account) {
  const headers = {
    'X-Client-Language': clientLanguage(),
    'X-ZCode-App-Version': appVersion,
    'X-Device-Mid': deviceOf(account),
  }
  if (account?.jwt) headers.Authorization = 'Bearer ' + account.jwt
  return headers
}

// 边缘防火墙（阿里云）会把整段 IP 拦掉，那时回的是 HTML 错误页而不是 JSON。
// 认出来是「本机 IP 被拦」，别报成「解析失败」。
const EDGE_HTML = /errors\.aliyun\.com|<html[\s>]/i

// 一条回包能读多少。ModelScope 那边的先例是 256KiB；这里营销 feed 比它大，但也远小于 4MiB。
// 超限就按「读不懂」处理，绝不让一个错误页把宿主的堆吃满。
const MAX_BODY = 4 * 1024 * 1024

async function readJSON(response) {
  const declared = Number(response.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > MAX_BODY) {
    try { await response.body?.cancel?.() } catch { /* 已经没人读了 */ }
    return { status: response.status, retryAfter: '', body: '', edge: false, tooLarge: declared }
  }
  const text = await response.text()
  if (text.length > MAX_BODY) {
    return { status: response.status, retryAfter: '', body: '', edge: false, tooLarge: text.length }
  }
  let body = text.slice(0, 600)
  try {
    body = JSON.parse(text)
  } catch { /* 保持文本，下面按 edge / unreadable 判定 */ }
  const edge = typeof body === 'string' && EDGE_HTML.test(body)
  return { status: response.status, retryAfter: response.headers.get('retry-after') || '', body, edge }
}

async function postJSON(url, payload, headers = {}, timeoutMs = 15_000) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  })
  return readJSON(response)
}

export function jwtExpired(jwt) {
  const payload = String(jwt || '').split('.')[1]
  if (!payload) return false
  try {
    const parsed = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    return Number.isFinite(parsed.exp) ? parsed.exp * 1000 <= Date.now() : false
  } catch {
    return false
  }
}

// ---- 速率限制的本地 hold --------------------------------------------------------
// 上游 429 / code 3002 之后，同一个账号在等待期内不再发请求：Retry-After 原样采纳（上限 6 小时），
// 没有就 30 分钟起翻倍。hold 只在本进程内存里，magpie 重启即忘。
const RECHECK_MS = 30 * 60_000
const RATE_LIMIT_MAX_MS = 6 * 60 * 60_000
const holds = new Map() // accountId -> { ms, until, message }

export function holdOf(accountId) {
  const held = holds.get(accountId)
  if (!held) return null
  if (Date.now() >= Date.parse(held.until)) {
    holds.delete(accountId)
    return null
  }
  return held
}

export function noteRateLimit(accountId, saidMs, message) {
  const last = holds.get(accountId)?.ms ?? 0
  const want = saidMs > 0 ? saidMs : Math.max(RECHECK_MS, last * 2)
  const ms = Math.min(RATE_LIMIT_MAX_MS, want)
  const held = { ms, until: new Date(Date.now() + ms).toISOString(), message }
  holds.set(accountId, held)
  return held
}

export function clearRateLimit(accountId) {
  holds.delete(accountId)
}

// 「查过一次是空的」也记一笔：30 分钟内再点就直接回上次的答案，别把账号打进限流。
const emptyUntil = new Map() // accountId -> ISO 时间
export const emptyUntilOf = (accountId) => {
  const until = emptyUntil.get(accountId)
  if (!until) return null
  // 过期就地删：这个 Map 只进不出的话，删掉的账号会一直留着一条
  if (Date.now() >= Date.parse(until)) {
    emptyUntil.delete(accountId)
    return null
  }
  return until
}
export const noteEmpty = (accountId) => {
  const until = new Date(Date.now() + RECHECK_MS).toISOString()
  emptyUntil.set(accountId, until)
  return until
}
export const clearEmpty = (accountId) => emptyUntil.delete(accountId)

// ---- 小工具 --------------------------------------------------------------------
const strOf = (value) =>
  typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''

// 上游的 id 会进 URL 路径、请求体和日志，只收「干净的标识」：非空、不超长、没有控制字符。
function safeId(value, limit = 256) {
  const text = strOf(value)
  if (!text || text.length > limit) return ''
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) < 32) return ''
  return text
}

// 秒 / 毫秒 / 浮点一律归到毫秒，非正数 → null。
// 1e12 毫秒是 2001 年，秒级时间戳永远到不了这个量级，所以这个分界是安全的。
export function epochMs(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return null
  return number < 1e12 ? Math.round(number * 1000) : Math.round(number)
}

// 权益：字段名上游 snake / camel 混用（show_name / showName），两种都读。
export function entitlementsOf(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const name = strOf(entry.show_name ?? entry.showName ?? entry.name)
    if (!name) continue
    out.push({
      name,
      unit: strOf(entry.unit_type ?? entry.unitType ?? entry.unit),
      grant: Number(entry.grant_units ?? entry.grantUnits ?? entry.grant) || 0,
      period: strOf(entry.period),
    })
  }
  return out
}

// ---- 版本门槛 ------------------------------------------------------------------
// 「3.18.0」→ [3,18,0]；不是纯点分数字就是 null（不拿一个读不懂的版本去比大小）。
function versionTuple(value) {
  const text = String(value || '').trim().toLowerCase().replace(/^v/, '').split('-')[0]
  if (!text) return null
  const numbers = []
  for (const part of text.split('.').slice(0, 3)) {
    if (!/^\d+$/.test(part)) return null
    numbers.push(Number(part))
  }
  while (numbers.length < 3) numbers.push(0)
  return numbers
}

export function versionAtLeast(value, minimum) {
  const current = versionTuple(value)
  const required = versionTuple(minimum)
  if (!current || !required) return false
  for (let i = 0; i < 3; i += 1) {
    if (current[i] !== required[i]) return current[i] > required[i]
  }
  return true
}

// ---- 验证场景 ----------------------------------------------------------------
// 匿名接口，10 分钟缓存；场景改版后旧 sceneId 会一直失败，所以要过期重取。
const SCENE_TTL_MS = 10 * 60 * 1000
let sceneCache = { at: 0, value: null, loading: null }

export async function scene(account, { force = false } = {}) {
  if (!force && sceneCache.value && Date.now() - sceneCache.at < SCENE_TTL_MS) return sceneCache.value
  if (sceneCache.loading) return sceneCache.loading
  sceneCache.loading = (async () => {
    const url = `${ZCODE}/api/v1/client/configs?app_version=${appVersion}&platform=${platform()}`
    const response = await fetch(url, { headers: headersFor(account), signal: AbortSignal.timeout(15000) })
    const { status, body, edge } = await readJSON(response)
    if (edge) return { unknown: true, why: '本机 IP 被厂商边缘防火墙拦，安全验证配置读不到' }
    if (status !== 200) throw new Error(`验证场景配置请求失败（HTTP ${status}）`)
    const captcha = body?.data?.configs?.captcha
    // 三态：没有这段配置 = 上游不要验证（客户端也是这么读）
    if (captcha == null) return cacheScene({ enabled: false })
    // 结构不对 = 未知：不发任何 claim，等下一轮
    if (typeof captcha !== 'object' || Array.isArray(captcha)) {
      return { unknown: true, why: '上游的安全验证配置结构不对，先不提交领取' }
    }
    if (captcha.enabled === false) return cacheScene({ enabled: false })
    const region = String(captcha.region || '')
    const sceneId = String(captcha.sceneId || '')
    const prefix = String(captcha.prefix || '')
    if ((region !== 'cn' && region !== 'sgp') || !sceneId || !prefix) {
      return { unknown: true, why: '上游的安全验证场景不完整，先不提交领取' }
    }
    return cacheScene({ enabled: true, scene_id: sceneId, region, prefix })
  })().catch((error) => {
    sceneCache.loading = null
    throw error
  })
  return sceneCache.loading
}

function cacheScene(value) {
  sceneCache = { at: Date.now(), value, loading: null }
  return value
}

export function resetScene() {
  sceneCache = { at: 0, value: null, loading: null }
}

// ---- 可领卡：解析 --------------------------------------------------------------
// 营销 feed：deliveries[].banner|popup 里的 claim_zcode_plan 按钮才是「能领的卡」。
// 套餐元数据（名字、有效期、权益）挂在同一条 delivery 的 zcode_plan 上，位置不固定，所以整条递归找。
// 真实抓包里 buttons[0] 是 close，领取按钮在第二个 —— 别只看第一个。
//
// 元数据按 plan_id 归并：一条 delivery 里挂两张卡时（第一张带 zcode_plan、第二张只有 id），
// 「只留第一份」会让第二张退化成裸 id。这里每个节点都当候选，缺元数据的用 id 兜底。
const MAX_DEPTH = 12
const MAX_NODES = 4096
const MAX_DELIVERIES = 32

function planOf(raw, defaultPriority) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const planId = safeId(raw.plan_id ?? raw.planId)
  if (!planId) return null
  const priority = Number.isFinite(Number(raw.priority)) ? Number(raw.priority) : defaultPriority
  return {
    plan_id: planId,
    name: strOf(raw.name) || planId,
    description: strOf(raw.description),
    priority,
    starts_at: epochMs(raw.starts_at ?? raw.startsAt),
    ends_at: epochMs(raw.ends_at ?? raw.endsAt),
    entitlements: entitlementsOf(raw.entitlements),
    campaign_ids: [],
    sources: ['marketing'],
  }
}

function blankPlan(planId, priority) {
  return {
    plan_id: planId,
    name: planId,
    description: '',
    priority,
    starts_at: null,
    ends_at: null,
    entitlements: [],
    campaign_ids: [],
    sources: ['marketing'],
  }
}

// 只补缺、不去坏：名字为空或就是 id 时才补；priority 取大；时间戳缺才补；权益空才补；来源与 campaign 取并集。
export function mergePlan(into, incoming) {
  if (!into.name || into.name === into.plan_id) into.name = incoming.name || into.name
  if (!into.description) into.description = incoming.description || ''
  into.priority = Math.max(Number(into.priority) || 0, Number(incoming.priority) || 0)
  if (into.starts_at == null && incoming.starts_at != null) into.starts_at = incoming.starts_at
  if (into.ends_at == null && incoming.ends_at != null) into.ends_at = incoming.ends_at
  if ((!into.entitlements || !into.entitlements.length) && incoming.entitlements?.length) {
    into.entitlements = incoming.entitlements.map((entry) => ({ ...entry }))
  }
  if (!Array.isArray(into.campaign_ids)) into.campaign_ids = []
  for (const campaign of incoming.campaign_ids || []) {
    if (campaign && !into.campaign_ids.includes(campaign)) into.campaign_ids.push(campaign)
  }
  if (!Array.isArray(into.sources)) into.sources = []
  for (const source of incoming.sources || []) {
    if (source && !into.sources.includes(source)) into.sources.push(source)
  }
  return into
}

export function plansOf(data) {
  // server_time 用来校正本机时钟偏差：窗口判断不该由一台钟不准的机器决定
  const stamp = data && typeof data === 'object' && !Array.isArray(data) ? epochMs(data.server_time) : null
  const empty = { plans: [], unknown: false, not_deployed: false, server_time: stamp }
  // 三态：deliveries 缺失 = 确实没有；不是数组 / 超上限 = 读不懂
  if (data == null) return { plans: [], unknown: false, not_deployed: false, server_time: null }
  if (typeof data !== 'object' || Array.isArray(data)) return { plans: [], unknown: true, not_deployed: false, server_time: null }
  if (data.deliveries == null) return empty
  if (!Array.isArray(data.deliveries)) return { plans: [], unknown: true, not_deployed: false, server_time: stamp }
  if (data.deliveries.length > MAX_DELIVERIES) return { plans: [], unknown: true, not_deployed: false, server_time: stamp }

  const found = []
  for (const delivery of data.deliveries) {
    if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) continue
    const defaultPriority = Number.isFinite(Number(delivery.priority)) ? Number(delivery.priority) : 0
    const metadata = new Map() // plan_id -> plan
    const ids = []
    let popup = ''
    let budget = MAX_NODES
    const seen = new WeakSet()

    const remember = (plan) => {
      if (!plan) return
      const existing = metadata.get(plan.plan_id)
      if (existing) mergePlan(existing, plan)
      else metadata.set(plan.plan_id, plan)
    }

    const walk = (node, depth) => {
      if (!node || typeof node !== 'object') return
      if (depth > MAX_DEPTH || budget <= 0) return
      if (seen.has(node)) return
      seen.add(node)
      budget -= 1
      if (!Array.isArray(node)) {
        // 任何带 plan_id 的节点都是候选元数据；zcode_plan 再单独认一次（两层都可能在）
        remember(planOf(node, defaultPriority))
        remember(planOf(node.zcode_plan, defaultPriority))
        // 两种领取按钮形态：动作对象自己带 type，或包在 node.action 里
        for (const action of [node, node.action]) {
          if (!action || typeof action !== 'object' || action.type !== 'claim_zcode_plan') continue
          const id = safeId(action.args?.plan_id)
          if (id && !ids.includes(id)) ids.push(id)
        }
        // 领取成功后客户端给的那段可复制文案，也在 feed 里
        if (!popup && node.type === 'copy_text' && typeof node.args?.text === 'string') popup = node.args.text
      }
      for (const key of Object.keys(node)) walk(node[key], depth + 1)
    }
    walk(delivery, 0)

    const campaign = safeId(delivery.campaign_id)
    for (const id of ids) {
      const meta = metadata.get(id)
      const plan = meta
        ? {
          ...meta,
          entitlements: meta.entitlements.map((entry) => ({ ...entry })),
          campaign_ids: [...meta.campaign_ids],
          sources: [...meta.sources],
        }
        : blankPlan(id, defaultPriority)
      if (campaign && !plan.campaign_ids.includes(campaign)) plan.campaign_ids.push(campaign)
      found.push({
        plan_id: id,
        name: plan.name || id,
        description: plan.description,
        priority: plan.priority,
        starts_at: plan.starts_at,
        ends_at: plan.ends_at,
        entitlements: plan.entitlements,
        campaign_ids: plan.campaign_ids,
        // 向后兼容：页面和日志一直读单个 campaign_id
        campaign_id: plan.campaign_ids[0] || campaign || '',
        sources: plan.sources,
        position: strOf(delivery.resource_position),
        popup,
      })
    }
  }
  const seenIds = new Set()
  return {
    plans: found.filter((plan) => (seenIds.has(plan.plan_id) ? false : seenIds.add(plan.plan_id))),
    unknown: false,
    not_deployed: false,
    server_time: stamp,
  }
}

// seq 是 ZCode 自己的 feed 计数，仅供服务端日志定位，不影响投放判断；一次刷新只发一次。
let touchSeq = 0

export async function marketingPlans(account) {
  if (!versionAtLeast(appVersion, MIN_MARKETING_VERSION)) {
    // 版本不够就是空 feed，不用发这一次：把原因说出来比「没有卡」诚实
    return {
      plans: [], unread: [], unknown: false, rate: false, retryAfter: '', status: 0, not_deployed: false,
      server_time: null,
      skipped: `客户端版本 ${appVersion} 低于营销 feed 的最低版本 ${MIN_MARKETING_VERSION}`,
    }
  }
  const url = `${ZCODE}/api/v1/marketing/touch?seq=${touchSeq++}`
  let response
  try {
    response = await fetch(url, { headers: headersFor(account), signal: AbortSignal.timeout(20000) })
  } catch (error) {
    return {
      plans: [], unread: [`营销 feed 请求失败：${error?.message || error}`], unknown: true,
      rate: false, retryAfter: '', status: 0, not_deployed: false, server_time: null,
    }
  }
  const { status, body, retryAfter, edge, tooLarge } = await readJSON(response)
  if (tooLarge) {
    return {
      plans: [], unread: [`营销 feed 响应过大（${tooLarge} 字节）`], unknown: true,
      rate: false, retryAfter, status, not_deployed: false, server_time: null,
    }
  }
  const unread = []
  if (edge) unread.push('本机 IP 被厂商边缘防火墙拦（回的是 HTML 拦截页）')
  // 接口没部署是「今天没有活动位」，不是错误：和「空 feed」分开报，别让用户以为读坏了
  if (status === 404 && !edge) {
    return { plans: [], unread: [], unknown: false, rate: false, retryAfter, status, not_deployed: true, server_time: null }
  }
  const code = body && typeof body === 'object' ? Number(body.code) : NaN
  const failed = Boolean(body && typeof body === 'object' && body.success === false)
  if (status !== 200 && !edge) unread.push(`营销 feed HTTP ${status}`)
  // code 只有 0 算成功（200 是上游少数接口的老写法，单独白名单）；success=false 同样算失败
  if (Number.isFinite(code) && code !== 0 && code !== 200) unread.push(strOf(body?.msg) || `营销 feed code ${code}`)
  if (failed) unread.push(strOf(body?.msg) || '营销 feed 回 success=false')
  const rate = status === 429 || code === 3002
  const unreadable = unread.length > 0 && (edge || Number.isFinite(code) || failed)
  const parsed = unreadable ? { plans: [], unknown: true } : plansOf(body?.data)
  if (parsed.unknown) unread.push('营销 feed 的结构读不懂')
  return {
    plans: parsed.plans,
    unread,
    unknown: parsed.unknown,
    rate,
    retryAfter,
    status,
    not_deployed: false,
    server_time: parsed.server_time || null,
  }
}

// 余额预览是备用来源（3.17 客户端只读 feed，这里通常为空），只在 feed 空或读不懂时用一次。
export async function billingPlans(account) {
  const url = `${ZCODE}/api/v1/zcode-plan/billing/preview?app_version=${appVersion}&platform=${platform()}`
  let response
  try {
    response = await fetch(url, { headers: headersFor(account), signal: AbortSignal.timeout(20000) })
  } catch (error) {
    return { plans: [], unread: [`余额预览请求失败：${error?.message || error}`], status: 0 }
  }
  const { status, body, edge, tooLarge } = await readJSON(response)
  if (tooLarge) return { plans: [], unread: [`余额预览响应过大（${tooLarge} 字节）`], status }
  if (edge) return { plans: [], unread: ['余额预览被边缘防火墙拦'], status }
  if (status === 404) return { plans: [], unread: [], status, not_deployed: true }
  // 401 是「这个号的登录态没了」，和「没有卡」是两件事
  if (status === 401) return { plans: [], unread: ['登录态已失效（余额预览 HTTP 401）'], status, expired: true }
  const raw = Array.isArray(body?.data?.plans) ? body.data.plans : []
  const plans = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const planId = safeId(item.plan_id ?? item.planId)
    if (!planId) continue
    plans.push({
      plan_id: planId,
      name: strOf(item.name) || planId,
      description: strOf(item.description),
      priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : 0,
      starts_at: epochMs(item.starts_at ?? item.startsAt),
      ends_at: epochMs(item.ends_at ?? item.endsAt),
      entitlements: entitlementsOf(item.entitlements),
      campaign_ids: [],
      campaign_id: '',
      sources: ['billing'],
      position: '',
      popup: '',
    })
  }
  return { plans, unread: status === 200 ? [] : [`余额预览 HTTP ${status}`], status }
}

export async function plans(account) {
  const feed = await marketingPlans(account).catch((error) => ({
    plans: [], unread: [String(error?.message || error)], unknown: true, rate: false, status: 0, not_deployed: false,
  }))
  let preview = { plans: [], unread: [] }
  // 只在 feed 没给出任何卡、或者接口根本没部署的时候才问预览，少发一次没用的请求
  if ((!feed.plans.length && !feed.rate) || feed.not_deployed) {
    preview = await billingPlans(account).catch((error) => ({ plans: [], unread: [String(error?.message || error)] }))
  }
  const byId = new Map()
  for (const plan of [...feed.plans, ...(preview.plans || [])]) {
    const id = String(plan.plan_id || '').trim()
    if (!id) continue
    const incoming = { ...plan, plan_id: id, name: String(plan.name || id) }
    const existing = byId.get(id)
    if (!existing) {
      byId.set(id, {
        ...incoming,
        campaign_ids: [...(plan.campaign_ids || [])],
        sources: [...(plan.sources || [])],
      })
      continue
    }
    mergePlan(existing, incoming)
  }
  const out = [...byId.values()]
  // 上游自己的钟永远比本机准：本机偏了就会误判窗口（把可领的挡住，或白吃一个 1005）。
  // 只采信 feed 的 server_time；拿不到就按本机算。
  const skew = clockSkew(feed.server_time, Date.now())
  const now = Date.now() + skew
  for (const plan of out) {
    plan.state = windowState(plan, now)
    if (!plan.campaign_id) plan.campaign_id = plan.campaign_ids[0] || ''
    if (!plan.name) plan.name = plan.plan_id
  }
  // 优先级高的排前面；同优先级别乱序
  out.sort((a, b) => (b.priority || 0) - (a.priority || 0))
  const unread = [...feed.unread, ...(preview.unread || [])]
  const sourceNotes = []
  if (feed.skipped) sourceNotes.push(feed.skipped)
  if (feed.not_deployed) sourceNotes.push('营销 feed 接口未部署（活动位今天没有投放）')
  if (preview.not_deployed) sourceNotes.push('余额预览接口未部署')
  return {
    plans: out,
    unread,
    unknown: Boolean(feed.unknown) && !out.length,
    rate_limited: Boolean(feed.rate),
    retry_after: feed.retryAfter || '',
    not_deployed: Boolean(feed.not_deployed) && Boolean(preview.not_deployed || !preview.plans?.length),
    expired_signin: Boolean(preview.expired),
    source_notes: sourceNotes,
    // 页面拿这个值跟本机钟对一下，就知道「未开窗」是不是本机时间错了
    skew_ms: skew,
  }
}

// ---- 窗口判断 ----------------------------------------------------------------
// 本机钟可能不准（虚拟机、双系统、久未同步），而窗口是绝对时间戳的比较。
// 上游每次都在 feed 里给 server_time，用它算偏差；只有偏差超过 30 秒才采信，
// 免得把网络延迟与秒级截断当成时钟错。
export function clockSkew(serverTime, now = Date.now()) {
  if (serverTime == null) return 0
  const delta = Number(serverTime) - Number(now)
  if (!Number.isFinite(delta)) return 0
  return Math.abs(delta) > 30_000 ? Math.round(delta) : 0
}

// starts_at / ends_at 都是绝对时间戳，所以时区只影响「怎么念给用户听」，不影响判定。
// 上游没给时间 = 默认可领：宁可让用户点一次，也不因为一个空字段把真能领的卡拦住。
export function windowState(plan, now = Date.now()) {
  const starts = plan?.starts_at
  const ends = plan?.ends_at
  if (starts != null && now < starts) return 'future'
  if (ends != null && now >= ends) return 'expired'
  return 'active'
}

export function formatBeijing(ms) {
  const at = Number(ms)
  if (!Number.isFinite(at) || at <= 0) return ''
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(at))
  } catch {
    return new Date(at).toISOString()
  }
}

// ---- 领取 --------------------------------------------------------------------
// 票走两个头：Param 是票本体，Region 是场景地域。票单次、90 秒内有效。
export async function claim(account, planId, ticket) {
  // 场景没开（enabled=false）时上游不要票，这时不带验证头，直接提交
  const extra = ticket?.param
    ? { 'X-Aliyun-Captcha-Verify-Param': ticket.param, 'X-Aliyun-Captcha-Verify-Region': ticket.region || 'cn' }
    : {}
  const response = await fetch(`${ZCODE}/api/v1/zcode-plan/billing/claim`, {
    method: 'POST',
    headers: headersFor(account, extra),
    body: JSON.stringify({ plan_id: planId }),
    signal: AbortSignal.timeout(25000),
  })
  return readJSON(response)
}

// ---- 营销回执 ----------------------------------------------------------------
// 客户端领完会给活动位回一条 confirm，运营侧据此把这次投放标成已领取。不做不影响「已到账」，
// 但活动位会一直挂着、统计也不算这一次。
// 失败不重试第二次以外的任何东西：它是锦上添花，不能把一次成功的领取拖成失败。
const marketingOk = (result) =>
  result.status >= 200 && result.status < 300 && Number(result.body?.code) === 0 && result.body?.success !== false

export async function confirmClaim(account, campaignIds, { timeoutMs = 8000 } = {}) {
  const unique = []
  for (const raw of Array.isArray(campaignIds) ? campaignIds : []) {
    const id = safeId(raw)
    if (id && !unique.includes(id)) unique.push(id)
  }
  if (!unique.length) return { ok: false, skipped: 'no_campaign', message: '这张卡没有 campaign_id，不用回执' }

  const errors = []
  let confirmed = 0
  for (const campaignId of unique) {
    const payload = { campaign_id: campaignId, action_type: 'confirm' }
    let result = null
    try {
      result = await postJSON(`${ZCODE}/api/v1/marketing/touch/action`, payload, feedHeaders(account), timeoutMs)
    } catch (error) {
      errors.push(`${campaignId}: ${error?.message || error}`)
      continue
    }
    // 极简头被拒时用客户端全头再试一次：两条路都试过，才把失败说出口
    if (!marketingOk(result)) {
      try {
        result = await postJSON(`${ZCODE}/api/v1/marketing/touch/action`, payload, headersFor(account), timeoutMs)
      } catch (error) {
        errors.push(`${campaignId}: ${error?.message || error}`)
        continue
      }
    }
    if (marketingOk(result)) confirmed += 1
    else errors.push(`${campaignId}: ${strOf(result.body?.msg) || `HTTP ${result.status}`}`)
  }
  const ok = errors.length === 0
  return {
    ok,
    confirmed,
    total: unique.length,
    message: ok
      ? `营销回执已确认（${confirmed} 个 campaign）`
      : `营销回执${confirmed ? '部分' : ''}失败: ${errors.join('；')}`,
  }
}

// 领取后复查活动位：活动位不再返回这张卡，就是「已下线」的正向证据。
// 但它永远只是备注 —— confirm 和复查都不能推翻一次已经服务端确认的领取。
export async function recheckMarketing(account, plan) {
  const result = await marketingPlans(account).catch((error) => ({
    plans: [], unread: [String(error?.message || error)], unknown: true, not_deployed: false, rate: false,
  }))
  if (result.not_deployed) return { note: '营销复查询接口未部署，不能作为活动位下线证据' }
  if (result.unknown) {
    return { note: `营销复查询读不懂${result.unread?.[0] ? `（${result.unread[0]}）` : ''}，不能作为下线证据` }
  }
  if (!result.plans.length) return { note: '营销活动位已下线（正向证据）' }
  if (result.plans.some((item) => item.plan_id === plan?.plan_id)) return { note: '营销活动位仍返回该套餐' }
  return { note: `营销活动位仍有 ${result.plans.length} 条，但未匹配到该套餐` }
}

// ---- 活跃事件上报 --------------------------------------------------------------
// 官方客户端启动 / 日活时会向事件接口报两条（app_launch、app_daily_active），运营系统据此
// 发放领取资格。页面插件不是那个客户端，所以要补这两条，否则资格链可能根本不成立。
// 该接口不带 Authorization，靠 body 里的 user_id + device_mid 自证；身份从 JWT 载荷里取。
const USER_KEYS = ['user_id', 'userId', 'uid', 'sub', 'id']

export function userIdOf(jwt) {
  const payload = String(jwt || '').split('.')[1]
  if (!payload) return ''
  let claims
  try {
    claims = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
  } catch {
    return ''
  }
  if (!claims || typeof claims !== 'object') return ''
  for (const key of USER_KEYS) {
    const value = claims[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  const nested = claims.data
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    for (const key of ['id', 'user_id', 'uid']) {
      const value = nested[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    }
  }
  return ''
}

const osCategory = () =>
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'

function osVersion() {
  try {
    const version = String(release() || '')
    // Windows 的 release 本来就是 10.0.<build>；别把 macOS 的 Darwin 内核号伪装成 10.0.x
    if (process.platform === 'win32' && !/^\d+\.\d+\.\d+/.test(version)) {
      const build = version.split('.')[2] || '0'
      return `10.0.${build}`
    }
    return version
  } catch {
    return ''
  }
}

// 客户端报的是 IANA 名（Asia/Shanghai）。Node 里读得到真值，比脚本在非 Windows 上给 "unknown" 更接近真客户端。
// ZCODE_CLAIM_TZ 可以强制成某个值，包括 "unknown"。
function clientTimezone() {
  const forced = String(process.env.ZCODE_CLAIM_TZ || '').trim()
  if (forced) return forced
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown'
  } catch {
    return 'unknown'
  }
}

export function activationBody(event, userId, deviceMid) {
  return {
    event_id: randomUUID(),
    client_timezone: clientTimezone(),
    client_language: 'zh-CN',
    element_name: event,
    event_region: 'app',
    event_type: 'view',
    event_text: '',
    event_extra_detail: {},
    user_id: userId,
    // Node 里没有屏幕尺寸可读；真客户端的常见值就是这个，写死比留空更像一次真实上报
    screen_resolution: String(process.env.ZCODE_CLAIM_SCREEN || '2560x1440'),
    app_version: appVersion,
    device_os_category: osCategory(),
    device_os_version: osVersion(),
    device_mid: deviceMid,
    source_page: '',
    source_element: '{}',
  }
}

export async function activation(account, { timeoutMs = 10_000 } = {}) {
  const userId = userIdOf(account?.jwt)
  if (!userId) return { ok: false, skipped: 'no_user_id', message: 'JWT 里读不到用户标识，跳过活跃上报' }
  const notes = []
  for (const event of ['app_launch', 'app_daily_active']) {
    try {
      const result = await postJSON(`${ZCODE}/api/v1/event/report`, activationBody(event, userId, deviceOf(account)), {}, timeoutMs)
      const ok = result.status === 200 && Number(result.body?.code) === 0
      notes.push(ok ? `${event}=ok` : `${event}: HTTP ${result.status} code=${result.body?.code ?? '?'}`)
    } catch (error) {
      notes.push(`${event}: ${error?.message || error}`)
    }
  }
  const ok = notes.every((note) => note.endsWith('=ok'))
  return {
    ok,
    notes,
    message: ok ? '已补报激活事件（app_launch / app_daily_active）' : `活跃上报失败: ${notes.join('；')}`,
  }
}

export { appVersion as APP_VERSION, DEFAULT_APP_VERSION, ZCODE, RECHECK_MS, MIN_MARKETING_VERSION, MAX_BODY }
