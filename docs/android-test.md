# Android playback acceptance test

Status: User confirmed that screen-off playback works on their Android device. Device/browser details and individual test durations were not recorded; remaining rows below are still pending. Desktop automation cannot pass this gate.

Record device, Android/browser versions, installed/browser mode, battery saver state, start/end time and observations. Set volume low first. Test files remain local and are not uploaded. Test tones change pitch every 30 seconds and repeat by default. Prefer your own speech/music clips for a realistic listening session.

| Test | Expected | Actual |
| --- | --- | --- |
| Start after explicit tap | Audible, controls update | Pending |
| Lock for 10 minutes | Audio continues with automatic transitions | Pending |
| Lock for 60 minutes | No unexplained stop; at least 10 transitions | Pending |
| Lock-screen play/pause/next | Correct audio and state | Pending |
| Bluetooth play/pause and headset disconnect | Controls work; disconnect does not unexpectedly play on speaker | Pending |
| Incoming call then return | Respects interruption, no unexpected overlapping audio | Pending |
| Battery saver | Record continuity and any restrictions | Pending |
| Browser backgrounded | Same queue continues | Pending |
| Local-file reload | Files must be selected again; no false resume claim | Pending |
| Wi-Fi/mobile/network interruption | NOT covered by local blobs; repeat with real HTTPS audio in next phase | Pending |
| Installed PWA | Install from Chrome menu and repeat locked playback tests | Pending |
| Spotify/moderation transition | NOT implemented or authorized by this test | Pending |

Export the JSON log from Audiotest after each run. Events include wall-clock timestamps, segment numbers, play/pause/error/ended, visibility and online/offline changes. An “ended” event counts a completed segment; manually skipped tracks do not. Browser events can be delayed during suspension, and success in the log does not prove audible output: record your listening observations too. Profiles/file names are not included; logs still contain browser details and timestamps, so review before sharing publicly.

If the required background test fails, do not declare PWA a fix. Diagnose from the log, reproduce and decide on native media-service playback.

## Install the PWA

The HTTPS build includes a web app manifest and a service worker. In Chrome on Android, open the app and choose **Install app** from the browser menu. The service worker caches the static app shell and same-origin JavaScript, CSS and icon files. API calls and generated audio are never cached, so offline use is limited to opening the interface; generation and playback of remote audio still need a connection.
