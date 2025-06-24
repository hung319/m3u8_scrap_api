// server.js (Phiên bản ổn định, đã loại bỏ phần script gây lỗi trên trang Docs)

require('dotenv').config();

const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const cheerio = require('cheerio');
const url = require('url');
const { SocksProxyAgent } = require('socks-proxy-agent');
const FormData = require('form-data');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// --- CẤU HÌNH SERVER VÀ CÁC BIẾN TOÀN CỤC ---
const { API_KEY, P_IP, P_PORT, P_USER, P_PASSWORD, RULE_URL, RULE_UPDATE_INTERVAL } = process.env;
let globalProxyUrl = null;
if (P_IP && P_PORT) {
    const authPart = (P_USER && P_PASSWORD) ? `${P_USER}:${P_PASSWORD}@` : '';
    globalProxyUrl = `socks5://${authPart}${P_IP}:${P_PORT}`;
    console.log(`[ENV CONFIG] Đã cấu hình proxy toàn cục: ${globalProxyUrl}`);
} else {
    console.log('[ENV CONFIG] Không có cấu hình proxy toàn cục.');
}
if (!API_KEY) {
    console.warn('[SECURITY WARNING] API_KEY chưa được thiết lập! API sẽ không thể truy cập.');
}

// --- HỆ THỐNG QUẢN LÝ RULE ---
const wildcardToRegex = (pattern) => {
    const escapedPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const regexString = escapedPattern.replace(/\*/g, '.*');
    return new RegExp(`^${regexString}$`, 'i');
};
const defaultRules = [wildcardToRegex('*.m3u8'), wildcardToRegex('*.m3u'), /application\/(vnd\.apple\.mpegurl|x-mpegurl)/i];
let detectionRules = [...defaultRules];
const updateDetectionRules = async () => {
    if (!RULE_URL) return console.log('[RULE MANAGER] Không có RULE_URL. Sử dụng rule mặc định.');
    console.log(`[RULE MANAGER] Đang cập nhật rule từ: ${RULE_URL}`);
    try {
        const { data } = await axios.get(RULE_URL);
        const remoteRules = data.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => {
            try {
                return l.toLowerCase().startsWith('regex:') ? new RegExp(l.substring(6).trim(), 'i') : wildcardToRegex(l);
            } catch (e) {
                console.error(`[RULE MANAGER] Lỗi cú pháp rule: "${l}". Bỏ qua.`);
                return null;
            }
        }).filter(Boolean);
        if (remoteRules.length > 0) {
            detectionRules = [...defaultRules, ...remoteRules];
            console.log(`[RULE MANAGER] Cập nhật thành công! Tổng số rule: ${detectionRules.length}`);
        }
    } catch (error) {
        console.error(`[RULE MANAGER] Lỗi khi tải file rule: ${error.message}`);
    }
};

// --- CÁC HÀM HELPER VÀ LÕI ---
const apiKeyMiddleware = (req, res, next) => {
    if (!API_KEY) return res.status(503).json({ success: false, message: 'Dịch vụ không được cấu hình.' });
    if (req.query.key === API_KEY) return next();
    res.status(401).json({ success: false, message: 'Unauthorized: API Key không hợp lệ hoặc bị thiếu.' });
};
async function uploadToDpaste(content) {
    try {
        const form = new FormData();
        form.append('content', content);
        form.append('syntax', 'text');
        form.append('expiry_days', '1');
        const { data } = await axios.post('https://dpaste.org/api/', form, { headers: { ...form.getHeaders() } });
        return `${data.trim()}/raw`;
    } catch (error) {
        console.error('[DPASTE] Lỗi khi tải lên:', error.message);
        return null;
    }
}
const handleResponse = (response, foundLinks) => {
    const requestUrl = response.url();
    const contentType = response.headers()['content-type'] || '';
    const isMatch = detectionRules.some(rule => rule.test(requestUrl) || rule.test(contentType));
    if (isMatch && !requestUrl.endsWith('.ts')) {
        console.log(`[+] Đã bắt được link M3U8 (khớp với rule): ${requestUrl}`);
        foundLinks.add(requestUrl);
    }
};
async function findM3u8LinksWithPuppeteer(targetUrl, customHeaders = {}) {
    const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
    if (globalProxyUrl) launchArgs.push(`--proxy-server=${globalProxyUrl}`);
    const foundLinks = new Set();
    let browser = null;
    try {
        browser = await puppeteer.launch({ headless: "new", args: launchArgs, executablePath: '/usr/bin/chromium' });
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on('request', r => ['image', 'stylesheet', 'font'].includes(r.resourceType()) ? r.abort() : r.continue());
        if (Object.keys(customHeaders).length > 0) await page.setExtraHTTPHeaders(customHeaders);
        page.on('response', r => handleResponse(r, foundLinks));
        page.on('framecreated', async f => f.on('response', r => handleResponse(r, foundLinks)));
        await page.goto(targetUrl, { waitUntil: 'networkidle0', timeout: 60000 });
        await new Promise(resolve => setTimeout(resolve, 5000));
        const mediaSrcs = await page.$$eval('video, audio', els => els.map(el => el.src).filter(src => src && src.startsWith('blob:')));
        for (const blobUrl of blobUrls) {
            const m3u8Content = await page.evaluate(async (bUrl) => {
                try { return await (await fetch(bUrl)).text(); } catch (e) { return null; }
            }, blobUrl);
            if (m3u8Content && m3u8Content.includes('#EXTM3U')) {
                const rawLink = await uploadToDpaste(m3u8Content);
                if (rawLink) foundLinks.add(rawLink);
            }
        }
        return Array.from(foundLinks);
    } catch (error) {
        console.error(`[PUPPETEER] Lỗi:`, error.message);
        return [];
    } finally {
        if (browser) await browser.close();
    }
}
async function handleScrapeRequest(targetUrl, headers, hasJs) {
    return await findM3u8LinksWithPuppeteer(targetUrl, headers);
}
const handleApiResponse = (res, links, url) => {
    if (links.length > 0) res.json({ success: true, count: links.length, source: url, links });
    else res.json({ success: false, message: 'Không tìm thấy link M3U8 nào.', source: url, links: [] });
};

// --- API ENDPOINTS ---
app.post('/api/scrape', apiKeyMiddleware, async (req, res) => {
    const { url, headers = {}, hasJs = true } = req.body;
    if (!url) return res.status(400).json({ success: false, message: 'Vui lòng cung cấp "url".' });
    const links = await handleScrapeRequest(url, headers, hasJs);
    handleApiResponse(res, links, url);
});
app.get('/api/scrape', apiKeyMiddleware, async (req, res) => {
    const { url, hasJs, referer } = req.query;
    if (!url) return res.status(400).json({ success: false, message: 'Vui lòng cung cấp tham số "url".' });
    const headers = referer ? { Referer: referer } : {};
    const links = await handleScrapeRequest(url, headers, hasJs !== 'false');
    handleApiResponse(res, links, url);
});

// --- TRANG TÀI LIỆU HƯỚNG DẪN (Phiên bản tĩnh, ổn định) ---
const docsHtml = `
<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>API Docs - M3U8 Scraper</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; padding: 20px; max-width: 900px; margin: 0 auto; color: #333; }
        h1, h2, h3 { color: #111; border-bottom: 1px solid #ddd; padding-bottom: 10px; margin-top: 30px;}
        code { background-color: #f4f4f4; padding: 2px 6px; border-radius: 4px; font-family: "Courier New", Courier, monospace; color: #c7254e; }
        pre { background-color: #f6f8fa; padding: 15px; border-radius: 5px; white-space: pre-wrap; word-wrap: break-word; border: 1px solid #ddd; }
        a { color: #0366d6; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .endpoint { border: 1px solid #eee; padding: 0 20px 15px; border-radius: 8px; margin-bottom: 20px; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        li { margin-bottom: 10px; }
        .badge { color:white; padding: 3px 8px; border-radius: 12px; font-size: .8em; font-weight:700; margin-right:8px;}
        .badge-post { background-color: #28a745; }
        .badge-get { background-color: #007bff; }
    </style>
</head>
<body>
    <h1>Tài Liệu API - M3U8 Scraper</h1>
    <p>API cào dữ liệu link M3U8 mạnh mẽ, hỗ trợ proxy, rule động, xác thực và tự động xử lý blob URL.</p>

    <h2>Xác Thực</h2>
    <div class="endpoint">
        <p>Mọi yêu cầu đến <code>/api/scrape</code> đều phải được xác thực bằng cách thêm tham số <code>key=YOUR_API_KEY</code> vào query string.</p>
    </div>
    
    <h2>Cấu Hình Server (qua <code>.env</code> file)</h2>
    <div class="endpoint">
        <p><strong>Proxy:</strong> Thiết lập qua <code>P_IP</code>, <code>P_PORT</code>, etc. | <strong>Rule Động:</strong> Thiết lập qua <code>RULE_URL</code>, <code>RULE_UPDATE_INTERVAL</code>.</p>
    </div>

    <h2>Cách Viết Rule (trong file <code>rules.txt</code>)</h2>
    <div class="endpoint">
        <h3>1. Dạng Wildcard (Mặc định, đơn giản)</h3>
        <p>Sử dụng dấu <code>*</code> để thay thế cho một chuỗi ký tự bất kỳ. Server sẽ tự động chuyển nó thành Regex.</p>
        <pre><code># Ví dụ: Bắt tất cả link trong domain a.com có path /videos/
https://*.a.com/videos/*

# Ví dụ: Bắt tất cả link có chứa "playlist.m3u8"
*playlist.m3u8*</code></pre>
        <h3>2. Dạng Regex (Nâng cao)</h3>
        <p>Thêm tiền tố <code>regex:</code> vào đầu dòng để sử dụng sức mạnh của Regular Expression.</p>
        <pre><code># Ví dụ: Bắt các link kết thúc bằng .m3u8 hoặc .m3u
regex:\\.m3u8?(\\?|$)</code></pre>
    </div>
    
    <h2><span class="badge badge-get">GET</span> /api/scrape</h2>
    <div class="endpoint">
        <h3>Mô tả</h3><p>Dùng cho các yêu cầu nhanh, đơn giản.</p>
        <h3>Ví dụ</h3><pre><code>curl "http://localhost:3000/api/scrape?url=https://m3u8.h4rs.pp.ua&key=YOUR_API_KEY"</code></pre>
    </div>
    
    <h2><span class="badge badge-post">POST</span> /api/scrape</h2>
    <div class="endpoint">
        <h3>Mô tả</h3><p>Dùng cho các yêu cầu phức tạp cần gửi kèm bộ header tùy chỉnh.</p>
        <h3>Ví dụ</h3><pre><code>curl -X POST "http://localhost:3000/api/scrape?key=YOUR_API_KEY" \\
-H "Content-Type: application/json" \\
-d '{"url": "https://m3u8.h4rs.pp.ua", "headers": {"Referer": "https://google.com"}}'</code></pre>
    </div>
</body>
</html>
`;

// --- START SERVER ---
const startServer = async () => {
    await updateDetectionRules();
    const updateIntervalMinutes = parseInt(process.env.RULE_UPDATE_INTERVAL, 10) || 60;
    setInterval(updateDetectionRules, updateIntervalMinutes * 60 * 1000);
    console.log(`[RULE MANAGER] Đã lên lịch tự động cập nhật rule mỗi ${updateIntervalMinutes} phút.`);

    app.get('/docs', (req, res) => res.setHeader('Content-Type', 'text/html').send(docsHtml));
    app.get('/', (req, res) => res.redirect('/docs'));

    app.listen(PORT, () => {
        console.log(`Server ổn định đang chạy tại http://localhost:${PORT}`);
    });
};

startServer();
