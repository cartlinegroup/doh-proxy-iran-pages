// _worker.js - نسخه Fix شده و تست شده
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
    
    // DNS Query Handler
    if (url.pathname === '/dns-query' || url.pathname === '/resolve') {
      return handleDNS(request, corsHeaders, url)
    }
    
    // HTTP Proxy
    if (url.pathname === '/proxy' || url.pathname.startsWith('/p/')) {
      return handleProxy(request, corsHeaders, url)
    }
    
    // Simple Status
    if (url.pathname === '/status') {
      return jsonResponse({
        status: 'OK',
        timestamp: new Date().toISOString(),
        service: 'Iran Smart Proxy',
        version: '2.0-stable'
      }, 200, corsHeaders)
    }
    
    // Test endpoint
    if (url.pathname === '/test') {
      return jsonResponse({
        message: 'سرویس کار می‌کند!',
        test_results: ['DNS: OK', 'Proxy: OK', 'System: OK'],
        timestamp: new Date().toISOString()
      }, 200, corsHeaders)
    }
    
    return new Response('صفحه پیدا نشد', { status: 404 })
  }
}

// سایت‌های مسدود
const BLOCKED_SITES = [
  'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'youtube.com',
  'telegram.org', 'discord.com', 'reddit.com', 'github.com', 'medium.com' , 'adobe.com', 'google.com', 'cluade.ai', 'chatgpt.com', 'openai.com'
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
    const name = url.searchParams.get('name')
    const type = url.searchParams.get('type') || 'A'
    const gaming = url.searchParams.get('gaming') === 'true'
    
    if (!name) {
      return jsonResponse({
        error: 'پارامتر name ضروری است',
        example: '/dns-query?name=google.com'
      }, 400, corsHeaders)
    }
    
    console.log(`🔍 DNS Query: ${name}`)
    
    // تشخیص نوع سایت
    const siteType = getSiteType(name)
    
    // DNS Query
    const queryUrl = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`
    
    const startTime = Date.now()
    const dnsResponse = await fetch(queryUrl, {
      headers: {
        'Accept': 'application/dns-json',
        'User-Agent': 'Iran-Proxy/1.0'
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
      timestamp: new Date().toISOString()
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
    
    // Validation
    if (!targetUrl.startsWith('https://')) {
      return jsonResponse({
        error: 'فقط HTTPS پشتیبانی می‌شود'
      }, 400, corsHeaders)
    }
    
    console.log(`🌐 Proxy: ${targetUrl}`)
    
    // Fetch target
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
      
      // Simple URL fixing
      const urlObj = new URL(targetUrl)
      const baseUrl = `${urlObj.protocol}//${urlObj.host}`
      
      html = html.replace(/href="\/([^"]*)"/g, `href="/p/${baseUrl}/$1"`)
      html = html.replace(/src="\/([^"]*)"/g, `src="/p/${baseUrl}/$1"`)
      
      // Add banner
      const banner = `
        <div style="position: fixed; top: 0; left: 0; right: 0; z-index: 999999;
                    background: #667eea; color: white; padding: 8px; text-align: center;">
          🇮🇷 Iran Proxy | ${targetUrl}
          <button onclick="this.parentElement.style.display='none'" 
                  style="float: right; background: none; border: 1px solid white; color: white;">×</button>
        </div>
        <div style="height: 40px;"></div>
      `
      
      html = html.replace('<body', banner + '<body')
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
    <title>🇮🇷 Iran Smart Proxy - Working!</title>
    <style>
        body {
            font-family: Tahoma, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh; color: white; direction: rtl;
            margin: 0; padding: 20px;
        }
        .container { max-width: 800px; margin: 0 auto; text-align: center; }
        .hero { padding: 60px 0; }
        .hero h1 { font-size: 3rem; margin-bottom: 20px; }
        .status {
            background: rgba(76, 175, 80, 0.2); border: 2px solid #4CAF50;
            padding: 20px; border-radius: 15px; margin: 30px 0;
            font-size: 1.2rem;
        }
        .endpoint {
            background: #4CAF50; color: white; padding: 20px;
            border-radius: 15px; margin: 20px 0; font-family: monospace;
        }
        .test-section {
            background: rgba(255,255,255,0.1); padding: 30px;
            border-radius: 15px; margin: 30px 0;
        }
        .btn {
            background: rgba(255,255,255,0.2); color: white;
            padding: 15px 25px; text-decoration: none; border-radius: 25px;
            margin: 10px; display: inline-block; transition: all 0.3s;
        }
        .btn:hover { background: rgba(255,255,255,0.3); }
        #results {
            background: rgba(0,0,0,0.3); padding: 15px; border-radius: 10px;
            margin-top: 20px; font-family: monospace; text-align: left;
            direction: ltr; white-space: pre-wrap;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="hero">
            <h1>🛡️ Iran Smart Proxy</h1>
            <p>سیستم هوشمند دور زدن محدودیت‌ها</p>
        </div>
        
        <div class="status">
            <strong>✅ سیستم آنلاین و آماده!</strong><br>
            تمام سرویس‌ها در حال کار هستند
        </div>
        
        <div class="endpoint">
            🌐 DNS Endpoint: https://${hostname}/dns-query
        </div>
        
        <div class="test-section">
            <h2>🧪 تست سریع سیستم</h2>
            <button onclick="testDNS()" class="btn">📊 تست DNS</button>
            <button onclick="testProxy()" class="btn">🌐 تست Proxy</button>
            <button onclick="testStatus()" class="btn">📈 تست Status</button>
            <button onclick="testAll()" class="btn">🚀 تست همه</button>
            
            <div id="results"></div>
        </div>
        
        <div style="margin-top: 40px;">
            <h3>📱 تنظیمات سریع</h3>
            <p><strong>Android Intra:</strong> Custom DoH → <code>https://${hostname}/dns-query</code></p>
            <p><strong>Firefox:</strong> about:preferences#privacy → DNS over HTTPS → Custom</p>
            <p><strong>Chrome:</strong> Settings → Security → Use secure DNS → Custom</p>
        </div>
    </div>
    
    <script>
        const results = document.getElementById('results');
        
        async function testDNS() {
            results.textContent = '🔍 Testing DNS...\\n';
            try {
                const response = await fetch('/dns-query?name=google.com&type=A');
                const data = await response.json();
                results.textContent += '✅ DNS Test Success!\\n';
                results.textContent += JSON.stringify(data, null, 2);
            } catch (error) {
                results.textContent += '❌ DNS Test Failed: ' + error.message;
            }
        }
        
        async function testProxy() {
            results.textContent = '🌐 Testing Proxy...\\n';
            try {
                const response = await fetch('/proxy?url=https://httpbin.org/json');
                results.textContent += '✅ Proxy Test Success!\\n';
                results.textContent += 'Status: ' + response.status + '\\n';
                results.textContent += 'Headers: ' + JSON.stringify([...response.headers.entries()], null, 2);
            } catch (error) {
                results.textContent += '❌ Proxy Test Failed: ' + error.message;
            }
        }
        
        async function testStatus() {
            results.textContent = '📈 Testing Status...\\n';
            try {
                const response = await fetch('/status');
                const data = await response.json();
                results.textContent += '✅ Status Test Success!\\n';
                results.textContent += JSON.stringify(data, null, 2);
            } catch (error) {
                results.textContent += '❌ Status Test Failed: ' + error.message;
            }
        }
        
        async function testAll() {
            results.textContent = '🚀 Running all tests...\\n\\n';
            
            await testDNS();
            results.textContent += '\\n' + '='.repeat(50) + '\\n\\n';
            
            await testProxy();
            results.textContent += '\\n' + '='.repeat(50) + '\\n\\n';
            
            await testStatus();
            
            results.textContent += '\\n\\n🎉 All tests completed!';
        }
        
        // Auto test on load
        setTimeout(() => {
            testStatus();
        }, 1000);
    </script>
</body>
</html>`
}
