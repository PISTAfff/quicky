package app.quicky.android

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray
import org.json.JSONObject

/**
 * Reminders as Android notifications. The page works out the coming reminders (tasks and calendar
 * events, quiet hours already applied) and hands them over as a list of
 * `{key, at, title, body, task?, event?}`; each becomes an alarm that posts a notification, even
 * with Quicky closed. Its buttons (Done, Snooze 10 min) are queued for the page.
 */
object Alarms {
    const val CHANNEL = "reminders"
    private const val SNOOZE_MIN = 10

    private fun manager(ctx: Context) = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager

    private fun pending(ctx: Context, a: JSONObject, flags: Int): PendingIntent? {
        val intent = Intent(ctx, AlarmReceiver::class.java).putExtra("alarm", a.toString())
        intent.action = "app.quicky.alarm." + a.optString("key")
        return PendingIntent.getBroadcast(ctx, a.optString("key").hashCode(), intent, flags or PendingIntent.FLAG_IMMUTABLE)
    }

    /** Cancels what was scheduled and schedules this list instead. */
    fun replace(ctx: Context, list: JSONArray) {
        val old = Store.alarms(ctx)
        for (i in 0 until old.length()) {
            val a = old.optJSONObject(i) ?: continue
            pending(ctx, a, PendingIntent.FLAG_NO_CREATE)?.let { manager(ctx).cancel(it); it.cancel() }
        }
        val now = System.currentTimeMillis()
        val kept = JSONArray()
        for (i in 0 until list.length()) {
            val a = list.optJSONObject(i) ?: continue
            if (a.optLong("at") <= now) continue
            set(ctx, a)
            kept.put(a)
        }
        Store.setAlarms(ctx, kept)
    }

    /** Puts every scheduled reminder back (after a restart or an update). */
    fun restore(ctx: Context) {
        val list = Store.alarms(ctx)
        val now = System.currentTimeMillis()
        for (i in 0 until list.length()) {
            val a = list.optJSONObject(i) ?: continue
            if (a.optLong("at") > now) set(ctx, a)
        }
    }

    fun set(ctx: Context, a: JSONObject) {
        val pi = pending(ctx, a, PendingIntent.FLAG_UPDATE_CURRENT) ?: return
        val am = manager(ctx)
        val at = a.optLong("at")
        if (Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        } else {
            // Exact alarms not allowed: Android may move it by a few minutes.
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        }
    }

    /** One more go of a reminder in a few minutes (the notification's Snooze), kept in the list. */
    fun snooze(ctx: Context, a: JSONObject) {
        val again = JSONObject(a.toString())
            .put("key", a.optString("key") + "+s" + System.currentTimeMillis())
            .put("at", System.currentTimeMillis() + SNOOZE_MIN * 60_000L)
        set(ctx, again)
        val list = Store.alarms(ctx)
        list.put(again)
        Store.setAlarms(ctx, list)
    }

    fun channel(ctx: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = ctx.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) != null) return
        val ch = NotificationChannel(CHANNEL, "Reminders", NotificationManager.IMPORTANCE_HIGH)
        ch.description = "Task and calendar reminders"
        ch.enableVibration(true)
        nm.createNotificationChannel(ch)
    }

    fun notify(ctx: Context, a: JSONObject) {
        channel(ctx)
        val key = a.optString("key")
        val id = key.hashCode()
        val task = a.optString("task", "")
        val open = JSONObject().put("type", "open")
        if (task.isNotEmpty()) open.put("id", task) else open.put("calendar", true)
        val content = launchIntent(ctx, open)?.let {
            PendingIntent.getActivity(ctx, id, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }
        val b = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_quicky)
            .setContentTitle(a.optString("title"))
            .setContentText(a.optString("body"))
            .setStyle(NotificationCompat.BigTextStyle().bigText(a.optString("body")))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .setContentIntent(content)
        val color = Store.snapshot(ctx).optString("accent", "")
        if (color.isNotEmpty()) try { b.setColor(android.graphics.Color.parseColor(color)) } catch (_: Exception) {}
        if (task.isNotEmpty()) b.addAction(0, "Done", action(ctx, a, "done", id))
        b.addAction(0, "Snooze $SNOOZE_MIN min", action(ctx, a, "snooze", id))
        try {
            NotificationManagerCompat.from(ctx).notify(id, b.build())
        } catch (_: SecurityException) {
            // Notifications not allowed: nothing to show.
        }
    }

    private fun action(ctx: Context, a: JSONObject, what: String, id: Int): PendingIntent {
        val i = Intent(ctx, ActionReceiver::class.java)
            .setAction("app.quicky.$what." + a.optString("key"))
            .putExtra("what", what)
            .putExtra("alarm", a.toString())
            .putExtra("notification", id)
        return PendingIntent.getBroadcast(ctx, id * 31 + what.hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
}

/** A reminder is due: show it. */
class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val a = try { JSONObject(intent.getStringExtra("alarm") ?: return) } catch (_: Exception) { return }
        Alarms.notify(ctx, a)
    }
}

/** A notification's Done or Snooze. */
class ActionReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val a = try { JSONObject(intent.getStringExtra("alarm") ?: return) } catch (_: Exception) { return }
        NotificationManagerCompat.from(ctx).cancel(intent.getIntExtra("notification", 0))
        val task = a.optString("task", "")
        when (intent.getStringExtra("what")) {
            "done" -> if (task.isNotEmpty()) {
                Store.enqueue(ctx, JSONObject().put("type", "status").put("id", task).put("status", "done").put("at", System.currentTimeMillis()))
                Store.markDone(ctx, task)
                Widgets.refresh(ctx)
            }
            "snooze" -> {
                Alarms.snooze(ctx, a)
                val q = JSONObject().put("type", "snooze").put("minutes", 10).put("at", System.currentTimeMillis())
                if (task.isNotEmpty()) q.put("id", task) else q.put("event", a.optString("event"))
                Store.enqueue(ctx, q)
            }
        }
    }
}

/** After a restart (or an update) Android forgets alarms: put them back. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        Alarms.restore(ctx)
        Widgets.refresh(ctx)
    }
}
