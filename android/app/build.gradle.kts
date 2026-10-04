import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("io.github.takahirom.roborazzi")
}

// CI passes a keystore so every build can update the installed app; without one the debug key signs.
val keystorePath: String? = System.getenv("RADIO_KEYSTORE_PATH")

android {
    namespace = "ch.heimberg.radio"
    compileSdk = 35

    defaultConfig {
        applicationId = "ch.heimberg.radio"
        minSdk = 26
        targetSdk = 35
        versionCode = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 1
        versionName = "0.2.$versionCode"
        // Spotify's login returns to personal-radio://spotify-callback (registered in the Spotify dashboard).
        manifestPlaceholders["redirectSchemeName"] = "personal-radio"
        manifestPlaceholders["redirectHostName"] = "spotify-callback"
    }

    signingConfigs {
        if (keystorePath != null) {
            create("owner") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("RADIO_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("RADIO_KEY_ALIAS")
                keyPassword = System.getenv("RADIO_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            // R8 drops what the libraries do not use (Compose, Media3 …), which makes the APK smaller and
            // starts faster; our own code and the Spotify SDK stay whole (proguard-rules.pro).
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("owner") ?: signingConfigs.getByName("debug")
        }
    }

    buildFeatures { compose = true }
    // Screenshot tests run on the JVM with Robolectric's native graphics; they need the app's resources.
    testOptions { unitTests { isIncludeAndroidResources = true } }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}

kotlin { compilerOptions { jvmTarget.set(JvmTarget.JVM_17) } }

dependencies {
    // Screenshot tests (src/test, golden images in src/test/screenshots): ./gradlew :app:verifyRoborazziDebug
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.17")
    testImplementation("io.github.takahirom.roborazzi:roborazzi:1.76.0")
    testImplementation("io.github.takahirom.roborazzi:roborazzi-compose:1.76.0")
    testImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    implementation("ch.heimberg.radio:core")
    implementation("androidx.core:core-ktx:1.13.1")
    // Installs the baseline profile (src/main/baseline-prof.txt) so startup code is compiled ahead of time.
    implementation("androidx.profileinstaller:profileinstaller:1.4.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    // The screens are Jetpack Compose with Material 3; the transcript and setup screens are still views.
    implementation(platform("androidx.compose:compose-bom:2025.05.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    // Album covers from Spotify's image CDN (no token is sent with them).
    implementation("io.coil-kt:coil-compose:2.7.0")
    // Drag and drop in the program list (a handle reacts on touch, like other apps).
    implementation("sh.calvin.reorderable:reorderable:2.4.3")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.media3:media3-exoplayer:1.8.0")
    implementation("androidx.media3:media3-session:1.8.0")
    implementation("androidx.media3:media3-datasource:1.8.0")
    implementation("androidx.media3:media3-database:1.8.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    // Spotify App Remote controls the installed Spotify app; see libs/README.md.
    implementation(files("libs/spotify-app-remote-release-0.8.0.aar"))
    // Spotify's login, released together with App Remote 0.8.0: grants «app-remote-control» when App Remote asks for it.
    implementation("com.spotify.android:auth:5.0.0")
    implementation("com.google.code.gson:gson:2.11.0")
}

roborazzi {
    outputDir.set(file("src/test/screenshots"))
}
