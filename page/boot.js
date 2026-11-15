// 带路页：把 magpie 的框架导航到本插件的页面服务。
//
// 这一页的 CSP 是 magpie 给的（connect-src 'none'），所以**不能探测、不能 fetch，只能跳转**。
// 踩过的坑：不要把跳转压在桥接上 —— 服务器上的 magpie（magpie web、没有窗口的场景）
// 可能永远不回 ready，那样页面会永远停在「正在连接本地领卡服务…」。所以每个桥接调用都限时，
// 拿不到就按默认值继续跳；语言也先用 navigator.language 猜一份。
(async () => {
  const DEFAULT_PORT = 3527
  const words = {
    en: {
      title: 'ZCode Claim',
      connecting: 'Connecting to the local claim service...',
      mixed: (port) => `This page is https, so the browser refuses to jump to http://127.0.0.1:${port} (mixed content). Open the page from the machine running magpie, or from an http address.`,
      lan: (port) => `Jumping to this machine at port ${port}. If it does not connect, the service is listening on 127.0.0.1 only: set the "bind" option to 0.0.0.0 and reload the plugin.`,
      retry: 'Retry',
    },
    zh: {
      title: 'ZCode 领卡中心',
      connecting: '正在连接本地领卡服务…',
      mixed: (port) => `这个页面是 https，浏览器不允许跳到 http://127.0.0.1:${port}（混合内容被拦）。请在运行 magpie 的那台机器上打开，或用 http 地址访问。`,
      lan: (port) => `正在跳到这台机器的 ${port} 端口。连不上就是服务只听了 127.0.0.1：把「bind」选项改成 0.0.0.0 再重载插件。`,
      retry: '重试',
    },
  }

  const state = { port: DEFAULT_PORT, theme: 'light', lang: 'en', tokens: null, service: '', navigated: false }
  const el = (id) => document.getElementById(id)
  const say = (text) => {
    const node = el('said')
    if (node) node.textContent = text
  }

  // 桥接只是锦上添花：限时内不回就当它不存在，绝不让页面卡在这上面
  const within = async (value, ms) => {
    let timer
    try {
      return await Promise.race([
        Promise.resolve(value).then((v) => v, () => undefined),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(undefined), ms)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  const followLanguage = (value) => {
    state.lang = String(value || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
    const text = words[state.lang]
    document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'en'
    document.title = text.title
    const title = el('title')
    if (title) title.textContent = text.title
    say(text.connecting)
    const retry = el('retry')
    if (retry) retry.textContent = text.retry
  }

  const go = (url) => {
    if (state.navigated) return
    state.navigated = true
    location.replace(url)
  }

  followLanguage(navigator.language)

  const retry = el('retry')
  if (retry) {
    retry.hidden = false
    retry.addEventListener('click', () => location.reload())
  }

  const current = await within(window.magpie?.ready, 900)
  if (current) {
    state.theme = current.dark ? 'dark' : 'light'
    if (current.lang) followLanguage(current.lang)
    state.tokens = current.tokens || null
  }

  const options = await within(window.magpie?.options?.get?.(), 600)
  const value = Number(options?.port)
  if (Number.isInteger(value) && value > 0 && value < 65536) state.port = value

  const service = window.magpie?.service
  if (typeof service === 'string' && /^https?:\/\//.test(service)) state.service = service

  try {
    window.magpie?.onTheme?.((next) => {
      if (!next) return
      if (typeof next.dark === 'boolean') state.theme = next.dark ? 'dark' : 'light'
      if (typeof next.lang === 'string' && String(next.lang).toLowerCase().startsWith('zh') !== (state.lang === 'zh')) {
        followLanguage(next.lang)
      }
    })
  } catch {
    // 没有桥接时页面照样能用
  }

  const query = new URLSearchParams()
  query.set('theme', state.theme)
  query.set('lang', state.lang)
  // 每次打开都换一个地址，浏览器不会拿缓存里的旧文档（旧口令）来用
  query.set('_', String(Date.now()))
  if (state.tokens && typeof state.tokens === 'object') {
    try {
      const slim = {}
      for (const [key, value] of Object.entries(state.tokens)) {
        const text = String(value ?? '').trim()
        if (text) slim[key] = text
      }
      if (Object.keys(slim).length) query.set('tokens', btoa(unescape(encodeURIComponent(JSON.stringify(slim)))))
    } catch {
      // 主题色带不过去就用页面自己的
    }
  }
  const at = (base) => `${base}/?${query.toString()}`

  // 1) magpie web / 反代：magpie 自己知道服务在哪，这条最稳（同源同 scheme，不会有混合内容）
  if (state.service) return go(at(state.service.replace(/\/+$/, '')))

  const host = String(location.hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  const local = !host || host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host)
  const secure = location.protocol === 'https:'

  // 2) https 页面跳 http 的回环地址会被当混合内容拦掉，说清楚，别让用户对着「正在连接…」发呆
  if (secure) return say(words[state.lang].mixed(state.port))

  // 3) 局域网 / Docker：跳这台机器自己的地址（服务要 bind 到局域网地址，默认只听 127.0.0.1）
  if (!local) {
    say(words[state.lang].lan(state.port))
    return go(at(`http://${location.hostname}:${state.port}`))
  }

  // 4) 桌面窗口、端口转发：回环
  say(words[state.lang].connecting)
  go(at(`http://127.0.0.1:${state.port}`))
})()
