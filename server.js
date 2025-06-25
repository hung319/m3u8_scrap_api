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

// --- CÁC HÀM HELPER VÀ LÕI (Không thay đổi nhiều) ---
const updateDetectionRules = async () => { /* ... giữ nguyên như cũ ... */ };
const apiKeyMiddleware = (req, res, next) => { /* ... giữ nguyên như cũ ... */ };
async function uploadToDpaste(content) { /* ... giữ nguyên như cũ ... */ };

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
            headers: { ...form.getHeaders() },
            httpAgent: agent,
            httpsAgent: agent
        });
        return `${data.trim()}/raw`;
    } catch (error) {
        console.error('[DPASTE] Lỗi khi tải lên:', error.message);
        return null;
    }
}


// --- LOGIC SCRAPE CHÍNH (PHIÊN BẢN SIÊU CẤP) ---
async function handleScrapeRequest(targetUrl, headers) {
    if (!browserInstance) {
        throw new Error("Trình duyệt chưa sẵn sàng. Vui lòng thử lại sau giây lát.");
    }

    let page = null;
    const foundLinks = new Set();
    
    return new Promise(async (resolve, reject) => {
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
            console.log(`[PAGE] Đang mở trang mới cho: ${targetUrl}`);
            page = await browserInstance.newPage();

            // <<< CẢI TIẾN LỚN #1: Bắt Blob URL bằng cách ghi đè JS >>>
            // Hàm này sẽ được gọi từ phía trình duyệt khi nó phát hiện blob
            await page.exposeFunction('onBlobCreated', async (blobUrl) => {
                if (resolved) return;
                console.log(`[BLOB INTERCEPTOR] Đã bắt được blob URL được tạo: ${blobUrl}`);
                try {
                    const content = await page.evaluate(bUrl => fetch(bUrl).then(res => res.text()), blobUrl);
                    if (content && content.includes('#EXTM3U')) {
                        console.log('[BLOB INTERCEPTOR] Nội dung blob là M3U8 hợp lệ. Đang xử lý...');
                        const rawLink = await uploadToDpaste(content);
                        if (rawLink) {
                            foundLinks.add(rawLink);
                            resolveOnce(Array.from(foundLinks));
                        }
                    }
                } catch(e) {
                    console.error('[BLOB INTERCEPTOR] Lỗi khi fetch nội dung blob:', e.message);
                }
            });
            
            // Script này được tiêm vào trang TRƯỚC KHI bất kỳ script nào của trang chạy.
            await page.evaluateOnNewDocument(() => {
                const originalCreateObjectURL = URL.createObjectURL;
                URL.createObjectURL = function(blob) {
                    const url = originalCreateObjectURL.apply(this, arguments);
                    // Gọi hàm đã được expose từ Node.js
                    window.onBlobCreated(url); 
                    return url;
                };
            });

            const responseHandler = (response) => {
                if (resolved) return;
                const requestUrl = response.url();
                if (requestUrl.startsWith('data:')) return;
                const contentType = response.headers()['content-type'] || '';
                const isMatchByRule = detectionRules.some(rule => rule.test(requestUrl) || rule.test(contentType));
                if (isMatchByRule && !requestUrl.endsWith('.ts')) {
                    console.log(`[+] Đã bắt được link M3U8 (khớp với Rule): ${requestUrl}`);
                    foundLinks.add(requestUrl);
                    resolveOnce(Array.from(foundLinks));
                }
            };
            
            page.on('response', responseHandler);

            await page.setRequestInterception(true);
            page.on('request', r => resolved || ['image', 'stylesheet', 'font'].includes(r.resourceType()) ? r.abort() : r.continue());
            if (Object.keys(headers).length > 0) await page.setExtraHTTPHeaders(headers);

            console.log('[NAVIGATE] Đang điều hướng đến trang...');
            await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            if (resolved) return;

            console.log('[INTERACTION] Phân tích mạng ban đầu hoàn tất. Thử kích hoạt video...');
            
            // <<< CẢI TIẾN LỚN #2: Kích hoạt video không phụ thuộc CSS >>>
            const interactionResult = await page.evaluate(async () => {
                const video = Array.from(document.querySelectorAll('video')).find(v => v.offsetWidth > 0 || v.offsetHeight > 0);
                if (!video) return 'Không tìm thấy video nào đang hiển thị.';
                
                // Cố gắng play trực tiếp, nếu lỗi thì click (phương pháp phổ quát)
                try {
                    await video.play();
                    return 'Lệnh video.play() đã được gửi thành công.';
                } catch (err) {
                    console.warn('Lệnh video.play() thất bại (Đây là điều bình thường). Thử click()...', err.name);
                    video.click();
                    return 'Lệnh video.play() thất bại, đã thử click() để thay thế.';
                }
            });
            console.log(`[INTERACTION] Kết quả: ${interactionResult}`);

            console.log('[FINALIZE] Chờ các listener (network/blob) hoạt động hoặc chờ timeout...');

        } catch (error) {
            if (!resolved) {
                console.error(`[PAGE] Lỗi nghiêm trọng khi xử lý ${targetUrl}:`, error.message);
                resolveOnce(Array.from(foundLinks));
            }
        }
    });
}

// --- API ENDPOINTS VÀ SERVER STARTUP (Giữ nguyên) ---
app.all('/api/scrape', apiKeyMiddleware, async (req, res) => { /* ... giữ nguyên như cũ ... */ });
const initializeBrowser = async () => { /* ... giữ nguyên như cũ ... */ };
const startServer = async () => { /* ... giữ nguyên như cũ ... */ };
const docsHtml = `...`; // Giữ nguyên HTML docs

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
        '--autoplay-policy=no-user-gesture-required' // Thử thêm cờ này để dễ play video hơn
    ];
    if (globalProxyUrl) launchArgs.push(`--proxy-server=${globalProxyUrl}`);

    try {
        browserInstance = await puppeteer.launch({
            headless: "new",
            args: launchArgs,
            executablePath: process.env.CHROME_BIN || null, 
            userDataDir: '/usr/src/app/.browser-cache',
            ignoreDefaultArgs: ['--mute-audio'] // Cho phép video có tiếng, đôi khi cần thiết
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
