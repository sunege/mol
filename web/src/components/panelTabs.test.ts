import { describe, expect, it } from 'vitest';
import { chosenTab, panelTabs } from './panelTabs';

describe('the panel tabs', () => {
  it('are the two modes on a wide screen', () => {
    expect(panelTabs(false).map((spec) => spec.tab)).toEqual(['edit', 'observe']);
  });

  it('add the records last on a narrow screen', () => {
    expect(panelTabs(true).map((spec) => spec.tab)).toEqual(['edit', 'observe', 'records']);
    expect(panelTabs(true).map((spec) => spec.label)).toEqual(['計算', '観察', '記録']);
  });

  it('keep the mode tabs the same on either screen', () => {
    expect(panelTabs(true).slice(0, 2)).toEqual(panelTabs(false));
  });

  it('choose the mode unless the records are asked for', () => {
    expect(chosenTab('edit', false)).toBe('edit');
    expect(chosenTab('observe', false)).toBe('observe');
    expect(chosenTab('edit', true)).toBe('records');
    expect(chosenTab('observe', true)).toBe('records');
  });
});
