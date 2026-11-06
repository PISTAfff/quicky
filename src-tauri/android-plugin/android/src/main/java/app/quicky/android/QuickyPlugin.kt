package app.quicky.android

import android.Manifest
import android.app.Activity
import android.app.AlarmManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import org.json.JSONObject

/** Extra on an intent that opens Quicky: a queued action as JSON (open a task, quick add). */
const val EXTRA_ACTION = "app.quicky.action"

/** Opens Quicky's main screen, optionally with an action for the page to pick up. */
fun launchIntent(ctx: Context, action: JSONObject?): Intent? {
    val intent = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return null
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    if (action != null) intent.putExtra(EXTRA_ACTION, action.toString())
    return intent
}

/**
 * The page's way to Android. Commands (called as `plugin:quicky-android|<name>`):
 * - `widgets {snapshot}`: the tasks as the widgets show them; redraws every widget;
 * - `schedule {alarms}`: the coming reminders (JSON list); replaces the ones scheduled before;
 * - `actions`: what was done from widgets and notifications since last asked (emptied);
 * - `permission {ask, exact}`: whether notifications (and exact alarms) are allowed; asks first.
 */
@TauriPlugin
class QuickyPlugin(private val activity: Activity) : Plugin(activity) {
    override fun load(webView: WebView) {
        super.load(webView)
        take(activity.intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        take(intent)
    }

    /** An action Quicky was opened with (a widget, a notification) waits in the queue. */
    private fun take(intent: Intent?) {
        val raw = intent?.getStringExtra(EXTRA_ACTION) ?: return
        intent.removeExtra(EXTRA_ACTION)
        try {
            Store.enqueue(activity, JSONObject(raw))
        } catch (_: Exception) {
        }
    }

    @Command
    fun widgets(invoke: Invoke) {
        val snapshot = invoke.getArgs().getString("snapshot", null)
        if (snapshot == null) {
            invoke.reject("Missing snapshot")
            return
        }
        Store.setSnapshot(activity, snapshot)
        // Ticks and adds the page hasn't taken in yet stay on the widgets.
        Store.replayQueue(activity)
        Widgets.refresh(activity)
        invoke.resolve()
    }

    @Command
    fun schedule(invoke: Invoke) {
        val raw = invoke.getArgs().getString("alarms", null)
        try {
            Alarms.replace(activity, JSONArray(raw ?: "[]"))
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject(e.message ?: "Couldn't schedule reminders")
        }
    }

    @Command
    fun actions(invoke: Invoke) {
        val out = JSObject()
        out.put("actions", Store.drain(activity))
        invoke.resolve(out)
    }

    @Command
    fun permission(invoke: Invoke) {
        val args = invoke.getArgs()
        val ask = args.getBoolean("ask", false)
        val exact = args.getBoolean("exact", false)
        val notify = Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        if (!notify && ask) {
            ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7301)
        }
        val alarms = activity.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val exactOk = Build.VERSION.SDK_INT < 31 || alarms.canScheduleExactAlarms()
        if (!exactOk && exact && Build.VERSION.SDK_INT >= 31) {
            // Android 12+: exact reminders are a switch in the app's settings.
            activity.startActivity(
                Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + activity.packageName))
            )
        }
        val out = JSObject()
        out.put("notifications", notify)
        out.put("exact", exactOk)
        invoke.resolve(out)
    }
}
