/*
 * Pure helpers: no network, no browser APIs.
 * Loaded as a classic script in the content script and the popup,
 * and as a CommonJS module by the Node tests.
 */
(function (root) {
  'use strict';

  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

  /** Returns the 11-character video ID for a YouTube URL, or null. */
  function getVideoId(url) {
    let u;
    try {
      u = new URL(url);
    } catch (_) {
      return null;
    }
    const host = u.hostname.replace(/^www\.|^m\./, '');
    let id = null;
    if (host === 'youtu.be') {
      id = u.pathname.split('/')[1];
    } else if (host === 'youtube.com' || host === 'music.youtube.com') {
      if (u.pathname === '/watch') {
        id = u.searchParams.get('v');
      } else {
        const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
        if (m) id = m[1];
      }
    }
    return id && VIDEO_ID_RE.test(id) ? id : null;
  }

  /**
   * Finds `marker` in `text` and parses the JSON object that follows it.
   * Uses brace matching that respects strings, so it works on large inline
   * <script> blocks where a regex would fail.
   */
  function extractJsonAfter(text, marker, fromIndex) {
    const at = text.indexOf(marker, fromIndex || 0);
    if (at === -1) return null;
    const start = text.indexOf('{', at + marker.length);
    if (start === -1) return null;
    const end = findObjectEnd(text, start);
    if (end === -1) return null;
    try {
      return { value: JSON.parse(text.slice(start, end + 1)), end };
    } catch (_) {
      return null;
    }
  }

  function findObjectEnd(text, start) {
    let depth = 0;
    let inString = false;
    let quote = '';
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === quote) inString = false;
      } else if (ch === '"' || ch === "'") {
        inString = true;
        quote = ch;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  /** Merges every `ytcfg.set({...})` call in the watch page HTML. */
  function extractYtcfg(html) {
    const cfg = {};
    let from = 0;
    for (;;) {
      const found = extractJsonAfter(html, 'ytcfg.set(', from);
      if (!found) break;
      Object.assign(cfg, found.value);
      from = found.end;
    }
    return cfg;
  }

  function extractPlayerResponse(html) {
    const found =
      extractJsonAfter(html, 'var ytInitialPlayerResponse = ') ||
      extractJsonAfter(html, 'ytInitialPlayerResponse = ') ||
      extractJsonAfter(html, '"ytInitialPlayerResponse":');
    return found ? found.value : null;
  }

  function extractInitialData(html) {
    const found =
      extractJsonAfter(html, 'var ytInitialData = ') ||
      extractJsonAfter(html, 'window["ytInitialData"] = ') ||
      extractJsonAfter(html, 'ytInitialData = ');
    return found ? found.value : null;
  }

  /** Depth-first search for the first value stored under `key`. */
  function findKey(obj, key) {
    const stack = [obj];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      if (Object.prototype.hasOwnProperty.call(cur, key)) return cur[key];
      const values = Array.isArray(cur) ? cur : Object.values(cur);
      for (let i = values.length - 1; i >= 0; i--) stack.push(values[i]);
    }
    return undefined;
  }

  /** Collects every value stored under `key`, in document order. */
  function findAllKeys(obj, key, out) {
    out = out || [];
    if (!obj || typeof obj !== 'object') return out;
    if (Array.isArray(obj)) {
      for (const v of obj) findAllKeys(v, key, out);
      return out;
    }
    for (const k of Object.keys(obj)) {
      if (k === key) out.push(obj[k]);
      findAllKeys(obj[k], key, out);
    }
    return out;
  }

  function textOf(node) {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (node.simpleText != null) return node.simpleText;
    if (Array.isArray(node.runs)) return node.runs.map((r) => r.text || '').join('');
    return '';
  }

  /** Normalizes the caption tracks of a player response. */
  function listTracks(playerResponse) {
    const renderer =
      playerResponse &&
      playerResponse.captions &&
      playerResponse.captions.playerCaptionsTracklistRenderer;
    const raw = (renderer && renderer.captionTracks) || [];
    return raw.map((t) => {
      const isAuto = t.kind === 'asr';
      const name = textOf(t.name) || t.languageCode;
      return {
        id: t.vssId || (isAuto ? 'a.' : '.') + t.languageCode,
        languageCode: t.languageCode,
        name,
        label: isAuto && !/auto/i.test(name) ? name + ' (auto-generated)' : name,
        isAuto,
        baseUrl: t.baseUrl,
      };
    });
  }

  /** Picks the default track: a manual track first, then anything. */
  function pickDefaultTrack(tracks, preferredLangs) {
    if (!tracks.length) return null;
    const prefs = (preferredLangs || []).map((l) => l.toLowerCase().split('-')[0]);
    const base = (t) => t.languageCode.toLowerCase().split('-')[0];
    for (const lang of prefs) {
      const manual = tracks.find((t) => !t.isAuto && base(t) === lang);
      if (manual) return manual;
    }
    for (const lang of prefs) {
      const auto = tracks.find((t) => base(t) === lang);
      if (auto) return auto;
    }
    return tracks.find((t) => !t.isAuto) || tracks[0];
  }

  function videoDetails(playerResponse) {
    const d = (playerResponse && playerResponse.videoDetails) || {};
    return {
      title: d.title || '',
      author: d.author || '',
      lengthSeconds: Number(d.lengthSeconds) || 0,
    };
  }

  function playabilityError(playerResponse) {
    const p = playerResponse && playerResponse.playabilityStatus;
    if (!p || p.status === 'OK') return null;
    return p.reason || textOf(p.errorScreen && findKey(p.errorScreen, 'reason')) || p.status;
  }

  /** Finds the `params` that the "Show transcript" button sends. */
  function findTranscriptParams(initialData) {
    const endpoint = findKey(initialData, 'getTranscriptEndpoint');
    return (endpoint && endpoint.params) || null;
  }

  /** Sets `fmt` on a timedtext URL. */
  function withFormat(baseUrl, fmt) {
    const u = new URL(baseUrl, 'https://www.youtube.com');
    if (fmt) u.searchParams.set('fmt', fmt);
    else u.searchParams.delete('fmt');
    return u.toString();
  }

  const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

  function decodeEntitiesOnce(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent) => {
      if (ent[0] === '#') {
        const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      const named = NAMED_ENTITIES[ent.toLowerCase()];
      return named != null ? named : whole;
    });
  }

  /** YouTube XML captions are often escaped twice (e.g. `&amp;#39;`). */
  function decodeEntities(s) {
    const once = decodeEntitiesOnce(s);
    return once.includes('&') ? decodeEntitiesOnce(once) : once;
  }

  function cleanText(s) {
    return s.replace(/\s+/g, ' ').trim();
  }

  function round3(n) {
    return Math.round(n * 1000) / 1000;
  }

  /** Parses `fmt=json3` timedtext into segments. */
  function parseJson3(data) {
    if (typeof data === 'string') data = JSON.parse(data);
    const events = (data && data.events) || [];
    const out = [];
    for (const ev of events) {
      if (!ev.segs) continue;
      const text = cleanText(ev.segs.map((s) => s.utf8 || '').join(''));
      if (!text) continue;
      out.push({
        start: round3((ev.tStartMs || 0) / 1000),
        duration: round3((ev.dDurationMs || 0) / 1000),
        text,
      });
    }
    return out;
  }

  /**
   * Parses XML timedtext. Handles both the classic format
   * (`<text start="1.2" dur="3.4">`) and srv3 (`<p t="1200" d="3400">`).
   * Regex based, so it runs without DOMParser.
   */
  function parseXmlCaptions(xml) {
    const out = [];
    const classic = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
    const srv3 = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
    const attr = (attrs, name) => {
      const m = attrs.match(new RegExp('\\b' + name + '="([^"]*)"'));
      return m ? parseFloat(m[1]) : NaN;
    };
    const push = (start, duration, inner) => {
      const text = cleanText(decodeEntities(inner.replace(/<[^>]+>/g, '')));
      if (text && Number.isFinite(start)) {
        out.push({ start: round3(start), duration: round3(duration || 0), text });
      }
    };
    let m;
    while ((m = classic.exec(xml))) push(attr(m[1], 'start'), attr(m[1], 'dur'), m[2]);
    if (!out.length) {
      while ((m = srv3.exec(xml))) push(attr(m[1], 't') / 1000, attr(m[1], 'd') / 1000, m[2]);
    }
    return out;
  }

  /** Parses a timedtext response body of unknown format. */
  function parseTimedtext(body) {
    const trimmed = (body || '').trim();
    if (!trimmed) return [];
    if (trimmed[0] === '{') return parseJson3(trimmed);
    return parseXmlCaptions(trimmed);
  }

  /** Parses a `youtubei/v1/get_transcript` response. */
  function parseTranscriptPanel(response) {
    const out = [];
    for (const seg of findAllKeys(response, 'transcriptSegmentRenderer')) {
      const startMs = Number(seg.startMs);
      const endMs = Number(seg.endMs);
      const text = cleanText(textOf(seg.snippet));
      if (!text || !Number.isFinite(startMs)) continue;
      out.push({
        start: round3(startMs / 1000),
        duration: Number.isFinite(endMs) ? round3((endMs - startMs) / 1000) : 0,
        text,
      });
    }
    return out;
  }

  function pad(n, width) {
    return String(n).padStart(width || 2, '0');
  }

  /** 75.4 -> "1:15"; 3725 -> "1:02:05". */
  function formatTimestamp(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }

  /** 75.4 -> "00:01:15,400" (SRT) or "00:01:15.400" (VTT). */
  function formatClock(seconds, sep) {
    const ms = Math.max(0, Math.round(seconds * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return pad(h) + ':' + pad(m) + ':' + pad(s) + sep + pad(ms % 1000, 3);
  }

  function segmentEnd(segments, i) {
    const seg = segments[i];
    if (seg.duration > 0) return seg.start + seg.duration;
    const next = segments[i + 1];
    return next ? next.start : seg.start + 2;
  }

  function toPlainText(segments, options) {
    const timestamps = !options || options.timestamps !== false;
    return segments
      .map((s) => (timestamps ? '[' + formatTimestamp(s.start) + '] ' : '') + s.text)
      .join('\n');
  }

  function toSrt(segments) {
    return segments
      .map(
        (s, i) =>
          i + 1 + '\n' +
          formatClock(s.start, ',') + ' --> ' + formatClock(segmentEnd(segments, i), ',') + '\n' +
          s.text + '\n'
      )
      .join('\n');
  }

  function toVtt(segments) {
    const cues = segments.map(
      (s, i) =>
        formatClock(s.start, '.') + ' --> ' + formatClock(segmentEnd(segments, i), '.') + '\n' + s.text + '\n'
    );
    return 'WEBVTT\n\n' + cues.join('\n');
  }

  function safeFileName(name) {
    const cleaned = (name || 'transcript')
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    return cleaned || 'transcript';
  }

  const api = {
    getVideoId,
    extractJsonAfter,
    extractYtcfg,
    extractPlayerResponse,
    extractInitialData,
    findKey,
    findAllKeys,
    textOf,
    listTracks,
    pickDefaultTrack,
    videoDetails,
    playabilityError,
    findTranscriptParams,
    withFormat,
    decodeEntities,
    parseJson3,
    parseXmlCaptions,
    parseTimedtext,
    parseTranscriptPanel,
    formatTimestamp,
    formatClock,
    toPlainText,
    toSrt,
    toVtt,
    safeFileName,
  };

  root.YTT = Object.assign(root.YTT || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
