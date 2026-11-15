// magpie 的页面框架是 sandbox="allow-scripts"：文档是 opaque origin，
// document.cookie 与 localStorage 都会抛 SecurityError。
// 阿里云无痕组件两样都用（它要存 _c_* 与 _l_* 这类设备标记），
// 所以必须在它加载之前垫一层内存实现，否则 SDK 初始化直接崩、按钮点了没反应。
//
// 实测（magpie 0.1.3832 / Chromium）：
//   不装垫片 → cookie:"throws:SecurityError" localStorage:"throws:SecurityError"，init 失败
//   装垫片   → cookie:"string" localStorage:"object"，SDK 正常取到真票（280 字符）
;(() => {
  if (window.__zcodeClaimShimmed) return
  window.__zcodeClaimShimmed = true

  const memoryStorage = () => {
    const map = new Map()
    return {
      getItem: (key) => (map.has(String(key)) ? map.get(String(key)) : null),
      setItem: (key, value) => void map.set(String(key), String(value)),
      removeItem: (key) => void map.delete(String(key)),
      clear: () => map.clear(),
      key: (index) => [...map.keys()][index] ?? null,
      get length() {
        return map.size
      },
    }
  }

  for (const name of ['localStorage', 'sessionStorage']) {
    let usable = false
    try {
      usable = typeof window[name] === 'object' && window[name] !== null
      if (usable) window[name].getItem('__zcode_probe__')
    } catch {
      usable = false
    }
    if (usable) continue
    Object.defineProperty(window, name, { configurable: true, get: () => (window[`__zcode_claim_${name}`] ??= memoryStorage()) })
  }

  const jar = new Map()
  let cookieUsable = false
  try {
    cookieUsable = typeof document.cookie === 'string'
  } catch {
    cookieUsable = false
  }
  if (!cookieUsable) {
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; '),
      set: (raw) => {
        const pair = String(raw).split(';')[0]
        const at = pair.indexOf('=')
        if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim())
      },
    })
  }
})()