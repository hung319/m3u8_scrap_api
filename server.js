
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

const { API_KEY, P_IP, P_PORT, P_USER, P_PASSWORD, RULE_URL, RULE_UPDATE_INTERVAL } = process.env;
let globalProxyUrl = null;
if (P_IP && P_PORT) {
    const authPart = (P_USER && P_PASSWORD) ? `${P_USER}:${P_PASSWORD}@` : '';
    globalProxyUrl = `socks5://${authPart}${P_IP}:${P_PORT}`;
}
if (!API_KEY) console.warn('[SECURITY WARNING] API_KEY chÆ°a Ä‘Æ°á»£c thiáº¿t láº­p!');

let browserInstance = null;
let detectionRules = [/application\/(vnd\.apple\.mpegurl|x-mpegurl)/i, /\.m3u8?(\?|$)/i];

const updateDetectionRules = async () => {
    if (!RULE_URL) return console.log('[RULE MANAGER] KhĂ´ng cĂ³ RULE_URL. Chá»‰ dĂ¹ng rule Content-Type máº·c Ä‘á»‹nh.');
    console.log(`[RULE MANAGER] Äang cáº­p nháº­t rule tá»«: ${RULE_URL}`);
    try {
        const { data } = await axios.get(RULE_URL);
        const remoteRules = data.split('\n').map(l => l.trim()).filter(l => l.toLowerCase().startsWith('regex:')).map(l => {
            try { return new RegExp(l.substring(6).trim(), 'i'); } 
            catch (e) { console.error(`[RULE MANAGER] Lá»—i cĂº phĂ¡p rule: "${l}". Bá» qua.`); return null; }
        }).filter(Boolean);
        detectionRules = [/application\/(vnd\.apple\.mpegurl|x-mpegurl)/i, /\.m3u8?(\?|$)/i, ...remoteRules];
        console.log(`[RULE MANAGER] Cáº­p nháº­t thĂ nh cĂ´ng! Tá»•ng sá»‘ rule: ${detectionRules.length}`);
    } catch (error) {
        console.error(`[RULE MANAGER] Lá»—i khi táº£i file rule: ${error.message}`);
    }
};

const apiKeyMiddleware = (req, res, next) => {
    if (!API_KEY) return res.status(503).json({ success: false, message: 'Dá»‹ch vá»¥ khĂ´ng Ä‘Æ°á»£c cáº¥u hĂ¬nh.' });
    if (req.query.key === API_KEY) return next();
    res.status(401).json({ success: false, message: 'Unauthorized: API Key khĂ´ng há»£p lá»‡ hoáº·c bá»‹ thiáº¿u.' });
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
        console.error('[DPASTE] Lá»—i khi táº£i lĂªn:', error.message);
        return null;
    }
}

const handleResponse = (response, foundLinks) => {
    const requestUrl = response.url();
    if (requestUrl.startsWith('data:')) return;
    const contentType = response.headers()['content-type'] || '';
    const isMatchByRule = detectionRules.some(rule => rule.test(requestUrl) || rule.test(contentType)) || /\.m3u8?(\?|$)/i.test(requestUrl);
    if (isMatchByRule && !requestUrl.endsWith('.ts')) {
        console.log(`[+] ÄĂ£ báº¯t Ä‘Æ°á»£c link M3U8 (khá»›p vá»›i Rule): ${requestUrl}`);
        foundLinks.add(requestUrl);
    }
};

async function handleScrapeRequest(targetUrl, headers) {
    if (!browserInstance) throw new Error("TrĂ¬nh duyá»‡t chÆ°a sáºµn sĂ ng. Vui lĂ²ng thá»­ láº¡i sau giĂ¢y lĂ¡t.");

    let page = null;
    const foundLinks = new Set();
    console.log(`[PAGE] Äang má»Ÿ trang má»›i cho: ${targetUrl}`);

    try {
        page = await browserInstance.newPage();
        await page.setRequestInterception(true);
        page.on('request', r => ['image', 'stylesheet', 'font'].includes(r.resourceType()) ? r.abort() : r.continue());
        if (Object.keys(headers).length > 0) await page.setExtraHTTPHeaders(headers);

        page.on('response', async r => {
            const requestUrl = r.url();
            const contentType = r.headers()['content-type'] || '';
            if (requestUrl.startsWith('blob:')) {
                try {
                    const text = await (await r.buffer()).toString();
                    if (text.includes('#EXTM3U')) {
                        const rawLink = await uploadToDpaste(text);
                        if (rawLink) foundLinks.add(rawLink);
                    }
                } catch (e) {
                    console.warn('[BLOB] Lá»—i khi Ä‘á»c blob:', e.message);
                }
            }
            handleResponse(r, foundLinks);
        });

        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });

        if (foundLinks.size > 0) {
            console.log('[OPTIMIZATION] TĂ¬m tháº¥y link máº¡ng trong lĂºc táº£i trang. Tráº£ vá» ngay.');
            return Array.from(foundLinks);
        }

        try {
            const videoElement = await page.waitForSelector('video', { timeout: 3000, visible: true });
            if (videoElement) await videoElement.click();
        } catch (e) {
            try {
                const playButton = await page.waitForSelector('[class*="play"], [aria-label*="Play"], [aria-label*="PhĂ¡t"]', { timeout: 2000, visible: true });
                if (playButton) await playButton.click();
            } catch (e2) {}
        }

        await new Promise(resolve => setTimeout(resolve, 8000));

        if (foundLinks.size > 0) {
            console.log('[OPTIMIZATION] TĂ¬m tháº¥y link máº¡ng sau khi tÆ°Æ¡ng tĂ¡c. Tráº£ vá» ngay.');
            return Array.from(foundLinks);
        }

        try {
            const jsLink = await page.waitForFunction(() => {
                for (const key in window) {
                    try {
                        const val = window[key];
                        if (typeof val === 'string' && val.includes('.m3u8')) return val;
                    } catch {}
                }
                return null;
            }, { timeout: 3000 });

            const linkStr = await jsLink.jsonValue();
            if (linkStr) {
                console.log('[JS-MEMORY] PhĂ¡t hiá»‡n link tá»« biáº¿n JavaScript:', linkStr);
                foundLinks.add(linkStr);
            }
        } catch (e) {}

        return Array.from(foundLinks);
    } catch (error) {
        console.error(`[PAGE] Lá»—i khi xá»­ lĂ½ trang ${targetUrl}:`, error.message);
        return [];
    } finally {
        if (page) await page.close();
        console.log(`[PAGE] ÄĂ£ Ä‘Ă³ng trang cho: ${targetUrl}`);
    }
}

app.get('/api/scrape', apiKeyMiddleware, async (req, res) => {
    const { url, referer } = req.query;
    if (!url) return res.status(400).json({ success: false, message: 'Vui lĂ²ng cung cáº¥p tham sá»‘ "url".' });
    const headers = referer ? { Referer: referer } : {};
    const links = await handleScrapeRequest(url, headers);
    handleApiResponse(res, links, url);
});

app.post('/api/scrape', apiKeyMiddleware, async (req, res) => {
    const { url, headers = {} } = req.body;
    if (!url) return res.status(400).json({ success: false, message: 'Vui lĂ²ng cung cáº¥p "url".' });
    const links = await handleScrapeRequest(url, headers);
    handleApiResponse(res, links, url);
});

const handleApiResponse = (res, links, url) => {
    if (links.length > 0) res.json({ success: true, count: links.length, source: url, links });
    else res.json({ success: false, message: 'KhĂ´ng tĂ¬m tháº¥y link M3U8 nĂ o.', source: url, links: [] });
};

const initializeBrowser = async () => {
    console.log('[BROWSER] Äang khá»Ÿi táº¡o instance trĂ¬nh duyá»‡t toĂ n cá»¥c...');
    const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--single-process', '--disable-gpu'];
    if (globalProxyUrl) launchArgs.push(`--proxy-server=${globalProxyUrl}`);
    try {
        browserInstance = await puppeteer.launch({
            headless: "new",
            args: launchArgs,
            executablePath: '/usr/bin/chromium',
            userDataDir: '/usr/src/app/.browser-cache'
        });
        console.log('[BROWSER] TrĂ¬nh duyá»‡t Ä‘Ă£ sáºµn sĂ ng!');
    } catch (error) {
        console.error('[BROWSER] Lá»—i nghiĂªm trá»ng khi khá»Ÿi táº¡o trĂ¬nh duyá»‡t:', error);
        process.exit(1);
    }
};

const startServer = async () => {
    await initializeBrowser();
    await updateDetectionRules();
    const updateIntervalMinutes = parseInt(RULE_UPDATE_INTERVAL, 10) || 60;
    setInterval(updateDetectionRules, updateIntervalMinutes * 60 * 1000);
    app.listen(PORT, () => console.log(`Server hiá»‡u nÄƒng cao Ä‘ang cháº¡y táº¡i http://localhost:${PORT}`));
};

startServer();
