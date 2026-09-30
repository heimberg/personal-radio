# Android app

The product for listening: native playback of the server-produced program, lock-screen and Bluetooth controls, feedback, the program and the archive. Everyday settings are native in the app's «Studio» tab; the rest comes from the web studio, opened from there (see [Architecture → Division of work](architecture.md#division-of-work-app-and-web-studio)). Source in [`android/`](../android).

## What it does

- **Playback** runs in a foreground media service (Media3 `MediaSessionService` with ExoPlayer), so the program continues with the screen off. Headphones unplugged pause playback; audio focus is respected during calls.
- **Program sync:** every minute (and whenever the program runs out) the app fetches `GET /api/timeline` and makes its playlist after the current item follow the server order: new items are added, moved, removed or rearranged in the app; the item that is playing is never interrupted. If the program had run out while listening, playback continues automatically. If nothing is planned, the app asks the server to plan.
- **Offline buffer:** segments are cached on the device (up to 300 MB) and the next four are downloaded ahead, so short network losses do not interrupt listening.
- **Feedback:** a segment that plays to its end is reported as complete; skipping reports the share heard; 👍/👎 in the app are strong signals. After 👎 on a spoken item the app asks for an optional reason (too long, boring, wrong tone, known already, wrong; `POST /api/timeline/{id}/reason`); repeated reasons become notes for the writer, the editor and the jury.
- **«Mehr dazu»:** the ⊕ button next to 👎/👍 orders a researched, checked follow-up that plays right after the current item (`POST /api/timeline/{id}/more`).
- **«Anders» and surprises (🎲):** the «Gleich» card under the player has «Anders»: the next item gives way to something different at the same place (`POST /api/timeline/{id}/swap`) – a surprise for another surprise of a different kind, any other item for a surprise. Items the planner mixed in carry a die; the options of any item offer the same.
- **Station sound:** before a spoken item that follows music the app plays a short ident jingle (one of four variants, fixed per item); before news the news opener instead. Before every spoken item it plays the host's live transition (`GET /api/linker?after=&next=`): the player loads it shortly before it airs (it is never prefetched), and the Worker writes and voices it then, so it knows what really ran before; the HTTP read timeout is 30 s for that. At the first change of item in the first 20 minutes of a new hour it plays the time signal and the host's spoken hour (`GET /api/sounds/…`, announced in `GET /api/timeline` → `sounds`). Both can be switched off in the settings.
- **Building blocks:** under the player, a row of ready-made blocks (Morgenbriefing, Wetter, Schlagzeilen, Entdeckung, Hintergrund, Künstler-, Genre- and Themen-Stunde, Musikblock, «Neu von deinen Künstlern», Überraschung, Song) and the owner's own shows (`GET /api/blocks`), each as a tile with the icon and colour of its kind. A tap adds the block right after what is playing (`POST /api/blocks/{id}/add`) and it is produced at once; blocks that take a word (a topic, an artist) ask for it, and "KI wählt" leaves the choice to the AI. Nothing has to be written or configured.
- **Notifications:** the app reports when a long production (a music hour or block) is ready and when a production failed, with "Erneut versuchen" in the notification – while the player runs, and every 15 minutes in the background (WorkManager) when the app is closed. The background check reads the program with `GET /api/timeline?peek=1`, which does not count as listening, so the server plans nothing new because of it. Player and background check share one saved state and never report the same thing twice.
- **In-app updates:** every signed build of the deployed branch is also stored on the Worker (`app/personal-radio.apk` and `app/latest.json` in R2, uploaded by the Android workflow with the Cloudflare token). The app checks `GET /api/app/latest` on start; when a newer build is there, a note offers "Update installieren": the APK comes from `GET /api/app/apk` with the service token, is checked against its SHA-256 and handed to Android's installer. The first time, Android asks to allow installing apps from Personal Radio.
- **Sleep timer:** the moon in the player pauses after 15, 30 or 60 minutes or after the playing item (session command `SLEEP`; the state comes back in the session extras and shows on the button).
- **Text and sources:** «Text» in the player (or a tap on the title) shows what is being said – dialogs by speaker, hours with their songs – and the sources as links (`GET /api/timeline/{id}/script`). In the program and the archive, the options of an item offer the same.
- **👍/👎 without opening the app:** the media notification, the lock screen and Android Auto show thumbs next to the transport controls (custom session commands `LIKE`/`DISLIKE`).
- **Android Auto:** the playback service is a `MediaLibraryService`. Android Auto browses "Als Nächstes" (ready items) and "Archiv"; a chosen production plays at once and the program continues after it.
- **Pull to refresh** in the program, the archive and the text view; light haptic feedback when rating, adding and swapping.
- **Arranging the program:** «Programm» shows «Jetzt · Gleich · Später». Swiping a row to the left takes it out of the program (`POST /api/timeline/{id}/remove`); a long press opens its options: «Jetzt hören», «Als Nächstes», «Nach vorne», «Nach hinten», «Anders», «Text und Quellen», «Aus dem Programm nehmen». A new order goes to the server (`POST /api/timeline/arrange`) and the player follows it at once. The times next to the rows say when each item would start from now (the rest of the playing item, then the estimated lengths), and move on every minute. «Mischen», «Song anhängen» and «Jetzt planen» sit above the list; failed productions show there with «Erneut versuchen» (produces them again from scratch) and «Aufräumen» (removes them).
- **Cleaning up the archive:** the options of a production in the archive delete it with its audio (`POST /api/timeline/{id}/delete`).
- **Listen freely:** a tap on a finished item in the program plays it right away. «Archiv» lists everything that can still be heard, grouped by day: new, unheard (left the program after 12 hours) and heard productions, for 7 days after they left the program. The chosen production plays after the current step; the program then continues, and an interrupted item comes back later from the start. Listening again does not count as a new "complete" or "skip"; 👍/👎 still count.
- **«Heute» (mood):** a row of chips under the header on «Hören»: 😌 Eher ruhig, 🧠 Mehr Wissen, 🎵 Mehr Musik, 📰 Was läuft?, 🎲 Überrasch mich. One tap sets the mood until midnight (`POST /api/mood`), a second tap clears it. The planner reads the day plan through the mood (`src/domain/mood.ts`); the saved plan is not changed, and items already planned stay.
- **Day plan in the app:** «Programm» → «Tagesplan» shows the time windows with their blocks. Ready-made windows (Morgen, Mittag, Nachmittag, Abend), start and end in half hours, days (Täglich, Werktags, Wochenende or single days), blocks from the palette (tap a block to take it out; a window keeps one) and the surprise level. «Speichern» reads the settings again and replaces only `schedule` and `surprise`.
- **Four tabs:** «Hören» (the player in full and the «Gleich» card), «Programm» (the building blocks: a tap adds one at the end; then «Jetzt · Gleich · Später»), «Archiv» and «Studio», with a navigation bar at the bottom. On every tab but «Hören» a mini player shows what plays, with play/pause and next; a tap opens the player. Back leads through the web studio's pages back to the native studio, then to «Hören». Planning needs no button: the playback service plans whenever nothing is open, and Play on an empty program starts it. «Spotify verbinden» first tries the quiet App Remote connection; without a permission it opens Spotify's own login (auth library 2.1.0, scope `app-remote-control`, redirect `personal-radio://spotify-callback`), then connects. The token only proves the permission and is dropped. The button appears on «Hören» only until the owner allowed it once; saving the connection again asks for Spotify again (the way to repair a lost permission).
- **Studio:** native (`StudioScreen`, `StudioSettings` in core): a card with the station at a glance, then cards that open in place, one at a time: Sender und Moderation (name, host, tone, style, co-host, instructions), Stimme (for the host or, switched with a chip, the second voice in dialogs; own, standard, German library and Mistral voices from `GET /api/voices`, library search, «✨ Entwerfen» from a description, «🎤 Meine Stimme» to clone: a 10–30 s sample and Google's German consent sentence, recorded as 24 kHz mono WAV (`VoiceRecorder`, microphone permission asked on first use) and sent to Google only on «Erstellen»; own voices can be deleted; every voice with ▶ for a sample: `GET /api/voices/preview?voice=&style=`, the host introducing the station, kept in R2; the radio pauses for it and goes on afterwards), Wo du hörst (place search through `GET /api/places`), Interessen (topic chips, own interests, exploration), Musik (songs between items, taste, announcements) and Stationssound (the four switches). Changes stay local until «Speichern» (or «Verwerfen»); saving reads the settings again and replaces only these fields (`StudioSettings.mergeInto`), so shows, feeds, agents and the day plan stay untouched, and a refused value names its field. «Mehr» leads to the day plan and to the web studio (shows, feeds, editorial team, usage, Spotify listening profile), which opens inside the tab with a back arrow and is kept loaded. «Verbindung» and the installed version sit at the top.
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

The app follows «Nocturne Spektrum»: the Nocturne ground (dark blue-grey, Inter at 400/500, a blurple accent for the station itself, outlined buttons) plus one colour per kind of content, always paired with an icon and a name:

| Kind | Colour | Examples |
| --- | --- | --- |
| Aktuell | `#D08A2A` | Morgenbriefing ☕, Schlagzeilen 📰 |
| Wissen | `#2BA57A` | Entdeckung 🔭, Hintergrund 🎙️, Vertiefung 🔍 |
| Wetter | `#5B95F5` | Wetter ☀️ |
| Musik | `#D06BD8` | Song 🎶, music hours, Musikblock 🎵, Neu ✨ |
| Überraschung | `#F0704F` | 🎲 and the surprise blocks |

The mapping lives in `core/Kinds.kt` (the colours are shared with `src/domain/kinds.ts` of the web studio); `Visuals.kt` turns a kind into tinted tiles, badges and chips. The player is a card tinted in the playing item's colour, with a glowing orb (`Orb`) and a waveform of the item's progress (`Waveform`, display only) in the same colour, and a chip naming the kind. Every item has a cover (`Cover` in `Visuals.kt`): the album image of its song or its first song (Spotify's image CDN, `imageUrl` on track parts, loaded with Coil without any token), otherwise a tile in the kind's colour with soft rings and the icon. The playing song's cover also goes into the media metadata, so the notification and the lock screen show it. Blocks are tinted tiles with an icon badge; every program row has a colour bar, an icon badge and the kind above its title.

- Screens: Jetpack Compose with Material 3 (`MainActivity`, `RadioApp.kt` and one file per tab). The tokens are in `RadioTheme.kt` (`Nocturne`: ground, surface, text, accent, the kind colours from `core/Kinds.kt`) and the type scale (Inter 400 and 500). Take colours from there instead of hard-coding them.
- The setup and text screens are still views: their tokens are in `res/values/colors.xml`, `dimens.xml` and `themes.xml` (same values).
- Assets: Inter 4.1 (Latin subset, SIL OFL 1.1) in `res/font`, Phosphor icons (MIT) as vector drawables `ic_*`. License texts are in `app/licenses/`.
- Motion: the orb breathes and the waveform sways only while audio plays.

## Build and test

- Program logic (pure Kotlin, no Android SDK needed): `cd android && ./gradlew -p core test`
- APK (needs the Android SDK; CI does this): `cd android && ./gradlew :app:assembleRelease`

CI (`.github/workflows/android.yml`) runs both on every change under `android/` and keeps the APK for 30 days.

## Acceptance test

The [Android playback test](android-test.md) applies to the app: 60 minutes screen-off with at least 10 automatic transitions, lock-screen and Bluetooth controls, an incoming call, a network change and the automatic continuation when the program had run out.
