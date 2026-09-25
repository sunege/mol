/**
 * An `IconButton` with a "…" that drops a short list of actions under it
 * (V5-8, the records column).
 *
 * It is for the actions that must not sit in a row of their own - one that
 * destroys everything, or one that only makes sense for one molecule - so a row
 * of buttons does not grow and shrink with them. The list closes when an item is
 * chosen, on Escape, and on a press anywhere else.
 *
 * The list is `position: fixed`, placed by `placeMenu` (V6-11): under its
 * button it was clipped by the records tree's scrolling box. Being fixed, it
 * would not follow a scroll, so a scroll anywhere or a resize closes it.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { IconButton } from './controls';
import { MoreIcon } from './icons';
import { placeMenu } from './menuPlacement';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

interface Props {
  /** Names the button, as `IconButton` does. */
  label: string;
  items: readonly MenuItem[];
  /** A line of text under the items, for what the button's place has no room for. */
  note?: string;
}

export function MoreMenu({ label, items, note }: Props) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const root = useRef<HTMLSpanElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // Measured before paint, so the list never shows at the wrong place first.
  useLayoutEffect(() => {
    if (!open) return;
    const button = root.current?.getBoundingClientRect();
    const menu = list.current?.getBoundingClientRect();
    if (!button || !menu) return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    setPlace(placeMenu(button, menu, viewport));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape);
    document.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', escape);
      document.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  // A list opened again is placed again, hidden until then.
  const toggle = () => {
    if (!open) setPlace(null);
    setOpen(!open);
  };

  return (
    <span className="more-menu" ref={root}>
      <IconButton label={label} active={open} expanded={open} onClick={toggle}>
        <MoreIcon />
      </IconButton>
      {open && (
        <div
          className="menu"
          role="menu"
          aria-label={label}
          ref={list}
          style={place ?? { visibility: 'hidden' }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="menu-item"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
          {note && <p className="menu-note">{note}</p>}
        </div>
      )}
    </span>
  );
}
