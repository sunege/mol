import { describe, expect, it } from 'vitest';
import { tablePosition } from './PeriodicPicker';

describe('tablePosition', () => {
  it('puts hydrogen and helium at the ends of period 1', () => {
    expect(tablePosition(1)).toEqual({ row: 1, column: 1 });
    expect(tablePosition(2)).toEqual({ row: 1, column: 8 });
  });

  it('lays period 2 out from lithium to neon', () => {
    expect(tablePosition(3)).toEqual({ row: 2, column: 1 });
    expect(tablePosition(6)).toEqual({ row: 2, column: 4 });
    expect(tablePosition(10)).toEqual({ row: 2, column: 8 });
  });

  it('lays period 3 out from sodium to argon', () => {
    expect(tablePosition(11)).toEqual({ row: 3, column: 1 });
    expect(tablePosition(17)).toEqual({ row: 3, column: 7 });
    expect(tablePosition(18)).toEqual({ row: 3, column: 8 });
  });

  it('keeps elements of the same group in the same column', () => {
    // Noble gases, then halogens.
    expect(tablePosition(2).column).toBe(tablePosition(10).column);
    expect(tablePosition(10).column).toBe(tablePosition(18).column);
    expect(tablePosition(9).column).toBe(tablePosition(17).column);
    // Alkali and alkaline earth metals.
    expect(tablePosition(3).column).toBe(tablePosition(11).column);
    expect(tablePosition(4).column).toBe(tablePosition(12).column);
  });

  it('gives every supported element a distinct cell', () => {
    const cells = new Set<string>();
    for (let z = 1; z <= 18; z++) {
      const { row, column } = tablePosition(z);
      expect(column).toBeGreaterThanOrEqual(1);
      expect(column).toBeLessThanOrEqual(8);
      cells.add(`${row}:${column}`);
    }
    expect(cells.size).toBe(18);
  });
});
