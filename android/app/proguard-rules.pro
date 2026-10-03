# R8 for the release build: shrink the libraries, keep what is reached by reflection.

# Our own code (app and core) stays whole and readable in crash reports: it is small, and the JSON
# models (kotlinx.serialization) and Compose code are safest kept as they are.
-keep class ch.heimberg.radio.** { *; }
-keepattributes SourceFile,LineNumberTable,*Annotation*,Signature,InnerClasses,EnclosingMethod

# Spotify App Remote and Auth: their messages are mapped with Gson through reflection.
-keep class com.spotify.** { *; }
-keep interface com.spotify.** { *; }
-dontwarn com.spotify.**
-keep class com.google.gson.** { *; }
-keepclassmembers class * { @com.google.gson.annotations.SerializedName <fields>; }
-dontwarn com.google.gson.**

# kotlinx.serialization brings its own rules; these keep the generated serializers of our models.
-keepclassmembers class ch.heimberg.radio.** { *** Companion; kotlinx.serialization.KSerializer serializer(...); }
-dontwarn kotlinx.serialization.**

# Optional dependencies some libraries name but do not need at runtime.
-dontwarn org.slf4j.**
-dontwarn javax.annotation.**
