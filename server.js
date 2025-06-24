// server.js (phiên bản cuối cùng, sẵn sàng cho Docker)

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
    console.warn('[SECURITY WARNING] API_KEY chưa được thiết lập! Các endpoint API sẽ không thể truy cập.');
}

const wildcardToRegex = (pattern) => {
    const escapedPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const regexString = escapedPattern.replace(/\*/g, '.*');
    return new RegExp(`^${regexString}$`, 'i');
};

const defaultRules = [
    wildcardToRegex('*.m3u8'),
    wildcardToRegex('*.m3u'),
    /application\/(vnd\.apple\.mpegurl|x-mpegurl)/i
];
let detectionRules = [...defaultRules];

const updateDetectionRules = async () => {
    if (!RULE_URL) {
        console.log('[RULE MANAGER] Không có RULE_URL. Sử dụng các rule mặc định.');
        return;
    }
    console.log(`[RULE MANAGER] Đang cập nhật các rule phát hiện từ: ${RULE_URL}`);
    try {
        const response = await axios.get(RULE_URL);
        const textList = response.data;
        const remoteRules = textList.split('\n').map(line => line.trim()).filter(line => line.length > 0 && !line.startsWith('#')).map(line => {
            try {
                if (line.toLowerCase().startsWith('regex:')) {
                    return new RegExp(line.substring(6).trim(), 'i');
                } else {
                    return wildcardToRegex(line);
                }
            } catch (e) {
                console.error(`[RULE MANAGER] Lỗi cú pháp rule: "${line}". Bỏ qua.`);
                return null;
            }
        }).filter(Boolean);
        if (remoteRules.length > 0) {
            detectionRules = [...defaultRules, ...remoteRules];
            console.log(`[RULE MANAGER] Cập nhật thành công! Tổng số rule đang hoạt động: ${detectionRules.length}`);
        }
    } catch (error) {
        console.error(`[RULE MANAGER] Lỗi khi tải file rule: ${error.message}`);
    }
};

// --- CÁC HÀM HELPER VÀ LÕI ---
const apiKeyMiddleware = (req, res, next) => {
    if (!API_KEY) {
        return res.status(503).json({ success: false, message: 'Dịch vụ không được cấu hình.' });
    }
    if (req.query.key && req.query.key === API_KEY) {
        next();
    } else {
        res.status(401).json({ success: false, message: 'Unauthorized: API Key không hợp lệ hoặc bị thiếu.' });
    }
};

async function uploadToDpaste(content) {
    try {
        const form = new FormData();
        form.append('content', content);
        form.append('syntax', 'text');
        form.append('expiry_days', '1');
        const response = await axios.post('https://dpaste.org/api/', form, { headers: { ...form.getHeaders() } });
        const dpasteUrl = response.data.trim();
        return `${dpasteUrl}/raw`;
    } catch (error) {
        console.error('[DPASTE] Lỗi khi tải lên:', error.message);
        return null;
    }
}

const handleResponse = (response, foundLinks) => {
    const requestUrl = response.url();
    const contentType = response.headers()['content-type'] || '';
    const isMatch = detectionRules.some(rule => rule.test(requestUrl) || rule.test(contentType));
    if (isMatch && !requestUrl.endsWith('.ts')) {
        console.log(`[+] Đã bắt được link M3U8 (khớp với rule): ${requestUrl}`);
        foundLinks.add(requestUrl);
    }
};

async function findM3u8LinksWithPuppeteer(targetUrl, customHeaders = {}) {
    const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
    if (globalProxyUrl) {
        launchArgs.push(`--proxy-server=${globalProxyUrl}`);
    }
    const foundLinks = new Set();
    let browser = null;
    try {
        browser = await puppeteer.launch({ headless: "new", args: launchArgs });
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            if (['image', 'stylesheet', 'font'].includes(request.resourceType())) {
                request.abort();
            } else {
                request.continue();
            }
        });
        if (Object.keys(customHeaders).length > 0) {
            await page.setExtraHTTPHeaders(customHeaders);
        }
        page.on('response', (response) => handleResponse(response, foundLinks));
        page.on('framecreated', async (frame) => {
            frame.on('response', (response) => handleResponse(response, foundLinks));
        });
        await page.goto(targetUrl, { waitUntil: 'networkidle0', timeout: 60000 });
        await new Promise(resolve => setTimeout(resolve, 5000));

        const mediaSrcs = await page.$$eval('video, audio', elements => elements.map(el => el.src));
        const blobUrls = mediaSrcs.filter(src => src && src.startsWith('blob:'));
        if (blobUrls.length > 0) {
            for (const blobUrl of blobUrls) {
                const m3u8Content = await page.evaluate(async (bUrl) => {
                    try { return await (await fetch(bUrl)).text(); } catch (e) { return null; }
                }, blobUrl);
                if (m3u8Content && m3u8Content.includes('#EXTM3U')) {
                    const rawLink = await uploadToDpaste(m3u8Content);
                    if (rawLink) foundLinks.add(rawLink);
                }
            }
        }
        return Array.from(foundLinks);
    } catch (error) {
        console.error(`[PUPPETEER] Lỗi:`, error.message);
        return [];
    } finally {
        if (browser) await browser.close();
    }
}

async function handleScrapeRequest(targetUrl, headers, hasJs) {
    if (hasJs) {
        return await findM3u8LinksWithPuppeteer(targetUrl, headers);
    } else {
        // Axios mode is not implemented in this final version for brevity, 
        // as Puppeteer handles all cases. Can be added back if needed.
        return await findM3u8LinksWithPuppeteer(targetUrl, headers);
    }
}

// --- API ENDPOINTS ---
const handleApiResponse = (res, links, mode, url) => {
    if (links.length > 0) {
        res.json({ success: true, mode, count: links.length, source: url, links });
    } else {
        res.json({ success: false, mode, message: 'Không tìm thấy link M3U8 nào.', source: url, links: [] });
    }
};

app.post('/api/scrape', apiKeyMiddleware, async (req, res) => {
    const { url, headers = {}, hasJs = true } = req.body;
    if (!url) return res.status(400).json({ success: false, message: 'Vui lòng cung cấp "url".' });
    const links = await handleScrapeRequest(url, headers, hasJs);
    handleApiResponse(res, links, hasJs ? 'puppeteer' : 'axios', url);
});

app.get('/api/scrape', apiKeyMiddleware, async (req, res) => {
    const { url, hasJs, referer } = req.query;
    if (!url) return res.status(400).json({ success: false, message: 'Vui lòng cung cấp tham số "url".' });
    const headers = referer ? { Referer: referer } : {};
    const links = await handleScrapeRequest(url, headers, hasJs === 'true');
    handleApiResponse(res, links, hasJs === 'true' ? 'puppeteer' : 'axios', url);
});

// --- DOCS PAGE ---
const docsHtml = `<!DOCTYPE html><html lang="vi"><head><title>API Docs - M3U8 Scraper</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:20px;max-width:800px;margin:0 auto;color:#333}h1,h2,h3{color:#111;border-bottom:1px solid #ddd;padding-bottom:10px}code{background-color:#f4f4f4;padding:2px 6px;border-radius:4px;font-family:"Courier New",Courier,monospace}pre{background-color:#f4f4f4;padding:15px;border-radius:5px;white-space:pre-wrap;word-wrap:break-word}a{color:#007bff;text-decoration:none}a:hover{text-decoration:underline}.endpoint{border:1px solid #eee;padding:15px;border-radius:5px;margin-bottom:20px}li{margin-bottom:5px}</style></head><body><h1>Tài Liệu API - M3U8 Scraper</h1><p>API cào dữ liệu link M3U8 với hệ thống proxy, rule động, xác thực và tự động xử lý blob URL.</p><h2>Xác Thực</h2><div class="endpoint"><p>Mọi yêu cầu đến <code>/api/scrape</code> phải có tham số <code>?key=YOUR_API_KEY</code>.</p></div><h2>Cấu Hình Server (.env)</h2><div class="endpoint"><p><strong>Proxy:</strong> <code>P_IP</code>, <code>P_PORT</code>, <code>P_USER</code>, <code>P_PASSWORD</code></p><p><strong>Rule Động:</strong> <code>RULE_URL</code>, <code>RULE_UPDATE_INTERVAL</code></p></div><h2>Cách Viết Rule (rules.txt)</h2><div class="endpoint"><h3>1. Wildcard (Mặc định)</h3><pre><code>https://*.domain.com/path/*</code></pre><h3>2. Regex (Nâng cao)</h3><pre><code>regex:/live/\\d+/stream\\.m3u8</code></pre></div><h2>Endpoint</h2><div class="endpoint"><p>Sử dụng <code>GET</code> hoặc <code>POST</code> đến <code>/api/scrape</code> với các tham số <code>url</code>, <code>hasJs</code>, <code>referer</code> và <code>key</code>.</p></div></body></html>`;

// --- START SERVER ---
const startServer = async () => {
    await updateDetectionRules();
    const updateIntervalMinutes = parseInt(RULE_UPDATE_INTERVAL, 10) || 60;
    setInterval(updateDetectionRules, updateIntervalMinutes * 60 * 1000);
    console.log(`[RULE MANAGER] Đã lên lịch cập nhật rule mỗi ${updateIntervalMinutes} phút.`);
    app.get('/docs', (req, res) => res.setHeader('Content-Type', 'text/html').send(docsHtml));
    app.get('/', (req, res) => res.redirect('/docs'));
    app.listen(PORT, () => console.log(`Server đang chạy tại http://localhost:${PORT}`));
};

startServer();
