/*
 * Content script for youtube.com. Answers requests from the popup.
 * Loaded after core.js and fetcher.js, which define globalThis.YTT.
 */
(function () {
  'use strict';

  const ext = globalThis.browser || globalThis.chrome;
  // The popup can inject this file again into a tab that was open before the
  // extension was installed. Register the listener only once.
  if (globalThis.__yttContentLoaded) return;
  globalThis.__yttContentLoaded = true;

  const service = YTT.createTranscriptService({
    fetch: (url, init) => fetch(url, init),
    origin: location.origin,
    resourceUrls: () => performance.getEntriesByType('resource').map((e) => e.name),
  });

  function currentVideoId() {
    return YTT.getVideoId(location.href);
  }

  function videoElement() {
    return document.querySelector('#movie_player video, video.html5-main-video, video');
  }

  async function handle(message) {
    switch (message && message.type) {
      case 'GET_VIDEO_INFO': {
        const videoId = currentVideoId();
        if (!videoId) return { ok: false, code: 'NOT_A_VIDEO', error: 'Open a YouTube video to see its transcript.' };
        const info = await service.getVideoInfo(videoId, message.languages || navigator.languages);
        return Object.assign({ ok: true }, info);
      }
      case 'GET_TRANSCRIPT': {
        const videoId = message.videoId || currentVideoId();
        if (!videoId) return { ok: false, code: 'NOT_A_VIDEO', error: 'Open a YouTube video to see its transcript.' };
        const result = await service.getTranscript(videoId, message.trackId);
        return Object.assign({ ok: true, videoId }, result);
      }
      case 'SEEK': {
        const video = videoElement();
        if (!video) return { ok: false, error: 'No video player on this page.' };
        video.currentTime = Math.max(0, Number(message.seconds) || 0);
        if (message.play && video.paused) video.play().catch(() => {});
        return { ok: true };
      }
      case 'GET_CURRENT_TIME': {
        const video = videoElement();
        return { ok: true, videoId: currentVideoId(), seconds: video ? video.currentTime : 0 };
      }
      case 'PING':
        return { ok: true };
      default:
        return { ok: false, error: 'Unknown request.' };
    }
  }

  ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handle(message)
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ ok: false, error: (err && err.message) || String(err), details: (err && err.details) || [] })
      );
    return true; // Keep the channel open for the async response.
  });
})();
