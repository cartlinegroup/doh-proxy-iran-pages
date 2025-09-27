// _worker.js - نسخه اصلاح شده برای مرورگرها
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
    
    // DNS Query API - پشتیبانی از هر دو فرمت
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
    let name, type = 'A'
    let isWireFormat = false
    
    if (request.method === 'GET') {
      // GET request - معمولاً از مرورگرها
      name = url.searchParams.get('name')
      type = url.searchParams.get('type') || 'A'
      
      // بررسی اینکه آیا درخواست از مرورگر است (DNS wire format)
      const acceptHeader = request.headers.get('Accept') || ''
      isWireFormat = acceptHeader.includes('application/dns-message')
      
      if (!name) {
        // اگر پارامتر name نیست، ممکن است DNS wire format باشد
        const dnsParam = url.searchParams.get('dns')
        if (dnsParam) {
          // Base64 decoded DNS query
          try {
            const dnsQuery = base64UrlDecode(dnsParam)
            return await forwardDNSQuery(dnsQuery, corsHeaders, true)
          } catch (error) {
            console.error('DNS wire format error:', error)
          }
        }
        
        return jsonResponse({
          error: 'پارامتر "name" ضروری است',
          example: '/dns-query?name=google.com&type=A',
          note: 'برای مرورگرها از فرمت DNS wire استفاده می‌شود'
        }, 400, corsHeaders)
      }
    } else if (request.method === 'POST') {
      // POST request - DNS wire format
      const contentType = request.headers.get('Content-Type') || ''
      if (contentType.includes('application/dns-message')) {
        const dnsQuery = new Uint8Array(await request.arrayBuffer())
        return await forwardDNSQuery(dnsQuery, corsHeaders, true)
      }
    }
    
    console.log(`🔍 DNS Query: ${name} (${type})`)
    
    // انتخاب بهترین DNS provider
    const provider = selectBestProvider(name)
    
    // ساخت URL با پارامترهای بهینه
    const queryParams = new URLSearchParams({
      name: name,
      type: type,
      cd: 'false',
      do: 'false',
      edns_client_subnet: '0.0.0.0/0'
    })
    
    const queryUrl = `${provider.url}?${queryParams.toString()}`
    
    // تشخیص فرمت مورد نیاز
    const acceptHeader = request.headers.get('Accept') || ''
    const needsWireFormat = acceptHeader.includes('application/dns-message')
    const needsJSON = acceptHeader.includes('application/dns-json') || acceptHeader.includes('application/json')
    
    // درخواست به DNS provider
    const startTime = Date.now()
    let dnsResponse
    
    if (needsWireFormat) {
      // درخواست wire format
      dnsResponse = await fetch(queryUrl, {
        headers: {
          'Accept': 'application/dns-message',
          'User-Agent': 'DoH-Iran-Pages/2.0'
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

async function forwardDNSQuery(dnsQuery, corsHeaders, isWireFormat = false) {
  try {
    // Forward به Cloudflare DoH
    const response = await fetch('https://cloudflare-dns.com/dns-query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/dns-message',
        'Accept': 'application/dns-message'
      },
      body: dnsQuery
    })
    
    if (!response.ok) {
      throw new Error(`DNS forward failed: ${response.status}`)
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
    console.error('DNS forward error:', error)
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
    <title>🇮🇷 DoH Proxy Iran - Fixed for Browsers</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            color: white;
            direction: rtl;
        }
        .container { max-width: 1000px; margin: 0 auto; padding: 20px; }
        .hero { text-align: center; padding: 40px 0; }
        .hero h1 { font-size: 3rem; margin-bottom: 20px; }
        .endpoint-card {
            background: rgba(255,255,255,0.15);
            backdrop-filter: blur(20px);
            border-radius: 20px;
            padding: 30px;
            margin: 30px 0;
        }
        .endpoint {
            background: linear-gradient(135deg, #4CAF50, #45a049);
            color: white;
            padding: 20px;
            border-radius: 15px;
            font-family: monospace;
            text-align: center;
        }
        .setup-instructions {
            background: rgba(255,255,255,0.1);
            border-radius: 15px;
            padding: 25px;
            margin: 20px 0;
        }
        .warning {
            background: rgba(255, 193, 7, 0.2);
            border: 1px solid rgba(255, 193, 7, 0.5);
            padding: 20px;
            border-radius: 15px;
            margin: 20px 0;
        }
        .btn {
            background: rgba(255,255,255,0.2);
            color: white;
            padding: 12px 24px;
            text-decoration: none;
            border-radius: 25px;
            margin: 10px;
            display: inline-block;
        }
        code {
            background: rgba(0,0,0,0.3);
            padding: 4px 8px;
            border-radius: 5px;
            font-family: monospace;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="hero">
            <h1>🚀 DoH Proxy Iran</h1>
            <p>نسخه اصلاح شده - سازگار با تمام مرورگرها</p>
        </div>
        
        <div class="endpoint-card">
            <h2>🌐 Endpoint برای مرورگرها</h2>
            <div class="endpoint">
                https://${hostname}/dns-query
            </div>
        </div>
        
        <div class="setup-instructions">
            <h3>🛠️ تنظیمات صحیح مرورگرها:</h3>
            
            <p><strong>Firefox:</strong></p>
            <ol>
                <li>برو به <code>about:preferences#privacy</code></li>
                <li><strong>DNS over HTTPS</strong> پیدا کن</li>
                <li><strong>Custom</strong> انتخاب کن</li>
                <li>URL: <code>https://${hostname}/dns-query</code></li>
                <li>Firefox رو restart کن</li>
            </ol>
            
            <p style="margin-top: 20px;"><strong>Chrome/Edge:</strong></p>
            <ol>
                <li>برو به <code>chrome://settings/security</code></li>
                <li><strong>Use secure DNS</strong> فعال کن</li>
                <li><strong>With: Custom</strong> انتخاب کن</li>
                <li>URL: <code>https://${hostname}/dns-query</code></li>
                <li>مرورگر رو restart کن</li>
            </ol>
        </div>
        
        <div class="warning">
            <strong>🔧 اگر هنوز کار نمی‌کنه:</strong><br>
            1. مرورگر رو کاملاً ببند و دوباره باز کن<br>
            2. Cache رو پاک کن (Ctrl+Shift+Del)<br>
            3. از حالت Incognito/Private امتحان کن<br>
            4. DNS کامپیوتر رو موقتاً به 1.1.1.1 تغییر بده
        </div>
        
        <center>
            <a href="/dns-query?name=google.com&type=A" class="btn">📊 تست JSON</a>
            <a href="/status" class="btn">📈 وضعیت سرورها</a>
            <a href="/test" class="btn">🧪 تست کامل</a>
        </center>
        
        <div style="text-align: center; margin-top: 40px; opacity: 0.8;">
            <p>🛡️ پشتیبانی کامل از DNS wire format | 🚀 سازگار با تمام مرورگرها</p>
        </div>
    </div>
</body>
</html>`
}