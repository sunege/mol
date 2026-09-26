import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildRecordTree,
  defaultExpanded,
  type CandidateNode,
  type PendingCandidate,
  recordIdsUnder,
  type RecordTree,
  type ValleyNode,
} from './tree';
import { groupRecords } from './log';
import { fakeRecord, isSupportedElement, type FakeRelaxation } from './fixtures';
import { readStructureLog } from './file';
import { HARTREE_TO_KJ_PER_MOL } from './units';

const hartree = (kj: number) => kj / HARTREE_TO_KJ_PER_MOL;
const BOTTOM = -75.0;
const AMMONIA = [7, 1, 1, 1];

let clock = 0;
/** Water `kj` above the bottom, saved a minute after the one before. */
function at(kj: number, extra: Partial<FakeRelaxation> = {}) {
  clock += 1;
  return fakeRecord({
    energy: BOTTOM + hartree(kj),
    id: `r${clock}`,
    savedAt: new Date(Date.UTC(2026, 8, 20, 9, clock)).toISOString(),
    ...extra,
  });
}

const treeOf = (records: Parameters<typeof groupRecords>[0]) =>
  buildRecordTree(groupRecords(records));

/** Every id in the tree, in order, to compare two trees by. */
function ids(tree: RecordTree): string[] {
  return tree.flatMap((molecule) => [
    molecule.id,
    ...molecule.children.flatMap((level) => [level.id, ...level.children.map((c) => c.id)]),
  ]);
}

describe('the shape of the tree', () => {
  it('folds three records of one valley under the deepest', () => {
    const [a, b, c] = [at(0.4), at(0), at(0.2)];
    const [molecule] = treeOf([a, b, c]);
    expect(molecule.children).toHaveLength(1);
    const [valley] = molecule.children[0].children as ValleyNode[];
    expect(molecule.children[0].children).toHaveLength(1);
    expect(valley.kind).toBe('valley');
    expect(valley.head.record.id).toBe(b.id);
    expect(valley.rest.map((entry) => entry.record.id)).toEqual([c.id, a.id]);
  });

  it('lists two valleys of one record each as records, the deeper first', () => {
    const [high, low] = [at(30), at(0)];
    const [molecule] = treeOf([high, low]);
    const children = molecule.children[0].children;
    expect(children.map((child) => child.kind)).toEqual(['record', 'record']);
    expect(children.map((child) => child.id)).toEqual([`r:${low.id}`, `r:${high.id}`]);
  });

  it('puts the records that did not settle after the valleys', () => {
    const unfinished = at(-50, { reason: 'interrupted' });
    const [molecule] = treeOf([unfinished, at(0), at(0.1), at(20)]);
    const kinds = molecule.children[0].children.map((child) => child.kind);
    expect(kinds).toEqual(['valley', 'record', 'record']);
    expect(molecule.children[0].children[2].id).toBe(`r:${unfinished.id}`);
  });

  it('keeps one molecule with a level under it for each level, shape first', () => {
    const tree = treeOf([at(0, { level: 'measure' }), at(0)]);
    expect(tree).toHaveLength(1);
    expect(tree[0].count).toBe(2);
    expect(tree[0].children.map((level) => level.level)).toEqual(['shape', 'measure']);
  });

  it('puts a level it does not know last', () => {
    const odd = { ...at(0), model: 'sto-3g/lda-vwn5/medium' };
    const tree = treeOf([odd, at(0, { level: 'measure' }), at(0)]);
    expect(tree[0].children.map((level) => level.level)).toEqual(['shape', 'measure', null]);
  });

  it('keeps a node for a molecule that has one level only', () => {
    const [molecule] = treeOf([at(0)]);
    expect(molecule.kind).toBe('formula');
    expect(molecule.children.map((level) => level.kind)).toEqual(['level']);
  });

  it('puts an ion under a molecule of its own, called with its charge (v7)', () => {
    const tree = treeOf([at(0), at(0, { charge: 1 })]);
    expect(tree.map((molecule) => molecule.formula)).toEqual(['H₂O⁺', 'H₂O']);
    expect(tree[0].id).not.toBe(tree[1].id);
    expect(tree.map((molecule) => molecule.children.length)).toEqual([1, 1]);
  });

  it('gives groups that read the same a level node each', () => {
    // Two models this program never wrote: both of unknown level, one heading.
    const tree = treeOf([{ ...at(0), model: 'old/one' }, { ...at(0), model: 'old/two' }]);
    expect(tree).toHaveLength(1);
    const [one, two] = tree[0].children;
    expect(one.level).toBe(two.level);
    expect(one.id).not.toBe(two.id);
  });

  it('orders the molecules newest first by their oldest record', () => {
    const [water, ammonia] = [at(0), at(0, { z: AMMONIA })];
    expect(treeOf([water, ammonia]).map((m) => m.formula)).toEqual(['H₃N', 'H₂O']);
    // However the groups come: the order is the tree's own, not the App's.
    const groups = groupRecords([water, ammonia]);
    expect(buildRecordTree([...groups].reverse()).map((m) => m.formula)).toEqual(['H₃N', 'H₂O']);
  });

  it('does not move a molecule when a newer record of it is added (V6-1)', () => {
    const records = [at(0), at(0, { z: AMMONIA })];
    const before = treeOf(records).map((m) => m.formula);
    // Water now has the newest record and the newest group, at another level
    // too, so ordering by the groups' `latest` would put it first.
    const more = [...records, at(5), at(0, { level: 'measure' })];
    expect(groupRecords(more)[0].formula).toBe('H₂O');
    expect(treeOf(more).map((m) => m.formula)).toEqual(before);
  });

  it('breaks a tie of first records by the formula', () => {
    const savedAt = new Date(Date.UTC(2026, 8, 20, 12)).toISOString();
    const tree = treeOf([at(0, { savedAt, z: AMMONIA }), at(0, { savedAt })]);
    expect(tree.map((m) => m.formula)).toEqual(['H₂O', 'H₃N']);
  });
});

describe('the ids that remember what is open', () => {
  it('are built from the formula, the group and the records', () => {
    const [a, b] = [at(0), at(0.1)];
    const [molecule] = treeOf([a, b]);
    const level = molecule.children[0];
    expect(molecule.id).toBe('f:H₂O');
    expect(level.id).toBe(`g:${level.group!.key}`);
    expect(level.children[0].id).toBe(`v:${level.group!.key}:${a.id}`);
  });

  it('do not change when a record is added', () => {
    const before = [at(0), at(0.3), at(40), at(0, { z: AMMONIA }), at(-9, { reason: 'maxSteps' })];
    const old = ids(treeOf(before));
    // Deeper in an existing valley, a new valley, and one more of each kind:
    // none of them may rename what was there.
    for (const added of [at(-0.2), at(-80), at(60), at(50, { z: AMMONIA })]) {
      const grown = ids(treeOf([...before, added]));
      for (const id of old) expect(grown).toContain(id);
    }
  });

  it('name a valley after the record that was alone in it before', () => {
    // The one that joins it is deeper, so it heads the valley; the name stays.
    const [bottom, alone] = [at(0), at(40)];
    const [molecule] = treeOf([bottom, alone, at(39.8)]);
    const level = molecule.children[0];
    expect(level.children.map((child) => child.id)).toEqual([
      `r:${bottom.id}`,
      `v:${level.group!.key}:${alone.id}`,
    ]);
  });

  it('are unique across the whole tree', () => {
    const all = ids(treeOf([at(0), at(0.1), at(20), at(0, { charge: 1 }), at(0, { z: AMMONIA })]));
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('what is open before the user opens anything', () => {
  const records = [at(0), at(0.2), at(0.4), at(0, { level: 'measure' }), at(0, { z: AMMONIA })];
  const tree = treeOf(records);
  const water = tree.find((molecule) => molecule.formula === 'H₂O')!;
  const ammonia = tree.find((molecule) => molecule.formula !== 'H₂O')!;
  const valley = water.children[0].children[0] as ValleyNode;

  it('is the molecule on screen and its levels, and nothing else', () => {
    const open = defaultExpanded(tree, { currentFormula: 'H₂O', openId: null });
    expect([...open].sort()).toEqual([water.id, ...water.children.map((l) => l.id)].sort());
    expect(open.has(ammonia.id)).toBe(false);
    expect(open.has(valley.id)).toBe(false);
  });

  it('opens a valley when the record on screen is folded inside it', () => {
    const folded = valley.rest[1].record.id;
    const open = defaultExpanded(tree, { currentFormula: 'H₂O', openId: folded });
    expect(open.has(valley.id)).toBe(true);
    // The head is in sight already, so opening it changes nothing.
    const head = defaultExpanded(tree, { currentFormula: 'H₂O', openId: valley.head.record.id });
    expect(head.has(valley.id)).toBe(false);
  });

  it('opens the ancestors of that valley too', () => {
    const folded = valley.rest[0].record.id;
    const open = defaultExpanded(tree, { currentFormula: 'H₃N', openId: folded });
    expect(open.has(water.id)).toBe(true);
    expect(open.has(water.children[0].id)).toBe(true);
    expect(open.has(valley.id)).toBe(true);
  });

  it('opens nothing when there is no molecule on screen', () => {
    expect(defaultExpanded(tree, { currentFormula: null, openId: null }).size).toBe(0);
  });
});

describe('the candidates of the search', () => {
  const pending = (
    id: string,
    status: PendingCandidate['status'],
    formula = 'H₂O',
  ): PendingCandidate => ({ id, formula, name: id, status, text: `${status} ${id}` });

  it('makes a molecule and a level for a molecule with no record yet', () => {
    const tree = buildRecordTree(groupRecords([at(0, { z: AMMONIA })]), [
      pending('a', 'running'),
      pending('b', 'waiting'),
    ]);
    expect(tree.map((molecule) => molecule.formula)).toEqual(['H₂O', 'H₃N']);
    const [water] = tree;
    expect(water.id).toBe('f:H₂O');
    expect(water.count).toBe(0);
    expect(water.children.map((level) => [level.level, level.group])).toEqual([['shape', null]]);
    const rows = water.children[0].children as CandidateNode[];
    expect(rows.map((row) => [row.id, row.candidateId, row.text])).toEqual([
      ['c:a', 'a', 'running a'],
      ['c:b', 'b', 'waiting b'],
    ]);
  });

  it('puts them first under the level the search runs at, in the order they came', () => {
    const records = [at(0), at(20), at(0, { level: 'measure' })];
    const tree = buildRecordTree(groupRecords(records), [
      pending('a', 'failed'),
      pending('b', 'running'),
    ]);
    const [shape, measure] = tree[0].children;
    expect(shape.level).toBe('shape');
    expect(shape.children.map((child) => child.kind)).toEqual([
      'candidate',
      'candidate',
      'record',
      'record',
    ]);
    expect(shape.children.slice(0, 2).map((child) => child.id)).toEqual(['c:a', 'c:b']);
    expect(measure.children.every((child) => child.kind !== 'candidate')).toBe(true);
  });

  it('adds a level for the search to a molecule measured but never shaped', () => {
    const tree = buildRecordTree(groupRecords([at(0, { level: 'measure' })]), [
      pending('a', 'waiting'),
    ]);
    expect(tree[0].children.map((level) => level.level)).toEqual(['shape', 'measure']);
  });

  it('goes under the molecule of the charge it asks for', () => {
    const tree = buildRecordTree(groupRecords([at(0), at(0, { charge: 1 })]), [
      pending('a', 'running', 'H₂O⁺'),
      pending('b', 'running'),
    ]);
    const heads = (formula: string) =>
      tree
        .find((molecule) => molecule.formula === formula)!
        .children[0].children.filter((child) => child.kind === 'candidate')
        .map((child) => (child as CandidateNode).candidateId);
    expect(heads('H₂O⁺')).toEqual(['a']);
    expect(heads('H₂O')).toEqual(['b']);
  });

  it('leaves out the ones that became records', () => {
    const tree = buildRecordTree(groupRecords([at(0)]), [
      pending('a', 'settled'),
      pending('b', 'partial'),
      pending('c', 'cancelled'),
      pending('d', 'unavailable'),
      pending('e', 'settled', 'CH₄'),
    ]);
    expect(ids(tree).filter((id) => id.startsWith('c:'))).toEqual(['c:c', 'c:d']);
    expect(tree.map((molecule) => molecule.formula)).toEqual(['H₂O']);
  });

  it('opens the molecule and level of one still waiting or running', () => {
    const records = [at(0), at(0, { z: AMMONIA })];
    const running = buildRecordTree(groupRecords(records), [
      pending('a', 'running', 'H₃N'),
    ]);
    const ammonia = running.find((molecule) => molecule.formula === 'H₃N')!;
    const open = defaultExpanded(running, { currentFormula: 'H₂O', openId: null });
    expect(open.has(ammonia.id)).toBe(true);
    expect(open.has(ammonia.children[0].id)).toBe(true);

    const over = buildRecordTree(groupRecords(records), [pending('a', 'failed', 'H₃N')]);
    const closed = defaultExpanded(over, { currentFormula: 'H₂O', openId: null });
    expect(closed.has(ammonia.id)).toBe(false);
  });
});

describe('the records under a node, for deleting them together (V6-2)', () => {
  it('are every record of every level under a molecule, and not its ion', () => {
    const records = [at(0), at(0.2), at(20), at(0, { level: 'measure' })];
    const [other, ion] = [at(0, { z: AMMONIA }), at(0, { charge: 1 })];
    const tree = treeOf([...records, other, ion]);
    const water = tree.find((m) => m.formula === 'H₂O')!;
    expect(recordIdsUnder(water).sort()).toEqual(records.map((r) => r.id).sort());
    expect(recordIdsUnder(tree.find((m) => m.formula === 'H₂O⁺')!)).toEqual([ion.id]);
  });

  it('are only its own group under a level, of two that read the same', () => {
    const [one, two] = [
      { ...at(0), model: 'old/one' },
      { ...at(0), model: 'old/two' },
    ];
    const [first, second] = treeOf([one, { ...at(0.1), model: 'old/one' }, two])[0].children;
    expect(first.level).toBe(second.level);
    const ids = [recordIdsUnder(first), recordIdsUnder(second)];
    expect(ids.find((each) => each.includes(two.id))).toEqual([two.id]);
    expect(ids.find((each) => each.includes(one.id))).toHaveLength(2);
  });

  it('are none under a level that holds only candidates, and leave candidates out', () => {
    const tree = buildRecordTree(groupRecords([at(0, { level: 'measure' })]), [
      { id: 'a', formula: 'H₂O', name: 'a', status: 'running', text: 'running a' },
    ]);
    const [shape, measure] = tree[0].children;
    expect(shape.group).toBeNull();
    expect(recordIdsUnder(shape)).toEqual([]);
    expect(recordIdsUnder(tree[0])).toEqual(recordIdsUnder(measure));
    expect(recordIdsUnder(tree[0])).toHaveLength(1);
  });
});

describe('a real log', () => {
  it('folds the two C₃H₆ records that found the same valley', () => {
    const text = readFileSync(
      new URL('../../../docs/C₃H₆-記録-20260920-1859.json', import.meta.url),
      'utf8',
    );
    const read = readStructureLog(text, (z) => isSupportedElement(z));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const [molecule] = buildRecordTree(groupRecords(read.records));
    expect(molecule.formula).toBe('C₃H₆');
    expect(molecule.count).toBe(read.records.length);
    const kinds = molecule.children[0].children.map((child) => child.kind);
    expect(kinds).toEqual(['record', 'valley']);
    expect((molecule.children[0].children[1] as ValleyNode).rest).toHaveLength(1);
  });
});
