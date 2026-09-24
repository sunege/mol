/**
 * A section of the panel that is closed until asked for (v5, V5-5).
 *
 * A `<details>` whose `<summary>` holds the section's one heading (V4-4: a
 * summary with two headings is read out as two sections) and, only while it is
 * closed, one line saying what is behind it. The line sits to the right of the
 * heading rather than under it, so opening and closing moves nothing below by
 * more than the section's own contents; once the section is open its own words
 * take over and the line would only repeat them.
 *
 * Controlled when `open` is given - the orbital section's is the App's, since
 * whether it is open decides what the worker is asked for - and otherwise it
 * keeps its own state, closed to begin with.
 */
import { useState, type ReactNode } from 'react';

interface Props {
  heading: string;
  /** What is inside, in a few words: shown beside the heading while closed. */
  teaser: string;
  /** Added to `fold`, for what the contents look like. */
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}

export function Fold({ heading, teaser, className, open, onOpenChange, children }: Props) {
  const [own, setOwn] = useState(false);
  const isOpen = open ?? own;
  return (
    <details
      className={className ? `fold ${className}` : 'fold'}
      open={isOpen}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        // React fires this for the attribute it set as well as for a click, so
        // only a change is passed on.
        if (next === isOpen) return;
        if (open === undefined) setOwn(next);
        onOpenChange?.(next);
      }}
    >
      <summary>
        <h2>{heading}</h2>
        {!isOpen && <span className="fold-teaser">{teaser}</span>}
      </summary>
      {children}
    </details>
  );
}
