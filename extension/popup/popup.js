(function () {
  'use strict';

  const ext = globalThis.browser || globalThis.chrome;
  const CONTENT_FILES = ['src/core.js', 'src/fetcher.js', 'src/content.js'];
  const METHOD_NAMES = {
    timedtext: 'caption track',
    panel: 'transcript panel',
    android: 'Android caption track',
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    title: $('title'),
    subtitle: $('subtitle'),
    controls: $('controls'),
    track: $('track'),
    search: $('search'),
    matchCount: $('match-count'),
    timestamps: $('timestamps'),
    follow: $('follow'),
    copy: $('copy'),
    format: $('format'),
    download: $('download'),
    status: $('status'),
    list: $('transcript'),
    footer: $('footer'),
  };

  const state = {
    tabId: null,
    info: null,
    segments: [],
    rows: [],
    activeIndex: -1,
    followTimer: null,
    loadToken: 0,
  };

  // ---------- Preferences (per-viewer convenience only) ----------

  function loadPref(key, fallback) {
    try {
      const v = localStorage.getItem('ytt.' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch (_) {
      return fallback;
    }
  }

  function savePref(key, value) {
    try {
      localStorage.setItem('ytt.' + key, JSON.stringify(value));
    } catch (_) {
      /* Storage can be unavailable. The setting then lasts for this popup only. */
    }
  }

  // ---------- Status display ----------

  function showStatus(message, options) {
    options = options || {};
    els.status.replaceChildren();
    if (options.error) {
      const p = document.createElement('p');
      p.className = 'error';
      p.textContent = message;
      els.status.append(p);
    } else {
      els.status.textContent = message;
    }
    if (options.hint) {
      const hint = document.createElement('p');
      hint.textContent = options.hint;
      els.status.append(hint);
    }
    if (options.details && options.details.length) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = 'Details';
      const ul = document.createElement('ul');
      for (const d of options.details) {
        const li = document.createElement('li');
        li.textContent = d;
        ul.append(li);
      }
      details.append(summary, ul);
      els.status.append(details);
    }
    if (options.retry) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.textContent = 'Try again';
      btn.addEventListener('click', options.retry);
      els.status.append(btn);
    }
  }

  function clearStatus() {
    els.status.replaceChildren();
  }

  // ---------- Talking to the content script ----------

  async function getTargetTab() {
    const param = new URLSearchParams(location.search).get('tabId');
    if (param) {
      document.body.classList.add('in-tab');
      return ext.tabs.get(Number(param));
    }
    const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function send(message) {
    let response;
    try {
      response = await ext.tabs.sendMessage(state.tabId, message);
    } catch (_) {
      response = undefined;
    }
    if (response !== undefined) return response;
    // No content script in this tab yet (for example, the tab was open
    // before the extension was installed). Inject it, then try again.
    await ext.scripting.executeScript({ target: { tabId: state.tabId }, files: CONTENT_FILES });
    return ext.tabs.sendMessage(state.tabId, message);
  }

  function isYouTubeUrl(url) {
    try {
      return /(^|\.)youtube\.com$/.test(new URL(url).hostname);
    } catch (_) {
      return false;
    }
  }

  // ---------- Loading ----------

  async function init() {
    els.timestamps.checked = loadPref('timestamps', true);
    document.body.classList.toggle('no-ts', !els.timestamps.checked);

    let tab;
    try {
      tab = await getTargetTab();
    } catch (err) {
      showStatus('Could not read the open tab.', { error: true, details: [String(err && err.message)] });
      return;
    }
    if (!tab) {
      showStatus('No open tab found.', { error: true });
      return;
    }
    state.tabId = tab.id;

    if (tab.url && !isYouTubeUrl(tab.url)) {
      showStatus('Open a YouTube video, then click this button again.');
      return;
    }
    if (tab.url && !YTT.getVideoId(tab.url)) {
      showStatus('Open a YouTube video page to see its transcript.');
      return;
    }
    await loadInfo();
  }

  async function loadInfo() {
    showStatus('Loading video information…');
    let info;
    try {
      info = await send({ type: 'GET_VIDEO_INFO', languages: navigator.languages });
    } catch (err) {
      showStatus('This extension cannot read this tab.', {
        error: true,
        hint:
          'Give the extension access to youtube.com and reload the page. ' +
          'In Safari: Safari > Settings > Extensions > YouTube Transcript > allow www.youtube.com.',
        details: [String(err && err.message)],
        retry: loadInfo,
      });
      return;
    }
    if (!info || !info.ok) {
      const notVideo = info && info.code === 'NOT_A_VIDEO';
      showStatus((info && info.error) || 'Could not load the video.', {
        error: !notVideo,
        details: info && info.details,
        retry: notVideo ? null : loadInfo,
      });
      return;
    }
    state.info = info;
    els.title.textContent = info.title || 'Untitled video';
    els.title.title = info.title || '';
    els.subtitle.textContent = [info.author, info.lengthSeconds ? YTT.formatTimestamp(info.lengthSeconds) : '']
      .filter(Boolean)
      .join(' · ');

    if (!info.tracks.length && !info.hasTranscriptPanel) {
      showStatus(info.playabilityError || 'This video has no captions or transcript.', { error: !!info.playabilityError });
      return;
    }

    els.track.replaceChildren();
    if (info.tracks.length) {
      for (const t of info.tracks) {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.label;
        els.track.append(opt);
      }
      els.track.value = info.defaultTrackId || info.tracks[0].id;
      els.track.disabled = info.tracks.length < 2;
    } else {
      const opt = document.createElement('option');
      opt.textContent = 'Transcript';
      els.track.append(opt);
      els.track.disabled = true;
    }
    els.controls.hidden = false;
    await loadTranscript();
  }

  async function loadTranscript() {
    const token = ++state.loadToken;
    setActionsEnabled(false);
    els.list.hidden = true;
    els.footer.hidden = true;
    showStatus('Loading transcript…');
    let result;
    try {
      result = await send({
        type: 'GET_TRANSCRIPT',
        videoId: state.info.videoId,
        trackId: state.info.tracks.length ? els.track.value : null,
      });
    } catch (err) {
      result = { ok: false, error: String(err && err.message) };
    }
    if (token !== state.loadToken) return; // A newer request replaced this one.

    if (!result || !result.ok) {
      showStatus((result && result.error) || 'Could not load the transcript.', {
        error: true,
        details: result && result.details,
        retry: loadTranscript,
      });
      return;
    }
    clearStatus();
    state.segments = result.segments;
    renderTranscript();
    els.footer.textContent =
      result.segments.length + ' lines · source: ' + (METHOD_NAMES[result.method] || result.method);
    els.footer.hidden = false;
    setActionsEnabled(true);
    applySearch();
    if (els.follow.checked) startFollow();
  }

  // ---------- Rendering ----------

  function renderTranscript() {
    const frag = document.createDocumentFragment();
    state.rows = state.segments.map((seg, i) => {
      const li = document.createElement('li');
      li.dataset.index = String(i);
      const ts = document.createElement('button');
      ts.type = 'button';
      ts.className = 'ts';
      ts.textContent = YTT.formatTimestamp(seg.start);
      ts.title = 'Jump to ' + ts.textContent;
      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = seg.text;
      li.append(ts, text);
      frag.append(li);
      return { li, text };
    });
    els.list.replaceChildren(frag);
    els.list.hidden = false;
    els.list.scrollTop = 0;
    state.activeIndex = -1;
  }

  function applySearch() {
    const query = els.search.value.trim().toLowerCase();
    let matches = 0;
    state.rows.forEach(({ li, text }, i) => {
      const value = state.segments[i].text;
      if (!query) {
        li.classList.remove('hidden');
        text.textContent = value;
        return;
      }
      const lower = value.toLowerCase();
      if (!lower.includes(query)) {
        li.classList.add('hidden');
        return;
      }
      matches++;
      li.classList.remove('hidden');
      text.replaceChildren(...highlight(value, lower, query));
    });
    els.matchCount.textContent = query ? matches + (matches === 1 ? ' match' : ' matches') : '';
  }

  function highlight(value, lower, query) {
    const parts = [];
    let from = 0;
    for (let at = lower.indexOf(query); at !== -1; at = lower.indexOf(query, from)) {
      if (at > from) parts.push(document.createTextNode(value.slice(from, at)));
      const mark = document.createElement('mark');
      mark.textContent = value.slice(at, at + query.length);
      parts.push(mark);
      from = at + query.length;
    }
    if (from < value.length) parts.push(document.createTextNode(value.slice(from)));
    return parts;
  }

  function setActionsEnabled(enabled) {
    els.copy.disabled = !enabled;
    els.download.disabled = !enabled;
    els.format.disabled = !enabled;
  }

  // ---------- Follow the video ----------

  function startFollow() {
    stopFollow();
    const tick = async () => {
      try {
        const res = await ext.tabs.sendMessage(state.tabId, { type: 'GET_CURRENT_TIME' });
        if (res && res.ok && res.videoId === state.info.videoId) setActive(res.seconds);
      } catch (_) {
        /* The tab may have closed or navigated. */
      }
    };
    tick();
    state.followTimer = setInterval(tick, 1000);
  }

  function stopFollow() {
    if (state.followTimer) clearInterval(state.followTimer);
    state.followTimer = null;
  }

  function setActive(seconds) {
    let index = -1;
    for (let i = 0; i < state.segments.length && state.segments[i].start <= seconds + 0.25; i++) index = i;
    if (index === state.activeIndex) return;
    if (state.rows[state.activeIndex]) state.rows[state.activeIndex].li.classList.remove('active');
    state.activeIndex = index;
    const row = state.rows[index];
    if (row) {
      row.li.classList.add('active');
      row.li.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  // ---------- Export ----------

  function exportText(format) {
    const segs = state.segments;
    switch (format) {
      case 'srt':
        return YTT.toSrt(segs);
      case 'vtt':
        return YTT.toVtt(segs);
      case 'json':
        return JSON.stringify(
          {
            videoId: state.info.videoId,
            title: state.info.title,
            author: state.info.author,
            url: 'https://www.youtube.com/watch?v=' + state.info.videoId,
            language: els.track.selectedOptions[0] ? els.track.selectedOptions[0].textContent : null,
            segments: segs,
          },
          null,
          2
        );
      default:
        return YTT.toPlainText(segs, { timestamps: els.timestamps.checked });
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      // Fallback for browsers that block the async clipboard API in popups.
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    }
  }

  function flash(button, label) {
    const original = button.dataset.label || button.textContent;
    button.dataset.label = original;
    button.textContent = label;
    setTimeout(() => (button.textContent = original), 1500);
  }

  function download(format) {
    const mime = { txt: 'text/plain', srt: 'application/x-subrip', vtt: 'text/vtt', json: 'application/json' }[format];
    const blob = new Blob([exportText(format)], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = YTT.safeFileName(state.info.title) + ' [' + state.info.videoId + '].' + format;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ---------- Events ----------

  els.track.addEventListener('change', loadTranscript);
  els.search.addEventListener('input', applySearch);
  els.timestamps.addEventListener('change', () => {
    document.body.classList.toggle('no-ts', !els.timestamps.checked);
    savePref('timestamps', els.timestamps.checked);
  });
  els.follow.addEventListener('change', () => (els.follow.checked ? startFollow() : stopFollow()));
  els.copy.addEventListener('click', async () => {
    flash(els.copy, (await copyText(exportText('txt'))) ? 'Copied' : 'Copy failed');
  });
  els.download.addEventListener('click', () => download(els.format.value));
  els.list.addEventListener('click', (e) => {
    const ts = e.target.closest('.ts');
    if (!ts) return;
    const seg = state.segments[Number(ts.parentElement.dataset.index)];
    if (seg) send({ type: 'SEEK', seconds: seg.start, play: true }).catch(() => {});
  });

  init();
})();
