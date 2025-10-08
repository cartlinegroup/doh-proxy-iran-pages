// _worker.js - Iran Smart Proxy v2.5: Approximate SNI Proxy via CONNECT Handling for Pages Functions
// Author: Mehdi feizezadeh
// Changes: Added /connect route for HTTP CONNECT (SNI-like), 501 for unsupported, metrics for CONNECT
// Compatible with Cloudflare Pages Functions (Hono + Wrangler deploy)

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
      data._iran_proxy = { site_type: siteType, gaming_mode: gaming, query_time_ms:
