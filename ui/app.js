// 页面脚本：列账号 → 点「领取」→ 读可领卡 → 弹窗取票 → 携票领取 → 就地出结果。
// 只跟自己这个服务说话（同源回环 + 页面口令），不依赖 magpie 的读取接口。
import { openClaimDialog } from './claim-dialog.js'

// 这个标记和 index.html 里的兜底定时器配合：脚本真跑起来了，兜底就不吭声
window.__zcodeClaimApp = true

const KEY = document.querySelector('meta[name="zcode-claim-key"]')?.getAttribute('content') || ''
const $ = (id) => document.getElementById(id)

const el = (tag, className, textContent) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (textContent != null) node.textContent = String(textContent)
  return node
}

const state = {
  accounts: [],
  logRows: [],
  known: new Map(), // 账号 id → { plans, at }，点过「领取」才知道
  done: new Map(), // 账号 id → Set(已领到的 plan_id)
  busy: false,
}

// 口令放 query、body 用 text/plain：两个都是「简单请求」，不触发预检。
// 在 magpie 的不透明来源框架里，带自定义头的预检会被拦，表现就是一直停在「读取中…」。
async function api(path, init = {}) {
  // 按文档地址算，而不是写成 /api/...：magpie web 把服务挂在路径前缀下时，
  // 以 / 开头的绝对路径会跑出前缀，页面上就是「读取失败」。
  const target = new URL(String(path).replace(/^\/+/, ''), document.baseURI)
  const url = target.pathname + target.search + (target.search ? '&' : '?') + 'k=' + encodeURIComponent(KEY)
  // body 传对象时要自己序列化：fetch 只认字符串，否则会变成 "[object Object]"
  const payload = init.body && typeof init.body === 'object' ? JSON.stringify(init.body) : init.body
  const response = await fetch(url, {
    ...init,
    body: payload,
    headers: { 'content-type': 'text/plain', ...(init.headers || {}) },
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  })
  const text = await response.text()
  let body = text
  try {
    body = JSON.parse(text)
  } catch {
    body = { error: text.slice(0, 300) }
  }
  if (!response.ok) throw new Error(body?.error || body?.message || `HTTP ${response.status}`)
  return body
}

let toastTimer = 0
function toast(message, bad = false) {
  const node = $('toast')
  node.textContent = message
  node.classList.toggle('bad', bad)
  node.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { node.hidden = true }, bad ? 6000 : 3400)
}

const say = (message, title) => {
  const node = $('subtitle')
  node.textContent = message
  if (title !== undefined) node.title = title
}

function busyButton(button, on) {
  button.disabled = on
  button.classList.toggle('is-busy', on)
}

// 状态行：一句话 + 可选的小按钮（比如「仍要查询」）
function setHint(node, { text, kind = '', action = null }) {
  if (!node) return
  node.className = 'card-hint card-status' + (kind ? ' is-' + kind : '')
  node.replaceChildren(document.createTextNode(text))
  if (action) {
    const button = el('button', 'mini', action.label)
    button.type = 'button'
    button.addEventListener('click', action.run)
    node.append(button)
  }
}

const untilText = (value) => {
  const at = Date.parse(value)
  if (!Number.isFinite(at)) return ''
  const left = at - Date.now()
  if (left <= 0) return '现在可以了'
  if (left < 3_600_000) return `${Math.max(1, Math.round(left / 60_000))} 分钟后（${clock(at)}）`
  return `${Math.round(left / 3_600_000)} 小时后（${clock(at)}）`
}

const pad = (n) => String(n).padStart(2, '0')
const clock = (ms) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
const ago = (ms) => {
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

// ends_at 可能是秒也可能是毫秒；只说人话：还剩几天 / 今天几点
function endsIn(value) {
  if (value == null || value === '') return ''
  let ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return ''
  if (ms < 1e12) ms *= 1000
  const left = ms - Date.now()
  if (left <= 0) return '已过期'
  if (left < 3_600_000) return `剩 ${Math.max(1, Math.round(left / 60_000))} 分钟`
  if (left < 86_400_000) return `剩 ${Math.round(left / 3_600_000)} 小时`
  return `剩 ${Math.round(left / 86_400_000)} 天`
}

// 数字换值时数一下，别硬跳
function countUp(node, next) {
  if (!node) return
  const shown = node.textContent
  if (next == null) {
    node.textContent = '—'
    node.dataset.value = ''
    return
  }
  const from = Number(node.dataset.value === '' ? NaN : node.dataset.value)
  const to = Number(next)
  if (!Number.isFinite(from) || from === to) {
    node.textContent = String(to)
    node.dataset.value = String(to)
    return
  }
  node.dataset.value = String(to)
  const start = performance.now()
  const tick = (now) => {
    const k = Math.min(1, (now - start) / 380)
    const eased = k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2
    node.textContent = String(Math.round(from + (to - from) * eased))
    if (k < 1) requestAnimationFrame(tick)
  }
  if (shown === '—' || !node.dataset.animated) node.textContent = String(to)
  node.dataset.animated = '1'
  requestAnimationFrame(tick)
}

function paintStats() {
  countUp($('stat-accounts'), state.accounts.length || null)
  let claimable = 0
  let known = 0
  for (const info of state.known.values()) {
    claimable += info.plans.filter((plan) => !isDone(plan.plan_id, '')).length
    known += 1
  }
  countUp($('stat-claimable'), known ? claimable : null)
  const today = new Date().setHours(0, 0, 0, 0)
  const claimed = state.logRows.filter((row) => row.kind === 'claim' && row.ok && row.at >= today).length
  countUp($('stat-claimed'), state.logRows.length ? claimed : null)
}

const isDone = (planId, accountId) => {
  const set = state.done.get(accountId)
  return Boolean(set && set.has(planId))
}

function skeleton() {
  const host = $('accounts')
  host.replaceChildren()
  for (let i = 0; i < 2; i += 1) {
    const card = el('div', 'skeleton')
    card.append(el('div', 'sk-avatar'))
    const lines = el('div', 'sk-lines')
    lines.append(el('div', 'sk-line w-40'), el('div', 'sk-line w-70'))
    card.append(lines)
    host.append(card)
  }
}

function chipsFor(account) {
  const info = state.known.get(account.id)
  if (!info || !info.plans.length) return null
  const box = el('div', 'chips')
  for (const plan of info.plans) {
    const done = isDone(plan.plan_id, account.id)
    const chip = el('span', 'chip' + (done ? ' is-done' : ''))
    chip.append(el('span', 'chip-name', plan.name || plan.plan_id))
    const ends = endsIn(plan.ends_at)
    if (ends) chip.append(el('span', 'chip-ends', ends))
    if (done) chip.append(el('span', 'chip-tick', '✓'))
    chip.title = plan.campaign_id ? `${plan.plan_id}
活动 ${plan.campaign_id}` : plan.plan_id
    box.append(chip)
  }
  return box
}

function rowFor(account) {
  const card = el('article', 'card')

  const avatar = el('div', 'avatar', (account.name || account.email || '?').replace(/^zcode#/, '').charAt(0))
  avatar.setAttribute('aria-hidden', 'true')

  const body = el('div', 'card-body')
  const top = el('div', 'card-top')
  top.append(el('b', 'card-name', account.name || account.email || account.id))
  if (account.plan) top.append(el('span', 'badge plan', account.plan))
  const claimable = state.known.get(account.id)
  if (claimable && claimable.plans.length) top.append(el('span', 'badge todo', `待领 ${claimable.plans.length} 张`))
  const dot = el('span', 'dot' + (account.jwt_ok ? '' : ' off'))
  dot.title = account.jwt_ok ? '凭据有效' : '凭据需要更新'
  top.append(dot)
  top.append(el('span', 'badge ' + (account.jwt_ok ? 'yes' : 'no'), account.jwt_ok ? '已登录' : '凭据需更新'))

  const email = el('p', 'card-email', account.email || (account.handle ? '账号 ' + account.handle : '—'))
  body.append(top, email)

  // 登录失效是另一件事：说清楚，别让它看起来像「没有卡」
  if (!account.jwt_ok) {
    const stale = el('p', 'card-hint is-error', 'ZCode 登录已过期或缺失，先在 magpie 里重新登录 ZCode。')
    body.append(stale)
    const side0 = el('div', 'card-side')
    const disabled = el('button', 'primary', '领取')
    disabled.type = 'button'
    disabled.disabled = true
    side0.append(disabled)
    card.append(avatar, body, side0)
    return card
  }

  const chips = chipsFor(account)
  if (chips) body.append(chips)

  const info = state.known.get(account.id)
  const hint = el('p', 'card-hint card-status', info
    ? `上次读取 ${clock(info.at)} · ${ago(info.at)}`
    : '点「领取」读取这张账号的可领卡。')
  body.append(hint)

  const side = el('div', 'card-side')
  const button = el('button', 'primary', info && info.plans.length ? '再查一次' : '领取')
  button.type = 'button'
  button.addEventListener('click', () => { void claim(account, button, hint) })
  side.append(button)

  card.append(avatar, body, side)
  return card
}

function renderAccounts() {
  const host = $('accounts')
  host.replaceChildren()
  const has = state.accounts.length > 0
  $('empty').hidden = has
  if (!has) {
    paintStats()
    return
  }
  for (const account of state.accounts) host.append(rowFor(account))
  paintStats()
}

// 只重画这一张卡，别把整页闪一下
function refreshCard(accountId) {
  const account = state.accounts.find((item) => item.id === accountId)
  const cards = [...$('accounts').children]
  if (!account) return
  const index = state.accounts.indexOf(account)
  const next = rowFor(account)
  const current = cards[index]
  if (current && current.replaceWith) current.replaceWith(next)
  else $('accounts').append(next)
  paintStats()
}

// 卡片会被整张替换，拿新卡上的那行状态
function hintOf(account) {
  const card = [...$('accounts').children][state.accounts.indexOf(account)]
  return card ? card.querySelector('.card-status') : null
}

async function claim(account, button, hint, { force = false } = {}) {
  if (state.busy) return
  state.busy = true
  busyButton(button, true)
  setHint(hint, { text: force ? '正在重新查询…' : '正在读取可领卡…' })
  const again = (label = '仍要查询') => ({
    label,
    run: () => { const next = hintOf(account); void claim(account, button, next || hint, { force: true }) },
  })
  try {
    const query = `/api/plans?account=${encodeURIComponent(account.id)}${force ? '&force=1' : ''}`
    const got = await api(query)
    const plans = Array.isArray(got.plans) ? got.plans : []
    const unread = Array.isArray(got.unread) ? got.unread.filter(Boolean) : []
    state.known.set(account.id, { plans, at: Date.now() })
    refreshCard(account.id)
    hint = hintOf(account) || hint

    if (got.rate_limited) {
      setHint(hint, { kind: 'error', text: `上游在限流（${unread[0] || '请求过于频繁'}），${untilText(got.until) || '过一会儿'}再试。` })
      return
    }
    if (!plans.length && got.cached_empty) {
      setHint(hint, { text: `刚查过是空的，${untilText(got.until) || '稍后'}可再查。`, action: again() })
      return
    }
    if (!plans.length) {
      // 读不懂 ≠ 没有：这两种要分开说
      if (got.unknown) {
        setHint(hint, { kind: 'error', text: `上游回包读不懂${unread.length ? `（${unread[0]}）` : ''}，没确认是否真的没有卡。`, action: again() })
        return
      }
      setHint(hint, {
        text: unread.length ? `读取失败：${unread.join('；')}` : '当前没有可领的卡（营销 feed 为空）。',
        kind: unread.length ? 'error' : '',
        action: unread.length ? again() : null,
      })
      return
    }
    hint.textContent = `可领 ${plans.length} 张，正在验证…`

    const scene = await api(`/api/scene?account=${encodeURIComponent(account.id)}`)
    const jobs = plans.map((plan) => ({
      ...plan,
      scene_id: scene.scene_id || '',
      region: scene.region || 'cn',
      prefix: scene.prefix || '',
    }))

    // 上游没开安全验证时不用弹窗，直接一卡一提交
    let result
    if (scene.enabled === false) {
      hint.textContent = `可领 ${jobs.length} 张，正在领取…`
      const rows = []
      for (const job of jobs) {
        const one = await api('/api/claim', { method: 'POST', body: { account: account.id, plan: job.plan_id, name: job.name || '' } })
        rows.push({ name: job.name || job.plan_id, plan: job.plan_id, ...one })
      }
      result = { ok: rows.some((row) => row.ok), claimed: rows.filter((row) => row.ok).length, results: rows }
    } else {
      result = await openClaimDialog({
        api: (path, init) => api(path, init),
        account,
        plans: jobs,
        copy: { title: '领取验证', manual: '请按组件提示完成验证。', cancel: '取消' },
      })
    }

    if (Array.isArray(result.results)) {
      const set = state.done.get(account.id) || new Set()
      for (const row of result.results) if (row.ok && row.plan) set.add(row.plan)
      state.done.set(account.id, set)
      refreshCard(account.id)
      hint = hintOf(account) || hint
    }

    const popup = jobs.map((job) => job.popup).find(Boolean) || ''
    if (result.code === 'canceled') {
      setHint(hint, { text: '已取消，剩下的卡没有动。' })
    } else if (result.code === 'expired') {
      setHint(hint, { kind: 'error', text: '验证会话过期，重新点「领取」会取一张新票。' })
    } else if (result.claimed) {
      setHint(hint, { kind: 'ok', text: `已领取 ${result.claimed} / ${jobs.length} 张。` })
      if (popup) hint.title = popup // feed 里客户端自己的分享文案，选中就能复制
      toast(`已领取 ${result.claimed} 张卡`)
    } else {
      const why = Array.isArray(result.results) ? (result.results.find((row) => !row.ok)?.message || '') : ''
      setHint(hint, { kind: 'error', text: why ? `没有领到卡：${why}（详情见下方记录）` : '没有领到卡，详情见下方记录。' })
    }
    await loadLog()
  } catch (error) {
    hint.className = 'card-hint is-error'
    hint.textContent = `出错：${error.message}`
    toast(error.message, true)
  } finally {
    state.busy = false
    busyButton(button, false)
  }
}

function logItem(row) {
  const ok = row.kind === 'claim' && row.ok
  const item = el('li', 'tl-item ' + (row.kind !== 'claim' ? 'idle' : ok ? 'ok' : 'bad'))
  item.append(el('span', 'tl-dot'))

  const body = el('div', 'tl-body')
  const title = el('div', 'tl-title', row.kind === 'import'
    ? `导入账号 ${(row.ids || []).join('、')}`
    : ok
      ? `${row.plan || row.plan_id || '赠卡'} · 已领取`
      : `${row.plan || row.plan_id || '赠卡'} · ${row.message || row.code || '失败'}`)
  const meta = el('div', 'tl-meta', `${clock(row.at)} · ${ago(row.at)}${row.ms ? ` · ${row.ms} ms` : ''}`)
  body.append(title, meta)
  item.append(body)
  return item
}

async function loadLog() {
  const got = await api('/api/log?limit=50')
  state.logRows = Array.isArray(got.rows) ? got.rows : []
  const host = $('log')
  host.replaceChildren()
  for (const row of state.logRows) host.append(logItem(row))
  $('log-empty').hidden = state.logRows.length > 0
  $('log-count').textContent = state.logRows.length ? `最近 ${state.logRows.length} 条` : ''
  paintStats()
}

async function load() {
  const refresh = $('refresh')
  busyButton(refresh, true)
  skeleton()
  say('正在读取账号…')
  try {
    const got = await api('/api/accounts')
    state.accounts = Array.isArray(got.accounts) ? got.accounts : []
    renderAccounts()
    say(`${state.accounts.length} 个 ZCode 账号 · 直连 zcode.z.ai`, String(got.config || ''))
    await loadLog()
  } catch (error) {
    $('accounts').replaceChildren()
    say(`读取失败：${error.message}`)
    toast(error.message, true)
  } finally {
    busyButton(refresh, false)
  }
}

$('refresh').addEventListener('click', () => { void load() })

// 滚起来之后顶栏落一道阴影，内容从下面穿过去时有层次
const onScroll = () => document.body.classList.toggle('is-scrolled', window.scrollY > 4)
window.addEventListener('scroll', onScroll, { passive: true })
onScroll()

void load()