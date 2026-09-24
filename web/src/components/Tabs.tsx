/**
 * The strip of two tabs between the panel's head and its body (V5-3).
 *
 * The tabs are the viewer's mode and nothing else: 計算 is `'edit'` and 観察
 * is `'observe'`, so what a click in the view does and the tools the panel
 * shows can never disagree. There is no state of its own here - the chosen
 * tab is `mode`, and pressing one is the same `chooseMode` the old switch
 * called, so a calculation moving the panel to 観察 (and back after a
 * divergence, an error or a stop) goes on working unchanged.
 *
 * Each tab says under its name what a click in the view does in it, since
 * that is the difference between the two that cannot be seen on the panel.
 *
 * On a narrow screen a third tab, 記録, takes the place of the records column
 * (V5-10, `panelTabs.ts`). It is not a mode: choosing it leaves `mode` alone,
 * and choosing a mode tab leaves it.
 */
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { ViewerMode } from '../scene/gestures';
import { chosenTab, panelTabs, type PanelTab } from './panelTabs';

/** The tab panel's id for a tab, for `aria-controls` / `aria-labelledby`. */
function tabPanelId(tab: PanelTab): string {
  return `tabpanel-${tab}`;
}

/** The tab's own id. */
function tabId(tab: PanelTab): string {
  return `tab-${tab}`;
}

export interface TabsProps {
  mode: ViewerMode;
  onChoose: (next: ViewerMode) => void;
  /** The narrow screen's records tab; absent where the records column is. */
  records?: {
    chosen: boolean;
    onChoose: () => void;
    /** A search candidate is going, so the tab turns the same spinner. */
    busy: boolean;
    busyLabel: string;
  };
}

export function Tabs({ mode, onChoose, records }: TabsProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const tabs = panelTabs(records !== undefined);
  const chosen = chosenTab(mode, records?.chosen ?? false);

  const choose = (tab: PanelTab) => {
    if (tab === 'records') records?.onChoose();
    else onChoose(tab);
  };

  // ← and → step to the neighbour, wrapping. Only the chosen tab is in the
  // tab order (the usual roving tabindex of a tablist).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const at = tabs.findIndex((spec) => spec.tab === chosen);
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = (at + step + tabs.length) % tabs.length;
    choose(tabs[next].tab);
    refs.current[next]?.focus();
  };

  return (
    <div
      className="tabs"
      role="tablist"
      aria-label="パネル"
      style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
      onKeyDown={onKeyDown}
    >
      {tabs.map((spec, index) => {
        const isChosen = spec.tab === chosen;
        return (
          <button
            key={spec.tab}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={tabId(spec.tab)}
            aria-selected={isChosen}
            aria-controls={tabPanelId(spec.tab)}
            tabIndex={isChosen ? 0 : -1}
            className={isChosen ? 'tab active' : 'tab'}
            onClick={() => choose(spec.tab)}
          >
            <span className="tab-label">
              {spec.label}
              {spec.tab === 'records' && records?.busy && (
                <span className="spinner" role="img" aria-label={records.busyLabel} />
              )}
            </span>
            <span className="tab-subtitle">{spec.subtitle}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The body of the chosen tab. Only the chosen one is rendered. */
export function TabPanel({ tab, children }: { tab: PanelTab; children: ReactNode }) {
  return (
    <div role="tabpanel" id={tabPanelId(tab)} aria-labelledby={tabId(tab)}>
      {children}
    </div>
  );
}
