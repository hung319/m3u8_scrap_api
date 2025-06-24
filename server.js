// server.js (Phiên bản "High-Performance" với Browser Pooling)

require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const url = require('url');
const { SocksProxyAgent } = require('socks-proxy-agent');
const FormData = require('form-data');

puppeteer.use(StealthPlugin());
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// --- CẤU HÌNH VÀ CÁC BIẾN TOÀN CỤC ---
const { API_KEY, P_IP, P_PORT, P_USER, P_PASSWORD, RULE_URL, RULE_UPDATE_INTERVAL } = process.env;
let globalProxyUrl = null;
if (P_IP && P_PORT) {
    const authPart = (P_USER && P_PASSWORD) ? `${P_USER}:${P_PASSWORD}@` : '';
    globalProxyUrl = `socks5://${authPart}${P_IP}:${P_PORT}`;
}
if (!API_KEY) console.warn('[SECURITY WARNING] API_KEY chưa được thiết lập!');

// --- THAY ĐỔI 1: Biến toàn cục để giữ instance của trình duyệt ---
let browserInstance = null;

// --- HỆ THỐNG QUẢN LÝ RULE VÀ CÁC HÀM HELPER (Không thay đổi) ---
// #region (Các hàm không đổi)
let detectionRules = [];
const updateDetectionRules = async () => { /* ... giữ nguyên ... */ };
const apiKeyMiddleware = (req, res, next) => { /* ... giữ nguyên ... */ };
async function uploadToDpaste(content) { /* ... giữ nguyên ... */ }
const handleResponse = async (response, foundLinks) => { /* ... giữ nguyên ... */ };
const handleApiResponse = (res, links, url) => { /* ... giữ nguyên ... */ };
// #endregion

// --- THAY ĐỔI 2: Hàm khởi tạo trình duyệt toàn cục ---
async function initializeBrowser() {
    console.log('[BROWSER] Đang khởi tạo instance trình duyệt toàn cục...');
    const launchArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process', // <- Chỉ dùng cho Docker
        '--disable-gpu'
    ];
    if (globalProxyUrl) launchArgs.push(`--proxy-server=${globalProxyUrl}`);

    try {
        browserInstance = await puppeteer.launch({
            headless: "new",
            args: launchArgs,
            executablePath: '/usr/bin/chromium',
            // Sử dụng thư mục cache đã tạo trong Dockerfile
            userDataDir: '/usr/src/app/.browser-cache'
        });
        console.log('[BROWSER] Trình duyệt đã sẵn sàng!');
    } catch (error) {
        console.error('[BROWSER] Lỗi nghiêm trọng khi khởi tạo trình duyệt:', error);
        process.exit(1); // Thoát server nếu không khởi tạo được trình duyệt
    }
}

// --- THAY ĐỔI 3: Hàm scrape được cấu trúc lại để dùng trình duyệt có sẵn ---
async function handleScrapeRequest(targetUrl, headers) {
    if (!browserInstance) {
        throw new Error("Trình duyệt chưa sẵn sàng. Vui lòng thử lại sau giây lát.");
    }
    
    let page = null;
    const foundLinks = new Set();
    console.log(`[PAGE] Đang mở trang mới cho: ${targetUrl}`);
    
    try {
        page = await browserInstance.newPage();
        await page.setRequestInterception(true);
        page.on('request', r => ['image', 'stylesheet', 'font'].includes(r.resourceType()) ? r.abort() : r.continue());
        if (Object.keys(headers).length > 0) await page.setExtraHTTPHeaders(headers);
        
        page.on('response', r => handleResponse(r, foundLinks));
        page.on('framecreated', async f => f.on('response', r => handleResponse(r, foundLinks)));
        
        await page.goto(targetUrl, { waitUntil: 'networkidle0', timeout: 60000 });
        
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
            if (m3u8Content && m3u8Content.includes('#EXTM3U')) {
                const rawLink = await uploadToDpaste(m3u8Content);
                if (rawLink) foundLinks.add(rawLink);
            }
        }
        
        return Array.from(foundLinks);
    } catch (error) {
        console.error(`[PAGE] Lỗi khi xử lý trang ${targetUrl}:`, error.message);
        return []; // Trả về mảng rỗng nếu có lỗi
    } finally {
        if (page) {
            await page.close();
            console.log(`[PAGE] Đã đóng trang cho: ${targetUrl}`);
        }
    }
}

// --- API ENDPOINTS (Đã đơn giản hóa) ---
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
const docsHtml = `...`; // Nội dung docs được rút gọn, chỉ cần cập nhật để bỏ 'hasJs'
const startServer = async () => {
    await updateDetectionRules();
    setInterval(updateDetectionRules, (parseInt(RULE_UPDATE_INTERVAL, 10) || 60) * 60 * 1000);
    
    // Khởi tạo trình duyệt trước khi nhận request
    await initializeBrowser();
    
    app.get('/docs', (req, res) => res.setHeader('Content-Type', 'text/html').send(docsHtml));
    app.get('/', (req, res) => res.redirect('/docs'));
    app.listen(PORT, () => console.log(`Server hiệu năng cao đang chạy tại http://localhost:${PORT}`));
};

startServer();

// --- Code đầy đủ cho các hàm không đổi để bạn tiện copy-paste ---
// #region (Full code for unchanged functions)
const wildcardToRegex = (pattern) => {const escapedPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); const regexString = escapedPattern.replace(/\*/g, '.*'); return new RegExp(`^${regexString}$`, 'i');};
detectionRules = [wildcardToRegex('*.m3u8'), wildcardToRegex('*.m3u'), /application\/(vnd\.apple\.mpegurl|x-mpegurl)/i];
const updateDetectionRules = async () => {if (!RULE_URL) return console.log('[RULE MANAGER] Không có RULE_URL.'); console.log(`[RULE MANAGER] Đang cập nhật rule từ: ${RULE_URL}`); try { const { data } = await axios.get(RULE_URL); const remoteRules = data.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => { try { return l.toLowerCase().startsWith('regex:') ? new RegExp(l.substring(6).trim(), 'i') : wildcardToRegex(l); } catch (e) { console.error(`[RULE MANAGER] Lỗi cú pháp rule: "${l}". Bỏ qua.`); return null; } }).filter(Boolean); if (remoteRules.length > 0) { detectionRules = [...defaultRules, ...remoteRules]; console.log(`[RULE MANAGER] Cập nhật thành công! Tổng số rule: ${detectionRules.length}`); } } catch (error) { console.error(`[RULE MANAGER] Lỗi khi tải file rule: ${error.message}`); }};
const apiKeyMiddleware = (req, res, next) => {if (!API_KEY) return res.status(503).json({ success: false, message: 'Dịch vụ không được cấu hình.' }); if (req.query.key === API_KEY) return next(); res.status(401).json({ success: false, message: 'Unauthorized: API Key không hợp lệ hoặc bị thiếu.' });};
async function uploadToDpaste(content) {try {const form = new FormData(); form.append('content', content); form.append('syntax', 'text'); form.append('expiry_days', '1'); const { data } = await axios.post('https://dpaste.org/api/', form, { headers: { ...form.getHeaders() } }); return `${data.trim()}/raw`;} catch (error) {console.error('[DPASTE] Lỗi khi tải lên:', error.message); return null;}}
const handleResponse = async (response, foundLinks) => {const requestUrl = response.url(); if (requestUrl.startsWith('data:')) return; const contentType = response.headers()['content-type'] || ''; const isMatchByRule = detectionRules.some(rule => rule.test(requestUrl) || rule.test(contentType)); if (isMatchByRule && !requestUrl.endsWith('.ts')) {foundLinks.add(requestUrl); return;} const request = response.request(); if (['xhr', 'fetch'].includes(request.resourceType())) {try { const textContent = await response.text(); if (textContent && textContent.trim().startsWith('#EXTM3U')) {const rawLink = await uploadToDpaste(textContent); if (rawLink) foundLinks.add(rawLink);}} catch (e) {}}};
const handleApiResponse = (res, links, url) => {if (links.length > 0) res.json({ success: true, count: links.length, source: url, links }); else res.json({ success: false, message: 'Không tìm thấy link M3U8 nào.', source: url, links: [] });};
// #endregion
