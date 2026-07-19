/* ---- SVG icons — hand-drawn line-art family -------------------------------- */
// Earned stamp: line-art bubble-tea cup with pearls, drawn inside the scallop
// seal so a collected stamp reads at a glance (empty slots stay blank).
export const CupArt = () => (
  <svg className="cp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6.5 8.5h11l-1.3 11a1.5 1.5 0 0 1-1.5 1.3H9.3a1.5 1.5 0 0 1-1.5-1.3l-1.3-11Z" />
    <path d="M10 8.5 12.8 3l2.7 1" />
    <circle cx="10" cy="16.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="14" cy="16.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="13.5" r="1" fill="currentColor" stroke="none" />
  </svg>
);
// Zig-zag seal edge for stamp slots — 24 teeth around a 64px viewBox.
const SCALLOP_POINTS = Array.from({ length: 48 }, (_, i) => {
  const a = (Math.PI * i) / 24;
  const r = i % 2 === 0 ? 29 : 25.5;
  return `${(32 + r * Math.cos(a)).toFixed(2)},${(32 + r * Math.sin(a)).toFixed(2)}`;
}).join(' ');
export const Scallop = ({ earned }) => (
  <svg className="cp-scallop" viewBox="0 0 64 64" aria-hidden="true">
    <polygon points={SCALLOP_POINTS} fill={earned ? 'rgba(61, 63, 33, 0.14)' : 'none'}
      stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
  </svg>
);
export const Sparkle = ({ className }) => (
  <svg className={`cp-deco ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
    <path d="M12 2.5v19M3.8 7.3l16.4 9.4M3.8 16.7l16.4-9.4" />
  </svg>
);
export const GiftIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="8" width="18" height="4" rx="1" />
    <path d="M12 8v13M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    <path d="M7.5 8a2.4 2.4 0 0 1 0-4.8C10 3.2 12 8 12 8s2-4.8 4.5-4.8a2.4 2.4 0 0 1 0 4.8" />
  </svg>
);
export const TicketIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 9V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a3 3 0 0 0 0 6v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a3 3 0 0 0 0-6Z" />
    <path d="M13 5v2m0 10v2m0-8v2" />
  </svg>
);
export const ReceiptIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 21V4a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v17l-2.5-1.5L14 21l-2-1.5L10 21l-2.5-1.5L5 21Z" />
    <path d="M9 7h6M9 11h6" />
  </svg>
);
export const StarIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m12 3 2.7 5.6 6.1.8-4.5 4.3 1.1 6-5.4-2.9-5.4 2.9 1.1-6L3.2 9.4l6.1-.8L12 3Z" />
  </svg>
);
export const GalleryIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <circle cx="8.5" cy="9.5" r="1.5" />
    <path d="m4 17 5-5 4 4 3-3 4 4" />
  </svg>
);
