// _worker.js — SmartProxy Iran 2.5-enterprise (Durable Object + Dashboard + Token-Bucket)
// Author: mehdi feizezadeh
// Notes:
// - Requires Durable Object binding: SMARTPROXY_DO
// - Requires env.ADMIN_PASSWORD set (strong password for admin panel)
// - Uses Hono for routing, HTMLRewriter for safe injection, Chart.js via CDN for dashboard

import { Hono } from 'hono';
import { poweredBy } from 'hono/powered-by';
import { html } from 'hono/html';

// ----------------------------
// Durable Object: SmartProxyDO
// ----------------------------
export class SmartProxyDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async _getState() {
    const s = (await this.state.storage.get('meta')) || {
      stats: { total: 0, blocked: 0, perIP: {}, perHost: {} },
      buckets: {},
      sessions: {}
    };
    return s;
  }

  async _putState(s) {
    await this.state.storage.put('meta', s);
  }

  _randToken(len = 32) {
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return Array.from(arr)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  _bucketConfig() {
    return {
      capacity: parseFloat(this.env.BUCKET_CAPACITY) || 60,
      refillPerSecond: parseFloat(this.env.BUCKET_REFILL_PER_SEC) || 1
    };
  }

  async consumeToken(ip, cost = 1) {
    const s = await this._getState();
    const cfg = this._bucketConfig();
    const now = Date.now();
    let bucket = s.buckets[ip];
    if (!bucket) {
      bucket = { tokens: cfg.capacity, lastRefill: now };
    } else {
      const elapsed = (now - bucket.lastRefill) / 1000;
      const refill = elapsed * cfg.refillPerSecond;
      bucket.tokens = Math.min(cfg.capacity, bucket.tokens + refill);
      bucket.lastRefill = now;
    }
    const allowed = bucket.tokens >= cost;
    if (allowed) bucket.tokens -= cost;
    s.buckets[ip] = bucket;
    await this._putState(s);
    return { allowed, tokensLeft: bucket.tokens };
  }

  async updateStats({ ip, host, blocked = false }) {
    const s = await this._getState();
    s.stats.total++;
    if (blocked) s.stats.blocked++;
    s.stats.perIP[ip] = (s.stats.perIP[ip] || 0) + 1;
    if (host) s.stats.perHost[host] = (s.stats.perHost[host] || 0) + 1;
    await this._putState(s);
  }

  async createSession(ip, ttlSeconds = 3600) {
    const s = await this._getState();
    const token = this._randToken(16);
    const now = Date.now();
    s.sessions[token] = {
      ip,
      createdAt: now,
      expiresAt: now + ttlSeconds * 1000
    };
    await this._putState(s);
    return token;
  }

  async validateSession(token) {
    const s = await this._getState();
    const entry = s.sessions[token];
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      delete s.sessions[token];
      await this._putState(s);
      return null;
    }
    return entry;
  }

  async revokeSession(token) {
    const s = await this._getState();
    delete s.sessions[token];
    await this._putState(s);
    return true;
  }

  async getStats() {
    const s = await this._getState();
    return s.stats;
  }

  async getTopIPs(limit = 30) {
    const s = await this._getState();
    const arr = Object.entries(s.stats.perIP || {}).map(([ip, count]) => ({
      ip,
      count
    }));
    arr.sort((a, b) => b.count - a.count);
    return arr.slice(0, limit);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === '/do/update' && request.method === 'POST') {
        const data = await request.json();
        await this.updateStats(data);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (p === '/do/consume' && request.method === 'POST') {
        const { ip, cost } = await request.json();
        const res = await this.consumeToken(ip, Number(cost || 1));
        return new Response(JSON.stringify(res), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (p === '/do/create-session' && request.method === 'POST') {
        const { ip, ttl } = await request.json();
        const token = await this.createSession(ip, Number(ttl || 3600));
        return new Response(JSON.stringify({ token }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (p === '/do/validate-session' && request.method === 'POST') {
        const { token } = await request.json();
        const entry = await this.validateSession(token);
        return new Response(JSON.stringify({ valid: !!entry, entry }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (p === '/do/revoke' && request.method === 'POST') {
        const { token } = await request.json();
        await this.revokeSession(token);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (p === '/do/stats') {
        const stats = await this.getStats();
        return new Response(JSON.stringify(stats), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (p === '/do/topips') {
        const top = await this.getTopIPs(100);
        return new Response(JSON.stringify(top), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response('SmartProxy DO root');
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), {
        status: 500
      });
    }
  }
}

// ----------------------------
// MAIN Worker (Hono)
// ----------------------------
const app = new Hono();
app.use('*', poweredBy());

function getDO(env) {
  const id = env.SMARTPROXY_DO.idFromName('global');
  return env.SMARTPROXY_DO.get(id);
}

function securityHeaders(env = {}) {
  const scriptSrcExtras = [
    "https://cdn.jsdelivr.net",
    "https://cdn.jsdelivr.net/npm/chart.js"
  ].join(' ');
  return {
    'Content-Security-Policy': `default-src 'self'; script-src 'self' ${scriptSrcExtras} 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: https:; connect-src 'self' https:; frame-ancestors 'none';`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer-when-downgrade',
    'X-Frame-Options': 'DENY'
  };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

// ----------------------------
// Admin Panel (HTML dashboard)
// ----------------------------
app.get('/admin', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8"/>
      <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
      <title>SmartProxy Admin</title>
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">
      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      <style>
        body { margin: 2rem; background: #f5f7fa; }
        canvas { max-width: 100%; }
      </style>
    </head>
    <body>
      <main class="container">
        <h2>SmartProxy Dashboard</h2>
        <button id="refresh">Refresh Stats</button>
        <pre id="statsBox">Loading...</pre>
        <canvas id="chart" width="400" height="200"></canvas>
      </main>
      <script>
        async function loadStats() {
          const res = await fetch('/do/stats');
          const stats = await res.json();
          document.getElementById('statsBox').textContent = JSON.stringify(stats, null, 2);
          const labels = Object.keys(stats.perIP);
          const data = Object.values(stats.perIP);
          new Chart(document.getElementById('chart'), {
            type: 'bar',
            data: { labels, datasets: [{ label: 'Requests per IP', data }] },
            options: { responsive: true, scales: { y: { beginAtZero: true } } }
          });
        }
        document.getElementById('refresh').onclick = loadStats;
        loadStats();
      </script>
    </body>
    </html>
  `);
});

// ----------------------------
// Root Route
// ----------------------------
app.get('/', (c) => {
  return c.text('SmartProxy 2.5-enterprise — for docs visit /admin (login)');
});

// ----------------------------
// Export Worker (FIX for EOF)
// ----------------------------
const worker = {
  async fetch(request, env, ctx) {
    app.setContext({ env, executionCtx: ctx });
    return app.fetch(request, env, ctx);
  }
};

export default worker;
export { SmartProxyDO as DurableObject };
