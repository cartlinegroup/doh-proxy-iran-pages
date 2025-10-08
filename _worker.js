// _worker.js — SmartProxy Iran 2.5-enterprise (Durable Object + Dashboard + Token-Bucket)
// Author: mehdi feizezadeh + GPT-5 Thinking mini
// Notes:
// - Requires Durable Object binding: SMARTPROXY_DO
// - Requires env.ADMIN_PASSWORD set (strong password for admin panel)
// - Uses Hono for routing, HTMLRewriter for safe injection, Chart.js via CDN for dashboard

import { Hono } from 'hono';
import { poweredBy } from 'hono/powered-by';
import { html } from 'hono/html';

// ----------------------------
// Durable Object: SmartProxyDO
// Responsibilities:
//  - Persistent stats: total, perIP, perHost
//  - Token-bucket per IP for rate-limiting
//  - Admin sessions (token -> ip) with TTL
// ----------------------------
export class SmartProxyDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // init once
  }

  // helper: read JSON state or default
  async _getState() {
    const s = (await this.state.storage.get('meta')) || {
      stats: { total: 0, blocked: 0, perIP: {}, perHost: {} },
      buckets: {},   // ip -> { tokens, lastRefill }
      sessions: {}   // token -> { ip, createdAt, expiresAt }
    };
    return s;
  }

  async _putState(s) {
    await this.state.storage.put('meta', s);
  }

  // Generate a random token (hex)
  _randToken(len = 32) {
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');
  }

  // Token bucket: capacity and refillRate per second configurable by env or defaults
  _bucketConfig() {
    return {
      capacity: parseFloat(this.env.BUCKET_CAPACITY) || 60, // tokens
      refillPerSecond: parseFloat(this.env.BUCKET_REFILL_PER_SEC) || 1 // tokens/sec
    };
  }

  // Check and consume tokens for ip; returns { allowed: bool, tokensLeft }
  async consumeToken(ip, cost = 1) {
    const s = await this._getState();
    const cfg = this._bucketConfig();
    const now = Date.now();
    const key = ip;
    let bucket = s.buckets[key];
    if (!bucket) {
      bucket = { tokens: cfg.capacity, lastRefill: now };
    } else {
      // refill
      const elapsed = (now - bucket.lastRefill) / 1000;
      const refill = elapsed * cfg.refillPerSecond;
      bucket.tokens = Math.min(cfg.capacity, bucket.tokens + refill);
      bucket.lastRefill = now;
    }
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      s.buckets[key] = bucket;
      await this._putState(s);
      return { allowed: true, tokensLeft: bucket.tokens };
    } else {
      s.buckets[key] = bucket;
      await this._putState(s);
      return { allowed: false, tokensLeft: bucket.tokens };
    }
  }

  // Update stats (ip, host, blocked flag)
  async updateStats({ ip, host, blocked = false }) {
    const s = await this._getState();
    s.stats.total = (s.stats.total || 0) + 1;
    if (blocked) s.stats.blocked = (s.stats.blocked || 0) + 1;
    s.stats.perIP[ip] = (s.stats.perIP[ip] || 0) + 1;
    if (host) s.stats.perHost[host] = (s.stats.perHost[host] || 0) + 1;
    await this._putState(s);
  }

  // Admin session: create, validate, revoke
  async createSession(ip, ttlSeconds = 3600) {
    const s = await this._getState();
    const token = this._randToken(16);
    const now = Date.now();
    s.sessions[token] = { ip, createdAt: now, expiresAt: now + ttlSeconds * 1000 };
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
    const arr = Object.entries(s.stats.perIP || {}).map(([ip, count]) => ({ ip, count }));
    arr.sort((a,b) => b.count - a.count);
    return arr.slice(0, limit);
  }

  // handler for fetch from Worker (we treat path-based API)
  async fetch(request) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // small router
    if (pathname === '/do/update' && request.method === 'POST') {
      try {
        const data = await request.json();
        await this.updateStats(data);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' }});
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 400, headers: { 'Content-Type': 'application/json' }});
      }
    }

    if (pathname === '/do/consume' && request.method === 'POST') {
      try {
        const { ip, cost } = await request.json();
        const res = await this.consumeToken(ip, Number(cost || 1));
        return new Response(JSON.stringify(res), { status: 200, headers: { 'Content-Type': 'application/json' }});
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 400, headers: { 'Content-Type': 'application/json' }});
      }
    }

    if (pathname === '/do/create-session' && request.method === 'POST') {
      const { ip, ttl } = await request.json();
      const token = await this.createSession(ip, Number(ttl || 3600));
      return new Response(JSON.stringify({ token }), { status: 200, headers: { 'Content-Type': 'application/json' }});
    }

    if (pathname === '/do/validate-session' && request.method === 'POST') {
      const { token } = await request.json();
      const entry = await this.validateSession(token);
      return new Response(JSON.stringify({ valid: !!entry, entry }), { status: 200, headers: { 'Content-Type': 'application/json' }});
    }

    if (pathname === '/do/stats') {
      const stats = await this.getStats();
      return new Response(JSON.stringify(stats, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' }});
    }

    if (pathname === '/do/topips') {
      const top = await this.getTopIPs(100);
      return new Response(JSON.stringify(top, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' }});
    }

    return new Response('SmartProxy DO root', { status: 200 });
  }
}

// ----------------------------
// MAIN Worker (Hono) — routes and logic
// ----------------------------
const app = new Hono();
app.use('*', poweredBy());

// Helper: get DO stub from env
function getDO(env) {
  const id = env.SMARTPROXY_DO.idFromName('global');
  return env.SMARTPROXY_DO.get(id);
}

// Security headers and CSP with Chart.js CDN allowed
function securityHeaders(env = {}) {
  const scriptSrcExtras = [
    "https://cdn.jsdelivr.net", // Chart.js CDN (we'll use jsdelivr)
    "https://cdn.jsdelivr.net/npm/chart.js"
  ].join(' ');
  return {
    'Content-Security-Policy': `default-src 'self'; script-src 'self' ${scriptSrcExtras} 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: https:; connect-src 'self' https:; frame-ancestors 'none';`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer-when-downgrade',
    'X-Frame-Options': 'DENY',
  };
}

// CORS simple helper
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

// Basic anti-open-redirect check
function isSafeRedirectUrl(u) {
  try {
    const parsed = new URL(u);
    // only allow https absolute URLs
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// Helper: forward stats update to DO (async)
async function recordHit(env, ip, host, blocked = false) {
  try {
    const doStub = getDO(env);
    await doStub.fetch('https://do/do/update', {
      method: 'POST',
      body: JSON.stringify({ ip, host, blocked }),
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    // swallow — DO might be cold
    console.error('recordHit error', e);
  }
}

// Helper: attempt token consume via DO
async function consumeTokenDO(env, ip, cost = 1) {
  try {
    const doStub = getDO(env);
    const resp = await doStub.fetch('https://do/do/consume', {
      method: 'POST',
      body: JSON.stringify({ ip, cost }),
      headers: { 'Content-Type': 'application/json' }
    });
    if (!resp.ok) return { allowed: true, tokensLeft: 999 }; // fail-open
    return await resp.json();
  } catch (e) {
    console.error('consumeTokenDO error', e);
    return { allowed: true, tokensLeft: 999 };
  }
}

// Admin authentication: UI posts password -> DO creates session -> returns token cookie
app.get('/admin', async c => {
  const env = c.env;
  const sh = securityHeaders(env);
  // simple login page (if already logged in, redirect to dashboard)
  const cookie = c.req.headers.get('Cookie') || '';
  const match = cookie.match(/sp_sess=([a-f0-9]+)/);
  if (match) {
    // validate session with DO
    const doStub = getDO(env);
    const val = await doStub.fetch('https://do/do/validate-session', {
      method: 'POST',
      body: JSON.stringify({ token: match[1] }),
      headers: { 'Content-Type': 'application/json' }
    });
    const json = await val.json().catch(()=>({ valid:false }));
    if (json.valid) {
      return c.redirect('/admin/dashboard');
    }
  }

  const htmlContent = `<!doctype html>
  <html lang="fa" dir="rtl">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ورود ادمین - SmartProxy</title>
  <style>body{font-family:system-ui,Segoe UI,Roboto;padding:20px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff}
  .card{max-width:520px;margin:40px auto;background:rgba(0,0,0,0.2);padding:24px;border-radius:12px}input{width:100%;padding:10px;margin-top:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.12)}
  button{margin-top:12px;padding:10px 14px;border-radius:8px;border:none;background:#4CAF50;color:#fff;cursor:pointer}</style>
  </head><body><div class="card"><h2>ورود پنل مدیریت</h2>
  <form method="POST" action="/api/login"><label>رمز عبور</label><input type="password" name="password" required><button type="submit">ورود</button></form>
  <p style="opacity:0.8;margin-top:12px">جلسه امن تا یک ساعت معتبر است.</p></div></body></html>`;
  return new Response(htmlContent, { status: 200, headers: { ...sh, ...corsHeaders(), 'Content-Type': 'text/html; charset=utf-8' }});
});

// API: login -> create session
app.post('/api/login', async c => {
  const env = c.env;
  const form = await c.req.parseBody().then(b => b.formData || b).catch(()=>null);
  // handle both application/x-www-form-urlencoded and JSON
  let password = null;
  if (form) {
    if (form.get) { // formData
      password = form.get('password');
    } else if (typeof form === 'object') {
      password = form.password || form.get && form.get('password');
    }
  } else {
    try {
      const j = await c.req.json().catch(()=>null);
      if (j && j.password) password = j.password;
    } catch {}
  }
  if (!password) return c.json({ ok: false, error: 'password required' }, 400);

  const adminPass = env.ADMIN_PASSWORD || '';
  if (password !== adminPass) {
    return c.json({ ok: false, error: 'invalid credentials' }, 401);
  }

  // create session via DO
  const doStub = getDO(env);
  const ip = c.req.headers.get('CF-Connecting-IP') || c.req.headers.get('x-forwarded-for') || 'unknown';
  const resp = await doStub.fetch('https://do/do/create-session', {
    method: 'POST',
    body: JSON.stringify({ ip, ttl: 3600 }),
    headers: { 'Content-Type': 'application/json' }
  });
  const j = await resp.json();
  const token = j.token;
  // set cookie (HttpOnly not available to JS fetching from other sites, but fine for same-origin)
  const cookie = `sp_sess=${token}; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Strict`;
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Set-Cookie': cookie, 'Content-Type': 'application/json' }});
});

// Admin dashboard (HTML + Chart.js)
app.get('/admin/dashboard', async c => {
  const env = c.env;
  // validate session cookie
  const cookie = c.req.headers.get('Cookie') || '';
  const match = cookie.match(/sp_sess=([a-f0-9]+)/);
  if (!match) return c.redirect('/admin');

  const doStub = getDO(env);
  const val = await doStub.fetch('https://do/do/validate-session', {
    method: 'POST',
    body: JSON.stringify({ token: match[1] }),
    headers: { 'Content-Type': 'application/json' }
  });
  const js = await val.json().catch(()=>({ valid:false }));
  if (!js.valid) return c.redirect('/admin');

  // prepare UI (Chart.js via jsdelivr)
  const sh = securityHeaders(env);
  const htmlPage = `<!doctype html>
  <html lang="fa" dir="rtl">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Dashboard - SmartProxy</title>
  <link rel="preconnect" href="https://cdn.jsdelivr.net">
  <style>body{font-family:system-ui;padding:18px;background:linear-gradient(135deg,#0f172a,#667eea);color:#fff}
  .wrap{max-width:1100px;margin:10px auto;background:rgba(255,255,255,0.03);padding:18px;border-radius:12px}
  .row{display:flex;gap:14px;flex-wrap:wrap}.card{flex:1 1 300px;background:rgba(0,0,0,0.25);padding:12px;border-radius:10px}
  table{width:100%;border-collapse:collapse}th,td{padding:8px;border-bottom:1px solid rgba(255,255,255,0.06);text-align:left}
  </style>
  </head><body><div class="wrap"><h2>داشبورد SmartProxy</h2>
  <div class="row"><div class="card"><canvas id="totalChart" height="120"></canvas></div>
  <div class="card"><h3>Top IPs</h3><div id="topIps"></div></div></div>
  <div style="margin-top:12px"><button onclick="fetch('/api/logout',{method:'POST'}).then(()=>location='/admin')">خروج</button> <button onclick="location.reload()">رفرش</button></div>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script>
  async function fetchStats(){
    const res = await fetch('/api/stats');
    const j = await res.json();
    return j;
  }
  async function fetchTopIPs(){
    const res = await fetch('/api/ips');
    const j = await res.json();
    return j;
  }
  async function render(){
    const stats = await fetchStats();
    const top = await fetchTopIPs();
    // simple total chart
    const labels = ['Total','Blocked'];
    const data = [stats.total || 0, stats.blocked || 0];
    const ctx = document.getElementById('totalChart').getContext('2d');
    new Chart(ctx, { type: 'doughnut', data: { labels, datasets:[{ data, label: 'Stats' }] }, options: {} });
    // top ip table
    const topEl = document.getElementById('topIps');
    topEl.innerHTML = '<table><tr><th>IP</th><th>Count</th></tr>' + top.map(t=>`<tr><td>${t.ip}</td><td>${t.count}</td></tr>`).join('') + '</table>';
  }
  render();
  </script>
  </div></body></html>`;
  return new Response(htmlPage, { status: 200, headers: { ...sh, 'Content-Type': 'text/html; charset=utf-8' }});
});

// API: stats (only for admin session)
app.get('/api/stats', async c => {
  const env = c.env;
  // allow dashboard to call with session cookie; validate similarly
  const cookie = c.req.headers.get('Cookie') || '';
  const match = cookie.match(/sp_sess=([a-f0-9]+)/);
  if (!match) return c.json({ error: 'unauth' }, 401);
  const doStub = getDO(env);
  const val = await doStub.fetch('https://do/do/validate-session', {
    method: 'POST',
    body: JSON.stringify({ token: match[1] }),
    headers: { 'Content-Type': 'application/json' }
  });
  const js = await val.json().catch(()=>({ valid:false }));
  if (!js.valid) return c.json({ error: 'unauth' }, 401);

  const statsResp = await doStub.fetch('https://do/do/stats');
  const data = await statsResp.json();
  return c.json(data);
});

// API: top IPs (admin)
app.get('/api/ips', async c => {
  const env = c.env;
  const cookie = c.req.headers.get('Cookie') || '';
  const match = cookie.match(/sp_sess=([a-f0-9]+)/);
  if (!match) return c.json({ error: 'unauth' }, 401);
  const doStub = getDO(env);
  const val = await doStub.fetch('https://do/do/validate-session', {
    method: 'POST',
    body: JSON.stringify({ token: match[1] }),
    headers: { 'Content-Type': 'application/json' }
  });
  const js = await val.json().catch(()=>({ valid:false }));
  if (!js.valid) return c.json({ error: 'unauth' }, 401);

  const top = await doStub.fetch('https://do/do/topips');
  const arr = await top.json();
  return c.json(arr);
});

// API: logout
app.post('/api/logout', async c => {
  const env = c.env;
  const cookie = c.req.headers.get('Cookie') || '';
  const match = cookie.match(/sp_sess=([a-f0-9]+)/);
  if (match) {
    const doStub = getDO(env);
    await doStub.fetch('https://do/do/revoke', {
      method: 'POST',
      body: JSON.stringify({ token: match[1] }),
      headers: { 'Content-Type': 'application/json' }
    }).catch(()=>{});
  }
  // expire cookie
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Set-Cookie': 'sp_sess=deleted; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict', 'Content-Type': 'application/json' }});
});

// DNS and Proxy endpoints (simplified & secure)
// /dns-query?name=...&type=...
app.get('/dns-query', async c => {
  const env = c.env;
  const name = c.req.query('name');
  const type = (c.req.query('type') || 'A').toUpperCase();
  if (!name) return c.json({ error: 'name required' }, 400);
  // simple validation
  if (name.length > 253) return c.json({ error: 'invalid name' }, 400);

  // rate-limit via DO token bucket
  const clientIP = c.req.headers.get('CF-Connecting-IP') || c.req.headers.get('x-forwarded-for') || 'unknown';
  const tokenRes = await consumeTokenDO(env, clientIP, 1);
  if (!tokenRes.allowed) {
    await recordHit(env, clientIP, name, true);
    return c.json({ error: 'rate_limit' }, 429);
  }

  // forward to upstream DoH (env.DEFAULT_DOH)
  const upstream = env.DEFAULT_DOH || 'https://cloudflare-dns.com/dns-query';
  const qUrl = `${upstream}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
  const resp = await fetch(qUrl, { headers: { 'Accept': 'application/dns-json', 'User-Agent': 'SmartProxy/2.5-enterprise' }});
  const data = await resp.json().catch(()=>({}));
  // record stats async
  c.executionCtx.waitUntil(recordHit(env, clientIP, name, false));
  return c.json(data, resp.status, { ...corsHeaders(), ...securityHeaders(env) });
});

// /proxy?url=...
app.all('/proxy', async c => {
  const env = c.env;
  const target = c.req.query('url') || c.req.query('target');
  if (!target) return c.text('proxy usage: /proxy?url=https://example.com', 400);
  if (!isSafeRedirectUrl(target)) return c.text('invalid or insecure url', 400);

  const clientIP = c.req.headers.get('CF-Connecting-IP') || c.req.headers.get('x-forwarded-for') || 'unknown';
  // rate-limit
  const tokenRes = await consumeTokenDO(env, clientIP, 5); // heavier cost for proxy
  if (!tokenRes.allowed) {
    await recordHit(env, clientIP, new URL(target).hostname, true);
    return c.json({ error: 'rate_limit' }, 429);
  }

  // fetch upstream (streamed), inject banner for html via HTMLRewriter
  const upstreamResp = await fetch(target, {
    method: c.req.method,
    headers: {
      'User-Agent': c.req.headers.get('User-Agent') || 'SmartProxy/2.5-enterprise',
      'Accept': c.req.headers.get('Accept') || '*/*'
    },
    body: (['POST','PUT','PATCH'].includes(c.req.method) ? await c.req.arrayBuffer() : undefined),
    redirect: 'follow'
  });

  // Record stats async
  c.executionCtx.waitUntil(recordHit(env, clientIP, new URL(target).hostname, false));

  const contentType = upstreamResp.headers.get('Content-Type') || '';
  if (contentType.includes('text/html')) {
    // Use HTMLRewriter to inject banner and rewrite relative links to pass via proxy (safe)
    class AttrRewriter {
      constructor(base) { this.base = base; }
      element(el) {
        try {
          ['href','src','action'].forEach(attr => {
            const v = el.getAttribute(attr);
            if (v && !v.match(/^(https?:|\/\/|data:|mailto:|tel:|#)/i)) {
              // relative => absolute via base
              const newv = new URL(v, this.base).toString();
              el.setAttribute(attr, '/proxy?url=' + encodeURIComponent(newv));
            } else if (v && v.match(/^https?:\/\//i)) {
              // absolute => route via proxy
              el.setAttribute(attr, '/proxy?url=' + encodeURIComponent(v));
            }
          });
        } catch(e) {}
      }
    }
    class BodyInjector {
      constructor(banner) { this.banner = banner; }
      element(el) { try { el.prepend(this.banner, { html: true }); } catch(e) {} }
    }
    const bannerHtml = `<div style="position:fixed;top:0;left:0;right:0;z-index:99999;background:linear-gradient(90deg,#0ea5e9,#7c3aed);color:#fff;padding:8px 12px;font-family:system-ui;display:flex;justify-content:space-between;align-items:center"><div><strong>SmartProxy</strong> <small style="opacity:0.9">${new URL(target).hostname}</small></div><div><button onclick="this.closest('div').style.display='none'" style="background:transparent;border:1px solid rgba(255,255,255,0.2);color:#fff;padding:6px;border-radius:6px;cursor:pointer">بستن</button></div></div><style>body{margin-top:48px !important}</style>`;
    const rewriter = new HTMLRewriter()
      .on('a', new AttrRewriter(target))
      .on('img', new AttrRewriter(target))
      .on('form', new AttrRewriter(target))
      .on('body', new BodyInjector(bannerHtml));
    const transformed = rewriter.transform(upstreamResp);
    // append security headers
    const headers = { ...securityHeaders(env), ...corsHeaders() };
    return new Response(transformed.body, { status: upstreamResp.status, headers });
  }

  // non-HTML: stream through
  const headers = { ...securityHeaders(env), ...corsHeaders() };
  // copy content-type if present
  const respHeaders = new Headers(headers);
  const ct = upstreamResp.headers.get('Content-Type');
  if (ct) respHeaders.set('Content-Type', ct);
  return new Response(upstreamResp.body, { status: upstreamResp.status, headers: respHeaders });
});

// Fallback root
app.get('/', (c) => {
  return c.text('SmartProxy 2.5-enterprise — for docs visit /admin (login)');
});

// Export default fetch
export default {
  async fetch(request, env, ctx) {
    // attach env to Hono context
    // provide executionCtx to routes for waitUntil usage
    app.setContext({ env, executionCtx: ctx });
    return app.fetch(request, env, ctx);
  }
};

// Export DO class for wrangler
export { SmartProxyDO as DurableObject };
