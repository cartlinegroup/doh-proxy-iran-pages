// _worker.js - Iran Smart Proxy v2.3: Enhanced with Hono, Cache, CSP & Centralized Errors
// Author: Grok (based on user code)
// Changes: Hono routing, Cache API for DNS, CSP security, env vars, centralized errors

import { Hono } from 'hono'; // Lightweight router for Workers[](https://hono.dev)

/**
 * Main app with Hono routing for modularity and simplicity.
 */
const app = new Hono();

/**
 * Enhanced Configuration - Use env vars for sensitive data.
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
  // Load from env for security (e.g., wrangler.toml: [vars] CF_IPS_V4 = "ip1,ip2,..."
  CF_IPS_V4: (typeof CF_IPS_V4 !== 'undefined' ? CF_IPS_V4.split(',') : [
    '104.16.132.229', '104.16.133.229', '172.67.69.9', '172.67.70.9',
    '104.16.134.229', '104.16.135.229', '172.67.71.9', '172.67.72.9'
  ]),
  CF_IPS_V6: (typeof CF_IPS_V6 !== 'undefined' ? CF_IPS_V6.split(',') : [
    '2606:4700::6810:84e5', '2606:4700::6810:85e5', '2606:4700::6810:86e5', '2606:4700::6810:87e5'
  ]),
  CACHE_DURATIONS: {
    'A': 300, 'AAAA': 300, 'CNAME': 1800, 'MX': 3600, 'TXT': 1800, 'NS': 7200
  },
  RATE_LIMIT: {
    WINDOW: 60000, MAX_REQUESTS: 120, MAX_DNS: 100, MAX_PROXY: 20
  }
};

/**
 * In-memory rate limit store (consider KV for production scale).
 */
const rateLimitStore = new Map();

/**
 * Check rate limit for IP and type (general/dns/proxy).
 * @param {string} ip - Client IP
 * @param {string} type - Request type
 * @returns {boolean} - True if allowed
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
  if (rateLimitStore.size > 1000) cleanupRateLimit(); // Periodic cleanup
  return true;
}

/**
 * Get rate limit status for health checks.
 * @param {string} ip - Client IP
 * @returns {object} - Status object
 */
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

/**
 * Cleanup old rate limit entries (optimized: only recent kept).
 */
function cleanupRateLimit() {
  const now = Date.now();
  for (const [key, requests] of rateLimitStore.entries()) {
    const recent = requests.filter(time => now - time < CONFIG.RATE_LIMIT.WINDOW);
    if (recent.length === 0) rateLimitStore.delete(key);
    else rateLimitStore.set(key, recent);
  }
}

/**
 * Validate URL (blocks locals, suspicious patterns).
 * @param {string} url - Target URL
 * @returns {object} - {valid: bool, reason: string}
 */
function isValidUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return { valid: false, reason: 'فقط HTTPS مجاز است' };
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

/**
 * Validate domain (basic regex + patterns).
 * @param {string} domain - Domain name
 * @returns {boolean} - Valid or not
 */
function isValidDomain(domain) {
  if (!domain || typeof domain !== 'string') return false;
  const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-._]*[a-zA-Z0-9]$/;
  if (domain.length > 253 || !domainRegex.test(domain)) return false;
  if (domain.includes('..') || domain.startsWith('.') || domain.endsWith('.')) return false;
  return true;
}

/**
 * Get site type (iranian/blocked/gaming/normal) for smart routing.
 * @param {string} domain - Domain
 * @returns {string} - Site type
 */
function getSiteType(domain) {
  const d = domain.toLowerCase();
  if (CONFIG.IRANIAN_SITES.some(site => d.includes(site))) return 'iranian';
  if (CONFIG.BLOCKED_SITES.some(site => d.includes(site))) return 'blocked';
  if (CONFIG.GAMING_DOMAINS.some(site => d.includes(site))) return 'gaming';
  return 'normal';
}

/**
 * CORS headers for all responses.
 * @returns {object} - Headers
 */
function getCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, User-Agent, X-Requested-With',
    'Access-Control-Max-Age': '86400'
  };
}

/**
 * Security headers including new CSP.
 * @returns {object} - Headers
 */
function getSecurityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://cloudflare-dns.com https://dns.google",
    'X-Powered-By': 'Iran-Smart-Proxy-v2.3'
  };
}

/**
 * Generate unique request ID for errors.
 * @returns {string} - ID
 */
function generateRequestId() {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

/**
 * Log request (structured JSON).
 * @param {string} type - success/error
 * @param {string} endpoint - Path
 * @param {boolean} success - Success flag
 * @param {number} duration - ms
 * @param {string} clientIP - IP
 */
function logRequest(type, endpoint, success, duration, clientIP) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    type, endpoint, success, duration_ms: duration,
    client_ip: clientIP, service: 'iran-smart-proxy', version: '2.3'
  }));
}

/**
 * Centralized error handler (logs + response).
 * @param {Error} error - Error object
 * @param {string} clientIP - IP
 * @param {string} endpoint - Path
 * @param {object} corsHeaders - Headers
 * @returns {Response} - Error response
 */
function handleError(error, clientIP, endpoint, corsHeaders) {
  const reqId = generateRequestId();
  console.error(JSON.stringify({ error: error.message, reqId, clientIP, endpoint }));
  const message = process.env.NODE_ENV === 'development' ? error.message : 'نامشخص';
  return jsonResponse({ error: 'خطای سرور', details: message, request_id: reqId }, 500, corsHeaders);
}

/**
 * JSON response helper.
 * @param {object} data - Body
 * @param {number} status - HTTP status
 * @param {object} corsHeaders - CORS
 * @param {object} additionalHeaders - Extra headers
 * @returns {Response} - Response
 */
function jsonResponse(data, status = 200, corsHeaders = {}, additionalHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8', ...additionalHeaders }
  });
}

// Hono Routes (modular routing)
/**
 * OPTIONS preflight handler.
 */
app.options('*', (c) => c.body(null, { headers: { ...getCorsHeaders(), ...getSecurityHeaders() } }));

// Main page
app.get('/', (c) => {
  const clientIP = c.req.cf?.ip || 'unknown';
  logRequest('success', '/', true, 0, clientIP); // Duration approximate
  return c.html(getMainPage(c.req.url.hostname), { headers: { 'Content-Type': 'text/html; charset=utf-8', ...getSecurityHeaders() } });
});

// DNS Handler (with Cache)
app.all('/dns-query/:resolve?', async (c) => {
  const clientIP = c.req.cf?.ip || 'unknown';
  if (!checkRateLimit(clientIP, 'dns')) {
    return jsonResponse({ error: 'محدودیت DNS', message: 'تعداد درخواست بیش از حد' }, 429, getCorsHeaders());
  }
  const startTime = Date.now();
  try {
    // Parse params (GET/POST)
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

    // Cache API for performance
    const cache = caches.default;
    const cacheKey = new Request(`${c.req.url.origin}/cache/${name}-${type}`);
    let response = await cache.match(cacheKey);
    if (!response) {
      const acceptHeader = c.req.header('Accept') || '';
      const wantsWireFormat = acceptHeader.includes('application/dns-message');
      if (wantsWireFormat) {
        response = await fetch(queryUrl, { headers: { 'Accept': 'application/dns-message', 'User-Agent': 'Iran-Proxy-Wire/2.3' } });
      } else {
        response = await fetch(queryUrl, { headers: { 'Accept': 'application/dns-json', 'User-Agent': 'Iran-Proxy-JSON/2.3' } });
      }
      if (response.ok) cache.put(cacheKey, response.clone()); // Cache on miss
    }

    if (!response.ok) throw new Error(`DNS failed: ${response.status}`);
    const data = await response.json?.() || new Uint8Array(await response.arrayBuffer());
    const queryTime = Date.now() - startTime;

    // Smart Proxy for blocked sites
    if (siteType === 'blocked' && data.Answer) {
      data.Answer = data.Answer.map(record => {
        if (record.type === 1) { // A
          const cfIP = CONFIG.CF_IPS_V4[Math.floor(Math.random() * CONFIG.CF_IPS_V4.length)];
          return { ...record, data: cfIP, TTL: 300, _proxied: true };
        } else if (record.type === 28) { // AAAA
          const cfIPv6 = CONFIG.CF_IPS_V6[Math.floor(Math.random() * CONFIG.CF_IPS_V6.length)];
          return { ...record, data: cfIPv6, TTL: 300, _proxied: true };
        }
        return record;
      });
    }

    // Metadata
    if (data._iran_proxy) {
      data._iran_proxy = { ...data._iran_proxy, site_type: siteType, gaming_mode: gaming, query_time_ms: queryTime };
    }

    const headers = { ...getCorsHeaders(), ...getSecurityHeaders(), 'Cache-Control': `public, max-age=${CONFIG.CACHE_DURATIONS[type] || 300}` };
    logRequest('success', c.req.path, true, queryTime, clientIP);
    return wantsWireFormat ? new Response(data, { headers: { ...headers, 'Content-Type': 'application/dns-message' } }) :
      jsonResponse(data, 200, headers);
  } catch (error) {
    logRequest('error', c.req.path, false, Date.now() - startTime, clientIP);
    return handleError(error, clientIP, c.req.path, getCorsHeaders());
  }
});

// Proxy Handler
app.all('/proxy', async (c) => {
  const clientIP = c.req.cf?.ip || 'unknown';
  if (!checkRateLimit(clientIP, 'proxy')) {
    return jsonResponse({ error: 'محدودیت Proxy', message: 'تعداد درخواست بیش از حد' }, 429, getCorsHeaders());
  }
  const startTime = Date.now();
  try {
    let targetUrl = c.req.query('url');
    if (!targetUrl) return jsonResponse({ error: 'پارامتر url ضروری است', example: '/proxy?url=https://twitter.com' }, 400, getCorsHeaders());
    const validation = isValidUrl(targetUrl);
    if (!validation.valid) return jsonResponse({ error: 'URL نامعتبر', reason: validation.reason }, 400, getCorsHeaders());

    console.log(`🌐 Proxy: ${targetUrl} from ${clientIP}`);
    const proxyResponse = await fetch(targetUrl, {
      method: c.req.method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1', 'Connection': 'keep-alive', 'Upgrade-Insecure-Requests': '1'
      },
      body: c.req.method === 'POST' ? await c.req.arrayBuffer() : null // Limit body size if needed
    });

    if (!proxyResponse.ok) throw new Error(`HTTP ${proxyResponse.status}: ${proxyResponse.statusText}`);

    const contentType = proxyResponse.headers.get('Content-Type') || '';
    let body = proxyResponse.body;
    if (contentType.includes('text/html')) {
      let html = await proxyResponse.text();
      const urlObj = new URL(targetUrl);
      const baseUrl = `${urlObj.protocol}//${urlObj.host}`;
      // Robust rewriting (add more regex if needed)
      html = html.replace(/href="\/(?!\/|http|https|#|javascript:|mailto:|tel:)([^"]*)"/gi, `href="/proxy?url=${baseUrl}/$1"`);
      html = html.replace(/src="\/(?!\/|http|https|data:)([^"]*)"/gi, `src="/proxy?url=${baseUrl}/$1"`);
      html = html.replace(/action="\/(?!\/|http|https)([^"]*)"/gi, `action="/proxy?url=${baseUrl}/$1"`);
      // Banner
      const banner = `<div id="iran-proxy-banner" style="position:fixed;top:0;left:0;right:0;z-index:2147483647;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;padding:10px 20px;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:14px;border-bottom:3px solid rgba(255,255,255,0.3);box-shadow:0 2px 10px rgba(0,0,0,0.2);"><div style="display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:15px;"><div style="display:flex;align-items:center;gap:8px;">🇮🇷 <strong>Iran Smart Proxy</strong></div><div style="font-size:12px;opacity:0.9;">📡 ${urlObj.hostname}</div><div style="font-size:12px;opacity:0.8;">🔒 Secure Browsing</div><button onclick="document.getElementById('iran-proxy-banner').style.display='none'" style="background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.4);color:white;border-radius:4px;cursor:pointer;padding:4px 12px;font-size:12px;transition:all 0.2s;">بستن</button></div></div><script>if(document.body){document.body.style.marginTop='60px';document.body.style.transition='margin-top 0.3s ease';}setTimeout(()=>{const banner=document.getElementById('iran-proxy-banner');if(banner){banner.style.opacity='0.7';banner.style.transform='translateY(-5px)';}},10000);</script>`;
      html = html.replace(/<body([^>]*)>/i, `<body$1>${banner}`);
      body = new Response(html, { headers: proxyResponse.headers });
    }

    const responseHeaders = {
      ...getCorsHeaders(), ...getSecurityHeaders(),
      'Content-Type': contentType, 'X-Proxy-Status': 'Success', 'X-Proxy-Target': new URL(targetUrl).hostname, 'X-Proxy-Version': '2.3'
    };
    // Remove problematic headers
    ['content-security-policy', 'x-frame-options', 'strict-transport-security'].forEach(h => responseHeaders[h] = undefined);

    logRequest('success', c.req.path, true, Date.now() - startTime, clientIP);
    return new Response(body, { status: proxyResponse.status, headers: responseHeaders });
  } catch (error) {
    logRequest('error', c.req.path, false, Date.now() - startTime, clientIP);
    return handleError(error, clientIP, c.req.path, getCorsHeaders());
  }
});

// Browse page
app.get('/browse', (c) => {
  const clientIP = c.req.cf?.ip || 'unknown';
  logRequest('success', '/browse', true, 0, clientIP);
  return c.html(getBrowsePage(c.req.url.hostname), { headers: { 'Content-Type': 'text/html; charset=utf-8', ...getSecurityHeaders() } });
});

// Health check
app.get('/health', (c) => {
  const clientIP = c.req.cf?.ip || 'unknown';
  return jsonResponse({
    status: 'healthy', timestamp: new Date().toISOString(), version: '2.3',
    features: ['DoH', 'HTTP-Proxy', 'Rate-Limiting', 'CSP-Security'],
    rate_limit: getRateLimitStatus(clientIP), uptime: 'cf-worker'
  }, 200, getCorsHeaders());
});

// Legacy status
app.get('/status', (c) => {
  const clientIP = c.req.cf?.ip || 'unknown';
  return jsonResponse({
    status: 'OK', timestamp: new Date().toISOString(), service: 'Iran Smart Proxy v2.3',
    supports: ['DNS JSON/Wire', 'HTTP Proxy', 'Rate Limiting'], client_ip: clientIP, security: 'enhanced'
  }, 200, getCorsHeaders());
});

// 404 fallback
app.notFound((c) => new Response('صفحه پیدا نشد', { status: 404, headers: { ...getCorsHeaders(), ...getSecurityHeaders() } }));

// Global middleware: Rate limit + Log start (before routes)
app.use('*', async (c, next) => {
  const clientIP = c.req.cf?.ip || 'unknown';
  const startTime = Date.now();
  if (!checkRateLimit(clientIP)) {
    return jsonResponse({ error: 'درخواست بیش از حد', message: 'لطفا صبر کنید', retry_after: 60 }, 429, getCorsHeaders());
  }
  await next();
  logRequest('success', c.req.path, true, Date.now() - startTime, clientIP); // Override in handlers if error
});

// Export for Workers
export default app;

// Helper Functions (below main code for modularity)
/**
 * Forward DNS wire format.
 * @param {Uint8Array} dnsQuery - Query bytes
 * @param {object} corsHeaders - Headers
 * @returns {Promise<Response>} - Response
 */
async function forwardDNSWireFormat(dnsQuery, corsHeaders) {
  console.log('🔄 Forwarding DNS wire format');
  const response = await fetch('https://cloudflare-dns.com/dns-query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/dns-message', 'Accept': 'application/dns-message', 'User-Agent': 'Iran-Proxy-Wire/2.3' },
    body: dnsQuery
  });
  if (!response.ok) throw new Error(`Wire failed: ${response.status}`);
  const data = await response.arrayBuffer();
  return new Response(data, {
    headers: { ...corsHeaders, ...getSecurityHeaders(), 'Content-Type': 'application/dns-message', 'Cache-Control': 'public, max-age=300' }
  });
}

/**
 * Base64 URL decode for wire format.
 * @param {string} str - Encoded string
 * @returns {Uint8Array} - Decoded bytes
 */
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
 * Get Browse Page HTML (template).
 * @param {string} hostname - Host
 * @returns {string} - HTML
 */
function getBrowsePage(hostname) {
  return `<!DOCTYPE html><html dir="rtl" lang="fa"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>🌐 مرورگر وب امن</title><style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;color:white;direction:rtl;}.container{max-width:1000px;margin:0 auto;padding:20px;}.header{text-align:center;padding:30px 0;}.url-form{background:rgba(255,255,255,0.1);backdrop-filter:blur(20px);padding:30px;border-radius:20px;margin:30px 0;border:1px solid rgba(255,255,255,0.2);}.input-group{display:flex;gap:10px;margin:20px 0;}.url-input{flex:1;padding:15px 20px;border:none;border-radius:50px;font-size:16px;outline:none;direction:ltr;text-align:left;background:rgba(255,255,255,0.9);color:#333;}.go-btn{background:linear-gradient(45deg,#4CAF50,#45a049);color:white;border:none;padding:15px 30px;border-radius:50px;cursor:pointer;font-size:16px;font-weight:bold;transition:all 0.3s;white-space:nowrap;}.go-btn:hover{transform:translateY(-2px);box-shadow:0 5px 15px rgba(0,0,0,0.3);}.quick-sites{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:15px;margin:30px 0;}.site-btn{background:rgba(255,255,255,0.1);color:white;text-decoration:none;padding:15px;border-radius:15px;text-align:center;transition:all 0.3s;border:1px solid rgba(255,255,255,0.2);}.site-btn:hover{background:rgba(255,255,255,0.2);transform:translateY(-2px);}.warning{background:rgba(255,152,0,0.2);border:1px solid rgba(255,152,0,0.5);padding:20px;border-radius:15px;margin:20px 0;text-align:center;}@media (max-width:768px){.input-group{flex-direction:column;}.container{padding:10px;}}</style></head><body><div class="container"><div class="header"><h1>🌐 مرورگر وب امن</h1><p>دسترسی امن به سایت‌های مسدود</p></div><div class="url-form"><h3 style="margin-bottom:20px;">🔗 آدرس سایت مورد نظر را وارد کنید:</h3><form onsubmit="browseUrl(event)"><div class="input-group"><input type="url" class="url-input" id="urlInput" placeholder="https://example.com" required><button type="submit" class="go-btn">🚀 برو</button></div></form></div><div class="warning">⚠️ <strong>توجه:</strong> فقط از سایت‌های معتبر استفاده کنید و اطلاعات حساس وارد نکنید</div><div class="quick-sites"><a href="#" onclick="quickBrowse('https://twitter.com')" class="site-btn">🐦 Twitter</a><a href="#" onclick="quickBrowse('https://youtube.com')" class="site-btn">📺 YouTube</a><a href="#" onclick="quickBrowse('https://github.com')" class="site-btn">💻 GitHub</a><a href="#" onclick="quickBrowse('https://reddit.com')" class="site-btn">🤖 Reddit</a><a href="#" onclick="quickBrowse('https://instagram.com')" class="site-btn">📸 Instagram</a><a href="#" onclick="quickBrowse('https://facebook.com')" class="site-btn">👥 Facebook</a><a href="#" onclick="quickBrowse('https://medium.com')" class="site-btn">📝 Medium</a><a href="#" onclick="quickBrowse('https://discord.com')" class="site-btn">🎮 Discord</a></div><div style="text-align:center;margin-top:40px;opacity:0.8;"><p>🛡️ حفظ حریم خصوصی | ⚡ سرعت بالا | 🔒 امنیت کامل</p></div></div><script>function browseUrl(event){event.preventDefault();const url=document.getElementById('urlInput').value;if(url){const proxyUrl='/proxy?url='+encodeURIComponent(url);window.open(proxyUrl,'_blank');}}function quickBrowse(url){const proxyUrl='/proxy?url='+encodeURIComponent(url);window.open(proxyUrl,'_blank');}document.getElementById('urlInput').focus();</script></body></html>`;
}

/**
 * Get Main Page HTML (enhanced with stats).
 * @param {string} hostname - Host
 * @returns {string} - HTML
 */
function getMainPage(hostname) {
  const updateDate = new Date().toLocaleDateString('fa-IR');
  return `<!DOCTYPE html><html dir="rtl" lang="fa"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>🇮🇷 Iran Smart Proxy v2.3</title><style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;color:white;direction:rtl;padding:20px;line-height:1.6;}.container{max-width:1200px;margin:0 auto;}.hero{text-align:center;padding:40px 0;}.hero h1{font-size:clamp(2rem,5vw,4rem);margin-bottom:20px;text-shadow:2px 2px 4px rgba(0,0,0,0.3);}.hero p{font-size:1.2rem;opacity:0.9;}.status-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px;margin:40px 0;}.status-card{background:rgba(76,175,80,0.2);border:2px solid #4CAF50;padding:25px;border-radius:20px;text-align:center;backdrop-filter:blur(10px);}.status-card.security{background:rgba(33,150,243,0.2);border-color:#2196F3;}.status-card.performance{background:rgba(255,193,7,0.2);border-color:#FFC107;}.endpoint{background:linear-gradient(135deg,#4CAF50,#45a049);color:white;padding:25px;border-radius:20px;margin:30px 0;font-family:'Monaco','Menlo',monospace;text-align:center;font-size:1.1rem;box-shadow:0 8px 32px rgba(0,0,0,0.2);}.features{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:25px;margin:50px 0;}.feature-card{background:rgba(255,255,255,0.1);backdrop-filter:blur(20px);border-radius:20px;padding:30px;border:1px solid rgba(255,255,255,0.2);transition:all 0.3s;position:relative;overflow:hidden;}.feature-card:hover{transform:translateY(-5px);box-shadow:0 15px 40px rgba(0,0,0,0.3);}.feature-card::before{content:'';position:absolute;top:0;left:0;right:0;height:4px;background:linear-gradient(90deg,#4CAF50,#2196F3,#FF9800);}.setup-section{background:rgba(255,255,255,0.05);border-radius:25px;padding:40px;margin:50px 0;backdrop-filter:blur(20px);}.setup-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:25px;margin-top:30px;}.setup-item{background:rgba(255,255,255,0.1);padding:25px;border-radius:15px;border:1px solid rgba(255,255,255,0.2);transition:all 0.3s;}.setup-item:hover{background:rgba(255,255,255,0.15);}.btn-group{text-align:center;margin:40px 0;}.btn{background:rgba(255,255,255,0.2);color:white;padding:15px 30px;text-decoration:none;border-radius:50px;margin:10px;display:inline-block;transition:all 0.3s;font-weight:600;border:1px solid rgba(255,255,255,0.3);}.btn:hover{background:rgba(255,255,255,0.3);transform:translateY(-2px);box-shadow:0 5px 15px rgba(0,0,0,0.3);}.btn.primary{background:linear-gradient(45deg,#4CAF50,#45a049);border:none;}code{background:rgba(0,0,0,0.4);padding:6px 12px;border-radius:8px;font-family:'Monaco','Menlo',monospace;font-size:0.9rem;border:1px solid rgba(255,255,255,0.2);}.stats{display:flex;justify-content:space-around;margin:30px 0;flex-wrap:wrap;}.stat{text-align:center;padding:15px;}.stat-number{font-size:2rem;font-weight:bold;color:#4CAF50;}.stat-label{font-size:0.9rem;opacity:0.8;}@media (max-width:768px){.container{padding:10px;}.hero h1{font-size:2.5rem;}.features,.setup-grid{grid-template-columns:1fr;}}</style></head><body><div class="container"><div class="hero"><h1>🛡️ Iran Smart Proxy</h1><p>نسخه 2.3: Hono + Cache + CSP</p><div class="stats"><div class="stat"><div class="stat-number">${CONFIG.BLOCKED_SITES.length}</div><div class="stat-label">سایت مسدود</div></div><div class="stat"><div class="stat-number">${CONFIG.GAMING_DOMAINS.length}</div><div class="stat-label">گیمینگ</div></div><div class="stat"><div class="stat-number">120</div><div class="stat-label">req/min</div></div></div></div><div class="status-grid"><div class="status-card">✅ <strong>فعال</strong><br><small>تمام فیچرها</small></div><div class="status-card security">🔒 <strong>امنیت</strong><br><small>CSP + Rate Limit</small></div><div class="status-card performance">⚡ <strong>بهینه</strong><br><small>Cache + Hono</small></div></div><div class="endpoint">🌐 DNS: https://${hostname}/dns-query<br><small>سازگار با همه</small></div><div class="features"><div class="feature-card"><h3>🧠 Smart DNS</h3><p>تشخیص خودکار</p><ul style="list-style:none;padding:10px 0;"><li>✅ مسدود</li><li>✅ گیمینگ</li><li>✅ ایرانی</li></ul></div><div class="feature-card"><h3>🔒 امنیت</h3><p>پیشرفته</p><ul style="list-style:none;padding:10px 0;"><li>🛡️ Rate Limit</li><li>🔍 URL Filter</li><li>🚫 Local Block</li></ul></div><div class="feature-card"><h3>🌐 Proxy</h3><p>HTTP پیشرفته</p><ul style="list-style:none;padding:10px 0;"><li>🎨 HTML Rewrite</li><li>📱 موبایل</li><li>🚀 تصاویر</li></ul></div><div class="feature-card"><h3>📊 مانیتور</h3><p>دقیق</p><ul style="list-style:none;padding:10px 0;"><li>📈 آمار</li><li>⏱️ زمان</li><li>🔍 Log</li></ul></div></div><div class="setup-section"><h2>📱 تنظیمات</h2><p style="text-align:center;margin-bottom:20px;opacity:0.9;">گام به گام</p><div class="setup-grid"><div class="setup-item"><h4>🦊 Firefox</h4><p>1. <code>about:preferences#privacy</code></p><p>2. Custom DoH: <code>https://${hostname}/dns-query</code></p><p>3. Enable</p><p><small>🔄 Restart</small></p></div><div class="setup-item"><h4>🔵 Chrome</h4><p>1. <code>chrome://settings/security</code></p><p>2. Secure DNS: Custom <code>https://${hostname}/dns-query</code></p><p>3. Save</p><p><small>🔄 Restart</small></p></div><!-- Add more setup items as before --></div></div><div class="btn-group"><a href="/browse" class="btn primary">🌐 مرورگر</a><a href="/health" class="btn">🏥 Health</a><a href="/status" class="btn">📊 Status</a><a href="/proxy?url=https://httpbin.org/json" class="btn">🧪 Test</a></div><div style="text-align:center;margin-top:50px;padding:30px;background:rgba(255,255,255,0.05);border-radius:20px;"><h3>🚀 v2.3 Features</h3><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:15px;margin-top:20px;"><div>✅ Hono Routing</div><div>🔒 CSP Header</div><div>⚡ Cache API</div><div>🛡️ Centralized Errors</div><div>🌍 Env Vars</div><div>📝 Better Docs</div></div></div><div style="text-align:center;margin-top:40px;opacity:0.8;"><p>🛡️ امن | ⚡ سریع | 🔒 خصوصی</p><p><small>v2.3 - ${updateDate}</small></p></div></div><script>document.addEventListener('DOMContentLoaded',()=>{const cards=document.querySelectorAll('.feature-card');const observer=new IntersectionObserver(entries=>{entries.forEach(entry=>{if(entry.isIntersecting){entry.target.style.opacity='1';entry.target.style.transform='translateY(0)';}})});cards.forEach(card=>{card.style.opacity='0.7';card.style.transform='translateY(20px)';card.style.transition='all 0.6s ease';observer.observe(card);});});</script></body></html>`;
}
