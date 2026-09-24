/**
 * The panel's icons, drawn inline.
 *
 * The page is cross-origin isolated (COOP + COEP, `vercel.json`), so an icon
 * font or a CDN sprite would simply not load. Each icon is a 16×16 viewBox
 * stroked in `currentColor`, which lets the button around it decide the colour
 * - a disabled button's opacity dims the icon with it.
 *
 * They carry no text of their own: the button that holds one names it with
 * `aria-label` and `title` (`IconButton` in `controls.tsx` insists on both).
 */
import type { ReactNode } from 'react';

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="icon"
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Frame the whole molecule: four corners closing in. */
export function FrameIcon() {
  return (
    <Icon>
      <path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5" />
    </Icon>
  );
}

/** Replay a record's path. */
export function PlayIcon() {
  return (
    <Icon>
      <path d="M5 3.5v9l7-4.5z" />
    </Icon>
  );
}

/**
 * On every button that starts a DFT calculation (`RunButton`): filled, unlike
 * the others, so it reads as the mark of that kind of button rather than as one
 * more thing to press. Sized to the label beside it.
 */
export function RunIcon() {
  return (
    <svg
      className="run-icon"
      width={10}
      height={10}
      viewBox="0 0 10 10"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M1.5 0.8v8.4L9 5z" />
    </svg>
  );
}

/** Rename a record. */
export function RenameIcon() {
  return (
    <Icon>
      <path d="M10.5 2.5l3 3L6 13H3v-3z" />
    </Icon>
  );
}

/** Delete a record. */
export function DeleteIcon() {
  return (
    <Icon>
      <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.75 9.5h6.5L12 4M6.75 6.5v4.5M9.25 6.5v4.5" />
    </Icon>
  );
}

/** Stop something that is running. */
export function StopIcon() {
  return (
    <Icon>
      <rect x={4} y={4} width={8} height={8} rx={1} />
    </Icon>
  );
}

/** More actions, behind a menu. */
export function MoreIcon() {
  return (
    <Icon>
      <circle cx={3.5} cy={8} r={0.6} />
      <circle cx={8} cy={8} r={0.6} />
      <circle cx={12.5} cy={8} r={0.6} />
    </Icon>
  );
}

/**
 * Fold or unfold a branch: pointing right while it is closed, down while it
 * is open. Both are centred on the same point, so the row does not shift.
 */
export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <Icon>
      <path d={open ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'} />
    </Icon>
  );
}
