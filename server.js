require('dotenv').config();

const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const url = require('url');
const { SocksProxyAgent } = require('socks-proxy-agent');
// FormData không còn cần thiết nữa
// const FormData = require('form-data');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// --- CẤU HÌNH SERVER ---
const { API_KEY, P_IP, P_PORT, P_USER, P_PASSWORD, RULE_URL, RULE_UPDATE_INTERVAL } = process.env;
let globalProxyUrl = null;
if (P_IP && P_PORT) {
    const authPart = (P_USER && P_PASSWORD) ? `${P_USER}:${P_PASSWORD}@` : '';
    globalProxyUrl = `socks5://${authPart}${P_IP}:${P_PORT}`;
}
if (!API_KEY) console.warn('[SECURITY WARNING] API_KEY chưa được thiết lập!');

// --- Biến toàn cục cho trình duyệt và quản lý rule ---
let browserInstance = null;
let detectionRules = [/application\/(vnd\.apple\.mpegurl|x-mpegurl)/i];

// --- CÁC HÀM HELPER VÀ LÕI ---
const updateDetectionRules = async () => {
    if (!RULE_URL) return console.log('[RULE MANAGER] Không có RULE_URL. Chỉ dùng rule mặc định.');
    console.log(`[RULE MANAGER] Đang cập nhật rule từ: ${RULE_URL}`);
    try {
        const { data } = await axios.get(RULE_URL);
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
    if (req.query.key === API_KEY) return next();
    res.status(401).json({ success: false, message: 'Unauthorized: API Key không hợp lệ hoặc bị thiếu.' });
};

// --- LOẠI BỎ HOÀN TOÀN --- Hàm uploadToDpaste không còn cần thiết
// async function uploadToDpaste(content) { ... }

const handleResponse = (response, foundLinks) => {
    const requestUrl = response.url();
    if (requestUrl.startsWith('data:')) return;
    const contentType = response.headers()['content-type'] || '';
    const isMatchByRule = detectionRules.some(rule => rule.test(requestUrl) || rule.test(contentType));
    if (isMatchByRule && !requestUrl.endsWith('.ts')) {
        console.log(`[+] Đã bắt được link M3U8 (khớp với Rule): ${requestUrl}`);
        foundLinks.add(requestUrl);
    }
};

// --- LOGIC SCRAPE CHÍNH (TRẢ VỀ NỘI DUNG BLOB TRỰC TIẾP) ---
async function handleScrapeRequest(targetUrl, headers) {
    if (!browserInstance) throw new Error("Trình duyệt chưa sẵn sàng.");

    let page = null;
    const foundLinks = new Set();
    const foundContents = new Set(); // --- THÊM MỚI ---: Set để lưu nội dung blob
    console.log(`[PAGE] Đang mở trang mới cho: ${targetUrl}`);

    try {
        page = await browserInstance.newPage();
        await page.setRequestInterception(true);
        page.on('request', r => ['image', 'stylesheet', 'font'].includes(r.resourceType()) ? r.abort() : r.continue());
        if (Object.keys(headers).length > 0) await page.setExtraHTTPHeaders(headers);
        page.on('response', r => handleResponse(r, foundLinks));
        page.on('framecreated', async f => f.on('response', r => handleResponse(r, foundLinks)));

        // --- GIAI ĐOẠN 1: Lắng nghe thụ động để tìm link mạng ---
        console.log('[GIAI ĐOẠN 1] Đang lắng nghe link mạng...');
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(resolve => setTimeout(resolve, 8000));

        if (foundLinks.size > 0) {
            console.log('[THÀNH CÔNG GĐ1] Tìm thấy link mạng! Trả về ngay.');
            return { links: Array.from(foundLinks), contents: [] }; // Trả về cấu trúc object
        }

        // --- GIAI ĐOẠN 2: Kích hoạt chế độ bắt BLOB nếu GĐ1 thất bại ---
        console.log('[GIAI ĐOẠN 2] Không có link mạng. Chuyển sang chế độ bắt Blob và tải lại trang.');
        const interceptedBlobUrls = new Set();
        await page.exposeFunction('reportBlobUrlToNode', (blobUrl) => {
            if (blobUrl && blobUrl.startsWith('blob:')) {
                console.log(`[BLOB INTERCEPTOR] Bắt được blob: ${blobUrl}`);
                interceptedBlobUrls.add(blobUrl);
            }
        });

        await page.evaluateOnNewDocument(() => {
            const originalCreateObjectURL = URL.createObjectURL;
            URL.createObjectURL = function(obj) {
                const blobUrl = originalCreateObjectURL.apply(this, arguments);
                window.reportBlobUrlToNode(blobUrl);
                return blobUrl;
            };
        });

        await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(resolve => setTimeout(resolve, 5000));

        if (interceptedBlobUrls.size > 0) {
            console.log(`[BLOB SCANNER] Tìm thấy ${interceptedBlobUrls.size} blob. Đang lấy nội dung...`);
            for (const blobUrl of interceptedBlobUrls) {
                const blobContent = await page.evaluate(async (bUrl) => {
                    try {
                        const response = await fetch(bUrl);
                        // Chỉ lấy nội dung nếu response thành công
                        if (response.ok) return await response.text();
                        return null;
                    } catch (e) {
                        return null;
                    }
                }, blobUrl);

                if (blobContent) {
                    console.log(`[BLOB SCANNER] Lấy thành công nội dung từ ${blobUrl}.`);
                    foundContents.add(blobContent);
                }
            }
        }

        // Trả về tất cả những gì tìm được (links và contents)
        return { links: Array.from(foundLinks), contents: Array.from(foundContents) };
    } catch (error) {
        // Đảm bảo log lỗi đầy đủ để debug
        console.error(`[PAGE] Lỗi nghiêm trọng khi xử lý trang ${targetUrl}:`, error);
        // Trả về cấu trúc lỗi nhất quán
        return { links: [], contents: [], error: error.message };
    } finally {
        if (page) await page.close();
        console.log(`[PAGE] Đã đóng trang cho: ${targetUrl}`);
    }
}


// --- API ENDPOINTS ---
app.get('/api/scrape', apiKeyMiddleware, async (req, res) => {
    const { url, referer } = req.query;
    if (!url) return res.status(400).json({ success: false, message: 'Vui lòng cung cấp tham số "url".' });
    const headers = referer ? { Referer: referer } : {};
    const result = await handleScrapeRequest(url, headers);
    handleApiResponse(res, result, url);
});
app.post('/api/scrape', apiKeyMiddleware, async (req, res) => {
    const { url, headers = {} } = req.body;
    if (!url) return res.status(400).json({ success: false, message: 'Vui lòng cung cấp "url".' });
    const result = await handleScrapeRequest(url, headers);
    handleApiResponse(res, result, url);
});

// --- THAY ĐỔI ---: Hàm xử lý kết quả API mới
const handleApiResponse = (res, result, url) => {
    const { links = [], contents = [], error = null } = result;
    
    if (error) {
        // Nếu có lỗi từ quá trình scrape, trả về lỗi 500
        return res.status(500).json({ success: false, message: 'Lỗi nội bộ trong quá trình scrape.', error: error, source: url });
    }

    if (links.length > 0 || contents.length > 0) {
        res.json({
            success: true,
            source: url,
            links: links,
            contents: contents
        });
    } else {
        res.json({
            success: false,
            message: 'Không tìm thấy link mạng hay nội dung blob nào.',
            source: url,
            links: [],
            contents: []
        });
    }
};

// --- DOCS & START SERVER ---
const docsHtml = `<!DOCTYPE html><html lang="vi"><head><title>API Docs - M3U8 Scraper</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:20px;max-width:900px;margin:0 auto;color:#333}h1,h2,h3{color:#111;border-bottom:1px solid #ddd;padding-bottom:10px;margin-top:30px}code{background-color:#f4f4f4;padding:2px 6px;border-radius:4px;font-family:"Courier New",Courier,monospace;color:#c7254e}pre{background-color:#f6f8fa;padding:15px;border-radius:5px;white-space:pre-wrap;word-wrap:break-word;border:1px solid #ddd}a{color:#0366d6;text-decoration:none}a:hover{text-decoration:underline}.endpoint{border:1px solid #eee;padding:0 20px 15px;border-radius:8px;margin-bottom:20px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.05)}li{margin-bottom:10px}.badge{color:white;padding:3px 8px;border-radius:12px;font-size:.8em;font-weight:700;margin-right:8px}.badge-post{background-color:#28a745}.badge-get{background-color:#007bff}</style></head><body><h1>API Docs - M3U8 Scraper</h1><p>API cào dữ liệu link M3U8 với hệ thống proxy, rule động, xác thực và tự động xử lý blob URL.</p><h2>Xác Thực</h2><div class="endpoint"><p>Mọi yêu cầu đến <code>/api/scrape</code> đều phải được xác thực bằng cách thêm tham số <code>key=YOUR_API_KEY</code> vào query string.</p></div><h2>Cấu Hình Server (.env)</h2><div class="endpoint"><p><strong>Proxy:</strong> <code>P_IP</code>, <code>P_PORT</code>, etc. | <strong>Rule Động:</strong> <code>RULE_URL</code>, <code>RULE_UPDATE_INTERVAL</code></p></div><h2>Định dạng trả về</h2><div class="endpoint"><p>API sẽ trả về cả link mạng và nội dung blob (nếu có)</p><pre><code>{
  "success": true,
  "source": "https://...",
  "links": ["https://.../master.m3u8"],
  "contents": ["#EXTM3U\\n#EXT-X-STREAM-INF:BANDWIDTH=..."]
}</code></pre></div><h2><span class="badge badge-get">GET</span> /api/scrape</h2><div class="endpoint"><h3>Ví dụ</h3><pre><code>curl "http://localhost:3000/api/scrape?url=...&key=..."</code></pre></div><h2><span class="badge badge-post">POST</span> /api/scrape</h2><div class="endpoint"><h3>Ví dụ</h3><pre><code>curl -X POST "http://localhost:3000/api/scrape?key=..." \\
-H "Content-Type: application/json" \\
-d '{"url": "...", "headers": {"Referer": "..."}}'</code></pre></div></body></html>`;

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

const initializeBrowser = async () => {
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
};

startServer();
