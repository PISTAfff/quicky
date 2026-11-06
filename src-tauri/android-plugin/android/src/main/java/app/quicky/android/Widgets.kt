package app.quicky.android

import android.app.Activity
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject

/**
 * The four home-screen widgets, all drawn from the page's last snapshot (`Store.snapshot`):
 * - [TaskListWidget]: the open tasks, each with a tick;
 * - [QuickAddWidget]: one button that opens the small add box;
 * - [NextUpWidget]: the pinned task, or else the most urgent one, with Done;
 * - [TodayWidget]: today's calendar events and the tasks due today.
 */
object Widgets {
    private val KINDS = listOf(TaskListWidget::class.java, QuickAddWidget::class.java, NextUpWidget::class.java, TodayWidget::class.java)

    fun refresh(ctx: Context) {
        val mgr = AppWidgetManager.getInstance(ctx)
        for (k in KINDS) {
            val ids = mgr.getAppWidgetIds(ComponentName(ctx, k))
            if (ids.isEmpty()) continue
            update(ctx, mgr, k, ids)
        }
    }

    fun update(ctx: Context, mgr: AppWidgetManager, kind: Class<*>, ids: IntArray) {
        val s = Store.snapshot(ctx)
        for (id in ids) {
            val views = when (kind) {
                TaskListWidget::class.java -> list(ctx, s, id, "tasks")
                TodayWidget::class.java -> list(ctx, s, id, "today")
                NextUpWidget::class.java -> next(ctx, s)
                else -> add(ctx, s)
            }
            mgr.updateAppWidget(id, views)
            // Android 12 and up get their rows inside the update; older ones read them from RowsService.
            if (Build.VERSION.SDK_INT < 31 && (kind == TaskListWidget::class.java || kind == TodayWidget::class.java)) {
                @Suppress("DEPRECATION")
                mgr.notifyAppWidgetViewDataChanged(id, R.id.w_rows)
            }
        }
    }

    /** The colours: the accent, text on it, and the card's own (light or dark). */
    class Look(s: JSONObject) {
        val dark = s.optBoolean("dark", false)
        val accent = parse(s.optString("accent"), 0xFF7B61FF.toInt())
        val onAccent = parse(s.optString("onAccent"), Color.WHITE)
        val ink = if (dark) 0xFFF1EEFF.toInt() else 0xFF2B2540.toInt()
        val muted = if (dark) 0xFFA59FBF.toInt() else 0xFF7A7392.toInt()
        val late = 0xFFE5484D.toInt()
        val card = if (dark) R.drawable.w_card_dark else R.drawable.w_card_light

        private fun parse(c: String, fallback: Int) = try { Color.parseColor(c) } catch (_: Exception) { fallback }
    }

    private fun openApp(ctx: Context, action: JSONObject?, code: Int): PendingIntent? =
        launchIntent(ctx, action)?.let {
            PendingIntent.getActivity(ctx, code, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }

    private fun quickAdd(ctx: Context): PendingIntent =
        PendingIntent.getActivity(
            ctx, 9101,
            Intent(ctx, QuickAddActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    private fun list(ctx: Context, s: JSONObject, widgetId: Int, which: String): RemoteViews {
        val look = Look(s)
        val v = RemoteViews(ctx.packageName, R.layout.w_list)
        v.setInt(R.id.w_root, "setBackgroundResource", look.card)
        val counts = s.optJSONObject("counts")
        if (which == "tasks") {
            v.setTextViewText(R.id.w_title, "Quicky")
            v.setTextViewText(R.id.w_sub, if (counts != null) "${counts.optInt("open")} to do" else "")
            v.setTextViewText(R.id.w_empty, if (s.has("tasks")) "All clear!" else "Open Quicky once to fill this in")
        } else {
            v.setTextViewText(R.id.w_title, "Today")
            v.setTextViewText(R.id.w_sub, s.optString("date"))
            v.setTextViewText(R.id.w_empty, if (s.has("today")) "Nothing on today" else "Open Quicky once to fill this in")
        }
        v.setTextColor(R.id.w_title, look.accent)
        v.setTextColor(R.id.w_sub, look.muted)
        v.setTextColor(R.id.w_empty, look.muted)
        v.setInt(R.id.w_add, "setColorFilter", look.onAccent)
        v.setInt(R.id.w_add_bg, "setColorFilter", look.accent)
        v.setOnClickPendingIntent(R.id.w_add_wrap, quickAdd(ctx))
        v.setOnClickPendingIntent(R.id.w_head, openApp(ctx, null, 9100))

        if (Build.VERSION.SDK_INT >= 31) {
            // The rows travel with the update itself, so a full update always shows them (some
            // launchers keep the old views when only a row service's data changes).
            val rows = s.optJSONArray(which) ?: JSONArray()
            val items = RemoteViews.RemoteCollectionItems.Builder().setViewTypeCount(1)
            for (i in 0 until rows.length()) items.addItem(i.toLong(), rowView(ctx, look, which, rows.optJSONObject(i) ?: JSONObject()))
            v.setRemoteAdapter(R.id.w_rows, items.build())
        } else {
            val svc = Intent(ctx, RowsService::class.java)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
                .putExtra("which", which)
            svc.data = Uri.parse(svc.toUri(Intent.URI_INTENT_SCHEME))
            @Suppress("DEPRECATION")
            v.setRemoteAdapter(R.id.w_rows, svc)
        }
        v.setEmptyView(R.id.w_rows, R.id.w_empty)
        // Each row fills in what was tapped (tick or open); this activity does it and closes.
        val tap = Intent(ctx, WidgetTapActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
        v.setPendingIntentTemplate(R.id.w_rows, PendingIntent.getActivity(ctx, 9200 + widgetId, tap, flags))
        return v
    }

    /** One row of the task list or today widget. */
    fun rowView(ctx: Context, look: Look, which: String, r: JSONObject): RemoteViews {
        val v = RemoteViews(ctx.packageName, R.layout.w_row)
        val id = r.optString("id", "")
        v.setTextViewText(R.id.w_row_title, r.optString("title"))
        v.setTextColor(R.id.w_row_title, look.ink)
        if (which == "today") {
            // Events show their time; tasks due today get a tick like the task list's.
            v.setTextViewText(R.id.w_row_meta, r.optString("time"))
            v.setTextColor(R.id.w_row_meta, if (r.optString("kind") == "event") look.accent else look.muted)
        } else {
            val meta = listOf(r.optString("due"), r.optString("steps")).filter { it.isNotEmpty() }.joinToString("  ·  ")
            v.setTextViewText(R.id.w_row_meta, meta)
            v.setTextColor(R.id.w_row_meta, if (r.optBoolean("late")) look.late else look.muted)
        }
        val hasMeta = if (which == "today") r.optString("time").isNotEmpty() else r.optString("due").isNotEmpty() || r.optString("steps").isNotEmpty()
        v.setViewVisibility(R.id.w_row_meta, if (hasMeta) View.VISIBLE else View.GONE)
        val isTask = id.isNotEmpty()
        v.setViewVisibility(R.id.w_tick, if (isTask) View.VISIBLE else View.INVISIBLE)
        v.setInt(R.id.w_tick, "setColorFilter", if (r.optString("status") == "doing") look.accent else look.muted)
        v.setImageViewResource(R.id.w_tick, if (r.optString("status") == "doing") R.drawable.w_tick_doing else R.drawable.w_tick)
        if (isTask) {
            v.setOnClickFillInIntent(R.id.w_tick, Intent().putExtra("what", "done").putExtra("id", id))
            v.setOnClickFillInIntent(R.id.w_row_text, Intent().putExtra("what", "open").putExtra("id", id))
        } else {
            v.setOnClickFillInIntent(R.id.w_row_text, Intent().putExtra("what", "calendar"))
        }
        return v
    }

    private fun add(ctx: Context, s: JSONObject): RemoteViews {
        val look = Look(s)
        val v = RemoteViews(ctx.packageName, R.layout.w_add)
        v.setInt(R.id.w_add_bg, "setColorFilter", look.accent)
        v.setInt(R.id.w_add, "setColorFilter", look.onAccent)
        v.setOnClickPendingIntent(R.id.w_root, quickAdd(ctx))
        return v
    }

    private fun next(ctx: Context, s: JSONObject): RemoteViews {
        val look = Look(s)
        val v = RemoteViews(ctx.packageName, R.layout.w_next)
        v.setInt(R.id.w_root, "setBackgroundResource", look.card)
        val t = s.optJSONObject("next")
        v.setTextColor(R.id.w_label, look.accent)
        v.setTextColor(R.id.w_task, look.ink)
        v.setTextColor(R.id.w_meta, look.muted)
        if (t == null) {
            v.setTextViewText(R.id.w_label, "Next up")
            v.setTextViewText(R.id.w_task, if (s.has("tasks")) "All clear!" else "Open Quicky once to fill this in")
            v.setTextViewText(R.id.w_meta, "")
            v.setViewVisibility(R.id.w_done, View.GONE)
            v.setOnClickPendingIntent(R.id.w_root, openApp(ctx, null, 9300))
            return v
        }
        val id = t.optString("id")
        v.setTextViewText(R.id.w_label, if (t.optBoolean("pinned")) "Pinned" else if (t.optString("status") == "doing") "Doing now" else "Next up")
        v.setTextViewText(R.id.w_task, t.optString("title"))
        val meta = listOf(t.optString("due"), t.optString("steps")).filter { it.isNotEmpty() }.joinToString("  ·  ")
        v.setTextViewText(R.id.w_meta, meta)
        if (t.optBoolean("late")) v.setTextColor(R.id.w_meta, look.late)
        v.setViewVisibility(R.id.w_done, View.VISIBLE)
        v.setInt(R.id.w_done, "setColorFilter", look.onAccent)
        v.setInt(R.id.w_done_bg, "setColorFilter", look.accent)
        val done = Intent(ctx, WidgetTapActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra("what", "done").putExtra("id", id)
        v.setOnClickPendingIntent(
            R.id.w_done_wrap,
            PendingIntent.getActivity(ctx, 9301, done, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE),
        )
        v.setOnClickPendingIntent(R.id.w_root, openApp(ctx, JSONObject().put("type", "open").put("id", id), 9302))
        return v
    }
}

class TaskListWidget : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) = Widgets.update(ctx, mgr, javaClass, ids)
}

class QuickAddWidget : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) = Widgets.update(ctx, mgr, javaClass, ids)
}

class NextUpWidget : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) = Widgets.update(ctx, mgr, javaClass, ids)
}

class TodayWidget : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) = Widgets.update(ctx, mgr, javaClass, ids)
}

/** The rows of the task list and today widgets. */
class RowsService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory = Rows(applicationContext, intent.getStringExtra("which") ?: "tasks")
}

class Rows(private val ctx: Context, private val which: String) : RemoteViewsService.RemoteViewsFactory {
    private var rows = JSONArray()
    private var look = Widgets.Look(JSONObject())

    override fun onCreate() {}
    override fun onDestroy() {}
    override fun onDataSetChanged() {
        val s = Store.snapshot(ctx)
        look = Widgets.Look(s)
        rows = s.optJSONArray(which) ?: JSONArray()
    }

    override fun getCount() = rows.length()
    override fun getViewTypeCount() = 1
    override fun getItemId(position: Int) = position.toLong()
    override fun hasStableIds() = false
    override fun getLoadingView(): RemoteViews? = null

    override fun getViewAt(position: Int): RemoteViews = Widgets.rowView(ctx, look, which, rows.optJSONObject(position) ?: JSONObject())
}

/**
 * A tap on a widget: ticks the task off (queued for the page, gone from the widgets at once) or
 * opens Quicky on it. An activity, not a broadcast, because Android only lets activities open
 * other screens.
 */
class WidgetTapActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val id = intent.getStringExtra("id") ?: ""
        when (intent.getStringExtra("what")) {
            "done" -> if (id.isNotEmpty()) {
                Store.enqueue(this, JSONObject().put("type", "status").put("id", id).put("status", "done").put("at", System.currentTimeMillis()))
                Store.markDone(this, id)
                Widgets.refresh(this)
            }
            "open" -> launchIntent(this, JSONObject().put("type", "open").put("id", id))?.let { startActivity(it) }
            "calendar" -> launchIntent(this, JSONObject().put("type", "open").put("calendar", true))?.let { startActivity(it) }
        }
        finish()
        @Suppress("DEPRECATION")
        overridePendingTransition(0, 0)
    }
}

/** The small "add a task" box over the home screen (the quick-add widget and the list's +). */
class QuickAddActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.quick_add)
        val look = Widgets.Look(Store.snapshot(this))
        findViewById<View>(R.id.qa_root).setBackgroundResource(look.card)
        val field = findViewById<EditText>(R.id.qa_text)
        field.setTextColor(look.ink)
        field.setHintTextColor(look.muted)
        val button = findViewById<TextView>(R.id.qa_add)
        button.setTextColor(look.onAccent)
        button.background.mutate().setTint(look.accent)
        findViewById<TextView>(R.id.qa_title).setTextColor(look.accent)
        var added = false
        val add = {
            val title = field.text.toString().trim()
            // The keyboard's Enter can arrive twice (down and up) before the box closes.
            if (title.isNotEmpty() && !added) {
                added = true
                val id = java.lang.Long.toString(System.currentTimeMillis(), 36) + "w" + (Math.random() * 1e6).toLong().toString(36)
                Store.enqueue(this, JSONObject().put("type", "add").put("id", id).put("title", title).put("at", System.currentTimeMillis()))
                Store.addTask(this, id, title)
                Widgets.refresh(this)
            }
            finish()
        }
        button.setOnClickListener { add() }
        field.setOnEditorActionListener { _, action, event ->
            val enter = action == EditorInfo.IME_ACTION_DONE || (event?.keyCode == android.view.KeyEvent.KEYCODE_ENTER && event.action == android.view.KeyEvent.ACTION_UP)
            if (enter) add()
            enter || event?.keyCode == android.view.KeyEvent.KEYCODE_ENTER
        }
        field.requestFocus()
    }
}
