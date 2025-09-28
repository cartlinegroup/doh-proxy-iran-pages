// _worker.js - Compatible with Browsers (DNS Wire Format + JSON)
// Version 2.2 - Updated & Secured by Gemini
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS Headers for API access and cross-origin requests
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, User-Agent',
      'Access-Control-Max-Age': '86400'
    };

    // Handle CORS preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Route for the main landing page
    if (url.pathname === '/') {
      return new Response(getMainPage(url.hostname), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // Route for DNS queries (both JSON and Wire Format)
    if (url.pathname === '/dns-query' || url.pathname === '/resolve') {
      return handleDNS(request, corsHeaders, url);
    }

    // Route for the HTTP web proxy
    if (url.pathname === '/proxy' || url.pathname.startsWith('/p/')) {
      return handleProxy(request, corsHeaders, url);
    }

    // Route for service status check
    if (url.pathname === '/status') {
      return jsonResponse({
        status: 'OK',
        timestamp: new Date().toISOString(),
        service: 'Iran Smart Proxy - Browser Compatible',
        version: '2.2-secure',
        supports: ['DNS JSON', 'DNS Wire Format', 'HTTP Proxy']
      }, 200, corsHeaders);
    }

    // Default 404 Not Found response
    return new Response('صفحه پیدا نشد', { status: 404 });
  }
};

// --- CONSTANTS ---

// List of blocked sites for proxying
const BLOCKED_SITES = [
  'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'youtube.com',
  'telegram.org', 'discord.com', 'reddit.com', 'github.com', 'medium.com',
  'bbc.com', 'cnn.com', 'wikipedia.org'
];

// List of Iranian sites for direct routing
const IRANIAN_SITES = [
  '.ir', '.ایران', 'irna.ir', 'tasnim.ir', 'mehr.ir', 'digikala.com'
];

// List of gaming-related domains
const GAMING_DOMAINS = [
  'steampowered.com', 'steamcommunity.com', 'riotgames.com',
  'leagueoflegends.com', 'valorant.com', 'epicgames.com'
];

// A pool of Cloudflare IPs to return for proxied domains
const CF_IPS = [
  '104.16.132.229', '104.16.133.229', '172.67.69.9', '172.67.70.9'
];

// --- CORE HANDLERS ---

/**
 * Handles DNS queries for both GET (JSON/Wire) and POST (Wire) requests.
 * @param {Request} request The incoming request object.
 * @param {Object} corsHeaders The CORS headers.
 * @param {URL} url The parsed URL of the request.
 * @returns {Response} The DNS response in the requested format.
 */
async function handleDNS(request, corsHeaders, url) {
  try {
    let dnsQuery = null;
    let name = null;
    let type = 'A';

    // Parse request based on method
    if (request.method === 'GET') {
      name = url.searchParams.get('name');
      type = url.searchParams.get('type') || 'A';
      const dnsParam = url.searchParams.get('dns');
      if (dnsParam) {
        try {
          dnsQuery = base64UrlDecode(dnsParam);
        } catch (e) {
          console.log('Invalid DNS base64 parameter:', e);
        }
      }
    } else if (request.method === 'POST') {
      const contentType = request.headers.get('Content-Type') || '';
      if (contentType.includes('application/dns-message')) {
        dnsQuery = new Uint8Array(await request.arrayBuffer());
      }
    }

    // If it's a raw wire format query, just forward it
    if (dnsQuery) {
      return await forwardDNSWireFormat(dnsQuery, corsHeaders);
    }

    if (!name) {
      return jsonResponse({
        error: 'پارامتر name ضروری است',
        examples: {
          json: '/dns-query?name=google.com',
          wire: '/dns-query?dns=BASE64_ENCODED_QUERY'
        }
      }, 400, corsHeaders);
    }

    console.log(`🔍 DNS Query: ${name}`);

    // Detect response format from Accept header
    const acceptHeader = request.headers.get('Accept') || '';
    const wantsWireFormat = acceptHeader.includes('application/dns-message');
    
    // Classify the site
    const siteType = getSiteType(name);
    const gaming = url.searchParams.get('gaming') === 'true' || siteType === 'gaming';

    // Choose DNS provider (can be extended for different modes)
    let dnsProvider = 'https://cloudflare-dns.com/dns-query';
    if (gaming) {
        console.log(`🎮 Gaming mode activated for: ${name}`);
        // For future: use a DNS provider optimized for gaming latency
        // dnsProvider = 'https://dns.google/resolve';
    }
    
    const queryUrl = `${dnsProvider}?name=${encodeURIComponent(name)}&type=${type}`;
    const startTime = Date.now();

    // Handle browser DoH (Wire Format) requests
    if (wantsWireFormat) {
      const dnsResponse = await fetch(queryUrl, {
        headers: { 'Accept': 'application/dns-message', 'User-Agent': 'Iran-Proxy-Browser/1.0' }
      });
      if (dnsResponse.ok) {
        const wireData = await dnsResponse.arrayBuffer();
        return new Response(wireData, {
          headers: { ...corsHeaders, 'Content-Type': 'application/dns-message', 'Cache-Control': 'public, max-age=300' }
        });
      }
    }

    // Default to JSON format for APIs and other clients
    const dnsResponse = await fetch(queryUrl, {
      headers: { 'Accept': 'application/dns-json', 'User-Agent': 'Iran-Proxy-JSON/1.0' }
    });

    if (!dnsResponse.ok) {
      throw new Error(`DNS upstream failed: ${dnsResponse.status}`);
    }

    const data = await dnsResponse.json();
    const queryTime = Date.now() - startTime;

    // Apply Smart Proxy Logic: Replace A records for blocked sites with CF IPs
    if (siteType === 'blocked' && data.Answer) {
      data.Answer = data.Answer.map(record => {
        if (record.type === 1) { // A record
          const cfIP = CF_IPS[Math.floor(Math.random() * CF_IPS.length)];
          return { ...record, data: cfIP, TTL: 300, _original: record.data, _proxied: true };
        }
        return record;
      });
    }

    // Add useful metadata to the JSON response
    data._iran_proxy = {
      site_type: siteType,
      gaming_mode: gaming,
      proxy_applied: siteType === 'blocked',
      query_time_ms: queryTime,
      timestamp: new Date().toISOString(),
      format: 'JSON'
    };

    return jsonResponse(data, 200, corsHeaders, {
      'Cache-Control': 'public, max-age=300',
      'X-Site-Type': siteType,
      'X-Query-Time': `${queryTime}ms`
    });

  } catch (error) {
    console.error('DNS Handler Error:', error);
    return jsonResponse({ error: 'خطا در پردازش درخواست DNS', message: error.message }, 500, corsHeaders);
  }
}

/**
 * Handles the HTTP web proxy for accessing websites directly.
 * @param {Request} request The incoming request object.
 * @param {Object} corsHeaders The CORS headers.
 * @param {URL} url The parsed URL of the request.
 * @returns {Response} The proxied web content.
 */
async function handleProxy(request, corsHeaders, url) {
  try {
    let targetUrl;
    if (url.pathname === '/proxy') {
      targetUrl = url.searchParams.get('url');
    } else if (url.pathname.startsWith('/p/')) {
      targetUrl = url.pathname.substring(3);
    }

    if (!targetUrl) return jsonResponse({ error: 'پارامتر url ضروری است', example: '/proxy?url=https://x.com' }, 400, corsHeaders);
    if (!targetUrl.startsWith('https://')) return jsonResponse({ error: 'فقط پروتکل HTTPS پشتیبانی می‌شود' }, 400, corsHeaders);

    console.log(`🌐 Proxying: ${targetUrl}`);

    const proxyResponse = await fetch(targetUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
    });
    if (!proxyResponse.ok) throw new Error(`Fetch failed with status ${proxyResponse.status}`);

    const contentType = proxyResponse.headers.get('Content-Type') || '';
    let body;

    if (contentType.includes('text/html')) {
      // Note: This regex-based replacement is simple but has limitations.
      // For a more robust solution, Cloudflare's HTMLRewriter is recommended.
      let html = await proxyResponse.text();
      const urlObj = new URL(targetUrl);
      const baseUrl = `${urlObj.protocol}//${urlObj.host}`;

      // Rewrite relative links to use the proxy
      html = html.replace(/href="\/([^"]*)"/g, `href="/p/${baseUrl}/$1"`);
      html = html.replace(/src="\/([^"]*)"/g, `src="/p/${baseUrl}/$1"`);

      // Inject a banner to inform the user they are using the proxy
      const banner = `
        <div style="position: fixed; top: 0; left: 0; right: 0; z-index: 999999; background: linear-gradient(45deg, #667eea, #764ba2); color: white; padding: 8px 15px; text-align: center; font-family: Arial, sans-serif; font-size: 13px; border-bottom: 1px solid rgba(255,255,255,0.2);">
          🇮🇷 Iran Proxy | <a href="${targetUrl}" target="_blank" style="color:white; text-decoration:underline;">${targetUrl}</a>
          <button onclick="this.parentElement.style.display='none'" style="float: right; background: rgba(255,255,255,0.2); border: 1px solid white; color: white; border-radius: 3px; cursor: pointer; padding: 2px 8px; margin-top: -3px;">×</button>
        </div>
        <script>if (document.body) document.body.style.paddingTop = '40px';</script>
      `;
      html = html.replace(/<body([^>]*)>/i, `<body$1>${banner}`);
      body = html;
    } else {
      // For non-HTML content, stream the body directly
      body = proxyResponse.body;
    }

    return new Response(body, {
      status: proxyResponse.status,
      headers: { ...corsHeaders, 'Content-Type': contentType, 'X-Proxy-Status': 'Success' }
    });

  } catch (error) {
    console.error('Proxy Handler Error:', error);
    return jsonResponse({ error: 'خطا در پراکسی کردن درخواست', message: error.message }, 500, corsHeaders);
  }
}

// --- HELPER FUNCTIONS ---

/**
 * Forwards a raw DNS wire format query to the upstream resolver.
 * @param {Uint8Array} dnsQuery The DNS query in wire format.
 * @param {Object} corsHeaders The CORS headers.
 * @returns {Response} The DNS response in wire format.
 */
async function forwardDNSWireFormat(dnsQuery, corsHeaders) {
  try {
    console.log('🔄 Forwarding DNS wire format query');
    const response = await fetch('https://cloudflare-dns.com/dns-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/dns-message', 'Accept': 'application/dns-message', 'User-Agent': 'Iran-Proxy-Wire/1.0' },
      body: dnsQuery
    });
    if (!response.ok) throw new Error(`Wire format forward failed: ${response.status}`);
    const responseData = await response.arrayBuffer();
    return new Response(responseData, {
      headers: { ...corsHeaders, 'Content-Type': 'application/dns-message', 'Cache-Control': 'public, max-age=300', 'X-Proxy-Format': 'Wire' }
    });
  } catch (error) {
    console.error('Wire format forward error:', error);
    throw error;
  }
}

/**
 * Decodes a URL-safe Base64 string into a Uint8Array.
 * @param {string} str The Base64 URL string.
 * @returns {Uint8Array} The decoded byte array.
 */
function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Accurately classifies a domain as 'iranian', 'blocked', 'gaming', or 'normal'.
 * This updated version is more secure and avoids false positives.
 * @param {string} domain The domain name to classify.
 * @returns {string} The classification of the site.
 */
function getSiteType(domain) {
    const d = domain.toLowerCase();

    // Helper for accurate matching (exact or subdomain)
    const isMatch = (domain, list) => list.some(site => domain === site || domain.endsWith('.' + site));
    
    // For Iranian sites, endsWith is sufficient and correct
    if (IRANIAN_SITES.some(site => d.endsWith(site))) {
        return 'iranian';
    }
    
    if (isMatch(d, BLOCKED_SITES)) {
        return 'blocked';
    }
    
    if (isMatch(d, GAMING_DOMAINS)) {
        return 'gaming';
    }
    
    return 'normal';
}

/**
 * Creates a JSON response with appropriate headers.
 * @param {Object} data The data to be stringified.
 * @param {number} status The HTTP status code.
 * @param {Object} corsHeaders The CORS headers.
 * @param {Object} additionalHeaders Any other headers to add.
 * @returns {Response} A JSON response object.
 */
function jsonResponse(data, status = 200, corsHeaders = {}, additionalHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8', ...additionalHeaders }
  });
}

/**
 * Generates the HTML for the main landing page.
 * @param {string} hostname The hostname of the worker.
 * @returns {string} The HTML content of the page.
 */
function getMainPage(hostname) {
  return `<!DOCTYPE html>
<html dir="rtl" lang="fa">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🇮🇷 Iran Smart Proxy - Browser Compatible</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; color: white; direction: rtl; margin: 0; padding: 20px; box-sizing: border-box; }
        .container { max-width: 900px; margin: 0 auto; }
        .hero { text-align: center; padding: 40px 0; }
        .hero h1 { font-size: 2.5rem; margin-bottom: 15px; }
        .status { background: rgba(76, 175, 80, 0.2); border: 2px solid #4CAF50; padding: 15px; border-radius: 15px; margin: 20px 0; text-align: center; font-size: 1.1rem; }
        .endpoint { background: linear-gradient(135deg, #4CAF50, #45a049); color: white; padding: 20px; border-radius: 15px; margin: 20px 0; font-family: 'Courier New', monospace; text-align: center; word-break: break-all; }
        .features { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; margin: 40px 0; }
        .feature-card { background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); border-radius: 15px; padding: 25px; border: 1px solid rgba(255,255,255,0.2); }
        .setup-section { background: rgba(255,255,255,0.05); border-radius: 15px; padding: 25px; margin: 30px 0; }
        .setup-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-top: 20px; }
        .setup-item { background: rgba(255,255,255,0.1); padding: 15px; border-radius: 10px; }
        .btn { background: rgba(255,255,255,0.2); color: white; padding: 12px 20px; text-decoration: none; border-radius: 20px; margin: 8px; display: inline-block; transition: all 0.3s; }
        .btn:hover { background: rgba(255,255,255,0.3); transform: translateY(-2px); }
        code { background: rgba(0,0,0,0.3); padding: 4px 8px; border-radius: 5px; font-family: 'Courier New', monospace; }
    </style>
</head>
<body>
    <div class="container">
        <div class="hero"><h1>🛡️ Iran Smart Proxy</h1><p>نسخه سازگار با تمام مرورگرها و دستگاه‌ها</p></div>
        <div class="status">✅ <strong>سازگار با تمام مرورگرها!</strong><br>پشتیبانی کامل از Firefox, Chrome, Edge و Android</div>
        <div class="endpoint">🌐 DNS Endpoint: <code>https://${hostname}/dns-query</code></div>
        <div class="features">
            <div class="feature-card"><h3>🧠 DNS هوشمند</h3><p>تشخیص خودکار و مسیریابی هوشمند برای ${BLOCKED_SITES.length} سایت مسدود شده.</p></div>
            <div class="feature-card"><h3>🎮 بهینه‌سازی بازی</h3><p>تشخیص خودکار ${GAMING_DOMAINS.length} دامنه مرتبط با بازی برای بهبود پینگ و اتصال.</p></div>
            <div class="feature-card"><h3>🌐 پراکسی وب</h3><p>دسترسی مستقیم به سایت‌ها از طریق یک رابط وب ساده و سریع.</p></div>
        </div>
        <div class="setup-section">
            <h2>📱 راهنمای تنظیمات</h2>
            <div class="setup-grid">
                <div class="setup-item"><h4>🦊 Firefox</h4><p>به <code>about:preferences#privacy</code> رفته و در بخش DNS over HTTPS آدرس را به صورت Custom وارد کنید.</p></div>
                <div class="setup-item"><h4>🔵 Chrome/Edge</h4><p>به <code>chrome://settings/security</code> رفته و در بخش Use secure DNS آدرس را به صورت Custom وارد کنید.</p></div>
                <div class="setup-item"><h4>📱 Android 9+</h4><p>در تنظیمات Private DNS (در بخش Network & internet) آدرس <code>${hostname}</code> را وارد کنید.</p></div>
            </div>
        </div>
        <div style="text-align:center; margin: 20px 0;">
            <a href="/proxy?url=https://www.wikipedia.org" class="btn">🌐 مرورگر وب (مثال)</a>
            <a href="/status" class="btn">📊 وضعیت سرویس</a>
        </div>
        <footer style="text-align: center; margin-top: 40px; opacity: 0.8; font-size: 0.9em;"><p>🛡️ سازگار با همه مرورگرها | ⚡ سرعت بالا | 🔒 امن</p></footer>
    </div>
</body>
</html>`;
}
