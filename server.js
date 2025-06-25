require('dotenv').config();

const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const FormData = require('form-data');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// --- CẤU HÌNH SERVER (Không đổi) ---
const { API_KEY, P_IP, P_PORT, P_USER, P_PASSWORD, RULE_URL, RULE_UPDATE_INTERVAL } = process.env;
let globalProxyUrl = null;
if (P_IP && P_PORT) {
    const authPart = (P_USER && P_PASSWORD) ? `${P_USER}:${P_PASSWORD}@` : '';
    globalProxyUrl = `socks5://${authPart}${P_IP}:${P_PORT}`;
}
if (!API_KEY) console.warn('[SECURITY WARNING] API_KEY chưa được thiết lập!');

// --- Biến toàn cục (Không đổi) ---
let browserInstance = null;
let detectionRules = [/application\/(vnd\.apple\.mpegurl|x-mpegurl)/i, /\.m3u8(\?|$)/i];

// --- CÁC HÀM HELPER VÀ LÕI (Không đổi) ---
const updateDetectionRules = async () => {
    if (!RULE_URL) return console.log('[RULE MANAGER] Không có RULE_URL. Dùng rule mặc định.');
    console.log(`[RULE MANAGER] Đang cập nhật rule từ: ${RULE_URL}`);
    try {
        const { data } = await axios.get(RULE_URL);
        const remoteRules = data.split('\n').map(l => l.trim()).filter(l => l.toLowerCase().startsWith('regex:')).map(l => {
            try { return new RegExp(l.substring(6).trim(), 'i'); }
            catch (e) { console.error(`[RULE MANAGER] Lỗi cú pháp rule: "${l}". Bỏ qua.`); return null; }
        }).filter(Boolean);
        detectionRules = [/application\/(vnd\.apple\.mpegurl|x-mpegurl)/i, /\.m3u8(\?|$)/i, ...remoteRules];
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

// Sử dụng dpaste.org hoặc dịch vụ pastebin khác nếu cần
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

// Hàm xử lý response mạng, được giữ lại để bắt các link m3u8 trực tiếp
const handleResponse = (response, foundLinks) => {
    const requestUrl = response.url();
    if (requestUrl.startsWith('data:')) return;
    const contentType = response.headers()['content-type'] || '';
    const isMatchByRule = detectionRules.some(rule => rule.test(requestUrl) || rule.test(contentType));
    if (isMatchByRule && !requestUrl.endsWith('.ts') && !foundLinks.has(requestUrl)) {
        console.log(`[+] Đã bắt được link M3U8 (từ Network Response): ${requestUrl}`);
        foundLinks.add(requestUrl);
    }
};


// --- LOGIC SCRAPE NÂNG CẤP ---
async function handleScrapeRequestV2(targetUrl, headers) {
    if (!browserInstance) throw new Error("Trình duyệt chưa sẵn sàng.");

    let page = null;
    const foundLinks = new Set();
    // Tạo một promise sẽ được resolve khi có link, để "thoát sớm"
    let resolveEarly;
    const earlyExitPromise = new Promise(resolve => { resolveEarly = resolve; });

    console.log(`[PAGE] Đang mở trang mới cho: ${targetUrl}`);

    try {
        page = await browserInstance.newPage();

        // --- CẢI TIẾN #1: HOOK VÀO URL.createObjectURL ĐỂ BẮT BLOB M3U8 ---
        // Expose một hàm từ Node.js ra môi trường trình duyệt
        await page.exposeFunction('__onM3U8FoundInBlob', async (m3u8Content) => {
            console.log('[BLOB DETECTOR] Đã bắt được nội dung M3U8 từ một blob!');
            const rawLink = await uploadToDpaste(m3u8Content);
            if (rawLink && !foundLinks.has(rawLink)) {
                foundLinks.add(rawLink);
                console.log(`[+] Đã xử lý link từ blob: ${rawLink}`);
                resolveEarly(Array.from(foundLinks)); // Kích hoạt "thoát sớm"
            }
        });

        // Chạy script này ngay khi document được tạo, trước cả script của trang web
        await page.evaluateOnNewDocument(() => {
            const originalCreateObjectURL = URL.createObjectURL;
            URL.createObjectURL = function (blob) {
                // Chỉ xử lý các blob có type liên quan đến video/streaming
                if (blob && (blob.type.includes('mpegurl') || blob.type.includes('octet-stream'))) {
                    blob.text().then(content => {
                        if (content.trim().startsWith('#EXTM3U')) {
                            // Gọi hàm đã được expose từ Node.js
                            window.__onM3U8FoundInBlob(content);
                        }
                    });
                }
                // Vẫn gọi hàm gốc để không làm hỏng chức năng của trang
                return originalCreateObjectURL.apply(this, arguments);
            };
        });

        // Tối ưu hóa: Chặn các tài nguyên không cần thiết
        await page.setRequestInterception(true);
        page.on('request', r => ['image', 'stylesheet', 'font', 'media'].includes(r.resourceType()) ? r.abort() : r.continue());
        if (Object.keys(headers).length > 0) await page.setExtraHTTPHeaders(headers);

        // Giữ lại listener cho response để bắt các link trực tiếp
        page.on('response', r => handleResponse(r, foundLinks));
        page.on('framecreated', async f => f.on('response', r => handleResponse(r, foundLinks)));
        
        console.log('[PAGE] Đang điều hướng và chờ...');
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45000 });

        if (foundLinks.size > 0) {
            console.log('[OPTIMIZATION] Tìm thấy link mạng trong lúc tải trang. Trả về ngay.');
            return Array.from(foundLinks);
        }

        // --- CẢI TIẾN #2: RÚT NGẮN THỜI GIAN CHỜ VÀ TĂNG CƯỜNG TƯƠNG TÁC ---
        console.log('[INTERACTION] Thử tương tác với video player...');
        try {
            // Selector mạnh hơn, bao gồm cả các nút của JW Player
            const playButtonSelector = [
                'video',
                '[aria-label*="Play"]',
                '[aria-label*="Phát"]',
                '[class*="play"]',
                '[class*="jw-icon-display"]', // Dành cho JW Player
                '[role="button"][aria-label*="Play"]'
            ].join(', ');
            
            const elementToClick = await page.waitForSelector(playButtonSelector, { timeout: 5000, visible: true });
            if (elementToClick) {
                await elementToClick.click();
                console.log("[INTERACTION] Đã click vào trình phát video.");
            }
        } catch (e) {
            console.log("[INTERACTION] Không tìm thấy nút play hoặc video rõ ràng để click.");
        }
        
        // Chờ kết quả từ các hành động (tải trang, click, hook blob)
        // Sẽ chờ tối đa 10 giây hoặc cho đến khi `resolveEarly` được gọi
        console.log('[PAGE] Đang chờ kết quả cuối cùng...');
        const result = await Promise.race([
            earlyExitPromise,
            new Promise(resolve => setTimeout(() => resolve(Array.from(foundLinks)), 10000))
        ]);

        return result;

    } catch (error) {
        console.error(`[PAGE] Lỗi khi xử lý trang ${targetUrl}:`, error.message);
        return [];
    } finally {
        if (page) await page.close();
        console.log(`[PAGE] Đã đóng trang cho: ${targetUrl}`);
    }
}

// --- API ENDPOINTS (Sử dụng logic V2) ---
app.all('/api/scrape', apiKeyMiddleware, async (req, res) => {
    const { url, headers = {} } = { ...req.query, ...req.body };
    if (!url) return res.status(400).json({ success: false, message: 'Vui lòng cung cấp "url".' });

    // Hợp nhất referer từ query vào headers nếu có
    if (req.query.referer && !headers.Referer) {
        headers.Referer = req.query.referer;
    }

    const links = await handleScrapeRequestV2(url, headers);
    handleApiResponse(res, links, url);
});

const handleApiResponse = (res, links, url) => {
    if (links.length > 0) {
        // Loại bỏ các link trùng lặp lần cuối
        const uniqueLinks = [...new Set(links)];
        res.json({ success: true, count: uniqueLinks.length, source: url, links: uniqueLinks });
    } else {
        res.json({ success: false, message: 'Không tìm thấy link M3U8 nào.', source: url, links: [] });
    }
};

// --- DOCS & START SERVER (Không đổi) ---
const docsHtml = `<!DOCTYPE html><html lang="vi"><head><title>API Docs - M3U8 Scraper v2</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:20px;max-width:900px;margin:0 auto;color:#333}h1,h2,h3{color:#111;border-bottom:1px solid #ddd;padding-bottom:10px;margin-top:30px}code{background-color:#f4f4f4;padding:2px 6px;border-radius:4px;font-family:"Courier New",Courier,monospace;color:#c7254e}pre{background-color:#f6f8fa;padding:15px;border-radius:5px;white-space:pre-wrap;word-wrap:break-word;border:1px solid #ddd}a{color:#0366d6;text-decoration:none}a:hover{text-decoration:underline}.endpoint{border:1px solid #eee;padding:0 20px 15px;border-radius:8px;margin-bottom:20px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.05)}li{margin-bottom:10px}.badge{color:white;padding:3px 8px;border-radius:12px;font-size:.8em;font-weight:700;margin-right:8px}.badge-all{background-color:#28a745}</style></head><body><h1>API Docs - M3U8 Scraper v2</h1><p>API cào dữ liệu link M3U8 với hệ thống proxy, rule động, xác thực và <strong>xử lý blob URL chủ động</strong>.</p><h2>Xác Thực</h2><div class="endpoint"><p>Mọi yêu cầu đến <code>/api/scrape</code> đều phải được xác thực bằng cách thêm tham số <code>key=YOUR_API_KEY</code> vào query string.</p></div><h2><span class="badge badge-all">GET/POST</span> /api/scrape</h2><div class="endpoint"><p>Endpoint chấp nhận cả GET và POST.</p><h3>Ví dụ (POST)</h3><pre><code>curl -X POST "http://localhost:3000/api/scrape?key=..." \\\n-H "Content-Type: application/json" \\\n-d '{"url": "...", "headers": {"Referer": "..."}}'</code></pre></div></body></html>`;

const startServer = async () => {
    await initializeBrowser();
    await updateDetectionRules();
    const updateIntervalMinutes = parseInt(RULE_UPDATE_INTERVAL, 10) || 60;
    setInterval(updateDetectionRules, updateIntervalMinutes * 60 * 1000);
    console.log(`[RULE MANAGER] Đã lên lịch cập nhật rule mỗi ${updateIntervalMinutes} phút.`);
    app.get('/docs', (req, res) => res.setHeader('Content-Type', 'text/html').send(docsHtml));
    app.get('/', (req, res) => res.redirect('/docs'));
    app.listen(PORT, () => console.log(`Server v2 hiệu năng cao đang chạy tại http://localhost:${PORT}`));
};

const initializeBrowser = async () => {
    console.log('[BROWSER] Đang khởi tạo instance trình duyệt toàn cục...');
    const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--single-process', '--disable-gpu'];
    if (globalProxyUrl) launchArgs.push(`--proxy-server=${globalProxyUrl}`);
    try {
        browserInstance = await puppeteer.launch({
            headless: "new",
            args: launchArgs,
            executablePath: process.env.CHROME_BIN || '/usr/bin/chromium' // Linh hoạt hơn
        });
        console.log('[BROWSER] Trình duyệt đã sẵn sàng!');
    } catch (error) {
        console.error('[BROWSER] Lỗi nghiêm trọng khi khởi tạo trình duyệt:', error);
        process.exit(1);
    }
};

startServer();
