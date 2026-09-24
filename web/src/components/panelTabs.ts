/**
 * Which tabs the panel has, and which of them is chosen (V5-10).
 *
 * The two wide-screen tabs are the viewer's mode and nothing else (V5-3). A
 * narrow screen has no room for the records column, so its panel - a sheet
 * from the bottom - gets a third tab, 記録, that shows the records in place of
 * the tab's body. That one is not a mode: choosing it leaves the mode as it
 * was (a click in the view still does what it did), so it is the one piece of
 * tab state the App keeps on its own, a single `narrowRecords` flag.
 */
import type { ViewerMode } from '../scene/gestures';

export type PanelTab = ViewerMode | 'records';

export interface PanelTabSpec {
  tab: PanelTab;
  label: string;
  /** What the tab is for: for a mode, what a click in the view does in it. */
  subtitle: string;
}

const MODE_TABS: readonly PanelTabSpec[] = [
  { tab: 'edit', label: '計算', subtitle: 'クリックで原子を置く' },
  { tab: 'observe', label: '観察', subtitle: 'クリックで原子を測る' },
];

const RECORDS_TAB: PanelTabSpec = { tab: 'records', label: '記録', subtitle: '見つけた形を開く' };

const NARROW_TABS: readonly PanelTabSpec[] = [...MODE_TABS, RECORDS_TAB];

/** The tabs in order; the records tab only where the records column is not. */
export function panelTabs(narrow: boolean): readonly PanelTabSpec[] {
  return narrow ? NARROW_TABS : MODE_TABS;
}

/** The chosen tab: the records while they are asked for, else the mode. */
export function chosenTab(mode: ViewerMode, records: boolean): PanelTab {
  return records ? 'records' : mode;
}
