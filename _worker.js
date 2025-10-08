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
  logRequest('error', endpoint
