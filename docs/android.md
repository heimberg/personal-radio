# Android app

The single app for listening: native playback of the server-produced program, lock-screen and Bluetooth controls, feedback, and the settings cockpit embedded as a web view. Source in [`android/`](../android).

## What it does

- **Playback** runs in a foreground media service (Media3 `MediaSessionService` with ExoPlayer), so the program continues with the screen off. Headphones unplugged pause playback; audio focus is respected during calls.
- **Program sync:** every minute (and whenever the program runs out) the app fetches `GET /api/timeline` and makes its playlist after the current item follow the server order: new items are added, items moved, removed or shuffled in the cockpit are rearranged; the item that is playing is never interrupted. If the program had run out while listening, playback continues automatically. If nothing is planned, the app asks the server to plan.
- **Offline buffer:** segments are cached on the device (up to 300 MB) and the next four are downloaded ahead, so short network losses do not interrupt listening.
- **Feedback:** a segment that plays to its end is reported as complete; skipping reports the share heard; 👍/👎 in the app are strong signals. The server learns from them.
- **Settings:** "Programm einstellen" opens the web cockpit (persona, shows, sources, program clock as YAML, timeline with sources). Inside the app the cockpit hides its own player.
- **Spotify (artist hours):** the app controls the installed Spotify app through the App Remote SDK. An artist hour's tracks sit in the playlist as silent placeholders with the song's title, so the notification, pause and "next" work for music as for speech. When a placeholder starts, Spotify plays that one track and our player gives up audio focus; when Spotify reports the track's end (or moves on), the app pauses Spotify at once and continues with the next spoken part. If Spotify pauses on its own (a call), the app pauses too and resumes with it. Hours wait in the queue until Spotify is connected, so they never play without their music. Nothing Spotify reports leaves the phone.

### Spotify

1. **Spotify developer app** (the same app whose ID and secret the Worker uses): add the redirect URI `personal-radio://spotify-callback`, tick **Android**, and add the package `ch.heimberg.radio` with the SHA1 fingerprint of the signing key (the CI log prints it in the step *Prepare signing key*). In development mode, add your Spotify account under *User Management*.
2. **Worker:** `SPOTIFY_CLIENT_ID` (variable) and `SPOTIFY_CLIENT_SECRET` (secret). The timeline response carries the client ID to the app; the secret never leaves the Worker.
3. **Phone:** Spotify app installed and logged in (Premium). In our app tap **Spotify verbinden** once and allow access in Spotify's dialog. Afterwards the playback service connects on its own.

The SDK (`app/libs/spotify-app-remote-release-0.8.0.aar`, Apache 2.0) is vendored because Spotify does not publish it to Maven; see `app/libs/README.md` for its source and checksum.

## One-time setup

1. **Service token:** Cloudflare Zero Trust → Access → Service Auth → *Create Service Token*, e.g. `personal-radio-app`. Copy the Client ID and Client Secret (the secret is shown only once).
2. **Access policy:** in the Access application of the Worker add a policy with action **Service Auth** that includes this service token (next to the existing policy that allows your email).
3. **Worker secret:** add `ACCESS_SERVICE_TOKEN_ID` with the token's **Client ID** (ends in `.access`) in the dashboard (Worker → Settings → Variables and Secrets) or with `npx wrangler secret put ACCESS_SERVICE_TOKEN_ID`. The Worker then treats requests with this token as the owner.
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
