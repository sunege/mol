/**
 * An `IconButton` with a "…" that drops a short list of actions under it
 * (V5-8, the records column).
 *
 * It is for the actions that must not sit in a row of their own - one that
 * destroys everything, or one that only makes sense for one molecule - so a row
 * of buttons does not grow and shrink with them. The list closes when an item is
 * chosen, on Escape, and on a press anywhere else.
 */
import { useEffect, useRef, useState } from 'react';
import { IconButton } from './controls';
import { MoreIcon } from './icons';

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
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <span className="more-menu" ref={root}>
      <IconButton label={label} active={open} expanded={open} onClick={() => setOpen(!open)}>
        <MoreIcon />
      </IconButton>
      {open && (
        <div className="menu" role="menu" aria-label={label}>
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
