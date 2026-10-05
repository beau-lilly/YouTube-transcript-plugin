'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const YTT = require('../extension/src/core.js');
const fx = require('./fixtures/youtube.js');

test('getVideoId reads every common YouTube URL form', () => {
  const id = 'dQw4w9WgXcQ';
  for (const url of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://www.youtube.com/watch?list=PL1&v=${id}&t=42s`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}?t=10`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube.com/live/${id}?feature=share`,
  ]) {
    assert.equal(YTT.getVideoId(url), id, url);
  }
  for (const url of ['https://www.youtube.com/', 'https://www.youtube.com/watch?v=short', 'https://example.com/watch?v=dQw4w9WgXcQ', 'not a url']) {
    assert.equal(YTT.getVideoId(url), null, url);
  }
});

test('extractJsonAfter handles braces and quotes inside strings', () => {
  const html = `<script>var x = {"a":"}{\\"","b":{"c":[1,2,{"d":"'"}]}};var y=1;</script>`;
  assert.deepEqual(YTT.extractJsonAfter(html, 'var x = ').value, { a: '}{"', b: { c: [1, 2, { d: "'" }] } });
  assert.equal(YTT.extractJsonAfter(html, 'missing'), null);
});

test('watch page extractors read ytcfg, player response, and initial data', () => {
  const html = fx.watchPageHtml();
  const cfg = YTT.extractYtcfg(html);
  assert.equal(cfg.INNERTUBE_API_KEY, 'test-key');
  assert.equal(cfg.INNERTUBE_CLIENT_VERSION, '2.20261001.00.00');
  assert.equal(cfg.VISITOR_DATA, 'visitor123', 'merges later ytcfg.set calls');

  const pr = YTT.extractPlayerResponse(html);
  assert.equal(pr.videoDetails.title, 'Test video: "quotes" & {braces}');

  const data = YTT.extractInitialData(html);
  assert.equal(YTT.findTranscriptParams(data), 'PANEL_PARAMS');
});

test('listTracks and pickDefaultTrack', () => {
  const tracks = YTT.listTracks(fx.playerResponse());
  assert.deepEqual(
    tracks.map((t) => [t.id, t.label, t.isAuto]),
    [
      ['.en', 'English', false],
      ['a.en', 'English (auto-generated)', true],
      ['.de', 'German', false],
    ]
  );
  assert.equal(YTT.pickDefaultTrack(tracks, ['de-DE', 'en']).id, '.de');
  assert.equal(YTT.pickDefaultTrack(tracks, ['fr']).id, '.en');
  assert.equal(YTT.pickDefaultTrack([], ['en']), null);
  assert.deepEqual(YTT.listTracks({}), []);
});

test('parseJson3 joins segments and skips empty events', () => {
  assert.deepEqual(YTT.parseJson3(fx.json3()), [
    { start: 0.5, duration: 2, text: 'Hello world' },
    { start: 2.5, duration: 1.25, text: "it's & here" },
  ]);
});

test('parseXmlCaptions reads the classic format and decodes double escaping', () => {
  const xml =
    '<?xml version="1.0" encoding="utf-8" ?><transcript>' +
    '<text start="0" dur="1.5">I&amp;#39;m here</text>' +
    '<text start="1.5" dur="2">a &lt;b&gt; &amp;amp; c\nnext</text>' +
    '<text start="4" dur="1"></text>' +
    '</transcript>';
  assert.deepEqual(YTT.parseXmlCaptions(xml), [
    { start: 0, duration: 1.5, text: "I'm here" },
    { start: 1.5, duration: 2, text: 'a <b> & c next' },
  ]);
});

test('parseXmlCaptions reads srv3', () => {
  const xml = '<timedtext format="3"><body><p t="1000" d="2500"><s>one</s><s t="500"> two</s></p><p t="4000" d="10">\n</p></body></timedtext>';
  assert.deepEqual(YTT.parseXmlCaptions(xml), [{ start: 1, duration: 2.5, text: 'one two' }]);
});

test('parseTimedtext detects the format', () => {
  assert.equal(YTT.parseTimedtext('').length, 0);
  assert.equal(YTT.parseTimedtext(JSON.stringify(fx.json3())).length, 2);
  assert.equal(YTT.parseTimedtext('<transcript><text start="1" dur="1">x</text></transcript>').length, 1);
});

test('parseTranscriptPanel reads get_transcript responses', () => {
  assert.deepEqual(YTT.parseTranscriptPanel(fx.panelResponse('English')), [
    { start: 0, duration: 1.5, text: 'Panel line one' },
    { start: 1.5, duration: 2, text: 'Panel line two' },
  ]);
});

test('formatters', () => {
  const segs = [
    { start: 0, duration: 1.5, text: 'a' },
    { start: 75.4, duration: 0, text: 'b' },
    { start: 3725, duration: 2, text: 'c' },
  ];
  assert.equal(YTT.formatTimestamp(75.4), '1:15');
  assert.equal(YTT.formatTimestamp(3725), '1:02:05');
  assert.equal(YTT.toPlainText(segs), '[0:00] a\n[1:15] b\n[1:02:05] c');
  assert.equal(YTT.toPlainText(segs, { timestamps: false }), 'a\nb\nc');
  assert.equal(
    YTT.toSrt(segs),
    '1\n00:00:00,000 --> 00:00:01,500\na\n\n' +
      '2\n00:01:15,400 --> 01:02:05,000\nb\n\n' +
      '3\n01:02:05,000 --> 01:02:07,000\nc\n'
  );
  assert.ok(YTT.toVtt(segs).startsWith('WEBVTT\n\n00:00:00.000 --> 00:00:01.500\na\n'));
  assert.equal(YTT.safeFileName('a/b: c?'), 'a b c');
  assert.equal(YTT.safeFileName(''), 'transcript');
});

test('withFormat sets and removes fmt', () => {
  const url = 'https://www.youtube.com/api/timedtext?v=x&lang=en&fmt=srv3';
  assert.match(YTT.withFormat(url, 'json3'), /fmt=json3/);
  assert.doesNotMatch(YTT.withFormat(url, null), /fmt=/);
});
