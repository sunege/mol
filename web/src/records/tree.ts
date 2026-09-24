/**
 * The structure log as a tree: molecule › level › record, with the records that
 * found the same valley folded under one.
 *
 * `groupRecords` already decides everything about comparison - which records
 * belong together, which valley each is in, how they are ordered - and this file
 * only gives that a shape to open and close. So it takes the groups as they
 * come (the App puts the molecule on screen first) and changes nothing inside
 * them: a molecule appears where its first group does, a group becomes one level
 * node even when two share a level (they differ by the charge, which is not
 * shown - requirement F4 - so their headings read the same, as they always
 * have), and a valley of one record is just that record.
 *
 * Every node has an `id` for remembering whether it is open. It must survive the
 * log growing and being re-sorted, so it is built from things that do not move:
 * the formula, the group's key, a record's id. A valley is named by its oldest
 * record rather than by its number or its deepest: numbers shift when a deeper
 * shape turns up, and a search that finds the same valley again lands a hair
 * above or below the first one about as often, which would move the deepest and
 * close a valley the user had opened.
 *
 * The search's candidates hang in the same tree (V5-9) while they have no
 * record: waiting, running, or over without one. A candidate that settled or
 * stopped part-way already is a record with its id, so it is not drawn twice.
 * They go first under the level the search runs at, and a molecule tried before
 * it has any record gets a molecule and a level of its own to hang in. The
 * tree never reads a clock: what a candidate is doing arrives as words.
 */
import { SEARCH_LEVEL, type CandidateStatus } from '../search/pool';
import type { ModelLevel } from '../worker/protocol';
import type { LogEntry, LogGroup } from './log';

export type RecordTree = FormulaNode[];

export interface FormulaNode {
  kind: 'formula';
  id: string;
  formula: string;
  /** Every record of the molecule, across its levels. */
  count: number;
  children: LevelNode[];
}

export interface LevelNode {
  kind: 'level';
  id: string;
  level: ModelLevel | null;
  /** Null for a level that holds only candidates, before any of them is a record. */
  group: LogGroup | null;
  /** The candidates first, then the valleys deepest first, then the records that did not settle. */
  children: (CandidateNode | ValleyNode | RecordLeaf)[];
}

/** A valley that more than one record found: the first shown, the rest folded. */
export interface ValleyNode {
  kind: 'valley';
  id: string;
  /** The first of the valley in the group's order, so its deepest. */
  head: LogEntry;
  rest: LogEntry[];
}

export interface RecordLeaf {
  kind: 'record';
  id: string;
  entry: LogEntry;
}

/** A candidate of the search with no record (yet, or at all). */
export interface CandidateNode {
  kind: 'candidate';
  id: string;
  candidateId: string;
  /** Its place in the batch (`candidateName`). */
  name: string;
  status: CandidateStatus;
  /** What it is doing, in the search's words (`statusText`). */
  text: string;
}

/** What the tree needs of a candidate; the App makes it, clock and all. */
export interface PendingCandidate {
  id: string;
  /** The Hill formula of its atoms. */
  formula: string;
  name: string;
  status: CandidateStatus;
  text: string;
}

export type RecordTreeNode = FormulaNode | LevelNode | CandidateNode | ValleyNode | RecordLeaf;

/** Levels in the order they are offered, and the unknown ones last. */
const LEVEL_ORDER: readonly (ModelLevel | null)[] = ['shape', 'measure', null];

export function buildRecordTree(
  groups: readonly LogGroup[],
  pending: readonly PendingCandidate[] = [],
): RecordTree {
  const tree = recordsOnly(groups);
  const fresh: FormulaNode[] = [];
  for (const candidate of pending) {
    if (!inTree(candidate.status)) continue;
    let molecule =
      tree.find((node) => node.formula === candidate.formula) ??
      fresh.find((node) => node.formula === candidate.formula);
    if (molecule === undefined) {
      molecule = {
        kind: 'formula',
        id: formulaId(candidate.formula),
        formula: candidate.formula,
        count: 0,
        children: [],
      };
      fresh.push(molecule);
    }
    // Its charge is not known until it is solved, so of two groups at the
    // search's level (a neutral one and an ion) it goes under the first.
    let level = molecule.children.find((node) => node.level === SEARCH_LEVEL);
    if (level === undefined) {
      level = {
        kind: 'level',
        id: `g:pending:${candidate.formula}:${SEARCH_LEVEL}`,
        level: SEARCH_LEVEL,
        group: null,
        children: [],
      };
      molecule.children.unshift(level);
    }
    const leading = level.children.filter((child) => child.kind === 'candidate').length;
    level.children.splice(leading, 0, {
      kind: 'candidate',
      id: candidateId(candidate.id),
      candidateId: candidate.id,
      name: candidate.name,
      status: candidate.status,
      text: candidate.text,
    });
  }
  // A molecule tried before it has any record is the newest thing in the tree.
  return [...fresh, ...tree];
}

/**
 * Whether a candidate in this state has a row of its own: every state but the
 * two that left a record behind.
 */
function inTree(status: CandidateStatus): boolean {
  return status !== 'settled' && status !== 'partial';
}

/** Whether a candidate still has work ahead of it. */
function isPending(status: CandidateStatus): boolean {
  return status === 'waiting' || status === 'running';
}

function recordsOnly(groups: readonly LogGroup[]): RecordTree {
  const byFormula = new Map<string, LogGroup[]>();
  for (const group of groups) {
    const existing = byFormula.get(group.formula);
    if (existing) existing.push(group);
    else byFormula.set(group.formula, [group]);
  }

  return [...byFormula].map(([formula, members]) => {
    // A stable sort, so two groups at one level stay in the order they came.
    const levels = [...members].sort(
      (a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level),
    );
    return {
      kind: 'formula',
      id: formulaId(formula),
      formula,
      count: members.reduce((sum, group) => sum + group.entries.length, 0),
      children: levels.map(levelNode),
    };
  });
}

function levelNode(group: LogGroup): LevelNode {
  const valleys = new Map<number, LogEntry[]>();
  const unsettled: LogEntry[] = [];
  for (const entry of group.entries) {
    if (entry.valley === null) {
      unsettled.push(entry);
      continue;
    }
    const existing = valleys.get(entry.valley);
    if (existing) existing.push(entry);
    else valleys.set(entry.valley, [entry]);
  }

  const children: LevelNode['children'] = [];
  // Entries come deepest valley first, so the map already has them in order.
  for (const [head, ...rest] of valleys.values()) {
    if (rest.length === 0) children.push(recordLeaf(head));
    else {
      const members = [head, ...rest].map((entry) => entry.record);
      const oldest = members.reduce((first, record) =>
        record.savedAt < first.savedAt ||
        (record.savedAt === first.savedAt && record.id < first.id)
          ? record
          : first,
      );
      children.push({ kind: 'valley', id: `v:${group.key}:${oldest.id}`, head, rest });
    }
  }
  for (const entry of unsettled) children.push(recordLeaf(entry));

  return { kind: 'level', id: groupId(group), level: group.level, group, children };
}

function recordLeaf(entry: LogEntry): RecordLeaf {
  return { kind: 'record', id: recordId(entry.record.id), entry };
}

const formulaId = (formula: string) => `f:${formula}`;
const groupId = (group: LogGroup) => `g:${group.key}`;
const recordId = (id: string) => `r:${id}`;
const candidateId = (id: string) => `c:${id}`;

/**
 * Which nodes are open before the user has opened or closed anything.
 *
 * The molecule on screen and its levels are, so its records are in sight; other
 * molecules and every valley are closed. The one exception is the record that
 * is open: if it sits folded inside a valley, the valley and everything above it
 * open too, because a record on screen that cannot be found in the list reads
 * as lost. So do the molecule and level of a candidate still waiting or
 * running, so that starting a search shows it happening. Whatever the user has
 * opened or closed since is V5-8's to remember, and wins over this.
 */
export function defaultExpanded(
  tree: RecordTree,
  { currentFormula, openId }: { currentFormula: string | null; openId: string | null },
): Set<string> {
  const open = new Set<string>();
  for (const molecule of tree) {
    if (molecule.formula === currentFormula) {
      open.add(molecule.id);
      for (const level of molecule.children) open.add(level.id);
    }
    for (const level of molecule.children) {
      for (const child of level.children) {
        if (child.kind === 'candidate' && isPending(child.status)) {
          open.add(molecule.id).add(level.id);
        }
        if (child.kind !== 'valley' || openId === null) continue;
        if (child.rest.some((entry) => entry.record.id === openId)) {
          open.add(molecule.id).add(level.id).add(child.id);
        }
      }
    }
  }
  return open;
}
