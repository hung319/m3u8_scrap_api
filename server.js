// server.js (Phiên bản cuối cùng, tối ưu nhất, tích hợp mọi tính năng)

require('dotenv').config();

const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const url = require('url');
const { SocksProxyAgent } = require('socks-proxy-agent');
const FormData = require('form-data');

// Áp dụng plugin stealth cho Puppeteer
puppeteer.use(StealthPlugin());

// Khởi tạo Express
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

// --- Biến toàn cục cho trình duyệt và quản lý rule ---
let browserInstance = null;
let detectionRules = [/application\/(vnd\.apple\.mpegurl|x-mpegurl)/i];

// --- CÁC HÀM HELPER VÀ LÕI ---

const wildcardToRegex = (pattern) => {
    const escapedPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const regexString = escapedPattern.replace(/\*/g, '.*');
    return new RegExp(`^${regexString}$`, 'i');
};

const updateDetectionRules = async () => {
    // Rule mặc định sẽ luôn kiểm tra Content-Type
    const baseRules = [/application\/(vnd\.apple\.mpegurl|x-mpegurl)/i];
    if (!RULE_URL) {
        console.log('[RULE MANAGER] Không có RULE_URL. Chỉ sử dụng rule Content-Type mặc định.');
        detectionRules = baseRules;
        return;
    }
    console.log(`[RULE MANAGER] Đang cập nhật rule từ: ${RULE_URL}`);
    try {
        const { data } = await axios.get(RULE_URL);
        const remoteRules = data.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && l.toLowerCase().startsWith('regex:')).map(l => {
            try {
                return new RegExp(l.substring(6).trim(), 'i');
            } catch (e) {
                console.error(`[RULE MANAGER] Lỗi cú pháp rule: "${l}". Bỏ qua.`);
                return null;
            }
        }).filter(Boolean);
        
        detectionRules = [...baseRules, ...remoteRules];
        console.log(`[RULE MANAGER] Cập nhật thành công! Tổng số rule đang hoạt động: ${detectionRules.length}`);
        
    } catch (error) {
        console.error(`[RULE MANAGER] Lỗi khi tải file rule: ${error.message}`);
    }
};

const apiKeyMiddleware = (req, res, next) => {
    if (!API_KEY) {
        return res.status(503).json({ success: false, message: 'Dịch vụ không được cấu hình.' });
    }
    if (req.query.key && req.query.key === API_KEY) {
        return next();
    }
    res.status(401).json({ success: false, message: 'Unauthorized: API Key không hợp lệ hoặc bị thiếu.' });
};

async function uploadToDpaste(content) {
    try {
        const form = new FormData();
        form.append('content', content);
        form.append('syntax', 'text');
        form.append('expiry_days', '1');
        const { data } = await axios.post('https://dpaste.org/api/', form, { headers: { ...form.getHeaders() } });
        const dpasteUrl = data.trim();
        if (!dpasteUrl.startsWith('http')) throw new Error('Dpaste API did not return a valid URL.');
        const rawUrl = `${dpasteUrl}/raw`;
        console.log(`[DPASTE] Tải lên thành công! Link raw: ${rawUrl}`);
        return rawUrl;
    } catch (error) {
        console.error('[DPASTE] Lỗi khi tải lên:', error.message);
        return null;
    }
}

const handleResponse = (response, foundLinks) => {
    const requestUrl = response.url();
    if (requestUrl.startsWith('data:')) return; // Bỏ qua data URI
    
    const contentType = response.headers()['content-type'] || '';
    const isMatchByRule = detectionRules.some(rule => rule.test(requestUrl) || rule.test(contentType));

    if (isMatchByRule && !requestUrl.endsWith('.ts')) {
        console.log(`[+] Đã bắt được link M3U8 (khớp với Rule): ${requestUrl}`);
        foundLinks.add(requestUrl);
    }
};

// --- LOGIC SCRAPE CHÍNH ---
async function handleScrapeRequest(targetUrl, headers) {
    if (!browserInstance) {
        throw new Error("Trình duyệt chưa sẵn sàng. Vui lòng thử lại sau giây lát.");
    }
    
    let page = null;
    const foundLinks = new Set();
    // Dùng một Set riêng để theo dõi các blob đã được xử lý, tránh lặp lại công việc
    const processedBlobs = new Set();
    
    console.log(`[PAGE] Đang mở trang mới cho: ${targetUrl}`);
    
    try {
        page = await browserInstance.newPage();
        
        // --- CƠ CHẾ 1: CAN THIỆP URL.createObjectURL ---
        await page.exposeFunction('onBlobUrlCreated', async (blobUrl) => {
            if (blobUrl && blobUrl.startsWith('blob:') && !processedBlobs.has(blobUrl)) {
                processedBlobs.add(blobUrl); // Đánh dấu đã thấy blob này
                console.log(`[BLOB INTERCEPTOR] Bắt được blob URL được tạo: ${blobUrl}`);
                const m3u8Content = await page.evaluate(async (bUrl) => { try { return await (await fetch(bUrl)).text(); } catch (e) { return null; } }, blobUrl);
                if (m3u8Content && m3u8Content.trim().includes('#EXTM3U')) {
                    const rawLink = await uploadToDpaste(m3u8Content);
                    if (rawLink) foundLinks.add(rawLink);
                }
            }
        });
        await page.evaluateOnNewDocument(() => {
            const originalCreateObjectURL = URL.createObjectURL;
            URL.createObjectURL = function(...args) {
                const blobUrl = originalCreateObjectURL.apply(this, args);
                window.onBlobUrlCreated(blobUrl);
                return blobUrl;
            };
        });
        
        await page.setRequestInterception(true);
        page.on('request', r => ['image', 'stylesheet', 'font'].includes(r.resourceType()) ? r.abort() : r.continue());
        if (Object.keys(headers).length > 0) await page.setExtraHTTPHeaders(headers);
        
        page.on('response', r => handleResponse(r, foundLinks));
        page.on('framecreated', async f => f.on('response', r => handleResponse(r, foundLinks)));
        
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        if (foundLinks.size > 0) return Array.from(foundLinks);
        
        console.log('[INTERACTION] Trang đã tải, đang thử tương tác với video...');
        await page.evaluate(() => {
            const video = document.querySelector('video');
            const playButton = document.querySelector('[class*="play"], [aria-label*="Play"], [aria-label*="Phát"]');
            if (video) video.click();
            if (playButton) playButton.click();
        }).catch(() => {});

        await new Promise(resolve => setTimeout(resolve, 5000));
        if (foundLinks.size > 0) return Array.from(foundLinks);

        // --- CƠ CHẾ 2: QUÉT DOM CHỐT CHẶN (BAO GỒM IFRAME) ---
        console.log('[BLOB SCANNER] Quét DOM chốt chặn để tìm blob URL bị bỏ sót...');
        const allFrames = page.frames();
        for (const frame of allFrames) {
            if (frame.isDetached()) continue;
            try {
                const blobUrlsInFrame = await frame.$$eval('video, audio', els => els.map(el => el.src).filter(src => src && src.startsWith('blob:')));
                for (const blobUrl of blobUrlsInFrame) {
                    if (processedBlobs.has(blobUrl)) continue; // Bỏ qua nếu đã xử lý bằng interceptor
                    processedBlobs.add(blobUrl);
                    const m3u8Content = await frame.evaluate(async (bUrl) => { try { return await (await fetch(bUrl)).text(); } catch (e) { return null; } }, blobUrl);
                    if (m3u8Content && m3u8Content.trim().includes('#EXTM3U')) {
                        const rawLink = await uploadToDpaste(m3u8Content);
                        if (rawLink) foundLinks.add(rawLink);
                    }
                }
            } catch (error) {}
            if (foundLinks.size > 0) return Array.from(foundLinks);
        }
        
        return Array.from(foundLinks);
    } catch (error) {
        console.error(`[PAGE] Lỗi khi xử lý trang ${targetUrl}:`, error.message);
        return [];
    } finally {
        if (page) await page.close();
        console.log(`[PAGE] Đã đóng trang cho: ${targetUrl}`);
    }
}

// --- API ENDPOINTS ---
const handleApiResponse = (res, links, url) => {
    if (links.length > 0) {
        res.json({ success: true, count: links.length, source: url, links });
    } else {
        res.json({ success: false, message: 'Không tìm thấy link M3U8 nào.', source: url, links: [] });
    }
};

app.post('/api/scrape', apiKeyMiddleware, async (req, res) => {
    const { url, headers = {} } = req.body;
    if (!url) return res.status(400).json({ success: false, message: 'Vui lòng cung cấp "url".' });
    const links = await handleScrapeRequest(url, headers);
    handleApiResponse(res, links, url);
});

app.get('/api/scrape', apiKeyMiddleware, async (req, res) => {
    const { url, referer } = req.query;
    if (!url) return res.status(400).json({ success: false, message: 'Vui lòng cung cấp tham số "url".' });
    const headers = referer ? { Referer: referer } : {};
    const links = await handleScrapeRequest(url, headers);
    handleApiResponse(res, links, url);
});

// --- DOCS & START SERVER ---
const docsHtml = `<!DOCTYPE html><html lang="vi"><head><title>API Docs - M3U8 Scraper</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:20px;max-width:900px;margin:0 auto;color:#333}h1,h2,h3{color:#111;border-bottom:1px solid #ddd;padding-bottom:10px;margin-top:30px}code{background-color:#f4f4f4;padding:2px 6px;border-radius:4px;font-family:"Courier New",Courier,monospace;color:#c7254e}pre{background-color:#f6f8fa;padding:15px;border-radius:5px;white-space:pre-wrap;word-wrap:break-word;border:1px solid #ddd}a{color:#0366d6;text-decoration:none}a:hover{text-decoration:underline}.endpoint{border:1px solid #eee;padding:0 20px 15px;border-radius:8px;margin-bottom:20px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.05)}li{margin-bottom:10px}.badge{color:white;padding:3px 8px;border-radius:12px;font-size:.8em;font-weight:700;margin-right:8px}.badge-post{background-color:#28a745}.badge-get{background-color:#007bff}</style></head><body><h1>Tài Liệu API - M3U8 Scraper</h1><p>API cào dữ liệu link M3U8 với hệ thống proxy, rule động, xác thực và tự động xử lý blob URL.</p><h2>Xác Thực</h2><div class="endpoint"><p>Mọi yêu cầu đến <code>/api/scrape</code> đều phải được xác thực bằng cách thêm tham số <code>key=YOUR_API_KEY</code> vào query string.</p></div><h2>Cấu Hình Server (.env)</h2><div class="endpoint"><p><strong>Proxy:</strong> <code>P_IP</code>, <code>P_PORT</code>, etc. | <strong>Rule Động:</strong> <code>RULE_URL</code>, <code>RULE_UPDATE_INTERVAL</code></p></div><h2>Cách Viết Rule (trong file <code>rules.txt</code>)</h2><div class="endpoint"><h3>Chỉ Hỗ Trợ Regex</h3><p>Hệ thống chỉ chấp nhận các quy tắc có tiền tố <code>regex:</code>.</p><pre><code>regex:\\.m3u8?(\\?|$)</code></pre></div><h2><span class="badge badge-get">GET</span> /api/scrape</h2><div class="endpoint"><h3>Ví dụ</h3><pre><code>curl "http://localhost:3000/api/scrape?url=...&key=..."</code></pre></div><h2><span class="badge badge-post">POST</span> /api/scrape</h2><div class="endpoint"><h3>Ví dụ</h3><pre><code>curl -X POST "http://localhost:3000/api/scrape?key=..." \\
-H "Content-Type: application/json" \\
-d '{"url": "...", "headers": {"Referer": "..."}}'</code></pre></div></body></html>`;

async function initializeBrowser() {
    console.log('[BROWSER] Đang khởi tạo instance trình duyệt toàn cục...');
    const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--single-process', '--disable-gpu'];
    if (globalProxyUrl) launchArgs.push(`--proxy-server=${globalProxyUrl}`);
    try {
        browserInstance = await puppeteer.launch({
            headless: "new",
            args: launchArgs,
            executablePath: '/usr/bin/chromium',
            userDataDir: '/usr/src/app/.browser-cache'
        });
        console.log('[BROWSER] Trình duyệt đã sẵn sàng!');
    } catch (error) {
        console.error('[BROWSER] Lỗi nghiêm trọng khi khởi tạo trình duyệt:', error);
        process.exit(1);
    }
}

const startServer = async () => {
    await initializeBrowser();
    await updateDetectionRules();
    const updateIntervalMinutes = parseInt(RULE_UPDATE_INTERVAL, 10) || 60;
    setInterval(updateDetectionRules, updateIntervalMinutes * 60 * 1000);
    console.log(`[RULE MANAGER] Đã lên lịch tự động cập nhật rule mỗi ${updateIntervalMinutes} phút.`);
    app.get('/docs', (req, res) => res.setHeader('Content-Type', 'text/html').send(docsHtml));
    app.get('/', (req, res) => res.redirect('/docs'));
    app.listen(PORT, () => console.log(`Server hiệu năng cao đang chạy tại http://localhost:${PORT}`));
};

startServer();
