```javascript
// _worker.js - Iran Smart Proxy v2.5: Approximate SNI Proxy via CONNECT Handling
// Author: Mehdi feizezadeh
// Changes: Added /connect route for HTTP CONNECT (SNI-like), 501 for unsupported, metrics for CONNECT
// Full code with all previous features (v2.4 + SNI)

import { Hono } from 'hono'; // https://hono.dev

const app = new Hono();

// Global metrics (updated for CONNECT)
let metrics = {
  requests: { total: 0, success: 0, error: 0, connect: 0 },
  uptime: { start: Date.now(), lastReset: Date.now() }
};

/**
 * Enhanced Configuration - Env vars for sensitive data.
 */
const CONFIG = {
  BLOCKED_SITES: [
    'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'youtube.com', 'telegram.org',
    'discord.com', 'reddit.com', 'github.com', 'medium.com', 'bbc.com', 'cnn.com',
    'wikipedia.org', 'whatsapp.com', 'linkedin.com'
  ],
  IRANIAN_SITES: [
    '.ir', '.ایران', 'irna.ir', 'tasnim.ir', 'mehr.ir', 'digikala.com',
    'snapp.ir', 'cafebazaar.ir', 'aparat.com', 'namasha.com'
  ],
  GAMING_DOMAINS: [
    'steampowered.com', 'steamcommunity.com', 'riotgames.com', 'leagueoflegends.com',
    'valorant.com', 'epicgames.com', 'blizzard.com', 'battle.net', 'ea.com', 'origin.com'
  ],
  CF_IPS_V4: (typeof CF_IPS_V4 !== 'undefined' ? CF_IPS_V4.split(',') : [
    '104.16.132.229', '104.16.133.229', '172.67.69.9', '172.67.70.9',
    '104.16.134.229', '104.16.135.229', '172.67.71.9', '172.67.72.9'
  ]),
  CF_IPS_V6: (typeof CF_IPS_V6 !== 'undefined' ? CF_IPS_V6.split(',') : [
    '2606:4700::6810:84e5', '2606:4700::6810:85e5', '2606:4700::6810:86e5', '2606:4700::6810:87e5'
  ]),
  CACHE_DURATIONS: { 'A': 300, 'AAAA': 300, 'CNAME': 1800, 'MX': 3600, 'TXT': 1800, 'NS': 7200 },
  RATE_LIMIT: { WINDOW: 60000, MAX_REQUESTS: 120, MAX_DNS: 100, MAX_PROXY: 20 }
};

const rateLimitStore = new Map();

/**
 * Check rate limit (optimized with async cleanup trigger).
 */
function checkRateLimit(ip, type = 'general') {
  const now = Date.now();
  const key = `${ip}:${type}`;
  const requests = rateLimitStore.get(key) || [];
  const recent = requests.filter(time => now - time < CONFIG.RATE_LIMIT.WINDOW);
  let limit = CONFIG.RATE_LIMIT.MAX_REQUESTS;
  if (type === 'dns') limit = CONFIG.RATE_LIMIT.MAX_DNS;
  if (type === 'proxy') limit = CONFIG.RATE_LIMIT.MAX_PROXY;
  if (recent.length >= limit) return false;
  recent.push(now);
  rateLimitStore.set(key, recent);
  // Async cleanup to avoid blocking (setTimeout for next tick)
  if (rateLimitStore.size > 1000) {
    setTimeout(cleanupRateLimit, 0);
  }
  return true;
}

function getRateLimitStatus(ip) {
  const now = Date.now();
  const getCount = (key) => {
    const requests = rateLimitStore.get(key) || [];
    return requests.filter(time => now - time < CONFIG.RATE_LIMIT.WINDOW).length;
  };
  return {
    general: `${getCount(`${ip}:general`)}/${CONFIG.RATE_LIMIT.MAX_REQUESTS}`,
    dns: `${getCount(`${ip}:dns`)}/${CONFIG.RATE_LIMIT.MAX_DNS}`,
    proxy: `${getCount(`${ip}:proxy`)}/${CONFIG.RATE_LIMIT.MAX_PROXY}`,
    window_seconds: CONFIG.RATE_LIMIT.WINDOW / 1000
  };
}

async function cleanupRateLimit() {
  const now = Date.now();
  for (const [key, requests] of rateLimitStore.entries()) {
    const recent = requests.filter(time => now - time < CONFIG.RATE_LIMIT.WINDOW);
    if (recent.length === 0) rateLimitStore.delete(key);
    else rateLimitStore.set(key, recent);
  }
}

/**
 * Enhanced URL validation with anti-open redirect (block relative/empty paths).
 */
function isValidUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return { valid: false, reason: 'فقط HTTPS مجاز است' };
    if (!parsed.hostname || parsed.hostname.length < 1 || parsed.hostname === '') {
      return { valid: false, reason: 'Open redirect prevented: Invalid hostname' };
    }
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.startsWith('127.') || hostname.startsWith('192.168.') ||
        hostname.startsWith('10.') || hostname.startsWith('172.1') || hostname.startsWith('172.2') ||
        hostname === '0.0.0.0' || hostname.includes('::1')) {
      return { valid: false, reason: 'آدرس محلی مجاز نیست' };
    }
    if (hostname.includes('..') || hostname.startsWith('.') || hostname.endsWith('.')) {
      return { valid: false, reason: 'فرمت آدرس نامعتبر' };
    }
    return { valid: true };
  } catch (error) {
    return { valid: false, reason: 'آدرس نامعتبر' };
  }
}

function isValidDomain(domain) {
  if (!domain || typeof domain !== 'string') return false;
  const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-._]*[a-zA-Z0-9]$/;
  if (domain.length > 253 || !domainRegex.test(domain)) return false;
  if (domain.includes('..') || domain.startsWith('.') || domain.endsWith('.')) return false;
  return true;
}

function getSiteType(domain) {
  const d = domain.toLowerCase();
  if (CONFIG.IRANIAN_SITES.some(site => d.includes(site))) return 'iranian';
  if (CONFIG.BLOCKED_SITES.some(site => d.includes(site))) return 'blocked';
  if (CONFIG.GAMING_DOMAINS.some(site => d.includes(site))) return 'gaming';
  return 'normal';
}

function getCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, User-Agent, X-Requested-With',
    'Access-Control-Max-Age': '86400'
  };
}

function getSecurityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: https:; connect-src 'self' https://cloudflare-dns.com https://dns.google; frame-ancestors 'none'",
    'X-Frame-Options': 'DENY', // Anti-iframe
    'X-Powered-By': 'Iran-Smart-Proxy-v2.5'
  };
}

function generateRequestId() {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

/**
 * Single logRequest (called once per request in middleware).
 */
function logRequest(type, endpoint, success, duration, clientIP) {
  metrics.requests.total++;
  if (success) metrics.requests.success++;
  else metrics.requests.error++;
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    type, endpoint, success, duration_ms: duration,
    client_ip: clientIP, service: 'iran-smart-proxy', version: '2.5'
  }));
}

/**
 * Centralized error handler (env.NODE_ENV for dev/prod).
 */
function handleError(error, clientIP, endpoint, corsHeaders, startTime) {
  const reqId = generateRequestId();
  const duration = Date.now() - startTime;
  logRequest('error', endpoint, false, duration, clientIP);
  const message = env.NODE_ENV === 'development' ? error.message : 'نامشخص';
  return jsonResponse({ error: 'خطای سرور', details: message, request_id: reqId }, 500, corsHeaders);
}

function jsonResponse(data, status = 200, corsHeaders = {}, additionalHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8', ...additionalHeaders }
  });
}

// Global middleware: Rate limit + Metrics start (single log at end)
app.use('*', async (c, next) => {
  const clientIP = c.req.cf?.ip || 'unknown';
  const startTime = Date.now();
  if (!checkRateLimit(clientIP)) {
    const duration = Date.now() - startTime;
    logRequest('error', c.req.path, false, duration, clientIP);
    return jsonResponse({ error: 'درخواست بیش از حد', message: 'لطفا صبر کنید', retry_after: 60 }, 429, getCorsHeaders());
  }
  if (c.req.method === 'CONNECT') {
    metrics.requests.connect++;
  }
  try {
    await next();
    const duration = Date.now() - startTime;
    logRequest('success', c.req.path, true, duration, clientIP);
  } catch (error) {
    const duration = Date.now() - startTime;
    return handleError(error, clientIP, c.req.path, getCorsHeaders(), startTime);
  }
});

app.options('*', (c) => c.body(null, { headers: { ...getCorsHeaders(), ...getSecurityHeaders() } }));

// Main page (completed with full setup-grid)
app.get('/', (c) => c.html(getMainPage(c.req.url.hostname), { headers: { 'Content-Type': 'text/html; charset=utf-8', ...getSecurityHeaders() } }));

// DNS Handler (async fetch + cache)
app.all('/dns-query/:resolve?', async (c) => {
  const clientIP = c.req.cf?.ip || 'unknown';
  const startTime = Date.now(); // Already in middleware
  // Rate limit already in middleware, but DNS-specific if needed
  if (!checkRateLimit(clientIP, 'dns')) {
    return jsonResponse({ error: 'محدودیت DNS', message: 'تعداد درخواست بیش از حد' }, 429, getCorsHeaders());
  }
  try {
    let name = c.req.query('name');
    let type = c.req.query('type') || 'A';
    let dnsQuery = null;
    if (c.req.method === 'POST') {
      const contentType = c.req.header('Content-Type') || '';
      if (contentType.includes('application/dns-message')) {
        dnsQuery = new Uint8Array(await c.req.arrayBuffer());
      }
    } else {
      const dnsParam = c.req.query('dns');
      if (dnsParam) dnsQuery = base64UrlDecode(dnsParam);
    }
    if (dnsQuery) return await forwardDNSWireFormat(dnsQuery, getCorsHeaders());
    if (!name) {
      return jsonResponse({
        error: 'پارامتر name ضروری است',
        examples: { json: '/dns-query?name=google.com&type=A', wire: '/dns-query?dns=BASE64_ENCODED_QUERY' },
        supported_types: ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS']
      }, 400, getCorsHeaders());
    }
    if (!isValidDomain(name)) {
      return jsonResponse({ error: 'نام دامنه نامعتبر' }, 400, getCorsHeaders());
    }

    console.log(`🔍 DNS Query: ${name} (${type}) from ${clientIP}`);
    const siteType = getSiteType(name);
    const gaming = c.req.query('gaming') === 'true';
    let dnsProvider = 'https://cloudflare-dns.com/dns-query';
    if (gaming && siteType === 'gaming') dnsProvider = 'https://dns.google/dns-query';
    const queryUrl = `${dnsProvider}?name=${encodeURIComponent(name)}&type=${type}`;

    // Async cache check
    const cache = caches.default;
    const cacheKey = new Request(`${c.req.url.origin}/cache/${name}-${type}`);
    let response = await cache.match(cacheKey);
    if (!response) {
      const acceptHeader = c.req.header('Accept') || '';
      const wantsWireFormat = acceptHeader.includes('application/dns-message');
      response = await fetch(queryUrl, { // Async fetch
        headers: { 'Accept': wantsWireFormat ? 'application/dns-message' : 'application/dns-json', 'User-Agent': `Iran-Proxy-${wantsWireFormat ? 'Wire' : 'JSON'}/2.5` }
      });
      if (response.ok) {
        const clone = response.clone();
        cache.put(cacheKey, clone); // Cache asynchronously
        response = clone;
      }
    }

    if (!response.ok) throw new Error(`DNS failed: ${response.status}`);
    const contentType = response.headers.get('Content-Type') || '';
    const data = await (contentType.includes('dns-message') ? response.arrayBuffer() : response.json());
    const queryTime = Date.now() - startTime;

    // Smart Proxy
    if (siteType === 'blocked' && typeof data === 'object' && data.Answer) {
      data.Answer = data.Answer.map(record => {
        if (record.type === 1) {
          const cfIP = CONFIG.CF_IPS_V4[Math.floor(Math.random() * CONFIG.CF_IPS_V4.length)];
          return { ...record, data: cfIP, TTL: 300, _proxied: true };
        } else if (record.type === 28) {
          const cfIPv6 = CONFIG.CF_IPS_V6[Math.floor(Math.random() * CONFIG.CF_IPS_V6.length)];
          return { ...record, data: cfIPv6, TTL: 300, _proxied: true };
        }
        return record;
      });
    }

    if (typeof data === 'object') {
      data._iran_proxy = { site_type: siteType, gaming_mode: gaming, query_time_ms: queryTime };
    }

    const headers = { ...getCorsHeaders(), ...getSecurityHeaders(), 'Cache-Control': `public, max-age=${CONFIG.CACHE_DURATIONS[type] || 300}` };
    return typeof data === 'object' ? jsonResponse(data, 200, headers) :
      new Response(data, { headers: { ...headers, 'Content-Type': 'application/dns-message' } });
  } catch (error) {
    return handleError(error, clientIP, c.req.path, getCorsHeaders(), startTime);
  }
});

// Proxy Handler (async body handling)
app.all('/proxy', async (c) => {
  const clientIP = c.req.cf?.ip || 'unknown';
  const startTime = Date.now();
  if (!checkRateLimit(clientIP, 'proxy')) {
    return jsonResponse({ error: 'محدودیت Proxy', message: 'تعداد درخواست بیش از حد' }, 429, getCorsHeaders());
  }
  try {
    let targetUrl = c.req.query('url');
    if (!targetUrl) return jsonResponse({ error: 'پارامتر url ضروری است', example: '/proxy?url=https://twitter.com' }, 400, getCorsHeaders());
    const validation = isValidUrl(targetUrl);
    if (!validation.valid) return jsonResponse({ error: 'URL نامعتبر', reason: validation.reason }, 400, getCorsHeaders());

    console.log(`🌐 Proxy: ${targetUrl} from ${clientIP}`);
    const body = c.req.method === 'POST' ? await c.req.arrayBuffer() : null; // Async body
    const proxyResponse = await fetch(targetUrl, { // Async fetch
      method: c.req.method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1', 'Connection': 'keep-alive', 'Upgrade-Insecure-Requests': '1'
      },
      body
    });

    if (!proxyResponse.ok) throw new Error(`HTTP ${proxyResponse.status}: ${proxyResponse.statusText}`);

    const contentType = proxyResponse.headers.get('Content-Type') || '';
    let bodyResp;
    if (contentType.includes('text/html')) {
      let html = await proxyResponse.text();
      const urlObj = new URL(targetUrl);
      const baseUrl = `${urlObj.protocol}//${urlObj.host}`;
      html = html.replace(/href="\/(?!\/|http|https|#|javascript:|mailto:|tel:)([^"]*)"/gi, `href="/proxy?url=${baseUrl}/$1"`);
      html = html.replace(/src="\/(?!\/|http|https|data:)([^"]*)"/gi, `src="/proxy?url=${baseUrl}/$1"`);
      html = html.replace(/action="\/(?!\/|http|https)([^"]*)"/gi, `action="/proxy?url=${baseUrl}/$1"`);
      const banner = `<div id="iran-proxy-banner" style="position:fixed;top:0;left:0;right:0;z-index:2147483647;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;padding:10px 20px;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:14px;border-bottom:3px solid rgba(255,255,255,0.3);box-shadow:0 2px 10px rgba(0,0,0,0.2);"><div style="display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:15px;"><div style="display:flex;align-items:center;gap:8px;">🇮🇷 <strong>Iran Smart Proxy</strong></div><div style="font-size:12px;opacity:0.9;">📡 ${urlObj.hostname}</div><div style="font-size:12px;opacity:0.8;">🔒 Secure Browsing</div><button onclick="document.getElementById('iran-proxy-banner').style.display='none'" style="background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.4);color:white;border-radius:4px;cursor:pointer;padding:4px 12px;font-size:12px;transition:all 0.2s;">بستن</button></div></div><script>if(document.body){document.body.style.marginTop='60px';document.body.style.transition='margin-top 0.3s ease';}setTimeout(()=>{const banner=document.getElementById('iran-proxy-banner');if(banner){banner.style.opacity='0.7';banner.style.transform='translateY(-5px)';}},10000);</script>`;
      html = html.replace(/<body([^>]*)>/i, `<body$1>${banner}`);
      bodyResp = new Response(html, { headers: proxyResponse.headers });
    } else {
      bodyResp = proxyResponse.body;
    }

    const responseHeaders = {
      ...getCorsHeaders(), ...getSecurityHeaders(),
      'Content-Type': contentType, 'X-Proxy-Status': 'Success', 'X-Proxy-Target': new URL(targetUrl).hostname, 'X-Proxy-Version': '2.5'
    };
    ['content-security-policy', 'x-frame-options', 'strict-transport-security'].forEach(h => responseHeaders[h] = undefined);

    return new Response(bodyResp, { status: proxyResponse.status, headers: responseHeaders });
  } catch (error) {
    return handleError(error, clientIP, c.req.path, getCorsHeaders(), startTime);
  }
});

// Browse page (Bootstrap RTL modern UI)
app.get('/browse', (c) => c.html(getBrowsePage(c.req.url.hostname), { headers: { 'Content-Type': 'text/html; charset=utf-8', ...getSecurityHeaders() } }));

// Health with metrics/uptime (updated for CONNECT)
app.get('/health', (c) => {
  const clientIP = c.req.cf?.ip || 'unknown';
  const uptimeMs = Date.now() - metrics.uptime.start;
  const uptime = `${Math.floor(uptimeMs / 86400000)}d ${Math.floor((uptimeMs % 86400000) / 3600000)}h`;
  return jsonResponse({
    status: 'healthy', timestamp: new Date().toISOString(), version: '2.5',
    features: ['DoH', 'HTTP-Proxy', 'Rate-Limiting', 'CSP-Security', 'Bootstrap-UI', 'SNI-Connect'],
    rate_limit: getRateLimitStatus(clientIP),
    metrics: {
      requests: metrics.requests,
      uptime: { ms: uptimeMs, human: uptime },
      cache_hits: 'N/A' // Can add counter if needed
    }
  }, 200, getCorsHeaders());
});

// Legacy status
app.get('/status', (c) => {
  const clientIP = c.req.cf?.ip || 'unknown';
  return jsonResponse({
    status: 'OK', timestamp: new Date().toISOString(), service: 'Iran Smart Proxy v2.5',
    supports: ['DNS JSON/Wire', 'HTTP Proxy', 'Rate Limiting', 'CONNECT SNI-like'], client_ip: clientIP, security: 'enhanced'
  }, 200, getCorsHeaders());
});

// New: SNI-like CONNECT Proxy Route
app.all('/connect/:host', async (c) => {
  const clientIP = c.req.cf?.ip || 'unknown';
  const startTime = Date.now();
  if (c.req.method !== 'CONNECT') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  if (!checkRateLimit(clientIP, 'proxy')) { // Reuse proxy limit
    return jsonResponse({ error: 'محدودیت CONNECT', message: 'تعداد درخواست بیش از حد' }, 429, getCorsHeaders());
  }

  try {
    const host = c.req.param('host'); // e.g., example.com:443
    if (!host || !isValidDomain(host.split(':')[0])) {
      return new Response('Bad Request: Invalid host', { status: 400 });
    }

    console.log(`🔌 CONNECT (SNI-like): ${host} from ${clientIP}`);

    // Approximate tunneling: Redirect to HTTP proxy with target
    const targetUrl = `https://${host}`;
    const validation = isValidUrl(targetUrl);
    if (!validation.valid) {
      return jsonResponse({ error: 'Host نامعتبر', reason: validation.reason }, 400, getCorsHeaders());
    }

    // Forward as HTTP proxy (not full TCP, but works for HTTPS via CONNECT simulation)
    const proxyUrl = `/proxy?url=${encodeURIComponent(targetUrl)}`;
    const redirect = new Response(null, { status: 302, headers: { Location: proxyUrl, ...getSecurityHeaders() } });

    logRequest('success', `/connect/${host}`, true, Date.now() - startTime, clientIP);
    return redirect;
  } catch (error) {
    return handleError(error, clientIP, `/connect/${c.req.param('host') || 'unknown'}`, getCorsHeaders(), startTime);
  }
});

// Fallback for raw CONNECT (unsupported - return 501) and 404
app.all('*', (c) => {
  if (c.req.method === 'CONNECT') {
    metrics.requests.error++;
    return new Response('CONNECT Not Supported (Use /connect/:host for SNI-like)', {
      status: 501,
      headers: { ...getCorsHeaders(), ...getSecurityHeaders() }
    });
  }
  return new Response('صفحه پیدا نشد', { status: 404, headers: { ...getCorsHeaders(), ...getSecurityHeaders() } });
});

export default app;

// Helpers (unchanged from v2.4)
async function forwardDNSWireFormat(dnsQuery, corsHeaders) {
  console.log('🔄 Forwarding DNS wire format');
  const response = await fetch('https://cloudflare-dns.com/dns-query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/dns-message', 'Accept': 'application/dns-message', 'User-Agent': 'Iran-Proxy-Wire/2.5' },
    body: dnsQuery
  });
  if (!response.ok) throw new Error(`Wire failed: ${response.status}`);
  const data = await response.arrayBuffer();
  return new Response(data, {
    headers: { ...corsHeaders, ...getSecurityHeaders(), 'Content-Type': 'application/dns-message', 'Cache-Control': 'public, max-age=300' }
  });
}

function base64UrlDecode(str) {
  try {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch (error) {
    throw new Error('Invalid base64url: ' + error.message);
  }
}

/**
 * Modern Browse Page with Bootstrap RTL.
 */
function getBrowsePage(hostname) {
  return `<!DOCTYPE html>
<html dir="rtl" lang="fa">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🌐 مرورگر وب امن - Iran Smart Proxy</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.rtl.min.css" rel="stylesheet">
<link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" rel="stylesheet">
<style>body{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;}.btn-primary{background:linear-gradient(45deg,#4CAF50,#45a049);border:none;}.card{border:none;background:rgba(255,255,255,0.1);backdrop-filter:blur(20px);border-radius:20px;}</style>
</head>
<body class="d-flex align-items-center min-vh-100">
<div class="container">
  <div class="row justify-content-center">
    <div class="col-lg-8 col-md-10">
      <div class="text-center mb-5">
        <h1 class="display-4 fw-bold mb-3">🌐 مرورگر وب امن</h1>
        <p class="lead">دسترسی امن و سریع به سایت‌های مسدود با پروکسی هوشمند</p>
      </div>
      <div class="card p-4 mb-4">
        <h5 class="card-title text-center mb-4">🔗 آدرس سایت را وارد کنید</h5>
        <form onsubmit="browseUrl(event)" class="d-flex gap-2">
          <input type="url" class="form-control form-control-lg" id="urlInput" placeholder="https://example.com" required>
          <button type="submit" class="btn btn-primary btn-lg">🚀 برو</button>
        </form>
      </div>
      <div class="alert alert-warning text-center" role="alert">
        ⚠️ <strong>توجه:</strong> فقط سایت‌های معتبر استفاده کنید و اطلاعات حساس وارد نکنید.
      </div>
      <div class="row g-3 mb-5">
        <div class="col-6 col-md-4 col-lg-3"><a href="#" onclick="quickBrowse('https://twitter.com')" class="btn btn-outline-light w-100"><i class="bi bi-twitter-x me-2"></i>Twitter</a></div>
        <div class="col-6 col-md-4 col-lg-3"><a href="#" onclick="quickBrowse('https://youtube.com')" class="btn btn-outline-light w-100"><i class="bi bi-youtube me-2"></i>YouTube</a></div>
        <div class="col-6 col-md-4 col-lg-3"><a href="#" onclick="quickBrowse('https://github.com')" class="btn btn-outline-light w-100"><i class="bi bi-github me-2"></i>GitHub</a></div>
        <div class="col-6 col-md-4 col-lg-3"><a href="#" onclick="quickBrowse('https://reddit.com')" class="btn btn-outline-light w-100"><i class="bi bi-reddit me-2"></i>Reddit</a></div>
        <div class="col-6 col-md-4 col-lg-3"><a href="#" onclick="quickBrowse('https://instagram.com')" class="btn btn-outline-light w-100"><i class="bi bi-instagram me-2"></i>Instagram</a></div>
        <div class="col-6 col-md-4 col-lg-3"><a href="#" onclick="quickBrowse('https://facebook.com')" class="btn btn-outline-light w-100"><i class="bi bi-facebook me-2"></i>Facebook</a></div>
        <div class="col-6 col-md-4 col-lg-3"><a href="#" onclick="quickBrowse('https://medium.com')" class="btn btn-outline-light w-100"><i class="bi bi-journal-text me-2"></i>Medium</a></div>
        <div class="col-6 col-md-4 col-lg-3"><a href="#" onclick="quickBrowse('https://discord.com')" class="btn btn-outline-light w-100"><i class="bi bi-discord me-2"></i>Discord</a></div>
      </div>
      <div class="text-center">
        <p class="opacity-75">🛡️ حفظ حریم خصوصی | ⚡ سرعت بالا | 🔒 امنیت کامل با CSP</p>
      </div>
    </div>
  </div>
</div>
<script>
function browseUrl(event) { event.preventDefault(); const url = document.getElementById('urlInput').value; if (url) { window.open('/proxy?url=' + encodeURIComponent(url), '_blank'); } }
function quickBrowse(url) { window.open('/proxy?url=' + encodeURIComponent(url), '_blank'); }
document.getElementById('urlInput').focus();
</script>
</body>
</html>`;
}

/**
 * Completed Main Page with full setup-grid (Bootstrap RTL).
 */
function getMainPage(hostname) {
  const updateDate = new Date().toLocaleDateString('fa-IR');
  return `<!DOCTYPE html>
<html dir="rtl" lang="fa">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🇮🇷 Iran Smart Proxy v2.5 - Enhanced & Secure</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.rtl.min.css" rel="stylesheet">
<link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" rel="stylesheet">
<style>body{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;}.btn-primary{background:linear-gradient(45deg,#4CAF50,#45a049);border:none;}.card{border:none;background:rgba(255,255,255,0.1);backdrop-filter:blur(20px);border-radius:20px;}</style>
</head>
<body class="min-vh-100">
<div class="container py-4">
  <div class="row justify-content-center">
    <div class="col-lg-10">
      <div class="text-center mb-5">
        <h1 class="display-3 fw-bold mb-3">🛡️ Iran Smart Proxy</h1>
        <p class="lead">نسخه 2.5: Bootstrap RTL + Anti-Frame + SNI-Connect</p>
        <div class="row justify-content-center g-3 mt-4">
          <div class="col-auto"><div class="bg-success bg-opacity-25 p-3 rounded-circle d-inline-block"><h2 class="mb-0">${CONFIG.BLOCKED_SITES.length}</h2><small>سایت مسدود</small></div></div>
          <div class="col-auto"><div class="bg-info bg-opacity-25 p-3 rounded-circle d-inline-block"><h2 class="mb-0">${CONFIG.GAMING_DOMAINS.length}</h2><small>گیمینگ</small></div></div>
          <div class="col-auto"><div class="bg-warning bg-opacity-25 p-3 rounded-circle d-inline-block"><h2 class="mb-0">120</h2><small>req/min</small></div></div>
        </div>
      </div>
      <div class="row g-4 mb-5">
        <div class="col-md-4"><div class="card p-4 text-center"><i class="bi bi-check-circle-fill text-success fs-1 mb-3"></i><h5>✅ سرویس فعال</h5><small>تمام قابلیت‌ها در دسترس</small></div></div>
        <div class="col-md-4"><div class="card p-4 text-center"><i class="bi bi-shield-lock-fill text-info fs-1 mb-3"></i><h5>🔒 امنیت</h5><small>CSP + Anti-Frame + Rate Limit</small></div></div>
        <div class="col-md-4"><div class="card p-4 text-center"><i class="bi bi-lightning-charge-fill text-warning fs-1 mb-3"></i><h5>⚡ عملکرد</h5><small>Cache + Async Fetch + SNI</small></div></div>
      </div>
      <div class="card mb-4 p-4">
        <h4 class="text-center mb-4">🌐 DNS Endpoint</h4>
        <div class="text-center"><code class="bg-dark p-3 rounded d-inline-block">https://${hostname}/dns-query</code><small class="d-block mt-2">سازگار با مرورگرها و اپ‌ها</small></div>
      </div>
      <div class="row g-4 mb-5">
        <div class="col-md-3"><div class="card p-4"><h5>🧠 Smart DNS</h5><ul class="list-unstyled"><li><i class="bi bi-check text-success"></i> تشخیص مسدود</li><li><i class="bi bi-check text-success"></i> بهینه گیمینگ</li><li><i class="bi bi-check text-success"></i> سرعت ایرانی</li></ul></div></div>
        <div class="col-md-3"><div class="card p-4"><h5>🔒 امنیت</h5><ul class="list-unstyled"><li><i class="bi bi-check text-success"></i> Rate Limit</li><li><i class="bi bi-check text-success"></i> URL Filter</li><li><i class="bi bi-check text-success"></i> Anti-Open Redirect</li></ul></div></div>
        <div class="col-md-3"><div class="card p-4"><h5>🌐 Proxy</h5><ul class="list-unstyled"><li><i class="bi bi-check text-success"></i> HTML Rewrite</li><li><i class="bi bi-check text-success"></i> موبایل</li><li><i class="bi bi-check text-success"></i> تصاویر سریع</li></ul></div></div>
        <div class="col-md-3"><div class="card p-4"><h5>📊 مانیتور</h5><ul class="list-unstyled"><li><i class="bi bi-check text-success"></i> آمار زنده</li><li><i class="bi bi-check text-success"></i> زمان پاسخ</li><li><i class="bi bi-check text-success"></i> Log کامل</li></ul></div></div>
      </div>
      <div class="card mb-5">
        <h4 class="card-header text-center">📱 تنظیمات مرورگرها</h4>
        <div class="card-body">
          <div class="row g-4">
            <div class="col-md-4"><div class="card p-3"><h6>🦊 Firefox</h6><ol class="small"><li><code>about:preferences#privacy</code></li><li>Custom DoH: <code>https://${hostname}/dns-query</code></li><li>Enable</li><li>Restart</li></ol></div></div>
            <div class="col-md-4"><div class="card p-3"><h6>🔵 Chrome</h6><ol class="small"><li><code>chrome://settings/security</code></li><li>Secure DNS: Custom <code>https://${hostname}/dns-query</code></li><li>Save</li><li>Restart</li></ol></div></div>
            <div class="col-md-4"><div class="card p-3"><h6>📱 Android (Intra)</h6><ol class="small"><li>Install Play Store</li><li>Custom DoH: <code>https://${hostname}/dns-query</code></li><li>Test</li><li>Enable</li></ol></div></div>
            <div class="col-md-4"><div class="card p-3"><h6>🍎 iOS (1.1.1.1)</h6><ol class="small"><li>Install App Store</li><li>Custom DoH: <code>https://${hostname}/dns-query</code></li><li>Connect</li><li>Secure</li></ol></div></div>
            <div class="col-md-4"><div class="card p-3"><h6>🐧 Linux/macOS</h6><ol class="small"><li>Edit network</li><li>Custom DoH: <code>https://${hostname}/dns-query</code></li><li>Apply</li><li>Test: dig</li></ol></div></div>
            <div class="col-md-4"><div class="card p-3"><h6>🎮 Gaming</h6><ol class="small"><li>Add ?gaming=true</li><li>Low latency DNS</li><li>Optimized domains</li><li>Monitor perf</li></ol></div></div>
          </div>
        </div>
      </div>
      <div class="text-center mb-4">
        <a href="/browse" class="btn btn-primary btn-lg me-3">🌐 مرورگر وب</a>
        <a href="/health" class="btn btn-outline-light btn-lg me-3">🏥 سلامت</a>
        <a href="/status" class="btn btn-outline-light btn-lg me-3">📊 وضعیت</a>
        <a href="/proxy?url=https://httpbin.org/json" class="btn btn-outline-light btn-lg">🧪 تست Proxy</a>
      </div>
      <div class="card p-4 text-center">
        <h5>🚀 ویژگی‌های v2.5</h5>
        <div class="row g-2 justify-content-center">
          <div class="col-auto"><span class="badge bg-success">✅ Bootstrap RTL</span></div>
          <div class="col-auto"><span class="badge bg-info">🔒 Anti-Frame</span></div>
          <div class="col-auto"><span class="badge bg-warning">⚡ Async Cache</span></div>
          <div class="col-auto"><span class="badge bg-light text-dark">📊 Metrics</span></div>
          <div class="col-auto"><span class="badge bg-secondary">🔌 SNI-Connect</span></div>
          <div class="col-auto"><span class="badge bg-dark">🌍 IPv6</span></div>
        </div>
      </div>
      <div class="text-center mt-5 opacity-75">
        <p>🛡️ امن و قابل اعتماد | ⚡ سرعت نوری | 🔒 حریم خصوصی محفوظ</p>
        <small>v2.5 - ${updateDate}</small>
      </div>
    </div>
  </div>
</div>
<script>
document.addEventListener('DOMContentLoaded', () => {
  const cards = document.querySelectorAll('.card');
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.style.opacity = '1';
        entry.target.style.transform = 'translateY(0)';
      }
    });
  });
  cards.forEach(card => {
    card.style.opacity = '0.7';
    card.style.transform = 'translateY(20px)';
    card.style.transition = 'all 0.6s ease';
    observer.observe(card);
  });
});
</script>
</body>
</html>`;
}
```
