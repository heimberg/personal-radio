# Android app

The product for listening: native playback of the server-produced program, lock-screen and Bluetooth controls, feedback, the program list and quick actions. Settings and planning come from the web cockpit, embedded in the app (see [Architecture → Division of work](architecture.md#division-of-work-app-and-web-cockpit)). Source in [`android/`](../android).

## What it does

- **Playback** runs in a foreground media service (Media3 `MediaSessionService` with ExoPlayer), so the program continues with the screen off. Headphones unplugged pause playback; audio focus is respected during calls.
- **Program sync:** every minute (and whenever the program runs out) the app fetches `GET /api/timeline` and makes its playlist after the current item follow the server order: new items are added, moved, removed or rearranged in the app; the item that is playing is never interrupted. If the program had run out while listening, playback continues automatically. If nothing is planned, the app asks the server to plan.
- **Offline buffer:** segments are cached on the device (up to 300 MB) and the next four are downloaded ahead, so short network losses do not interrupt listening.
- **Feedback:** a segment that plays to its end is reported as complete; skipping reports the share heard; 👍/👎 in the app are strong signals. The server learns from them.
- **Text and sources:** the ⓘ button in the player (or a tap on the title) shows what is being said – dialogs by speaker, hours with their songs – and the sources as links (`GET /api/timeline/{id}/script`). In the archive, a long press offers the same.
- **👍/👎 without opening the app:** the media notification, the lock screen and Android Auto show thumbs next to the transport controls (custom session commands `LIKE`/`DISLIKE`).
- **Android Auto:** the playback service is a `MediaLibraryService`. Android Auto browses "Als Nächstes" (ready items) and "Archiv"; a chosen production plays at once and the program continues after it.
- **Pull to refresh** on the main screen, in the archive and in the text view; light haptic feedback when moving rows, rating and opening a menu.
- **Arranging with the finger:** in "Als Nächstes" every row but the playing one has a handle; drag it (or long-press the row) to move the item. The new order goes to the server (`POST /api/timeline/arrange`) and the player follows it at once. The times next to the rows say when each item would start from now (the rest of the playing item, then the estimated lengths), and move on every minute.
- **Cleaning up the archive:** a long press on a production in the archive deletes it with its audio (`POST /api/timeline/{id}/delete`).
- **Listen freely:** a tap on a finished item in "Als Nächstes" plays it right away. "Archiv · frei hören" lists everything that can still be heard, grouped by day: new, unheard (left the program after 12 hours) and heard productions, for 7 days after they left the program. The chosen production plays after the current step; the program then continues, and an interrupted item comes back later from the start. Listening again does not count as a new "complete" or "skip"; 👍/👎 still count.
- **Main screen, kept simple:** player, "Als Nächstes", one primary action ("Sendung sofort produzieren"), then "Archiv" and "Einstellungen" side by side and "Verbindung" at the bottom. Planning needs no button: the playback service plans whenever nothing is open, and Play on an empty program starts it. "Spotify verbinden" appears only until the owner allowed it once; saving the connection again asks for Spotify again (the way to repair a lost permission).
- **Quick production:** tap a show in the list and it is produced. Artist, genre and theme hours first ask for an optional subject; leaving it blank lets the AI choose.
- **Settings and planning:** "Einstellungen" opens the web cockpit inside the app (persona, voices, shows, program clock, music, feeds, arranging the timeline, YAML). Native in the app are the things used while listening: the program list, immediate production and feedback.
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

## Design

The app follows the Nocturne design system, direction "1c Kompakt" from the Claude Design handoff: a dark blue-grey ground, Inter at 400/500, one blurple accent used for lines and glow, outlined buttons, and rules that fade at their ends. The player is a compact card with a glowing orb (`OrbView`) and a waveform that shows the segment's progress (`WaveformView`, display only). The program list follows, then the actions.

- Tokens: `res/values/colors.xml` (ground, surface, text, accent and the 100–900 ramps) and `res/values/dimens.xml` (the compact 0.7× spacing scale and radii). Take colours and spacing from there instead of hard-coding them.
- Styles: `res/values/themes.xml` holds the theme, the button variants (`Button`, `.Primary`, `.Ghost`, `.Icon`, `.Play`), the input and the text styles (apply them with `style=`).
- Assets: Inter 4.1 (Latin subset, SIL OFL 1.1) in `res/font`, Phosphor icons (MIT) as vector drawables `ic_*`. License texts are in `app/licenses/`.
- Motion: the orb breathes and the waveform sways only while audio plays, and both stay still when the system's animations are turned off.

## Build and test

- Program logic (pure Kotlin, no Android SDK needed): `cd android && ./gradlew -p core test`
- APK (needs the Android SDK; CI does this): `cd android && ./gradlew :app:assembleRelease`

CI (`.github/workflows/android.yml`) runs both on every change under `android/` and keeps the APK for 30 days.

## Acceptance test

The [Android playback test](android-test.md) applies to the app: 60 minutes screen-off with at least 10 automatic transitions, lock-screen and Bluetooth controls, an incoming call, a network change and the automatic continuation when the program had run out.
