import { describe, expect, it } from 'vitest';
import {
  EMPTY_MEMORY,
  ancestorsOf,
  expandedIds,
  openAncestors,
  parseExplorerMemory,
  serializeExplorerMemory,
  withChoice,
} from './explorer';
import { buildRecordTree } from '../records/tree';
import { groupRecords } from '../records/log';
import { fakeRecord } from '../records/fixtures';
import { HARTREE_TO_KJ_PER_MOL } from '../records/units';

const BOTTOM = -75.0;
const at = (kj: number, id: string, minute: number) =>
  fakeRecord({
    energy: BOTTOM + kj / HARTREE_TO_KJ_PER_MOL,
    id,
    savedAt: new Date(Date.UTC(2026, 8, 20, 9, minute)).toISOString(),
  });

// Water: a valley of three (a oldest, b deepest) and one shape 20 kJ/mol up;
// ammonia: one record.
const tree = buildRecordTree(
  groupRecords([
    at(0.3, 'a', 1),
    at(0, 'b', 2),
    at(0.2, 'c', 3),
    at(20, 'd', 4),
    fakeRecord({ energy: -56, z: [7, 1, 1, 1], id: 'n', savedAt: '2026-09-20T09:05:00.000Z' }),
  ]),
);
const water = tree.find((molecule) => molecule.formula === 'H₂O')!;
const ammonia = tree.find((molecule) => molecule !== water)!;
const [shape] = water.children;
const valley = shape.children[0];
if (valley.kind !== 'valley') throw new Error('expected a valley');

describe('what the column remembers', () => {
  it('reads back what it wrote', () => {
    const folded = { ...EMPTY_MEMORY, collapsed: true };
    const memory = withChoice(withChoice(folded, 'f:H₂O', false), 'x', true);
    const back = parseExplorerMemory(serializeExplorerMemory(memory));
    expect(back.collapsed).toBe(true);
    expect([...back.choices]).toEqual([
      ['x', true],
      ['f:H₂O', false],
    ]);
  });

  it('is the defaults when there is nothing, or nothing it understands', () => {
    for (const text of [null, '', '{', 'null', '3', '{"collapsed":"yes","open":"f:H₂O"}']) {
      const memory = parseExplorerMemory(text);
      expect(memory.collapsed).toBe(false);
      expect(memory.choices.size).toBe(0);
    }
  });
});

describe('which branches are open', () => {
  const context = { currentFormula: 'H₂O', openId: null };

  it('follows the defaults where the user chose nothing', () => {
    expect(expandedIds(tree, new Map(), context)).toEqual(new Set([water.id, shape.id]));
  });

  it('follows the user where they chose', () => {
    const choices = new Map([
      [water.id, false],
      [valley.id, true],
      [ammonia.id, true],
    ]);
    expect(expandedIds(tree, choices, context)).toEqual(
      new Set([shape.id, valley.id, ammonia.id]),
    );
  });
});

describe('the record on screen', () => {
  it('has its molecule, level and folding valley above it', () => {
    expect(ancestorsOf(tree, 'a')).toEqual([water.id, shape.id, valley.id]);
    // The deepest heads the valley: the valley's row is its own.
    expect(ancestorsOf(tree, 'b')).toEqual([water.id, shape.id]);
    expect(ancestorsOf(tree, 'n')).toEqual([ammonia.id, ammonia.children[0].id]);
    expect(ancestorsOf(tree, 'gone')).toEqual([]);
  });

  it('opens what the user had closed above it, and can be closed again', () => {
    const closed = withChoice(withChoice(EMPTY_MEMORY, water.id, false), valley.id, false);
    const opened = openAncestors(closed, tree, 'c');
    const context = { currentFormula: null, openId: 'c' };
    expect(expandedIds(tree, opened.choices, context)).toEqual(
      new Set([water.id, shape.id, valley.id]),
    );
    const again = withChoice(opened, valley.id, false);
    expect(expandedIds(tree, again.choices, context).has(valley.id)).toBe(false);
  });

  it('leaves the memory alone when everything above it is already open', () => {
    const opened = openAncestors(EMPTY_MEMORY, tree, 'n');
    expect(openAncestors(opened, tree, 'n')).toBe(opened);
  });
});
