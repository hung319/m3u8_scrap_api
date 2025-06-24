// server.js (Phiên bản "Regex-Only" & "No-Data-URI")

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

// --- HỆ THỐNG QUẢN LÝ RULE (Đã tinh gọn) ---
// Rule mặc định giờ chỉ còn kiểm tra Content-Type
const defaultRules = [/application\/(vnd\.apple\.mpegurl|x-mpegurl)/i];
let detectionRules = [...defaultRules];

const updateDetectionRules = async () => {
    if (!RULE_URL) {
        console.log('[RULE MANAGER] Không có RULE_URL. Chỉ sử dụng rule mặc định.');
        detectionRules = [...defaultRules];
        return;
    }
    console.log(`[RULE MANAGER] Đang cập nhật rule từ: ${RULE_URL}`);
    try {
        const { data } = await axios.get(RULE_URL);
        // THAY ĐỔI: Chỉ xử lý các dòng có tiền tố "regex:"
        const remoteRules = data.split('\n').map(l => l.trim()).filter(l => l.toLowerCase().startsWith('regex:')).map(l => {
            try {
                // Lấy phần nội dung sau tiền tố "regex:"
                return new RegExp(l.substring(6).trim(), 'i');
            } catch (e) {
                console.error(`[RULE MANAGER] Lỗi cú pháp regex: "${l}". Bỏ qua.`);
                return null;
            }
        }).filter(Boolean);
        
        detectionRules = [...defaultRules, ...remoteRules];
        console.log(`[RULE MANAGER] Cập nhật thành công! Tổng số rule đang hoạt động: ${detectionRules.length}`);
        
    } catch (error) {
        console.error(`[RULE MANAGER] Lỗi khi tải file rule: ${error.message}`);
    }
};

// --- CÁC HÀM HELPER VÀ LÕI ---
const apiKeyMiddleware = (req, res, next) => { /* giữ nguyên */ };
async function uploadToDpaste(content) { /* giữ nguyên */ }
// #region (Các hàm helper không đổi)
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
// #endregion

const handleResponse = async (response, foundLinks) => {
    const requestUrl = response.url();

    // THAY ĐỔI: Tự động lọc bỏ data: URI ngay từ đầu
    if (requestUrl.startsWith('data:')) {
        console.log(`[FILTER] Bỏ qua link data URI.`);
        return;
    }

    const contentType = response.headers()['content-type'] || '';
    const isMatchByRule = detectionRules.some(rule => rule.test(requestUrl) || rule.test(contentType));

    if (isMatchByRule && !requestUrl.endsWith('.ts')) {
        console.log(`[+] Đã bắt được link M3U8 (khớp với Rule): ${requestUrl}`);
        foundLinks.add(requestUrl);
        return;
    }

    const request = response.request();
    if (['xhr', 'fetch'].includes(request.resourceType())) {
        try {
            const textContent = await response.text();
            if (textContent && textContent.trim().startsWith('#EXTM3U')) {
                console.log(`[+] Đã bắt được M3U8 từ NỘI DUNG của request: ${requestUrl}`);
                const rawLink = await uploadToDpaste(textContent);
                if (rawLink) foundLinks.add(rawLink);
            }
        } catch (e) {}
    }
};

async function findM3u8LinksWithPuppeteer(targetUrl, customHeaders = {}) { /* giữ nguyên */ }
// #region (Hàm puppeteer không đổi)
async function findM3u8LinksWithPuppeteer(targetUrl, customHeaders = {}) {
    console.log(`[PUPPETEER] Bắt đầu phiên làm việc cho: ${targetUrl}`);
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
        console.log('[PUPPETEER] Trang đã tải xong, đang tương tác và quét blob...');
        try {
            const videoElement = await page.waitForSelector('video', { timeout: 5000 });
            if (videoElement) await videoElement.click();
        } catch (e) {
            try {
                const playButton = await page.waitForSelector('[class*="play"], [aria-label*="Play"], [aria-label*="Phát"]', { timeout: 3000 });
                if (playButton) await playButton.click();
            } catch (e2) {}
        }
        await new Promise(resolve => setTimeout(resolve, 5000));
        const blobUrls = await page.$$eval('video, audio', els => els.map(el => el.src).filter(src => src && src.startsWith('blob:')));
        for (const blobUrl of blobUrls) {
            const m3u8Content = await page.evaluate(async (bUrl) => { try { return await (await fetch(bUrl)).text(); } catch (e) { return null; } }, blobUrl);
            if (m3u8Content && m3u8Content.trim().includes('#EXTM3U')) {
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
// #endregion

async function handleScrapeRequest(targetUrl, headers, hasJs) { /* giữ nguyên */ }
// #region (Hàm handleScrapeRequest không đổi)
async function handleScrapeRequest(targetUrl, headers, hasJs) {
    return await findM3u8LinksWithPuppeteer(targetUrl, headers);
}
// #endregion

const handleApiResponse = (res, links, url) => { /* giữ nguyên */ };
// #region (Hàm handleApiResponse không đổi)
const handleApiResponse = (res, links, url) => {
    if (links.length > 0) res.json({ success: true, count: links.length, source: url, links });
    else res.json({ success: false, message: 'Không tìm thấy link M3U8 nào.', source: url, links: [] });
};
// #endregion

// --- API ENDPOINTS (Không thay đổi) ---
// #region (Các route không đổi)
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

// --- DOCS & START SERVER ---
const docsHtml = `<!DOCTYPE html><html lang="vi"><head><title>API Docs - M3U8 Scraper</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:20px;max-width:900px;margin:0 auto;color:#333}h1,h2,h3{color:#111;border-bottom:1px solid #ddd;padding-bottom:10px;margin-top:30px}code{background-color:#f4f4f4;padding:2px 6px;border-radius:4px;font-family:"Courier New",Courier,monospace;color:#c7254e}pre{background-color:#f6f8fa;padding:15px;border-radius:5px;white-space:pre-wrap;word-wrap:break-word;border:1px solid #ddd}a{color:#0366d6;text-decoration:none}a:hover{text-decoration:underline}.endpoint{border:1px solid #eee;padding:0 20px 15px;border-radius:8px;margin-bottom:20px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.05)}li{margin-bottom:10px}</style></head><body><h1>Tài Liệu API - M3U8 Scraper</h1><p>API cào dữ liệu link M3U8 với hệ thống proxy, rule động (chỉ Regex), xác thực và tự động xử lý blob URL.</p><h2>Cách Viết Rule (trong file <code>rules.txt</code>)</h2><div class="endpoint"><h3>Chỉ Hỗ Trợ Regex</h3><p>Hệ thống đã được tinh gọn, chỉ chấp nhận các quy tắc có tiền tố <code>regex:</code>.</p><pre><code># Bắt các link kết thúc bằng .m3u8 hoặc .m3u
regex:\\.m3u8?(\\?|$)

# Bắt các link từ domain master-lengs.org
regex:https?:\\/\\/master-lengs\\.org\\/api\\/v3\\/hh\\/.*?\\/master\\.m3u8\\?.*
</code></pre></div><h2>Endpoints</h2><p>Sử dụng <code>GET</code> hoặc <code>POST</code> đến <code>/api/scrape</code> với tham số <code>?key=YOUR_API_KEY</code>.</p></body></html>`;

const startServer = async () => { /* giữ nguyên */ };
// #region (Hàm startServer không đổi)
const startServer = async () => {
    await updateDetectionRules();
    const updateIntervalMinutes = parseInt(RULE_UPDATE_INTERVAL, 10) || 60;
    setInterval(updateDetectionRules, updateIntervalMinutes * 60 * 1000);
    console.log(`[RULE MANAGER] Đã lên lịch tự động cập nhật rule mỗi ${updateIntervalMinutes} phút.`);

    app.get('/docs', (req, res) => res.setHeader('Content-Type', 'text/html').send(docsHtml));
    app.get('/', (req, res) => res.redirect('/docs'));

    app.listen(PORT, () => {
        console.log(`Server "Regex-Only" đang chạy tại http://localhost:${PORT}`);
    });
};

startServer();
// #endregion
