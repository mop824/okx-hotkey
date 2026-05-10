/**
 * monitor-okx-selectors.js — Headless DOM selector health check
 *
 * Loads OKX trade page (no login) and verifies each selector in
 * monitor-config.json actually matches a DOM element. Broken selectors
 * trigger a Discord webhook alert. Clean runs are stdout-only (no noise).
 *
 * Run: node scripts/monitor-okx-selectors.js
 * Env: DISCORD_WEBHOOK_URL (optional — stdout simulation when unset)
 */

'use strict';

const path    = require('path');
const fs      = require('fs');
const https   = require('https');
const { URL } = require('url');

const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin  = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG_PATH  = path.join(__dirname, 'monitor-config.json');
const PROFILE_DIR  = path.join(__dirname, '..', '.chrome-profile-monitor');
const CHROME_BIN   = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// ── KST timestamp ─────────────────────────────────────────────────────────────

function nowKST() {
  return new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}

// ── Discord alert ─────────────────────────────────────────────────────────────

function sendDiscordAlert(broken) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  const list = broken.map(k => `\`${k}\``).join(', ');
  const msg = `🚨 단축키 헤드리스 모니터링 — 깨진 셀렉터: ${list}, 시각: ${nowKST()}, 페이지: ${config.target_url}`;

  if (!webhookUrl) {
    console.log('[ALERT-SIMULATED]', msg);
    return Promise.resolve();
  }

  const body = JSON.stringify({ content: msg });
  const parsed = new URL(webhookUrl);

  return new Promise((resolve) => {
    const req = https.request(
      { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => { res.resume(); resolve(); }
    );
    req.on('error', (e) => { console.error('[ALERT] Discord webhook error:', e.message); resolve(); });
    req.write(body);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  console.log(`[${nowKST()}] 모니터링 시작 — ${config.target_url}`);

  const browser = await puppeteerExtra.launch({
    executablePath:  CHROME_BIN,
    headless:        'new',
    userDataDir:     PROFILE_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  let broken = [];

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    await page.goto(config.target_url, {
      waitUntil: 'domcontentloaded',
      timeout:   config.page_load_timeout_ms,
    });

    // Extra wait for React hydration
    await new Promise(r => setTimeout(r, config.selector_check_timeout_ms));

    const selectors = config.selectors;
    for (const [key, css] of Object.entries(selectors)) {
      const el = await page.$(css).catch(() => null);
      if (el) {
        console.log(`  ✅ ${key}: ${css}`);
      } else {
        console.log(`  ❌ ${key}: ${css}`);
        broken.push(key);
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\n[${nowKST()}] 결과: ${Object.keys(config.selectors).length - broken.length}/${Object.keys(config.selectors).length} 정상`);

  if (broken.length > 0) {
    console.log(`깨진 셀렉터: ${broken.join(', ')}`);
    await sendDiscordAlert(broken);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[${nowKST()}] 치명적 오류:`, err.message);
  process.exit(2);
});
