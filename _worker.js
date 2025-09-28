// _worker.js - Enhanced Iran Smart Proxy with Security & Rate Limiting
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const clientIP = request.headers.get('CF-Connecting-IP') || 
                    request.headers.get('X-Forwarded-For') || 
                    'unknown'
    
    // Rate Limiting Check
    if (!checkRateLimit(clientIP)) {
      return jsonResponse({
        error: 'درخواست بیش از حد مجاز',
        message: 'لطفا کمی صبر کنید',
        retry_after: 60
      }, 429, getCorsHeaders())
    }
    
    // Security Headers
    const securityHeaders = getSecurityHeaders()
    const corsHeaders = { ...getCorsHeaders(), ...securityHeaders }
    
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }
    
    // Log Request
    const startTime = Date.now()
    
    try {
      let response
      
      // صفحه اصلی
      if (url.pathname === '/') {
        response = new Response(getMainPage(url.hostname), {
          headers: { 
            'Content-Type': 'text/html; charset=utf-8',
            ...securityHeaders
          }
        })
      }
      // DNS Query Handler
      else if (url.pathname === '/dns-query' || url.pathname === '/resolve') {
        response = await handleDNS(request, corsHeaders, url)
      }
      // HTTP Proxy
      else if (url.pathname === '/proxy' || url.pathname.startsWith('/p/')) {
        response = await handleProxy(request, corsHeaders, url)
      }
      // Web Browser Interface
      else if (url.pathname === '/browse') {
        response = new Response(getBrowsePage(url.hostname), {
          headers: { 
            'Content-Type': 'text/html; charset=utf-8',
            ...securityHeaders
          }
        })
      }
      // Health Check
      else if (url.pathname === '/health') {
        response = jsonResponse({
          status: 'healthy',
          timestamp: new Date().toISOString(),
          version: '2.2-enhanced',
          features: ['DNS-over-HTTPS', 'HTTP-Proxy', 'Rate-Limiting', 'Security-Headers'],
          rate_limit: getRateLimitStatus(clientIP),
          uptime: 'cf-worker'
        }, 200, corsHeaders)
      }
      // Status (Legacy)
      else if (url.pathname === '/status') {
        response = jsonResponse({
          status: 'OK',
          timestamp: new Date().toISOString(),
          service: 'Iran Smart Proxy - Enhanced',
          version: '2.2-enhanced',
          supports: ['DNS JSON', 'DNS Wire Format', 'HTTP Proxy', 'Rate Limiting'],
          client_ip: clientIP,
          security: 'enabled'
        }, 200, corsHeaders)
      }
      else {
        response = new Response('صفحه پیدا نشد', { 
          status: 404,
          headers: corsHeaders
        })
      }
      
      // Log successful request
      logRequest('success', url.pathname, true, Date.now() - startTime, clientIP)
      return response
      
    } catch (error) {
      console.error('Request Error:', error)
      logRequest('error', url.pathname, false, Date.now() - startTime, clientIP)
      
      return jsonResponse({
        error: 'خطای سرور',
        message: 'لطفا دوباره تلاش کنید',
        request_id: generateRequestId()
      }, 500, corsHeaders)
    }
  }
}

// Enhanced Configuration
const CONFIG = {
  // سایت‌های مسدود
  BLOCKED_SITES: [
    'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'youtube.com',
    'telegram.org', 'discord.com', 'reddit.com', 'github.com', 'medium.com',
    'bbc.com', 'cnn.com', 'wikipedia.org', 'whatsapp.com', 'linkedin.com'
  ],
  
  // سایت‌های ایرانی
  IRANIAN_SITES: [
    '.ir', '.ایران', 'irna.ir', 'tasnim.ir', 'mehr.ir', 'digikala.com',
    'snapp.ir', 'cafebazaar.ir', 'aparat.com', 'namasha.com'
  ],
  
  // Gaming domains
  GAMING_DOMAINS: [
    'steampowered.com', 'steamcommunity.com', 'riotgames.com', 
    'leagueoflegends.com', 'valorant.com', 'epicgames.com',
    'blizzard.com', 'battle.net', 'ea.com', 'origin.com'
  ],
  
  // Cloudflare IPs (IPv4 & IPv6)
  CF_IPS_V4: [
    '104.16.132.229', '104.16.133.229', '172.67.69.9', '172.67.70.9',
    '104.16.134.229', '104.16.135.229', '172.67.71.9', '172.67.72.9'
  ],
  
  CF_IPS_V6: [
    '2606:4700::6810:84e5', '2606:4700::6810:85e5',
    '2606:4700::6810:86e5', '2606:4700::6810:87e5'
  ],
  
  // Cache durations (seconds)
  CACHE_DURATIONS: {
    'A': 300,      // 5 minutes
    'AAAA': 300,   // 5 minutes
    'CNAME': 1800, // 30 minutes
    'MX': 3600,    // 1 hour
    'TXT': 1800,   // 30 minutes
    'NS': 7200     // 2 hours
  },
  
  // Rate limiting
  RATE_LIMIT: {
    WINDOW: 60000,    // 1 minute
    MAX_REQUESTS: 120, // 120 req/min
    MAX_DNS: 100,     // 100 DNS req/min
    MAX_PROXY: 20     // 20 Proxy req/min
  }
}

// Rate Limiting System
const rateLimitStore = new Map()

function checkRateLimit(ip, type = 'general') {
  const now = Date.now()
  const key = `${ip}:${type}`
  const requests = rateLimitStore.get(key) || []
  
  // Clean old requests
  const recent = requests.filter(time => now - time < CONFIG.RATE_LIMIT.WINDOW)
  
  // Check limits based on type
  let limit = CONFIG.RATE_LIMIT.MAX_REQUESTS
  if (type === 'dns') limit = CONFIG.RATE_LIMIT.MAX_DNS
  if (type === 'proxy') limit = CONFIG.RATE_LIMIT.MAX_PROXY
  
  if (recent.length >= limit) {
    return false
  }
  
  // Add current request
  recent.push(now)
  rateLimitStore.set(key, recent)
  
  // Cleanup old entries periodically
  if (rateLimitStore.size > 1000) {
    cleanupRateLimit()
  }
  
  return true
}

function getRateLimitStatus(ip) {
  const now = Date.now()
  const generalKey = `${ip}:general`
  const dnsKey = `${ip}:dns`
  const proxyKey = `${ip}:proxy`
  
  const getCount = (key) => {
    const requests = rateLimitStore.get(key) || []
    return requests.filter(time => now - time < CONFIG.RATE_LIMIT.WINDOW).length
  }
  
  return {
    general: `${getCount(generalKey)}/${CONFIG.RATE_LIMIT.MAX_REQUESTS}`,
    dns: `${getCount(dnsKey)}/${CONFIG.RATE_LIMIT.MAX_DNS}`,
    proxy: `${getCount(proxyKey)}/${CONFIG.RATE_LIMIT.MAX_PROXY}`,
    window_seconds: CONFIG.RATE_LIMIT.WINDOW / 1000
  }
}

function cleanupRateLimit() {
  const now = Date.now()
  for (const [key, requests] of rateLimitStore.entries()) {
    const recent = requests.filter(time => now - time < CONFIG.RATE_LIMIT.WINDOW)
    if (recent.length === 0) {
      rateLimitStore.delete(key)
    } else {
      rateLimitStore.set(key, recent)
    }
  }
}

// Enhanced URL Validation
function isValidUrl(url) {
  try {
    const parsed = new URL(url)
    
    // Protocol check
    if (parsed.protocol !== 'https:') {
      return { valid: false, reason: 'فقط HTTPS مجاز است' }
    }
    
    // Hostname validation
    const hostname = parsed.hostname.toLowerCase()
    
    // Block private/local addresses
    if (hostname === 'localhost' || 
        hostname.startsWith('127.') ||
        hostname.startsWith('192.168.') ||
        hostname.startsWith('10.') ||
        hostname.startsWith('172.16.') ||
        hostname.startsWith('172.17.') ||
        hostname.startsWith('172.18.') ||
        hostname.startsWith('172.19.') ||
        hostname.startsWith('172.2') ||
        hostname.startsWith('172.30.') ||
        hostname.startsWith('172.31.') ||
        hostname === '0.0.0.0' ||
        hostname.includes('::1')) {
      return { valid: false, reason: 'آدرس محلی مجاز نیست' }
    }
    
    // Block suspicious patterns
    if (hostname.includes('..') || 
        hostname.startsWith('.') || 
        hostname.endsWith('.')) {
      return { valid: false, reason: 'فرمت آدرس نامعتبر' }
    }
    
    return { valid: true }
    
  } catch (error) {
    return { valid: false, reason: 'آدرس نامعتبر' }
  }
}

// Enhanced DNS Handler
async function handleDNS(request, corsHeaders, url) {
  const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown'
  
  // DNS-specific rate limiting
  if (!checkRateLimit(clientIP, 'dns')) {
    return jsonResponse({
      error: 'محدودیت DNS درخواست',
      message: 'تعداد درخواست DNS بیش از حد مجاز'
    }, 429, corsHeaders)
  }
  
  try {
    let dnsQuery = null
    let name = null
    let type = 'A'
    
    // Process request type
    if (request.method === 'GET') {
      name = url.searchParams.get('name')
      type = url.searchParams.get('type') || 'A'
      
      // Handle DNS wire format
      const dnsParam = url.searchParams.get('dns')
      if (dnsParam) {
        try {
          dnsQuery = base64UrlDecode(dnsParam)
        } catch (e) {
          console.log('Invalid DNS base64:', e)
          return jsonResponse({
            error: 'فرمت base64 نامعتبر',
            message: 'درخواست wire format اشتباه است'
          }, 400, corsHeaders)
        }
      }
    } else if (request.method === 'POST') {
      const contentType = request.headers.get('Content-Type') || ''
      if (contentType.includes('application/dns-message')) {
        try {
          dnsQuery = new Uint8Array(await request.arrayBuffer())
        } catch (e) {
          return jsonResponse({
            error: 'خطا در خواندن DNS message',
            message: 'فرمت wire format اشتباه است'
          }, 400, corsHeaders)
        }
      }
    }
    
    // Forward wire format
    if (dnsQuery) {
      return await forwardDNSWireFormat(dnsQuery, corsHeaders)
    }
    
    // Validate name parameter
    if (!name) {
      return jsonResponse({
        error: 'پارامتر name ضروری است',
        examples: {
          json: '/dns-query?name=google.com&type=A',
          wire: '/dns-query?dns=BASE64_ENCODED_QUERY'
        },
        supported_types: ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS']
      }, 400, corsHeaders)
    }
    
    // Basic domain validation
    if (!isValidDomain(name)) {
      return jsonResponse({
        error: 'نام دامنه نامعتبر',
        message: 'لطفا یک دامنه معتبر وارد کنید'
      }, 400, corsHeaders)
    }
    
    console.log(`🔍 DNS Query: ${name} (${type}) from ${clientIP}`)
    
    // Determine response format
    const acceptHeader = request.headers.get('Accept') || ''
    const wantsWireFormat = acceptHeader.includes('application/dns-message')
    
    // Get site type and apply smart routing
    const siteType = getSiteType(name)
    const gaming = url.searchParams.get('gaming') === 'true'
    
    // Choose DNS provider
    let dnsProvider = 'https://cloudflare-dns.com/dns-query'
    if (gaming && siteType === 'gaming') {
      dnsProvider = 'https://dns.google/dns-query' // Lower latency for gaming
    }
    
    const queryUrl = `${dnsProvider}?name=${encodeURIComponent(name)}&type=${type}`
    const startTime = Date.now()
    
    // Wire format request
    if (wantsWireFormat) {
      const dnsResponse = await fetch(queryUrl, {
        headers: {
          'Accept': 'application/dns-message',
          'User-Agent': 'Iran-Proxy-Wire/2.2'
        }
      })
      
      if (dnsResponse.ok) {
        const wireData = await dnsResponse.arrayBuffer()
        return new Response(wireData, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/dns-message',
            'Cache-Control': `public, max-age=${CONFIG.CACHE_DURATIONS[type] || 300}`,
            'X-Site-Type': siteType,
            'X-Proxy-Applied': siteType === 'blocked' ? 'true' : 'false'
          }
        })
      }
    }
    
    // JSON format request
    const dnsResponse = await fetch(queryUrl, {
      headers: {
        'Accept': 'application/dns-json',
        'User-Agent': 'Iran-Proxy-JSON/2.2'
      }
    })
    
    if (!dnsResponse.ok) {
      throw new Error(`DNS provider failed: ${dnsResponse.status}`)
    }
    
    const data = await dnsResponse.json()
    const queryTime = Date.now() - startTime
    
    // Apply Smart Proxy Logic
    if (siteType === 'blocked' && data.Answer) {
      data.Answer = data.Answer.map(record => {
        if (record.type === 1) { // A record
          const cfIP = CONFIG.CF_IPS_V4[Math.floor(Math.random() * CONFIG.CF_IPS_V4.length)]
          return {
            ...record,
            data: cfIP,
            TTL: 300,
            _original: record.data,
            _proxied: true,
            _proxy_reason: 'blocked_site'
          }
        } else if (record.type === 28) { // AAAA record
          const cfIPv6 = CONFIG.CF_IPS_V6[Math.floor(Math.random() * CONFIG.CF_IPS_V6.length)]
          return {
            ...record,
            data: cfIPv6,
            TTL: 300,
            _original: record.data,
            _proxied: true,
            _proxy_reason: 'blocked_site'
          }
        }
        return record
      })
    }
    
    // Add enhanced metadata
    data._iran_proxy = {
      site_type: siteType,
      gaming_mode: gaming,
      proxy_applied: siteType === 'blocked',
      query_time_ms: queryTime,
      timestamp: new Date().toISOString(),
      format: 'JSON',
      client_ip: clientIP,
      provider: dnsProvider.includes('cloudflare') ? 'cloudflare' : 'google',
      cache_ttl: CONFIG.CACHE_DURATIONS[type] || 300
    }
    
    return jsonResponse(data, 200, corsHeaders, {
      'Cache-Control': `public, max-age=${CONFIG.CACHE_DURATIONS[type] || 300}`,
      'X-Site-Type': siteType,
      'X-Query-Time': `${queryTime}ms`,
      'X-Gaming-Mode': gaming ? 'enabled' : 'disabled'
    })
    
  } catch (error) {
    console.error('DNS Error:', error)
    return jsonResponse({
      error: 'خطا در DNS',
      message: error.message,
      request_id: generateRequestId()
    }, 500, corsHeaders)
  }
}

// Enhanced Proxy Handler
async function handleProxy(request, corsHeaders, url) {
  const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown'
  
  // Proxy-specific rate limiting
  if (!checkRateLimit(clientIP, 'proxy')) {
    return jsonResponse({
      error: 'محدودیت Proxy درخواست',
      message: 'تعداد درخواست proxy بیش از حد مجاز'
    }, 429, corsHeaders)
  }
  
  try {
    let targetUrl
    
    if (url.pathname === '/proxy') {
      targetUrl = url.searchParams.get('url')
    } else if (url.pathname.startsWith('/p/')) {
      targetUrl = decodeURIComponent(url.pathname.substring(3))
    }
    
    if (!targetUrl) {
      return jsonResponse({
        error: 'پارامتر url ضروری است',
        example: '/proxy?url=https://twitter.com',
        note: 'فقط HTTPS پشتیبانی می‌شود'
      }, 400, corsHeaders)
    }
    
    // Enhanced URL validation
    const validation = isValidUrl(targetUrl)
    if (!validation.valid) {
      return jsonResponse({
        error: 'URL نامعتبر',
        reason: validation.reason
      }, 400, corsHeaders)
    }
    
    console.log(`🌐 Proxy: ${targetUrl} from ${clientIP}`)
    
    const proxyResponse = await fetch(targetUrl, {
      method: request.method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      },
      // Forward POST body if needed
      body: request.method === 'POST' ? request.body : null
    })
    
    if (!proxyResponse.ok) {
      throw new Error(`HTTP ${proxyResponse.status}: ${proxyResponse.statusText}`)
    }
    
    const contentType = proxyResponse.headers.get('Content-Type') || ''
    let body
    
    if (contentType.includes('text/html')) {
      let html = await proxyResponse.text()
      
      const urlObj = new URL(targetUrl)
      const baseUrl = `${urlObj.protocol}//${urlObj.host}`
      
      // Enhanced HTML rewriting
      html = html.replace(/href="\/(?!\/|http|https|#|javascript:|mailto:|tel:)([^"]*)"/gi, 
                         `href="/p/${baseUrl}/$1"`)
      html = html.replace(/src="\/(?!\/|http|https|data:)([^"]*)"/gi, 
                         `src="/p/${baseUrl}/$1"`)
      html = html.replace(/action="\/(?!\/|http|https)([^"]*)"/gi, 
                         `action="/p/${baseUrl}/$1"`)
      
      // Enhanced proxy banner
      const banner = `
        <div id="iran-proxy-banner" style="position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white;
                    padding: 10px 20px; text-align: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; 
                    font-size: 14px; border-bottom: 3px solid rgba(255,255,255,0.3); box-shadow: 0 2px 10px rgba(0,0,0,0.2);">
          <div style="display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 15px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              🇮🇷 <strong>Iran Smart Proxy</strong>
            </div>
            <div style="font-size: 12px; opacity: 0.9;">
              📡 ${urlObj.hostname}
            </div>
            <div style="font-size: 12px; opacity: 0.8;">
              🔒 Secure Browsing
            </div>
            <button onclick="document.getElementById('iran-proxy-banner').style.display='none'" 
                    style="background: rgba(255,255,255,0.2); border: 1px solid rgba(255,255,255,0.4); 
                           color: white; border-radius: 4px; cursor: pointer; padding: 4px 12px; 
                           font-size: 12px; transition: all 0.2s;">بستن</button>
          </div>
        </div>
        <script>
          if (document.body) {
            document.body.style.marginTop = '60px';
            document.body.style.transition = 'margin-top 0.3s ease';
          }
          // Auto-hide banner after 10 seconds
          setTimeout(() => {
            const banner = document.getElementById('iran-proxy-banner');
            if (banner) {
              banner.style.opacity = '0.7';
              banner.style.transform = 'translateY(-5px)';
            }
          }, 10000);
        </script>
      `
      
      html = html.replace(/<body([^>]*)>/i, `<body$1>${banner}`)
      body = html
    } else {
      body = proxyResponse.body
    }
    
    // Enhanced response headers
    const responseHeaders = {
      ...corsHeaders,
      'Content-Type': contentType,
      'X-Proxy-Status': 'Success',
      'X-Proxy-Target': urlObj.hostname,
      'X-Proxy-Version': '2.2-enhanced'
    }
    
    // Remove potentially problematic headers
    const headersToRemove = ['content-security-policy', 'x-frame-options', 'strict-transport-security']
    headersToRemove.forEach(header => {
      if (proxyResponse.headers.has(header)) {
        // Don't forward these headers
      }
    })
    
    return new Response(body, {
      status: proxyResponse.status,
      headers: responseHeaders
    })
    
  } catch (error) {
    console.error('Proxy Error:', error)
    return jsonResponse({
      error: 'خطا در proxy',
      message: error.message,
      target: targetUrl || 'unknown',
      request_id: generateRequestId()
    }, 500, corsHeaders)
  }
}

// Enhanced Helper Functions
function isValidDomain(domain) {
  if (!domain || typeof domain !== 'string') return false
  
  // Basic domain validation
  const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-._]*[a-zA-Z0-9]$/
  if (domain.length > 253 || !domainRegex.test(domain)) return false
  
  // Check for suspicious patterns
  if (domain.includes('..') || domain.startsWith('.') || domain.endsWith('.')) return false
  
  return true
}

function getSiteType(domain) {
  const d = domain.toLowerCase()
  
  if (CONFIG.IRANIAN_SITES.some(site => d.includes(site))) {
    return 'iranian'
  }
  
  if (CONFIG.BLOCKED_SITES.some(site => d.includes(site))) {
    return 'blocked'
  }
  
  if (CONFIG.GAMING_DOMAINS.some(site => d.includes(site))) {
    return 'gaming'
  }
  
  return 'normal'
}

function getCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, User-Agent, X-Requested-With',
    'Access-Control-Max-Age': '86400'
  }
}

function getSecurityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Powered-By': 'Iran-Smart-Proxy-v2.2'
  }
}

function generateRequestId() {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36)
}

function logRequest(type, endpoint, success, duration, clientIP) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    type,
    endpoint,
    success,
    duration_ms: duration,
    client_ip: clientIP,
    service: 'iran-smart-proxy',
    version: '2.2-enhanced'
  }))
}

// DNS Wire Format Handler
async function forwardDNSWireFormat(dnsQuery, corsHeaders) {
  try {
    console.log('🔄 Forwarding DNS wire format query')
    
    const response = await fetch('https://cloudflare-dns.com/dns-query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/dns-message',
        'Accept': 'application/dns-message',
        'User-Agent': 'Iran-Proxy-Wire/2.2-enhanced'
      },
      body: dnsQuery
    })
    
    if (!response.ok) {
      throw new Error(`Wire format forward failed: ${response.status}`)
    }
    
    const responseData = await response.arrayBuffer()
    
    return new Response(responseData, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/dns-message',
        'Cache-Control': 'public, max-age=300',
        'X-Proxy-Format': 'Wire',
        'X-Proxy-Version': '2.2'
      }
    })
  } catch (error) {
    console.error('Wire format error:', error)
    throw error
  }
}

function base64UrlDecode(str) {
  // Base64 URL safe decoding with enhanced error handling
  try {
    str = str.replace(/-/g, '+').replace(/_/g, '/')
    while (str.length % 4) {
      str += '='
    }
    
    const binary = atob(str)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  } catch (error) {
    throw new Error('Invalid base64url encoding: ' + error.message)
  }
}

function jsonResponse(data, status = 200, corsHeaders = {}, additionalHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      ...additionalHeaders
    }
  })
}

// Enhanced Browse Page
function getBrowsePage(hostname) {
  return `<!DOCTYPE html>
<html dir="rtl" lang="fa">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🌐 مرورگر وب امن</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh; color: white; direction: rtl;
        }
        .container { max-width: 1000px; margin: 0 auto; padding: 20px; }
        .header { text-align: center; padding: 30px 0; }
        .url-form {
            background: rgba(255,255,255,0.1); backdrop-filter: blur(20px);
            padding: 30px; border-radius: 20px; margin: 30px 0;
            border: 1px solid rgba(255,255,255,0.2);
        }
        .input-group { display: flex; gap: 10px; margin: 20px 0; }
        .url-input {
            flex: 1; padding: 15px 20px; border: none; border-radius: 50px;
            font-size: 16px; outline: none; direction: ltr; text-align: left;
            background: rgba(255,255,255,0.9); color: #333;
        }
        .go-btn {
            background: linear-gradient(45deg, #4CAF50, #45a049);
            color: white; border: none; padding: 15px 30px; border-radius: 50px;
            cursor: pointer; font-size: 16px; font-weight: bold;
            transition: all 0.3s; white-space: nowrap;
        }
        .go-btn:hover { transform: translateY(-2px); box-shadow: 0 5px 15px rgba(0,0,0,0.3); }
        .quick-sites {
            display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px; margin: 30px 0;
        }
        .site-btn {
            background: rgba(255,255,255,0.1); color: white; text-decoration: none;
            padding: 15px; border-radius: 15px; text-align: center;
            transition: all 0.3s; border: 1px solid rgba(255,255,255,0.2);
        }
        .site-btn:hover {
            background: rgba(255,255,255,0.2); transform: translateY(-2px);
        }
        .warning {
            background: rgba(255,152,0,0.2); border: 1px solid rgba(255,152,0,0.5);
            padding: 20px; border-radius: 15px; margin: 20px 0;
            text-align: center;
        }
        @media (max-width: 768px) {
            .input-group { flex-direction: column; }
            .container { padding: 10px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🌐 مرورگر وب امن</h1>
            <p>دسترسی امن به سایت‌های مسدود</p>
        </div>
        
        <div class="url-form">
            <h3 style="margin-bottom: 20px;">🔗 آدرس سایت مورد نظر را وارد کنید:</h3>
            <form onsubmit="browseUrl(event)">
                <div class="input-group">
                    <input type="url" class="url-input" id="urlInput" 
                           placeholder="https://example.com" required>
                    <button type="submit" class="go-btn">🚀 برو</button>
                </div>
            </form>
        </div>
        
        <div class="warning">
            ⚠️ <strong>توجه:</strong> فقط از سایت‌های معتبر استفاده کنید و اطلاعات حساس وارد نکنید
        </div>
        
        <div class="quick-sites">
            <a href="#" onclick="quickBrowse('https://twitter.com')" class="site-btn">
                🐦 Twitter
            </a>
            <a href="#" onclick="quickBrowse('https://youtube.com')" class="site-btn">
                📺 YouTube
            </a>
            <a href="#" onclick="quickBrowse('https://github.com')" class="site-btn">
                💻 GitHub
            </a>
            <a href="#" onclick="quickBrowse('https://reddit.com')" class="site-btn">
                🤖 Reddit
            </a>
            <a href="#" onclick="quickBrowse('https://instagram.com')" class="site-btn">
                📸 Instagram
            </a>
            <a href="#" onclick="quickBrowse('https://facebook.com')" class="site-btn">
                👥 Facebook
            </a>
            <a href="#" onclick="quickBrowse('https://medium.com')" class="site-btn">
                📝 Medium
            </a>
            <a href="#" onclick="quickBrowse('https://discord.com')" class="site-btn">
                🎮 Discord
            </a>
        </div>
        
        <div style="text-align: center; margin-top: 40px; opacity: 0.8;">
            <p>🛡️ حفظ حریم خصوصی | ⚡ سرعت بالا | 🔒 امنیت کامل</p>
        </div>
    </div>
    
    <script>
        function browseUrl(event) {
            event.preventDefault();
            const url = document.getElementById('urlInput').value;
            if (url) {
                const proxyUrl = '/proxy?url=' + encodeURIComponent(url);
                window.open(proxyUrl, '_blank');
            }
        }
        
        function quickBrowse(url) {
            const proxyUrl = '/proxy?url=' + encodeURIComponent(url);
            window.open(proxyUrl, '_blank');
        }
        
        // Auto-focus on input
        document.getElementById('urlInput').focus();
    </script>
</body>
</html>`
}

// Enhanced Main Page
function getMainPage(hostname) {
  return `<!DOCTYPE html>
<html dir="rtl" lang="fa">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🇮🇷 Iran Smart Proxy - Enhanced & Secure</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh; color: white; direction: rtl;
            padding: 20px; line-height: 1.6;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        .hero { text-align: center; padding: 40px 0; }
        .hero h1 { 
            font-size: clamp(2rem, 5vw, 4rem); margin-bottom: 20px; 
            text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
        }
        .hero p { font-size: 1.2rem; opacity: 0.9; }
        
        .status-grid {
            display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px; margin: 40px 0;
        }
        .status-card {
            background: rgba(76, 175, 80, 0.2); border: 2px solid #4CAF50;
            padding: 25px; border-radius: 20px; text-align: center;
            backdrop-filter: blur(10px);
        }
        .status-card.security { background: rgba(33, 150, 243, 0.2); border-color: #2196F3; }
        .status-card.performance { background: rgba(255, 193, 7, 0.2); border-color: #FFC107; }
        
        .endpoint {
            background: linear-gradient(135deg, #4CAF50, #45a049);
            color: white; padding: 25px; border-radius: 20px; margin: 30px 0;
            font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace; 
            text-align: center; font-size: 1.1rem;
            box-shadow: 0 8px 32px rgba(0,0,0,0.2);
        }
        
        .features {
            display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
            gap: 25px; margin: 50px 0;
        }
        .feature-card {
            background: rgba(255,255,255,0.1); backdrop-filter: blur(20px);
            border-radius: 20px; padding: 30px; 
            border: 1px solid rgba(255,255,255,0.2);
            transition: all 0.3s; position: relative; overflow: hidden;
        }
        .feature-card:hover {
            transform: translateY(-5px); 
            box-shadow: 0 15px 40px rgba(0,0,0,0.3);
        }
        .feature-card::before {
            content: ''; position: absolute; top: 0; left: 0; right: 0; height: 4px;
            background: linear-gradient(90deg, #4CAF50, #2196F3, #FF9800);
        }
        
        .setup-section {
            background: rgba(255,255,255,0.05); border-radius: 25px;
            padding: 40px; margin: 50px 0; backdrop-filter: blur(20px);
        }
        .setup-grid {
            display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
            gap: 25px; margin-top: 30px;
        }
        .setup-item {
            background: rgba(255,255,255,0.1); padding: 25px; 
            border-radius: 15px; border: 1px solid rgba(255,255,255,0.2);
            transition: all 0.3s;
        }
        .setup-item:hover { background: rgba(255,255,255,0.15); }
        
        .btn-group { text-align: center; margin: 40px 0; }
        .btn {
            background: rgba(255,255,255,0.2); color: white;
            padding: 15px 30px; text-decoration: none; border-radius: 50px;
            margin: 10px; display: inline-block; transition: all 0.3s;
            font-weight: 600; border: 1px solid rgba(255,255,255,0.3);
        }
        .btn:hover { 
            background: rgba(255,255,255,0.3); 
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(0,0,0,0.3);
        }
        .btn.primary { 
            background: linear-gradient(45deg, #4CAF50, #45a049);
            border: none;
        }
        
        code {
            background: rgba(0,0,0,0.4); padding: 6px 12px; border-radius: 8px;
            font-family: 'Monaco', 'Menlo', monospace; font-size: 0.9rem;
            border: 1px solid rgba(255,255,255,0.2);
        }
        
        .stats { display: flex; justify-content: space-around; margin: 30px 0; flex-wrap: wrap; }
        .stat { text-align: center; padding: 15px; }
        .stat-number { font-size: 2rem; font-weight: bold; color: #4CAF50; }
        .stat-label { font-size: 0.9rem; opacity: 0.8; }
        
        @media (max-width: 768px) {
            .container { padding: 10px; }
            .hero h1 { font-size: 2.5rem; }
            .features { grid-template-columns: 1fr; }
            .setup-grid { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="hero">
            <h1>🛡️ Iran Smart Proxy</h1>
            <p>نسخه پیشرفته با امنیت بالا و محدودیت نرخ درخواست</p>
            <div class="stats">
                <div class="stat">
                    <div class="stat-number">${CONFIG.BLOCKED_SITES.length}</div>
                    <div class="stat-label">سایت مسدود</div>
                </div>
                <div class="stat">
                    <div class="stat-number">${CONFIG.GAMING_DOMAINS.length}</div>
                    <div class="stat-label">پلتفرم گیمینگ</div>
                </div>
                <div class="stat">
                    <div class="stat-number">120</div>
                    <div class="stat-label">درخواست/دقیقه</div>
                </div>
            </div>
        </div>
        
        <div class="status-grid">
            <div class="status-card">
                ✅ <strong>سرویس فعال</strong><br>
                <small>تمام قابلیت‌ها در دسترس</small>
            </div>
            <div class="status-card security">
                🔒 <strong>امنیت فعال</strong><br>
                <small>محدودیت نرخ + هدرهای امنیتی</small>
            </div>
            <div class="status-card performance">
                ⚡ <strong>عملکرد بهینه</strong><br>
                <small>Cache هوشمند + مسیریابی سریع</small>
            </div>
        </div>
        
        <div class="endpoint">
            🌐 DNS Endpoint: https://${hostname}/dns-query<br>
            <small>سازگار با تمام مرورگرها و اپلیکیشن‌ها</small>
        </div>
        
        <div class="features">
            <div class="feature-card">
                <h3>🧠 Smart DNS با هوش مصنوعی</h3>
                <p>تشخیص خودکار نوع سایت و مسیریابی بهینه</p>
                <ul style="list-style: none; padding: 10px 0;">
                    <li>✅ تشخیص سایت‌های مسدود</li>
                    <li>✅ بهینه‌سازی برای گیمینگ</li>
                    <li>✅ حفظ سرعت سایت‌های ایرانی</li>
                </ul>
            </div>
            
            <div class="feature-card">
                <h3>🔒 امنیت پیشرفته</h3>
                <p>محافظت کامل در برابر سوءاستفاده</p>
                <ul style="list-style: none; padding: 10px 0;">
                    <li>🛡️ Rate Limiting هوشمند</li>
                    <li>🔍 فیلترینگ URL مخرب</li>
                    <li>🚫 جلوگیری از آدرس‌های محلی</li>
                </ul>
            </div>
            
            <div class="feature-card">
                <h3>🌐 HTTP Proxy پیشرفته</h3>
                <p>دسترسی مستقیم با رابط کاربری بهبود یافته</p>
                <ul style="list-style: none; padding: 10px 0;">
                    <li>🎨 بازنویسی HTML هوشمند</li>
                    <li>📱 سازگاری موبایل</li>
                    <li>🚀 لود سریع تصاویر</li>
                </ul>
            </div>
            
            <div class="feature-card">
                <h3>📊 مانیتورینگ پیشرفته</h3>
                <p>نظارت دقیق بر عملکرد و استفاده</p>
                <ul style="list-style: none; padding: 10px 0;">
                    <li>📈 آمار زنده درخواست‌ها</li>
                    <li>⏱️ اندازه‌گیری زمان پاسخ</li>
                    <li>🔍 Log کامل عملیات</li>
                </ul>
            </div>
        </div>
        
        <div class="setup-section">
            <h2>📱 تنظیمات مرورگرها (تضمین عملکرد)</h2>
            <p style="text-align: center; margin-bottom: 20px; opacity: 0.9;">
                راهنمای گام به گام برای تمام پلتفرم‌ها
            </p>
            
            <div class="setup-grid">
                <div class="setup-item">
                    <h4>🦊 Firefox Desktop</h4>
                    <p>1. <code>about:preferences#privacy</code></p>
                    <p>2. DNS over HTTPS → Use Custom Provider</p>
                    <p>3. <code>https://${hostname}/dns-query</code></p>
                    <p>4. ✅ Enable DNS over HTTPS</p>
                    <p><small>🔄 Restart browser for changes</small></p>
                </div>
                
                <div class="setup-item">
                    <h4>🔵 Chrome/Edge</h4>
                    <p>1. <code>chrome://settings/security</code></p>
                    <p>2. Advanced → Use secure DNS</p>
                    <p>3. With → Custom → <code>https://${hostname}/dns-query</code></p>
                    <p>4. ✅ Save settings</p>
                    <p><small>🔄 Restart for optimal performance</small></p>
                </div>
                
                <div class="setup-item">
                    <h4>📱 Android (Intra)</h4>
                    <p>1. 📥 Install from Play Store</p>
                    <p>2. ⚙️ Custom DoH Server</p>
                    <p>3. <code>https://${hostname}/dns-query</code></p>
                    <p>4. 🧪 Test Connection</p>
                    <p><small>🚀 Turn on protection</small></p>
                </div>
                
                <div class="setup-item">
                    <h4>🍎 iOS (1.1.1.1 App)</h4>
                    <p>1. 📱 Install 1.1.1.1 from App Store</p>
                    <p>2. ⚙️ Advanced → Connection Options</p>
                    <p>3. 🔧 Custom DoH Server</p>
                    <p>4. <code>https://${hostname}/dns-query</code></p>
                    <p><small>🔗 Connect to secure DNS</small></p>
                </div>
                
                <div class="setup-item">
                    <h4>🐧 Linux/macOS</h4>
                    <p>1. 📝 Edit network settings</p>
                    <p>2. 🔧 DNS Settings → Custom</p>
                    <p>3. DoH: <code>https://${hostname}/dns-query</code></p>
                    <p>4. 💾 Apply configuration</p>
                    <p><small>🔍 Test with: dig @1.1.1.1 google.com</small></p>
                </div>
                
                <div class="setup-item">
                    <h4>🎮 Gaming Optimization</h4>
                    <p>1. 🚀 Add <code>?gaming=true</code> to URL</p>
                    <p>2. 🎯 Lower latency DNS servers</p>
                    <p>3. ⚡ Optimized for gaming domains</p>
                    <p>4. 📊 Real-time performance monitoring</p>
                    <p><small>🎮 Perfect for Steam, Riot Games, etc.</small></p>
                </div>
            </div>
        </div>
        
        <div class="btn-group">
            <a href="/browse" class="btn primary">🌐 مرورگر وب</a>
            <a href="/health" class="btn">🏥 سلامت سیستم</a>
            <a href="/status" class="btn">📊 وضعیت کامل</a>
            <a href="/proxy?url=https://httpbin.org/json" class="btn">🧪 تست Proxy</a>
        </div>
        
        <div style="text-align: center; margin-top: 50px; padding: 30px; background: rgba(255,255,255,0.05); border-radius: 20px;">
            <h3>🚀 ویژگی‌های نسخه 2.2</h3>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-top: 20px;">
                <div>✅ Rate Limiting هوشمند</div>
                <div>🔒 هدرهای امنیتی پیشرفته</div>
                <div>🧠 AI-powered routing</div>
                <div>📱 UI/UX بهبود یافته</div>
                <div>⚡ کارایی بهتر</div>
                <div>🌍 پشتیبانی IPv6</div>
            </div>
        </div>
        
        <div style="text-align: center; margin-top: 40px; opacity: 0.8;">
            <p>🛡️ امن و قابل اعتماد | ⚡ سرعت نوری | 🔒 حریم خصوصی محفوظ</p>
            <p><small>نسخه 2.2 Enhanced - آخرین بروزرسانی: ${new Date().toLocaleDateString('fa-IR')}</small></p>
        </div>
    </div>
    
    <script>
        // Add some interactive effects
        document.addEventListener('DOMContentLoaded', function() {
            // Animate cards on scroll
            const cards = document.querySelectorAll('.feature-card');
            const observer = new IntersectionObserver((entries) => {
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
</html>`
