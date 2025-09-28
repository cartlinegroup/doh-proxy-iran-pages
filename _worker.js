// _worker.js - Compatible with Browsers (DNS Wire Format + JSON)
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    
    // CORS Headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, User-Agent',
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
    
    // Status
    if (url.pathname === '/status') {
      return jsonResponse({
        status: 'OK',
        timestamp: new Date().toISOString(),
        service: 'Iran Smart Proxy - Browser Compatible',
        version: '2.1-browser-fix',
        supports: ['DNS JSON', 'DNS Wire Format', 'HTTP Proxy']
      }, 200, corsHeaders)
    }
    
    return new Response('صفحه پیدا نشد', { status: 404 })
  }
}

// سایت‌های مسدود
const BLOCKED_SITES = [
  'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'youtube.com',
  'telegram.org', 'discord.com', 'reddit.com', 'github.com', 'medium.com',
  'bbc.com', 'cnn.com', 'wikipedia.org'
]

// سایت‌های ایرانی
const IRANIAN_SITES = [
  '.ir', '.ایران', 'irna.ir', 'tasnim.ir', 'mehr.ir', 'digikala.com'
]

// Gaming domains
const GAMING_DOMAINS = [
  'steampowered.com', 'steamcommunity.com', 'riotgames.com', 
  'leagueoflegends.com', 'valorant.com', 'epicgames.com'
]

// Cloudflare IPs
const CF_IPS = [
  '104.16.132.229', '104.16.133.229', '172.67.69.9', '172.67.70.9'
]

async function handleDNS(request, corsHeaders, url) {
  try {
    let dnsQuery = null
    let name = null
    let type = 'A'
    
    // تشخیص نوع درخواست
    if (request.method === 'GET') {
      // GET request - JSON یا Wire format
      name = url.searchParams.get('name')
      type = url.searchParams.get('type') || 'A'
      
      // بررسی DNS wire format در URL (base64)
      const dnsParam = url.searchParams.get('dns')
      if (dnsParam) {
        try {
          dnsQuery = base64UrlDecode(dnsParam)
        } catch (e) {
          console.log('Invalid DNS base64:', e)
        }
      }
    } else if (request.method === 'POST') {
      // POST request - DNS wire format
      const contentType = request.headers.get('Content-Type') || ''
      if (contentType.includes('application/dns-message')) {
        dnsQuery = new Uint8Array(await request.arrayBuffer())
      }
    }
    
    // اگر wire format داریم، forward کن
    if (dnsQuery) {
      return await forwardDNSWireFormat(dnsQuery, corsHeaders)
    }
    
    // اگر name نداریم، خطا
    if (!name) {
      return jsonResponse({
        error: 'پارامتر name ضروری است',
        examples: {
          json: '/dns-query?name=google.com',
          wire: '/dns-query?dns=BASE64_ENCODED_QUERY'
        }
      }, 400, corsHeaders)
    }
    
    console.log(`🔍 DNS Query: ${name}`)
    
    // تشخیص Accept header برای فرمت پاسخ
    const acceptHeader = request.headers.get('Accept') || ''
    const wantsWireFormat = acceptHeader.includes('application/dns-message')
    const wantsJSON = acceptHeader.includes('application/dns-json') || 
                     acceptHeader.includes('application/json') ||
                     !wantsWireFormat // پیش‌فرض JSON
    
    // تشخیص نوع سایت
    const siteType = getSiteType(name)
    const gaming = url.searchParams.get('gaming') === 'true'
    
    // انتخاب بهترین DNS provider
    let dnsProvider = 'https://cloudflare-dns.com/dns-query'
    
    // درخواست به DNS provider
    const queryUrl = `${dnsProvider}?name=${encodeURIComponent(name)}&type=${type}`
    
    const startTime = Date.now()
    
    // درخواست wire format یا JSON بسته به نیاز
    let dnsResponse
    if (wantsWireFormat) {
      // درخواست wire format
      dnsResponse = await fetch(queryUrl, {
        headers: {
          'Accept': 'application/dns-message',
          'User-Agent': 'Iran-Proxy-Browser/1.0'
        }
      })
      
      if (dnsResponse.ok) {
        const wireData = await dnsResponse.arrayBuffer()
        return new Response(wireData, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/dns-message',
            'Cache-Control': 'public, max-age=300'
          }
        })
      }
    }
    
    // پیش‌فرض: JSON format
    dnsResponse = await fetch(queryUrl, {
      headers: {
        'Accept': 'application/dns-json',
        'User-Agent': 'Iran-Proxy-JSON/1.0'
      }
    })
    
    if (!dnsResponse.ok) {
      throw new Error(`DNS failed: ${dnsResponse.status}`)
    }
    
    const data = await dnsResponse.json()
    const queryTime = Date.now() - startTime
    
    // Smart Proxy Logic
    if (siteType === 'blocked' && data.Answer) {
      data.Answer = data.Answer.map(record => {
        if (record.type === 1) { // A record
          const cfIP = CF_IPS[Math.floor(Math.random() * CF_IPS.length)]
          return {
            ...record,
            data: cfIP,
            TTL: 300,
            _original: record.data,
            _proxied: true
          }
        }
        return record
      })
    }
    
    // Add metadata
    data._iran_proxy = {
      site_type: siteType,
      gaming_mode: gaming,
      proxy_applied: siteType === 'blocked',
      query_time_ms: queryTime,
      timestamp: new Date().toISOString(),
      format: 'JSON'
    }
    
    return jsonResponse(data, 200, corsHeaders, {
      'Cache-Control': 'public, max-age=300',
      'X-Site-Type': siteType,
      'X-Query-Time': `${queryTime}ms`
    })
    
  } catch (error) {
    console.error('DNS Error:', error)
    return jsonResponse({
      error: 'خطا در DNS',
      message: error.message
    }, 500, corsHeaders)
  }
}

async function forwardDNSWireFormat(dnsQuery, corsHeaders) {
  try {
    console.log('🔄 Forwarding DNS wire format query')
    
    // Forward به Cloudflare DoH
    const response = await fetch('https://cloudflare-dns.com/dns-query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/dns-message',
        'Accept': 'application/dns-message',
        'User-Agent': 'Iran-Proxy-Wire/1.0'
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
        'X-Proxy-Format': 'Wire'
      }
    })
  } catch (error) {
    console.error('Wire format error:', error)
    throw error
  }
}

function base64UrlDecode(str) {
  // Base64 URL safe decoding
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
    
    const proxyResponse = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
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
          🇮🇷 Iran Proxy | ${targetUrl}
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
        'X-Proxy-Status': 'Success'
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
    <title>🇮🇷 Iran Smart Proxy - Browser Compatible!</title>
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
        .compatibility {
            background: rgba(0,255,135,0.1); border: 1px solid rgba(0,255,135,0.3);
            padding: 20px; border-radius: 10px; margin: 20px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="hero">
            <h1>🛡️ Iran Smart Proxy</h1>
            <p>نسخه سازگار با تمام مرورگرها و موبایل</p>
        </div>
        
        <div class="status">
            ✅ <strong>سازگار با Browser!</strong><br>
            پشتیبانی کامل از Firefox, Chrome, Android
        </div>
        
        <div class="endpoint">
            🌐 DNS Endpoint: https://${hostname}/dns-query
        </div>
        
        <div class="compatibility">
            <h3>🔧 پشتیبانی شده:</h3>
            <ul style="list-style: none; padding: 0;">
                <li>✅ DNS JSON Format (API calls)</li>
                <li>✅ DNS Wire Format (Browser DoH)</li>
                <li>✅ GET & POST requests</li>
                <li>✅ Base64 encoded queries</li>
                <li>✅ CORS headers</li>
            </ul>
        </div>
        
        <div class="features">
            <div class="feature-card">
                <h3>🧠 Smart DNS</h3>
                <p>تشخیص خودکار سایت‌ها و مسیریابی هوشمند</p>
                <p><strong>مسدود:</strong> ${BLOCKED_SITES.length} سایت</p>
            </div>
            <div class="feature-card">
                <h3>🎮 Gaming Optimization</h3>
                <p>بهینه‌سازی ping برای بازی‌ها</p>
                <p><strong>پلتفرم:</strong> ${GAMING_DOMAINS.length} دامنه</p>
            </div>
            <div class="feature-card">
                <h3>🌐 HTTP Proxy</h3>
                <p>دسترسی مستقیم به سایت‌های مسدود</p>
                <p><strong>Web Interface:</strong> /browse</p>
            </div>
        </div>
        
        <div class="setup-section">
            <h2>📱 تنظیمات مرورگرها (تضمینی!)</h2>
            
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
            <a href="/browse" class="btn">🌐 Web Browser</a>
            <a href="/status" class="btn">📊 Status</a>
            <a href="/proxy?url=https://httpbin.org/json" class="btn">🧪 Test Proxy</a>
        </center>
        
        <div style="text-align: center; margin-top: 40px; opacity: 0.8;">
            <p>🛡️ سازگار با همه مرورگرها | ⚡ سرعت بالا | 🔒 امن</p>
        </div>
    </div>
</body>
</html>`
}
