// server.js (Phiên bản "Real-time Blob Interception")

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

// --- CÁC HÀM, BIẾN, MIDDLEWARE KHÔNG THAY ĐỔI ---
// #region (Phần không đổi)
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
const handleApiResponse = (res, links, url) => {
    if (links.length > 0) res.json({ success: true, count: links.length, source: url, links });
    else res.json({ success: false, message: 'Không tìm thấy link M3U8 nào.', source: url, links: [] });
};
// #endregion

// --- NÂNG CẤP LOGIC PUPPETEER ---

// Hàm xử lý response mạng (đã có đọc nội dung)
const handleResponse = async (response, foundLinks) => {
    const requestUrl = response.url();
    const contentType = response.headers()['content-type'] || '';
    const isMatchByRule = detectionRules.some(rule => rule.test(requestUrl) || rule.test(contentType));
    if (isMatchByRule && !requestUrl.endsWith('.ts')) {
        foundLinks.add(requestUrl);
        return;
    }
    const request = response.request();
    if (['xhr', 'fetch'].includes(request.resourceType())) {
        try {
            const textContent = await response.text();
            if (textContent && textContent.trim().startsWith('#EXTM3U')) {
                const rawLink = await uploadToDpaste(textContent);
                if (rawLink) foundLinks.add(rawLink);
            }
        } catch (e) {}
    }
};

async function findM3u8LinksWithPuppeteer(targetUrl, customHeaders = {}) {
    console.log(`[PUPPETEER] Bắt đầu phiên làm việc cho: ${targetUrl}`);
    const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
    if (globalProxyUrl) launchArgs.push(`--proxy-server=${globalProxyUrl}`);
    
    // Sử dụng Set để đảm bảo link không bị trùng
    const networkLinks = new Set();
    const blobLinksFound = new Set();
    
    let browser = null;
    try {
        browser = await puppeteer.launch({ headless: "new", args: launchArgs, executablePath: '/usr/bin/chromium' });
        const page = await browser.newPage();

        // --- BƯỚC 1: TẠO CẦU NỐI GIỮA BROWSER VÀ NODE.JS ---
        // `exposeFunction` tạo ra một hàm `window.onBlobUrlCreated` trong trình duyệt
        // mà khi gọi, nó sẽ thực thi hàm trong Node.js
        await page.exposeFunction('onBlobUrlCreated', (blobUrl) => {
            console.log(`[BLOB INTERCEPTOR] Đã bắt được blob URL được tạo: ${blobUrl}`);
            blobLinksFound.add(blobUrl);
        });

        // --- BƯỚC 2: TIÊM SCRIPT CAN THIỆP VÀO TRANG ---
        // `evaluateOnNewDocument` đảm bảo script này chạy trước mọi script của trang web
        await page.evaluateOnNewDocument(() => {
            // Lưu lại hàm gốc
            const originalCreateObjectURL = URL.createObjectURL;
            // Ghi đè hàm gốc
            URL.createObjectURL = function(...args) {
                // Gọi hàm gốc để lấy ra link blob
                const blobUrl = originalCreateObjectURL.apply(this, args);
                // Gọi hàm đã được expose để báo cho Node.js biết
                window.onBlobUrlCreated(blobUrl);
                // Trả về link blob để trang web hoạt động bình thường
                return blobUrl;
            };
        });

        await page.setRequestInterception(true);
        page.on('request', r => ['image', 'stylesheet', 'font'].includes(r.resourceType()) ? r.abort() : r.continue());
        if (Object.keys(customHeaders).length > 0) await page.setExtraHTTPHeaders(customHeaders);
        
        // Săn link mạng vẫn chạy song song
        page.on('response', r => handleResponse(r, networkLinks));
        page.on('framecreated', async f => f.on('response', r => handleResponse(r, networkLinks)));
        
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        console.log('[PUPPETEER] Trang đã tải xong, chờ thêm 3 giây để hoàn tất các script.');
        await new Promise(resolve => setTimeout(resolve, 3000)); // Chờ một chút để đảm bảo các blob đã được báo về

        // --- BƯỚC 3: XỬ LÝ CÁC LINK BLOB ĐÃ BẮT ĐƯỢC ---
        if (blobLinksFound.size > 0) {
            console.log(`[BLOB PROCESSOR] Bắt đầu xử lý ${blobLinksFound.size} link blob đã được intercept...`);
            for (const blobUrl of blobLinksFound) {
                const m3u8Content = await page.evaluate(async (bUrl) => {
                    try { return await (await fetch(bUrl)).text(); } catch (e) { return null; }
                }, blobUrl);
                if (m3u8Content && m3u8Content.trim().includes('#EXTM3U')) {
                    console.log(`[BLOB PROCESSOR]   -> Nội dung từ ${blobUrl} là M3U8. Đang tải lên Dpaste...`);
                    const rawLink = await uploadToDpaste(m3u8Content);
                    if (rawLink) networkLinks.add(rawLink);
                }
            }
        } else {
            console.log(`[BLOB PROCESSOR] Không có blob URL nào được tạo ra trong phiên này.`);
        }
        
        console.log(`[PUPPETEER] Hoàn tất. Tìm thấy tổng cộng ${networkLinks.size} link.`);
        return Array.from(networkLinks);
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

// --- API ENDPOINTS VÀ START SERVER (Không thay đổi) ---
// #region (Phần cuối không đổi)
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
const docsHtml = `<!DOCTYPE html><html lang="vi"><head><title>API Docs - M3U8 Scraper</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:20px;max-width:900px;margin:0 auto;color:#333}h1,h2,h3{color:#111;border-bottom:1px solid #ddd;padding-bottom:10px;margin-top:30px}code{background-color:#f4f4f4;padding:2px 6px;border-radius:4px;font-family:"Courier New",Courier,monospace;color:#c7254e}pre{background-color:#f6f8fa;padding:15px;border-radius:5px;white-space:pre-wrap;word-wrap:break-word;border:1px solid #ddd}a{color:#0366d6;text-decoration:none}a:hover{text-decoration:underline}.endpoint{border:1px solid #eee;padding:0 20px 15px;border-radius:8px;margin-bottom:20px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.05)}li{margin-bottom:10px}.badge{color:white;padding:3px 8px;border-radius:12px;font-size:.8em;font-weight:700;margin-right:8px}.badge-post{background-color:#28a745}.badge-get{background-color:#007bff}</style></head><body><h1>Tài Liệu API - M3U8 Scraper</h1><p>API cào dữ liệu link M3U8 với hệ thống proxy, rule động, xác thực và <strong>tự động can thiệp để bắt blob URL</strong>.</p><h2>Cách Hoạt Động</h2><div class="endpoint"><ol><li>Săn link M3U8 từ URL/Content-Type của request mạng dựa vào <strong>rules.txt</strong>.</li><li>Săn M3U8 bằng cách đọc nội dung của các response từ API/XHR.</li><li>Săn M3U8 bằng cách can thiệp vào hàm <strong>URL.createObjectURL()</strong> của trình duyệt để bắt blob ngay khi chúng được tạo ra.</li></ol></div><h2>Endpoints</h2><p>Sử dụng <code>GET</code> hoặc <code>POST</code> đến <code>/api/scrape</code> với tham số <code>?key=YOUR_API_KEY</code>.</p></body></html>`;
const startServer = async () => {
    await updateDetectionRules();
    const updateIntervalMinutes = parseInt(RULE_UPDATE_INTERVAL, 10) || 60;
    setInterval(updateDetectionRules, updateIntervalMinutes * 60 * 1000);
    console.log(`[RULE MANAGER] Đã lên lịch tự động cập nhật rule mỗi ${updateIntervalMinutes} phút.`);
    app.get('/docs', (req, res) => res.setHeader('Content-Type', 'text/html').send(docsHtml));
    app.get('/', (req, res) => res.redirect('/docs'));
    app.listen(PORT, () => {
        console.log(`Server "Interceptor" đang chạy tại http://localhost:${PORT}`);
    });
};
startServer();
// #endregion
