/*
 * Gets transcripts from YouTube. Runs in the content script, so every request
 * is same-origin with youtube.com and uses the user's normal session.
 *
 * YouTube changes these endpoints often, so we try several methods in order
 * and return the first one that gives text:
 *   1. timedtext   - the caption URL from the player response (json3 format).
 *                    If the page already loaded captions, we reuse its
 *                    proof-of-origin token ("pot").
 *   2. panel       - youtubei/v1/get_transcript, the same call the
 *                    "Show transcript" button makes.
 *   3. android     - youtubei/v1/player with the ANDROID client. Its caption
 *                    URLs do not need a proof-of-origin token.
 */
(function (root) {
  'use strict';

  const YTT = root.YTT || (typeof require === 'function' ? require('./core.js') : null);
  const DEFAULT_ORIGIN = 'https://www.youtube.com';
  const ANDROID_CLIENT = { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30 };

  /**
   * @param {object} deps
   * @param {typeof fetch} deps.fetch
   * @param {string} [deps.origin] youtube.com origin of the open page.
   * @param {() => string[]} [deps.resourceUrls] URLs the page already loaded
   *   (from the Performance API). Used to find a proof-of-origin token.
   */
  function createTranscriptService(deps) {
    const doFetch = deps.fetch;
    const ORIGIN = deps.origin || DEFAULT_ORIGIN;
    const resourceUrls = deps.resourceUrls || (() => []);
    const contexts = new Map();

    async function getText(url, init) {
      const res = await doFetch(url, Object.assign({ credentials: 'include' }, init));
      if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + shortUrl(url));
      return res.text();
    }

    async function postInnertube(endpoint, body, ytcfg, client) {
      const key = ytcfg.INNERTUBE_API_KEY;
      const url = ORIGIN + '/youtubei/v1/' + endpoint + '?prettyPrint=false' + (key ? '&key=' + key : '');
      const headers = { 'Content-Type': 'application/json' };
      if (!client) {
        if (ytcfg.INNERTUBE_CONTEXT_CLIENT_NAME) headers['X-Youtube-Client-Name'] = String(ytcfg.INNERTUBE_CONTEXT_CLIENT_NAME);
        if (ytcfg.INNERTUBE_CLIENT_VERSION) headers['X-Youtube-Client-Version'] = ytcfg.INNERTUBE_CLIENT_VERSION;
        if (ytcfg.VISITOR_DATA) headers['X-Goog-Visitor-Id'] = ytcfg.VISITOR_DATA;
      }
      const context = client
        ? { client: Object.assign({ hl: hl(ytcfg) }, client) }
        : ytcfg.INNERTUBE_CONTEXT || { client: { clientName: 'WEB', clientVersion: ytcfg.INNERTUBE_CLIENT_VERSION, hl: hl(ytcfg) } };
      const text = await getText(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(Object.assign({ context }, body)),
      });
      return JSON.parse(text);
    }

    /** Loads the watch page and reads the data that YouTube embeds in it. */
    async function loadContext(videoId) {
      if (contexts.has(videoId)) return contexts.get(videoId);
      const promise = (async () => {
        const html = await getText(ORIGIN + '/watch?v=' + encodeURIComponent(videoId) + '&bpctr=9999999999&has_verified=1');
        const ytcfg = YTT.extractYtcfg(html);
        const playerResponse = YTT.extractPlayerResponse(html);
        const initialData = YTT.extractInitialData(html);
        if (!playerResponse) {
          throw new Error('Could not read the video data from the YouTube page. YouTube may have asked for consent or sign-in.');
        }
        const pr = playerResponse.videoDetails && playerResponse.videoDetails.videoId;
        if (pr && pr !== videoId) throw new Error('YouTube returned data for a different video.');
        return { videoId, ytcfg, playerResponse, initialData, tracks: YTT.listTracks(playerResponse) };
      })();
      contexts.set(videoId, promise);
      promise.catch(() => contexts.delete(videoId));
      return promise;
    }

    /** Video title, author, and caption tracks (without the private URLs). */
    async function getVideoInfo(videoId, preferredLangs) {
      const ctx = await loadContext(videoId);
      const details = YTT.videoDetails(ctx.playerResponse);
      const def = YTT.pickDefaultTrack(ctx.tracks, preferredLangs);
      return {
        videoId,
        title: details.title,
        author: details.author,
        lengthSeconds: details.lengthSeconds,
        playabilityError: YTT.playabilityError(ctx.playerResponse),
        hasTranscriptPanel: !!YTT.findTranscriptParams(ctx.initialData),
        tracks: ctx.tracks.map(({ baseUrl, ...rest }) => rest),
        defaultTrackId: def ? def.id : null,
      };
    }

    function potFor(videoId) {
      for (const url of resourceUrls().slice().reverse()) {
        if (url.indexOf('/api/timedtext') === -1) continue;
        try {
          const u = new URL(url);
          if (u.searchParams.get('v') === videoId && u.searchParams.get('pot')) {
            return { pot: u.searchParams.get('pot'), c: u.searchParams.get('c') };
          }
        } catch (_) {
          /* ignore malformed URLs */
        }
      }
      return null;
    }

    async function fetchTimedtext(baseUrl, extra) {
      const u = new URL(YTT.withFormat(baseUrl, 'json3'), ORIGIN);
      if (extra) {
        for (const [k, v] of Object.entries(extra)) if (v) u.searchParams.set(k, v);
      }
      let segments = YTT.parseTimedtext(await getText(u.toString()));
      if (!segments.length) {
        // Some caption URLs only answer in their own default (XML) format.
        segments = YTT.parseTimedtext(await getText(YTT.withFormat(baseUrl, null)));
      }
      return segments;
    }

    const methods = {
      async timedtext(ctx, track) {
        if (!track) throw new Error('no caption track');
        return fetchTimedtext(track.baseUrl, potFor(ctx.videoId));
      },

      async panel(ctx, track) {
        let params = YTT.findTranscriptParams(ctx.initialData);
        if (!params) throw new Error('no transcript button on this video');
        let response = await postInnertube('get_transcript', { params }, ctx.ytcfg);
        // The panel opens in a default language. Switch to the chosen one.
        if (track) {
          const other = panelLanguageParams(response, track);
          if (other) {
            params = other;
            response = await postInnertube('get_transcript', { params }, ctx.ytcfg);
          }
        }
        return YTT.parseTranscriptPanel(response);
      },

      async android(ctx, track) {
        const pr = await postInnertube('player', { videoId: ctx.videoId, contentCheckOk: true, racyCheckOk: true }, ctx.ytcfg, ANDROID_CLIENT);
        const tracks = YTT.listTracks(pr);
        const match =
          (track && tracks.find((t) => t.languageCode === track.languageCode && t.isAuto === track.isAuto)) ||
          (track && tracks.find((t) => t.languageCode === track.languageCode)) ||
          (!track && tracks[0]);
        if (!match) throw new Error('no matching track for the Android client');
        return fetchTimedtext(match.baseUrl);
      },
    };

    /**
     * Returns { segments, method, track } for the chosen track.
     * Throws an Error that lists why each method failed.
     */
    async function getTranscript(videoId, trackId) {
      const ctx = await loadContext(videoId);
      const track = ctx.tracks.find((t) => t.id === trackId) || YTT.pickDefaultTrack(ctx.tracks) || null;
      const order = track ? ['timedtext', 'panel', 'android'] : ['panel', 'android'];
      const failures = [];
      for (const name of order) {
        try {
          const segments = await methods[name](ctx, track);
          if (segments.length) {
            return { segments, method: name, track: track ? { id: track.id, label: track.label, languageCode: track.languageCode } : null };
          }
          failures.push(name + ': empty response');
        } catch (err) {
          failures.push(name + ': ' + (err && err.message ? err.message : String(err)));
        }
      }
      const error = new Error(
        ctx.tracks.length ? 'YouTube did not return a transcript.' : 'This video has no captions or transcript.'
      );
      error.details = failures;
      throw error;
    }

    return { getVideoInfo, getTranscript, loadContext, methods };
  }

  /** Finds the get_transcript params for another language in the panel menu. */
  function panelLanguageParams(response, track) {
    const items = YTT.findAllKeys(response, 'subMenuItems')[0] || [];
    const selected = items.find((i) => i.selected);
    const want = track.name.toLowerCase();
    const item =
      items.find((i) => (i.title || '').toLowerCase() === want) ||
      items.find((i) => (i.title || '').toLowerCase().startsWith(want.replace(/\s*\(.*\)$/, '')));
    if (!item || item === selected) return null;
    // Shape: { continuation: { reloadContinuationData: { continuation: "..." } } }
    return YTT.findAllKeys(item, 'continuation').find((v) => typeof v === 'string') || null;
  }

  function hl(ytcfg) {
    return ytcfg.HL || (ytcfg.INNERTUBE_CONTEXT && ytcfg.INNERTUBE_CONTEXT.client && ytcfg.INNERTUBE_CONTEXT.client.hl) || 'en';
  }

  function shortUrl(url) {
    return String(url).replace(/\?.*$/, '');
  }

  const api = { createTranscriptService, panelLanguageParams };
  root.YTT = Object.assign(root.YTT || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
