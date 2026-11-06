// An extension window's badge for its taskbar and window icon: Rust paints Quicky's blob in the
// accent and this badge over its bottom-right corner (`icons::extension_icon`). The badge is the
// catalogue's picture for the extension when it has one, a drawing of its own for the extensions
// Quicky knows (a board for Projects, a calendar for Calendar), or else its first letter.
import { invoke } from "@tauri-apps/api/core";
import type { Installed } from "./cloud";

/** The icon's size (`icons::ICON` in Rust, the same as the window icon layers). */
const ICON = 64;
const INK = "#2b2540";
/** The badge: a rounded square in the bottom-right corner. */
const B = { x: 29, y: 29, size: 33, r: 10 };

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
}

/** Line drawings on a 24-unit grid, centred in the badge. */
const GLYPHS: Record<string, (c: CanvasRenderingContext2D) => void> = {
  // Three columns of cards.
  project: (c) => {
    c.fillStyle = INK;
    for (const [x, ys] of [[3.5, [4, 11]], [10, [4, 10.5, 16.5]], [16.5, [4]]] as [number, number[]][]) {
      for (const y of ys) {
        roundRect(c, x, y, 5, 5, 1.4);
        c.fill();
      }
    }
  },
  // A calendar page: binder rings, a header and a few days.
  calendar: (c) => {
    c.strokeStyle = c.fillStyle = INK;
    c.lineWidth = 2.4;
    c.lineCap = "round";
    roundRect(c, 3, 5, 18, 16, 3);
    c.stroke();
    c.fillRect(3, 5, 18, 5);
    c.beginPath();
    c.moveTo(8, 2.5);
    c.lineTo(8, 6.5);
    c.moveTo(16, 2.5);
    c.lineTo(16, 6.5);
    c.stroke();
    for (const [x, y] of [[7.5, 13.5], [12, 13.5], [16.5, 13.5], [7.5, 17.5], [12, 17.5]]) {
      c.beginPath();
      c.arc(x, y, 1.3, 0, Math.PI * 2);
      c.fill();
    }
  },
};

function loadImage(src: string) {
  return new Promise<HTMLImageElement | null>((done) => {
    const img = new Image();
    img.onload = () => done(img);
    img.onerror = () => done(null);
    img.src = src;
  });
}

/** Draws the badge and hands it to Rust for this window's icon. */
export async function sendExtensionIcon(ext: Pick<Installed, "id" | "name" | "icon">) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = ICON;
  const c = canvas.getContext("2d")!;
  // The plate: white with the blob's ink outline, so it reads on any accent and taskbar.
  roundRect(c, B.x, B.y, B.size, B.size, B.r);
  c.fillStyle = "#fff";
  c.fill();
  c.lineWidth = 3;
  c.strokeStyle = INK;
  c.stroke();
  const inner = { x: B.x + 4.5, y: B.y + 4.5, size: B.size - 9 };
  const picture = ext.icon ? await loadImage(ext.icon) : null;
  if (picture) {
    c.save();
    roundRect(c, inner.x, inner.y, inner.size, inner.size, B.r - 4);
    c.clip();
    c.drawImage(picture, inner.x, inner.y, inner.size, inner.size);
    c.restore();
  } else if (GLYPHS[ext.id]) {
    c.save();
    c.translate(inner.x, inner.y);
    c.scale(inner.size / 24, inner.size / 24);
    GLYPHS[ext.id](c);
    c.restore();
  } else {
    await document.fonts.load('700 22px "Fredoka"').catch(() => {});
    c.fillStyle = INK;
    c.font = '700 22px "Fredoka", "Segoe UI", sans-serif';
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText((ext.name.trim()[0] ?? ext.id[0]).toUpperCase(), B.x + B.size / 2, B.y + B.size / 2 + 1);
  }
  const png = canvas.toDataURL("image/png").split(",")[1];
  await invoke("extension_icon", { png }).catch(() => {});
}
