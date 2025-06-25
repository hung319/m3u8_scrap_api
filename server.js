require('dotenv').config();

const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const url = require('url');
const { SocksProxyAgent } = require('socks-proxy-agent');

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
let networkDetectionRules = [/application\/(vnd\.apple\.mpegurl|x-mpegurl)/i];
let blobUrlFilterRules = []; 

// --- CÁC HÀM HELPER VÀ LÕI ---
const updateDetectionRules = async () => {
    // Reset rules trước mỗi lần cập nhật
    networkDetectionRules = [/application\/(vnd\.apple\.mpegurl|x-mpegurl)/i];
    blobUrlFilterRules = [];

    if (!RULE_URL) return console.log('[RULE MANAGER] Không có RULE_URL. Chỉ dùng rule content-type mặc định.');
    console.log(`[RULE MANAGER] Đang cập nhật rule từ: ${RULE_URL}`);
    try {
        const { data } = await axios.get(RULE_URL);
        const allRules = data.split('\n').map(l => l.trim().toLowerCase()).filter(Boolean);

        const networkRulesRaw = allRules.filter(r => r.startsWith('regex:') && !r.startsWith('regex:blob:'));
        const blobRulesRaw = allRules.filter(r => r.startsWith('regex:blob:'));

        networkRulesRaw.forEach(r => {
            try {
                networkDetectionRules.push(new RegExp(r.substring(6).trim(), 'i'));
            } catch (e) { console.error(`[RULE MANAGER] Lỗi cú pháp rule mạng: "${r}". Bỏ qua.`); }
        });
        
        blobRulesRaw.forEach(r => {
            try {
                blobUrlFilterRules.push(new RegExp(r.substring(11).trim(), 'i'));
            } catch (e) { console.error(`[RULE MANAGER] Lỗi cú pháp rule lọc blob: "${r}". Bỏ qua.`); }
        });

        console.log(`[RULE MANAGER] Cập nhật thành công! ${networkDetectionRules.length} rule mạng, ${blobUrlFilterRules.length} rule lọc URL blob.`);
        if (blobUrlFilterRules.length > 0) {
            console.log(`[RULE MANAGER] Các rule lọc URL blob: ${blobUrlFilterRules.map(r => r.source).join(', ')}`);
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

const handleResponse = (response, foundLinks) => {
    const requestUrl = response.url();
    if (requestUrl.startsWith('data:')) return;
    const contentType = response.headers()['content-type'] || '';
    const isMatchByRule = networkDetectionRules.some(rule => rule.test(requestUrl) || rule.test(contentType));
    if (isMatchByRule && !requestUrl.endsWith('.ts')) {
        console.log(`[+] Đã bắt được link M3U8 (khớp với Rule): ${requestUrl}`);
        foundLinks.add(requestUrl);
    }
};

// --- LOGIC SCRAPE CHÍNH (LOGIC 3 GIAI ĐOẠN HOÀN CHỈNH) ---
async function handleScrapeRequest(targetUrl, headers) {
    if (!browserInstance) throw new Error("Trình duyệt chưa sẵn sàng.");

    let page = null;
    const foundLinks = new Set();
    const foundContents = new Set();
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
        if (foundLinks.size > 0) {
            console.log('[THÀNH CÔNG GĐ1] Tìm thấy link mạng khi tải trang! Trả về ngay.');
            return { links: Array.from(foundLinks), contents: [] };
        }

        // --- GIAI ĐOẠN 2: Tương tác lần 1 ---
        console.log('[GIAI ĐOẠN 2] Thất bại GĐ1. Đang thử ép video phát...');
        try {
            await page.evaluate(async () => {
                for (const video of document.querySelectorAll('video')) {
                    video.muted = true;
                    try { await video.play(); } catch (e) {}
                }
            });
            await new Promise(resolve => setTimeout(resolve, 5000));
        } catch(e) { /* Bỏ qua nếu không có video */ }

        if (foundLinks.size > 0) {
            console.log('[THÀNH CÔNG GĐ2] Tìm thấy link mạng sau khi tương tác! Trả về ngay.');
            return { links: Array.from(foundLinks), contents: [] };
        }
        
        // --- GIAI ĐOẠN 3: Kích hoạt bắt blob và tương tác đồng thời ---
        console.log('[GIAI ĐOẠN 3] Thất bại GĐ2. Chuyển sang giai đoạn cuối cùng.');
        
        if (blobUrlFilterRules.length === 0) {
            console.log('[BLOB RULE] Không có rule `regex:blob:...` nào được định nghĩa. Kết thúc.');
            return { links: [], contents: [] };
        }
        
        console.log('[GIAI ĐOẠN 3] Kích hoạt bắt Blob, tải lại trang và tương tác...');
        const interceptedBlobUrls = new Set();
        await page.exposeFunction('reportBlobUrlToNode', (blobUrl) => {
            if (blobUrl && blobUrl.startsWith('blob:')) interceptedBlobUrls.add(blobUrl);
        });
        await page.evaluateOnNewDocument(() => {
            const originalCreateObjectURL = URL.createObjectURL;
            URL.createObjectURL = function(obj) {
                const blobUrl = originalCreateObjectURL.apply(this, arguments);
                window.reportBlobUrlToNode(blobUrl);
                return blobUrl;
            };
        });
        
        // Tải lại trang với cơ chế bắt blob đã được tiêm
        await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });

        // --- THAY ĐỔI QUAN TRỌNG ---: Phát video NGAY SAU KHI tải lại trang
        console.log('[GIAI ĐOẠN 3] Đang thử ép video phát để kích hoạt blob...');
        try {
            await page.evaluate(async () => {
                for (const video of document.querySelectorAll('video')) {
                    video.muted = true;
                    try { await video.play(); } catch (e) {}
                }
            });
            await new Promise(resolve => setTimeout(resolve, 5000)); // Chờ blob được tạo
        } catch(e) { /* Bỏ qua nếu không có video */ }


        if (interceptedBlobUrls.size > 0) {
            for (const blobUrl of interceptedBlobUrls) {
                const isUrlMatch = blobUrlFilterRules.some(rule => rule.test(blobUrl));
                if (!isUrlMatch) {
                    console.log(`[BLOB FILTER] URL ${blobUrl} không khớp với rule. Bỏ qua.`);
                    continue;
                }
                console.log(`[BLOB FILTER] URL ${blobUrl} khớp với rule. Đang lấy nội dung...`);
                const blobContent = await page.evaluate(async (bUrl) => {
                    try {
                        const response = await fetch(bUrl);
                        if (response.ok) return await response.text();
                        return null;
                    } catch (e) { return null; }
                }, blobUrl);
                if (blobContent) foundContents.add(blobContent);
            }
        }

        return { links: Array.from(foundLinks), contents: Array.from(foundContents) };
    } catch (error) {
        console.error(`[PAGE] Lỗi nghiêm trọng khi xử lý trang ${targetUrl}:`, error.message);
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

const handleApiResponse = (res, result, url) => {
    const { links = [], contents = [], error = null } = result;
    if (error) {
        return res.status(500).json({ success: false, message: 'Lỗi nội bộ trong quá trình scrape.', error: error, source: url });
    }
    if (links.length > 0 || contents.length > 0) {
        res.json({ success: true, source: url, links: links, contents: contents });
    } else {
        res.json({ success: false, message: 'Không tìm thấy link mạng hay nội dung blob nào.', source: url, links: [], contents: [] });
    }
};

// --- DOCS & START SERVER ---
const docsHtml = `<!DOCTYPE html><html lang="vi"><head><title>API Docs - M3U8 Scraper</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:20px;max-width:900px;margin:0 auto;color:#333}h1,h2,h3{color:#111;border-bottom:1px solid #ddd;padding-bottom:10px;margin-top:30px}code{background-color:#f4f4f4;padding:2px 6px;border-radius:4px;font-family:"Courier New",Courier,monospace;color:#c7254e}pre{background-color:#f6f8fa;padding:15px;border-radius:5px;white-space:pre-wrap;word-wrap:break-word;border:1px solid #ddd}a{color:#0366d6;text-decoration:none}a:hover{text-decoration:underline}.endpoint{border:1px solid #eee;padding:0 20px 15px;border-radius:8px;margin-bottom:20px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.05)}li{margin-bottom:10px}.badge{color:white;padding:3px 8px;border-radius:12px;font-size:.8em;font-weight:700;margin-right:8px}.badge-post{background-color:#28a745}.badge-get{background-color:#007bff}</style></head><body><h1>API Docs - M3U8 Scraper</h1><p>API cào dữ liệu link M3U8 với hệ thống proxy, rule động, xác thực và tự động xử lý blob URL.</p><h2>Xác Thực</h2><div class="endpoint"><p>Mọi yêu cầu đến <code>/api/scrape</code> đều phải được xác thực bằng cách thêm tham số <code>key=YOUR_API_KEY</code> vào query string.</p></div><h2>Cấu Hình Server (.env)</h2><div class="endpoint"><p><strong>Proxy:</strong> <code>P_IP</code>, <code>P_PORT</code>, etc. | <strong>Rule Động:</strong> <code>RULE_URL</code>, <code>RULE_UPDATE_INTERVAL</code></p></div><h2>Cách Viết Rule (trong file <code>rules.txt</code>)</h2><div class="endpoint"><h3>Rule Bắt Link Mạng</h3><p>Sử dụng tiền tố <code>regex:</code> để bắt các URL mạng.</p><pre><code># Bắt các link kết thúc bằng .m3u8 hoặc .m3u8?
regex:\\.m3u8(\\?|$)</code></pre><h3>Rule Lọc URL Blob</h3><p>Sử dụng tiền tố <code>regex:blob:</code> để lọc chính URL của blob (phần origin của nó). Tính năng bắt blob chỉ được kích hoạt nếu có ít nhất một rule loại này.</p><pre><code># Chỉ giữ lại các blob được tạo từ domain 'kjl.bit'
# Sẽ khớp với 'blob:https://kjl.bit/...'
regex:blob:kjl\\.bit

# Chỉ giữ lại các blob được tạo từ domain có chứa 'phimmoi'
regex:blob:phimmoi</code></pre></div><h2><span class="badge badge-get">GET</span> /api/scrape</h2><div class="endpoint"><h3>Ví dụ</h3><pre><code>curl "http://localhost:3000/api/scrape?url=...&key=..."</code></pre></div></body></html>`;

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
