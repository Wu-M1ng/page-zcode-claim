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
  // 「今日已领」由服务端数（/api/log 的 claimed_today）。页面只拉最近 10 条，
  // 从这 10 条里数会让今天领了 15 张的号只报 5 张。
  claimedToday: null,
  settings: null, // { auto_active, auto_locked, auto_at }
}

// 口令放 query、body 用 text/plain：两个都是「简单请求」，不触发预检。
// 在 magpie 的不透明来源框架里，带自定义头的预检会被拦，表现就是一直停在「读取中…」。
// 每个端点自己的超时。以前统一 15 秒，而 /api/claim 在服务端最坏要几十秒：
// scene 15s + claim 25s + 回执 8s×N + 复查 20s。网络一抖，浏览器先报「出错」，
// 服务端却还在后台把卡领了 —— 用户以为失败反复重试。
const TIMEOUT_MS = {
  default: 15_000,
  claim: 120_000,
  plans: 60_000,
  scene: 30_000,
  activation: 30_000,
}

async function api(path, init = {}) {
  // 按文档地址算，而不是写成 /api/...：magpie web 把服务挂在路径前缀下时，
  // 以 / 开头的绝对路径会跑出前缀，页面上就是「读取失败」。
  const target = new URL(String(path).replace(/^\/+/, ''), document.baseURI)
  const url = target.pathname + target.search + (target.search ? '&' : '?') + 'k=' + encodeURIComponent(KEY)
  // body 传对象时要自己序列化：fetch 只认字符串，否则会变成 "[object Object]"
  const payload = init.body && typeof init.body === 'object' ? JSON.stringify(init.body) : init.body
  const { timeoutMs, ...rest } = init
  const response = await fetch(url, {
    ...rest,
    body: payload,
    headers: { 'content-type': 'text/plain', ...(init.headers || {}) },
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs || TIMEOUT_MS.default),
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

// state.busy 是全局锁（同一时刻只允许一轮领取：两个验证弹窗会抢层级），
// 所以视觉上也把所有「领取」按钮一起锁住 —— 否则点了别的账号毫无反应，
// 看起来就像页面死了。锁挂在 #accounts 容器上：卡片会被 refreshCard 整张换掉，
// 但容器不会，class 因此不会丢。
function lockAll(on) {
  const host = $('accounts')
  if (host) host.classList.toggle('is-busy', on)
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

// 上游把 starts_at / ends_at 统一成毫秒了（lib/zcode.mjs 的 epochMs），
// 但页面拿到的也可能是旧缓存里的秒值：两种都认。
const asMs = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n < 1e12 ? n * 1000 : n
}

const beijingClock = (ms) => {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(ms))
  } catch {
    return new Date(ms).toISOString().slice(5, 16).replace('T', ' ')
  }
}

// 窗口状态由服务端算好（state），这里只负责怎么说人话
const planState = (plan) => plan.state || 'active'

const windowText = (plan) => {
  const state = planState(plan)
  if (state === 'future') return `北京时间 ${beijingClock(asMs(plan.starts_at))} 开启`
  if (state === 'expired') return '已结束'
  return ''
}

// 一张卡给什么：名字 + 额度 + 单位（GLM-5.3-Flash 500000000token）
const grantsText = (plan) => (Array.isArray(plan.entitlements) ? plan.entitlements : [])
  .map((entry) => `${entry.name} ${entry.grant}${entry.unit}`)
  .join(' · ')

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
  const claimed = Number.isFinite(state.claimedToday)
    ? state.claimedToday
    : state.logRows.filter((row) => row.kind === 'claim' && row.ok && row.at >= new Date().setHours(0, 0, 0, 0)).length
  countUp($('stat-claimed'), state.claimedToday != null || state.logRows.length ? claimed : null)
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
    const state = planState(plan)
    const chip = el('span', 'chip' + (done ? ' is-done' : '') + (state !== 'active' ? ' is-' + state : ''))
    chip.append(el('span', 'chip-name', plan.name || plan.plan_id))
    // 未开窗 / 已结束说的是另一件事，不该和「还剩几天」挤在同一个位置
    const window = windowText(plan)
    if (window) chip.append(el('span', 'chip-ends', window))
    else {
      const ends = endsIn(plan.ends_at)
      if (ends) chip.append(el('span', 'chip-ends', ends))
    }
    if (done) chip.append(el('span', 'chip-tick', '✓'))
    const grants = grantsText(plan)
    chip.title = [
      plan.plan_id,
      plan.campaign_id ? `活动 ${plan.campaign_id}` : '',
      grants,
    ].filter(Boolean).join('\n')
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
    // 没有可用凭据就读不到用户标识，报上去也是空身份
    const disabledActive = el('button', 'ghost', '活跃')
    disabledActive.type = 'button'
    disabledActive.disabled = true
    disabledActive.title = '登录已失效，拿不到用户标识'
    side0.append(disabled, disabledActive)
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
  // data-claim：容器级锁定只认这个标记。jwt 失效那张卡上的「领取」也带 primary，
  // 但不能被解开 —— 它靠自己的 disabled 属性钉死。
  button.dataset.claim = '1'
  // data-force：「再查一次」就该真重查。之前按钮文案和请求参数对不上，
  // 点了还是读缓存，用户看到的是「再查一次也还是那句话」。
  button.dataset.force = info && info.plans.length ? '1' : ''
  button.addEventListener('click', () => {
    void claim(account, button, hint, { force: button.dataset.force === '1' })
  })
  side.append(button)

  // 手动补报活跃：跟领取里的自动上报同一个接口，只是不受「今天已报」限制
  // activation_today 只说「今天报过」，activation_ok 才是「报成了没有」——
  // 自动活跃失败也照样标今天已报（一天一次，不重试），所以两个必须分开显示。
  const actDone = Boolean(account.activation_today)
  const actOk = account.activation_ok !== false
  const actState = actDone ? (actOk ? 'ok' : 'failed') : 'off'
  const ACT_LABEL = { off: '活跃', ok: '活跃 ✓', failed: '活跃 ✗' }
  const ACT_CLASS = { off: '', ok: ' is-done', failed: ' is-failed' }
  const activeButton = el('button', 'ghost' + ACT_CLASS[actState], ACT_LABEL[actState])
  activeButton.type = 'button'
  const actTitles = {
    off: '补报一次 app_launch + app_daily_active，运营侧据此发放领取资格',
    ok: '今天已补报过 app_launch + app_daily_active（自动或手动都算）。再点会再报一次。',
    failed: `今天的上报没成功：${account.activation_note || '原因见下方记录'}。点一下重试。`,
  }
  activeButton.title = actTitles[actState]
  activeButton.addEventListener('click', () => { void reportActivation(account, activeButton, hint) })
  side.append(activeButton)

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

// 手动补报一次活跃事件。服务端的 /api/activation 不看 ZCODE_CLAIM_ACTIVATION，
// 也不看「今天报过了」—— 点了就报，这是显式意图。
async function reportActivation(account, button, hint) {
  if (button.disabled) return
  busyButton(button, true)
  try {
    const result = await api('/api/activation', { method: 'POST', body: { account: account.id }, timeoutMs: TIMEOUT_MS.activation })
    if (result.ok) {
      account.activation_today = true
      button.textContent = '活跃 ✓'
      button.classList.add('is-done')
      button.title = '今天已补报过。再点会再报一次。'
      setHint(hint, { kind: 'ok', text: result.message || '活跃事件已补报' })
      toast('活跃事件已补报')
      // 记录列表不会自己变，报完就拉一下，不然会以为没生效
      void loadLog()
    } else {
      // message 里已经带了「活跃上报失败: …」，不再套一层
      setHint(hint, { kind: 'error', text: result.message || result.skipped || '活跃上报没成功' })
      toast(result.message || '活跃上报没成功', true)
    }
  } catch (error) {
    setHint(hint, { kind: 'error', text: `活跃上报没成功：${error.message}` })
    toast(`活跃上报没成功：${error.message}`, true)
  } finally {
    busyButton(button, false)
  }
}

// 领完之后本地先记上：下一次点「领取」时那句「今天已领 N 张」才是对的，
// 不用等整页 reload。
function bumpClaimed(id, added = 1) {
  const row = (state.accounts || []).find((item) => item.id === id)
  if (!row) return
  row.claimed_today = (Number(row.claimed_today) || 0) + (Number(added) || 0)
}

// 今天这个号领到了几张（来自 /api/accounts，服务端按 claim-log 数）
function claimedOf(id) {
  const row = (state.accounts || []).find((item) => item.id === id)
  return { today: Number(row?.claimed_today) || 0 }
}

async function claim(account, button, hint, { force = false } = {}) {
  if (state.busy) return
  state.busy = true
  // 锁在 #accounts 容器上而不是按钮上：refreshCard() 会把整张卡片 replaceWith 掉，
  // 之前锁住的 button 随之变成游离节点，「解锁」也就白做了 —— 页面上那个按钮
  // 看起来永远是「领取中」。容器不会被替换，class 一直在。
  lockAll(true)
  setHint(hint, { text: force ? '正在重新查询…' : '正在读取可领卡…' })
  const again = (label = '仍要查询') => ({
    label,
    run: () => { const next = hintOf(account); void claim(account, button, next || hint, { force: true }) },
  })
  try {
    const query = `/api/plans?account=${encodeURIComponent(account.id)}${force ? '&force=1' : ''}`
    const got = await api(query, { timeoutMs: TIMEOUT_MS.plans })
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
      // source_notes 是「为什么没有卡」：版本头太低、营销接口没部署……
      // 吞掉它就只剩「没有卡」，用户只会反复点
      const notes = Array.isArray(got.source_notes) ? got.source_notes.filter(Boolean) : []
      // 今天已经领到过卡的话，「没有可领的卡」不等于「什么也没领到」：
      // 卡可能已经绑上了但还没到生效时间，billing/preview 里是空的。这句必须说清楚，
      // 否则用户（和帮他查的人）会拿着空账单得出「领取失败」的结论。
      const claimed = claimedOf(account.id)
      let why = '当前没有可领的卡（营销 feed 为空）。'
      if (unread.length) why = `读取失败：${unread.join('；')}`
      else if (claimed.today) {
        why = `今天这个号已领到 ${claimed.today} 张，暂时没有可再领的卡。要是账单里还看不到，多半是没到生效时间——不是没领到。`
      } else if (notes.length) why = notes.join('；')
      setHint(hint, {
        text: why,
        kind: unread.length ? 'error' : '',
        action: unread.length ? again() : null,
      })
      return
    }
    // 没开窗 / 已结束的卡不发 claim：上游只会回 1005 / 1004，白烧一次机会
    const ready = plans.filter((plan) => planState(plan) === 'active')
    const future = plans.filter((plan) => planState(plan) === 'future')
    if (!ready.length) {
      setHint(hint, {
        text: future.length
          ? `活动还没开窗：${future.map((plan) => `${plan.name || plan.plan_id} ${windowText(plan)}`).join('；')}`
          : '这些卡都已经结束了，没有可领的。',
        action: again('再查一次'),
      })
      return
    }
    hint.textContent = ready.length === plans.length
      ? `可领 ${plans.length} 张，正在验证…`
      : `可领 ${ready.length} 张（跳过 ${plans.length - ready.length} 张未开窗或已结束），正在验证…`

    const scene = await api(`/api/scene?account=${encodeURIComponent(account.id)}`, { timeoutMs: TIMEOUT_MS.scene })
    const jobs = ready.map((plan) => ({
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
        const one = await api('/api/claim', { method: 'POST', body: { account: account.id, plan: job.plan_id, name: job.name || '' }, timeoutMs: TIMEOUT_MS.claim })
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
      // 营销回执是服务端在领取成功后补的；确认到了就把这件事说出来
      const receipts = (Array.isArray(result.results) ? result.results : [])
        .map((row) => row.confirm)
        .filter((item) => item && item.ok)
      const receiptCount = receipts.reduce((sum, item) => sum + (item.confirmed || 0), 0)
      const tail = receiptCount ? ` 营销回执已确认 ${receiptCount} 个` : ''
      // 领到 ≠ 立刻能用：卡有生效时间（实测有 23:00 才生效的），
      // 那会儿去查账单是空的。这里不猜具体时刻（feed 的 starts_at 是领取窗口的开始，
      // 不是生效时间），只提醒别把「账单里没看到」当成「没领到」。
      setHint(hint, {
        kind: 'ok',
        text: `已领取 ${result.claimed} / ${jobs.length} 张。${tail}若账单里暂时看不到，多半是没到生效时间。`,
      })
      if (popup) hint.title = popup // feed 里客户端自己的分享文案，选中就能复制
      toast(`已领取 ${result.claimed} 张卡`)
      bumpClaimed(account.id, result.claimed)
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
    lockAll(false)
  }
}

function logItem(row) {
  const kind = row.kind || 'claim'
  // 记录里不只有「领取」：活跃上报与营销回执也会落一条，不能让它们冒充一张赠卡
  const ok = kind === 'import' ? null : Boolean(row.ok)
  let tone = 'bad'
  if (kind === 'import') tone = 'idle'
  else if (ok) tone = 'ok'
  const item = el('li', `tl-item ${tone}`)
  item.append(el('span', 'tl-dot'))

  const body = el('div', 'tl-body')
  let title = ''
  if (kind === 'import') title = `导入账号 ${(row.ids || []).join('、')}`
  else if (kind === 'settings') title = `设置 · ${row.message || (ok ? '已更新' : '未生效')}`
  else if (kind === 'activation') title = `活跃事件 · ${ok ? '已补报' : (row.message || row.code || '失败')}`
  else if (kind === 'confirm') title = `营销回执 · ${ok ? '已确认' : (row.message || row.code || '失败')}${row.recheck ? ` · 复查：${row.recheck}` : ''}`
  else if (ok) title = `${row.plan || row.plan_id || '赠卡'} · 已领取`
  else title = `${row.plan || row.plan_id || '赠卡'} · ${row.message || row.code || '失败'}`

  const meta = el('div', 'tl-meta', `${clock(row.at)} · ${ago(row.at)}${row.ms ? ` · ${row.ms} ms` : ''}`)
  body.append(el('div', 'tl-title', title), meta)
  item.append(body)
  return item
}

// 只显示最近 10 条：这个面板是「刚才发生了什么」，不是审计台账。
// 要看得多在地址上带 ?limit=200（服务端把上限钉在 200）。
async function loadLog() {
  const got = await api('/api/log?limit=10')
  state.logRows = Array.isArray(got.rows) ? got.rows : []
  if (Number.isFinite(got.claimed_today)) state.claimedToday = got.claimed_today
  const host = $('log')
  host.replaceChildren()
  for (const row of state.logRows) host.append(logItem(row))
  $('log-empty').hidden = state.logRows.length > 0
  const total = Number(got.total) || state.logRows.length
  $('log-count').textContent = state.logRows.length
    ? (total > state.logRows.length ? `最近 ${state.logRows.length} 条 · 共 ${total} 条` : `最近 ${state.logRows.length} 条`)
    : ''
  paintStats()
}

// ---- 每日自动活跃的开关（眼睛在按钮上，不在环境变量里）----
function paintAutoActive() {
  const button = $('auto-active')
  const text = $('auto-active-text')
  if (!button || !text) return
  const s = state.settings
  if (!s) {
    button.hidden = true
    return
  }
  button.hidden = false
  const on = Boolean(s.auto_active)
  const locked = Boolean(s.auto_locked)
  button.classList.toggle('is-on', on)
  button.setAttribute('aria-pressed', String(on))
  button.disabled = locked
  button.title = locked
    ? 'ZCODE_CLAIM_AUTO_ACTIVE=0 把定时锁死了；去掉这个环境变量才能从这里打开'
    : on
      ? `开：每天 08:00–09:00 之间自动补报一次活跃（今天排在 ${s.auto_at}）。点一下关掉。`
      : '关：点一下打开，每天 08:00–09:00 随机一分钟自动补报活跃。'
  text.textContent = locked ? '每日活跃 已锁' : on ? `每日活跃 ${s.auto_at}` : '每日活跃 关'
}

// 上一次看过的「自动活跃跑过的时刻」。轮询靠它判断服务端是不是刚跑过一轮。
let autoSeen = 0

async function loadSettings() {
  try {
    state.settings = await api('/api/settings')
  } catch {
    // 读不到就不显示按钮 —— 总比显示一个点了没反应的开关强
    state.settings = null
  }
  autoSeen = Number(state.settings?.auto_last) || 0
  paintAutoActive()
}

async function toggleAutoActive() {
  const button = $('auto-active')
  if (!button || button.disabled) return
  const want = !(state.settings && state.settings.auto_active)
  busyButton(button, true)
  try {
    state.settings = await api('/api/settings', { method: 'POST', body: { auto_active: want } })
  } catch (error) {
    toast(error.message, true)
  } finally {
    // busyButton 会把 disabled 解开，所以重画一次才对：env 锁死时它得弹回去
    busyButton(button, false)
    paintAutoActive()
  }
  if (state.settings && state.settings.auto_active === want) {
    toast(want ? `已开：每天 ${state.settings.auto_at} 自动补报活跃` : '已关掉每日自动活跃')
  }
}

// 自动活跃是服务端定时器，页面可能一开就是一整天。每分钟看一眼它跑过没有 ——
// 跑过就整页重画（卡片上的「活跃 ✓/✗」和下方记录都要跟着变）。
// 只看本地端点，不碰上游，所以不算「轮询营销 feed」。
async function watchAuto() {
  if (document.hidden) return
  try {
    const s = await api('/api/settings')
    const last = Number(s.auto_last) || 0
    const ran = last > autoSeen && last > 0
    autoSeen = last
    const switched = state.settings && state.settings.auto_active !== s.auto_active
    state.settings = s
    if (switched) paintAutoActive()
    if (ran) {
      await load()
      const { auto_last_ok: ok = 0, auto_last_failed: bad = 0 } = s
      toast(bad ? `每日活跃：${ok} 个已报，${bad} 个失败` : `每日活跃：${ok} 个账号已自动补报`, Boolean(bad))
    }
  } catch {
    /* 轮询失败不打扰用户：下一分钟再试 */
  }
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
    await Promise.all([loadLog(), loadSettings()])
  } catch (error) {
    $('accounts').replaceChildren()
    say(`读取失败：${error.message}`)
    toast(error.message, true)
  } finally {
    busyButton(refresh, false)
  }
}

$('refresh').addEventListener('click', () => { void load() })
$('auto-active').addEventListener('click', () => { void toggleAutoActive() })

// 滚起来之后顶栏落一道阴影，内容从下面穿过去时有层次
const onScroll = () => document.body.classList.toggle('is-scrolled', window.scrollY > 4)
window.addEventListener('scroll', onScroll, { passive: true })
onScroll()

// 每日自动活跃跑在服务端：页面开着的时候得自己发现它跑过了
setInterval(() => { void watchAuto() }, 60_000)
document.addEventListener('visibilitychange', () => { if (!document.hidden) void watchAuto() })

void load()