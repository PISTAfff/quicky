//! Recording part of the screen to an MP4 (H.264 video, AAC microphone sound when asked) with
//! Media Foundation's sink writer, which picks a hardware encoder when the PC has one. Each frame
//! is the screen area copied with GDI (what `capture` does), with the pointer drawn in and, when
//! asked, a ring while the left button is down. The caller times the frames (`frame(at)`) and
//! hands over the sound as 16-bit mono PCM at 48 kHz (`audio`). Lives on one thread (COM).

use super::{left_button_down, Rect};
use std::path::Path;
use windows::core::HSTRING;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
use windows_sys::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, CreatePen, DeleteDC, DeleteObject, Ellipse, GetDC, GetStockObject, ReleaseDC, SelectObject,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ, HPEN, NULL_BRUSH, PS_SOLID, SRCCOPY,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{DrawIconEx, GetCursorInfo, GetIconInfo, CURSORINFO, CURSOR_SHOWING, DI_NORMAL, ICONINFO};

/// Recording the screen works here: Media Foundation is installed (Windows N editions leave it
/// out unless the Media Feature Pack is added). Its DLLs are delay-loaded (`build.rs`), so
/// nothing calls into them before this says yes.
pub fn can_record() -> bool {
    use std::sync::OnceLock;
    use windows_sys::Win32::System::LibraryLoader::{LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32};
    static OK: OnceLock<bool> = OnceLock::new();
    *OK.get_or_init(|| {
        ["mfplat.dll", "mfreadwrite.dll"].iter().all(|dll| {
            let wide: Vec<u16> = dll.encode_utf16().chain(Some(0)).collect();
            !unsafe { LoadLibraryExW(wide.as_ptr(), std::ptr::null_mut(), LOAD_LIBRARY_SEARCH_SYSTEM32) }.is_null()
        })
    })
}

/// Mic sound: 48 kHz, mono, 16-bit.
const RATE: u32 = 48_000;

/// The screen area copied each frame, through one bitmap kept for the whole recording.
struct Grab {
    screen: HDC,
    dc: HDC,
    bmp: HBITMAP,
    old: HGDIOBJ,
    bits: *mut u8,
    pen: HPEN,
    area: Rect,
}

impl Grab {
    fn new(area: Rect) -> Option<Self> {
        let (w, h) = (area.right - area.left, area.bottom - area.top);
        unsafe {
            let screen = GetDC(std::ptr::null_mut());
            if screen.is_null() {
                return None;
            }
            let dc = CreateCompatibleDC(screen);
            let mut bi: BITMAPINFO = std::mem::zeroed();
            bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            bi.bmiHeader.biWidth = w;
            bi.bmiHeader.biHeight = -h; // top-down rows
            bi.bmiHeader.biPlanes = 1;
            bi.bmiHeader.biBitCount = 32;
            bi.bmiHeader.biCompression = BI_RGB;
            let mut bits = std::ptr::null_mut();
            let bmp = CreateDIBSection(dc, &bi, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0);
            if dc.is_null() || bmp.is_null() || bits.is_null() {
                if !bmp.is_null() {
                    DeleteObject(bmp);
                }
                if !dc.is_null() {
                    DeleteDC(dc);
                }
                ReleaseDC(std::ptr::null_mut(), screen);
                return None;
            }
            let old = SelectObject(dc, bmp);
            // The click ring: Quicky yellow, 3 px.
            let pen = CreatePen(PS_SOLID, 3, 0x0000_C8FF);
            Some(Grab { screen, dc, bmp, old, bits: bits as *mut u8, pen, area })
        }
    }

    /// Copies the area (and the pointer) into the bitmap; gives its rows (BGRA, top-down).
    fn take(&mut self, clicks: bool) -> &[u8] {
        let a = self.area;
        let (w, h) = (a.right - a.left, a.bottom - a.top);
        unsafe {
            BitBlt(self.dc, 0, 0, w, h, self.screen, a.left, a.top, SRCCOPY | CAPTUREBLT);
            let mut ci: CURSORINFO = std::mem::zeroed();
            ci.cbSize = std::mem::size_of::<CURSORINFO>() as u32;
            if GetCursorInfo(&mut ci) != 0 && ci.flags & CURSOR_SHOWING != 0 {
                let (cx, cy) = (ci.ptScreenPos.x - a.left, ci.ptScreenPos.y - a.top);
                if clicks && left_button_down() {
                    let old_pen = SelectObject(self.dc, self.pen);
                    let old_brush = SelectObject(self.dc, GetStockObject(NULL_BRUSH));
                    Ellipse(self.dc, cx - 18, cy - 18, cx + 18, cy + 18);
                    SelectObject(self.dc, old_brush);
                    SelectObject(self.dc, old_pen);
                }
                let mut ii: ICONINFO = std::mem::zeroed();
                if GetIconInfo(ci.hCursor, &mut ii) != 0 {
                    DrawIconEx(self.dc, cx - ii.xHotspot as i32, cy - ii.yHotspot as i32, ci.hCursor, 0, 0, 0, std::ptr::null_mut(), DI_NORMAL);
                    // GetIconInfo hands out copies of the cursor's bitmaps.
                    if !ii.hbmMask.is_null() {
                        DeleteObject(ii.hbmMask);
                    }
                    if !ii.hbmColor.is_null() {
                        DeleteObject(ii.hbmColor);
                    }
                }
            }
            std::slice::from_raw_parts(self.bits, (w * h * 4) as usize)
        }
    }
}

impl Drop for Grab {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.old);
            DeleteObject(self.bmp);
            DeleteObject(self.pen);
            DeleteDC(self.dc);
            ReleaseDC(std::ptr::null_mut(), self.screen);
        }
    }
}

pub struct Recorder {
    writer: Option<IMFSinkWriter>,
    video: u32,
    audio: Option<u32>,
    grab: Grab,
    clicks: bool,
    frame_len: i64,
    /// Sound samples written so far (their time comes from this count).
    samples: u64,
    started: bool,
}

fn err(e: windows::core::Error) -> String {
    format!("Couldn't record ({})", e.message())
}

const fn pack(a: u32, b: u32) -> u64 {
    ((a as u64) << 32) | b as u64
}

impl Recorder {
    /// Starts an MP4 at `path` of the screen `area` (physical px; trimmed to even sizes, which
    /// H.264 needs), at `fps` frames a second, with a sound track when `audio`.
    pub fn start(area: Rect, path: &Path, audio: bool, clicks: bool, fps: u32) -> Result<Self, String> {
        let w = ((area.right - area.left).max(16) & !1) as u32;
        let h = ((area.bottom - area.top).max(16) & !1) as u32;
        let area = Rect { left: area.left, top: area.top, right: area.left + w as i32, bottom: area.top + h as i32 };
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok().map_err(err)?;
            // MF_VERSION: the SDK version over the API version.
            if let Err(e) = MFStartup((MF_SDK_VERSION << 16) | MF_API_VERSION, MFSTARTUP_FULL) {
                CoUninitialize();
                return Err(err(e));
            }
        }
        let started = || -> windows::core::Result<(IMFSinkWriter, u32, Option<u32>)> {
            unsafe {
                let mut attrs: Option<IMFAttributes> = None;
                MFCreateAttributes(&mut attrs, 2)?;
                let attrs = attrs.ok_or_else(windows::core::Error::empty)?;
                attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)?;
                let writer = MFCreateSinkWriterFromURL(&HSTRING::from(path.as_os_str()), None, &attrs)?;

                let bitrate = ((w as u64 * h as u64 * fps as u64) / 10).clamp(2_000_000, 40_000_000) as u32;
                let out = MFCreateMediaType()?;
                out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
                out.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
                out.SetUINT32(&MF_MT_AVG_BITRATE, bitrate)?;
                out.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
                out.SetUINT64(&MF_MT_FRAME_SIZE, pack(w, h))?;
                out.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))?;
                out.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
                let video = writer.AddStream(&out)?;
                let inp = MFCreateMediaType()?;
                inp.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
                inp.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)?;
                inp.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
                inp.SetUINT64(&MF_MT_FRAME_SIZE, pack(w, h))?;
                inp.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))?;
                inp.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
                // A positive stride: rows top-down, as the bitmap has them (else it plays upside down).
                inp.SetUINT32(&MF_MT_DEFAULT_STRIDE, w * 4)?;
                writer.SetInputMediaType(video, &inp, None)?;

                let mut sound = None;
                if audio {
                    let out = MFCreateMediaType()?;
                    out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
                    out.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)?;
                    out.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
                    out.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, RATE)?;
                    out.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 1)?;
                    // 128 kbit/s: one of the four rates the AAC encoder takes.
                    out.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 16_000)?;
                    let stream = writer.AddStream(&out)?;
                    let inp = MFCreateMediaType()?;
                    inp.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
                    inp.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)?;
                    inp.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
                    inp.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, RATE)?;
                    inp.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 1)?;
                    inp.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 2)?;
                    inp.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, RATE * 2)?;
                    writer.SetInputMediaType(stream, &inp, None)?;
                    sound = Some(stream);
                }
                writer.BeginWriting()?;
                Ok((writer, video, sound))
            }
        }();
        let (writer, video, sound) = match started {
            Ok(v) => v,
            Err(e) => {
                unsafe {
                    let _ = MFShutdown();
                    CoUninitialize();
                }
                return Err(err(e));
            }
        };
        let Some(grab) = Grab::new(area) else {
            drop(writer);
            unsafe {
                let _ = MFShutdown();
                CoUninitialize();
            }
            return Err("Couldn't read the screen".into());
        };
        Ok(Recorder { writer: Some(writer), video, audio: sound, grab, clicks, frame_len: 10_000_000 / fps as i64, samples: 0, started: true })
    }

    fn write(&self, stream: u32, bytes: &[u8], at: i64, len: i64) -> windows::core::Result<()> {
        let Some(writer) = &self.writer else { return Ok(()) };
        unsafe {
            let buf = MFCreateMemoryBuffer(bytes.len() as u32)?;
            let mut p = std::ptr::null_mut();
            buf.Lock(&mut p, None, None)?;
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
            buf.Unlock()?;
            buf.SetCurrentLength(bytes.len() as u32)?;
            let sample = MFCreateSample()?;
            sample.AddBuffer(&buf)?;
            sample.SetSampleTime(at)?;
            sample.SetSampleDuration(len)?;
            writer.WriteSample(stream, &sample)
        }
    }

    /// Takes a frame now, shown at `at` (100 ns units from the start, pauses left out).
    pub fn frame(&mut self, at: i64) -> Result<(), String> {
        let clicks = self.clicks;
        let len = self.frame_len;
        let rows = self.grab.take(clicks).to_vec();
        self.write(self.video, &rows, at, len).map_err(err)?;
        // No sound for a while (the mic went quiet): tell the writer, so it doesn't hold the
        // video back waiting for it.
        if let (Some(stream), Some(writer)) = (self.audio, &self.writer) {
            let heard = (self.samples as i64) * 10_000_000 / RATE as i64;
            if at - heard > 5_000_000 {
                unsafe {
                    let _ = writer.SendStreamTick(stream, at);
                }
            }
        }
        Ok(())
    }

    /// Adds sound (16-bit mono PCM at 48 kHz, little-endian), right after the last.
    pub fn audio(&mut self, pcm: &[u8]) -> Result<(), String> {
        let Some(stream) = self.audio else { return Ok(()) };
        let n = (pcm.len() / 2) as u64;
        if n == 0 {
            return Ok(());
        }
        let at = (self.samples as i64) * 10_000_000 / RATE as i64;
        let len = (n as i64) * 10_000_000 / RATE as i64;
        self.write(stream, &pcm[..(n * 2) as usize], at, len).map_err(err)?;
        self.samples += n;
        Ok(())
    }

    /// Finishes the file (an MP4 that's never finished has no index and doesn't play).
    pub fn finish(mut self) -> Result<(), String> {
        let writer = self.writer.take();
        let done = match &writer {
            Some(w) => unsafe { w.Finalize() }.map_err(err),
            None => Ok(()),
        };
        drop(writer);
        done
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        // Let go of the writer before Media Foundation and COM go away.
        self.writer = None;
        if self.started {
            unsafe {
                let _ = MFShutdown();
                CoUninitialize();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Media::MediaFoundation::{MFCreateSourceReaderFromURL, MF_SOURCE_READER_FIRST_VIDEO_STREAM};

    /// The first frame of an MP4, decoded by Windows (RGBA, top-down, 320x240).
    fn first_frame(path: &Path) -> Vec<u8> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap();
            MFStartup((MF_SDK_VERSION << 16) | MF_API_VERSION, MFSTARTUP_FULL).unwrap();
            let out;
            {
                let mut attrs: Option<IMFAttributes> = None;
                MFCreateAttributes(&mut attrs, 1).unwrap();
                let attrs = attrs.unwrap();
                attrs.SetUINT32(&MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, 1).unwrap();
                let reader = MFCreateSourceReaderFromURL(&HSTRING::from(path.as_os_str()), &attrs).unwrap();
                let stream = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
                let want = MFCreateMediaType().unwrap();
                want.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).unwrap();
                want.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32).unwrap();
                reader.SetCurrentMediaType(stream, None, &want).unwrap();
                let (mut sample, mut flags, mut at) = (None, 0u32, 0i64);
                reader.ReadSample(stream, 0, None, Some(&mut flags), Some(&mut at), Some(&mut sample)).unwrap();
                let buf = sample.unwrap().ConvertToContiguousBuffer().unwrap();
                // The decoder says which way its rows go (a negative stride: bottom-up).
                let pitch = reader.GetCurrentMediaType(stream).unwrap().GetUINT32(&MF_MT_DEFAULT_STRIDE).expect("stride") as i32;
                let mut p = std::ptr::null_mut();
                buf.Lock(&mut p, None, None).unwrap();
                if pitch < 0 {
                    p = p.offset((-pitch as isize) * 239);
                }
                let mut px = Vec::with_capacity(320 * 240 * 4);
                for y in 0..240isize {
                    let row = std::slice::from_raw_parts(p.offset(y * pitch as isize), 320 * 4);
                    px.extend(row.chunks(4).flat_map(|c| [c[2], c[1], c[0], 255]));
                }
                buf.Unlock().unwrap();
                out = px;
            }
            let _ = MFShutdown();
            CoUninitialize();
            out
        }
    }

    /// Records about a second of the top-left of the screen and reads the file back.
    #[test]
    fn records_a_playable_mp4() {
        let path = std::env::temp_dir().join(format!("quicky-rec-test-{}.mp4", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let area = Rect { left: 0, top: 0, right: 321, bottom: 241 };
        // A PC (or CI runner) without Media Foundation's encoders can't record: nothing to test.
        let mut rec = match Recorder::start(area, &path, true, true, 30) {
            Ok(r) => r,
            Err(e) => return eprintln!("skipped: {e}"),
        };
        for i in 0..30 {
            rec.frame(i * 333_333).expect("frame");
            rec.audio(&vec![0u8; 3200]).expect("audio");
        }
        rec.finish().expect("finish");
        assert!(std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > 1000, "the file has something in it");
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap();
            MFStartup((MF_SDK_VERSION << 16) | MF_API_VERSION, MFSTARTUP_FULL).unwrap();
            {
                let reader = MFCreateSourceReaderFromURL(&HSTRING::from(path.as_os_str()), None).expect("open");
                let stream = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
                let kind = reader.GetCurrentMediaType(stream).expect("video track");
                // Trimmed to even sizes.
                assert_eq!(kind.GetUINT64(&MF_MT_FRAME_SIZE).unwrap(), pack(320, 240));
                let mut frames = 0;
                let mut last = 0i64;
                loop {
                    let (mut flags, mut at) = (0u32, 0i64);
                    let mut sample = None;
                    reader.ReadSample(stream, 0, None, Some(&mut flags), Some(&mut at), Some(&mut sample)).expect("read");
                    if sample.is_none() || flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                        break;
                    }
                    frames += 1;
                    last = at;
                }
                assert!(frames >= 25, "{frames} frames");
                assert!(last > 8_000_000, "about a second long ({last})");
            }
            let _ = MFShutdown();
            CoUninitialize();
        }
        // The picture is the right way up: the decoded frame's rows match the screen's rows
        // better than they match them upside down.
        let Some(screen) = crate::win::capture(0, 0, 320, 240) else { return };
        let decoded = first_frame(&path);
        let rows = |px: &[u8], flip: bool| -> Vec<f64> {
            (0..240)
                .map(|y| {
                    let y = if flip { 239 - y } else { y };
                    px[y * 320 * 4..][..320 * 4].iter().map(|&v| v as f64).sum::<f64>() / (320.0 * 4.0)
                })
                .collect()
        };
        let diff = |a: &[f64], b: &[f64]| a.iter().zip(b).map(|(x, y)| (x - y).abs()).sum::<f64>();
        let (shown, frame) = (rows(&screen, false), rows(&decoded, false));
        let (right, flipped) = (diff(&shown, &frame), diff(&shown, &rows(&decoded, true)));
        println!("rows differ by {right:.0} the right way up, {flipped:.0} upside down");
        // Only telling when the screen's top and bottom differ (a plain desktop looks the same
        // both ways up).
        if diff(&shown, &rows(&screen, true)) > 200.0 {
            assert!(right < flipped, "upside down? {right} vs {flipped}");
        }
        // QUICKY_KEEP_RECORDING=1 keeps the file to look at.
        if std::env::var_os("QUICKY_KEEP_RECORDING").is_none() {
            let _ = std::fs::remove_file(&path);
        } else {
            println!("kept {}", path.display());
        }
    }
}
