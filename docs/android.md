# Android app

The single app for listening: native playback of the server-produced program, lock-screen and Bluetooth controls, feedback, and the settings cockpit embedded as a web view. Source in [`android/`](../android).

## What it does

- **Playback** runs in a foreground media service (Media3 `MediaSessionService` with ExoPlayer), so the program continues with the screen off. Headphones unplugged pause playback; audio focus is respected during calls.
- **Program sync:** every minute (and whenever the program runs out) the app fetches `GET /api/timeline` and appends newly ready segments. If the program had run out while listening, playback continues automatically. If nothing is planned, the app asks the server to plan.
- **Offline buffer:** segments are cached on the device (up to 300 MB) and the next four are downloaded ahead, so short network losses do not interrupt listening.
- **Feedback:** a segment that plays to its end is reported as complete; skipping reports the share heard; 👍/👎 in the app are strong signals. The server learns from them.
- **Settings:** "Programm einstellen" opens the web cockpit (persona, shows, sources, program clock as YAML, timeline with sources). Inside the app the cockpit hides its own player.
- **Spotify** is not in the app yet (milestone 3: App Remote SDK).

## One-time setup

1. **Service token:** Cloudflare Zero Trust → Access → Service Auth → *Create Service Token*, e.g. `personal-radio-app`. Copy the Client ID and Client Secret (the secret is shown only once).
2. **Access policy:** in the Access application of the Worker add a policy with action **Service Auth** that includes this service token (next to the existing policy that allows your email).
3. **Worker secret:** `npx wrangler secret put ACCESS_SERVICE_TOKEN_ID` with the token's **Client ID** (ends in `.access`). The Worker then treats requests with this token as the owner.
4. **Install:** open the latest run of **Actions → Android app**, download the artifact `personal-radio-android`, unzip it and install the APK on the phone (allow installation from this source when Android asks).
5. **Connect:** on first start enter the Worker address (`https://…workers.dev`), Client ID and Client Secret. The app tests the connection before it saves anything.

### Updates without reinstalling

Android only updates an app signed with the same key. Without further setup every CI build uses a new debug key, so a new build must be installed after uninstalling the old one (the connection has to be entered again). For in-place updates create a keystore once and store it as repository secrets:

```sh
keytool -genkeypair -v -keystore radio.jks -alias radio -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 radio.jks   # value of RADIO_KEYSTORE_B64
```

Repository secrets: `RADIO_KEYSTORE_B64`, `RADIO_KEYSTORE_PASSWORD`, `RADIO_KEY_ALIAS` (`radio`), `RADIO_KEY_PASSWORD`. Keep `radio.jks` outside the repository.

### Cockpit login

The cockpit's first request carries the service token. If Access still shows its login page inside the app, use the **one-time PIN by email**: Google sign-in is blocked inside embedded web views by Google.

## Build and test

- Program logic (pure Kotlin, no Android SDK needed): `cd android && ./gradlew -p core test`
- APK (needs the Android SDK; CI does this): `cd android && ./gradlew :app:assembleRelease`

CI (`.github/workflows/android.yml`) runs both on every change under `android/` and keeps the APK for 30 days.

## Acceptance test

The [Android playback test](android-test.md) applies to the app: 60 minutes screen-off with at least 10 automatic transitions, lock-screen and Bluetooth controls, an incoming call, a network change and the automatic continuation when the program had run out.
