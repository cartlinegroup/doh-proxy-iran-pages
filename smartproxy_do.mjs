export class SmartProxyDO {
  constructor(state, env) {
    this.state = state
    this.env = env
    this.cache = {
      stats: { total: 0, blocked: 0, perIP: {}, perHost: {} }
    }
  }

  async fetch(request) {
    const url = new URL(request.url)
    const { pathname, searchParams } = url
    const method = request.method

    if (pathname === "/update") {
      const data = await request.json()
      this.updateStats(data)
      return new Response("ok", { status: 200 })
    }

    if (pathname === "/stats") {
      return new Response(JSON.stringify(this.cache.stats, null, 2), {
        headers: { "Content-Type": "application/json" },
      })
    }

    if (pathname === "/reset" && method === "POST") {
      this.cache.stats = { total: 0, blocked: 0, perIP: {}, perHost: {} }
      return new Response("reset done", { status: 200 })
    }

    return new Response("SmartProxy Durable Object", { status: 200 })
  }

  updateStats({ ip, host, blocked = false }) {
    const stats = this.cache.stats
    stats.total++
    if (blocked) stats.blocked++
    stats.perIP[ip] = (stats.perIP[ip] || 0) + 1
    stats.perHost[host] = (stats.perHost[host] || 0) + 1
  }
}
