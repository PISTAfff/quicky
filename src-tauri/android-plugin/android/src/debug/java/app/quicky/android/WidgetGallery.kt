package app.quicky.android

import android.app.Activity
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject

/**
 * Debug builds only: the widgets drawn at several sizes over a made-up wallpaper, for checking the
 * design without placing each one. `adb shell am start -n app.quicky.mobile/app.quicky.android.WidgetGallery
 * --es kinds BlobWidget,QuickAddWidget --es theme dark --es look quicky --es data full|empty|fresh`.
 */
class WidgetGallery : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val kinds = (intent.getStringExtra("kinds") ?: "TaskListWidget").split(",")
        val theme = intent.getStringExtra("theme") ?: "light"
        val look = intent.getStringExtra("look") ?: "quicky"
        val accent = intent.getStringExtra("accent") ?: "#6d4cff"
        val data = intent.getStringExtra("data") ?: "full"
        val dp = resources.displayMetrics.density
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding((12 * dp).toInt(), (40 * dp).toInt(), (12 * dp).toInt(), (24 * dp).toInt()) }
        col.background = GradientDrawable(GradientDrawable.Orientation.TL_BR,
            if (theme == "dark") intArrayOf(0xFF1B2440.toInt(), 0xFF0B0D18.toInt()) else intArrayOf(0xFFB9C7F5.toInt(), 0xFF6F7FC0.toInt()))
        val s = fixture(data, accent, theme)
        for (name in kinds) {
            val kind = Widgets.kindOf("app.quicky.android.$name") ?: continue
            for ((w, h) in sizes(kind)) {
                col.addView(TextView(this).apply { text = "$name  ${w}x$h"; setTextColor(Color.WHITE); textSize = 11f; setPadding(0, (8 * dp).toInt(), 0, (2 * dp).toInt()) })
                val frame = FrameLayout(this)
                col.addView(frame, LinearLayout.LayoutParams((w * dp).toInt(), (h * dp).toInt()))
                val big = w >= bigW(kind) && h >= bigH(kind)
                try {
                    // Drawn as a launcher would: with a restricted context (no bundled fonts).
                    val host = createPackageContext(packageName, CONTEXT_RESTRICTED)
                    val style = WidgetStyle(look, if (theme == "phone") "phone" else "app")
                    val view = Widgets.build(this, kind, 0, s, style, big).apply(host, frame)
                    frame.addView(view)
                    Widgets.fillRows(host, view, kind, s, style)
                } catch (e: Exception) {
                    frame.addView(TextView(this).apply { text = e.toString(); setTextColor(Color.RED) })
                }
            }
        }
        setContentView(ScrollView(this).apply { addView(col) })
    }

    private fun sizes(kind: Class<*>) = when (kind) {
        QuickAddWidget::class.java -> listOf(76 to 76, 170 to 64, 340 to 64)
        BlobWidget::class.java -> listOf(76 to 76, 170 to 76, 250 to 90, 170 to 170)
        NextUpWidget::class.java -> listOf(170 to 64, 340 to 64, 340 to 150, 190 to 170)
        else -> listOf(170 to 200, 340 to 300)
    }
    private fun bigW(kind: Class<*>) = when (kind) { QuickAddWidget::class.java -> 130; BlobWidget::class.java -> 150; NextUpWidget::class.java -> 180; else -> 230 }
    private fun bigH(kind: Class<*>) = when (kind) { QuickAddWidget::class.java, BlobWidget::class.java -> 40; else -> 100 }

    private fun fixture(data: String, accent: String, theme: String): JSONObject {
        val base = JSONObject().put("accent", accent).put("onAccent", "#ffffff").put("mode", if (theme == "dark") "dark" else if (theme == "phone") "auto" else "light")
            .put("dark", theme == "dark").put("date", "Friday 6")
        if (data == "fresh") return JSONObject()
        if (data == "empty") return base.put("tasks", JSONArray()).put("next", JSONObject.NULL).put("today", JSONArray()).put("week", JSONArray())
            .put("counts", JSONObject().put("open", 0).put("done", 5))
        fun t(id: String, title: String, vararg kv: Pair<String, Any>) = JSONObject().put("id", id).put("title", title).put("status", "todo").also { o -> kv.forEach { o.put(it.first, it.second) } }
        val tasks = JSONArray()
            .put(t("a", "Call the dentist about the appointment next week before it fills up", "due" to "Overdue", "late" to true))
            .put(t("b", "Write the report", "status" to "doing", "steps" to "2/5 steps"))
            .put(t("c", "Water the plants", "due" to "Today"))
            .put(t("d", "Buy oat milk"))
            .put(t("e", "Book the train", "due" to "Sat", "steps" to "0/2 steps"))
            .put(t("f", "Reply to Sam", "status" to "doing"))
        val ev = { title: String, time: String -> JSONObject().put("title", title).put("time", time).put("kind", "event") }
        return base.put("tasks", tasks)
            .put("next", JSONObject(tasks.getJSONObject(1).toString()).put("pinned", true))
            .put("today", JSONArray().put(ev("Team stand-up", "9:30 AM")).put(ev("Gym", "6:00 PM"))
                .put(JSONObject(tasks.getJSONObject(0).toString()).put("time", "Overdue").put("kind", "task"))
                .put(JSONObject(tasks.getJSONObject(2).toString()).put("time", "Due today").put("kind", "task")))
            .put("week", JSONArray()
                .put(JSONObject().put("title", "Today 6").put("kind", "day"))
                .put(ev("Team stand-up", "9:30 AM"))
                .put(JSONObject(tasks.getJSONObject(0).toString()).put("time", "Overdue").put("kind", "task"))
                .put(JSONObject().put("title", "Tomorrow 7").put("kind", "day"))
                .put(ev("Lunch with Sam", "1:00 PM"))
                .put(JSONObject().put("title", "Monday 9").put("kind", "day"))
                .put(ev("Dentist", "All day")))
            .put("counts", JSONObject().put("open", 6).put("done", 3))
    }
}
