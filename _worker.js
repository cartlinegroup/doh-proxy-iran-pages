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
  'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'youtube.com',
  'telegram.org', 'discord.com', 'reddit.com', 'github.com'
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

function errorResponse(message, status, corsHeaders) {
  return new Response(JSON.stringify({ 
    error: message,
    status: status,
    timestamp: new Date().toISOString()
  }), {
    status: status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
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
