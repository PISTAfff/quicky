//! The screen tools' Record: a part of the screen recorded to an MP4 in Videos\Quicky (or the
//! user's folder) by `win::Recorder`, on a thread of its own, 30 frames a second. The page sends
//! the microphone's sound when it's on (`rec_audio`); pausing leaves the paused time out. While
//! recording, the screen tools' window is kept out of the picture (its frame and stop bar stay on
//! screen only), so live drawing isn't recorded either. Every way of leaving finishes the file
//! (`stop`): an MP4 that's never finished doesn't play.

use crate::win;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::ipc::Request;
use tauri::AppHandle;

const FPS: u32 = 30;

enum Msg {
    Audio(Vec<u8>),
    Pause(bool),
    Stop,
}

struct Active {
    tx: Sender<Msg>,
    thread: JoinHandle<Result<(), String>>,
    path: PathBuf,
    folder: PathBuf,
}

static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);

fn lock() -> std::sync::MutexGuard<'static, Option<Active>> {
    ACTIVE.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn active() -> bool {
    lock().is_some()
}

/// Finishes the recording going on (if any): where it was saved, and its folder.
pub fn stop(app: &AppHandle) -> Option<Result<(PathBuf, PathBuf), String>> {
    let a = lock().take()?;
    let _ = a.tx.send(Msg::Stop);
    let done = a.thread.join().unwrap_or_else(|_| Err("The recording stopped unexpectedly".into()));
    if let Some(w) = crate::draw::window(app) {
        win::exclude_from_capture(&w, false);
    }
    Some(done.map(|()| {
        crate::draw::remember(&a.path);
        (a.path, a.folder)
    }))
}

fn run(rec: &mut win::Recorder, rx: &Receiver<Msg>) -> Result<(), String> {
    let frame = Duration::from_nanos(1_000_000_000 / FPS as u64);
    let start = Instant::now();
    let mut paused_for = Duration::ZERO;
    let mut paused_at: Option<Instant> = None;
    let mut next = Instant::now();
    loop {
        while let Ok(m) = rx.try_recv() {
            match m {
                Msg::Audio(pcm) if paused_at.is_none() => rec.audio(&pcm)?,
                Msg::Audio(_) => {}
                Msg::Pause(true) => paused_at = paused_at.or(Some(Instant::now())),
                Msg::Pause(false) => {
                    if let Some(p) = paused_at.take() {
                        paused_for += p.elapsed();
                    }
                }
                Msg::Stop => return Ok(()),
            }
        }
        if paused_at.is_none() {
            let at = (start.elapsed() - paused_for).as_nanos() / 100;
            rec.frame(at as i64)?;
        }
        next += frame;
        let now = Instant::now();
        // Behind (a big area on a slow PC): skip ahead rather than rush.
        if next < now {
            next = now;
        } else {
            std::thread::sleep(next - now);
        }
    }
}

/// Starts recording `rect` (physical px, relative to the screen tools' window) to a new MP4
/// named `name`, with the microphone's sound when `mic` and a ring around clicks when `clicks`.
#[tauri::command]
pub async fn rec_start(app: AppHandle, rect: [i32; 4], mic: bool, clicks: bool, name: String) -> Result<(), String> {
    if !win::CAN_RECORD {
        return Err("Recording the screen isn't available on this system yet".into());
    }
    if active() {
        return Err("Already recording".into());
    }
    let w = crate::draw::window(&app).ok_or("The screen tools aren't open")?;
    let origin = w.outer_position().map_err(|e| e.to_string())?;
    let [x, y, width, height] = rect;
    if width < 16 || height < 16 {
        return Err("Choose a bigger area".into());
    }
    let area = win::Rect { left: origin.x + x, top: origin.y + y, right: origin.x + x + width, bottom: origin.y + y + height };
    let folder = crate::draw::folder(&app, true)?;
    let path = crate::draw::fresh_path(&folder, &crate::draw::clean_name(&name), "mp4");
    // The window's frame and stop bar stay on screen, out of the video.
    win::exclude_from_capture(&w, true);
    let (tx, rx) = channel();
    let (ready_tx, ready_rx) = channel();
    let file = path.clone();
    let thread = std::thread::spawn(move || {
        let mut rec = match win::Recorder::start(area, &file, mic, clicks, FPS) {
            Ok(r) => {
                let _ = ready_tx.send(Ok(()));
                r
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e.clone()));
                return Err(e);
            }
        };
        let ran = run(&mut rec, &rx);
        let finished = rec.finish();
        ran.and(finished)
    });
    match ready_rx.recv() {
        Ok(Ok(())) => {
            *lock() = Some(Active { tx, thread, path, folder });
            Ok(())
        }
        Ok(Err(e)) => {
            win::exclude_from_capture(&w, false);
            let _ = thread.join();
            let _ = std::fs::remove_file(&path);
            Err(e)
        }
        Err(_) => {
            win::exclude_from_capture(&w, false);
            Err("The recording didn't start".into())
        }
    }
}

/// The microphone's sound (raw body: 16-bit mono PCM at 48 kHz).
#[tauri::command]
pub fn rec_audio(request: Request<'_>) {
    if let Ok(pcm) = crate::data::body_bytes(&request)
        && let Some(a) = lock().as_ref()
    {
        let _ = a.tx.send(Msg::Audio(pcm.into_owned()));
    }
}

#[tauri::command]
pub fn rec_pause(paused: bool) {
    if let Some(a) = lock().as_ref() {
        let _ = a.tx.send(Msg::Pause(paused));
    }
}

/// Stops and finishes the file: where it was saved.
#[tauri::command]
pub async fn rec_stop(app: AppHandle) -> Result<Value, String> {
    let (path, folder) = stop(&app).ok_or("Not recording")??;
    Ok(json!({ "path": path.to_string_lossy(), "folder": folder.to_string_lossy() }))
}
