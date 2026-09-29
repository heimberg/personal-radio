# Android playback acceptance test

Applies to the [Android app](android.md), the listening product. The web studio has no player.

Status: User confirmed on 2026-09-28 that the Android playback test completed successfully. Device/build details and individual observations were not recorded here. Desktop automation cannot pass this gate.

Record device, Android version, app build, battery saver state, start/end time and observations. Set volume low first. Test files remain local and are not uploaded. Test tones change pitch every 30 seconds and repeat by default. Prefer your own speech/music clips for a realistic listening session.

| Test | Expected | Actual |
| --- | --- | --- |
| Start after explicit tap | Audible, controls update | Pending |
| Lock for 10 minutes | Audio continues with automatic transitions | Pending |
| Lock for 60 minutes | No unexplained stop; at least 10 transitions | Pending |
| Lock-screen play/pause/next | Correct audio and state | Pending |
| Bluetooth play/pause and headset disconnect | Controls work; disconnect does not unexpectedly play on speaker | Pending |
| Incoming call then return | Respects interruption, no unexpected overlapping audio | Pending |
| Battery saver | Record continuity and any restrictions | Pending |
| App backgrounded and screen off | Same queue continues | Pending |
| Wi-Fi/mobile/network interruption | NOT covered by local blobs; repeat with real HTTPS audio in next phase | Pending |
| Spotify/moderation transition | NOT implemented or authorized by this test | Pending |

Note the time of every interruption, skipped handoff or unexpected pause, and what you were doing (screen off, call, network change, Bluetooth). Record your listening observations: a clean log does not prove audible output.

If background playback fails, diagnose from the log and reproduce it in the Android app's Media3 service. Browser/PWA behavior is outside this acceptance test.
