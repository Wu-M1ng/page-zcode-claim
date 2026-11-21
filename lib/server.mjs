// 页面服务：给窗口里的「ZCode 领卡中心」提供账号、可领卡、验证场景与领取。
//
// 安全模型（对齐 magpie 的其他页面插件）：
//  - Host 只认本进程监听端口上的 127.0.0.1 / localhost，挡掉 DNS 重绑定；
//  - magpie 的页面框架是 sandbox="allow-scripts"，导航后 origin 是字面量 "null"，
//    所以 API 一律要页面口令（每次启动随机生成，只注入本实例返回的 HTML），并且要有 CORS 头；
//  - 账号凭据只在服务端用，页面只看得到 email / 是否有 jwt，看不到 jwt 本体。
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { accounts, configDir, dataDir, findAccount } from './store.mjs'
import * as zcode from './zcode.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const UI_ROOT = resolve(here, '..', 'ui')
const DEFAULT_PORT = 3527

// ── 每日自动活跃的「时刻」是纯函数，放到模块顶尖便于直接测 ───────────────
// 上游的「一天」按北京算，日界也按北京时间，跟本机时区无关。
/** 北京日期（YYYY-MM-DD） */
export const beijingDay = (now = Date.now()) => new Date(now + 8 * 3600_000).toISOString().slice(0, 10)

/** 随机窗口长度：08:00–09:00 */
export const AUTO_ACTIVE_WINDOW_S = 3600

/**
 * 用日期字符串算一个 [0, 3600) 的秒偏移。
 *
 * 为什么不用 Math.random()：magpie 重载插件很频繁，每次重启都重摇的话，
 * 一个总被重载的进程可能整天都等不到那个时刻。同一天怎么重启都是同一分钟。
 */
export function autoOffsetSeconds(day) {
  // FNV-1a：确定性、零依赖、够分散
  let h = 0x811c9dc5
  for (let i = 0; i < String(day).length; i += 1) {
    h ^= String(day).charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h % AUTO_ACTIVE_WINDOW_S
}

/** 今天该跑的那一瞬（UTC 毫秒）。北京 08:00 = 北京日期那天的 00:00Z。 */
export function autoActiveTarget(day = beijingDay()) {
  return Date.parse(`${day}T00:00:00Z`) + autoOffsetSeconds(day) * 1000
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
}

// 阿里云组件的域名（实测命中）：脚本在 alicdn，上报在 *.aliyuncs.com 与 *.aliyun.com。
// 这里少一条的症状是「点开始验证没反应」——SDK 初始化时被拦，实例建不起来。
//
// 策略里为什么「'self' + 完整源」两个都要（官方文档 /docs/zh/plugins 的原话）：
//  - sandbox="allow-scripts" 的框架里，WebKit（Mac、Linux 的窗口）的 'self' 和不带 scheme
//    的源可能**什么都匹配不上**，所以桌面窗口这条路上必须写服务的完整源；
//  - 走 magpie web（局域网、容器、反代）时，magpie 会把响应头里**每个 'self' 补成服务的
//    真实地址**，`<meta>` 里的不补 —— 策略里一条 'self' 都没有，它就补不了。
// 缺哪一边，那一侧就是脚本和样式一起被拦：页面只剩静态骨架，控件没样式，点哪都不动。
//  - 最后再按请求自己的 Host / x-forwarded-* 推一份源，覆盖反代改了 Host 的情况。
const firstValue = (value) => String(Array.isArray(value) ? value[0] : value ?? '').split(',')[0].trim()

/** 请求自己所在的源：反代带了 x-forwarded-* 就用它，否则按 Host 拼。 */
const requestOrigin = (req) => {
  const host = firstValue(req.headers['x-forwarded-host']) || firstValue(req.headers.host)
  if (!host) return ''
  // 只认「主机[:端口]」这一种形态，别把奇怪的头拼进策略里
  if (!/^([a-z0-9._-]+|\[[0-9a-f:]+\])(:\d+)?$/i.test(host)) return ''
  const proto = firstValue(req.headers['x-forwarded-proto']) || (req.socket?.encrypted ? 'https' : 'http')
  return `${proto === 'https' ? 'https' : 'http'}://${host}`
}

const cspFor = (req, port) => {
  const sources = new Set(["'self'", `http://127.0.0.1:${port}`, `http://localhost:${port}`])
  const own = requestOrigin(req)
  if (own) sources.add(own)
  const src = [...sources].join(' ')
  return [
    `default-src ${src}`,
    `script-src ${src} 'unsafe-inline' https://o.alicdn.com https://g.alicdn.com`,
    `connect-src ${src} https://*.aliyuncs.com https://*.aliyun.com https://*.alicdn.com https://zcode.z.ai`,
    `img-src ${src} data: blob:`,
    `style-src ${src} 'unsafe-inline'`,
    `frame-src ${src} https://*.aliyuncs.com https://*.aliyun.com https://*.alicdn.com`,
  ].join('; ')
}

/**
 * 只认真票：base64(JSON) 里必须有 certifyId，且带 securityToken（二代）或 data/sig（旧版）。
 * SDK 初始化失败时会 fire 一个 76 字符的假票，只有 certifyId + sceneId，提交上去必然 3007。
 */
export function ticketOf(param, region = 'cn') {
  if (typeof param !== 'string') return null
  const text = param.trim()
  if (text.length < 100 || text.length > 32 * 1024) return null
  let json
  try {
    // base64url → base64，并补齐 padding。
    // Buffer 对缺 padding 是宽容的，但浏览器端的 atob 不是 —— 两边不统一时会出现
    // 「页面说票无效、服务端说票有效」，用户只能重新点一次滑块。统一补上。
    const b64 = text.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    json = Buffer.from(padded, 'base64').toString('utf8')
  } catch {
    return null
  }
  let value
  try {
    value = JSON.parse(json)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || typeof value.certifyId !== 'string' || !value.certifyId) return null
  let strong = false
  if (typeof value.securityToken === 'string') strong = value.securityToken.length > 20
  else if (typeof value.data === 'string') strong = value.data.length > 20
  else if (typeof value.sig === 'string') strong = value.sig.length > 0
  if (!strong) return null
  return { param: text, region: region === 'sgp' ? 'sgp' : 'cn', certifyId: value.certifyId }
}

/** 领取结果的分类：上游 code 直接决定提示与是否重试。 */
// 上游的 code 对照（沿用 @magpie-community/opencode-zcode-auth 的记录）：
//   0 / 200  成功；1003 之前领过（真 msg 是 "target already exists"）；1001 套餐不存在；
//   1004     当前不提供 —— 旧版本头会让它变成全局症状（11-04 六账号齐刷刷 1004）；
//   3007 或 msg 里有 captcha  =  要客户端的阿里云票；3002 / HTTP 429  =  太频繁；
//   3012     风控把账号封了，别重试（ZCode 自己的 app 在这个账号上也是 405）。
const CAPTCHA_WORDS = /captcha/i

function classify(status, body, { edge = false } = {}) {
  if (edge) return { ok: false, code: 'edge_blocked', message: '本机 IP 被厂商边缘防火墙拦（回的是 HTML 拦截页），等一会儿或换个网络', retry: true }
  const code = body && typeof body === 'object' && body.code != null ? Number(body.code) : NaN
  let message = ''
  // msg 是上游说了算的字符串，可能是整页 HTML。截断之后再往外带：
  // 它既会进 claim-log（常驻 200 条），也会进接口响应。
  if (typeof body?.msg === 'string') message = body.msg.slice(0, 300)
  else if (typeof body === 'string') message = body.slice(0, 200)
  if (status === 429 || code === 3002) return { ok: false, code: 'rate_limited', message: message || '请求过于频繁', retry: true }
  if (code === 3012) return { ok: false, code: 'restricted', message: message || '账号被风控拦下（code 3012），先别再试' }
  if (code === 3007 || CAPTCHA_WORDS.test(message)) return { ok: false, code: 'captcha_rejected', message: message || '安全验证未通过', retry: true }
  if (code === 1003) return { ok: true, code: 'already', message: message || '此前已领取' }
  if (code === 1001) return { ok: false, code: 'not_found', message: message || '套餐不存在或已下架' }
  if (code === 1004) return { ok: false, code: 'ineligible', message: message || '当前账号不可领取该卡' }
  if (status === 200 && (code === 0 || code === 200)) return { ok: true, code: 'claimed', message: message || '领取成功' }
  // 没有可解析的 body：只能算「读不懂」，绝不能当成功
  if (!Number.isFinite(code)) return { ok: false, code: 'unreadable', message: message || `HTTP ${status}，回包读不懂`, status }
  return { ok: false, code: 'failed', message: message || `HTTP ${status}`, status }
}

// Retry-After 可能是秒数也可能是 HTTP 日期
function retryAfterMs(value) {
  const raw = String(value || '').trim()
  if (!raw) return 0
  const secs = Number(raw)
  if (Number.isFinite(secs) && secs > 0) return secs * 1000
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0
}

export async function startServer({ port, host, directory, options } = {}) {
  // 只认回环、0.0.0.0（含 IPv6 的 ::）或一个像样的地址；别把任意字符串拼进 listen
  const bind = (() => {
    const value = String(host ?? '').trim()
    if (!value) return '127.0.0.1'
    if (value === '0.0.0.0' || value === '::' || value === '*' || value === 'all') return '0.0.0.0'
    if (/^([a-z0-9._-]+|\[[0-9a-f:]+\])$/i.test(value)) return value
    return '127.0.0.1'
  })()
  const dir = configDir(directory)
  const data = dataDir(dir)
  const logs = join(data, 'claim-log.jsonl')
  const KEY = randomBytes(24).toString('base64url')
  const recent = []

  // 写 JSON 状态文件一律走这里：临时文件 + rename。
  // 裸 writeFileSync 遇到 magpie 重载插件（很频繁）把进程半路杀掉时，会留下
  // 半截 JSON；读取处 catch 后返回 {}，于是整份内容归零 —— activation.json 一丢，
  // 当天所有账号会重新报一遍活跃（正是「别打成高频」要避免的）。
  const writeJsonAtomic = (file, value) => {
    const tmp = `${file}.tmp-${process.pid}`
    try {
      writeFileSync(tmp, JSON.stringify(value, null, 1), { mode: 0o600 })
      renameSync(tmp, file)
      return true
    } catch {
      try { unlinkSync(tmp) } catch { /* 临时文件可能根本没建出来 */ }
      return false
    }
  }

  // 日志轮转：只在超过上限时切一次，保留一个 .1 备份。
  // 以前是 appendFileSync 无限增长，配上「启动时全量 readFileSync」，
  // 跑几个月后光是启动就要把几十 MB 读进内存。
  const LOG_MAX_BYTES = 2 * 1024 * 1024
  let logSize = (() => {
    try { return statSync(logs).size } catch { return 0 }
  })()
  const rotateLogIfNeeded = () => {
    if (logSize <= LOG_MAX_BYTES) return
    try {
      renameSync(logs, `${logs}.1`)
      logSize = 0
    } catch {
      /* 轮转失败就继续写，别把记录丢了 */
    }
  }

  // 启动时把最近几条捞回内存：以前 recent 纯内存，magpie 重载一次插件
  // 页面上「领取记录」就整页空了，用户看到的是「我的记录被自动刷新没了」。
  // 只读尾部：open + fstat + readSync，内存里永远只有 256 KiB。
  const RESTORE_ROWS = 200
  const TAIL_BYTES = 256 * 1024
  const restoreRecent = () => {
    let fd
    let text = ''
    try {
      fd = openSync(logs, 'r')
      // 一行约 200–400 字节，200 条 ≈ 80 KiB。留 3 倍余量，不随日志长大而变慢。
      const size = fstatSync(fd).size
      const start = Math.max(0, size - TAIL_BYTES)
      const length = size - start
      if (length <= 0) return
      const buf = Buffer.allocUnsafe(length)
      readSync(fd, buf, 0, length, start)
      text = buf.toString('utf8')
      // 从中间切进去的第一个半行丢掉（否则必定 JSON.parse 失败）
      if (start > 0) text = text.replace(/^[^\n]*\n/, '')
    } catch {
      return
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd) } catch { /* 已经关了 */ }
      }
    }
    const rows = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        rows.push(JSON.parse(line))
      } catch {
        /* 半截行（进程被杀时写了一半）直接跳过 */
      }
    }
    // 文件是追加写（旧在前），recent 是 unshift 语义（新在前）
    recent.push(...rows.slice(-RESTORE_ROWS).reverse())
  }
  restoreRecent()

  // 活跃上报的「今天报过了」：只写 { <accountId>: 'YYYY-MM-DD' }，不写凭据。
  // 上游的「一天」按北京算，所以日界也按北京时间，跟本机时区无关。
  const ACTIVATION_FILE = join(data, 'activation.json')
  const activationDays = (() => {
    try {
      const raw = JSON.parse(readFileSync(ACTIVATION_FILE, 'utf8'))
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    } catch {
      return {}
    }
  })()
  const activationSettled = (accountId) => activationDays[accountId] === beijingDay()
  // activationSettled 只说「报过了」，不说成没成。上报失败也照样 mark（一天一次，
  // 4xx 重试救不回来），所以卡片上的「活跃 ✓」不能直接等同于「成功了」——
  // 把今天那条的实际结果一并给出去。
  const beijingDayStart = () => Date.parse(`${beijingDay()}T00:00:00Z`) - 8 * 3600_000
  const activationStateOf = (accountId) => {
    if (!activationSettled(accountId)) return { today: false, ok: false, note: '' }
    const start = beijingDayStart()
    const hit = recent.find((row) => row.kind === 'activation' && row.account === accountId && row.at >= start)
    // 自动活跃全成功时只写一条无 account 的汇总，所以「找不到」= 成功
    return hit ? { today: true, ok: Boolean(hit.ok), note: hit.message || '' } : { today: true, ok: true, note: '' }
  }

  // 今天这个账号领到了几张。
  // 不猜「几点生效」：feed 里的 starts_at 是**领取窗口开始**，不是权益生效时间
  // （能领的时候它必然已经过去），拿它算「还没生效」永远是 0，等于没算。
  // 只报事实：今天领到过几张 —— 账单里看不到时，页面据此提示「可能还没生效」。
  const claimedTodayOf = (accountId) => {
    const start = beijingDayStart()
    return recent.filter((row) => row.kind === 'claim' && row.ok && row.account === accountId && row.at >= start).length
  }

  // 页面上的开关：data/settings.json，只存 {"auto_active": boolean}，不碰凭据。
  // 环境变量 ZCODE_CLAIM_AUTO_ACTIVE=0 是硬开关（测试和排查用），
  // 它优先于页面开关：env 关了，页面上怎么点都不会跑。
  const SETTINGS_FILE = join(data, 'settings.json')
  const settings = (() => {
    try {
      const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    } catch {
      return {}
    }
  })()
  const saveSettings = () => writeJsonAtomic(SETTINGS_FILE, settings)
  // ZCODE_CLAIM_ACTIVATION=0 关掉自动补报（手动 /api/activation 不受限：那是显式意图）
  const activationEnabled = () => String(process.env.ZCODE_CLAIM_ACTIVATION ?? '1').trim() !== '0'
  const markActivation = (accountId) => {
    activationDays[accountId] = beijingDay()
    // 落盘失败不阻断领取（下次靠内存值也行），但不能当成写成功
    writeJsonAtomic(ACTIVATION_FILE, activationDays)
  }

  // 手动上报的防抖：页面上的「活跃」按钮被双击、浏览器自动重试、脚本轮询时，
  // 不该把同一个号打成高频。5 秒内复用上一次结果，并发的合成一个请求。
  const MANUAL_DEDUPE_MS = 5_000
  const manualDone = new Map() // accountId -> { at, result }
  const manualInFlight = new Map() // accountId -> Promise

  // device_mid 必须跳重启稳定：上游按 user_id + device_mid 认设备，
  // 每次重启换一个号等于每次都当新设备。magpie 账号里没存 device 时就落在这里。
  const DEVICE_FILE = join(data, 'device.json')
  const devices = (() => {
    try {
      const raw = JSON.parse(readFileSync(DEVICE_FILE, 'utf8'))
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    } catch {
      return {}
    }
  })()
  zcode.setDeviceStore({
    get: (accountId) => String(devices[accountId] || ''),
    set: (accountId, uuid) => {
      devices[accountId] = uuid
      // 写不了就先用内存里的：下次启动会重新生成一个（比抛错好）
      writeJsonAtomic(DEVICE_FILE, devices)
    },
  })

  // 领取计划快照：/api/claim 只拿得到 plan_id，而营销回执要的是 campaign_ids，
  // 所以列可领卡那一步留一份。10 分钟后失效 —— 一张卡放这么久还没点，这页早就该刷新了。
  const SNAPSHOT_TTL_MS = 10 * 60_000
  const snapshots = new Map() // accountId -> { at, byId: Map<plan_id, plan> }
  const snapshotOf = (accountId, planId) => {
    const snapshot = snapshots.get(accountId)
    if (snapshot && Date.now() - snapshot.at > SNAPSHOT_TTL_MS) {
      snapshots.delete(accountId) // 过期就地扔，别等下一次 /api/accounts
      return null
    }
    if (!snapshot) return null
    const plan = snapshot.byId.get(planId)
    return plan ? { plan, skew: snapshot.skew || 0 } : null
  }

  let actualPort = 0
  let OWN = new Set()
  let HOSTS = new Set()
  const own = (value) => {
    actualPort = value
    OWN = new Set([`http://127.0.0.1:${value}`, `http://localhost:${value}`])
    HOSTS = new Set([`127.0.0.1:${value}`, `localhost:${value}`])
    // 只听回环时，别的 Host 也只能是回环；bind 到别处时由「端口对得上」那条规则放行
  }
  // sandbox 里 Origin 是字面量 "null"；另外允许同源、本机回环，以及「页面就是从它自己的
  // Host 来的」这一种（magpie web / 局域网 / 反代会改 Host，写死回环会让 API 全 403）。
  const sameOrigin = (req) => Boolean(requestOrigin(req)) && requestOrigin(req) === req.headers.origin
  const hostAllowed = (req) => {
    const host = String(req.headers.host || '').toLowerCase()
    if (HOSTS.has(host)) return true
    // 端口就是本进程的监听端口：反代/局域网把服务暴露成别的地址时属于这一类
    if (actualPort && host.endsWith(`:${actualPort}`)) return true
    // 明确带了反代头（magpie web 就是这种）
    if (req.headers['x-forwarded-host'] || req.headers['x-forwarded-proto']) return true
    return false
  }
  const originAllowed = (req) => {
    const origin = req.headers.origin
    return origin === undefined || origin === 'null' || OWN.has(origin) || sameOrigin(req)
  }
  const cors = (req) => {
    const origin = req.headers.origin
    if (origin === 'null') return { 'access-control-allow-origin': 'null', vary: 'Origin' }
    if (origin && (OWN.has(origin) || sameOrigin(req))) return { 'access-control-allow-origin': origin, vary: 'Origin' }
    return { vary: 'Origin' }
  }
  const send = (req, res, status, body, type = 'application/json; charset=utf-8') => {
    const data = typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body)
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...cors(req),
    })
    res.end(data)
  }
  // 口令既认头也认 query 里的 k：不透明来源（Origin: null）里带自定义头的请求会先发预检，
  // 那条预检在部分 Chromium 版本上会被私有网络访问（PNA）拦掉，症状是请求一直挂着。
  // 只带 query、body 用 text/plain 的请求是「简单请求」，不预检，稳。
  const same = (value) => {
    const got = Buffer.from(String(value || ''))
    const want = Buffer.from(KEY)
    return got.length === want.length && timingSafeEqual(got, want)
  }
  const keyOK = (req, url) => same(req.headers['x-zcode-claim-key']) || same(url?.searchParams.get('k'))
  const body = (req, limit = 64 * 1024) =>
    new Promise((resolveBody, rejectBody) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
        if (raw.length > limit) {
          rejectBody(new Error('请求体过大'))
          req.destroy()
        }
      })
      req.on('end', () => {
        try {
          resolveBody(raw ? JSON.parse(raw) : {})
        } catch {
          rejectBody(new Error('请求体不是 JSON'))
        }
      })
      req.on('error', rejectBody)
    })

  // 单条记录的字符串字段上限。recent 会常驻 200 条，任何一处没拦住的长文本
  // 都会被放大 200 倍（上游的 msg、回执说明、活跃失败原因都来自外部）。
  const CLIP_CHARS = 300
  const clip = (value) =>
    typeof value === 'string' && value.length > CLIP_CHARS ? `${value.slice(0, CLIP_CHARS)}…` : value

  const record = (entry) => {
    const row = { at: Date.now() }
    for (const [key, value] of Object.entries(entry)) row[key] = clip(value)
    recent.unshift(row)
    if (recent.length > 200) recent.pop()
    try {
      const line = JSON.stringify(row) + '\n'
      appendFileSync(logs, line, { mode: 0o600 })
      logSize += Buffer.byteLength(line)
      rotateLogIfNeeded()
    } catch {
      /* 日志写不了不影响领取 */
    }
    return row
  }

  // ── 每日自动活跃（北京时间 08:00–09:00 之间随机一个时刻）─────────────
  // 运营侧的领取资格看 app_launch + app_daily_active 这两条事件。以前只在
  // 「点领取」时顺带补一次 —— 那天没点就等于没活跃，资格也就没续上。
  // 现在由服务端自己兜：每天那一小时内挑一分钟，把所有账号报一遍。
  //
  // 三个刻意的选择：
  //  1) 目标时刻用「北京日期字符串」当种子算，不用 Math.random()。
  //     magpie 重载插件很频繁，每次重启都重摇的话，一个总被重载的进程
  //     可能整天都等不到那个时刻。同一天怎么重启都是同一分钟。
  //  2) 只跑「今天还没报过」的号，复用 activationDays，不另存一份状态 ——
  //     手动点过「活跃」的号，自动那轮自然跳过，不会一天两次。
  //  3) 失败也 markActivation：和领取路径一个理由，4xx 重试救不回来，
  //     反复打只会把号打成高频。
  //
  // 开关两层：
  //  · env ZCODE_CLAIM_AUTO_ACTIVE=0 —— 硬开关（测试、排查、一键安静），优先
  //  · 页面上的按钮 —— 软开关，写 settings.json
  // 和 ZCODE_CLAIM_ACTIVATION 相互独立：那个管「点领取时顺带报」，这个管「每天定时报」。
  // autoOffsetSeconds / autoActiveTarget 是模块顶尖的纯函数，这里只负责判定和跑。
  const autoEnvLocked = () => String(process.env.ZCODE_CLAIM_AUTO_ACTIVE ?? '1').trim() === '0'
  const autoActiveOn = () => !autoEnvLocked() && settings.auto_active !== false
  // 今天那个随机时刻，给页面显示（北京时间 HH:MM）
  const autoAtText = () => {
    const at = new Date(autoActiveTarget() + 8 * 3600_000)
    return `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`
  }

  // jwt_ok 是算出来的，不是账号自带字段。自动活跃定时器也要它，
  // 两处必须同源 —— 否则定时器筛账号时会拿到 undefined，一个号都不跑。
  const jwtAlive = (account) => Boolean(account.jwt) && (!account.expiresAt || account.expiresAt > Date.now())

  // 自动活跃上一次跑的时刻：页面上靠它判断「服务端刚跑过一轮」并自己刷新。
  // 不写进 settings.json（那是用户配置），也不进 claim-log（那是领取时间线）。
  const AUTO_STATE_FILE = join(data, 'auto-active.json')
  const autoState = (() => {
    try {
      const raw = JSON.parse(readFileSync(AUTO_STATE_FILE, 'utf8'))
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    } catch {
      return {}
    }
  })()
  const saveAutoState = (patch) => {
    Object.assign(autoState, patch)
    // 写不了不影响上报本身，但会丢「上一轮跑在什么时间」
    writeJsonAtomic(AUTO_STATE_FILE, autoState)
  }

  let autoActiveRunning = false
  const runAutoActive = async () => {
    if (autoActiveRunning) return
    autoActiveRunning = true
    let ok = 0
    let bad = 0
    try {
      const todo = accounts(dir).filter((item) => jwtAlive(item) && !activationSettled(item.id))
      if (!todo.length) return
      // 记录只写「值得一提的事」：全成功就一条汇总，有失败才逐条列。
      // 以前一圈打 5 条（start + 每个号 + done），而页面只展示 10 条，
      // 一轮自动活跃就能把真正要看的领取记录挤出去。
      const failed = []
      for (const account of todo) {
        try {
          const result = await zcode.activation(account)
          markActivation(account.id)
          if (!result.ok) failed.push({ account, code: result.skipped || 'activation_failed', message: result.message })
        } catch (error) {
          // 抛了也算「今天处理过」，否则下一次 tick 会原地重试到天亮
          markActivation(account.id)
          failed.push({ account, code: 'auto_error', message: String(error?.message || error) })
        }
      }
      ok = todo.length - failed.length
      bad = failed.length
      if (!failed.length) {
        record({ kind: 'activation', ok: true, code: 'auto_reported', message: `每日自动活跃：${todo.length} 个账号已补报` })
        return
      }
      for (const item of failed) {
        record({
          kind: 'activation',
          account: item.account.id,
          ok: false,
          code: item.code,
          message: item.message,
          auto: true,
        })
      }
    } finally {
      if (ok || bad) saveAutoState({ last_run: Date.now(), day: beijingDay(), ok, failed: bad })
      autoActiveRunning = false
    }
  }

  const autoActiveTick = () => {
    if (!autoActiveOn()) return
    if (Date.now() < autoActiveTarget()) return
    void runAutoActive()
  }

  // 每分钟看一眼；unref 掉，不挡住进程退出（magpie 关窗口时服务要能自己走）。
  const autoActiveTimer = setInterval(autoActiveTick, 60_000)
  autoActiveTimer.unref?.()
  // 启动补跑：这个点已经过了今天的随机时刻就别干等下一次 tick
  const bootTimer = setTimeout(autoActiveTick, 5_000)
  bootTimer.unref?.()

  // 插件选项里与上游有关的那几项。app_version 决定 UA / X-ZCode-App-Version /
  // 配置查询与上报 body 里的版本号 —— 版本变了的场景配置不一样，zcode.setAppVersion
  // 自己会清掉验证场景缓存。被 ZCODE_CLAIM_APP_VERSION 锁定时 setAppVersion 会拒绝。
  const applyOptions = (saved) => {
    if (!saved) return
    if (saved.app_version != null) zcode.setAppVersion(saved.app_version)
  }

  const liveOptions = async () => {
    if (typeof options?.option !== 'function') return {}
    try {
      const saved = (await options.option()) ?? {}
      applyOptions(saved)
      return saved
    } catch {
      return {}
    }
  }

  // 启动时就取一次：第一次打上游之前版本头就该是对的，
  // 不能等页面第一次访问 /api/accounts 才顺带读。
  void liveOptions()

  const serveFile = (req, res, file) => {
    const full = resolve(UI_ROOT, file)
    if (!full.startsWith(UI_ROOT) || !existsSync(full)) return send(req, res, 404, { error: 'not found' })
    const type = MIME[extname(full).toLowerCase()] || 'application/octet-stream'
    if (type.startsWith('text/html')) {
      const html = readFileSync(full, 'utf8').replaceAll('__ZCODE_CLAIM_KEY__', KEY)
      res.writeHead(200, {
        ...cors(req),
        'content-type': type,
        'cache-control': 'no-store',
        'content-security-policy': cspFor(req, actualPort || DEFAULT_PORT),
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      })
      return res.end(html)
    }
    const stat = statSync(full)
    // 不透明来源里 ES module 的导入是 CORS 请求，静态文件也要给 allow-origin，否则 app.js 加载失败
    res.writeHead(200, { ...cors(req), 'content-type': type, 'cache-control': 'no-store', 'content-length': stat.size })
    res.end(readFileSync(full))
  }

  const handler = async (req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${actualPort || DEFAULT_PORT}`)
    const path = url.pathname
    if (!hostAllowed(req)) return send(req, res, 403, { error: 'invalid host' })
    if (!originAllowed(req)) return send(req, res, 403, { error: 'cross-origin reads are not allowed' })
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors(req),
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type, x-zcode-claim-key',
        'access-control-allow-private-network': 'true',
        'access-control-max-age': '86400',
      })
      return res.end()
    }
    try {
      if (req.method === 'GET' && !path.startsWith('/api/')) {
        const file = path === '/' ? 'index.html' : path.replace(/^\/+/, '')
        return serveFile(req, res, file)
      }
      if (!keyOK(req, url)) return send(req, res, 401, { error: 'unauthorized: send the x-zcode-claim-key header' })

      if (path === '/api/ping') {
        return send(req, res, 200, {
          ok: true,
          service: 'magpie-zcode-claim',
          port: actualPort,
          config: dir,
          app_version: zcode.appVersionOf(),
          app_version_locked: zcode.appVersionLocked(),
          options: await liveOptions(),
        })
      }

      if (path === '/api/accounts') {
        const list = accounts(dir).map((account) => {
          const act = activationStateOf(account.id)
          const claimedToday = claimedTodayOf(account.id)
          return {
            id: account.id,
            name: account.name,
            email: account.email,
            handle: account.handle || '',
            plan: account.plan,
            site: account.site,
            source: account.source,
            jwt_ok: jwtAlive(account),
            expires_at: account.expiresAt,
            // 页面上那个「活跃」按钮靠这几个字段：今天报没报、报成没成
            activation_today: act.today,
            activation_ok: act.ok,
            activation_note: act.note,
            // 今天领到几张。billing/preview 只列已生效的卡，没有这个字段的话，
            // 「领到了但还没生效」在页面上长得和「什么也没领到」一模一样。
            claimed_today: claimedToday,
          }
        })
        // 顺手扫一遍快照：账号被删的、以及过了 TTL 的。
        // 快照里存的是整份 plan 对象（每张几百字节），过期之后没有任何用途。
        const alive = new Set(accounts(dir).map((account) => account.id))
        const sweepAt = Date.now()
        for (const [snapId, snap] of snapshots) {
          if (!alive.has(snapId) || sweepAt - snap.at > SNAPSHOT_TTL_MS) snapshots.delete(snapId)
        }
        return send(req, res, 200, {
          accounts: list,
          config: dir,
          // 版本头是请求上游的一部分，页面得能看见当下用的是哪个、能不能改。
          app_version: zcode.appVersionOf(),
          app_version_locked: zcode.appVersionLocked(),
          app_version_default: zcode.DEFAULT_APP_VERSION,
        })
      }

      if (path === '/api/plans') {
        const account = findAccount(dir, url.searchParams.get('account') || '')
        if (!account) return send(req, res, 404, { error: '账号不存在' })
        const force = url.searchParams.get('force') === '1'

        // 这个账号还在限流等待里：同一个回答，不发请求
        const held = zcode.holdOf(account.id)
        if (held) {
          return send(req, res, 200, { plans: [], unread: [held.message], unknown: false, rate_limited: true, until: held.until, account: account.id })
        }
        // 刚查过是空的：30 分钟内直接回上次的答案（force=1 是用户明确要求再查）
        const emptyUntil = zcode.emptyUntilOf(account.id)
        if (!force && emptyUntil && Date.parse(emptyUntil) > Date.now()) {
          return send(req, res, 200, { plans: [], unread: [], unknown: false, cached_empty: true, until: emptyUntil, account: account.id })
        }

        const got = await zcode.plans(account)
        if (got.rate_limited) {
          const held2 = zcode.noteRateLimit(account.id, retryAfterMs(got.retry_after), got.unread.join('；') || '上游限流')
          return send(req, res, 200, { ...got, rate_limited: true, until: held2.until, account: account.id })
        }
        if (!got.plans.length) {
          const until = got.unknown ? '' : zcode.noteEmpty(account.id)
          return send(req, res, 200, { ...got, until, account: account.id })
        }
        zcode.clearEmpty(account.id)
        if (got.plans.length) {
          snapshots.set(account.id, {
            at: Date.now(),
            skew: got.skew_ms || 0,
            byId: new Map(got.plans.map((plan) => [plan.plan_id, plan])),
          })
        }
        return send(req, res, 200, { ...got, account: account.id })
      }

      if (path === '/api/scene') {
        const account = findAccount(dir, url.searchParams.get('account') || '')
        if (!account) return send(req, res, 404, { error: '账号不存在' })
        const value = await zcode.scene(account, { force: url.searchParams.get('force') === '1' })
        return send(req, res, 200, value)
      }

      if (path === '/api/claim' && req.method === 'POST') {
        const input = await body(req)
        const account = findAccount(dir, String(input.account || ''))
        if (!account) return send(req, res, 404, { error: '账号不存在' })
        const planId = String(input.plan || '').trim()
        if (!planId) return send(req, res, 400, { error: '缺少 plan_id' })
        // 记录里写卡名更好读，plan_id 单独留一份用于核对
        const planLabel = String(input.name || '').trim() || planId
        // 时间窗是硬门槛：没开窗就发 claim 只会白吃一个 1005，已结束的白吃 1004。
        // 快照里没有这张卡（页面直接 POST，或者快照超过 10 分钟）就不拦 —— 没有证据就不阻止用户。
        const hit = snapshotOf(account.id, planId)
        const snapshot = hit ? hit.plan : null
        // 窗口用上游时钟判：本机钟偏了就会把能领的卡挡在门外
        const slot = hit ? zcode.windowState(hit.plan, Date.now() + hit.skew) : 'active'
        if (slot !== 'active') {
          const message = slot === 'future'
            ? `活动还没开窗，北京时间 ${zcode.formatBeijing(snapshot.starts_at)} 开启`
            : `活动已于北京时间 ${zcode.formatBeijing(snapshot.ends_at)} 结束`
          const code = slot === 'future' ? 'not_open' : 'expired'
          record({ kind: 'claim', account: account.id, plan: planLabel, plan_id: planId, ok: false, code, message })
          return send(req, res, 409, { ok: false, code, message, account: account.id, plan: planId })
        }
        // 补报活跃事件：官方客户端启动 / 日活那两条，运营侧据此发放领取资格。
        // 一天一次（失败也算报过，别把一个号打成高频）；只对营销来源的卡报，billing 兜底的卡不参与。
        let activation = null
        const marketingPlan = !snapshot || (snapshot.sources || []).includes('marketing')
        if (activationEnabled() && marketingPlan && !activationSettled(account.id)) {
          activation = await zcode.activation(account)
          // 无论成败都记「今天报过」：4xx（身份/参数）重试也救不回来，反复打只会把号打成高频。
          // 真要补救走 /api/activation，那个端点不看这个标记。
          markActivation(account.id)
          record({
            kind: 'activation',
            account: account.id,
            ok: activation.ok,
            code: activation.ok ? 'reported' : activation.skipped || 'activation_failed',
            message: activation.message,
          })
        }
        const supplied = String(input.param || '')
        const ticket = supplied ? ticketOf(supplied, String(input.region || 'cn')) : null
        if (supplied && !ticket) {
          record({ kind: 'claim', account: account.id, plan: planLabel, plan_id: planId, ok: false, code: 'invalid_ticket' })
          return send(req, res, 400, { ok: false, code: 'invalid_ticket', message: '验证票据无效或已过期，请重新验证' })
        }
        if (!ticket) {
          // 只有上游明确说「不需要验证」才允许无票提交；要求验证、以及配置读不懂（未知），
          // 都先让页面取票 —— 没票的 claim 只会白吃一次 3007。
          const current = await zcode.scene(account)
          if (current.unknown || current.enabled !== false) {
            return send(req, res, 400, {
              ok: false,
              code: current.unknown ? 'scene_unknown' : 'needs_ticket',
              message: current.unknown ? (current.why || '上游验证配置读不懂，先不提交') : '上游要求安全验证，请先取票',
            })
          }
        }
        const held = zcode.holdOf(account.id)
        if (held) {
          return send(req, res, 200, { ok: false, code: 'rate_limited', message: held.message, until: held.until, retry: true, account: account.id, plan: planId })
        }
        const started = Date.now()
        const { status, body: responseBody, retryAfter, edge } = await zcode.claim(account, planId, ticket)
        const result = classify(status, responseBody, { edge })
        if (result.code === 'rate_limited') {
          // 上游说了要等多久就等多久，没说就从 30 分钟起翻倍
          const wait = zcode.noteRateLimit(account.id, retryAfterMs(retryAfter), result.message)
          result.until = wait.until
        } else if (result.code === 'restricted') {
          // 风控封号：给足 6 小时，别把一个被封的账号打穿
          result.until = zcode.noteRateLimit(account.id, 6 * 60 * 60_000, result.message).until
        } else if (result.ok) {
          zcode.clearEmpty(account.id)
        }
        // 领取成功（含 1003「此前已领」）后给活动位回一条 confirm，再复查一次活动位。
        // 这两步都只是备注：失败绝不能推翻一次服务端已经确认的领取。
        let confirm = null
        if (result.ok) {
          const campaignIds = snapshot?.campaign_ids?.length
            ? snapshot.campaign_ids
            : Array.isArray(input.campaign_ids) ? input.campaign_ids : []
          if (marketingPlan && campaignIds.length) {
            const confirmed = await zcode.confirmClaim(account, campaignIds)
            const recheck = await zcode.recheckMarketing(account, { plan_id: planId })
            confirm = { ...confirmed, recheck: recheck.note }
            record({
              kind: 'confirm',
              account: account.id,
              plan_id: planId,
              ok: confirmed.ok,
              code: confirmed.ok ? 'confirmed' : 'confirm_failed',
              message: confirmed.message,
              recheck: recheck.note,
            })
          }
        }
        record({
          kind: 'claim',
          account: account.id,
          plan: planLabel,
          plan_id: planId,
          ok: result.ok,
          code: result.code,
          status,
          message: result.message,
          ms: Date.now() - started,
          ticket_age: input.age ?? null,
          // 卡的生效/失效时间。领到 ≠ 立刻可用（实测有 23:00 才生效的卡），
          // 记下来页面才能说「已领，X 点生效」，而不是让人去 billing 里找不到就以为没领到。
          starts_at: snapshot?.starts_at ?? null,
          ends_at: snapshot?.ends_at ?? null,
          activation: activation ? activation.message : null,
          confirm: confirm ? confirm.message : null,
        })
        return send(req, res, 200, {
          ...result,
          status,
          account: account.id,
          plan: planId,
          confirm,
          activation,
          // 带上生效/失效时间：领到不等于立刻能用，页面要能说「23:00 生效」
          starts_at: snapshot?.starts_at ?? null,
          ends_at: snapshot?.ends_at ?? null,
        })
      }

      // 手动补报一次活跃事件（页面不留入口，给命令行排查用）
      if (path === '/api/activation' && req.method === 'POST') {
        const input = await body(req)
        const account = findAccount(dir, String(input.account || ''))
        if (!account) return send(req, res, 404, { error: '账号不存在' })
        const last = manualDone.get(account.id)
        if (last && Date.now() - last.at < MANUAL_DEDUPE_MS) {
          return send(req, res, 200, { ...last.result, account: account.id, deduped: true, message: '刚刚已补报过（5 秒内不重复）' })
        }
        // 并发点击也只会发一次：拿同一张在飞的 promise
        let pending = manualInFlight.get(account.id)
        if (!pending) {
          pending = zcode.activation(account)
          manualInFlight.set(account.id, pending)
          pending.finally(() => manualInFlight.delete(account.id))
        }
        const result = await pending
        manualDone.set(account.id, { at: Date.now(), result })
        if (result.ok) markActivation(account.id)
        record({
          kind: 'activation',
          account: account.id,
          ok: result.ok,
          code: result.ok ? 'reported' : result.skipped || 'activation_failed',
          message: result.message,
          manual: true,
        })
        return send(req, res, 200, { ...result, account: account.id })
      }

      // 自动活跃的开关：页面读它显示按钮，点它写它
      if (path === '/api/settings') {
        const snapshot = () => ({
          auto_active: autoActiveOn(),
          // env 硬关时，页面上的按钮改成只读，不去骗人
          auto_locked: autoEnvLocked(),
          auto_at: autoAtText(),
          auto_today: beijingDay(),
          // 上一轮自动活跃：页面拿它判断「该刷新了」
          auto_last: Number(autoState.last_run) || 0,
          auto_last_day: String(autoState.day || ''),
          auto_last_ok: Number(autoState.ok) || 0,
          auto_last_failed: Number(autoState.failed) || 0,
        })
        if (req.method === 'POST') {
          const input = await body(req)
          if (typeof input.auto_active !== 'boolean') return send(req, res, 400, { error: 'auto_active 必须是 true / false' })
          if (autoEnvLocked()) {
            return send(req, res, 409, { error: 'ZCODE_CLAIM_AUTO_ACTIVE=0 锁死了定时，先去掉这个环境变量', ...snapshot() })
          }
          const was = settings.auto_active
          settings.auto_active = input.auto_active
          if (!saveSettings()) {
            // 写不进去就不能回 200：页面会显示「已关」但重启后又变回开，
            // 用户只会以为开关坏了。回滚内存值并说清楚原因。
            settings.auto_active = was
            return send(req, res, 500, {
              error: '开关写不进 settings.json（目录只读或磁盘满），这次设置没有生效',
              ...snapshot(),
            })
          }
          // 不落 claim-log：那是「领取发生了什么」的时间线，一次开关往里塞一
          // 条会把真正要紧的记录挤出去（页面只展示最近 10 条）。
        }
        return send(req, res, 200, snapshot())
      }

      // 页面只要最近几条；默认 10（传 limit 可以要更多，查问题时用）
      if (path === '/api/log') {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 10, 1), 200)
        // 「今日已领」不能由页面从这 10 条里数 —— 今天领了 15 张就少报 5 张。
        // 北京当天 0 点 = 北京日期那天的 00:00Z 减 8 小时。
        const todayStart = Date.parse(`${beijingDay()}T00:00:00Z`) - 8 * 3600_000
        const claimedToday = recent.filter((row) => row.kind === 'claim' && row.ok && row.at >= todayStart).length
        return send(req, res, 200, { rows: recent.slice(0, limit), total: recent.length, claimed_today: claimedToday })
      }

      return send(req, res, 404, { error: 'not found' })
    } catch (error) {
      return send(req, res, 500, { error: String(error?.message || error) })
    }
  }

  // 端口被占用时的退路。最常见的两种情况：
  //  1) 上一次的领卡服务进程还没退干净（magpie 重启、插件重载都会留下这种孤儿），
  //     等一两秒它自己就走了 —— 先原地重试一次；
  //  2) 端口真被别的程序占了 —— 往后顺延着找，别让整个页面直接打不开。
  // 声明端口和实际端口不一致时把话说明白：boot 页只能按声明的端口跳。
  const base = port || DEFAULT_PORT
  const plan = [base, base]
  for (let step = 1; step <= 15; step += 1) plan.push(base + step)
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  let server
  let lastError
  for (let index = 0; index < plan.length; index += 1) {
    const candidate = plan[index]
    const attempt = createServer(handler)
    try {
      await new Promise((resolveListen, rejectListen) => {
        const failed = (error) => { attempt.off('listening', listened); rejectListen(error) }
        const listened = () => { attempt.off('error', failed); resolveListen() }
        attempt.once('error', failed)
        attempt.once('listening', listened)
        attempt.listen(candidate, bind)
      })
      server = attempt
      own(candidate)
      break
    } catch (error) {
      lastError = error
      try { attempt.close() } catch {}
      if (error?.code !== 'EADDRINUSE') throw error
      console.warn(`[zcode-claim] ${bind}:${candidate} 被占用（${index === 0 ? '等一下重试同一个端口' : '换下一个端口'}）`)
      await sleep(index === 0 ? 1500 : 300)
    }
  }
  if (!server) {
    throw new Error(`领卡服务的端口全被占了：${base}–${base + 15}（最后一次：${lastError?.code || lastError?.message}）`)
  }
  if (actualPort !== base) {
    console.warn(`[zcode-claim] 声明端口 ${base} 用不了，服务实际在 127.0.0.1:${actualPort}；页面上请把「端口」选项改成 ${actualPort}`)
  }
  return {
    port: actualPort,
    requested: base,
    bind,
    url: `http://${bind === '0.0.0.0' ? '127.0.0.1' : bind}:${actualPort}/`,
    key: KEY,
    config: dir,
    close: () => {
      // 不清定时器的话，每调一次 startServer 就留一个每分钟跑一遍的 tick，
      // 连同整个闭包（recent、snapshots、日志路径、账号缓存）一起常驻。
      clearInterval(autoActiveTimer)
      clearTimeout(bootTimer)
      server.close()
    },
  }
}