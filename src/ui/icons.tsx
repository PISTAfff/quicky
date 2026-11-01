import type { JSX } from "solid-js";

type P = { size?: number; class?: string };

const Svg = (p: P & { children: JSX.Element; fill?: boolean; sw?: number }) => (
  <svg
    width={p.size ?? 16}
    height={p.size ?? 16}
    viewBox="0 0 24 24"
    fill={p.fill ? "currentColor" : "none"}
    stroke={p.fill ? "none" : "currentColor"}
    stroke-width={p.sw ?? 2.3}
    stroke-linecap="round"
    stroke-linejoin="round"
    class={p.class}
    aria-hidden="true"
  >
    {p.children}
  </svg>
);

export const IPlus = (p: P) => <Svg {...p} sw={3}><path d="M12 5v14M5 12h14" /></Svg>;
export const IClose = (p: P) => <Svg {...p}><path d="M6 6l12 12M18 6L6 18" /></Svg>;
export const IMin = (p: P) => <Svg {...p}><path d="M5 12h14" /></Svg>;
export const IPin = (p: P) => <Svg {...p}><path d="M12 17v5" /><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z" /></Svg>;
export const IClip = (p: P) => (
  <Svg {...p}><path d="M21 11l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.3 3.3 0 0 1 4.7 4.7L10 17.3a1.7 1.7 0 0 1-2.3-2.3L15.5 7" /></Svg>
);
export const IMic = (p: P) => <Svg {...p}><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v4" /></Svg>;
export const IRepeat = (p: P) => (
  <Svg {...p}><path d="M17 2l4 4-4 4" /><path d="M3 11V9a3 3 0 0 1 3-3h15" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v2a3 3 0 0 1-3 3H3" /></Svg>
);
export const IImage = (p: P) => <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="2" /><path d="M21 16l-5-5-9 9" /></Svg>;
export const IPlay = (p: P) => <Svg {...p} fill><path d="M8 5v14l11-7z" /></Svg>;
export const IPause = (p: P) => <Svg {...p} fill><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></Svg>;
export const IFile = (p: P) => <Svg {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></Svg>;
export const IUp = (p: P) => <Svg {...p}><path d="M6 15l6-6 6 6" /></Svg>;
export const IDown = (p: P) => <Svg {...p}><path d="M6 9l6 6 6-6" /></Svg>;
export const IRestore = (p: P) => <Svg {...p}><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></Svg>;
export const ITrash = (p: P) => <Svg {...p}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></Svg>;
export const IFolder = (p: P) => <Svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Svg>;
export const IArrow = (p: P) => <Svg {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Svg>;

/** The Quicky blob. `mood` "done" gives it happy closed eyes. */
export const Blob = (p: { size?: number; color?: string; mood?: "done" }) => {
  const s = p.size ?? 20;
  return (
    <svg width={s} height={s * 0.9} viewBox="0 0 40 36" aria-hidden="true">
      <path d="M20 1C31 1 39 9 39 20c0 9-6 15-19 15S1 29 1 20C1 9 9 1 20 1z" fill={p.color ?? "var(--accent)"} />
      {p.mood === "done" ? (
        <g fill="none" stroke="var(--ink)" stroke-width="2.6" stroke-linecap="round">
          <path d="M11 18q3-3 6 0M23 18q3-3 6 0" />
        </g>
      ) : (
        <g fill="#fff">
          <rect x="12" y="13" width="4" height="7" rx="2" />
          <rect x="24" y="13" width="4" height="7" rx="2" />
        </g>
      )}
    </svg>
  );
};
