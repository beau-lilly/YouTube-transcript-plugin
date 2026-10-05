'use strict';

// Small, made-up stand-ins for the data that YouTube pages and APIs return.

const VIDEO_ID = 'abcdefghijk';

function playerResponse(overrides) {
  return Object.assign(
    {
      playabilityStatus: { status: 'OK' },
      videoDetails: {
        videoId: VIDEO_ID,
        title: 'Test video: "quotes" & {braces}',
        author: 'Test Channel',
        lengthSeconds: '125',
      },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=en&exp=xpe`,
              name: { runs: [{ text: 'English' }] },
              vssId: '.en',
              languageCode: 'en',
            },
            {
              baseUrl: `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=en&kind=asr`,
              name: { simpleText: 'English' },
              vssId: 'a.en',
              languageCode: 'en',
              kind: 'asr',
            },
            {
              baseUrl: `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=de`,
              name: { simpleText: 'German' },
              vssId: '.de',
              languageCode: 'de',
            },
          ],
        },
      },
    },
    overrides
  );
}

function initialData() {
  return {
    engagementPanels: [
      {
        engagementPanelSectionListRenderer: {
          content: {
            continuationItemRenderer: {
              continuationEndpoint: { getTranscriptEndpoint: { params: 'PANEL_PARAMS' } },
            },
          },
        },
      },
    ],
  };
}

function watchPageHtml(pr, data) {
  return (
    '<!doctype html><html><head><script>ytcfg.set({"INNERTUBE_API_KEY":"test-key","INNERTUBE_CLIENT_VERSION":"2.20261001.00.00",' +
    '"INNERTUBE_CONTEXT_CLIENT_NAME":1,"INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"2.20261001.00.00","hl":"en"}}});' +
    'window.ytplayer={};</script><script>ytcfg.set({"VISITOR_DATA":"visitor123"});</script></head><body>' +
    '<script>var ytInitialPlayerResponse = ' +
    JSON.stringify(pr || playerResponse()) +
    ';var meta = document.createElement(\'meta\');</script>' +
    '<script>var ytInitialData = ' +
    JSON.stringify(data || initialData()) +
    ';</script><div id="movie_player"><video class="html5-main-video"></video></div></body></html>'
  );
}

function json3() {
  return {
    events: [
      { tStartMs: 0, dDurationMs: 100000, id: 1 },
      { tStartMs: 500, dDurationMs: 2000, segs: [{ utf8: 'Hello' }, { utf8: ' world', tOffsetMs: 300 }] },
      { tStartMs: 2400, dDurationMs: 100, aAppend: 1, segs: [{ utf8: '\n' }] },
      { tStartMs: 2500, dDurationMs: 1250, segs: [{ utf8: "it's & here" }] },
    ],
  };
}

function panelResponse(selectedTitle) {
  const seg = (startMs, endMs, text) => ({
    transcriptSegmentRenderer: { startMs: String(startMs), endMs: String(endMs), snippet: { runs: [{ text }] } },
  });
  const prefix = selectedTitle === 'German' ? 'Deutsch' : 'Panel';
  return {
    actions: [
      {
        updateEngagementPanelAction: {
          content: {
            transcriptRenderer: {
              content: {
                transcriptSearchPanelRenderer: {
                  body: {
                    transcriptSegmentListRenderer: {
                      initialSegments: [seg(0, 1500, prefix + ' line one'), seg(1500, 3500, prefix + ' line two')],
                    },
                  },
                  footer: {
                    transcriptFooterRenderer: {
                      languageMenu: {
                        sortFilterSubMenuRenderer: {
                          subMenuItems: ['English', 'English (auto-generated)', 'German'].map((title) => ({
                            title,
                            selected: title === selectedTitle,
                            continuation: { reloadContinuationData: { continuation: 'PARAMS_' + title } },
                          })),
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    ],
  };
}

module.exports = { VIDEO_ID, playerResponse, initialData, watchPageHtml, json3, panelResponse };
