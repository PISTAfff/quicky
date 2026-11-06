package app.quicky.android

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

/**
 * What the widgets and reminders need while the app's page isn't running, in the app's private
 * preferences:
 * - `snapshot`: the page's last picture of the tasks (see `src/mobile/native.ts`, `Snapshot`),
 *   drawn by the widgets;
 * - `queue`: what was done from a widget or a notification (tick off, add, snooze, open), applied
 *   by the page through its own store actions the next time it runs, then synced;
 * - `alarms`: the reminders scheduled now, so they can be cancelled or put back after a restart.
 */
object Store {
    private const val PREFS = "quicky"

    private fun prefs(ctx: Context): SharedPreferences = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun snapshot(ctx: Context): JSONObject =
        try { JSONObject(prefs(ctx).getString("snapshot", null) ?: "{}") } catch (_: Exception) { JSONObject() }

    fun setSnapshot(ctx: Context, json: String) = prefs(ctx).edit().putString("snapshot", json).apply()

    @Synchronized
    fun enqueue(ctx: Context, action: JSONObject) {
        val q = queue(ctx)
        q.put(action)
        prefs(ctx).edit().putString("queue", q.toString()).commit()
    }

    private fun queue(ctx: Context): JSONArray =
        try { JSONArray(prefs(ctx).getString("queue", null) ?: "[]") } catch (_: Exception) { JSONArray() }

    /** Everything queued, emptied in the same step. */
    @Synchronized
    fun drain(ctx: Context): JSONArray {
        val q = queue(ctx)
        prefs(ctx).edit().putString("queue", "[]").commit()
        return q
    }

    /** Draws what's still queued onto the snapshot (the page's newer one doesn't have it yet). */
    fun replayQueue(ctx: Context) {
        val q = queue(ctx)
        for (i in 0 until q.length()) {
            val a = q.optJSONObject(i) ?: continue
            val id = a.optString("id")
            when (a.optString("type")) {
                "status" -> if (a.optString("status") == "done") markDone(ctx, id)
                "add" -> if (!hasTask(ctx, id)) addTask(ctx, id, a.optString("title"))
            }
        }
    }

    private fun hasTask(ctx: Context, id: String): Boolean {
        val tasks = snapshot(ctx).optJSONArray("tasks") ?: return false
        for (i in 0 until tasks.length()) if (tasks.optJSONObject(i)?.optString("id") == id) return true
        return false
    }

    fun alarms(ctx: Context): JSONArray =
        try { JSONArray(prefs(ctx).getString("alarms", null) ?: "[]") } catch (_: Exception) { JSONArray() }

    fun setAlarms(ctx: Context, list: JSONArray) = prefs(ctx).edit().putString("alarms", list.toString()).apply()

    /**
     * A task ticked off away from the page: gone from the widgets' lists at once (the page applies
     * the real change later and sends a fresh snapshot).
     */
    fun markDone(ctx: Context, id: String) {
        val s = snapshot(ctx)
        val tasks = s.optJSONArray("tasks") ?: JSONArray()
        val left = JSONArray()
        for (i in 0 until tasks.length()) {
            val t = tasks.optJSONObject(i) ?: continue
            if (t.optString("id") != id) left.put(t)
        }
        // Not on the list (already done, or another list's): nothing to change.
        if (left.length() == tasks.length() && s.optJSONObject("next")?.optString("id") != id) return
        s.put("tasks", left)
        val next = s.optJSONObject("next")
        if (next != null && next.optString("id") == id) {
            s.put("next", left.optJSONObject(0)?.let { JSONObject(it.toString()).put("pinned", false) } ?: JSONObject.NULL)
        }
        val counts = s.optJSONObject("counts") ?: JSONObject()
        counts.put("open", maxOf(0, counts.optInt("open") - 1)).put("done", counts.optInt("done") + 1)
        s.put("counts", counts)
        val today = s.optJSONArray("today") ?: JSONArray()
        val keep = JSONArray()
        for (i in 0 until today.length()) {
            val r = today.optJSONObject(i) ?: continue
            if (r.optString("id") != id) keep.put(r)
        }
        s.put("today", keep)
        // The week widget: the task's row goes, and so does a day's heading left with nothing under it.
        s.optJSONArray("week")?.let { week ->
            val rows = (0 until week.length()).mapNotNull { week.optJSONObject(it) }.filter { it.optString("id") != id }
            val out = JSONArray()
            rows.forEachIndexed { i, r ->
                val heading = r.optString("kind") == "day"
                if (!heading || (i + 1 < rows.size && rows[i + 1].optString("kind") != "day")) out.put(r)
            }
            s.put("week", out)
        }
        setSnapshot(ctx, s.toString())
    }

    /** A task added from the widget's box: on the list at once. */
    fun addTask(ctx: Context, id: String, title: String) {
        val s = snapshot(ctx)
        val tasks = s.optJSONArray("tasks") ?: JSONArray()
        val out = JSONArray().put(JSONObject().put("id", id).put("title", title).put("status", "todo"))
        for (i in 0 until tasks.length()) out.put(tasks.get(i))
        s.put("tasks", out)
        if (s.isNull("next") || !s.has("next")) s.put("next", JSONObject(out.getJSONObject(0).toString()).put("pinned", false))
        val counts = s.optJSONObject("counts") ?: JSONObject()
        counts.put("open", counts.optInt("open") + 1)
        s.put("counts", counts)
        setSnapshot(ctx, s.toString())
    }
}
