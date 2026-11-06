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

// The release signing key: from the environment in CI (the keystore decoded from a repository
// secret), else this PC's own files in ~/.quicky/android/ (never in the repo). Without either, a
// release build comes out unsigned. Losing the key means new APKs can't update installed ones.
val releaseKey: Map<String, String>? = run {
    val env = System.getenv()
    if (!env["ANDROID_KEYSTORE_FILE"].isNullOrEmpty()) {
        return@run mapOf(
            "storeFile" to env.getValue("ANDROID_KEYSTORE_FILE"),
            "storePassword" to (env["ANDROID_KEYSTORE_PASSWORD"] ?: ""),
            "keyAlias" to (env["ANDROID_KEY_ALIAS"] ?: "quicky"),
            "keyPassword" to (env["ANDROID_KEY_PASSWORD"] ?: env["ANDROID_KEYSTORE_PASSWORD"] ?: ""),
        )
    }
    val home = System.getProperty("user.home")
    val local = file("$home/.quicky/android/keystore.properties")
    if (!local.exists()) return@run null
    val p = Properties().apply { local.inputStream().use { load(it) } }
    p.stringPropertyNames().associateWith { p.getProperty(it) }
}

android {
    compileSdk = 37
    namespace = "app.quicky.mobile"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "app.quicky.mobile"
        minSdk = 24
        targetSdk = 37
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        if (releaseKey != null) {
            create("release") {
                storeFile = file(releaseKey.getValue("storeFile"))
                storePassword = releaseKey.getValue("storePassword")
                keyAlias = releaseKey.getValue("keyAlias")
                keyPassword = releaseKey.getValue("keyPassword")
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
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
            if (releaseKey != null) signingConfig = signingConfigs.getByName("release")
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
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
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))
