package app.quicky.android

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Build
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.asin
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.sin

/**
 * The widgets' little sounds, made the way the app makes them (`src/lib/sfx.ts`): a few notes with
 * a quick fade in and out, rendered to a tiny buffer, no audio files. They follow the app's Sounds
 * switch and volume (the snapshot's `sfx`). With the phone on silent or vibrate there's a light
 * haptic tick instead.
 */
object Sfx {
    /** A note: start and (optional) glide-to frequency in Hz, length and start in seconds, loudness, triangle or sine. */
    private class Note(val f: Double, val to: Double = 0.0, val d: Double, val t: Double = 0.0, val g: Double = 0.6, val tri: Boolean = false)

    private const val RATE = 44100

    // The same recipes as sfx.ts.
    private val SOUNDS = mapOf(
        "add" to listOf(Note(520.0, 780.0, 0.11, tri = true), Note(1040.0, d = 0.1, t = 0.06, g = 0.35)),
        "done" to listOf(
            Note(659.0, d = 0.14, g = 0.5, tri = true),
            Note(880.0, d = 0.14, t = 0.08, g = 0.5, tri = true),
            Note(1319.0, d = 0.28, t = 0.16, g = 0.45),
        ),
        "doing" to listOf(Note(440.0, 620.0, 0.1, g = 0.5, tri = true)),
        "undo" to listOf(Note(720.0, 420.0, 0.15, g = 0.45, tri = true)),
        "delete" to listOf(Note(260.0, 110.0, 0.22, g = 0.5, tri = true)),
        "open" to listOf(Note(380.0, 640.0, 0.11, g = 0.3)),
        "tap" to listOf(Note(880.0, 620.0, 0.06, g = 0.35)),
    )

    private val cache = HashMap<String, ShortArray>()

    /** Plays a sound (or, on silent, a haptic tick). Never throws: sound is a nicety. */
    fun play(ctx: Context, name: String) {
        try {
            val prefs = Store.snapshot(ctx).optJSONObject("sfx")
            val on = prefs?.optBoolean("on", true) ?: true
            val volume = (prefs?.optDouble("volume", 0.6) ?: 0.6).coerceIn(0.0, 1.0)
            val audio = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            if (audio.ringerMode != AudioManager.RINGER_MODE_NORMAL) {
                tick(ctx)
                return
            }
            if (!on || volume <= 0.0) return
            val pcm = cache.getOrPut(name) { render(SOUNDS[name] ?: return) }
            val track = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
                .setAudioFormat(
                    AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(RATE)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build(),
                )
                .setTransferMode(AudioTrack.MODE_STATIC)
                .setBufferSizeInBytes(pcm.size * 2)
                .build()
            track.write(pcm, 0, pcm.size)
            // The app's volume; the phone's own sound volume applies on top.
            track.setVolume(volume.toFloat())
            track.setNotificationMarkerPosition(pcm.size)
            track.setPlaybackPositionUpdateListener(object : AudioTrack.OnPlaybackPositionUpdateListener {
                override fun onMarkerReached(t: AudioTrack) = t.release()
                override fun onPeriodicNotification(t: AudioTrack) {}
            })
            track.play()
        } catch (_: Exception) {
        }
    }

    /** The notes, mixed into 16-bit samples: a 12 ms rise and an exponential fade, as in Web Audio. */
    private fun render(notes: List<Note>): ShortArray {
        val length = notes.maxOf { it.t + it.d + 0.03 }
        val out = DoubleArray((length * RATE).toInt())
        for (n in notes) {
            val start = (n.t * RATE).toInt()
            val count = ((n.d + 0.03) * RATE).toInt()
            var phase = 0.0
            for (i in 0 until count) {
                val time = i.toDouble() / RATE
                val p = (time / n.d).coerceAtMost(1.0)
                val f = if (n.to > 0) n.f * exp(ln(n.to / n.f) * p) else n.f
                phase += 2 * PI * f / RATE
                val wave = if (n.tri) 2 / PI * asin(sin(phase)) else sin(phase)
                val env = when {
                    time < 0.012 -> 0.0001 * exp(ln(n.g / 0.0001) * time / 0.012)
                    time < n.d -> n.g * exp(ln(0.0001 / n.g) * (time - 0.012) / (n.d - 0.012))
                    else -> 0.0
                }
                if (start + i < out.size) out[start + i] += wave * env
            }
        }
        // Peaks at half of full scale: loud enough, never harsh.
        val peak = out.maxOf { abs(it) }.coerceAtLeast(0.0001)
        return ShortArray(out.size) { (out[it] / peak * 0.5 * Short.MAX_VALUE).toInt().coerceIn(-32767, 32767).toShort() }
    }

    /** A light tap of the vibration motor, following the phone's touch feedback setting. */
    private fun tick(ctx: Context) {
        val vibrator = if (Build.VERSION.SDK_INT >= 31) {
            (ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            ctx.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
        if (!vibrator.hasVibrator()) return
        if (Build.VERSION.SDK_INT < 26) {
            @Suppress("DEPRECATION")
            vibrator.vibrate(12)
            return
        }
        val effect = if (Build.VERSION.SDK_INT >= 29) VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK)
        else VibrationEffect.createOneShot(12, VibrationEffect.DEFAULT_AMPLITUDE)
        if (Build.VERSION.SDK_INT >= 33) {
            vibrator.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_TOUCH))
        } else {
            @Suppress("DEPRECATION")
            vibrator.vibrate(effect)
        }
    }
}
