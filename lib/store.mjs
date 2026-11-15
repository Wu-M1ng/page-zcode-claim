// 账号来源：magpie 的 plugin-auth.json（只读）+ 插件目录下的 accounts.json（只读）。
// 插件**不写**凭据：不碰 magpie 的文件，也不接受页面提交的 jwt。
//
// magpie 把每个 OAuth 账号存成 {"<provider>#<name>": {type, refresh, access, accountId, uid}}，
// 其中 refresh 是插件自己写的 JSON 字符串。ZCode 的 refresh 里就有
// {site, base, key, jwt, device, plan} —— 领卡要的 jwt 与 device 全在里面。
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** magpie 配置目录：宿主给的 input.directory 优先，其次 cwd（便携版），最后 ~/.config/magpie。 */
export function configDir(given) {
  if (given && existsSync(join(given, 'plugin-auth.json'))) return given
  const env = process.env.MAGPIE_CONFIG_DIR
  if (env && isAbsolute(env)) return env
  try {
    const cwd = process.cwd()
    for (const f of ['plugin-auth.json', 'plugins.json', 'providers.json']) {
      if (existsSync(join(cwd, f))) return cwd
    }
  } catch {
    /* cwd 可能不可读 */
  }
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg && isAbsolute(xdg)) return join(xdg, 'magpie')
  return join(homedir(), '.config', 'magpie')
}

/** 插件自己的目录（导入的账号、领取记录）。 */
export function dataDir(dir) {
  const target = join(dir, 'zcode-claim')
  mkdirSync(target, { recursive: true, mode: 0o700 })
  return target
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** JWT 的过期时间（毫秒）；没有 exp 的当长期有效，返回 0。 */
export function jwtExpiresAt(jwt) {
  try {
    const payload = String(jwt).split('.')[1]
    const value = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    return Number(value?.exp) > 0 ? Number(value.exp) * 1000 : 0
  } catch {
    return 0
  }
}

/** 把一条 magpie auth 记录摊平成领卡要用的字段；认不出返回 null。 */
export function accountOf(id, entry) {
  if (!entry || typeof entry !== 'object') return null
  if (!String(id).startsWith('zcode')) return null
  let state
  try {
    state = typeof entry.refresh === 'string' ? JSON.parse(entry.refresh) : entry.refresh
  } catch {
    return null
  }
  const jwt = typeof state?.jwt === 'string' ? state.jwt.trim() : ''
  if (!jwt) return null
  const site = state?.site === 'bigmodel' ? 'bigmodel' : 'zai'
  // 国际站（zai）的 accountId 是邮箱，国内站（bigmodel）是用户名：分开存，别硬塞进 email
  const accountId = String(entry.accountId || '')
  const suffix = String(id).includes('#') ? String(id).split('#').slice(1).join('#') : ''
  return {
    id: String(id),
    name: suffix || accountId || String(id),
    email: accountId.includes('@') ? accountId : '',
    handle: accountId,
    site,
    base: String(state?.base || ''),
    key: String(state?.key || ''),
    jwt,
    device: String(state?.device || ''),
    plan: String(state?.plan || ''),
    expiresAt: jwtExpiresAt(jwt),
    source: 'magpie',
  }
}

/** magpie 记着的 ZCode 账号（只读，不写回 magpie 的文件）。 */
export function magpieAccounts(dir) {
  const all = readJSON(join(dir, 'plugin-auth.json'), {})
  const out = []
  for (const [id, entry] of Object.entries(all)) {
    const account = accountOf(id, entry)
    if (account) out.push(account)
  }
  return out
}

/** 插件自己导入的账号（粘贴 blob 或手工填 jwt 时用）。 */
export function importedAccounts(dir) {
  const all = readJSON(join(dataDir(dir), 'accounts.json'), {})
  const out = []
  for (const [id, entry] of Object.entries(all)) {
    const account = accountOf(id, entry)
    if (account) out.push({ ...account, source: 'imported' })
  }
  return out
}

/** 两个来源合并：同一个 id 以 magpie 的为准（插件里刷新过 token）。 */
export function accounts(dir) {
  const byId = new Map()
  for (const account of magpieAccounts(dir)) byId.set(account.id, account)
  for (const account of importedAccounts(dir)) if (!byId.has(account.id)) byId.set(account.id, account)
  return [...byId.values()]
}

export function findAccount(dir, id) {
  return accounts(dir).find((account) => account.id === id) ?? null
}
