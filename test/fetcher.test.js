'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
require('../extension/src/core.js');
const { createTranscriptService } = require('../extension/src/fetcher.js');
const fx = require('./fixtures/youtube.js');

const ID = fx.VIDEO_ID;

/** A fake fetch. `routes` maps a test function to a response body or status. */
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url: u, body, init });
    for (const [match, respond] of routes) {
      if (match(u, body)) {
        const r = typeof respond === 'function' ? respond(u, body) : respond;
        if (typeof r === 'number') return { ok: false, status: r, text: async () => '' };
        const text = typeof r === 'string' ? r : JSON.stringify(r);
        return { ok: true, status: 200, text: async () => text };
      }
    }
    return { ok: false, status: 404, text: async () => '' };
  };
  return { fetch, calls };
}

const isWatch = (u) => u.pathname === '/watch';
const isTimedtext = (u) => u.pathname === '/api/timedtext';
const isPanel = (u) => u.pathname === '/youtubei/v1/get_transcript';
const isPlayer = (u) => u.pathname === '/youtubei/v1/player';

test('getVideoInfo returns details and tracks without private URLs', async () => {
  const { fetch, calls } = fakeFetch([[isWatch, fx.watchPageHtml()]]);
  const service = createTranscriptService({ fetch });
  const info = await service.getVideoInfo(ID, ['de']);
  assert.equal(info.title, 'Test video: "quotes" & {braces}');
  assert.equal(info.author, 'Test Channel');
  assert.equal(info.defaultTrackId, '.de');
  assert.equal(info.hasTranscriptPanel, true);
  assert.equal(info.tracks.length, 3);
  assert.ok(info.tracks.every((t) => !('baseUrl' in t)));

  await service.getVideoInfo(ID);
  assert.equal(calls.length, 1, 'the watch page is cached per video');
});

test('timedtext method: uses json3 and reuses the page pot token', async () => {
  const pageUrl = `https://www.youtube.com/api/timedtext?v=${ID}&lang=en&pot=TOKEN&c=WEB`;
  const { fetch, calls } = fakeFetch([
    [isWatch, fx.watchPageHtml()],
    [(u) => isTimedtext(u) && u.searchParams.get('pot') === 'TOKEN', fx.json3()],
  ]);
  const service = createTranscriptService({ fetch, resourceUrls: () => [pageUrl] });
  const result = await service.getTranscript(ID, '.en');
  assert.equal(result.method, 'timedtext');
  assert.equal(result.track.id, '.en');
  assert.equal(result.segments[0].text, 'Hello world');
  const tt = calls.find((c) => isTimedtext(c.url)).url;
  assert.equal(tt.searchParams.get('fmt'), 'json3');
  assert.equal(tt.searchParams.get('c'), 'WEB');
});

test('falls back to the transcript panel and switches its language', async () => {
  const { fetch, calls } = fakeFetch([
    [isWatch, fx.watchPageHtml()],
    [isTimedtext, ''], // Empty body: YouTube wants a pot token we do not have.
    [(u, b) => isPanel(u) && b.params === 'PANEL_PARAMS', fx.panelResponse('English')],
    [(u, b) => isPanel(u) && b.params === 'PARAMS_German', fx.panelResponse('German')],
  ]);
  const service = createTranscriptService({ fetch });
  const result = await service.getTranscript(ID, '.de');
  assert.equal(result.method, 'panel');
  assert.equal(result.segments[0].text, 'Deutsch line one');

  const panelCall = calls.find((c) => isPanel(c.url));
  assert.equal(panelCall.url.searchParams.get('key'), 'test-key');
  assert.equal(panelCall.body.context.client.clientName, 'WEB');
  assert.equal(panelCall.init.headers['X-Youtube-Client-Version'], '2.20261001.00.00');
});

test('falls back to the Android player and matches the track kind', async () => {
  const androidPr = fx.playerResponse();
  for (const t of androidPr.captions.playerCaptionsTracklistRenderer.captionTracks) {
    t.baseUrl = t.baseUrl.replace('timedtext?', 'timedtext?android=1&');
  }
  const { fetch, calls } = fakeFetch([
    [isWatch, fx.watchPageHtml()],
    [(u) => isTimedtext(u) && u.searchParams.get('android') && u.searchParams.get('kind') === 'asr',
      '<transcript><text start="0" dur="1">auto words</text></transcript>'],
    [isTimedtext, ''],
    [isPanel, 400],
    [isPlayer, androidPr],
  ]);
  const service = createTranscriptService({ fetch });
  const result = await service.getTranscript(ID, 'a.en');
  assert.equal(result.method, 'android');
  assert.deepEqual(result.segments, [{ start: 0, duration: 1, text: 'auto words' }]);
  const playerCall = calls.find((c) => isPlayer(c.url));
  assert.equal(playerCall.body.context.client.clientName, 'ANDROID');
  assert.equal(playerCall.body.videoId, ID);
});

test('reports why each method failed', async () => {
  const { fetch } = fakeFetch([
    [isWatch, fx.watchPageHtml()],
    [isTimedtext, ''],
    [isPanel, 400],
    [isPlayer, { playabilityStatus: { status: 'OK' } }],
  ]);
  const service = createTranscriptService({ fetch });
  await assert.rejects(service.getTranscript(ID, '.en'), (err) => {
    assert.equal(err.message, 'YouTube did not return a transcript.');
    assert.equal(err.details.length, 3);
    assert.match(err.details[0], /^timedtext: empty/);
    assert.match(err.details[1], /^panel: HTTP 400/);
    assert.match(err.details[2], /^android: no matching track/);
    return true;
  });
});

test('video without captions uses only the panel and Android methods', async () => {
  const pr = fx.playerResponse({ captions: undefined });
  const { fetch } = fakeFetch([
    [isWatch, fx.watchPageHtml(pr, {})],
    [isPlayer, { playabilityStatus: { status: 'OK' } }],
  ]);
  const service = createTranscriptService({ fetch });
  const info = await service.getVideoInfo(ID);
  assert.deepEqual(info.tracks, []);
  assert.equal(info.hasTranscriptPanel, false);
  await assert.rejects(service.getTranscript(ID, null), /no captions or transcript/);
});

test('a failed watch page load is not cached', async () => {
  let first = true;
  const { fetch } = fakeFetch([
    [isWatch, () => (first ? ((first = false), 500) : fx.watchPageHtml())],
  ]);
  const service = createTranscriptService({ fetch });
  await assert.rejects(service.getVideoInfo(ID), /HTTP 500/);
  const info = await service.getVideoInfo(ID);
  assert.equal(info.tracks.length, 3);
});

test('uses the origin of the open page', async () => {
  const { fetch, calls } = fakeFetch([[isWatch, fx.watchPageHtml()]]);
  const service = createTranscriptService({ fetch, origin: 'https://m.youtube.com' });
  await service.getVideoInfo(ID);
  assert.equal(calls[0].url.origin, 'https://m.youtube.com');
});
