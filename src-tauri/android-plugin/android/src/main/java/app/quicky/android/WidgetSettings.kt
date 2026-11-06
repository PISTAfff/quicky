package app.quicky.android

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import org.json.JSONObject

/**
 * A widget's settings: shown when one is placed on Android 11 and older (optional from 12, where it
 * is the widget's pencil after a long-press). The look (the app's cards, soft, or Material You) and
 * whose light or dark it follows, with a live preview. Backing out keeps the widget as it was.
 */
class WidgetSettingsActivity : Activity() {
    private var id = AppWidgetManager.INVALID_APPWIDGET_ID
    private var kind: Class<*>? = null
    private var style = WidgetStyle()
    private var snapshot = JSONObject()
    private lateinit var look: Widgets.Look

    private val looks = listOf(R.id.ws_look_quicky to "quicky", R.id.ws_look_soft to "soft", R.id.ws_look_you to "you")
    private val themes = listOf(R.id.ws_theme_app to "app", R.id.ws_theme_light to "light", R.id.ws_theme_dark to "dark", R.id.ws_theme_phone to "phone")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        // Android 11 and older drop a new widget whose settings were cancelled: keep it either way.
        setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id))
        val mgr = AppWidgetManager.getInstance(this)
        kind = Widgets.kindOf(mgr.getAppWidgetInfo(id)?.provider?.className)
        if (kind == null) {
            finish()
            return
        }
        // A widget placed with these settings open gets no update of its own until they close: draw it now.
        Widgets.update(this, mgr, kind!!, intArrayOf(id))
        style = Store.widgetStyle(this, id)
        snapshot = Store.snapshot(this)
        look = Widgets.Look(this, snapshot, WidgetStyle())
        setContentView(R.layout.w_settings)

        findViewById<View>(R.id.ws_outside).setOnClickListener { finish() }
        findViewById<View>(R.id.ws_card).setBackgroundResource(if (look.dark) R.drawable.w_card_q_dark else R.drawable.w_card_q_light)
        findViewById<TextView>(R.id.ws_title).setTextColor(look.ink.int)
        for (label in listOf(R.id.ws_look_label, R.id.ws_theme_label, R.id.ws_note)) findViewById<TextView>(label).setTextColor(look.muted.int)
        if (Build.VERSION.SDK_INT < 31) findViewById<View>(R.id.ws_look_you).visibility = View.GONE
        for ((view, value) in looks) findViewById<View>(view).setOnClickListener { style = style.copy(look = value); draw() }
        for ((view, value) in themes) findViewById<View>(view).setOnClickListener { if (style.look != "you") { style = style.copy(theme = value); draw() } }
        val done = findViewById<TextView>(R.id.ws_done)
        done.setTextColor(look.onAccent.int)
        done.background.mutate().setTint(look.accent.int)
        done.setOnClickListener {
            Store.setWidgetStyle(this, id, style)
            Widgets.update(this, mgr, kind!!, intArrayOf(id))
            finish()
        }
        // A preview needs something to show: the user's own tasks, or made-up ones.
        val tasks = snapshot.optJSONArray("tasks")
        if (tasks == null || tasks.length() == 0) snapshot = Widgets.sample(snapshot)
        findViewById<View>(R.id.ws_preview).layoutParams.height = (resources.displayMetrics.density * when (kind) {
            QuickAddWidget::class.java, BlobWidget::class.java -> 110
            NextUpWidget::class.java -> 170
            else -> 260
        }).toInt()
        draw()
    }

    private fun pill(view: Int, on: Boolean, enabled: Boolean = true) {
        val v = findViewById<TextView>(view)
        v.background.mutate().setTint(if (on) look.accent.int else look.soft2.int)
        v.setTextColor(if (on) look.onAccent.int else look.ink.int)
        v.alpha = if (enabled) 1f else 0.4f
    }

    private fun draw() {
        val you = style.look == "you"
        for ((view, value) in looks) pill(view, style.look == value)
        for ((view, value) in themes) pill(view, !you && style.theme == value, !you)
        findViewById<TextView>(R.id.ws_note).text = when {
            you -> "Material You takes the wallpaper's colours and the phone's light or dark."
            style.theme == "app" -> "Light or dark as set in Quicky's settings."
            style.theme == "phone" -> "Light or dark with the phone."
            else -> ""
        }
        val frame = findViewById<FrameLayout>(R.id.ws_preview)
        frame.removeAllViews()
        try {
            val views = Widgets.build(this, kind!!, id, snapshot, style, true)
            // Drawn as a launcher would: with a restricted context (no bundled fonts).
            val host = createPackageContext(packageName, CONTEXT_RESTRICTED)
            val view = views.apply(host, frame)
            frame.addView(view)
            Widgets.fillRows(host, view, kind!!, snapshot, style)
        } catch (_: Exception) {
            // The preview is a nicety; the settings still work without it.
        }
    }
}
