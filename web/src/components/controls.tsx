/**
 * The four kinds of button the panel is built from (v5, `docs/v5/README.md`).
 *
 * Every row used to be a wrapping flex row of content-width buttons, so a
 * longer label - an element's name in 削除（O）, a sixth preset - pushed a
 * button onto a second line and moved everything under it. Each of these
 * decides its columns first, as a CSS grid, and a label that is too long is cut
 * with an ellipsis inside its own cell instead of reflowing the row.
 *
 * - `Segmented`: one of a few, in equal halves or thirds, never wrapping.
 * - `Choices`: one of a few, stacked, each with an optional line saying what
 *   it is.
 * - `ActionGrid`: a fixed number of columns of ordinary buttons.
 * - `IconButton`: a square in a row, named for the screen reader and the
 *   pointer alike.
 *
 * All four are stateless: the caller owns what is chosen. A button that
 * cannot be used right now is disabled rather than hidden, so nothing around
 * it moves when it comes back.
 *
 * The look is one class, `.btn` (`App.css`), with `.small` for a denser row
 * and `.active` for the chosen one. A button in any of them that hands atoms to
 * the engine - a DFT calculation, which takes seconds to minutes - is a
 * `RunButton` (`.btn.run`, green with a ▶) wherever it sits, so what will set
 * the engine going reads at a glance; nothing else is drawn that way.
 */
import type { ReactNode } from 'react';
import { RunIcon } from './icons';

function classes(...names: (string | false | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Shown on hover, for when the label alone is terse. */
  title?: string;
  /** This one choice cannot be made right now; the rest of the row still can. */
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> {
  /** Names the group for a screen reader. */
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  small?: boolean;
}

/** One of a few, side by side in equal widths. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
  small,
}: SegmentedProps<T>) {
  return (
    <div
      className="seg"
      role="group"
      aria-label={label}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={classes('btn', small && 'small', option.value === value && 'active')}
          aria-pressed={option.value === value}
          title={option.title}
          disabled={disabled || option.disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  /** One line under the label saying what choosing it shows. */
  description?: string;
}

export interface ChoicesProps<T extends string> {
  label: string;
  options: readonly ChoiceOption<T>[];
  /** `null` when none of them is the one on screen. */
  value: T | null;
  onChange: (value: T) => void;
  disabled?: boolean;
}

/** One of a few, stacked, each with room to say what it is. */
export function Choices<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
}: ChoicesProps<T>) {
  return (
    <div className="choices" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          className={classes('btn', 'choice', option.value === value && 'active')}
          aria-checked={option.value === value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          <span className="choice-label">{option.label}</span>
          {option.description && (
            <span className="choice-description">{option.description}</span>
          )}
        </button>
      ))}
    </div>
  );
}

export interface ActionGridProps {
  columns: 1 | 2 | 3 | 5;
  /** Names the group for a screen reader, when the heading above does not. */
  label?: string;
  /** Plain `<button className="btn">`s, one per cell. */
  children: ReactNode;
}

/** Buttons in a fixed number of columns, one line each. */
export function ActionGrid({ columns, label, children }: ActionGridProps) {
  return (
    <div
      className={`action-grid cols-${columns}`}
      role={label ? 'group' : undefined}
      aria-label={label}
    >
      {children}
    </div>
  );
}

export interface IconButtonProps {
  /**
   * What the button does, read out and shown on hover. Required: the icon
   * alone says nothing to a screen reader.
   */
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  /** For a button that opens and closes something: whether it is open now. */
  expanded?: boolean;
  /** An icon from `icons.tsx`. */
  children: ReactNode;
}

/** A 26px square button in a row, holding one icon. */
export function IconButton({
  label,
  onClick,
  disabled,
  active,
  expanded,
  children,
}: IconButtonProps) {
  return (
    <button
      type="button"
      className={classes('icon-btn', active && 'active')}
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export interface RunButtonProps {
  onClick: () => void;
  disabled?: boolean;
  /** The words after the ▶. */
  children: ReactNode;
}

/** A `.btn` that starts a DFT calculation: green, with a ▶ before its label. */
export function RunButton({ onClick, disabled, children }: RunButtonProps) {
  return (
    <button type="button" className="btn run" disabled={disabled} onClick={onClick}>
      <RunIcon />
      {children}
    </button>
  );
}
