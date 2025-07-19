// --- KHỞI TẠO VÀ IMPORT CÁC THƯ VIỆN ---
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

// --- CẤU HÌNH SERVER TỪ BIẾN MÔI TRƯỜNG ---
const { API_KEY, P_IP, P_PORT, P_USER, P_PASSWORD, RULE_URL, RULE_UPDATE_INTERVAL } = process.env;
let globalProxyUrl = null;
if (P_IP && P_PORT) {
    const authPart = (P_USER && P_PASSWORD) ? `${P_USER}:${P_PASSWORD}@` : '';
    globalProxyUrl = `socks5://${authPart}${P_IP}:${P_PORT}`;
}
if (!API_KEY) console.warn('[SECURITY WARNING] API_KEY chưa được thiết lập!');

// --- BIẾN TOÀN CỤC CHO TRÌNH DUYỆT VÀ QUẢN LÝ RULE ---
let browserInstance = null;
let networkDetectionRules = [/application\/(vnd\.apple\.mpegurl|x-mpegurl)/i];
let blobUrlFilterRules = [];
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
// --- KỊCH BẢN BYPASS ANTI-DEVTOOL ---
const antiAntiDebugScript = `!(() => {
    console.log("Anti-anti-debug loaded! Happy debugging!")
    const Proxy = window.Proxy;
    const Object = window.Object;
    const Array = window.Array;
    /**
     * Save original methods before we override them
     */
    const Originals = {
        createElement: document.createElement,
        log: console.log,
        warn: console.warn,
        table: console.table,
        clear: console.clear,
        functionConstructor: window.Function.prototype.constructor,
        setInterval: window.setInterval,
        createElement: document.createElement,
        toString: Function.prototype.toString,
        addEventListener: window.addEventListener
    }

    /**
     * Cutoffs for logging. After cutoff is reached, will no longer log anti debug warnings.
     */
    const cutoffs = {
        table: {
            amount: 5,
            within: 5000
        },
        clear: {
            amount: 5,
            within: 5000
        },
        redactedLog: {
            amount: 5,
            within: 5000
        },
        debugger: {
            amount: 10,
            within: 10000
        },
        debuggerThrow: {
            amount: 10,
            within: 10000
        }
    }

    /**
     * Decides if anti debug warnings should be logged
     */
    function shouldLog(type) {
        const cutoff = cutoffs[type];
        if (cutoff.tripped) return false;
        cutoff.current = cutoff.current || 0;
        const now = Date.now();
        cutoff.last = cutoff.last || now;

        if (now - cutoff.last > cutoff.within) {
            cutoff.current = 0;
        }

        cutoff.last = now;
        cutoff.current++;

        if (cutoff.current > cutoff.amount) {
            Originals.warn("Limit reached! Will now ignore " + type)
            cutoff.tripped = true;
            return false;
        }

        return true;
    }

    window.console.log = wrapFn((...args) => {
        // Keep track of redacted arguments
        let redactedCount = 0;

        // Filter arguments for detectors
        const newArgs = args.map((a) => {

            // Don't print functions.
            if (typeof a === 'function') {
                redactedCount++;
                return "Redacted Function";
            }

            // Passthrough if primitive
            if (typeof a !== 'object' || a === null) return a;

            // For objects, scan properties
            var props = Object.getOwnPropertyDescriptors(a)
            for (var name in props) {

                // Redact custom getters
                if (props[name].get !== undefined) {
                    redactedCount++;
                    return "Redacted Getter";
                }

                // Also block toString overrides
                if (name === 'toString') {
                    redactedCount++;
                    return "Redacted Str";
                }
            }

            // Defeat Performance Detector
            // https://github.com/theajack/disable-devtool/blob/master/src/detector/sub-detector/performance.ts
            if (Array.isArray(a) && a.length === 50 && typeof a[0] === "object") {
                redactedCount++;
                return "Redacted LargeObjArray";
            }

            return a;
        });

        // If most arguments are redacted, its probably spam
        if (redactedCount >= Math.max(args.length - 1, 1)) {
            if (!shouldLog("redactedLog")) {
                return;
            }
        }

        return Originals.log.apply(console, newArgs)
    }, Originals.log);

    window.console.table = wrapFn((obj) => {
        if (shouldLog("table")) {
            Originals.warn("Redacted table");
        }
    }, Originals.table);

    window.console.clear = wrapFn(() => {
        if (shouldLog("table")) {
            Originals.warn("Prevented clear");
        }
    }, Originals.clear);

    let debugCount = 0;
    window.Function.prototype.constructor = wrapFn((...args) => {
        const originalFn = Originals.functionConstructor.apply(this, args);
        var fnContent = args[0];
        if (fnContent) {
            if (fnContent.includes('debugger')) { // An anti-debugger is attempting to stop debugging
                if (shouldLog("debugger")) {
                    Originals.warn("Prevented debugger");
                }
                debugCount++;
                if (debugCount > 100) {
                    if (shouldLog("debuggerThrow")) {
                        Originals.warn("Debugger loop detected! Throwing error to stop execution");
                    }
                    throw new Error("You bad!");
                } else {
                    setTimeout(() => {
                        debugCount--;
                    }, 1);
                }
                const newArgs = args.slice(0);
                newArgs[0] = args[0].replaceAll("debugger", ""); // remove debugger statements
                return new Proxy(Originals.functionConstructor.apply(this, newArgs),{
                    get: function (target, prop) {
                        if (prop === "toString") {
                            return originalFn.toString;
                        }
                        return target[prop];
                    }
                });
            }
        }
        return originalFn;
    }, Originals.functionConstructor);

    document.createElement = wrapFn((el, o) => {
        var string = el.toString();
        var element = Originals.createElement.apply(document, [string, o]);
        if (string.toLowerCase() === "iframe") {
            element.addEventListener("load", () => {
                try {
                    element.contentWindow.window.console = window.console;
                } catch (e) {

                }
            });
        }
        return element;
    }, Originals.createElement);

    function wrapFn(newFn, old) {
        return new Proxy(newFn, {
            get: function (target, prop) {
                const callMethods = ['apply', 'bind', 'call'];
                if (callMethods.includes(prop)) {
                    return target[prop];
                }
                return old[prop];
            }
        });
    }
})()`;


// --- CÁC HÀM HELPER VÀ LỖI ---
const updateDetectionRules = async () => {
    networkDetectionRules = [/application\/(vnd\.apple\.mpegurl|x-mpegurl)/i];
    blockedUrlFilterRules = []; // New array to store blocked URL rules
    if (!RULE_URL) return console.log('[RULE MANAGER] Không có RULE_URL. Chỉ dùng rule content-type mặc định.');
    console.log(`[RULE MANAGER] Đang cập nhật rule từ: ${RULE_URL}`);
    try {
        const { data } = await axios.get(RULE_URL);
        const allRules = data.split('\n').map(l => l.trim().toLowerCase()).filter(Boolean);
        const networkRulesRaw = allRules.filter(r => r.startsWith('al:'));
        const blockedRulesRaw = allRules.filter(r => r.startsWith('bl:'));
        networkRulesRaw.forEach(r => {
            const ruleStr = r.substring(3).trim();
            try { networkDetectionRules.push(new RegExp(ruleStr, 'i')); }
            catch (e) { console.error(`[RULE MANAGER] Lỗi cú Pháp rule mạng: "${r}". Bỏ qua.`); }
        });
        blockedRulesRaw.forEach(r => {
            const ruleStr = r.substring(3).trim();
            try { blockedUrlFilterRules.push(new RegExp(ruleStr, 'i')); }
            catch (e) { console.error(`[RULE MANAGER] Lỗi cú pháp rule chặn: "${r}". Bỏ qua.`); }
        });
        console.log(`[RULE MANAGER] Cập nhật thành công! ${networkDetectionRules.length} rule mạng, ${blockedUrlFilterRules.length} rule chặn.`);
    } catch (error) {
        console.error(`[RULE MANAGER] Lỗi khi tải file rule: ${error.message}`);
    }
};

const handleResponse = (response, foundLinks) => {
    const requestUrl = response.url();
    if (requestUrl.startsWith('data:')) return;
    const contentType = response.headers()['content-type'] || '';
    const isBlockedByRule = blockedUrlFilterRules.some(rule => rule.test(requestUrl));
    const isMatchByRule = networkDetectionRules.some(rule => rule.test(requestUrl) || rule.test(contentType));
    if (isBlockedByRule) {
        console.log(`[-] Đã chặn link: ${requestUrl}`);
        return;
    }
    if (isMatchByRule && !requestUrl.endsWith('.ts')) {
        console.log(`[+] Đã bắt được link M3U8 (khớp với Rule): ${requestUrl}`);
        foundLinks.add(requestUrl);
    }
};

// --- Upload nội dung lên dpaste.org ---
async function uploadToDpaste(content) {
    try {
        const form = new FormData();
        form.append('data', content);
        form.append('exp', '12h'); // 12-hour expiration
        const { data } = await axios.post('https://text.h4rs.dpdns.org/', form, { headers: { ...form.getHeaders() } });
        return `${data.trim()}`; // Assuming the response is just the raw URL
    } catch (error) {
        console.error('[TEXT UPLOAD] Lỗi khi tải lên:', error.message);
        return null;
    }
}

const apiKeyMiddleware = (req, res, next) => {
    if (!API_KEY) return res.status(503).json({ success: false, message: 'Dịch vụ không được cấu hình.' });
    if (req.query.key === API_KEY) return next();
    res.status(401).json({ success: false, message: 'Unauthorized: API Key không hợp lệ hoặc bị thiếu.' });
};


const universalAutoplayScript = `
    async function universalAutoplay() {
        const SCRIPT_PREFIX = '[🤖 Universal Autoplay]';
        console.log(SCRIPT_PREFIX, 'Bắt đầu chạy kịch bản autoplay thông minh...');
        let interactionHappened = false;
        const handleJwPlayer = (videoElement) => {
            if (typeof jwplayer !== 'function' || !jwplayer().getState) return false;
            try {
                const playerInstance = jwplayer(videoElement.id || undefined);
                if (playerInstance && playerInstance.getState() !== 'playing') {
                    playerInstance.play(true).catch(() => {
                        playerInstance.setMute(true);
                        playerInstance.play(true);
                    });
                    return true;
                }
            } catch (e) {}
            return false;
        };
        const handleVideoJs = (videoElement) => {
            if (typeof videojs !== 'function') return false;
            try {
                const player = videojs.getPlayer(videoElement.id);
                if (player && player.paused()) {
                    player.play().catch(() => {
                        player.muted(true);
                        player.play();
                    });
                    return true;
                }
            } catch(e) {}
            return false;
        };
        const handlePlyr = (videoElement) => {
            const playerContainer = videoElement.closest('.plyr');
            if (playerContainer && playerContainer.__plyr) {
                const player = playerContainer.__plyr;
                if (player.paused) {
                    player.play().catch(() => {
                        player.muted = true;
                        player.play();
                    });
                    return true;
                }
            }
            return false;
        };
        const handleGenericVideo = async (videoElement) => {
            try {
                await videoElement.play();
                interactionHappened = true;
                return;
            } catch (error) {
                if (error.name === 'NotAllowedError') {
                    videoElement.muted = true;
                    await videoElement.play();
                    interactionHappened = true;
                    return;
                }
            }
            const container = videoElement.closest('div, article, main') || document.body;
            const playButton = container.querySelector('[class*="play"], [aria-label*="Play"], [aria-label*="Phát"], [data-plyr="play"]');
            if (playButton) {
                playButton.click();
                interactionHappened = true;
            }
        };
        const videos = document.querySelectorAll('video');
        for (const video of videos) {
            if (!video.paused || video.readyState < 2) continue;
            if (!handleJwPlayer(video) && !handleVideoJs(video) && !handlePlyr(video)) {
                await handleGenericVideo(video);
            }
        }
        return interactionHappened;
    }
    universalAutoplay();
`;

// --- LOGIC SCRAPE CHÍNH ---
async function handleScrapeRequest(targetUrl, headers) {
    if (!browserInstance) throw new Error("Trình duyệt chưa sẵn sàng.");
    let page = null;
    const foundLinks = new Set();
    console.log(`[PAGE] Đang mở trang mới cho: ${targetUrl}`);
    try {
        page = await browserInstance.newPage();
        await page.setUserAgent(DEFAULT_USER_AGENT);

        // --- TÍCH HỢP ANTI-ANTI-DEBUG ---
        // Tiêm kịch bản anti-anti-debug ngay khi tài liệu được tạo
        // để vô hiệu hóa các cơ chế bảo vệ trước khi chúng kịp chạy.
        await page.evaluateOnNewDocument(antiAntiDebugScript);
        
        page.on('console', msg => console.log('PAGE LOG:', msg.text()));
        await page.setRequestInterception(true);
        page.on('request', r => ['image', 'stylesheet', 'font'].includes(r.resourceType()) ? r.abort() : r.continue());
        if (Object.keys(headers).length > 0) await page.setExtraHTTPHeaders(headers);
        page.on('response', r => handleResponse(r, foundLinks));
        page.on('framecreated', async f => f.on('response', r => handleResponse(r, foundLinks)));
        
        // GIAI ĐOẠN 1
        console.log('[GIAI ĐOẠN 1] Đang lắng nghe link mạng...');
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        if (foundLinks.size > 0) return Array.from(foundLinks);
        
        // GIAI ĐOẠN 2
        console.log('[GIAI ĐOẠN 2] Thực thi Universal Autoplay Script...');
        await page.evaluate(universalAutoplayScript);
        await new Promise(resolve => setTimeout(resolve, 5000));
        if (foundLinks.size > 0) return Array.from(foundLinks);
        
        // GIAI ĐOẠN 3
        console.log('[GIAI ĐOẠN 3] Chuyển sang bắt Blob...');
        if (blobUrlFilterRules.length === 0) return Array.from(foundLinks);
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
        await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
        await page.evaluate(universalAutoplayScript);
        await new Promise(resolve => setTimeout(resolve, 5000));
        const blobUrlsFromDOM = await page.$$eval('video, audio', els => els.map(el => el.src).filter(src => src && src.startsWith('blob:')));
        const allBlobUrlsToScan = new Set([...interceptedBlobUrls, ...blobUrlsFromDOM]);
        if (allBlobUrlsToScan.size > 0) {
            for (const blobUrl of allBlobUrlsToScan) {
                const isUrlMatch = blobUrlFilterRules.some(rule => rule.test(blobUrl));
                if (!isUrlMatch) continue;
                const blobContent = await page.evaluate(async (bUrl) => {
                    try {
                        const response = await fetch(bUrl);
                        if (response.ok) return await response.text();
                        return null;
                    } catch (e) { return null; }
                }, blobUrl);
                if (blobContent) {
                    console.log(`[DPASTE] Đang tải nội dung từ ${blobUrl} lên dpaste.org...`);
                    const rawLink = await uploadToDpaste(blobContent);
                    if (rawLink) {
                        console.log(`[DPASTE] Tải lên thành công: ${rawLink}`);
                        foundLinks.add(rawLink);
                    }
                }
            }
        }
        return Array.from(foundLinks);
    } catch (error) {
        console.error(`[PAGE] Lỗi nghiêm trọng khi xử lý trang ${targetUrl}:`, error.message);
        return [];
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
    const links = await handleScrapeRequest(url, headers);
    handleApiResponse(res, links, url);
});

app.post('/api/scrape', apiKeyMiddleware, async (req, res) => {
    const { url, headers = {} } = req.body;
    if (!url) return res.status(400).json({ success: false, message: 'Vui lòng cung cấp "url".' });
    const links = await handleScrapeRequest(url, headers);
    handleApiResponse(res, links, url);
});

const handleApiResponse = (res, links, url) => {
    if (links.length > 0) {
        res.json({ success: true, count: links.length, source: url, links });
    } else {
        res.json({ success: false, message: 'Không tìm thấy link M3U8 nào.', source: url, links: [] });
    }
};

// --- DOCS & START SERVER ---
const docsHtml = `<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>API Docs - M3U8 Scraper</title>
    <style>
        :root {
            --bg-color: #f8f9fa;
            --text-color: #212529;
            --primary-color: #0d6efd;
            --card-bg: #ffffff;
            --card-border: #dee2e6;
            --code-bg: #e9ecef;
            --code-color: #d63384;
            --badge-get-bg: #0d6efd;
            --badge-post-bg: #198754;
            --badge-text-color: #ffffff;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            line-height: 1.6;
            margin: 0;
            padding: 0;
            background-color: var(--bg-color);
            color: var(--text-color);
        }
        .container {
            max-width: 960px;
            margin: 0 auto;
            padding: 2rem;
        }
        header {
            text-align: center;
            border-bottom: 1px solid var(--card-border);
            padding-bottom: 2rem;
            margin-bottom: 2rem;
        }
        h1 {
            font-size: 2.5rem;
            color: var(--text-color);
        }
        h2 {
            font-size: 1.75rem;
            border-bottom: 1px solid var(--card-border);
            padding-bottom: 0.5rem;
            margin-top: 2.5rem;
            margin-bottom: 1.5rem;
        }
        h3 {
            font-size: 1.5rem;
            margin-top: 2rem;
            margin-bottom: 1rem;
        }
        .section {
            background-color: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 8px;
            padding: 1.5rem;
            margin-bottom: 1.5rem;
            box-shadow: 0 2px 4px rgba(0,0,0,0.05);
        }
        code {
            background-color: var(--code-bg);
            color: var(--code-color);
            padding: 0.2em 0.4em;
            border-radius: 4px;
            font-family: "SF Mono", "Fira Code", "Courier New", monospace;
        }
        pre {
            background-color: #212529;
            color: #f8f9fa;
            padding: 1rem;
            border-radius: 5px;
            white-space: pre-wrap;
            word-wrap: break-word;
            border: 1px solid var(--card-border);
        }
        .badge {
            display: inline-block;
            padding: 0.35em 0.65em;
            font-size: 0.75em;
            font-weight: 700;
            line-height: 1;
            color: var(--badge-text-color);
            text-align: center;
            white-space: nowrap;
            vertical-align: baseline;
            border-radius: 0.25rem;
            margin-right: 0.5rem;
        }
        .badge-get { background-color: var(--badge-get-bg); }
        .badge-post { background-color: var(--badge-post-bg); }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 1rem;
        }
        th, td {
            text-align: left;
            padding: 0.75rem;
            border-bottom: 1px solid var(--card-border);
        }
        th { background-color: var(--bg-color); }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>M3U8 Scraper API</h1>
            <p>API cào dữ liệu link M3U8 mạnh mẽ với trình duyệt ảo, rule động và cơ chế bypass nâng cao.</p>
        </header>
        <main>
            <h2>Giới Thiệu</h2>
            <div class="section">
                <p>API này sử dụng một trình duyệt ảo (Headless Browser) để truy cập vào một <code>url</code> bất kỳ, sau đó thực thi một loạt các hành động thông minh để tìm và trích xuất các liên kết video streaming (M3U8). Nó được thiết kế để vượt qua các rào cản thông thường và cả các kỹ thuật ẩn link phức tạp.</p>
            </div>
            <h2>Xác Thực</h2>
            <div class="section">
                <p>Tất cả các yêu cầu đến API đều phải được xác thực. Bạn cần cung cấp <code>API_KEY</code> đã được cấu hình trên server dưới dạng một tham số truy vấn (query parameter).</p>
                <p>Thêm <code>?key=YOUR_API_KEY</code> vào cuối URL của yêu cầu.</p>
                <pre><code>curl "http://localhost:3000/api/scrape?..." # SẼ BỊ TỪ CHỐI
curl "http://localhost:3000/api/scrape?url=...&key=your_super_secret_key" # HỢP LỆ</code></pre>
            </div>
            <h2>Endpoints</h2>
            <div class="section">
                <h3><span class="badge badge-get">GET</span> /api/scrape</h3>
                <p>Cào dữ liệu từ một URL bằng phương thức GET. Các tham số được truyền qua query string.</p>
                <h4>Parameters</h4>
                <table>
                    <thead>
                        <tr><th>Tên tham số</th><th>Kiểu</th><th>Mô tả</th><th>Bắt buộc</th></tr>
                    </thead>
                    <tbody>
                        <tr><td><code>url</code></td><td>string</td><td>URL của trang web bạn muốn cào.</td><td>Có</td></tr>
                        <tr><td><code>key</code></td><td>string</td><td>API Key để xác thực.</td><td>Có</td></tr>
                        <tr><td><code>referer</code></td><td>string</td><td>(Tùy chọn) Giả mạo header Referer để vượt qua một số cơ chế bảo vệ.</td><td>Không</td></tr>
                    </tbody>
                </table>
                <h4>Ví dụ sử dụng (cURL)</h4>
                <pre><code>curl -X GET "http://localhost:3000/api/scrape?url=https://example.com/video-page&key=YOUR_API_KEY"</code></pre>
            </div>
            <div class="section">
                <h3><span class="badge badge-post">POST</span> /api/scrape</h3>
                <p>Cào dữ liệu từ một URL bằng phương thức POST. Các tham số được truyền trong body của yêu cầu dưới dạng JSON. Phương thức này hữu ích khi bạn cần truyền các header phức tạp.</p>
                <h4>Request Body (JSON)</h4>
                <table>
                    <thead>
                        <tr><th>Tên thuộc tính</th><th>Kiểu</th><th>Mô tả</th><th>Bắt buộc</th></tr>
                    </thead>
                    <tbody>
                        <tr><td><code>url</code></td><td>string</td><td>URL của trang web bạn muốn cào.</td><td>Có</td></tr>
                        <tr><td><code>headers</code></td><td>object</td><td>(Tùy chọn) Một đối tượng chứa các HTTP header tùy chỉnh để gửi kèm yêu cầu (ví dụ: <code>{"Referer": "https://google.com", "User-Agent": "MyBot"}</code>).</td><td>Không</td></tr>
                    </tbody>
                </table>
                <h4>Ví dụ sử dụng (cURL)</h4>
                <pre><code>curl -X POST "http://localhost:3000/api/scrape?key=YOUR_API_KEY" \\
-H "Content-Type: application/json" \\
-d '{
  "url": "https://example.com/video-page",
  "headers": {
    "Referer": "https://some-other-site.com"
  }
}'</code></pre>
            </div>
            <h2>Phản Hồi (Responses)</h2>
            <div class="section">
                <h4>Phản hồi thành công (Success)</h4>
                <pre><code>{
  "success": true,
  "count": 1,
  "source": "https://example.com/video-page",
  "links": [
    "https://cdn.example.com/path/to/video.m3u8"
  ]
}</code></pre>
                <h4>Phản hồi thất bại (Failure)</h4>
                <pre><code>{
  "success": false,
  "message": "Không tìm thấy link M3U8 nào.",
  "source": "https://example.com/video-page",
  "links": []
}</code></pre>
            </div>
            <h2>Tính Năng Nâng Cao</h2>
            <div class="section">
                <h3>Rule Động</h3>
                <p>Hệ thống có thể tải các quy tắc nhận dạng (regex) từ một file text (được cấu hình bởi <code>RULE_URL</code>). Điều này cho phép cập nhật logic phát hiện mà không cần khởi động lại server.</p>
                <pre><code># File rules.txt
# Bắt các link mạng kết thúc bằng .m3u8
al:^https?:\\/\\/(example\\.com|example\\.co\\.uk)\\/.*\\.m3u8$
# Block các link mạng từ domain example.com
bl:^https?:\\/\\/(example\\.com|example\\.co\\.uk)\\/blocked.*$

# Bắt các blob từ domain example.com
al:blob:^https?:\\/\\/(example\\.com|example\\.co\\.uk)\\/.*$

# Block các blob từ domain example.com
bl:blob:^https?:\\/\\/(example\\.com|example\\.co\\.uk)\\/blocked.*
</code></pre>
                <h3>Bypass Anti-DevTool</h3>
                <p>API tự động tiêm một kịch bản vào trang web đích để vô hiệu hóa các kỹ thuật phổ biến mà trang web dùng để phát hiện và ngăn chặn các công cụ tự động. Kịch bản này sẽ:</p>
                <ul>
                    <li>Ghi đè các hàm <code>console</code> để tránh bị phát hiện.</li>
                    <li>Vô hiệu hóa các vòng lặp <code>debugger;</code>.</li>
                    <li>Ngăn chặn các cơ chế phát hiện dựa trên <code>toString()</code> của hàm.</li>
                </ul>
                <p>Tính năng này giúp tăng đáng kể tỉ lệ thành công trên các trang web có cơ chế bảo vệ cao.</p>
            </div>
            <h2>nodetext - Hướng Dẫn Sử Dụng API</h2>
            <div class="section">
                <h3>Ghi chú:</h3>
                <p>Dịch vụ đơn giản để lưu trữ các đoạn text tạm thời hoặc vĩnh viễn qua API.</p>
                <h3>UPLOAD MỘT FILE</h3>
                <p>Gửi một request POST đến URL với tên file bạn mong muốn.</p>
                <ul>
                    <li><strong>Method:</strong> POST</li>
                    <li><strong>URL:</strong>    /ten-file-cua-ban.txt</li>
                    <li><strong>Body:</strong>   JSON</li>
                </ul>
                <p><strong>CÁC THAM SỐ TRONG BODY:</strong></p>
                <ul>
                    <li><code>data</code> (bắt buộc): Nội dung text thô bạn muốn lưu trữ.</li>
                    <li><code>exp</code> (tùy chọn): Thời gian hết hạn. Nếu bỏ qua, file sẽ được lưu vĩnh viễn.
                        <ul>
                            <li>Định dạng: <s> (giây), <m> (phút), <h> (giờ), <d> (ngày), <mo> (tháng), <y> (năm).</li>
                            <li>Ví dụ: "60s", "30m", "12h", "7d", "1mo", "2y".</li>
                        </ul>
                    </li>
                </ul>
                <p><strong>PHẢN HỒI (RESPONSE):</strong></p>
                <p>API sẽ trả về một URL dạng text thô đến file vừa được tạo.</p>
                <p><strong>VÍ DỤ (sử dụng curl):</strong></p>
<pre><code># Tạo file hết hạn sau 5 phút
curl -X POST http://localhost:10000/vidu.txt \\
-H "Content-Type: application/json" \\
-d '{ "data": "Đây là một bài test.", "exp": "5m" }'

# Tạo file vĩnh viễn
curl -X POST http://localhost:10000/vinhvien.txt \\
-H "Content-Type: application/json" \\
-d '{ "data": "Nội dung này không bao giờ hết hạn." }'
</code></pre>
                <h3>TRUY CẬP FILE</h3>
                <p>Thực hiện một request GET đến URL được trả về từ API upload.</p>
                <ul>
                    <li><strong>Method:</strong> GET</li>
                    <li><strong>URL:</strong>    /<chuoi-ngau-nhien>/ten-file-cua-ban.txt</li>
                </ul>
                <p>và bỏ qua phần check file coi có phải m3u8 hay ko</p>
            </div>
        </main>
    </div>
</body>
</html>`;


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
    const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--single-process', '--disable-gpu', '--disable-web-security'];
    if (globalProxyUrl) launchArgs.push(`--proxy-server=${globalProxyUrl}`);
    try {
        browserInstance = await puppeteer.launch({
            headless: "new",
            args: launchArgs,
            executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', // Cho phép tùy chỉnh đường dẫn
            userDataDir: '/usr/src/app/.browser-cache'
        });
        console.log('[BROWSER] Trình duyệt đã sẵn sàng!');
    } catch (error) {
        console.error('[BROWSER] Lỗi nghiêm trọng khi khởi tạo trình duyệt:', error);
        process.exit(1);
    }
};

startServer();
