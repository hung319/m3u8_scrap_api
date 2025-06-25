require('dotenv').config();

// --- 1. KHAI BÁO THƯ VIỆN ---
const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const FormData = require('form-data');

// --- 2. KHỞI TẠO BAN ĐẦU ---
puppeteer.use(StealthPlugin());
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// --- 3. CẤU HÌNH SERVER & BIẾN TOÀN CỤC ---
const { API_KEY, P_IP, P_PORT, P_USER, P_PASSWORD, RULE_URL, RULE_UPDATE_INTERVAL, GLOBAL_TIMEOUT } = process.env;

let globalProxyUrl = null;
let agent = null;
if (P_IP && P_PORT) {
    const authPart = (P_USER && P_PASSWORD) ? `${P_USER}:${P_PASSWORD}@` : '';
    globalProxyUrl = `socks5://${authPart}${P_IP}:${P_PORT}`;
    agent = new SocksProxyAgent(globalProxyUrl);
}
if (!API_KEY) console.warn('[SECURITY WARNING] API_KEY chưa được thiết lập!');

let browserInstance = null;
let detectionRules = [/application\/(vnd\.apple\.mpegurl|x-mpegurl)/i];

// --- 4. CÁC HÀM HELPER ---

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

// --- 5. LOGIC SCRAPE CỐT LÕI ---

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
            if (page) page.close().catch(e => { /* ignore */ });
            console.log(`[OPTIMIZATION] Hoàn tất xử lý cho ${targetUrl}. Tìm thấy ${result.length} link.`);
            resolve(result);
        };

        const masterTimeout = setTimeout(() => {
            console.log(`[TIMEOUT] Quá trình vượt quá ${timeout / 1000}s. Trả về kết quả hiện tại.`);
            resolveOnce(Array.from(foundLinks));
        }, timeout);

        try {
            page = await browserInstance.newPage();

            // --- CƠ CHẾ BẮT LINK MẠNG (THEO PHONG CÁCH FILE CŨ, HIỆU QUẢ) ---
            const networkResponseHandler = (response) => {
                if (resolved) return;
                const requestUrl = response.url();
                if (requestUrl.startsWith('data:')) return;

                const contentType = response.headers()['content-type'] || '';
                const isMatchByRule = detectionRules.some(rule => rule.test(requestUrl) || rule.test(contentType));

                if (isMatchByRule && !requestUrl.endsWith('.ts')) {
                    console.log(`[+] Đã bắt được link M3U8 từ mạng (khớp với Rule): ${requestUrl}`);
                    foundLinks.add(requestUrl);
                    resolveOnce(Array.from(foundLinks));
                }
            };

            page.on('response', networkResponseHandler);
            // <<< PHỤC HỒI: Lắng nghe cả Iframe, rất quan trọng! >>>
            page.on('framecreated', async (frame) => {
                frame.on('response', networkResponseHandler);
            });


            // --- CƠ CHẾ BẮT LINK BLOB (ĐƯỢC CẢI TIẾN ĐỂ LẤY NỘI DUNG) ---
            await page.exposeFunction('onBlobUrlDetected', async (blobUrl) => {
                if (resolved) return;
                console.log(`[BLOB INTERCEPTOR] Đã bắt được blob URL: ${blobUrl}`);
                try {
                    // Sử dụng evaluate để fetch nội dung từ trong ngữ cảnh trình duyệt
                    const content = await page.evaluate(async (url) => {
                        try {
                            const response = await fetch(url);
                            return await response.text();
                        } catch (e) {
                            console.error('Error fetching blob content in browser:', e.message);
                            return null;
                        }
                    }, blobUrl);

                    if (content && content.includes('#EXTM3U')) {
                        console.log('[BLOB INTERCEPTOR] Nội dung blob là M3U8 hợp lệ. Đang xử lý...');
                        const rawLink = await uploadToDpaste(content);
                        if (rawLink) {
                            foundLinks.add(rawLink);
                            resolveOnce(Array.from(foundLinks));
                        }
                    }
                } catch (e) { 
                    console.error('[BLOB INTERCEPTOR] Lỗi khi xử lý blob:', e.message);
                }
            });

            await page.evaluateOnNewDocument(() => {
                const originalCreateObjectURL = URL.createObjectURL;
                URL.createObjectURL = function() {
                    const url = originalCreateObjectURL.apply(this, arguments);
                    if (url.startsWith('blob:') && typeof window.onBlobUrlDetected === 'function') {
                        window.onBlobUrlDetected(url);
                    }
                    return url;
                };
            });
            
            await page.setRequestInterception(true);
            page.on('request', r => resolved || ['image', 'stylesheet', 'font'].includes(r.resourceType()) ? r.abort() : r.continue());
            if (Object.keys(headers).length > 0) await page.setExtraHTTPHeaders(headers);

            console.log('[NAVIGATE] Đang điều hướng đến trang...');
            await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            
            if (resolved) {
                console.log('[OPTIMIZATION] Đã tìm thấy link trong lúc tải trang. Bỏ qua bước tương tác.');
                return;
            }

            console.log('[INTERACTION] Chưa tìm thấy link. Thử kích hoạt video...');
            await page.evaluate(async () => {
                const video = Array.from(document.querySelectorAll('video')).find(v => v.offsetWidth > 0 || v.offsetHeight > 0);
                if (video) video.click(); // Click đơn giản thường hiệu quả hơn play()
            });

            // Sau khi tương tác, chờ một chút để các sự kiện mạng cuối cùng được kích hoạt
            await new Promise(r => setTimeout(r, 3000));
            if(resolved) return;

            // --- NỖ LỰC CUỐI CÙNG (DỰ PHÒNG) ---
            console.log('[FALLBACK] Quét thủ công các thẻ video một lần cuối...');
            const finalBlobUrls = await page.$$eval('video, audio', els => els.map(el => el.src).filter(src => src && src.startsWith('blob:')));
            if(finalBlobUrls.length > 0 && !resolved){
                await page.workers()[0].client.send('onBlobUrlDetected', {blobUrl : finalBlobUrls[0]})
            }

        } catch (error) {
            if (!resolved) {
                console.error(`[PAGE] Lỗi nghiêm trọng khi xử lý ${targetUrl}:`, error.message);
                resolveOnce(Array.from(foundLinks));
            }
        }
    });
}

// --- 6. API ENDPOINTS & DOCS ---

const docsHtml = `<!DOCTYPE html><html lang="vi"><head><title>API Docs - M3U8 Scraper</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:20px;max-width:900px;margin:0 auto;color:#333}h1,h2,h3{color:#111;border-bottom:1px solid #ddd;padding-bottom:10px;margin-top:30px}code{background-color:#f4f4f4;padding:2px 6px;border-radius:4px;font-family:"Courier New",Courier,monospace;color:#c7254e}pre{background-color:#f6f8fa;padding:15px;border-radius:5px;white-space:pre-wrap;word-wrap:break-word;border:1px solid #ddd}a{color:#0366d6;text-decoration:none}a:hover{text-decoration:underline}.endpoint{border:1px solid #eee;padding:0 20px 15px;border-radius:8px;margin-bottom:20px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.05)}li{margin-bottom:10px}.badge{color:white;padding:3px 8px;border-radius:12px;font-size:.8em;font-weight:700;margin-right:8px}.badge-all{background-color:#6c757d}</style></head><body><h1>API Docs - M3U8 Scraper (Hybrid Version)</h1><p>API cào dữ liệu link M3U8 với hệ thống proxy, rule động, và cơ chế bắt link blob/network trực tiếp.</p><h2>Xác Thực</h2><div class="endpoint"><p>Mọi yêu cầu đến <code>/api/scrape</code> đều phải được xác thực bằng cách thêm tham số <code>key=YOUR_API_KEY</code> vào query string hoặc trong body của request POST.</p></div><h2><span class="badge badge-all">GET/POST</span> /api/scrape</h2><div class="endpoint"><p>Endpoint này chấp nhận cả hai phương thức GET và POST.</p><pre><code># Sử dụng GET
curl "http://localhost:3000/api/scrape?url=...&key=...&referer=..."

# Sử dụng POST
curl -X POST "http://localhost:3000/api/scrape" \
-H "Content-Type: application/json" \
-d '{"url": "...", "key": "...", "headers": {"Referer": "..."}}'</code></pre></div></body></html>`;

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

app.get('/docs', (req, res) => res.setHeader('Content-Type', 'text/html').send(docsHtml));
app.get('/', (req, res) => res.redirect('/docs'));


// --- 7. KHỞI CHẠY SERVER ---

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
    
    app.listen(PORT, () => console.log(`Server hiệu năng cao đang chạy tại http://localhost:${PORT}`));
};

startServer();
