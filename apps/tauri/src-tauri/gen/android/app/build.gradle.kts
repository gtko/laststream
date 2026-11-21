import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Plugins natifs (lecteur libVLC, téléchargements, mise à jour, écran : src/main/java/com/laststream/app/{player,
// downloads,update,display}) repris de l'ancienne app Capacitor ; l'API `com.getcapacitor` qu'ils utilisent est recréée
// dans src/main/java/com/getcapacitor.

// Version : -PlsVersionCode / -PlsVersionName (CI, même schéma AAAAMMJJNN que l'app Capacitor : la mise à jour en un tap
// compare ce numéro), sinon celle de tauri.conf.json.
val lsVersionCode = (findProperty("lsVersionCode") as String?)?.toInt()
    ?: tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
val lsVersionName = (findProperty("lsVersionName") as String?)
    ?: tauriProperties.getProperty("tauri.android.versionName", "1.0")
// Clé de signature stable (-PlsKeystore=chemin, release CI) : la même que l'app Capacitor, sinon Android refuse la mise à
// jour (« Application non installée »). Le keystore est un debug.keystore (mots de passe et alias standard).
val lsKeystore = findProperty("lsKeystore") as String?

android {
    compileSdk = 36
    namespace = "com.laststream.app"
    defaultConfig {
        applicationId = "com.laststream.app"
        minSdk = 24
        targetSdk = 35
        versionCode = lsVersionCode
        versionName = lsVersionName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    signingConfigs {
        create("publish") {
            if (lsKeystore != null) {
                storeFile = file(lsKeystore)
                storePassword = "android"
                keyAlias = "androiddebugkey"
                keyPassword = "android"
            }
        }
    }
    buildTypes {
        getByName("debug") {
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            // Release CI : clé stable (lsKeystore). Build local sans propriété : clé de debug de la machine.
            signingConfig = signingConfigs.getByName(if (lsKeystore != null) "publish" else "debug")
            // Pas de réduction : les plugins sont trouvés par réflexion (@PluginMethod, @Command).
            isMinifyEnabled = false
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    // libVLC : bibliothèques natives non compressées, comme dans l'app Capacitor.
    packaging {
        jniLibs.useLegacyPackaging = true
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_17
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.core:core-splashscreen:1.0.1")
    implementation("androidx.coordinatorlayout:coordinatorlayout:1.2.0")
    // Moteur de lecture natif (décodage matériel, HEVC / AV1 / DTS / TrueHD / AC3 / EAC3), comme l'app Capacitor.
    implementation("org.videolan.android:libvlc-all:3.6.5")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))
