// 领卡弹窗：每个账号一行「领取」→ 一个小弹窗，用官方 SDK 取票，票到手立刻提交领取。
// 无框架、无依赖；只依赖本地服务的两个端点：/api/ticket?（场景配置）、/api/claim。
//
// 实测教训（2026-11-15，真 Chromium + 127.0.0.1 原点）：
//  1) SDK 的上报域名是 *.aliyuncs.com（不是 *.aliyun.com）。CSP 少一条 → 请求全被拦
//     → init 13ms 就 INIT_FAIL，但 SDK 仍会 fire 一个 76 字符的假票 {"certifyId","sceneId","isSign"}。
//     用户看到的症状是「点开始验证没反应」：实例没建起来，按钮没有绑定任何处理。
//  2) 真票（二代）= base64({"certifyId","sceneId","isSign","securityToken"})，约 280 字符。
//  3) 本机/IP 上「自动无痕」直接 F001；人工点一下滑块必出真票 → 弹窗必须留人工这一手。
//  4) 票单次、90s 上限（F008/F018/F019）→ 出票即提交，不做「先存着待会再领」。

const SDK_URL = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js'
const READY_DELAY = 2100 // 实例就绪到 startTracelessVerification 的最短间隔（官方要求 > 2s）
const AUTO_WAIT = 15000 // 自动无痕等待上限，超时转人工
const SESSION_TIMEOUT = 600000 // 整个弹窗的总时长上限（10 分钟）：票在，就等你想起来
const VERIFY_CODES = /^[FT][0-9]{3}$/

let sdkLoading = null
function loadSDK() {
  if (typeof window.initAliyunCaptcha === 'function') return Promise.resolve()
  if (!sdkLoading) {
    sdkLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      const timer = setTimeout(() => fail(new Error('验证组件加载超时')), 15000)
      const fail = (error) => { clearTimeout(timer); script.remove(); reject(error) }
      script.src = SDK_URL
      script.async = true
      script.onload = () => {
        clearTimeout(timer)
        if (typeof window.initAliyunCaptcha === 'function') resolve()
        else fail(new Error('验证组件不可用'))
      }
      script.onerror = () => fail(new Error('验证组件加载失败，请检查网络'))
      document.head.append(script)
    }).catch((error) => { sdkLoading = null; throw error })
  }
  return sdkLoading
}

// ticketOf 只认真票。SDK 初始化失败时会 fire 一个形似票据的 76 字符 stub，
// 提交上去必然 3007/F019，白烧一次领取机会，所以这里先挡掉。
export function ticketOf(param, region = 'cn') {
  if (typeof param !== 'string') return null
  const text = param.trim()
  if (text.length < 100 || text.length > 32 * 1024) return null
  let json
  try {
    // base64url → base64 并补齐 padding：atob 不接受长度不是 4 的倍数的输入，
    // 而服务端 Buffer 是宽容的 —— 不补的话两端判定会不一致，
    // 表现为「页面说票无效，服务端说票是好的」，用户白点一次滑块。
    const b64 = text.replace(/-/g, '+').replace(/_/g, '/')
    json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  } catch { return null }
  let value
  try { value = JSON.parse(json) } catch { return null }
  if (!value || typeof value !== 'object' || typeof value.certifyId !== 'string' || !value.certifyId) return null
  // 真票判据：二代带 securityToken，老版带 data/sig；只有 certifyId+sceneId 的短 stub 是初始化失败的假票
  let strong = false
  if (typeof value.securityToken === 'string') strong = value.securityToken.length > 20
  else if (typeof value.data === 'string') strong = value.data.length > 20
  else if (typeof value.sig === 'string') strong = value.sig.length > 0
  return strong ? { param: text, region, certifyId: value.certifyId, sceneId: String(value.sceneId || '') } : null
}

// ---- 小工具：全部走 createElement / textContent，不拼 HTML ----
function el(tag, className, textContent) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (textContent != null) node.textContent = String(textContent)
  return node
}
const codeOf = (value) => {
  const result = value?.Result || value?.result || value || {}
  return String(result.VerifyCode || result.verifyCode || value?.verifyCode || '')
}
const labelOf = (plan) => plan?.name || plan?.plan_id || '卡片'
const endsLine = (plan) => (plan?.ends_at ? ` · 有效期至 ${new Date(plan.ends_at).toLocaleString()}` : '')

function buildDialog(text) {
  const root = el('div', 'zclaim-dialog')
  const mask = el('div', 'zclaim-mask')
  mask.dataset.cancel = ''
  const panel = el('div', 'zclaim-panel')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-label', text.title)
  const header = el('header')
  header.append(el('b', null, text.title), el('span', 'zclaim-account'))
  const planLine = el('p', 'zclaim-plan')
  const mount = el('div', 'zclaim-mount')
  const start = el('button', 'zclaim-start', text.manual)
  start.type = 'button'
  start.hidden = true
  const status = el('p', 'zclaim-status', text.preparing)
  status.setAttribute('role', 'status')
  const progress = el('ul', 'zclaim-progress')
  progress.hidden = true
  const footer = el('footer')
  const cancel = el('button', 'zclaim-cancel', text.cancel)
  cancel.type = 'button'
  cancel.dataset.cancel = ''
  footer.append(cancel)
  panel.append(header, planLine, mount, start, status, progress, footer)
  root.append(mask, panel)
  return { root, panel, planLine, mount, start, status, progress, account: header.querySelector('.zclaim-account') }
}

// openClaimDialog 领取一个账号的所有可领卡：一次一票，串行提交，弹窗里显示进度。
export async function openClaimDialog({ api, account, plans, copy = {} }) {
  const text = {
    title: '领取验证',
    preparing: '正在准备…',
    auto: '正在自动验证…',
    manual: '请按组件提示完成验证。',
    retry: '重新验证',
    reload: '重新加载',
    claiming: '正在领取…',
    cancel: '取消',
    ...copy,
  }
  const jobs = (plans || []).slice()
  const done = []
  const ui = buildDialog(text)
  document.body.append(ui.root)
  ui.account.textContent = account.label || account.email || account.id

  let closed = false
  let instance = null
  let epoch = 0
  const timers = new Set()
  const later = (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id }
  const clearTimers = () => { for (const id of timers) clearTimeout(id); timers.clear() }
  // 结果必须在循环开始前就挂好：弹窗可能在你点滑块之前就被关掉，
  // 那时 finally 里的收尾要能 resolve，否则调用方会一直 await。
  let settledResult = false
  let resolveAll = () => {}
  const outcome = new Promise((resolve) => { resolveAll = resolve })
  const finish = (value) => {
    if (settledResult) return
    settledResult = true
    resolveAll(value)
  }
  // solve() 的 resolve 也必须被兑现。只 resolve 外层 outcome 的后果是：主循环还卡在
  // `await solve()` 上，`finally` 永远不跑，全屏遮罩留在页面上 —— 页面的症状就是
  // 「这个账号一直显示领取中，别的按钮也点不动」。
  let releaseSolve = null

  const state = (message, { error = false, busy = false } = {}) => {
    ui.status.textContent = message
    ui.status.classList.toggle('error', !!error)
    ui.status.setAttribute('aria-busy', String(busy))
  }
  const teardown = () => {
    if (closed) return
    closed = true
    clearTimers()
    try { instance?.destroy?.() } catch { /* SDK 可能已被销毁 */ }
    ui.root.remove()
    window.removeEventListener('pagehide', onLeave)
    document.removeEventListener('keydown', onKey)
    // 叫醒卡在 await solve() 的主循环。set 到 null 再调，重复进来不会有副作用。
    const release = releaseSolve
    releaseSolve = null
    release?.(null)
  }
  const onLeave = () => { teardown(); finish({ ok: false, code: 'canceled', message: '已取消' }) }
  const cancel = () => onLeave()
  // 超时就走正常收尾：票过期了留着弹窗也没用，而「留在弹窗里给人看」正是
  // 上面那个死锁的入口。提示信息不丢 —— claim() 的 result.code === 'expired'
  // 分支会在卡片上写明「验证会话过期，重新点领取会取一张新票」。
  const expire = () => {
    if (closed) return
    finish({ ok: false, code: 'expired', message: '验证会话过期' })
    teardown()
  }
  ui.root.querySelectorAll('[data-cancel]').forEach((node) => node.addEventListener('click', cancel))
  window.addEventListener('pagehide', onLeave)
  const onKey = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); cancel() }
  }
  document.addEventListener('keydown', onKey)
  later(expire, SESSION_TIMEOUT)

  // solve 取一张票：先自动无痕试一次，失败/需要交互就把官方组件摆出来让人点。
  const solve = (job) => new Promise((resolve) => {
    const current = ++epoch
    clearTimers()
    later(expire, SESSION_TIMEOUT)
    try { instance?.destroy?.() } catch { /* 同上 */ }
    instance = null
    ui.mount.replaceChildren()
    const holder = el('div')
    holder.id = `zclaim-captcha-${current}`
    ui.mount.append(holder)
    // 换节点：清掉旧监听，避免上一次验证的点击重复提交
    const button = el('button', 'zclaim-start', text.preparing)
    button.type = 'button'
    button.disabled = true
    ui.start.replaceWith(button)
    ui.start = button
    state(text.preparing, { busy: true })

    let manual = false
    let verifying = false
    let ready = false
    let settled = false
    const live = () => !closed && current === epoch && !settled
    // 交给 teardown 的统一句柄：关窗/超时时它会把这里叫醒
    releaseSolve = resolve
    const settle = (value) => {
      if (!live()) return
      settled = true
      releaseSolve = null
      resolve(value)
    }

    const toManual = (message, value) => {
      if (!live()) return
      manual = true
      verifying = false
      const code = codeOf(value)
      state(message + (VERIFY_CODES.test(code) ? `（${code}）` : ''), { error: true })
      button.hidden = false
      button.disabled = !ready
      button.textContent = ready ? text.retry : text.reload
      try { instance?.show?.() } catch { /* 供交互验证的组件可能不存在 */ }
    }

    const adopt = (param) => {
      if (!live()) return
      const ticket = ticketOf(param, job.region)
      if (!ticket) { toManual('验证未返回有效票据，请重新验证'); return }
      state(text.claiming, { busy: true })
      settle(ticket)
    }

    button.addEventListener('click', () => {
      if (!live() || !instance) { if (live()) void begin(); return }
      if (verifying) return
      verifying = true
      state(text.manual, { busy: true })
      try { instance.show?.() } catch { /* 无交互形态时只能等 auto 分支 */ }
    })

    async function begin() {
      button.disabled = true
      button.textContent = text.preparing
      await loadSDK()
      if (!live()) return
      window.AliyunCaptchaConfig = { region: job.region, prefix: job.prefix }
      const startedAt = Date.now()
      const init = window.initAliyunCaptcha({
        SceneId: job.scene_id,
        mode: 'popup',
        element: `#zclaim-captcha-${current}`,
        button,
        language: 'zh',
        delayBeforeSuccess: false,
        success: (param) => adopt(param),
        fail: (value) => toManual('验证未通过，请点一下组件重新验证', value),
        onError: () => toManual('验证组件异常，请重新加载'),
        onClose: (reason) => { if (reason === 'userDismiss' && manual) toManual('已关闭验证窗口，请重新验证') },
        getInstance: (value) => {
          if (!live()) { try { value?.destroy?.() } catch { /* 同上 */ } return }
          if (!value) { toManual('验证组件未能初始化'); return }
          if (instance) { if (value !== instance) { try { value.destroy?.() } catch { /* 同上 */ } } return }
          instance = value
          state('准备验证…', { busy: true })
          const wait = Math.max(0, READY_DELAY - (Date.now() - startedAt))
          later(() => {
            if (!live() || !instance) return
            ready = true
            const automatic = typeof instance.startTracelessVerification === 'function'
            if (manual || !automatic) {
              button.disabled = false
              button.hidden = false
              toManual(text.manual)
              return
            }
            state(text.auto, { busy: true })
            let tried = false
            const fallback = () => {
              if (tried) return
              tried = true
              toManual('自动验证未完成，请手动完成验证')
            }
            later(fallback, AUTO_WAIT)
            try { Promise.resolve(instance.startTracelessVerification()).catch(fallback) } catch { fallback() }
          }, wait)
        },
      })
      Promise.resolve(init).catch(() => toManual('验证组件初始化失败，请重新加载'))
    }
    begin().catch((error) => toManual(error?.message || '验证组件加载失败'))
  })

  // 一票一卡：取票 → 立刻提交 → 记进度
  const runJob = async (job) => {
    ui.planLine.textContent = `${labelOf(job)}${endsLine(job)}`
    const ticket = await solve(job)
    if (!ticket || closed) return null
    state(text.claiming, { busy: true })
    return api('/api/claim', { method: 'POST', body: { account: account.id, plan: job.plan_id, name: labelOf(job), ...ticket } })
  }

  const renderProgress = () => {
    ui.progress.hidden = false
    ui.progress.replaceChildren()
    done.forEach((row, index) => {
      const name = row.name || row.plan || '卡片'
      const said = row.ok ? '已领取' : (row.message || row.code || '失败')
      ui.progress.append(el('li', null, `${index + 1}. ${name} — ${said}`))
    })
  }

  try {
    for (const job of jobs) {
      if (closed) break
      const result = await runJob(job)
      if (!result) break
      done.push({ name: labelOf(job), plan: job.plan_id, ...result })
      renderProgress()
      if (!result.ok && !result.requires_verification) break
      if (result.requires_verification) break
    }
  } catch (error) {
    done.push({ ok: false, error: String(error?.message || error) })
  } finally {
    const claimed = done.filter((row) => row.ok).length
    const ok = done.length === jobs.length && claimed === jobs.length
    teardown()
    finish({ ok, claimed, results: done })
  }
  return outcome
}