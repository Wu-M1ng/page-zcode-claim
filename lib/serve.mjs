// 独立运行：node lib/serve.mjs [--port 3527]
// 不经过 magpie 也能起服务，用来在浏览器里直接调试页面。
import { startServer } from './server.mjs'

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const port = Number(arg('port', process.env.ZCODE_CLAIM_PORT || 3527))
// --host 0.0.0.0 可以让局域网/反代访问（服务器上调试页面时用；magpie 里对应 bind 选项）
const host = arg('host', process.env.ZCODE_CLAIM_HOST || '')
const info = await startServer({ port: Number.isInteger(port) && port > 0 ? port : 3527, host })
console.log(`[zcode-claim] http://${info.bind === '0.0.0.0' ? '127.0.0.1' : info.bind}:${info.port}/  （监听 ${info.bind}:${info.port}，配置目录 ${info.config}）`)
// 口令已经注入页面，浏览器直接开就行；只有需要命令行调接口时才加 --key 打出来
if (process.argv.includes('--key')) console.log(`[zcode-claim] 页面口令：${info.key}`)