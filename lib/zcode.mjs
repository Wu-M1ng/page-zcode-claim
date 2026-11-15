// ZCode 上游接口：验证场景、可领卡（营销 feed）、余额预览（兜底）、携票领取。
//
// 这里几条判定对齐 @magpie-community/opencode-zcode-auth 已经踩过的结论：
//  1) 版本头是硬门槛：旧版本头下 marketing/touch 回空 feed、领取回 1004（11-04 六账号齐刷刷 1004）。
//  2) 「读不懂」与「没有」严格分开：deliveries 缺失 = 确实没有；缺 deliveries 数组/结构不对 = 读不懂，
//     绝不降级成「没有卡」，否则用户会以为真没活动。
//  3) 安全验证配置用三态：缺失 = 不需要验证；不是对象 = 未知；其余按「要验证」处理。
//     未知时一个 claim 都不发 —— 没有票的 claim 只会白吃一次 3007。
//  4) 领取按钮不在 buttons[0]（真实样本里第一个是 close），所以要整条 delivery 递归找。
import { randomUUID } from 'node:crypto'

const APP_VERSION = '3.17.2'
// ZCODE_CLAIM_BASE 只在自测时用：指向本地假上游，就能在没有真实活动卡的情况下跑通整条链路。
const ZCODE = process.env.ZCODE_CLAIM_BASE || 'https://zcode.z.ai'
const UA = 'ZCode/' + APP_VERSION

const platform = () => `${process.platform}-${process.arch}`

// 没拿到 device 时也要带一个：上游把缺这个头当参数错（真客户端的 anyDevice 是同一思路）
const anyDevice = randomUUID()
const deviceOf = (account) => String(account?.device || '') || anyDevice

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
    'User-Agent': UA,
    'X-ZCode-App-Version': APP_VERSION,
    'X-Platform': platform(),
    'X-Client-Language': clientLanguage(),
    'X-Device-Mid': deviceOf(account),
  }
  if (account?.jwt) headers.Authorization = 'Bearer ' + account.jwt
  return { ...headers, ...extra }
}

// 边缘防火墙（阿里云）会把整段 IP 拦掉，那时回的是 HTML 错误页而不是 JSON。
// 认出来是「本机 IP 被拦」，别报成「解析失败」。
const EDGE_HTML = /errors\.aliyun\.com|<html[\s>]/i

async function readJSON(response) {
  const text = await response.text()
  let body = text.slice(0, 600)
  try {
    body = JSON.parse(text)
  } catch { /* 保持文本，下面按 edge / unreadable 判定 */ }
  const edge = typeof body === 'string' && EDGE_HTML.test(body)
  return { status: response.status, retryAfter: response.headers.get('retry-after') || '', body, edge }
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
export const emptyUntilOf = (accountId) => emptyUntil.get(accountId) || null
export const noteEmpty = (accountId) => {
  const until = new Date(Date.now() + RECHECK_MS).toISOString()
  emptyUntil.set(accountId, until)
  return until
}
export const clearEmpty = (accountId) => emptyUntil.delete(accountId)

// ---- 验证场景 ----------------------------------------------------------------
// 匿名接口，10 分钟缓存；场景改版后旧 sceneId 会一直失败，所以要过期重取。
const SCENE_TTL_MS = 10 * 60 * 1000
let sceneCache = { at: 0, value: null, loading: null }

export async function scene(account, { force = false } = {}) {
  if (!force && sceneCache.value && Date.now() - sceneCache.at < SCENE_TTL_MS) return sceneCache.value
  if (sceneCache.loading) return sceneCache.loading
  sceneCache.loading = (async () => {
    const url = `${ZCODE}/api/v1/client/configs?app_version=${APP_VERSION}&platform=${platform()}`
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

// ---- 可领卡 ------------------------------------------------------------------
// 营销 feed：deliveries[].banner|popup 里的 claim_zcode_plan 按钮才是「能领的卡」。
// 套餐元数据（名字、有效期、权益）挂在同一条 delivery 的 zcode_plan 上，位置不固定，所以整条递归找。
// 真实抓包里 buttons[0] 是 close，领取按钮在第二个 —— 别只看第一个。
function plansOf(data) {
  // 三态：deliveries 缺失 = 确实没有；不是数组 = 读不懂
  if (data == null) return { plans: [], unknown: false }
  if (typeof data !== 'object' || Array.isArray(data)) return { plans: [], unknown: true }
  if (data.deliveries == null) return { plans: [], unknown: false }
  if (!Array.isArray(data.deliveries)) return { plans: [], unknown: true }

  const found = []
  for (const delivery of data.deliveries) {
    if (!delivery || typeof delivery !== 'object') continue
    const ids = []
    let meta = null
    let popup = ''
    const walk = (value, depth) => {
      if (!value || typeof value !== 'object' || depth > 12) return
      if (Array.isArray(value)) {
        for (const item of value) walk(item, depth + 1)
        return
      }
      if (value.type === 'claim_zcode_plan' && typeof value.args?.plan_id === 'string' && value.args.plan_id.trim()) {
        ids.push(value.args.plan_id.trim())
      }
      if (value.zcode_plan && typeof value.zcode_plan === 'object' && typeof value.zcode_plan.name === 'string' && !meta) {
        meta = value.zcode_plan
      }
      // 领取成功后客户端给的那段可复制文案，也在 feed 里
      if (!popup && value.type === 'copy_text' && typeof value.args?.text === 'string') popup = value.args.text
      for (const key of Object.keys(value)) walk(value[key], depth + 1)
    }
    walk(delivery, 0)
    for (const id of ids) {
      found.push({
        plan_id: id,
        name: String(meta?.name || id),
        ends_at: meta?.ends_at ?? 0,
        entitlements: Array.isArray(meta?.entitlements) ? meta.entitlements : [],
        campaign_id: String(delivery.campaign_id || ''),
        priority: Number.isFinite(Number(delivery.priority)) ? Number(delivery.priority) : 0,
        position: String(delivery.resource_position || ''),
        popup,
      })
    }
  }
  const seen = new Set()
  return {
    plans: found.filter((plan) => (seen.has(plan.plan_id) ? false : seen.add(plan.plan_id))),
    unknown: false,
  }
}

// seq 是 ZCode 自己的 feed 计数，仅供服务端日志定位，不影响投放判断；一次刷新只发一次。
let touchSeq = 0

export async function marketingPlans(account) {
  const url = `${ZCODE}/api/v1/marketing/touch?seq=${touchSeq++}`
  const response = await fetch(url, { headers: headersFor(account), signal: AbortSignal.timeout(20000) })
  const { status, body, retryAfter, edge } = await readJSON(response)
  const unread = []
  if (edge) unread.push('本机 IP 被厂商边缘防火墙拦（回的是 HTML 拦截页）')
  const code = body && typeof body === 'object' ? Number(body.code) : NaN
  if (status !== 200 && !edge) unread.push(`营销 feed HTTP ${status}`)
  if (Number.isFinite(code) && code !== 0 && code !== 200) unread.push(body?.msg || `营销 feed code ${code}`)
  const rate = status === 429 || code === 3002
  const parsed = unread.length && (edge || Number.isFinite(code))
    ? { plans: [], unknown: true }
    : plansOf(body?.data)
  if (parsed.unknown) unread.push('营销 feed 的结构读不懂')
  return { plans: parsed.plans, unread, unknown: parsed.unknown, rate, retryAfter, status }
}

// 余额预览是备用来源（3.17 客户端只读 feed，这里通常为空），只在 feed 空或读不懂时用一次。
export async function billingPlans(account) {
  const url = `${ZCODE}/api/v1/zcode-plan/billing/preview?app_version=${APP_VERSION}&platform=${platform()}`
  const response = await fetch(url, { headers: headersFor(account), signal: AbortSignal.timeout(20000) })
  const { status, body, edge } = await readJSON(response)
  if (edge) return { plans: [], unread: ['余额预览被边缘防火墙拦'], status }
  const plans = Array.isArray(body?.data?.plans) ? body.data.plans : []
  return {
    plans: plans.filter((plan) => typeof plan?.plan_id === 'string').map((plan) => ({ ...plan, plan_id: String(plan.plan_id) })),
    unread: status === 200 ? [] : [`余额预览 HTTP ${status}`],
    status,
  }
}

export async function plans(account) {
  const feed = await marketingPlans(account).catch((error) => ({
    plans: [], unread: [String(error?.message || error)], unknown: true, rate: false, status: 0,
  }))
  let preview = { plans: [], unread: [] }
  // 只在 feed 没给出任何卡的时候才问预览，少发一次没用的请求
  if (!feed.plans.length && !feed.rate) {
    preview = await billingPlans(account).catch((error) => ({ plans: [], unread: [String(error?.message || error)] }))
  }
  const seen = new Set()
  const out = []
  for (const plan of [...feed.plans, ...preview.plans]) {
    const id = String(plan.plan_id || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ ...plan, plan_id: id, name: String(plan.name || id), ends_at: plan.ends_at ?? 0 })
  }
  // 优先级高的排前面；同优先级别乱序
  out.sort((a, b) => (b.priority || 0) - (a.priority || 0))
  return {
    plans: out,
    unread: [...feed.unread, ...(preview.unread || [])],
    unknown: Boolean(feed.unknown) && !out.length,
    rate_limited: Boolean(feed.rate),
    retry_after: feed.retryAfter || '',
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

export { APP_VERSION, ZCODE, RECHECK_MS }
