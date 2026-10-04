plugins {
    id("com.android.application") version "8.12.0" apply false
    id("org.jetbrains.kotlin.android") version "2.4.20" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.20" apply false
    // Screenshot tests of the Compose screens (JVM, no emulator).
    id("io.github.takahirom.roborazzi") version "1.76.0" apply false
}
