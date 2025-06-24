// server.js (phiên bản cuối cùng, tích hợp Rule Generator trên trang Docs)

require('dotenv').config();

const express = require('express');
const puppeteer = require('puppeteer-extra');
// ... (các import khác giữ nguyên)
// #region (Phần import không đổi)
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const cheerio = require('cheerio');
const url = require('url');
const { SocksProxyAgent } = require('socks-proxy-agent');
const FormData = require('form-data');
puppeteer.use(StealthPlugin());
// #endregion

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// --- TOÀN BỘ LOGIC SERVER GIỮ NGUYÊN ---
// #region (Toàn bộ logic server không đổi)
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
// #endregion

// --- TRANG TÀI LIỆU HƯỚNG DẪN (Tích hợp công cụ tạo Rule) ---
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
        input[type="text"] { width: 100%; padding: 8px; margin-bottom: 10px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box;}
        button { background-color: #28a745; color: white; padding: 8px 15px; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;}
        button:hover { background-color: #218838; }
    </style>
</head>
<body>
    <h1>Tài Liệu API - M3U8 Scraper</h1>
    <p>API cào dữ liệu link M3U8 mạnh mẽ, hỗ trợ proxy, rule động, xác thực và tự động xử lý blob URL.</p>

    <h2>Công Cụ Tạo Rule Nhanh</h2>
    <div class="endpoint">
        <p>Dán một URL M3U8 mẫu vào đây để tạo nhanh các quy tắc cho file <code>rules.txt</code> của bạn.</p>
        <input type="text" id="url-input" placeholder="Dán URL M3U8 mẫu vào đây...">
        <button id="generate-button">Tạo Rule</button>
        <h3>Kết quả:</h3>
        <pre><code id="output-rules"># Dán URL vào ô trên và nhấn nút...</code></pre>
    </div>

    <h2>Xác Thực</h2>
    <div class="endpoint">
        <p>Mọi yêu cầu đến <code>/api/scrape</code> đều phải được xác thực bằng cách thêm tham số <code>key=YOUR_API_KEY</code> vào query string.</p>
    </div>
    
    <h2>Cấu Hình Server (qua <code>.env</code> file)</h2>
    <div class="endpoint">
        <p><strong>Proxy:</strong> <code>P_IP</code>, <code>P_PORT</code>, etc. | <strong>Rule Động:</strong> <code>RULE_URL</code>, <code>RULE_UPDATE_INTERVAL</code></p>
    </div>

    <h2>Cách Viết Rule (trong file <code>rules.txt</code>)</h2>
    <div class="endpoint">
        <h3>1. Dạng Wildcard (Mặc định, đơn giản)</h3>
        <p>Sử dụng dấu <code>*</code> để thay thế cho một chuỗi ký tự bất kỳ.</p>
        <pre><code>https://*.domain.com/path/*</code></pre>
        <h3>2. Dạng Regex (Nâng cao)</h3>
        <p>Thêm tiền tố <code>regex:</code> vào đầu dòng để sử dụng sức mạnh của Regular Expression.</p>
        <pre><code>regex:/live/\\d+/stream\\.m3u8</code></pre>
    </div>

    <h2><span class="badge badge-get">GET</span> /api/scrape</h2>
    <div class="endpoint">
        <h3>Mô tả</h3><p>Dùng cho các yêu cầu nhanh, đơn giản.</p>
        <h3>Ví dụ</h3><pre><code>curl "http://localhost:3000/api/scrape?url=...&key=..."</code></pre>
    </div>
    <h2><span class="badge badge-post">POST</span> /api/scrape</h2>
    <div class="endpoint">
        <h3>Mô tả</h3><p>Dùng cho các yêu cầu phức tạp cần gửi kèm bộ header tùy chỉnh.</p>
        <h3>Ví dụ</h3><pre><code>curl -X POST "http://localhost:3000/api/scrape?key=..." \\
-H "Content-Type: application/json" \\
-d '{"url": "...", "headers": {"Referer": "..."}}'</code></pre>
    </div>

    <script>
        document.getElementById('generate-button').addEventListener('click', () => {
            const urlInput = document.getElementById('url-input');
            const outputRules = document.getElementById('output-rules');
            const urlString = urlInput.value.trim();

            if (!urlString) {
                outputRules.textContent = '# Vui lòng nhập một URL.';
                return;
            }

            try {
                const url = new URL(urlString);
                
                // 1. Tạo rule Wildcard
                // Lấy hostname và pathname, thay thế subdomain và query bằng *
                const wildcardPath = url.pathname.substring(0, url.pathname.lastIndexOf('/') + 1) + '*';
                const wildcardRule = `https://*.${url.hostname.split('.').slice(1).join('.')}*${wildcardPath}`;


                // 2. Tạo rule Regex
                // Escape các ký tự đặc biệt trong toàn bộ URL để tạo rule chính xác
                const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\\\$&');
                const regexRule = `regex:${escapeRegex(urlString)}`;

                const outputText = \`# Dưới đây là các rule được tạo ra từ URL của bạn.
# Bạn có thể chọn một trong hai và dán vào file rules.txt

# --- QUY TẮC WILDCARD (Đề nghị cho trường hợp chung) ---
# Quy tắc này sẽ bắt các link có cùng domain và cùng cấu trúc thư mục.
${wildcardRule}

# --- QUY TẮC REGEX (Bắt chính xác URL này) ---
# Dùng quy tắc này nếu bạn chỉ muốn bắt chính xác URL đã cung cấp.
${regexRule}
\`;
                outputRules.textContent = outputText;

            } catch (e) {
                outputRules.textContent = '# URL không hợp lệ. Vui lòng kiểm tra lại.';
            }
        });
    </script>
</body>
</html>
`;

// --- START SERVER ---
const startServer = async () => { /* giữ nguyên */ };
// #region (Hàm startServer không đổi)
const startServer = async () => {
    await updateDetectionRules();
    const updateIntervalMinutes = parseInt(process.env.RULE_UPDATE_INTERVAL, 10) || 60;
    setInterval(updateDetectionRules, updateIntervalMinutes * 60 * 1000);
    console.log(`[RULE MANAGER] Đã lên lịch tự động cập nhật rule mỗi ${updateIntervalMinutes} phút.`);

    app.get('/docs', (req, res) => res.setHeader('Content-Type', 'text/html').send(docsHtml));
    app.get('/', (req, res) => res.redirect('/docs'));

    app.listen(PORT, () => {
        console.log(`Server hoàn thiện đang chạy tại http://localhost:${PORT}`);
    });
};

startServer();
// #endregion
