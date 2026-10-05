'use strict';

/*
 * End-to-end check: loads the unpacked extension in Chromium, serves a fake
 * youtube.com watch page, and drives the popup.
 *
 *   npm run test:e2e
 *
 * Needs the `playwright` package and a Chromium build. No real network access.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fx = require('../fixtures/youtube.js');

const EXT = path.resolve(__dirname, '../../extension');
const ID = fx.VIDEO_ID;
const SHOTS = process.env.SCREENSHOT_DIR;

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytt-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });

  try {
    const requests = [];
    await context.route('https://www.youtube.com/**', (route) => {
      const u = new URL(route.request().url());
      requests.push(u.pathname + u.search);
      if (u.pathname === '/watch') {
        return route.fulfill({ contentType: 'text/html', body: fx.watchPageHtml() });
      }
      if (u.pathname === '/api/timedtext') {
        // The English track works only with the page's pot token; German never works.
        const ok = u.searchParams.get('lang') === 'en' && u.searchParams.get('pot') === 'TOKEN';
        return route.fulfill({ contentType: 'application/json', body: ok ? JSON.stringify(fx.json3()) : '' });
      }
      if (u.pathname === '/youtubei/v1/get_transcript') {
        const params = JSON.parse(route.request().postData()).params;
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(fx.panelResponse(params === 'PARAMS_German' ? 'German' : 'English')),
        });
      }
      if (u.pathname === '/') {
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>YouTube</title>' });
      }
      return route.fulfill({ status: 204, body: '' });
    });

    const page = await context.newPage();
    await page.goto(`https://www.youtube.com/watch?v=${ID}`);
    // Simulate the player having loaded English captions with a pot token.
    await page.evaluate((id) => fetch(`/api/timedtext?v=${id}&lang=en&pot=TOKEN&c=WEB&fmt=json3`), ID);

    const extensionId = await findExtensionId(context);

    const popup = await context.newPage();
    await popup.setViewportSize({ width: 440, height: 600 });
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    const tabId = await popup.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
      return tab.id;
    });
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html?tabId=${tabId}`);

    await popup.waitForSelector('#transcript li');
    assert.equal(await popup.textContent('#title'), 'Test video: "quotes" & {braces}');
    assert.equal(await popup.textContent('#subtitle'), 'Test Channel · 2:05');
    assert.deepEqual(await popup.$$eval('#transcript .text', (els) => els.map((e) => e.textContent)), [
      'Hello world',
      "it's & here",
    ]);
    assert.match(await popup.textContent('#footer'), /2 lines · source: caption track/);
    if (SHOTS) await popup.screenshot({ path: path.join(SHOTS, 'popup-english.png') });

    // Search highlights matches and hides other lines.
    await popup.fill('#search', 'world');
    assert.equal(await popup.textContent('#match-count'), '1 match');
    assert.equal(await popup.textContent('#transcript mark'), 'world');
    assert.equal(await popup.$$eval('#transcript li:not(.hidden)', (els) => els.length), 1);
    await popup.fill('#search', '');

    // Clicking a timestamp seeks the video in the YouTube tab.
    await popup.click('#transcript li:nth-child(2) .ts');
    await page.waitForFunction(() => document.querySelector('video').currentTime === 2.5);

    // German has no working caption URL, so the transcript panel answers.
    await popup.selectOption('#track', '.de');
    await popup.waitForFunction(() => document.querySelector('#footer').textContent.includes('transcript panel'));
    assert.equal(await popup.textContent('#transcript li .text'), 'Deutsch line one');
    if (SHOTS) await popup.screenshot({ path: path.join(SHOTS, 'popup-german.png') });

    // Downloads use the video title in the file name.
    await popup.selectOption('#format', 'srt');
    const [download] = await Promise.all([popup.waitForEvent('download'), popup.click('#download')]);
    assert.equal(download.suggestedFilename(), `Test video quotes & {braces} [${ID}].srt`);
    const srt = fs.readFileSync(await download.path(), 'utf8');
    assert.ok(srt.startsWith('1\n00:00:00,000 --> 00:00:01,500\nDeutsch line one\n'), srt);

    // A non-video YouTube page shows a clear message.
    await page.goto('https://www.youtube.com/');
    await popup.reload();
    await popup.waitForFunction(() => document.querySelector('#status').textContent.includes('Open a YouTube video'));

    console.log('e2e: all checks passed');
    console.log('requests:', requests.join('\n          '));
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

/** Reads the extension ID with the management API of chrome://extensions. */
async function findExtensionId(context) {
  const page = await context.newPage();
  await page.goto('chrome://extensions');
  const id = await page.evaluate(async () => {
    const list = await chrome.management.getAll();
    return list.find((e) => e.name === 'YouTube Transcript').id;
  });
  await page.close();
  return id;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
