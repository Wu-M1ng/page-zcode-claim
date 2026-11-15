// 插件的宿主部分：magpie 的 Bun 宿主加载本模块，向它要页面服务。
// 服务跑在宿主进程里；magpie 停掉插件或窗口时一起停。
import { startServer } from './lib/server.mjs'

let started = null

export default {
  id: 'magpie-zcode-claim',
  // server(input, options)：input 由 magpie 给（directory=配置目录），
  // options 是插件页面上保存的选项。
  server: async (input, options) => {
    if (!started) {
      // 端口 0 或非法值归成 undefined：页面与这里读的是同一份 options。
      const value = Number(options?.port)
      const port = Number.isInteger(value) && value > 0 && value < 65536 ? value : undefined
      // bind：默认只听回环。服务器/Docker 里要让局域网或反代访问时设成 0.0.0.0。
      // 页面口令、Host 与 Origin 校验都还在，所以放宽监听地址不等于把接口敞开。
      started = startServer({
        port,
        host: options?.bind,
        directory: input?.directory,
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