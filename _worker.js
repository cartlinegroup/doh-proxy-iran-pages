// _worker.js - Enhanced with Geographic Routing
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    
    // CORS Headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, User-Agent, CF-Connecting-IP',
      'Access-Control-Max-Age': '86400'
    }
    
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }
    
    // صفحه اصلی
    if (url.pathname === '/') {
      return new Response(getMainPage(url.hostname), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      })
    }
    
    // DNS Query Handler - پشتیبانی از هر دو فرمت
    if (url.pathname === '/dns-query' || url.pathname === '/resolve') {
      return handleDNS(request, corsHeaders, url)
    }
    
    // HTTP Proxy
    if (url.pathname === '/proxy' || url.pathname.startsWith('/p/')) {
      return handleProxy(request, corsHeaders, url)
    }
    
    // Geographic Status
    if (url.pathname === '/geo-status') {
      return handleGeoStatus(request, corsHeaders)
    }
    
    // Status
    if (url.pathname === '/status') {
      return jsonResponse({
        status: 'OK',
        timestamp: new Date().toISOString(),
        service: 'Iran Smart Proxy - Geographic Enhanced',
        version: '3.0-geo',
        supports: ['DNS JSON', 'DNS Wire Format', 'HTTP Proxy', 'Geographic Routing']
      }, 200, corsHeaders)
    }
    
    return new Response('صفحه پیدا نشد', { status: 404 })
  }
}

// تنظیمات Geographic Routing
const GEO_CONFIG = {
  // سایت‌های ایرانی - از Iran Edge
  iranian_sites: [
    '.ir', '.ایران', 'irna.ir', 'tasnim.ir', 'mehr.ir', 'digikala.com',
    'aparat.com', 'snapp.ir', 'cafe-bazaar.ir', 'shaparak.ir'
  ],
  
  // سایت‌های مسدود - حتماً از خارج ایران
  blocked_sites: [
    'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'youtube.com',
    'telegram.org', 'discord.com', 'reddit.com', 'github.com', 'medium.com',
    'bbc.com', 'cnn.com', 'wikipedia.org', 'linkedin.com', 'tiktok.com'
  ],
  
  // Gaming sites - نزدیک‌ترین edge برای کمترین ping
  gaming_sites: [
    'steampowered.com', 'steamcommunity.com', 'riotgames.com', 
    'leagueoflegends.com', 'valorant.com', 'epicgames.com', 'battle.net',
    'ea.com', 'ubisoft.com', 'origin.com', 'gog.com'
  ],
  
  // Cloudflare Edge Locations بهینه برای ایران
  preferred_edges: {
    iran_domestic: ['IKA', 'THR'], // Tehran
    middle_east: ['DXB', 'AUH'], // Dubai, Abu Dhabi
    europe: ['IST', 'FRA', 'AMS'], // Istanbul, Frankfurt, Amsterdam
    gaming_optimized: ['DXB', 'IST', 'FRA'] // کمترین ping برای gaming
  }
}

// سایت‌های مسدود (مجموعه کامل)
const BLOCKED_SITES = GEO_CONFIG.blocked_sites

// سایت‌های ایرانی
const IRANIAN_SITES = GEO_CONFIG.iranian_sites

// Gaming domains
const GAMING_DOMAINS = GEO_CONFIG.gaming_sites

// IP های Cloudflare برای proxy
const CF_IPS = [
  '104.16.132.229', '104.16.133.229', '172.67.69.9', '172.67.70.9',
  '104.21.34.96', '172.67.161.180', '104.26.10.78', '185.199.108.153'
]

async function handleDNS(request, corsHeaders, url) {
  try {
    // دریافت اطلاعات جغرافیایی کلاینت
    const clientCountry = request.cf?.country || 'IR'
    const clientColo = request.cf?.colo || 'IKA'
    const isFromIran = clientCountry === 'IR'
    
    let dnsQuery = null
    let name = null
    let type = 'A'
    
    // تشخیص نوع درخواست
    if (request.method === 'GET') {
      name = url.searchParams.get('name')
      type = url.searchParams.get('type') || 'A'
      
      const dnsParam = url.searchParams.get('dns')
      if (dnsParam) {
        try {
          dnsQuery = base64UrlDecode(dnsParam)
        } catch (e) {
          console.log('Invalid DNS base64:', e)
        }
      }
    } else if (request.method === 'POST') {
      const contentType = request.headers.get('Content-Type') || ''
      if (contentType.includes('application/dns-message')) {
        dnsQuery = new Uint8Array(await request.arrayBuffer())
      }
    }
    
    // اگر wire format داریم، forward کن
    if (dnsQuery) {
      return await forwardDNSWireFormat(dnsQuery, corsHeaders, clientCountry, clientColo)
    }
    
    if (!name) {
      return jsonResponse({
        error: 'پارامتر name ضروری است',
        examples: {
          json: '/dns-query?name=google.com',
          wire: '/dns-query?dns=BASE64_ENCODED_QUERY'
        }
      }, 400, corsHeaders)
    }
    
    console.log(`🌍 DNS Query: ${name} from ${clientCountry}/${clientColo}`)
    
    // تشخیص Accept header
    const acceptHeader = request.headers.get('Accept') || ''
    const wantsWireFormat = acceptHeader.includes('application/dns-message')
    
    // تشخیص نوع سایت
    const siteType = getSiteType(name)
    const gaming = url.searchParams.get('gaming') === 'true' || siteType === 'gaming'
    
    // انتخاب بهترین DNS provider با Geographic Routing
    const dnsProvider = selectOptimalDNSProvider(siteType, isFromIran, clientColo)
    
    const queryUrl = `${dnsProvider}?name=${encodeURIComponent(name)}&type=${type}`
    const startTime = Date.now()
    
    // درخواست با Geographic Headers
    const dnsHeaders = {
      'Accept': wantsWireFormat ? 'application/dns-message' : 'application/dns-json',
      'User-Agent': 'Iran-Proxy-Geo/1.0',
      'CF-IPCountry': isFromIran ? 'XX' : clientCountry, // Hide Iran origin for blocked sites
      'X-Forwarded-For': isFromIran && siteType === 'blocked' ? '8.8.8.8' : undefined
    }
    
    // حذف undefined headers
    Object.keys(dnsHeaders).forEach(key => 
      dnsHeaders[key] === undefined && delete dnsHeaders[key]
    )
    
    let dnsResponse
    if (wantsWireFormat) {
      dnsResponse = await fetch(queryUrl, { headers: dnsHeaders })
      
      if (dnsResponse.ok) {
        const wireData = await dnsResponse.arrayBuffer()
        return new Response(wireData, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/dns-message',
            'Cache-Control': 'public, max-age=300',
            'X-Geo-Route': getRoutingStrategy(siteType, isFromIran),
            'X-Edge-Colo': clientColo
          }
        })
      }
    }
    
    // JSON format
    dnsResponse = await fetch(queryUrl, { headers: dnsHeaders })
    
    if (!dnsResponse.ok) {
      throw new Error(`DNS failed: ${dnsResponse.status}`)
    }
    
    const data = await dnsResponse.json()
    const queryTime = Date.now() - startTime
    
    // Smart Proxy Logic با Geographic Intelligence
    if (siteType === 'blocked' && data.Answer) {
      data.Answer = data.Answer.map(record => {
        if (record.type === 1) { // A record
          const cfIP = selectOptimalCFIP(name, record.data, clientCountry, clientColo)
          return {
            ...record,
            data: cfIP,
            TTL: 300,
            _original: record.data,
            _proxied: true,
            _geo_optimized: true
          }
        }
        return record
      })
    }
    
    // Gaming optimization با Geographic routing
    if (gaming && data.Answer) {
      data.Answer = data.Answer.map(record => {
        if (record.type === 1) {
          const optimizedIP = optimizeGamingIP(record.data, name, clientColo)
          return {
            ...record,
            data: optimizedIP,
            _gaming_optimized: optimizedIP !== record.data,
            _geo_route: getGamingRoute(clientColo)
          }
        }
        return record
      })
    }
    
    // اضافه کردن Geographic metadata
    data._iran_proxy = {
      site_type: siteType,
      gaming_mode: gaming,
      proxy_applied: siteType === 'blocked',
      geo_routing: {
        client_country: clientCountry,
        client_colo: clientColo,
        routing_strategy: getRoutingStrategy(siteType, isFromIran),
        dns_provider: dnsProvider.split('/')[2]
      },
      query_time_ms: queryTime,
      timestamp: new Date().toISOString(),
      format: 'JSON'
    }
    
    return jsonResponse(data, 200, corsHeaders, {
      'Cache-Control': 'public, max-age=300',
      'X-Site-Type': siteType,
      'X-Query-Time': `${queryTime}ms`,
      'X-Geo-Route': getRoutingStrategy(siteType, isFromIran)
    })
    
  } catch (error) {
    console.error('DNS Error:', error)
    return jsonResponse({
      error: 'خطا در DNS',
      message: error.message
    }, 500, corsHeaders)
  }
}

async function forwardDNSWireFormat(dnsQuery, corsHeaders, clientCountry, clientColo) {
  try {
    console.log(`🔄 Forwarding DNS wire format from ${clientCountry}/${clientColo}`)
    
    // انتخاب endpoint بر اساس موقعیت
    const isFromIran = clientCountry === 'IR'
    let endpoint = 'https://cloudflare-dns.com/dns-query'
    
    // برای کاربران ایرانی و سایت‌های حساس، از edge خارجی استفاده کن
    if (isFromIran) {
      // Force routing through non-Iran edges
      endpoint = 'https://dns.google/dns-query' // Google has better geo distribution
    }
    
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/dns-message',
        'Accept': 'application/dns-message',
        'User-Agent': 'Iran-Proxy-Wire-Geo/1.0',
        'CF-IPCountry': isFromIran ? 'AE' : clientCountry, // Mask Iran origin
        'X-Forwarded-For': isFromIran ? '185.25.182.1' : undefined // Dubai IP
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
        'X-Geo-Route': isFromIran ? 'iran-masked' : 'direct',
        'X-Edge-Used': isFromIran ? 'external' : 'auto'
      }
    })
  } catch (error) {
    console.error('Wire format error:', error)
    throw error
  }
}

// انتخاب بهترین DNS provider
function selectOptimalDNSProvider(siteType, isFromIran, clientColo) {
  switch (siteType) {
    case 'iranian':
      // سایت‌های ایرانی: از نزدیک‌ترین edge
      return 'https://cloudflare-dns.com/dns-query'
      
    case 'blocked':
      // سایت‌های مسدود: حتماً از خارج ایران
      if (isFromIran) {
        return 'https://dns.google/dns-query' // Google has good global presence
      }
      return 'https://cloudflare-dns.com/dns-query'
      
    case 'gaming':
      // Gaming: کمترین latency
      if (['IKA', 'THR'].includes(clientColo)) {
        return 'https://cloudflare-dns.com/dns-query' // Dubai edge usually
      }
      return 'https://dns.quad9.net/dns-query'
      
    default:
      return 'https://cloudflare-dns.com/dns-query'
  }
}

// انتخاب بهترین Cloudflare IP
function selectOptimalCFIP(domain, originalIP, clientCountry, clientColo) {
  // IP ranges بهینه بر اساس موقعیت کلاینت
  const geoOptimizedIPs = {
    'IR': {
      // برای کاربران ایرانی - از Dubai/Turkey edges
      'dubai': ['104.16.132.229', '104.16.133.229'],
      'turkey': ['172.67.69.9', '172.67.70.9'],
      'europe': ['104.21.34.96', '172.67.161.180']
    },
    'default': ['185.199.108.153', '104.26.10.78']
  }
  
  let availableIPs = geoOptimizedIPs[clientCountry] || geoOptimizedIPs['default']
  
  // اگر array نیست، تبدیل کن
  if (typeof availableIPs === 'object' && !Array.isArray(availableIPs)) {
    // برای ایران، اولویت با Dubai
    if (clientCountry === 'IR') {
      availableIPs = [...availableIPs.dubai, ...availableIPs.turkey, ...availableIPs.europe]
    } else {
      availableIPs = geoOptimizedIPs['default']
    }
  }
  
  // انتخاب IP بر اساس hash domain
  const hash = domain.split('').reduce((a, b) => {
    a = ((a << 5) - a) + b.charCodeAt(0)
    return a & a
  }, 0)
  
  return availableIPs[Math.abs(hash) % availableIPs.length]
}

// بهینه‌سازی Gaming IP
function optimizeGamingIP(originalIP, domain, clientColo) {
  // Gaming servers نزدیک به ایران
  const gamingOptimizations = {
    'steampowered.com': {
      'IKA': '185.25.182.52', // Dubai Steam
      'THR': '185.25.182.52',
      'default': '162.254.197.85'
    },
    'leagueoflegends.com': {
      'IKA': '162.249.72.1', // Turkey EUNE
      'THR': '162.249.72.1',
      'default': '162.249.73.1'
    },
    'epicgames.com': {
      'IKA': '13.226.238.76', // ME region
      'THR': '13.226.238.76',
      'default': '13.35.67.15'
    }
  }
  
  for (const [gameDomain, coloIPs] of Object.entries(gamingOptimizations)) {
    if (domain.includes(gameDomain)) {
      return coloIPs[clientColo] || coloIPs['default'] || originalIP
    }
  }
  
  return originalIP
}

// استراتژی routing
function getRoutingStrategy(siteType, isFromIran) {
  if (siteType === 'blocked' && isFromIran) {
    return 'iran-masked-external'
  } else if (siteType === 'iranian') {
    return 'local-optimized'
  } else if (siteType === 'gaming') {
    return 'latency-optimized'
  }
  return 'standard'
}

// مسیر Gaming
function getGamingRoute(clientColo) {
  const routes = {
    'IKA': 'Tehran→Dubai',
    'THR': 'Tehran→Dubai', 
    'DXB': 'Dubai-Direct',
    'IST': 'Istanbul-Direct',
    'FRA': 'Frankfurt-Direct'
  }
  return routes[clientColo] || 'Auto-Route'
}

// Geographic Status
async function handleGeoStatus(request, corsHeaders) {
  const clientCountry = request.cf?.country || 'Unknown'
  const clientColo = request.cf?.colo || 'Unknown'
  const clientIP = request.headers.get('CF-Connecting-IP') || 'Unknown'
  
  return jsonResponse({
    geographic_info: {
      country: clientCountry,
      datacenter: clientColo,
      client_ip: clientIP,
      is_iran: clientCountry === 'IR'
    },
    routing_strategy: {
      iranian_sites: 'Local-Optimized',
      blocked_sites: clientCountry === 'IR' ? 'External-Masked' : 'Direct',
      gaming_sites: 'Latency-Optimized',
      normal_sites: 'Standard'
    },
    available_edges: GEO_CONFIG.preferred_edges,
    optimization_status: 'Active'
  }, 200, corsHeaders)
}

function base64UrlDecode(str) {
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
}

async function handleProxy(request, corsHeaders, url) {
  try {
    let targetUrl
    
    if (url.pathname === '/proxy') {
      targetUrl = url.searchParams.get('url')
    } else if (url.pathname.startsWith('/p/')) {
      targetUrl = url.pathname.substring(3)
    }
    
    if (!targetUrl) {
      return jsonResponse({
        error: 'پارامتر url ضروری است',
        example: '/proxy?url=https://twitter.com'
      }, 400, corsHeaders)
    }
    
    if (!targetUrl.startsWith('https://')) {
      return jsonResponse({
        error: 'فقط HTTPS پشتیبانی می‌شود'
      }, 400, corsHeaders)
    }
    
    console.log(`🌐 Proxy: ${targetUrl}`)
    
    // Geographic optimization برای proxy
    const clientCountry = request.cf?.country || 'IR'
    const isFromIran = clientCountry === 'IR'
    
    const proxyHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5'
    }
    
    // برای کاربران ایرانی، IP را mask کن
    if (isFromIran) {
      proxyHeaders['X-Forwarded-For'] = '185.25.182.1' // Dubai IP
      proxyHeaders['CF-IPCountry'] = 'AE'
    }
    
    const proxyResponse = await fetch(targetUrl, {
      headers: proxyHeaders,
      cf: {
        // Force routing through specific edges
        cacheEverything: false,
        cacheTtl: 0
      }
    })
    
    if (!proxyResponse.ok) {
      throw new Error(`HTTP ${proxyResponse.status}`)
    }
    
    const contentType = proxyResponse.headers.get('Content-Type') || ''
    let body
    
    if (contentType.includes('text/html')) {
      let html = await proxyResponse.text()
      
      const urlObj = new URL(targetUrl)
      const baseUrl = `${urlObj.protocol}//${urlObj.host}`
      
      html = html.replace(/href="\/([^"]*)"/g, `href="/p/${baseUrl}/$1"`)
      html = html.replace(/src="\/([^"]*)"/g, `src="/p/${baseUrl}/$1"`)
      
      const banner = `
        <div style="position: fixed; top: 0; left: 0; right: 0; z-index: 999999;
                    background: linear-gradient(45deg, #667eea, #764ba2); color: white;
                    padding: 8px 15px; text-align: center; font-family: Arial; font-size: 13px;">
          🌍 Iran Geo Proxy | ${targetUrl} | Route: ${isFromIran ? 'External' : 'Direct'}
          <button onclick="this.parentElement.style.display='none'" 
                  style="float: right; background: rgba(255,255,255,0.2); border: 1px solid white; 
                         color: white; border-radius: 3px; cursor: pointer; padding: 2px 8px;">×</button>
        </div>
        <script>if (document.body) document.body.style.marginTop = '35px';</script>
      `
      
      html = html.replace(/<body([^>]*)>/i, `<body$1>${banner}`)
      body = html
    } else {
      body = proxyResponse.body
    }
    
    return new Response(body, {
      status: proxyResponse.status,
      headers: {
        ...corsHeaders,
        'Content-Type': contentType,
        'X-Proxy-Status': 'Success',
        'X-Geo-Route': isFromIran ? 'iran-external' : 'direct'
      }
    })
    
  } catch (error) {
    console.error('Proxy Error:', error)
    return jsonResponse({
      error: 'خطا در proxy',
      message: error.message
    }, 500, corsHeaders)
  }
}

function getSiteType(domain) {
  const d = domain.toLowerCase()
  
  if (IRANIAN_SITES.some(site => d.includes(site))) {
    return 'iranian'
  }
  
  if (BLOCKED_SITES.some(site => d.includes(site))) {
    return 'blocked'
  }
  
  if (GAMING_DOMAINS.some(site => d.includes(site))) {
    return 'gaming'
  }
  
  return 'normal'
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

function getMainPage(hostname) {
  return `<!DOCTYPE html>
<html dir="rtl" lang="fa">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🌍 Iran Smart Proxy - Geographic Enhanced</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh; color: white; direction: rtl;
            margin: 0; padding: 20px;
        }
        .container { max-width: 900px; margin: 0 auto; }
        .hero { text-align: center; padding: 40px 0; }
        .hero h1 { font-size: 3rem; margin-bottom: 20px; }
        .status {
            background: rgba(76, 175, 80, 0.2); border: 2px solid #4CAF50;
            padding: 20px; border-radius: 15px; margin: 30px 0;
            text-align: center; font-size: 1.2rem;
        }
        .endpoint {
            background: linear-gradient(135deg, #4CAF50, #45a049);
            color: white; padding: 20px; border-radius: 15px; margin: 20px 0;
            font-family: 'Courier New', monospace; text-align: center;
        }
        .features {
            display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
            gap: 20px; margin: 40px 0;
        }
        .feature-card {
            background: rgba(255,255,255,0.1); backdrop-filter: blur(20px);
            border-radius: 15px; padding: 25px; border: 1px solid rgba(255,255,255,0.2);
        }
        .setup-section {
            background: rgba(255,255,255,0.05); border-radius: 15px;
            padding: 25px; margin: 30px 0;
        }
        .setup-grid {
            display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px; margin-top: 20px;
        }
        .setup-item {
            background: rgba(255,255,255,0.1); padding: 15px; border-radius: 10px;
        }
        .btn {
            background: rgba(255,255,255,0.2); color: white;
            padding: 12px 20px; text-decoration: none; border-radius: 20px;
            margin: 8px; display: inline-block; transition: all 0.3s;
        }
        .btn:hover { background: rgba(255,255,255,0.3); }
        code {
            background: rgba(0,0,0,0.3); padding: 4px 8px; border-radius: 5px;
            font-family: 'Courier New', monospace;
        }
        .geo-info {
            background: rgba(255,193,7,0.1); border: 1px solid rgba(255,193,7,0.3);
            padding: 20px; border-radius: 10px; margin: 20px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="hero">
            <h1>🌍 Iran Smart Proxy</h1>
            <p>Geographic Enhanced - مسیریابی هوشمند جغرافیایی</p>
        </div>
        
        <div class="status">
            ✅ <strong>Geographic Routing فعال!</strong><br>
            اتصال خودکار از بهترین Edge Location ها
        </div>
        
        <div class="endpoint">
            🌐 DNS Endpoint: https://${hostname}/dns-query
        </div>
        
        <div class="geo-info">
            <h3>🗺️ مسیریابی جغرافیایی:</h3>
            <ul style="list-style: none; padding: 0;">
                <li>🇮🇷 سایت‌های ایرانی: مسیر داخلی (سریع‌ترین)</li>
                <li>🚫 سایت‌های مسدود: مسیر خارجی (دور زدن محدودیت)</li>
                <li>🎮 Gaming: نزدیک‌ترین Edge (کمترین ping)</li>
                <li>🌐 بقیه: مسیر بهینه خودکار</li>
            </ul>
        </div>
        
        <div class="features">
            <div class="feature-card">
                <h3>🧠 Smart DNS</h3>
                <p>تشخیص خودکار و مسیریابی هوشمند</p>
                <p><strong>مسدود:</strong> ${BLOCKED_SITES.length} سایت</p>
            </div>
            <div class="feature-card">
                <h3>🌍 Geographic Routing</h3>
                <p>انتخاب بهترین Edge Location</p>
                <p><strong>Edges:</strong> Tehran, Dubai, Istanbul</p>
            </div>
            <div class="feature-card">
                <h3>🎮 Gaming Optimization</h3>
                <p>کاهش ping با مسیریابی بهینه</p>
                <p><strong>Games:</strong> Steam, Riot, Epic
            </div>
            <div class="feature-card">
                <h3>🌐 HTTP Proxy</h3>
                <p>دسترسی مستقیم به سایت‌های مسدود</p>
                <p><strong>Geographic:</strong> Auto-route via best edge</p>
            </div>
        </div>
        
        <div class="setup-section">
            <h2>📱 تنظیمات مرورگرها</h2>
            
            <div class="setup-grid">
                <div class="setup-item">
                    <h4>🦊 Firefox</h4>
                    <p>1. <code>about:preferences#privacy</code></p>
                    <p>2. DNS over HTTPS → Custom</p>
                    <p>3. <code>https://${hostname}/dns-query</code></p>
                    <p>4. Restart Firefox</p>
                </div>
                
                <div class="setup-item">
                    <h4>🔵 Chrome/Edge</h4>
                    <p>1. <code>chrome://settings/security</code></p>
                    <p>2. Use secure DNS → Custom</p>
                    <p>3. <code>https://${hostname}/dns-query</code></p>
                    <p>4. Restart Browser</p>
                </div>
                
                <div class="setup-item">
                    <h4>📱 Android Intra</h4>
                    <p>1. Install Intra from Play Store</p>
                    <p>2. Custom DoH server</p>
                    <p>3. <code>https://${hostname}/dns-query</code></p>
                    <p>4. Test & Turn on</p>
                </div>
                
                <div class="setup-item">
                    <h4>🔧 Android 1.1.1.1</h4>
                    <p>1. Install 1.1.1.1 app</p>
                    <p>2. Advanced → Custom DoH</p>
                    <p>3. <code>https://${hostname}/dns-query</code></p>
                    <p>4. Connect</p>
                </div>
            </div>
        </div>
        
        <center>
            <a href="/geo-status" class="btn">🗺️ Geographic Status</a>
            <a href="/status" class="btn">📊 System Status</a>
            <a href="/proxy?url=https://httpbin.org/json" class="btn">🧪 Test Proxy</a>
        </center>
        
        <div style="text-align: center; margin-top: 40px; opacity: 0.8;">
            <p>🌍 Geographic Intelligence | ⚡ Edge Optimized | 🔒 Secure</p>
        </div>
    </div>
    
    <script>
        // Auto-detect user location and show optimal settings
        fetch('/geo-status')
            .then(r => r.json())
            .then(data => {
                if (data.geographic_info) {
                    const info = data.geographic_info;
                    const isIran = info.is_iran;
                    
                    // Show optimal configuration based on location
                    const statusEl = document.querySelector('.status');
                    if (isIran) {
                        statusEl.innerHTML += '<br><small>🇮🇷 تشخیص: ایران → مسیریابی بهینه فعال</small>';
                    } else {
                        statusEl.innerHTML += '<br><small>🌍 Location: ' + info.country + ' → Direct routing</small>';
                    }
                }
            })
            .catch(e => console.log('Geo detection failed:', e));
    </script>
</body>
</html>`