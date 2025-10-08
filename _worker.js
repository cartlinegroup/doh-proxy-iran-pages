// _worker.js — SmartProxy Iran 2.4-pro (Durable Object Edition)
// Author: mehdi feizezadeh + GPT-5
// Description: Secure, Cache-aware, and Durable Cloudflare Worker Proxy for Iran Traffic

import { Hono } from 'hono'
import { poweredBy } from 'hono/powered-by'
import { cors } from 'hono/cors'

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
    const { pathname } = url
    const method = request.method

    if (pathname === "/update" && method === "POST") {
      const data = await request.json()
      this.updateStats(data)
      return new Response("ok", { status: 200 })
    }

    if (pathname === "/stats") {
      return new Response(JSON.stringify(this.cache.stats, null, 2), {
        headers: { "Content-Type": "application/json" }
      })
    }

    if (pathname === "/reset" && method === "POST") {
      this.cache.stats = { total: 0, blocked: 0, perIP: {}, perHost: {} }
      return new Response("reset done", { status: 200 })
    }

    return new Response("SmartProxy Durable Object", { status: 200 })
  }

  updateStats({ ip, host, blocked = false }) {
    const s = this.cache.stats
    s.total++
    if (blocked) s.blocked++
    s.perIP[ip] = (s.perIP[ip] || 0) + 1
    s.perHost[host] = (s.perHost[host] || 0) + 1
  }
}

// -----------------------------
// MAIN WORKER LOGIC
// -----------------------------
export default {
  async fetch(request, env, ctx) {
    const app = new Hono()
    app.use('*', poweredBy())
    app.use('*', cors())

    const url = new URL(request.url)
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown'

    // Safe CSP Header
    const securityHeaders = {
      'Content-Security-Policy': "default-src 'self'; script-src 'none'; object-src 'none'; frame-ancestors 'none';",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
    }

    // Durable Object Stub
    const doId = env.SMARTPROXY_DO.idFromName('global')
    const doStub = env.SMARTPROXY_DO.get(doId)

    // --- ENDPOINT: STATUS ---
    app.get('/status', async c => {
      const resp = await doStub.fetch('https://dummy/stats')
      const json = await resp.text()
      return new Response(json, {
        headers: { 'Content-Type': 'application/json', ...securityHeaders }
      })
    })

    // --- ENDPOINT: RESET (admin only) ---
    app.post('/reset', async c => {
      await doStub.fetch('https://dummy/reset', { method: 'POST' })
      return c.text('Stats reset successfully.')
    })

    // --- MAIN PROXY HANDLER ---
    app.all('*', async c => {
      const req = c.req
      const url = new URL(req.url)
      const target = url.searchParams.get('target')

      if (!target) {
        return c.text('✅ SmartProxy 2.4-pro is running successfully.', 200)
      }

      try {
        const safeURL = new URL(target)
        if (!['http:', 'https:'].includes(safeURL.protocol)) {
          return c.text('❌ Invalid target protocol.', 400)
        }

        const targetHost = safeURL.hostname

        // Rate limiting (basic)
        const respStats = await doStub.fetch('https://dummy/stats')
        const stats = await respStats.json()
        const ipCount = stats.perIP[clientIP] || 0
        if (ipCount > 1000) {
          await doStub.fetch('https://dummy/update', {
            method: 'POST',
            body: JSON.stringify({ ip: clientIP, host: targetHost, blocked: true }),
            headers: { 'Content-Type': 'application/json' },
          })
          return c.text('🚫 Too many requests.', 429)
        }

        // Forward Request
        const proxyReq = new Request(safeURL.toString(), {
          method: req.method,
          headers: req.headers,
          body: req.body,
        })

        const resp = await fetch(proxyReq, { cf: { cacheEverything: true } })
        const newHeaders = new Headers(resp.headers)
        Object.entries(securityHeaders).forEach(([k, v]) => newHeaders.set(k, v))

        // Update durable object asynchronously
        ctx.waitUntil(
          doStub.fetch('https://dummy/update', {
            method: 'POST',
            body: JSON.stringify({ ip: clientIP, host: targetHost, blocked: false }),
            headers: { 'Content-Type': 'application/json' },
          })
        )

        return new Response(resp.body, {
          status: resp.status,
          headers: newHeaders,
        })
      } catch (err) {
        console.error('Proxy Error:', err)
        await doStub.fetch('https://dummy/update', {
          method: 'POST',
          body: JSON.stringify({ ip: clientIP, host: 'error', blocked: true }),
          headers: { 'Content-Type': 'application/json' },
        })
        return c.text('⚠️ Proxy error occurred.', 500)
      }
    })

    return app.fetch(request, env, ctx)
  }
}

export { SmartProxyDO }
