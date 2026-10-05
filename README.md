# YouTube Transcript

A browser extension for Chrome and Safari. It shows the transcript of the YouTube video in the open tab.

## Features

- Shows the transcript with timestamps.
- Lets you select a caption language, including auto-generated captions.
- Searches the transcript and highlights the matches.
- Moves the video to a line when you click its timestamp.
- Highlights the line that plays now ("Follow").
- Copies the transcript as text.
- Downloads the transcript as `.txt`, `.srt`, `.vtt`, or `.json`.

## How it gets the transcript

YouTube has no public transcript API. The extension uses the same private endpoints that the YouTube website uses. The content script sends all requests from the youtube.com page. Thus the requests use your normal YouTube session. No other server gets your data.

1. The extension loads the watch page and reads the data that YouTube puts in it: `ytcfg`, `ytInitialPlayerResponse` (caption tracks), and `ytInitialData` (transcript panel).
2. It tries these methods in sequence. It stops at the first method that gives text:

| Method | Endpoint | Notes |
| --- | --- | --- |
| Caption track | `/api/timedtext?…&fmt=json3` | The caption URL from the player data. Many videos need a proof-of-origin token (`pot`). If the page player already loaded captions, the extension uses the same token again. |
| Transcript panel | `POST /youtubei/v1/get_transcript` | The same request as the **Show transcript** button on YouTube. |
| Android caption track | `POST /youtubei/v1/player` with the `ANDROID` client | These caption URLs do not need a token. |

The popup footer shows which method gave the transcript. If all methods fail, the popup shows the reason for each failure under **Details**.

YouTube changes these endpoints often. If a method stops working, the other methods usually continue to work.

## Install in Chrome (and Edge, Brave, Arc)

1. Go to `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the `extension` folder.
4. Open a YouTube video. Click the extension button in the toolbar.

To make a zip file for the Chrome Web Store:

```sh
npm run package:chrome   # writes dist/youtube-transcript-chrome-<version>.zip
```

## Install in Safari (macOS and iOS)

Safari extensions must be in an app. Apple's converter makes an Xcode project from the same `extension` folder. You must have a Mac with Xcode.

1. Run:

   ```sh
   npm run build:safari
   # Optional: BUNDLE_ID=com.yourname.youtube-transcript npm run build:safari
   ```

2. Open `safari/YouTube Transcript/YouTube Transcript.xcodeproj` in Xcode.
3. Select the macOS scheme and click **Run**.
4. In Safari, go to **Settings > Advanced** and turn on **Show features for web developers**. Then go to **Develop** and turn on **Allow Unsigned Extensions**.
5. Go to **Settings > Extensions** and turn on **YouTube Transcript**. Let it use `www.youtube.com`.

For iOS, select the iOS scheme in Xcode and run it on a device or simulator. Then turn on the extension in **Settings > Apps > Safari > Extensions**.

## Project layout

```
extension/
  manifest.json      Manifest V3. Chrome and Safari use the same file.
  src/core.js        Parsers and formatters. No network and no browser APIs.
  src/fetcher.js     The three transcript methods and the fallback sequence.
  src/content.js     Content script. Answers messages from the popup.
  popup/             The popup UI.
  icons/
scripts/
  package-chrome.sh  Makes the Chrome Web Store zip file.
  build-safari.sh    Makes the Safari Xcode project.
test/
  *.test.js          Unit tests (Node test runner, no dependencies).
  e2e/               Loads the extension in Chromium with a fake youtube.com.
```

## Tests

```sh
npm test            # unit tests
npm install         # one time, for the end-to-end test
npm run test:e2e    # loads the extension in headless Chromium
```

The tests do not connect to YouTube. They use made-up responses in `test/fixtures/youtube.js`.

## Permissions

- `activeTab` and `scripting`: let the popup add the content script to a YouTube tab that was open before you installed the extension.
- Host access to `www.youtube.com` and `m.youtube.com`: lets the content script run on YouTube.

## Limits

- Some videos have no captions and no transcript. The popup then shows "This video has no captions or transcript."
- Private, age-restricted, and members-only videos can fail when you are not signed in.
- Safari can block the **Download** button in some versions. Use **Copy** if this occurs.
