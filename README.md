# 🛡️ Ultimate Iran Proxy - Pages

کامل‌ترین سیستم دسترسی آزاد به اینترنت با Cloudflare Pages Functions

## 📋 فهرست مطالب

- [ویژگی‌ها](#ویژگی‌ها)
- [نصب و راه‌اندازی](#نصب-و-راه‌اندازی)  
- [تنظیمات مرورگر](#تنظیمات-مرورگر)
- [API مستندات](#api-مستندات)
- [عملکرد و بهینه‌سازی](#عملکرد-و-بهینه‌سازی)
- [پشتیبانی](#پشتیبانی)

## 🚀 ویژگی‌ها

### Smart DNS Intelligence
- تشخیص خودکار نوع سایت (ایرانی، مسدود، gaming، بین‌المللی)
- مسیریابی هوشمند بر اساس محتوا
- کش بهینه با TTL متغیر
- Fallback خودکار به DNS providers دیگر

### Geographic Routing  
- مسیریابی از طریق 10 edge location جهانی Cloudflare
- بهینه‌سازی ECS برای هر منطقه
- سایت‌های ایرانی: مسیر مستقیم
- سایت‌های مسدود: عبور از edge خارجی

### Gaming Optimization
- کاهش ping تا 50ms برای gaming
- انتخاب نزدیک‌ترین game servers
- پشتیبانی از Steam، Riot Games، Epic Games
- بهینه‌سازی real-time برای کاربران ایرانی

### HTTP Proxy
- دسترسی مستقیم به سایت‌های مسدود
- رابط مرورگر وب کامل
- اصلاح خودکار HTML/CSS/JS
- پشتیبانی از mobile و desktop

### Browser Compatibility
- DNS Wire Format کامل
- JSON API سازگار با RFC 8484
- Base64 encoded queries
- پشتیبانی از تمام DoH clients

## 📁 ساختار پروژه

```
doh-proxy-iran-pages/
├── functions/
│   └── _middleware.js    # کد اصلی Pages Functions
├── index.html           # صفحه اصلی
├── browse.html          # Web Browser Interface
└── README.md            # این فایل
```

## ⚙️ نصب و راه‌اندازی

### 1. Fork Repository
```bash
# کلون repository
git clone https://github.com/feizezadeh/doh-proxy-iran-pages.git
cd doh-proxy-iran-pages
```

### 2. Deploy در Cloudflare Pages
1. وارد [Cloudflare Dashboard](https://dash.cloudflare.com) شوید
2. **Workers & Pages** → **Create Application** → **Pages**
3. **Connect to Git** → انتخاب repository
4. تنظیمات Build:
   - Build command: (خالی)
   - Build output directory: `/`
   - Root directory: `/`
5. **Save and Deploy**

### 3. Domain سفارشی (اختیاری)
- **Custom domains** → **Set up a custom domain**
- DNS record اضافه کنید: `CNAME your-domain.com your-project.pages.dev`

## 🔧 تنظیمات مرورگر

### Firefox
```
1. about:config
2. network.trr.mode = 2
3. network.trr.uri = https://your-domain.pages.dev/dns-query
4. Restart Firefox
```

### Chrome/Edge
```
1. Settings → Privacy and Security → Security
2. Use secure DNS → Custom
3. https://your-domain.pages.dev/dns-query
4. Restart Browser
```

### Android

#### روش 1: Intra App
```
1. نصب Intra از Google Play Store
2. Custom DNS over HTTPS
3. https://your-domain.pages.dev/dns-query
4. Turn On
```

#### روش 2: 1.1.1.1 App
```
1. نصب 1.1.1.1 از Google Play Store  
2. Advanced → Connection options → DNS over HTTPS
3. Custom → https://your-domain.pages.dev/dns-query
```

### iOS
```
1. نصب DNSCloak یا 1.1.1.1
2. DNS over HTTPS
3. https://your-domain.pages.dev/dns-query
```

## 📚 API مستندات

### Base URL
```
https://your-domain.pages.dev
```

### DNS Query API

#### Basic Query
```http
GET /dns-query?name=example.com&type=A
```

#### با پارامترهای اضافی
```http
GET /dns-query?name=steam.com&type=A&gaming=true
GET /dns-query?name=twitter.com&type=A&geo=abroad
GET /dns-query?name=site.com&format=simple
```

#### Wire Format (POST)
```http
POST /dns-query
Content-Type: application/dns-message
Accept: application/dns-message

[DNS wire format data]
```

### HTTP Proxy API

#### Basic Proxy
```http
GET /proxy?url=https://github.com
```

#### Direct URL
```http
GET /p/https://twitter.com
```

### System APIs

#### Status Check  
```http
GET /status
```

#### Geographic Info
```http
GET /geo-status
```

#### Speed Test
```http
GET /speed-test
```

#### Gaming Servers
```http
GET /game-servers?game=steam
```

#### Ping Test
```http
GET /ping-test?target=google.com
```

#### Configuration
```http
GET /config
```

## 🎯 نمونه‌های کاربردی

### DNS Queries
```bash
# تست basic
curl "https://your-domain.pages.dev/dns-query?name=google.com"

# gaming mode
curl "https://your-domain.pages.dev/dns-query?name=steampowered.com&gaming=true"

# forced geographic routing
curl "https://your-domain.pages.dev/dns-query?name=twitter.com&geo=abroad"
```

### HTTP Proxy
```bash
# دسترسی به GitHub
curl "https://your-domain.pages.dev/proxy?url=https://github.com"

# دسترسی به Twitter
curl "https://your-domain.pages.dev/p/https://twitter.com"
```

### System Status
```bash
# وضعیت سیستم
curl "https://your-domain.pages.dev/status"

# اطلاعات جغرافیایی
curl "https://your-domain.pages.dev/geo-status"
```

## 📊 عملکرد و بهینه‌سازی

### آمار عملکرد
- **DNS Latency**: 2-50ms معمولی
- **Proxy Overhead**: 10-30ms اضافی
- **Gaming Improvement**: 15-50ms کاهش ping
- **Cache Hit Ratio**: 80-95% معمولی
- **Uptime Target**: 99.9%

### بهینه‌سازی‌ها
- ECS-based geographic optimization
- Intelligent TTL بر اساس نوع محتوا
- Multi-provider DNS fallback
- Cloudflare edge caching
- Smart routing algorithms

### محدودیت‌ها
- Cloudflare Pages: 100,000 requests/day (رایگان)
- Function execution: 10ms CPU time/request
- Memory: 128MB per function
- Response size: 25MB maximum

## 🛠️ توسعه و سفارشی‌سازی

### اضافه کردن سایت جدید

#### سایت مسدود
```javascript
// در functions/_middleware.js
const BLOCKED_SITES = [
  // ... سایت‌های موجود
  'new-blocked-site.com'
]
```

#### سایت ایرانی
```javascript
const IRANIAN_SITES = [
  // ... سایت‌های موجود  
  'new-iranian-site.ir'
]
```

#### دامنه Gaming
```javascript
const GAMING_DOMAINS = [
  // ... دامنه‌های موجود
  'new-game-platform.com'
]
```

### تنظیم Gaming Servers
```javascript
const GAMING_SERVERS = {
  'new-platform': {
    regions: [
      { 
        name: 'Dubai', 
        ip: '1.2.3.4', 
        ping_estimate: 40, 
        best_for_iran: true 
      }
    ]
  }
}
```

### تغییر Edge Locations
```javascript
const NON_IRAN_EDGES = [
  'DXB', 'IST', 'FRA', // ... edge locations
  'NEW'  // اضافه کردن edge جدید
]
```

## 🔍 عیب‌یابی

### مشکلات متداول

#### DNS کار نمی‌کند
```bash
# تست manual
curl "https://your-domain.pages.dev/dns-query?name=google.com"

# بررسی status
curl "https://your-domain.pages.dev/status"
```

#### Proxy خطا می‌دهد
- بررسی کنید URL مجاز باشد
- فقط سایت‌های HTTPS پشتیبانی می‌شوند
- برخی سایت‌ها frame blocking دارند

#### عملکرد کند
- کش مرورگر را پاک کنید
- از mode خصوصی استفاده کنید
- تست کنید: `/speed-test`

### Debug Mode
```javascript
// در console مرورگر
console.log('Ultimate Proxy Debug Mode');

// تست DNS
fetch('/dns-query?name=google.com')
  .then(r => r.json())
  .then(console.log);

// تست Geo Status  
fetch('/geo-status')
  .then(r => r.json())
  .then(console.log);
```

## 📈 مانیتورینگ

### Cloudflare Analytics
- **Workers & Pages** → **Analytics**
- نمایش requests، errors، latency
- Usage patterns و geographic data

### Custom Monitoring
```bash
# Status check script
#!/bin/bash
response=$(curl -s "https://your-domain.pages.dev/status")
if [[ $response == *"operational"* ]]; then
    echo "✅ System OK"
else
    echo "❌ System Down"
fi
```

## 🔐 امنیت

### Best Practices
- همیشه از HTTPS استفاده کنید
- Browser cache منظم پاک کنید
- از DNS leak test استفاده کنید
- ترافیک خود را monitor کنید

### Privacy
- No logging policy
- تمام traffic رمزگذاری شده
- Geographic routing برای privacy
- Open source و قابل بررسی

## 🤝 مشارکت

### Issues
- Bug reports در GitHub Issues
- Feature requests خوشآمد
- Security issues: ایمیل مستقیم

### Pull Requests
1. Fork repository
2. ایجاد feature branch
3. Commit با پیام واضح
4. ایجاد Pull Request

### Development Setup
```bash
# Clone
git clone https://github.com/feizezadeh/doh-proxy-iran-pages.git

# Local development
npx wrangler pages dev

# Testing
curl "http://localhost:8788/dns-query?name=google.com"
```

## 📄 لیسنس

MIT License - استفاده آزاد برای تمام اهداف

## 🔗 لینک‌های مفید

- [Cloudflare Pages Docs](https://developers.cloudflare.com/pages/)
- [DNS over HTTPS RFC](https://tools.ietf.org/html/rfc8484)
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)

## 📞 پشتیبانی

- **GitHub Issues**: برای bugs و feature requests
- **Documentation**: این README و comments در کد
- **Community**: GitHub Discussions

---

**ساخته شده با ❤️ برای کاربران ایرانی**

*Ultimate Iran Proxy - دسترسی آزاد، امن و سریع به اینترنت جهانی*