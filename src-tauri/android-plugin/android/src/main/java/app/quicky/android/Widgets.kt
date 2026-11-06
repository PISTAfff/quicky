package app.quicky.android

import android.app.Activity
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.appwidget.AppWidgetProviderInfo
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.TextPaint
import android.util.TypedValue
import android.util.SizeF
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.ListView
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject

/**
 * The home-screen widgets, all drawn from the page's last snapshot (`Store.snapshot`):
 * - [TaskListWidget]: the open tasks, each with a tick;
 * - [QuickAddWidget]: a button (or, wider, a bar) that opens the small add box;
 * - [NextUpWidget]: the pinned task, or else the most urgent one, with Done;
 * - [TodayWidget]: today's calendar events and the tasks due today;
 * - [BlobWidget]: the Quicky blob in the accent, with how many tasks are open (wider: a balloon with the next one);
 * - [DoingWidget]: the tasks in progress (the snapshot's tasks marked doing), each with a tick;
 * - [WeekWidget]: the next 7 days' events and due tasks, under a heading per day.
 *
 * Each has a small and a big layout: on Android 12+ the launcher picks one by size itself (a size
 * map); older ones get the one that fits from [QuickyWidget.onAppWidgetOptionsChanged]. Each placed
 * widget can have its own [WidgetStyle] (long-press, then the widget's settings).
 */
object Widgets {
    private val KINDS = listOf(
        TaskListWidget::class.java, QuickAddWidget::class.java, NextUpWidget::class.java, TodayWidget::class.java,
        BlobWidget::class.java, DoingWidget::class.java, WeekWidget::class.java,
    )
    private val LISTS = mapOf(
        TaskListWidget::class.java to "tasks", TodayWidget::class.java to "today",
        DoingWidget::class.java to "doing", WeekWidget::class.java to "week",
    )

    /** The big layout's smallest size (dp); anything smaller gets the small one. */
    private fun bigFrom(kind: Class<*>): SizeF = when (kind) {
        NextUpWidget::class.java -> SizeF(180f, 100f)
        BlobWidget::class.java -> SizeF(150f, 40f)
        QuickAddWidget::class.java -> SizeF(130f, 40f)
        else -> SizeF(230f, 100f)
    }

    /** List widgets this tall (dp) and up show Quicky in their empty state. */
    private const val TALL = 150f

    fun kindOf(className: String?): Class<*>? = KINDS.firstOrNull { it.name == className }

    fun refresh(ctx: Context) {
        val mgr = AppWidgetManager.getInstance(ctx)
        for (k in KINDS) {
            val ids = mgr.getAppWidgetIds(ComponentName(ctx, k))
            if (ids.isEmpty()) continue
            update(ctx, mgr, k, ids)
        }
        previews(ctx)
    }

    fun update(ctx: Context, mgr: AppWidgetManager, kind: Class<*>, ids: IntArray) {
        val s = Store.snapshot(ctx)
        for (id in ids) {
            mgr.updateAppWidget(id, views(ctx, mgr, kind, id, s))
            // Android 12 and up get their rows inside the update; older ones read them from RowsService.
            if (Build.VERSION.SDK_INT < 31 && LISTS.containsKey(kind)) {
                @Suppress("DEPRECATION")
                mgr.notifyAppWidgetViewDataChanged(id, R.id.w_rows)
            }
        }
    }

    /**
     * How much bigger to draw a widget so it looks its intended size: Samsung's One UI draws widgets
     * shrunk (`hsResizeRatio`, about 0.71), which made text and icons tiny. 1 everywhere else.
     */
    fun scale(mgr: AppWidgetManager, id: Int): Float {
        val ratio = mgr.getAppWidgetOptions(id).getFloat("hsResizeRatio", 1f)
        return if (ratio in 0.3f..0.99f) (1f / ratio).coerceAtMost(1.6f) else 1f
    }

    private fun views(ctx: Context, mgr: AppWidgetManager, kind: Class<*>, id: Int, s: JSONObject): RemoteViews {
        val style = Store.widgetStyle(ctx, id).copy(scale = scale(mgr, id))
        val big = bigFrom(kind)
        val list = LISTS.containsKey(kind)
        if (Build.VERSION.SDK_INT >= 31) {
            // The launcher shows the biggest layout that fits, and switches as the widget is resized.
            // List widgets also get short versions, without Quicky in their empty state.
            val sizes = mutableMapOf(
                SizeF(40f, 40f) to build(ctx, kind, id, s, style, false, !list),
                big to build(ctx, kind, id, s, style, true, !list),
            )
            if (list) {
                sizes[SizeF(40f, TALL)] = build(ctx, kind, id, s, style, false, true)
                sizes[SizeF(big.width, TALL)] = build(ctx, kind, id, s, style, true, true)
            }
            return RemoteViews(sizes)
        }
        val o = mgr.getAppWidgetOptions(id)
        val w = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH)
        val h = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT)
        return build(ctx, kind, id, s, style, w == 0 || (w >= big.width && h >= big.height), w == 0 || h >= TALL)
    }

    /** One widget's views at one size (also used by the settings screen's preview). */
    fun build(ctx: Context, kind: Class<*>, id: Int, s: JSONObject, style: WidgetStyle, big: Boolean, tall: Boolean = true): RemoteViews {
        val look = Look(ctx, s, style)
        val which = LISTS[kind]
        return when {
            which != null -> list(ctx, look, s, id, which, big, tall)
            kind == NextUpWidget::class.java -> next(ctx, look, s, big)
            kind == BlobWidget::class.java -> blob(ctx, look, s, big)
            else -> add(ctx, look, big)
        }
    }

    /** The rows a list widget shows: the snapshot's list, or for "doing" the tasks in progress. */
    fun rows(s: JSONObject, which: String): JSONArray {
        if (which != "doing") return s.optJSONArray(which) ?: JSONArray()
        val all = s.optJSONArray("tasks") ?: JSONArray()
        val out = JSONArray()
        for (i in 0 until all.length()) all.optJSONObject(i)?.takeIf { it.optString("status") == "doing" }?.let { out.put(it) }
        return out
    }

    /**
     * Fills a list widget's rows after drawing it in Quicky's own window (the settings' preview, the
     * debug gallery): the rows sent with an update only reach a launcher.
     */
    fun fillRows(ctx: Context, root: View, kind: Class<*>, s: JSONObject, style: WidgetStyle) {
        val which = LISTS[kind] ?: return
        val list = root.findViewById<ListView>(R.id.w_rows) ?: return
        val rows = rows(s, which)
        val look = Look(ctx, s, style)
        list.adapter = object : BaseAdapter() {
            override fun getCount() = rows.length()
            override fun getItem(position: Int) = rows.opt(position)
            override fun getItemId(position: Int) = position.toLong()
            override fun getView(position: Int, convertView: View?, parent: ViewGroup): View =
                rowView(ctx, look, which, rows.optJSONObject(position) ?: JSONObject()).apply(ctx, parent)
        }
        root.findViewById<View>(R.id.w_empty)?.visibility = if (rows.length() == 0) View.VISIBLE else View.GONE
        list.visibility = if (rows.length() == 0) View.GONE else View.VISIBLE
    }

    // ---- colours ---------------------------------------------------------------------------

    /** A colour as a value, and (Android 12+) as a resource the launcher resolves itself, so the
     *  widget follows the phone's dark mode and Material You colours without the app running. */
    class C(val int: Int, val res: Int = 0, val day: Int = 0, val night: Int = 0, val pair: Boolean = false)

    /**
     * The colours for one widget: the accent from the app's theme (or the wallpaper's, for Material
     * You), and the card's own, light or dark (from tokens.css).
     */
    class Look(ctx: Context, s: JSONObject, style: WidgetStyle) {
        val you = style.look == "you" && Build.VERSION.SDK_INT >= 31
        /** Text and icon size factor: the launcher's shrink made up for (see [scale]) times the widget's own text size. */
        val k = style.scale * style.text
        val soft = style.look == "soft"
        /** The app's look: ink rings on the buttons, a hard shadow under the card. */
        val edged = !you && !soft
        /** Whether it is dark right now. */
        val dark: Boolean
        /** "light", "dark", or "auto" (the launcher follows the phone's dark mode itself). */
        private val mode: String

        init {
            val m = if (you) "auto" else when (style.theme) {
                "light", "dark" -> style.theme
                "phone" -> "auto"
                // Like the app: its own setting (light, dark, or like the phone).
                else -> s.optString("mode").takeIf { it == "light" || it == "dark" || it == "auto" }
                    ?: if (s.optBoolean("dark", false)) "dark" else "light"
            }
            val phoneDark = (ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
            dark = if (m == "auto") phoneDark else m == "dark"
            // Before Android 12 the launcher can't switch colours: draw what the phone shows now.
            mode = if (m == "auto" && Build.VERSION.SDK_INT < 31) (if (dark) "dark" else "light") else m
        }

        private fun q(ctx: Context, light: Int, dark: Int, auto: Int) =
            C(ctx.getColor(if (this.dark) dark else light), if (mode == "auto") auto else 0)
        private fun y(ctx: Context, res: Int) = C(ctx.getColor(res), res)

        val ink = if (you) y(ctx, R.color.w_you_ink) else q(ctx, R.color.w_ink_light, R.color.w_ink_dark, R.color.w_ink)
        val muted = if (you) y(ctx, R.color.w_you_muted) else q(ctx, R.color.w_muted_light, R.color.w_muted_dark, R.color.w_muted)
        val soft2 = if (you) y(ctx, R.color.w_you_soft) else q(ctx, R.color.w_soft_light, R.color.w_soft_dark, R.color.w_soft)
        val ring = if (you) y(ctx, R.color.w_you_ring) else q(ctx, R.color.w_ring_light, R.color.w_ring_dark, R.color.w_ring)
        val doing = if (you) y(ctx, R.color.w_you_doing) else q(ctx, R.color.w_doing_light, R.color.w_doing_dark, R.color.w_doing)
        val late = q(ctx, R.color.w_late_light, R.color.w_late_dark, R.color.w_late)
        val lateSoft = q(ctx, R.color.w_late_soft_light, R.color.w_late_soft_dark, R.color.w_late_soft)
        val accent = if (you) y(ctx, R.color.w_you_accent) else C(parse(s.optString("accent"), 0xFF6D4CFF.toInt()))
        val onAccent = if (you) y(ctx, R.color.w_you_on_accent) else C(parse(s.optString("onAccent"), Color.WHITE))
        /** The accent for text: lifted toward the ink on dark cards (the app's --accent-ink), so it reads. */
        val accentText: C = if (you) accent else {
            val lifted = mix(accent.int, ctx.getColor(R.color.w_ink_dark), 0.42f)
            when {
                mode == "auto" -> C(if (dark) lifted else accent.int, day = accent.int, night = lifted, pair = true)
                dark -> C(lifted)
                else -> accent
            }
        }

        private fun mix(a: Int, b: Int, t: Float): Int {
            fun ch(x: Int, y: Int) = (x + (y - x) * t).toInt().coerceIn(0, 255)
            return Color.rgb(ch(Color.red(a), Color.red(b)), ch(Color.green(a), Color.green(b)), ch(Color.blue(a), Color.blue(b)))
        }

        /** The card behind the widget. */
        val card = when {
            you -> R.drawable.w_card_you
            soft -> when (mode) { "auto" -> R.drawable.w_card_s; "dark" -> R.drawable.w_card_s_dark; else -> R.drawable.w_card_s_light }
            else -> when (mode) { "auto" -> R.drawable.w_card_q; "dark" -> R.drawable.w_card_q_dark; else -> R.drawable.w_card_q_light }
        }

        private fun parse(c: String, fallback: Int) = try { Color.parseColor(c) } catch (_: Exception) { fallback }
    }

    private fun RemoteViews.color(id: Int, method: String, c: C) {
        when {
            c.res != 0 && Build.VERSION.SDK_INT >= 31 -> setColor(id, method, c.res)
            c.pair && Build.VERSION.SDK_INT >= 31 -> setColorInt(id, method, c.day, c.night)
            else -> setInt(id, method, c.int)
        }
    }
    private fun RemoteViews.text(id: Int, c: C) = color(id, "setTextColor", c)
    private fun RemoteViews.tint(id: Int, c: C) = color(id, "setColorFilter", c)
    private fun RemoteViews.shown(id: Int, on: Boolean) = setViewVisibility(id, if (on) View.VISIBLE else View.GONE)

    /** Text at its layout size times the widget's scale. */
    private fun RemoteViews.sp(look: Look, id: Int, sp: Float) {
        if (Math.abs(look.k - 1f) > 0.01f) setTextViewTextSize(id, TypedValue.COMPLEX_UNIT_SP, sp * look.k)
    }

    /** A view at its layout size (dp) times the widget's scale (Android 12+, where it can be set). */
    private fun RemoteViews.size(look: Look, id: Int, w: Float, h: Float) {
        if (Math.abs(look.k - 1f) <= 0.01f || Build.VERSION.SDK_INT < 31) return
        if (w > 0) setViewLayoutWidth(id, w * look.k, TypedValue.COMPLEX_UNIT_DIP)
        if (h > 0) setViewLayoutHeight(id, h * look.k, TypedValue.COMPLEX_UNIT_DIP)
    }

    /** An accent button: the fill, its icon, and the ink ring in the app's look. */
    private fun RemoteViews.button(look: Look, bg: Int, ring: Int, icon: Int) {
        tint(bg, look.accent)
        tint(icon, look.onAccent)
        shown(ring, look.edged)
    }

    /** Quicky: the accent body and the face for the mood ("clear": all done; "cross": something's late). */
    private fun RemoteViews.mascot(look: Look, mood: String) {
        tint(R.id.w_q_body, look.accent)
        tint(R.id.w_q_face, look.onAccent)
        setImageViewResource(R.id.w_q_face, when (mood) {
            "clear" -> R.drawable.w_q_face_clear
            "cross" -> R.drawable.w_q_face_eyes
            else -> R.drawable.w_q_face
        })
        shown(R.id.w_q_cross, mood == "cross")
    }

    private fun mood(s: JSONObject): String {
        if (!s.has("tasks")) return ""
        val tasks = s.optJSONArray("tasks") ?: JSONArray()
        for (i in 0 until tasks.length()) if (tasks.optJSONObject(i)?.optBoolean("late") == true) return "cross"
        return if (tasks.length() == 0) "clear" else ""
    }

    /** A chip under a task: "late" (red), "accent" (an event's time) or plain. */
    private fun RemoteViews.chip(look: Look, n: Int, text: String, tone: String) {
        val id = if (n == 1) R.id.w_chip1 else R.id.w_chip2
        shown(id, text.isNotEmpty())
        if (text.isEmpty()) return
        setTextViewText(id, text)
        text(id, when (tone) { "late" -> look.late; "accent" -> look.accentText; else -> look.muted })
        val bg = if (tone == "late") look.lateSoft else look.soft2
        if (Build.VERSION.SDK_INT >= 31) {
            if (bg.res != 0) setColorStateList(id, "setBackgroundTintList", bg.res)
            else setColorStateList(id, "setBackgroundTintList", ColorStateList.valueOf(bg.int))
        } else {
            setInt(id, "setBackgroundResource", when {
                tone == "late" -> if (look.dark) R.drawable.w_chip_late_dark else R.drawable.w_chip_late_light
                else -> if (look.dark) R.drawable.w_chip_soft_dark else R.drawable.w_chip_soft_light
            })
        }
    }

    // ---- headings in Fredoka ---------------------------------------------------------------------

    private var fredoka: Typeface? = null
    /** Headings drawn lately: one picture per text and size, shared by a widget's layouts (kept small for updates). */
    private val headings = object : LinkedHashMap<String, Bitmap>(32, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Bitmap>?) = size > 48
    }

    /**
     * A heading drawn in Fredoka, the app's heading font: launchers draw widgets with a restricted
     * context that ignores bundled fonts. Drawn as a white mask and tinted like any icon, so it
     * still follows the phone's dark mode (and the user's text size).
     */
    private fun heading(ctx: Context, text: String, sp: Float): Bitmap? {
        if (Build.VERSION.SDK_INT < 26 || text.isEmpty()) return null
        val face = fredoka ?: (try { ctx.resources.getFont(R.font.quicky_fredoka) } catch (_: Exception) { null } ?: return null).also { fredoka = it }
        val dm = ctx.resources.displayMetrics
        val key = "$text|$sp|${dm.densityDpi}|${ctx.resources.configuration.fontScale}"
        headings[key]?.let { return it }
        val paint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
            typeface = face
            color = Color.WHITE
            textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, sp, dm)
        }
        val fm = paint.fontMetricsInt
        val w = Math.ceil(paint.measureText(text).toDouble()).toInt() + 2
        // A mask (alpha only): a quarter of the size of a colour picture, tinted when drawn.
        val bmp = Bitmap.createBitmap(w.coerceAtMost(2000), (fm.descent - fm.ascent).coerceAtLeast(1), Bitmap.Config.ALPHA_8)
        bmp.density = dm.densityDpi
        Canvas(bmp).drawText(text, 1f, -fm.ascent.toFloat(), paint)
        headings[key] = bmp
        return bmp
    }

    /** Sets a heading: the Fredoka picture where it can be drawn, else the plain text. */
    private fun RemoteViews.heading(ctx: Context, look: Look, textId: Int, imgId: Int, text: String, sp: Float, c: C) {
        setTextViewText(textId, text)
        text(textId, c)
        sp(look, textId, sp)
        val bmp = heading(ctx, text, sp * look.k)
        shown(textId, bmp == null)
        shown(imgId, bmp != null)
        if (bmp != null) {
            setImageViewBitmap(imgId, bmp)
            tint(imgId, c)
            setContentDescription(imgId, text)
        }
    }

    // ---- taps --------------------------------------------------------------------------------

    /** Opens Quicky (on a task, or the calendar), through [WidgetTapActivity] so the tap makes its sound. */
    private fun openApp(ctx: Context, action: JSONObject?, code: Int): PendingIntent? {
        val tap = Intent(ctx, WidgetTapActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra("what", "launch")
            .putExtra("action", action?.toString())
        return PendingIntent.getActivity(ctx, code, tap, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun quickAdd(ctx: Context): PendingIntent =
        PendingIntent.getActivity(
            ctx, 9101,
            Intent(ctx, QuickAddActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    // ---- the widgets ---------------------------------------------------------------------------

    private const val BG = android.R.id.background

    private fun list(ctx: Context, look: Look, s: JSONObject, widgetId: Int, which: String, big: Boolean, tall: Boolean): RemoteViews {
        val v = RemoteViews(ctx.packageName, if (big) R.layout.w_list else R.layout.w_list_compact)
        v.setInt(BG, "setBackgroundResource", look.card)
        val counts = s.optJSONObject("counts")
        val open = counts?.optInt("open") ?: 0
        val done = counts?.optInt("done") ?: 0
        val rows = rows(s, which)
        val fresh = !s.has("tasks")
        var mood = ""
        val title: String
        var sub = s.optString("date")
        val empty: Pair<String, String>
        when (which) {
            "tasks" -> {
                title = "Quicky"
                sub = when {
                    counts == null -> ""
                    done > 0 && big -> "$open to do · $done done today"
                    else -> "$open to do"
                }
                empty = "All clear!" to "Tap + to add a mini task"
                mood = "clear"
            }
            "doing" -> {
                val n = rows.length()
                title = "Doing now"
                sub = if (fresh) "" else if (n == 1) "1 task" else "$n tasks"
                empty = "Nothing in progress" to "Tasks you start show here"
            }
            "week" -> {
                title = "This week"
                empty = "Nothing on this week" to "Events and due tasks show here"
                mood = "clear"
            }
            else -> {
                title = "Today"
                empty = "Nothing on today" to "Events and tasks due today show here"
                mood = "clear"
            }
        }
        // Snapshots from before a widget existed lack its list: the app sends one on its next change.
        val (emptyTitle, emptySub) = if (fresh || !s.has(if (which == "doing") "tasks" else which)) "Hi, I'm Quicky!" to "Open Quicky once to fill this in" else empty
        if (fresh) mood = ""

        v.heading(ctx, look, R.id.w_title, R.id.w_title_img, title, if (big) 19f else 16f, look.ink)
        v.setTextViewText(R.id.w_sub, sub)
        v.shown(R.id.w_sub, sub.isNotEmpty())
        v.heading(ctx, look, R.id.w_empty_title, R.id.w_empty_title_img, emptyTitle, 16f, look.ink)
        v.setTextViewText(R.id.w_empty_sub, emptySub)
        v.shown(R.id.w_empty_sub, big)
        v.text(R.id.w_sub, look.muted)
        v.text(R.id.w_empty_sub, look.muted)
        v.tint(R.id.w_logo, look.accent)
        v.mascot(look, mood)
        v.shown(R.id.w_mascot, tall)
        v.sp(look, R.id.w_sub, 12f)
        v.sp(look, R.id.w_empty_sub, 12f)
        val logo = if (big) 26f else 20f
        val addSize = if (big) 36f else 30f
        v.size(look, R.id.w_logo, logo, logo)
        v.size(look, R.id.w_add_wrap, addSize, addSize)
        v.button(look, R.id.w_add_bg, R.id.w_add_ring, R.id.w_add)

        // How much of today is done, on the task list (the bar is tinted, so Android 12+ only).
        val progress = which == "tasks" && Build.VERSION.SDK_INT >= 31 && open + done > 0 && done > 0
        v.shown(R.id.w_progress, progress)
        if (progress) {
            v.setProgressBar(R.id.w_progress, 100, done * 100 / (open + done), false)
            if (look.accent.res != 0) v.setColorStateList(R.id.w_progress, "setProgressTintList", look.accent.res)
            else v.setColorStateList(R.id.w_progress, "setProgressTintList", ColorStateList.valueOf(look.accent.int))
            if (look.soft2.res != 0) v.setColorStateList(R.id.w_progress, "setProgressBackgroundTintList", look.soft2.res)
            else v.setColorStateList(R.id.w_progress, "setProgressBackgroundTintList", ColorStateList.valueOf(look.soft2.int))
        }

        v.setOnClickPendingIntent(R.id.w_add_wrap, quickAdd(ctx))
        // Each kind its own request code: PendingIntents that differ only in extras would share one.
        val calendar = which == "today" || which == "week"
        val home = openApp(ctx, if (calendar) JSONObject().put("type", "open").put("calendar", true) else null, if (calendar) 9112 else 9110)
        v.setOnClickPendingIntent(R.id.w_head, home)
        v.setOnClickPendingIntent(R.id.w_empty, openApp(ctx, null, 9110))

        if (Build.VERSION.SDK_INT >= 31) {
            // The rows travel with the update itself, so a full update always shows them (some
            // launchers keep the old views when only a row service's data changes).
            // Stable ids (from the task, the event or the day), so the list keeps its place when a row goes.
            val items = RemoteViews.RemoteCollectionItems.Builder().setViewTypeCount(2).setHasStableIds(true)
            val seen = HashSet<Long>()
            for (i in 0 until rows.length()) {
                val r = rows.optJSONObject(i) ?: JSONObject()
                val key = r.optString("id").ifEmpty { r.optString("kind") + r.optString("title") + r.optString("time") }
                var itemId = key.hashCode().toLong()
                if (!seen.add(itemId)) itemId = (i.toLong() shl 32) or (itemId and 0xFFFFFFFFL)
                items.addItem(itemId, rowView(ctx, look, which, r, big))
            }
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

    /** One row of a list widget (or a day's heading in the week widget). */
    fun rowView(ctx: Context, look: Look, which: String, r: JSONObject, wide: Boolean = true): RemoteViews {
        if (r.optString("kind") == "day") {
            val h = RemoteViews(ctx.packageName, R.layout.w_day)
            h.heading(ctx, look, R.id.w_day, R.id.w_day_img, r.optString("title"), 14f, look.accentText)
            return h
        }
        val v = RemoteViews(ctx.packageName, R.layout.w_row)
        val id = r.optString("id", "")
        val title = r.optString("title")
        v.setTextViewText(R.id.w_row_title, title)
        v.text(R.id.w_row_title, look.ink)
        v.sp(look, R.id.w_row_title, 15f)
        v.sp(look, R.id.w_chip1, 11.5f)
        v.sp(look, R.id.w_chip2, 11.5f)
        v.size(look, R.id.w_tick, 38f, 42f)
        v.size(look, R.id.w_dot, 24f, 24f)
        v.size(look, R.id.w_dot_half, 24f, 24f)
        val isTask = id.isNotEmpty()
        val event = r.optString("kind") == "event"
        val doing = r.optString("status") == "doing"
        v.shown(R.id.w_dot, isTask)
        v.shown(R.id.w_dot_half, isTask && doing)
        v.shown(R.id.w_bar, event)
        v.tint(R.id.w_dot, if (doing) look.doing else look.ring)
        v.tint(R.id.w_dot_half, look.doing)
        v.tint(R.id.w_bar, look.accent)

        // The chips: an event's time; a task's due day (or "Overdue") and its steps.
        val timed = which == "today" || which == "week"
        val first = if (timed) r.optString("time") else r.optString("due")
        val firstTone = if (event) "accent" else if (r.optBoolean("late")) "late" else ""
        v.chip(look, 1, first, firstTone)
        v.chip(look, 2, r.optString("steps"), "")
        v.shown(R.id.w_row_meta, first.isNotEmpty() || r.optString("steps").isNotEmpty())

        // The task lists: start or pause, and delete, right on the row (wide enough widgets only).
        val actions = isTask && wide && (which == "tasks" || which == "doing")
        v.shown(R.id.w_state, actions)
        v.shown(R.id.w_delete, actions)
        if (actions) {
            v.setImageViewResource(R.id.w_state, if (doing) R.drawable.ic_pause else R.drawable.ic_play)
            v.tint(R.id.w_state, if (doing) look.doing else look.muted)
            v.tint(R.id.w_delete, look.muted)
            v.size(look, R.id.w_state, 34f, 40f)
            v.size(look, R.id.w_delete, 34f, 40f)
            v.setContentDescription(R.id.w_state, if (doing) "Pause $title" else "Start $title")
            v.setContentDescription(R.id.w_delete, "Delete $title")
            v.setOnClickFillInIntent(R.id.w_state, Intent().putExtra("what", if (doing) "todo" else "doing").putExtra("id", id))
            v.setOnClickFillInIntent(R.id.w_delete, Intent().putExtra("what", "delete").putExtra("id", id))
        }
        if (isTask) {
            v.setContentDescription(R.id.w_tick, "Mark $title done")
            v.setOnClickFillInIntent(R.id.w_tick, Intent().putExtra("what", "done").putExtra("id", id))
            v.setOnClickFillInIntent(R.id.w_row_text, Intent().putExtra("what", "open").putExtra("id", id))
        } else {
            v.setOnClickFillInIntent(R.id.w_row_text, Intent().putExtra("what", "calendar"))
        }
        return v
    }

    private fun next(ctx: Context, look: Look, s: JSONObject, big: Boolean): RemoteViews {
        val v = RemoteViews(ctx.packageName, if (big) R.layout.w_next else R.layout.w_next_small)
        v.setInt(BG, "setBackgroundResource", look.card)
        v.text(R.id.w_label, look.accentText)
        v.text(R.id.w_task, look.ink)
        val open = s.optJSONObject("counts")?.optInt("open") ?: 0
        if (big) {
            v.tint(R.id.w_logo, look.accent)
            v.text(R.id.w_more, look.muted)
            v.text(R.id.w_done_text, look.onAccent)
        }
        v.button(look, R.id.w_done_bg, R.id.w_done_ring, R.id.w_done)
        v.sp(look, R.id.w_label, if (big) 12.5f else 11f)
        v.sp(look, R.id.w_task, if (big) 21f else 15f)
        if (big) {
            v.sp(look, R.id.w_more, 12f)
            v.sp(look, R.id.w_done_text, 14f)
            v.sp(look, R.id.w_chip1, 11.5f)
            v.sp(look, R.id.w_chip2, 11.5f)
            v.size(look, R.id.w_logo, 20f, 20f)
            v.size(look, R.id.w_done_wrap, 0f, 38f)
            v.size(look, R.id.w_done, 18f, 18f)
            v.size(look, R.id.w_mascot, 58f, 52f)
        } else {
            v.size(look, R.id.w_done_wrap, 40f, 40f)
            v.size(look, R.id.w_mascot, 40f, 36f)
        }
        val t = s.optJSONObject("next")
        if (t == null) {
            v.setTextViewText(R.id.w_label, "Next up")
            v.setTextViewText(R.id.w_task, if (s.has("tasks")) "All clear!" else "Open Quicky once to fill this in")
            v.shown(R.id.w_done_wrap, false)
            v.shown(R.id.w_mascot, true)
            v.mascot(look, if (s.has("tasks")) "clear" else "")
            if (big) {
                v.setTextViewText(R.id.w_more, "")
                v.shown(R.id.w_row_meta, false)
            }
            v.setOnClickPendingIntent(BG, openApp(ctx, null, 9300))
            return v
        }
        val id = t.optString("id")
        v.setTextViewText(R.id.w_label, if (t.optBoolean("pinned")) "Pinned" else if (t.optString("status") == "doing") "Doing now" else "Next up")
        v.setTextViewText(R.id.w_task, t.optString("title"))
        v.shown(R.id.w_mascot, false)
        v.shown(R.id.w_done_wrap, true)
        v.setContentDescription(R.id.w_done_wrap, "Mark ${t.optString("title")} done")
        if (big) {
            v.setTextViewText(R.id.w_more, if (open > 1) "+${open - 1} more" else "")
            v.chip(look, 1, t.optString("due"), if (t.optBoolean("late")) "late" else "")
            v.chip(look, 2, t.optString("steps"), "")
            v.shown(R.id.w_row_meta, true)
        }
        val done = Intent(ctx, WidgetTapActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra("what", "done").putExtra("id", id)
        v.setOnClickPendingIntent(
            R.id.w_done_wrap,
            PendingIntent.getActivity(ctx, 9301, done, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE),
        )
        v.setOnClickPendingIntent(BG, openApp(ctx, JSONObject().put("type", "open").put("id", id), 9302))
        return v
    }

    private fun blob(ctx: Context, look: Look, s: JSONObject, big: Boolean): RemoteViews {
        val v = RemoteViews(ctx.packageName, if (big) R.layout.w_blob_wide else R.layout.w_blob)
        val open = s.optJSONObject("counts")?.optInt("open") ?: 0
        val mood = mood(s)
        v.mascot(look, mood)
        // No badge with nothing to do (or before the first snapshot): just Quicky, smiling.
        v.shown(R.id.w_badge, open > 0)
        v.setTextViewText(R.id.w_badge, if (open > 99) "99+" else open.toString())
        v.sp(look, R.id.w_badge, 12f)
        v.size(look, R.id.w_badge, 0f, 24f)
        v.setContentDescription(R.id.w_q_face, if (open > 0) "Quicky, $open to do" else "Quicky")
        v.setOnClickPendingIntent(R.id.w_root, openApp(ctx, null, 9400))
        if (big) {
            // Quicky's speech balloon: the next task, as the desktop balloon shows the pinned one.
            v.setInt(R.id.w_balloon, "setBackgroundResource", look.card)
            v.text(R.id.w_bal_title, look.ink)
            v.text(R.id.w_bal_sub, if (mood == "cross") look.late else look.muted)
            val t = s.optJSONObject("next")
            val (line, sub) = when {
                !s.has("tasks") -> "Hi! I'm Quicky." to "Open me once to fill this in"
                t == null -> "All clear!" to "Nothing left to do"
                else -> t.optString("title") to when {
                    mood == "cross" -> "Overdue!"
                    open > 1 -> "+${open - 1} more"
                    else -> "Last one!"
                }
            }
            v.setTextViewText(R.id.w_bal_title, line)
            v.setTextViewText(R.id.w_bal_sub, sub)
            v.sp(look, R.id.w_bal_title, 13.5f)
            v.sp(look, R.id.w_bal_sub, 11.5f)
            v.size(look, R.id.w_blob_box, 0f, 66f)
            v.setOnClickPendingIntent(
                R.id.w_balloon,
                openApp(ctx, t?.let { JSONObject().put("type", "open").put("id", it.optString("id")) }, 9401),
            )
        }
        return v
    }

    private fun add(ctx: Context, look: Look, big: Boolean): RemoteViews {
        val v = RemoteViews(ctx.packageName, if (big) R.layout.w_add_wide else R.layout.w_add)
        v.button(look, R.id.w_add_bg, R.id.w_add_ring, R.id.w_add)
        if (big) {
            v.setInt(BG, "setBackgroundResource", look.card)
            v.text(R.id.w_add_text, look.muted)
            v.sp(look, R.id.w_add_text, 15f)
            v.tint(R.id.w_logo, look.accent)
            v.setOnClickPendingIntent(BG, quickAdd(ctx))
        } else {
            v.shown(R.id.w_add_shadow, look.edged)
            v.setOnClickPendingIntent(R.id.w_root, quickAdd(ctx))
        }
        return v
    }

    // ---- the widget picker ------------------------------------------------------------------------

    /**
     * Android 15+: the picker shows each widget drawn by us, with sample tasks in the user's own
     * colours. Sent again only when the colours change (Android limits how often).
     */
    private fun previews(ctx: Context) {
        if (Build.VERSION.SDK_INT < 35) return
        val s = Store.snapshot(ctx)
        if (!s.has("accent")) return
        val sample = sample(s)
        val sig = listOf(s.optString("accent"), s.optString("onAccent"), sample.optString("mode")).joinToString("|")
        val mgr = AppWidgetManager.getInstance(ctx)
        for (k in KINDS) {
            if (Store.previewSig(ctx, k.simpleName) == sig) continue
            val ok = try {
                mgr.setWidgetPreview(ComponentName(ctx, k), AppWidgetProviderInfo.WIDGET_CATEGORY_HOME_SCREEN, build(ctx, k, 0, sample, WidgetStyle(), true))
            } catch (_: Exception) { false }
            if (ok) Store.setPreviewSig(ctx, k.simpleName, sig) else break
        }
    }

    /** Made-up tasks in the snapshot's colours, for previews. */
    fun sample(s: JSONObject): JSONObject {
        fun task(id: String, title: String, vararg kv: Pair<String, Any>) = JSONObject().put("id", id).put("title", title).put("status", "todo").also { o -> kv.forEach { o.put(it.first, it.second) } }
        val report = task("p1", "Write the report", "status" to "doing", "steps" to "2/5 steps")
        val dentist = task("p2", "Call the dentist", "due" to "Today")
        val plants = task("p3", "Water the plants")
        val milk = task("p4", "Buy oat milk", "due" to "Sat")
        val event = { title: String, time: String -> JSONObject().put("title", title).put("time", time).put("kind", "event") }
        val date = s.optString("date").ifEmpty { "Today" }
        return JSONObject()
            .put("accent", s.optString("accent")).put("onAccent", s.optString("onAccent"))
            .put("mode", s.optString("mode").ifEmpty { if (s.optBoolean("dark")) "dark" else "light" })
            .put("dark", s.optBoolean("dark"))
            .put("date", date)
            .put("tasks", JSONArray().put(report).put(dentist).put(plants).put(milk))
            .put("next", JSONObject(report.toString()).put("pinned", false))
            .put("today", JSONArray().put(event("Team stand-up", "9:30 AM")).put(JSONObject(dentist.toString()).put("time", "Due today").put("kind", "task")))
            .put("week", JSONArray()
                .put(JSONObject().put("title", "Today").put("kind", "day"))
                .put(event("Team stand-up", "9:30 AM"))
                .put(JSONObject(dentist.toString()).put("time", "").put("kind", "task"))
                .put(JSONObject().put("title", "Tomorrow").put("kind", "day"))
                .put(event("Lunch with Sam", "1:00 PM")))
            .put("counts", JSONObject().put("open", 4).put("done", 2))
    }
}

/** How one placed widget looks: "quicky" (the app's cards), "soft" or "you" (Material You); its
 *  colours: "app" (like the app's theme), "light", "dark" or "phone"; its text size (1 = normal);
 *  and `scale`, the launcher's shrink made up for (worked out on each update, not saved). */
data class WidgetStyle(val look: String = "quicky", val theme: String = "app", val text: Float = 1f, val scale: Float = 1f)

/** All the widgets: redrawn on update, on resize (before Android 12), and their settings dropped when removed. */
open class QuickyWidget : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) = Widgets.update(ctx, mgr, javaClass, ids)

    override fun onAppWidgetOptionsChanged(ctx: Context, mgr: AppWidgetManager, id: Int, options: Bundle) {
        // Android 12+ picks the layout for the size itself, but One UI's shrink factor can change with
        // the home screen grid, so redraw there too.
        if (Build.VERSION.SDK_INT < 31 || options.containsKey("hsResizeRatio")) Widgets.update(ctx, mgr, javaClass, intArrayOf(id))
    }

    override fun onDeleted(ctx: Context, ids: IntArray) {
        for (id in ids) Store.forgetWidget(ctx, id)
    }
}

class TaskListWidget : QuickyWidget()
class QuickAddWidget : QuickyWidget()
class NextUpWidget : QuickyWidget()
class TodayWidget : QuickyWidget()
class BlobWidget : QuickyWidget()
class DoingWidget : QuickyWidget()
class WeekWidget : QuickyWidget()

/** The rows of the list widgets on Android 11 and older. */
class RowsService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory =
        Rows(applicationContext, intent.getStringExtra("which") ?: "tasks", intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, 0))
}

class Rows(private val ctx: Context, private val which: String, private val widgetId: Int) : RemoteViewsService.RemoteViewsFactory {
    private var rows = JSONArray()
    private var look = Widgets.Look(ctx, JSONObject(), WidgetStyle())

    override fun onCreate() {}
    override fun onDestroy() {}
    override fun onDataSetChanged() {
        val s = Store.snapshot(ctx)
        look = Widgets.Look(ctx, s, Store.widgetStyle(ctx, widgetId).copy(scale = Widgets.scale(AppWidgetManager.getInstance(ctx), widgetId)))
        rows = Widgets.rows(s, which)
    }

    override fun getCount() = rows.length()
    override fun getViewTypeCount() = 2
    override fun getItemId(position: Int) = position.toLong()
    override fun hasStableIds() = false
    override fun getLoadingView(): RemoteViews? = null

    override fun getViewAt(position: Int): RemoteViews = Widgets.rowView(ctx, look, which, rows.optJSONObject(position) ?: JSONObject())
}

/**
 * A tap on a widget: ticks the task off, starts or pauses it, or deletes it (queued for the page and
 * shown on the widgets at once), or opens Quicky on it. An activity, not a broadcast, because Android only lets activities open
 * other screens.
 */
class WidgetTapActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val id = intent.getStringExtra("id") ?: ""
        val what = intent.getStringExtra("what")
        Sfx.play(this, when (what) { "done" -> "done"; "doing" -> "doing"; "todo" -> "undo"; "delete" -> "delete"; else -> "tap" })
        when (what) {
            "launch" -> launchIntent(this, intent.getStringExtra("action")?.let { JSONObject(it) })?.let { startActivity(it) }
            "done" -> if (id.isNotEmpty()) {
                Store.enqueue(this, JSONObject().put("type", "status").put("id", id).put("status", "done").put("at", System.currentTimeMillis()))
                Store.markDone(this, id)
                Widgets.refresh(this)
            }
            "doing", "todo" -> if (id.isNotEmpty()) {
                val status = intent.getStringExtra("what")!!
                Store.enqueue(this, JSONObject().put("type", "status").put("id", id).put("status", status).put("at", System.currentTimeMillis()))
                Store.setStatus(this, id, status)
                Widgets.refresh(this)
            }
            "delete" -> if (id.isNotEmpty()) {
                Store.enqueue(this, JSONObject().put("type", "delete").put("id", id).put("at", System.currentTimeMillis()))
                Store.remove(this, id)
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
        if (savedInstanceState == null) Sfx.play(this, "open")
        val look = Widgets.Look(this, Store.snapshot(this), WidgetStyle())
        findViewById<View>(R.id.qa_root).setBackgroundResource(if (look.dark) R.drawable.w_card_q_dark else R.drawable.w_card_q_light)
        val field = findViewById<EditText>(R.id.qa_text)
        field.setTextColor(look.ink.int)
        field.setHintTextColor(look.muted.int)
        field.background.mutate().setTint(look.soft2.int)
        val button = findViewById<TextView>(R.id.qa_add)
        button.setTextColor(look.onAccent.int)
        button.background.mutate().setTint(look.accent.int)
        findViewById<TextView>(R.id.qa_title).setTextColor(look.ink.int)
        findViewById<android.widget.ImageView>(R.id.qa_logo).setColorFilter(look.accent.int)
        val cancel = findViewById<TextView>(R.id.qa_cancel)
        cancel.setTextColor(look.ink.int)
        cancel.background.mutate().setTint(look.soft2.int)
        cancel.setOnClickListener { finish() }
        // A tap outside the box cancels too.
        val outside = findViewById<View>(R.id.qa_outside)
        outside.setOnClickListener { finish() }
        // The box sits just above the keyboard and the navigation bar (Android 15 draws behind them).
        val pad = outside.paddingBottom
        outside.setOnApplyWindowInsetsListener { v, insets ->
            val bottom = if (Build.VERSION.SDK_INT >= 30) {
                insets.getInsets(android.view.WindowInsets.Type.systemBars() or android.view.WindowInsets.Type.ime()).bottom
            } else {
                @Suppress("DEPRECATION")
                insets.systemWindowInsetBottom
            }
            v.setPadding(v.paddingLeft, v.paddingTop, v.paddingRight, pad + bottom)
            insets
        }
        var added = false
        val add = {
            val title = field.text.toString().trim()
            // The keyboard's Enter can arrive twice (down and up) before the box closes.
            if (title.isNotEmpty() && !added) {
                added = true
                val id = java.lang.Long.toString(System.currentTimeMillis(), 36) + "w" + (Math.random() * 1e6).toLong().toString(36)
                Store.enqueue(this, JSONObject().put("type", "add").put("id", id).put("title", title).put("at", System.currentTimeMillis()))
                Store.addTask(this, id, title)
                Sfx.play(this, "add")
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
