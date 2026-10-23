# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.

# Keep all app classes and JNI methods called from Rust
-keep class dev.drexius.terminal.** { *; }
-keepclassmembers class dev.drexius.terminal.** { *; }
