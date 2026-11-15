// 插件的宿主部分：magpie 的 Bun 宿主加载本模块，向它要页面服务。
// 服务跑在宿主进程里；magpie 停掉插件或窗口时一起停。
import { startServer } from './lib/server.mjs'

let started = null

export default {
  id: 'magpie-zcode-claim',
  // server(input, options)：input 由 magpie 给（directory=配置目录、client.auth=账号的读写口），
  // options 是插件页面上保存的选项。
  server: async (input, options) => {
    if (!started) {
      // 端口 0 或非法值归成 undefined：页面与这里读的是同一份 options。
      const value = Number(options?.port)
      const port = Number.isInteger(value) && value > 0 && value < 65536 ? value : undefined
      started = startServer({
        port,
        directory: input?.directory,
        auth: input?.client?.auth,
        options: { option: input?.magpie?.option },
      }).catch((error) => {
        started = null
        throw error
      })
    }
    await started
    return {}
  },
}