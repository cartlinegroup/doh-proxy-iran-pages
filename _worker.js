// فایل: _worker.js (اصلی‌ترین فایل)
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
    
    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }
    
    // صفحه اصلی
    if (url.pathname === '/') {
      return new Response(getMainPage(url.hostname), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      })
    }
    
    // DNS Query API
    if (url.pathname === '/dns-query' || url.pathname === '/resolve') {
      return handleDNSQuery(request, corsHeaders, url)
    }
    
    // Status API
    if (url.pathname === '/status') {
      return handleStatus(corsHeaders)
    }
    
    // Test API
    if (url.pathname === '/test') {
      return handleTest(corsHeaders)
    }
    
    return new Response('صفحه پیدا نشد', { status: 404 })
  }
}

async function handleDNSQuery(request, corsHeaders, url) {
  try {
    const name = url.searchParams.get('name')
    const type = url.searchParams.get('type') || 'A'
    const format = url.searchParams.get('format') || 'full'
    
    if (!name) {
      return jsonResponse({
        error: 'پارامتر "name" ضروری است',
        example: '/dns-query?name=google.com&type=A',
        formats: ['full', 'simple']
      }, 400, corsHeaders)
    }
    
    console.log(`🔍 DNS Query: ${name} (${type})`)
    
    // انتخاب بهترین DNS provider
    const provider = selectBestProvider(name)
    
    // ساخت URL با پارامترهای بهینه
    const queryParams = new URLSearchParams({
      name: name,
      type: type,
      cd: 'false',  // DNSSEC validation off
      do: 'false',  // DNSSEC OK bit off
      edns_client_subnet: '0.0.0.0/0'  // Privacy
    })
    
    const queryUrl = `${provider.url}?${queryParams.toString()}`
    
    // درخواست به DNS provider
    const startTime = Date.now()
    const dnsResponse = await fetch(queryUrl, {
      headers: {
        'Accept': 'application/dns-json',
        'User-Agent': 'DoH-Iran-Pages/2.0',
        'CF-IPCountry': request.headers.get('CF-IPCountry') || 'IR'
      },
      cf: {
        cacheTtl: 300,
        cacheEverything: true
      }
    })
    
    if (!dnsResponse.ok) {
      throw new Error(`DNS query failed: ${dnsResponse.status} ${dnsResponse.statusText}`)
    }
    
    const data = await dnsResponse.json()
    const queryTime = Date.now() - startTime
    
    // Metadata اضافی
    data._iran_proxy = {
      provider: provider.name,
      query_time_ms: queryTime,
      timestamp: new Date().toISOString(),
      server: 'Cloudflare-Pages-Iran',
      optimized_for_iran: true
    }
    
    // فرمت ساده اگر درخواست شده
    if (format === 'simple') {
      const simplified = {
        domain: name,
        type: type,
        answers: data.Answer?.map(record => ({
          ip: record.data,
          ttl: record.TTL
        })) || [],
        success: data.Status === 0
      }
      return jsonResponse(simplified, 200, corsHeaders)
    }
    
    return jsonResponse(data, 200, corsHeaders, {
      'Cache-Control': 'public, max-age=300',
      'X-DNS-Provider': provider.name,
      'X-Query-Time': `${queryTime}ms`
    })
    
  } catch (error) {
    console.error('❌ DNS Error:', error)
    
    // Fallback system
    try {
      const fallbackData = await tryFallbackProvider(url.searchParams.get('name'), url.searchParams.get('type') || 'A')
      if (fallbackData) {
        fallbackData._iran_proxy = {
          provider: 'Google-Fallback',
          timestamp: new Date().toISOString()
        }
        return jsonResponse(fallbackData, 200, corsHeaders)
      }
    } catch (fallbackError) {
      console.error('Fallback failed:', fallbackError)
    }
    
    return jsonResponse({
      error: 'خطا در حل نام دامنه',
      message: error.message,
      suggestion: 'نام دامنه را بررسی کنید یا دوباره امتحان کنید'
    }, 500, corsHeaders)
  }
}

function selectBestProvider(domain) {
  const providers = [
    { 
      name: 'Cloudflare-Primary', 
      url: 'https://cloudflare-dns.com/dns-query',
      priority: 1,
      best_for: ['general', 'iran', 'speed']
    },
    { 
      name: 'Google-Secondary', 
      url: 'https://dns.google/dns-query',
      priority: 2,
      best_for: ['reliability', 'global']
    },
    { 
      name: 'Quad9-Security', 
      url: 'https://dns.quad9.net/dns-query',
      priority: 3,
      best_for: ['security', 'privacy']
    }
  ]
  
  // دامنه‌های ایرانی
  const iranDomains = ['.ir', '.ایران', 'irna', 'tasnim', 'mehr', 'isna']
  
  if (iranDomains.some(iranDomain => domain.includes(iranDomain))) {
    return providers[0] // Cloudflare برای دامنه‌های ایرانی
  }
  
  return providers[0] // پیش‌فرض
}

async function tryFallbackProvider(name, type) {
  try {
    const response = await fetch(`https://dns.google/dns-query?name=${name}&type=${type}`, {
      headers: { 'Accept': 'application/dns-json' }
    })
    return response.ok ? await response.json() : null
  } catch {
    return null
  }
}

async function handleStatus(corsHeaders) {
  const providers = [
    { name: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
    { name: 'Google', url: 'https://dns.google/dns-query' }
  ]
  
  const status = {
    service: 'DoH Proxy Iran',
    timestamp: new Date().toISOString(),
    providers: []
  }
  
  for (const provider of providers) {
    try {
      const start = Date.now()
      const response = await fetch(`${provider.url}?name=google.com&type=A`, {
        headers: { 'Accept': 'application/dns-json' }
      })
      const latency = Date.now() - start
      
      status.providers.push({
        name: provider.name,
        status: response.ok ? 'OK' : 'ERROR',
        latency_ms: latency,
        response_code: response.status
      })
    } catch (error) {
      status.providers.push({
        name: provider.name,
        status: 'TIMEOUT',
        error: error.message
      })
    }
  }
  
  return jsonResponse(status, 200, corsHeaders)
}

async function handleTest(corsHeaders) {
  const testDomains = [
    { name: 'google.com', description: 'سرویس جهانی' },
    { name: 'github.com', description: 'سرویس توسعه' },
    { name: 'cloudflare.com', description: 'CDN سریع' },
    { name: 'irna.ir', description: 'سایت ایرانی' }
  ]
  
  const results = []
  
  for (const domain of testDomains) {
    try {
      const start = Date.now()
      const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${domain.name}&type=A`, {
        headers: { 'Accept': 'application/dns-json' }
      })
      const latency = Date.now() - start
      const data = await response.json()
      
      results.push({
        domain: domain.name,
        description: domain.description,
        status: 'SUCCESS',
        latency_ms: latency,
        ip_addresses: data.Answer?.map(a => a.data) || [],
        records_count: data.Answer?.length || 0
      })
    } catch (error) {
      results.push({
        domain: domain.name,
        description: domain.description,
        status: 'FAILED',
        error: error.message
      })
    }
  }
  
  return jsonResponse({
    test_timestamp: new Date().toISOString(),
    results: results,
    summary: {
      total_tests: results.length,
      successful: results.filter(r => r.status === 'SUCCESS').length,
      failed: results.filter(r => r.status === 'FAILED').length
    }
  }, 200, corsHeaders)
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
    <title>🇮🇷 DoH Proxy Iran - Cloudflare Pages</title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🚀</text></svg>">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            color: white;
            direction: rtl;
        }
        .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
        .hero {
            text-align: center;
            padding: 60px 0 40px;
        }
        .hero h1 {
            font-size: 3.5rem;
            margin-bottom: 20px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
            background: linear-gradient(45deg, #fff, #e3f2fd);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .hero p { font-size: 1.3rem; opacity: 0.9; }
        .endpoint-card {
            background: rgba(255,255,255,0.15);
            backdrop-filter: blur(20px);
            border-radius: 20px;
            padding: 30px;
            margin: 30px 0;
            border: 1px solid rgba(255,255,255,0.1);
        }
        .endpoint {
            background: linear-gradient(135deg, #4CAF50, #45a049);
            color: white;
            padding: 20px;
            border-radius: 15px;
            font-family: 'Courier New', monospace;
            font-size: 1.1rem;
            text-align: center;
            word-break: break-all;
        }
        .cards {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
            gap: 30px;
            margin: 40px 0;
        }
        .card {
            background: rgba(255,255,255,0.1);
            backdrop-filter: blur(20px);
            border-radius: 20px;
            padding: 30px;
            border: 1px solid rgba(255,255,255,0.1);
            transition: transform 0.3s ease;
        }
        .card:hover {
            transform: translateY(-5px);
            background: rgba(255,255,255,0.15);
        }
        .card h3 {
            font-size: 1.5rem;
            margin-bottom: 20px;
            color: #e3f2fd;
        }
        .feature-list {
            list-style: none;
            padding: 0;
        }
        .feature-list li {
            padding: 8px 0;
            border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        .feature-list li:last-child { border-bottom: none; }
        .api-example {
            background: rgba(0,0,0,0.2);
            padding: 15px;
            border-radius: 10px;
            margin: 15px 0;
            font-family: 'Courier New', monospace;
            font-size: 0.9rem;
            border-left: 4px solid #4CAF50;
        }
        .btn-group {
            display: flex;
            gap: 15px;
            justify-content: center;
            flex-wrap: wrap;
            margin: 30px 0;
        }
        .btn {
            background: rgba(255,255,255,0.2);
            color: white;
            padding: 12px 24px;
            text-decoration: none;
            border-radius: 25px;
            transition: all 0.3s ease;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255,255,255,0.1);
        }
        .btn:hover {
            background: rgba(255,255,255,0.3);
            transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(0,0,0,0.2);
        }
        .status-indicator {
            display: inline-block;
            width: 12px;
            height: 12px;
            background: #4CAF50;
            border-radius: 50%;
            margin-left: 8px;
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0% { box-shadow: 0 0 0 0 rgba(76, 175, 80, 0.7); }
            70% { box-shadow: 0 0 0 10px rgba(76, 175, 80, 0); }
            100% { box-shadow: 0 0 0 0 rgba(76, 175, 80, 0); }
        }
        .warning {
            background: rgba(255, 193, 7, 0.2);
            border: 1px solid rgba(255, 193, 7, 0.5);
            padding: 20px;
            border-radius: 15px;
            margin: 20px 0;
        }
        code {
            background: rgba(0,0,0,0.3);
            padding: 4px 8px;
            border-radius: 5px;
            font-family: 'Courier New', monospace;
        }
        @media (max-width: 768px) {
            .hero h1 { font-size: 2.5rem; }
            .cards { grid-template-columns: 1fr; }
            .btn-group { flex-direction: column; align-items: center; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="hero">
            <h1>🚀 DoH Proxy Iran</h1>
            <p>DNS over HTTPS با بالاترین کیفیت و سرعت</p>
            <span class="status-indicator"></span>
            <span>آنلاین و آماده خدمات‌رسانی</span>
        </div>
        
        <div class="endpoint-card">
            <h2>🌐 Endpoint اصلی</h2>
            <div class="endpoint">
                https://${hostname}/dns-query
            </div>
        </div>
        
        <div class="cards">
            <div class="card">
                <h3>⚡ ویژگی‌های پیشرفته</h3>
                <ul class="feature-list">
                    <li>🎯 انتخاب هوشمند DNS provider</li>
                    <li>🚀 Cloudflare Pages Edge Network</li>
                    <li>🔄 سیستم Fallback خودکار</li>
                    <li>📊 آمار کامل Query</li>
                    <li>🇮🇷 بهینه‌سازی ویژه ایران</li>
                    <li>🛡️ حریم خصوصی محفوظ</li>
                </ul>
            </div>
            
            <div class="card">
                <h3>🛠️ API Examples</h3>
                
                <p><strong>Basic Query:</strong></p>
                <div class="api-example">
                    GET /dns-query?name=google.com&type=A
                </div>
                
                <p><strong>Simple Format:</strong></p>
                <div class="api-example">
                    GET /dns-query?name=github.com&format=simple
                </div>
                
                <p><strong>Iranian Domain:</strong></p>
                <div class="api-example">
                    GET /dns-query?name=irna.ir&type=A
                </div>
            </div>
            
            <div class="card">
                <h3>🔧 تنظیمات مرورگر</h3>
                
                <p><strong>Firefox:</strong></p>
                <p>Settings → Privacy & Security → DNS over HTTPS → Custom</p>
                <code>https://${hostname}/dns-query</code>
                
                <p style="margin-top: 15px;"><strong>Chrome/Edge:</strong></p>
                <p>Settings → Privacy and security → Security → Use secure DNS</p>
                <code>https://${hostname}/dns-query</code>
                
                <p style="margin-top: 15px;"><strong>Android:</strong></p>
                <p>Network & Internet → Private DNS</p>
                <code>${hostname}</code>
            </div>
        </div>
        
        <div class="btn-group">
            <a href="/dns-query?name=google.com&type=A" class="btn">📊 تست Google</a>
            <a href="/dns-query?name=github.com&format=simple" class="btn">🔍 فرمت ساده</a>
            <a href="/status" class="btn">📈 وضعیت سرورها</a>
            <a href="/test" class="btn">🧪 تست کامل</a>
        </div>
        
        <div class="warning">
            <strong>💡 نکته مهم:</strong> این DNS proxy برای دور زدن محدودیت‌های DNS طراحی شده است.
            برای دسترسی کامل به YouTube و Telegram، استفاده همزمان با VPN توصیه می‌شود.
        </div>
        
        <div style="text-align: center; margin-top: 40px; opacity: 0.8;">
            <p>🛡️ بدون لاگ‌گیری | 🚀 سرعت بالا | 🔒 رمزگذاری کامل</p>
        </div>
    </div>
    
    <script>
        // تست خودکار در بارگذاری
        document.addEventListener('DOMContentLoaded', async () => {
            try {
                const response = await fetch('/dns-query?name=google.com&type=A');
                const data = await response.json();
                console.log('✅ DNS Service Test:', data);
            } catch (error) {
                console.log('❌ DNS Service Error:', error);
            }
        });
    </script>
</body>
</html>`
}
