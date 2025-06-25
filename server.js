// Dễ dàng sao chép toàn bộ mã nguồn
require('dotenv').config();

const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const FormData = require('form-data');
const url = require('url');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// --- CẤU HÌNH SERVER ---
const { API_KEY, P_IP, P_PORT, P_USER, P_PASSWORD, RULE_URL, RULE_UPDATE_INTERVAL, GLOBAL_TIMEOUT } = process.env;

let globalProxyUrl = null;
let agent = null;
if (P_IP && P_PORT) {
    const authPart = (P_USER && P_PASSWORD) ? `${P_USER}:${P_PASSWORD}@` : '';
    globalProxyUrl = `socks5://${authPart}${P_IP}:${P_PORT}`;
    agent = new SocksProxyAgent(globalProxyUrl);
}
if (!API_KEY) console.warn('[SECURITY WARNING] API_KEY chưa được thiết lập!');

// --- Biến toàn cục cho trình duyệt và quản lý rule ---
let browserInstance = null;
let detectionRules = [/application\/(vnd\.apple\.mpegurl|x-mpegurl)/i];

// --- CÁC HÀM HELPER VÀ LÕI (Giữ nguyên) ---
const updateDetectionRules = async () => { /* ... */ };
const apiKeyMiddleware = (req, res, next) => { /* ... */ };
async function uploadToDpaste(content) { /* ... */ };

// (Dán các hàm updateDetectionRules, apiKeyMiddleware, uploadToDpaste từ phiên bản trước vào đây)
const updateDetectionRules = async () => {
    if (!RULE_URL) return console.log('[RULE MANAGER] Không có RULE_URL. Chỉ dùng rule Content-Type mặc định.');
    console.log(`[RULE MANAGER] Đang cập nhật rule từ: ${RULE_URL}`);
    try {
        const { data } = await axios.get(RULE_URL, { httpAgent: agent, httpsAgent: agent });
        const remoteRules = data.split('\n').map(l => l.trim()).filter(l => l.toLowerCase().startsWith('regex:')).map(l => {
            try { return new RegExp(l.substring(6).trim(), 'i'); }
            catch (e) { console.error(`[RULE MANAGER] Lỗi cú pháp rule: "${l}". Bỏ qua.`); return null; }
        }).filter(Boolean);
        detectionRules = [/application\/(vnd\.apple\.mpegurl|x-mpegurl)/i, ...remoteRules];
        console.log(`[RULE MANAGER] Cập nhật thành công! Tổng số rule: ${detectionRules.length}`);
    } catch (error) {
        console.error(`[RULE MANAGER] Lỗi khi tải file rule: ${error.message}`);
    }
};
const apiKeyMiddleware = (req, res, next) => {
    if (!API_KEY) return res.status(503).json({ success: false, message: 'Dịch vụ không được cấu hình.' });
    if (req.query.key === API_KEY || (req.body && req.body.key === API_KEY)) return next();
    res.status(401).json({ success: false, message: 'Unauthorized: API Key không hợp lệ hoặc bị thiếu.' });
};
async function uploadToDpaste(content) {
    try {
        const form = new FormData();
        form.append('content', content);
        form.append('syntax', 'text');
        form.append('expiry_days', '1');
        const { data } = await axios.post('https://dpaste.org/api/', form, {
            headers: { ...form.getHeaders() }, httpAgent: agent, httpsAgent: agent
        });
        return `${data.trim()}/raw`;
    } catch (error) {
        console.error('[DPASTE] Lỗi khi tải lên:', error.message);
        return null;
    }
}


// --- LOGIC SCRAPE CHÍNH (PHIÊN BẢN TOÀN DIỆN) ---
async function handleScrapeRequest(targetUrl, headers) {
    if (!browserInstance) throw new Error("Trình duyệt chưa sẵn sàng.");

    let page = null;
    const foundLinks = new Set();
    
    return new Promise(async (resolve) => {
        const timeout = parseInt(GLOBAL_TIMEOUT, 10) || 90000;
        let resolved = false;

        const resolveOnce = (result) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(masterTimeout);
            if (page) page.close().catch(e => console.error('[PAGE] Lỗi khi đóng trang (có thể đã đóng):', e.message));
            console.log(`[OPTIMIZATION] Hoàn tất xử lý cho ${targetUrl}. Tìm thấy ${result.length} link.`);
            resolve(result);
        };

        const masterTimeout = setTimeout(() => {
            console.log(`[TIMEOUT] Quá trình vượt quá ${timeout / 1000}s. Trả về kết quả hiện tại.`);
            resolveOnce(Array.from(foundLinks));
        }, timeout);

        try {
            page = await browserInstance.newPage();

            // --- CƠ CHẾ BẮT BLOB (Mạnh mẽ) ---
            await page.exposeFunction('onBlobCreated', async (blobUrl) => {
                if (resolved) return;
                console.log(`[BLOB INTERCEPTOR] Đã bắt được blob URL: ${blobUrl}`);
                try {
                    const content = await page.evaluate(bUrl => fetch(bUrl).then(res => res.text()), blobUrl);
                    if (content && content.includes('#EXTM3U')) {
                        console.log('[BLOB INTERCEPTOR] Nội dung blob là M3U8 hợp lệ. Đang xử lý...');
                        const rawLink = await uploadToDpaste(content);
                        if (rawLink) foundLinks.add(rawLink);
                        if (foundLinks.size > 0) resolveOnce(Array.from(foundLinks));
                    }
                } catch(e) { /* Bỏ qua lỗi fetch blob */ }
            });
            
            await page.evaluateOnNewDocument(() => {
                const originalCreateObjectURL = URL.createObjectURL;
                URL.createObjectURL = function() {
                    const url = originalCreateObjectURL.apply(this, arguments);
                    window.onBlobCreated(url); 
                    return url;
                };
            });

            // --- CƠ CHẾ BẮT NETWORK (Được nâng cấp để mạnh mẽ hơn) ---
            page.on('response', async (response) => {
                if (resolved) return;
                const requestUrl = response.url();
                if (requestUrl.startsWith('data:')) return;
                const contentType = response.headers()['content-type'] || '';
                
                const isMatchByRule = detectionRules.some(rule => rule.test(requestUrl) || rule.test(contentType));
                
                if (isMatchByRule && !requestUrl.endsWith('.ts')) {
                    console.log(`[NETWORK INTERCEPTOR] Phát hiện URL khớp rule: ${requestUrl}`);
                    try {
                        // <<< CẢI TIẾN QUAN TRỌNG: Xác thực nội dung link network >>>
                        const text = await response.text();
                        if (text && text.includes('#EXTM3U')) {
                            console.log(`[NETWORK INTERCEPTOR] Link đã được xác thực là M3U8. Bắt link!`);
                            foundLinks.add(requestUrl);
                            resolveOnce(Array.from(foundLinks));
                        } else {
                            console.log(`[NETWORK INTERCEPTOR] URL khớp rule nhưng không phải M3U8. Bỏ qua.`);
                        }
                    } catch (e) {
                        // Bỏ qua lỗi nếu không đọc được body (vd: redirect, no content)
                    }
                }
            });

            await page.setRequestInterception(true);
            page.on('request', r => resolved || ['image', 'stylesheet', 'font'].includes(r.resourceType()) ? r.abort() : r.continue());
            if (Object.keys(headers).length > 0) await page.setExtraHTTPHeaders(headers);

            console.log('[NAVIGATE] Đang điều hướng đến trang...');
            await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            
            // <<< CHỐT CHẶN LOGIC THOÁT SỚM >>>
            if (resolved) {
                console.log('[OPTIMIZATION] Đã tìm thấy link trong lúc tải trang. Bỏ qua bước tương tác.');
                return;
            }

            console.log('[INTERACTION] Chưa tìm thấy link. Thử kích hoạt video...');
            const interactionResult = await page.evaluate(async () => {
                const video = Array.from(document.querySelectorAll('video')).find(v => v.offsetWidth > 0 || v.offsetHeight > 0);
                if (!video) return 'Không tìm thấy video nào đang hiển thị.';
                try {
                    await video.play();
                    return 'Lệnh video.play() đã được gửi.';
                } catch (err) {
                    video.click();
                    return 'Lệnh video.play() thất bại, đã thử click().';
                }
            });
            console.log(`[INTERACTION] Kết quả: ${interactionResult}`);

            console.log('[FINALIZE] Chờ các listener hoạt động hoặc chờ timeout...');

        } catch (error) {
            if (!resolved) {
                console.error(`[PAGE] Lỗi nghiêm trọng khi xử lý ${targetUrl}:`, error.message);
                resolveOnce(Array.from(foundLinks));
            }
        }
    });
}

// --- API ENDPOINTS VÀ SERVER STARTUP (Giữ nguyên) ---
const docsHtml = `...`; // Giữ nguyên HTML docs
app.all('/api/scrape', apiKeyMiddleware, async (req, res) => { /* ... */ });
const initializeBrowser = async () => { /* ... */ };
const startServer = async () => { /* ... */ };

// (Dán các hàm docsHtml, app.all, initializeBrowser, startServer từ phiên bản trước vào đây)
app.all('/api/scrape', apiKeyMiddleware, async (req, res) => {
    const { url, headers = {}, referer } = { ...req.query, ...req.body };
    if (!url) return res.status(400).json({ success: false, message: 'Vui lòng cung cấp "url".' });

    const finalHeaders = { ...headers };
    if (referer) finalHeaders.Referer = referer;

    try {
        const links = await handleScrapeRequest(url, finalHeaders);
        if (links.length > 0) {
            res.json({ success: true, count: links.length, source: url, links });
        } else {
            res.status(404).json({ success: false, message: 'Không tìm thấy link M3U8 nào.', source: url, links: [] });
        }
    } catch (error) {
        console.error(`[API] Lỗi khi scrape ${url}:`, error);
        res.status(500).json({ success: false, message: `Lỗi máy chủ: ${error.message}`, source: url });
    }
});
const initializeBrowser = async () => {
    console.log('[BROWSER] Đang khởi tạo instance trình duyệt toàn cục...');
    const launchArgs = [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
        '--single-process', '--disable-gpu', '--window-size=1280,720',
        '--autoplay-policy=no-user-gesture-required'
    ];
    if (globalProxyUrl) launchArgs.push(`--proxy-server=${globalProxyUrl}`);
    try {
        browserInstance = await puppeteer.launch({
            headless: "new", args: launchArgs, executablePath: '/usr/bin/chromium',
            userDataDir: '/usr/src/app/.browser-cache', ignoreDefaultArgs: ['--mute-audio']
        });
        console.log('[BROWSER] Trình duyệt đã sẵn sàng!');
    } catch (error) {
        console.error('[BROWSER] Lỗi nghiêm trọng khi khởi tạo trình duyệt:', error);
        process.exit(1);
    }
};
const startServer = async () => {
    await initializeBrowser();
    await updateDetectionRules();
    const updateIntervalMinutes = parseInt(RULE_UPDATE_INTERVAL, 10) || 60;
    setInterval(updateDetectionRules, updateIntervalMinutes * 60 * 1000);
    console.log(`[RULE MANAGER] Đã lên lịch cập nhật rule mỗi ${updateIntervalMinutes} phút.`);
    app.get('/docs', (req, res) => res.setHeader('Content-Type', 'text/html').send(docsHtml));
    app.get('/', (req, res) => res.redirect('/docs'));
    app.listen(PORT, () => console.log(`Server hiệu năng cao đang chạy tại http://localhost:${PORT}`));
};

startServer();
