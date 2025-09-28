// _worker.js - Fully Compatible DoH Worker
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    
    // Enhanced CORS Headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, User-Agent, DNT, Cache-Control',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Accept'
    }
    
    // Handle preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, { 
        status: 200,
        headers: corsHeaders 
      })
    }
    
    // Main DNS endpoint
    if (url.pathname === '/dns-query' || url.pathname === '/resolve' || url.pathname === '/') {
      // If root path has no query params, show homepage
      if (url.pathname === '/' && !url.searchParams.has('name')) {
        return new Response(getHomePage(url.hostname), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        })
      }
      
      return handleDoH(request, corsHeaders, url)
    }
    
    // HTTP Proxy for actual traffic
    if (url.pathname === '/proxy' || url.pathname.startsWith('/p/')) {
      return handleHTTPProxy(request, corsHeaders, url)
    }
    
    // Web Browser Interface
    if (url.pathname === '/browse') {
      return handleWebBrowser(url.hostname)
    }
    
    // Status endpoint
    if (url.pathname === '/status') {
      return new Response(JSON.stringify({
        status: 'operational',
        timestamp: new Date().toISOString(),
        service: 'DoH Iran Proxy',
        protocols: ['DoH GET', 'DoH POST', 'JSON', 'Wire Format'],
        compatible_with: ['Firefox', 'Chrome', 'Android Intra', '1.1.1.1 app']
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      })
    }
    
    return new Response('Not Found', { status: 404 })
  }
}

const BLOCKED_DOMAINS = [
  // Social Media & Communication
  'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'youtube.com',
  'telegram.org', 'discord.com', 'reddit.com', 'slack.com',
  
  // AI & Development
  'chat.openai.com', 'openai.com', 'claude.ai', 'chat.claude.ai',
  'chatgpt.com', 'cdn.oaistatic.com', 'bard.google.com', 'gemini.google.com',
  'github.com', 'gitlab.com', 'notion.so', 'pastebin.com',
  
  // Google Services
  'analytics.google.com', 'firebaseremoteconfig.googleapis.com', 'cloud.google.com',
  'ads.google.com', 'fonts.googleapis.com', 'developer.android.com',
  'console.cloud.google.com', 'googletagmanager.com', 'firebase.google.com',
  'packages.cloud.google.com', 'developers.google.com', 'dl.google.com',
  'notifications.google.com', 'firebaseextensions.clients6.google.com',
  'i.ytimg.com', 'appspot.com', 'web.dev',
  
  // Cloud & Enterprise
  'cloud.oracle.com', 'oraclecloud.com', 'oracle.com',
  'vmware.com', 'vsphereclient.vmware.com', 'code.vmware.com',
  'blogs.vmware.com', 'kb.vmware.com', 'docs.vmware.com', 'ssc.vmware.com',
  'my.vmware.com', 'mon.vmware.com',
  
  // Hardware & Tech Companies  
  'intel.com', 'intel.de', 'downloadcenter.intel.com', 'corpredirect.intel.com',
  'ark.intel.com', 'amd.com', 'nvidia.com', 'lenovo.com', 'pcsupport.lenovo.com',
  'motorola.com', 'ti.com', 'adobe.com', 'att.com',
  
  // Development Tools
  'docker.io', 'docker.com', 'repo.mysql.com', 'apt.kubernetes.io',
  'golang.org', 'grafana.com', 'splunk.com',
  
  // Networks & Security
  'hpe.com', 'community.hpe.com', 'solarwinds.com', 'thwack.solarwinds.com',
  'oriondemo.solarwinds.com', 'spiceworks.com', 'gns3.com',
  
  // E-commerce & Services
  'ebay.com', 'ebaystatic.com', 'ebayimg.com', 'ebaycdn.net',
  'visa.com', 'visa.de', 'kinsta.com',
  
  // CDN & Infrastructure
  'dgivdslhqe3qo.cloudfront.net', 'd36jcksde1wxzq.cloudfront.net',
  'd2wy8f7a9ursnm.cloudfront.net', 'd20hvw4zeymqbm.cloudfront.net',
  
  // Cisco Systems
  'download-ssc.cisco.com', 'api.cisco.com', 'software.cisco.com',
  
  // Other Services
  'algolia.com', 'atlassian.net', 'arcgis.com', 'computerworld.com',
  'filehippo.com', 'boardgamegeek.com', 'ign.com', 'linuxhostsupport.com'
]

const CLOUDFLARE_IPS = [
  '104.16.132.229', '104.16.133.229', '172.67.69.9', '172.67.70.9'
]

async function handleDoH(request, corsHeaders, url) {
  try {
    let name = null
    let type = 'A'
    let dnsWireQuery = null
    
    // Parse request based on method
    if (request.method === 'GET') {
      name = url.searchParams.get('name')
      type = url.searchParams.get('type') || 'A'
      
      // Check for DNS wire format in GET parameter
      const dnsParam = url.searchParams.get('dns')
      if (dnsParam) {
        try {
          dnsWireQuery = base64UrlDecode(dnsParam)
          console.log('📦 DNS Wire query detected in GET')
        } catch (e) {
          console.error('Invalid DNS base64:', e.message)
        }
      }
    } else if (request.method === 'POST') {
      const contentType = request.headers.get('Content-Type') || ''
      if (contentType.includes('application/dns-message')) {
        dnsWireQuery = new Uint8Array(await request.arrayBuffer())
        console.log('📦 DNS Wire query detected in POST')
      }
    }
    
    // Determine response format
    const acceptHeader = request.headers.get('Accept') || ''
    const wantsWireFormat = acceptHeader.includes('application/dns-message')
    
    console.log(`🔍 DoH Request: name=${name}, type=${type}, wire=${!!dnsWireQuery}, wants_wire=${wantsWireFormat}`)
    
    // Handle wire format queries
    if (dnsWireQuery) {
      return await forwardWireQuery(dnsWireQuery, corsHeaders, wantsWireFormat)
    }
    
    // Validate name parameter
    if (!name) {
      return errorResponse('Missing name parameter. Usage: /dns-query?name=example.com', 400, corsHeaders)
    }
    
    // Make DNS query
    const startTime = Date.now()
    let dnsResponse
    
    if (wantsWireFormat) {
      // Request wire format from upstream
      dnsResponse = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, {
        headers: {
          'Accept': 'application/dns-message',
          'User-Agent': 'DoH-Iran-Proxy/1.0'
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
    
    // Fallback to JSON format
    dnsResponse = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, {
      headers: {
        'Accept': 'application/dns-json',
        'User-Agent': 'DoH-Iran-Proxy/1.0'
      }
    })
    
    if (!dnsResponse.ok) {
      throw new Error(`Upstream DNS failed: ${dnsResponse.status} ${dnsResponse.statusText}`)
    }
    
    const data = await dnsResponse.json()
    const queryTime = Date.now() - startTime
    
    // Apply smart proxy logic
    const isBlocked = BLOCKED_DOMAINS.some(domain => name.toLowerCase().includes(domain))
    
    if (isBlocked && data.Answer) {
      data.Answer = data.Answer.map(record => {
        if (record.type === 1) { // A record
          const proxyIP = CLOUDFLARE_IPS[Math.floor(Math.random() * CLOUDFLARE_IPS.length)]
          return {
            ...record,
            data: proxyIP,
            TTL: 300,
            _original_ip: record.data,
            _proxied: true
          }
        }
        return record
      })
    }
    
    // Add metadata
    data._iran_proxy = {
      blocked_site: isBlocked,
      proxy_applied: isBlocked,
      query_time_ms: queryTime,
      timestamp: new Date().toISOString(),
      format: 'JSON'
    }
    
    return new Response(JSON.stringify(data), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/dns-json',
        'Cache-Control': 'public, max-age=300'
      }
    })
    
  } catch (error) {
    console.error('DoH Error:', error)
    return errorResponse(`DNS query failed: ${error.message}`, 500, corsHeaders)
  }
}

async function forwardWireQuery(wireQuery, corsHeaders, returnWireFormat) {
  try {
    console.log('🔄 Forwarding wire format query to upstream')
    
    const response = await fetch('https://cloudflare-dns.com/dns-query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/dns-message',
        'Accept': 'application/dns-message',
        'User-Agent': 'DoH-Iran-Wire/1.0'
      },
      body: wireQuery
    })
    
    if (!response.ok) {
      throw new Error(`Wire query failed: ${response.status}`)
    }
    
    const responseData = await response.arrayBuffer()
    
    return new Response(responseData, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/dns-message',
        'Cache-Control': 'public, max-age=300'
      }
    })
    
  } catch (error) {
    console.error('Wire forward error:', error)
    throw error
  }
}

function base64UrlDecode(str) {
  // Convert base64url to base64
  str = str.replace(/-/g, '+').replace(/_/g, '/')
  // Add padding if needed
  while (str.length % 4) {
    str += '='
  }
  
  try {
    const binary = atob(str)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  } catch (e) {
    throw new Error('Invalid base64 encoding')
  }
}

async function handleHTTPProxy(request, corsHeaders, url) {
  try {
    let targetUrl
    
    if (url.pathname === '/proxy') {
      targetUrl = url.searchParams.get('url')
    } else if (url.pathname.startsWith('/p/')) {
      // Extract URL from path: /p/https://example.com/path
      targetUrl = url.pathname.substring(3) // Remove '/p/'
      if (url.search) {
        targetUrl += url.search
      }
    }
    
    if (!targetUrl) {
      return new Response(JSON.stringify({
        error: 'پارامتر url ضروری است',
        examples: [
          '/proxy?url=https://chat.openai.com',
          '/p/https://claude.ai',
          '/browse برای رابط گرافیکی'
        ]
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
    
    // Validate URL
    let urlObj
    try {
      urlObj = new URL(targetUrl)
    } catch (e) {
      return new Response(JSON.stringify({
        error: 'URL نامعتبر',
        provided: targetUrl
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
    
    // Only allow HTTPS
    if (urlObj.protocol !== 'https:') {
      return new Response(JSON.stringify({
        error: 'فقط HTTPS پشتیبانی می‌شود',
        provided_protocol: urlObj.protocol
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
    
    // Check if domain is in our blocked list (optional validation)
    const hostname = urlObj.hostname.toLowerCase()
    const isAllowedDomain = BLOCKED_DOMAINS.some(domain => 
      hostname === domain || hostname.endsWith('.' + domain) || domain.includes(hostname)
    )
    
    if (!isAllowedDomain) {
      return new Response(JSON.stringify({
        error: 'دامنه مجاز نیست',
        hostname: hostname,
        note: 'فقط سایت‌های لیست شده قابل دسترسی هستند'
      }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
    
    console.log(`🌐 HTTP Proxy: ${targetUrl}`)
    
    // Prepare headers for upstream request
    const proxyHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': request.headers.get('Accept') || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,fa;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none'
    }
    
    // Copy some headers from original request
    const allowedHeaders = ['Authorization', 'Content-Type', 'X-Requested-With', 'Cookie']
    allowedHeaders.forEach(header => {
      const value = request.headers.get(header)
      if (value) {
        proxyHeaders[header] = value
      }
    })
    
    // Make the proxied request
    const startTime = Date.now()
    const proxyResponse = await fetch(targetUrl, {
      method: request.method,
      headers: proxyHeaders,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
      cf: {
        // Cloudflare-specific optimizations
        cacheTtl: 300,
        cacheEverything: false,
        scrapeShield: false,
        apps: false
      }
    })
    
    const proxyTime = Date.now() - startTime
    console.log(`⏱️ Proxy response: ${proxyResponse.status} in ${proxyTime}ms`)
    
    if (!proxyResponse.ok && proxyResponse.status >= 400) {
      return new Response(JSON.stringify({
        error: 'خطا در دسترسی به سایت',
        status: proxyResponse.status,
        statusText: proxyResponse.statusText,
        url: targetUrl
      }), {
        status: proxyResponse.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
    
    // Handle different content types
    const contentType = proxyResponse.headers.get('Content-Type') || ''
    let responseBody
    
    if (contentType.includes('text/html')) {
      // Modify HTML for proxy compatibility
      let html = await proxyResponse.text()
      html = modifyHtmlForProxy(html, targetUrl, url.hostname)
      responseBody = html
    } else if (contentType.includes('text/css')) {
      // Modify CSS URLs
      let css = await proxyResponse.text()
      css = modifyCssForProxy(css, targetUrl, url.hostname)
      responseBody = css
    } else {
      // Binary content or other formats
      responseBody = proxyResponse.body
    }
    
    // Prepare response headers
    const responseHeaders = {
      ...corsHeaders,
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=300',
      'X-Proxy-Status': 'Success',
      'X-Original-URL': targetUrl,
      'X-Proxy-Time': `${proxyTime}ms`,
      'X-Served-By': 'Iran-HTTP-Proxy'
    }
    
    // Remove problematic headers
    const removeHeaders = [
      'Content-Security-Policy', 'X-Frame-Options', 'Strict-Transport-Security',
      'Content-Security-Policy-Report-Only', 'X-Content-Type-Options'
    ]
    removeHeaders.forEach(header => {
      if (proxyResponse.headers.has(header)) {
        delete responseHeaders[header]
      }
    })
    
    return new Response(responseBody, {
      status: proxyResponse.status,
      statusText: proxyResponse.statusText,
      headers: responseHeaders
    })
    
  } catch (error) {
    console.error('❌ HTTP Proxy Error:', error)
    
    return new Response(JSON.stringify({
      error: 'خطا در HTTP Proxy',
      message: error.message,
      timestamp: new Date().toISOString()
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
}

function modifyHtmlForProxy(html, originalUrl, proxyHost) {
  try {
    const urlObj = new URL(originalUrl)
    const baseUrl = `${urlObj.protocol}//${urlObj.host}`
    
    // Fix relative URLs
    html = html.replace(/href="\/([^"]*)"/g, `href="/p/${baseUrl}/$1"`)
    html = html.replace(/src="\/([^"]*)"/g, `src="/p/${baseUrl}/$1"`)
    html = html.replace(/action="\/([^"]*)"/g, `action="/p/${baseUrl}/$1"`)
    
    // Fix absolute URLs to other allowed domains
    html = html.replace(/href="https:\/\/([^"]*?)"/g, (match, url) => {
      const domain = url.split('/')[0]
      const isAllowed = BLOCKED_DOMAINS.some(d => domain.includes(d) || d.includes(domain))
      if (isAllowed) {
        return `href="/p/https://${url}"`
      }
      return match
    })
    
    // Add proxy banner
    const banner = `
      <div id="iran-proxy-banner" style="
        position: fixed; top: 0; left: 0; right: 0; z-index: 999999;
        background: linear-gradient(135deg, #667eea, #764ba2); color: white;
        padding: 8px 15px; text-align: center; font-family: Arial, sans-serif;
        font-size: 13px; box-shadow: 0 2px 10px rgba(0,0,0,0.3);
      ">
        🇮🇷 Iran HTTP Proxy Active | 🌐 ${originalUrl}
        <button onclick="document.getElementById('iran-proxy-banner').style.display='none'" 
                style="float: right; background: rgba(255,255,255,0.2); border: 1px solid white;
                       color: white; border-radius: 3px; cursor: pointer; padding: 2px 8px; margin-left: 10px;">×</button>
      </div>
      <script>
        // Add margin to body for banner
        document.addEventListener('DOMContentLoaded', function() {
          if (document.body) {
            document.body.style.marginTop = '40px';
          }
        });
      </script>
    `
    
    // Insert banner after <body> tag
    html = html.replace(/<body([^>]*)>/i, `<body$1>${banner}`)
    
    return html
  } catch (e) {
    console.error('HTML modification error:', e)
    return html
  }
}

function modifyCssForProxy(css, originalUrl, proxyHost) {
  try {
    const urlObj = new URL(originalUrl)
    const baseUrl = `${urlObj.protocol}//${urlObj.host}`
    
    // Fix CSS URLs
    css = css.replace(/url\(["']?\/([^"')]*?)["']?\)/g, `url("/p/${baseUrl}/$1")`)
    
    return css
  } catch (e) {
    console.error('CSS modification error:', e)
    return css
  }
}

function handleWebBrowser(hostname) {
  return new Response(`
<!DOCTYPE html>
<html dir="rtl" lang="fa">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🌐 مرورگر وب Iran Proxy</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh; direction: rtl; color: white;
        }
        .browser-container { max-width: 1400px; margin: 0 auto; padding: 20px; }
        .browser-header {
            background: rgba(255,255,255,0.1); backdrop-filter: blur(20px);
            border-radius: 15px; padding: 20px; margin-bottom: 20px;
        }
        .address-bar { display: flex; gap: 10px; margin-bottom: 15px; }
        .url-input {
            flex: 1; padding: 12px; border: 2px solid rgba(255,255,255,0.3);
            border-radius: 8px; font-size: 16px; direction: ltr;
            background: rgba(255,255,255,0.1); color: white;
        }
        .url-input::placeholder { color: rgba(255,255,255,0.7); }
        .go-btn {
            background: linear-gradient(45deg, #00ff87, #60efff); color: #0f0f23;
            border: none; padding: 12px 25px; border-radius: 8px; 
            cursor: pointer; font-size: 16px; font-weight: bold;
        }
        .shortcuts { display: flex; flex-wrap: wrap; gap: 10px; }
        .shortcut-btn {
            background: rgba(255,255,255,0.2); color: white;
            padding: 8px 15px; text-decoration: none; border-radius: 20px;
            font-size: 14px; cursor: pointer; border: none;
        }
        .iframe-container {
            background: white; border-radius: 15px; overflow: hidden;
            box-shadow: 0 10px 30px rgba(0,0,0,0.3); height: 80vh;
        }
        #content-frame { width: 100%; height: 100%; border: none; }
        .status-bar {
            background: rgba(0,0,0,0.1); padding: 8px 15px; font-size: 12px;
            display: flex; justify-content: space-between; align-items: center;
        }
    </style>
</head>
<body>
    <div class="browser-container">
        <div class="browser-header">
            <h2>🌐 مرورگر وب Iran Proxy</h2>
            <p>دسترسی کامل به سایت‌های مسدود شده با HTTP Proxy</p>
            
            <div class="address-bar">
                <input type="text" id="urlInput" class="url-input" 
                       placeholder="chat.openai.com یا claude.ai وارد کنید..." 
                       value="">
                <button onclick="loadPage()" class="go-btn">🚀 برو</button>
            </div>
            
            <div class="shortcuts">
                <strong>میانبرهای AI و Cloud:</strong>
                <button onclick="loadUrl('https://chat.openai.com')" class="shortcut-btn">🤖 ChatGPT</button>
                <button onclick="loadUrl('https://claude.ai')" class="shortcut-btn">🧠 Claude</button>
                <button onclick="loadUrl('https://cloud.google.com')" class="shortcut-btn">☁️ Google Cloud</button>
                <button onclick="loadUrl('https://github.com')" class="shortcut-btn">💻 GitHub</button>
                <button onclick="loadUrl('https://vmware.com')" class="shortcut-btn">🖥️ VMware</button>
                <button onclick="loadUrl('https://intel.com')" class="shortcut-btn">🔧 Intel</button>
            </div>
        </div>
        
        <div class="iframe-container">
            <div class="status-bar">
                <span id="status">آماده برای مرورگری...</span>
                <span id="proxy-status">🛡️ HTTP Proxy فعال</span>
            </div>
            <iframe id="content-frame" src="about:blank"></iframe>
        </div>
    </div>
    
    <script>
        function loadPage() {
            const url = document.getElementById('urlInput').value.trim();
            if (url) {
                loadUrl(url);
            }
        }
        
        function loadUrl(url) {
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                url = 'https://' + url;
            }
            
            const proxyUrl = \`/p/\${url}\`;
            const frame = document.getElementById('content-frame');
            const status = document.getElementById('status');
            
            status.textContent = 'در حال بارگذاری...';
            frame.src = proxyUrl;
            document.getElementById('urlInput').value = url;
            
            frame.onload = function() {
                status.textContent = \`✅ بارگذاری شد: \${url}\`;
            };
            
            frame.onerror = function() {
                status.textContent = '❌ خطا در بارگذاری';
            };
        }
        
        document.getElementById('urlInput').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                loadPage();
            }
        });
    </script>
</body>
</html>
  `, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  })
}

function getHomePage(hostname) {
  return `<!DOCTYPE html>
<html dir="rtl" lang="fa">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🇮🇷 DoH Iran Proxy - Compatible</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
            min-height: 100vh; color: white; direction: rtl; margin: 0; padding: 20px;
        }
        .container { max-width: 800px; margin: 0 auto; }
        .header { text-align: center; padding: 40px 0; }
        .header h1 { font-size: 3rem; margin-bottom: 20px; }
        .status {
            background: rgba(34, 197, 94, 0.2); border: 2px solid #22c55e;
            padding: 20px; border-radius: 15px; margin: 30px 0; text-align: center;
        }
        .endpoint {
            background: rgba(255,255,255,0.1); backdrop-filter: blur(10px);
            padding: 20px; border-radius: 15px; margin: 20px 0;
            font-family: 'Courier New', monospace; text-align: center;
            border: 1px solid rgba(255,255,255,0.2);
        }
        .setup {
            background: rgba(255,255,255,0.05); padding: 25px; border-radius: 15px;
            margin: 30px 0;
        }
        .setup-grid {
            display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
            gap: 20px; margin-top: 20px;
        }
        .setup-card {
            background: rgba(255,255,255,0.1); padding: 20px; border-radius: 10px;
        }
        .btn {
            background: rgba(255,255,255,0.2); color: white; padding: 12px 20px;
            text-decoration: none; border-radius: 20px; margin: 8px;
            display: inline-block; transition: all 0.3s;
        }
        .btn:hover { background: rgba(255,255,255,0.3); }
        .test-section {
            background: rgba(255,255,255,0.05); padding: 20px; border-radius: 15px;
            margin: 30px 0; text-align: center;
        }
        #test-result {
            background: rgba(0,0,0,0.3); padding: 15px; border-radius: 10px;
            margin-top: 15px; font-family: monospace; text-align: left; direction: ltr;
            white-space: pre-wrap; min-height: 100px; overflow-x: auto;
        }
        code {
            background: rgba(0,0,0,0.3); padding: 4px 8px; border-radius: 4px;
            font-family: 'Courier New', monospace;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🛡️ DoH Iran Proxy</h1>
            <p>DNS over HTTPS - مطابق با استانداردهای RFC</p>
        </div>
        
        <div class="status">
            ✅ <strong>سرویس آنلاین</strong><br>
            سازگار با Firefox, Chrome, Android Intra
        </div>
        
        <div class="endpoint">
            <div style="font-size: 1.2em; margin-bottom: 10px;">🌐 DoH Endpoint:</div>
            <div style="font-size: 1.1em; color: #a7f3d0;">https://${hostname}/dns-query</div>
        </div>
        
        <div class="test-section">
            <h2>🧪 تست سریع</h2>
            <button onclick="testDoH()" class="btn">📊 تست DNS</button>
            <button onclick="testWireFormat()" class="btn">🔧 تست Wire Format</button>
            <button onclick="clearResults()" class="btn">🗑️ پاک کردن</button>
            <div id="test-result">کلیک روی دکمه تست برای شروع...</div>
        </div>
        
        <div class="setup">
            <h2 style="text-align: center; margin-bottom: 20px;">📱 راهنمای تنظیم</h2>
            
            <div class="setup-grid">
                <div class="setup-card">
                    <h3>🦊 Firefox</h3>
                    <ol>
                        <li><code>about:preferences#privacy</code></li>
                        <li>DNS over HTTPS</li>
                        <li>Custom provider</li>
                        <li><code>https://${hostname}/dns-query</code></li>
                        <li>Restart Firefox</li>
                    </ol>
                </div>
                
                <div class="setup-card">
                    <h3>🔵 Chrome</h3>
                    <ol>
                        <li><code>chrome://settings/security</code></li>
                        <li>Use secure DNS</li>
                        <li>With Custom provider</li>
                        <li><code>https://${hostname}/dns-query</code></li>
                        <li>Restart Chrome</li>
                    </ol>
                </div>
                
                <div class="setup-card">
                    <h3>📱 Android Intra</h3>
                    <ol>
                        <li>Install Intra from Play Store</li>
                        <li>Settings → Choose DNS server</li>
                        <li>Custom server URL</li>
                        <li><code>https://${hostname}/dns-query</code></li>
                        <li>Test server → Enable</li>
                    </ol>
                </div>
                
                <div class="setup-card">
                    <h3>🌐 1.1.1.1 App</h3>
                    <ol>
                        <li>Install 1.1.1.1 app</li>
                        <li>Advanced → Connection options</li>
                        <li>DNS over HTTPS</li>
                        <li><code>https://${hostname}/dns-query</code></li>
                        <li>Save and Connect</li>
                    </ol>
                </div>
            </div>
        </div>
        
        <div style="text-align: center; margin-top: 40px; opacity: 0.8;">
            <p>🔒 رمزگذاری کامل | 🚀 سرعت بالا | 🛡️ حریم خصوصی محفوظ</p>
        </div>
    </div>
    
    <script>
        const resultDiv = document.getElementById('test-result');
        
        async function testDoH() {
            resultDiv.textContent = '🔍 Testing DoH JSON format...\\n';
            
            try {
                const response = await fetch('/dns-query?name=google.com&type=A');
                const data = await response.json();
                
                resultDiv.textContent += '✅ JSON Test Success!\\n';
                resultDiv.textContent += \`Response: \${response.status}\\n\`;
                resultDiv.textContent += \`Query time: \${data._iran_proxy?.query_time_ms}ms\\n\`;
                resultDiv.textContent += \`Blocked site: \${data._iran_proxy?.blocked_site}\\n\`;
                resultDiv.textContent += \`IP: \${data.Answer?.[0]?.data}\\n\\n\`;
                resultDiv.textContent += JSON.stringify(data, null, 2);
                
            } catch (error) {
                resultDiv.textContent += \`❌ Test Failed: \${error.message}\\n\`;
            }
        }
        
        async function testWireFormat() {
            resultDiv.textContent = '🔧 Testing DoH Wire format...\\n';
            
            try {
                const response = await fetch('/dns-query?name=cloudflare.com&type=A', {
                    headers: {
                        'Accept': 'application/dns-message'
                    }
                });
                
                resultDiv.textContent += \`✅ Wire Format Test: \${response.status}\\n\`;
                resultDiv.textContent += \`Content-Type: \${response.headers.get('Content-Type')}\\n\`;
                resultDiv.textContent += \`Content-Length: \${response.headers.get('Content-Length')} bytes\\n\`;
                
                if (response.ok) {
                    resultDiv.textContent += '✅ Wire format working correctly!\\n';
                } else {
                    resultDiv.textContent += '❌ Wire format failed\\n';
                }
                
            } catch (error) {
                resultDiv.textContent += \`❌ Wire Test Failed: \${error.message}\\n\`;
            }
        }
        
        function clearResults() {
            resultDiv.textContent = 'Results cleared. Click test button to start...';
        }
        
        // Auto test on load
        setTimeout(testDoH, 1000);
    </script>
</body>
</html>`
}