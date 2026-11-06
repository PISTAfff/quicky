package app.quicky.android

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/**
 * Quicky in the Quick Settings panel: one tap opens the small add box (keyboard up) over whatever
 * is on screen. The tile shows how many tasks are open, from the widgets' snapshot.
 */
class QuickAddTile : TileService() {
    override fun onStartListening() {
        super.onStartListening()
        val tile = qsTile ?: return
        tile.state = Tile.STATE_INACTIVE
        tile.icon = Icon.createWithResource(this, R.drawable.ic_tile_add)
        tile.label = "Add a task"
        val open = Store.snapshot(this).optJSONObject("counts")?.optInt("open")
        if (Build.VERSION.SDK_INT >= 29) tile.subtitle = if (open == null) "Quicky" else if (open == 0) "All clear" else "$open to do"
        tile.contentDescription = "Add a task to Quicky"
        tile.updateTile()
    }

    override fun onClick() {
        super.onClick()
        // On the lock screen the box waits until the phone is unlocked.
        if (isLocked) unlockAndRun { open() } else open()
    }

    @SuppressLint("StartActivityAndCollapseDeprecated")
    private fun open() {
        val intent = Intent(this, QuickAddActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 9500, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }
}
