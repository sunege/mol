/**
 * What the records column remembers between visits (V5-8): whether the column
 * is folded to its strip, and which branches of the tree the user has opened or
 * closed.
 *
 * Only what the user chose is kept - a branch nobody has touched follows
 * `defaultExpanded` (`records/tree.ts`), so the molecule on screen still opens
 * by itself when the molecule changes. The one thing that beats a remembered
 * choice is the record on screen: when it changes, its ancestors are written in
 * as opened (`openAncestors`), so the row of what is in the view is never hidden
 * under a fold the user closed an hour ago. It is written in rather than
 * enforced, so the user can close that fold again.
 *
 * The storage is `localStorage` under `mol.explorer`, read and written by the
 * column behind a try/catch: a browser that will not keep it (private windows,
 * blocked storage) gets the defaults every time and nothing fails - the same
 * stance as `RecordStore`. What is read is checked, and anything unexpected is
 * the defaults, not an error.
 */
import { defaultExpanded, type RecordTree } from '../records/tree';

export const EXPLORER_KEY = 'mol.explorer';

export interface ExplorerMemory {
  /** The column is its 40px strip. */
  collapsed: boolean;
  /** A node's id → whether the user left it open. Nodes not here follow the defaults. */
  choices: ReadonlyMap<string, boolean>;
}

export const EMPTY_MEMORY: ExplorerMemory = { collapsed: false, choices: new Map() };

export function parseExplorerMemory(text: string | null): ExplorerMemory {
  if (text === null) return EMPTY_MEMORY;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return EMPTY_MEMORY;
  }
  if (typeof value !== 'object' || value === null) return EMPTY_MEMORY;
  const { collapsed, open, closed } = value as Record<string, unknown>;
  const choices = new Map<string, boolean>();
  for (const [list, state] of [
    [open, true],
    [closed, false],
  ] as const) {
    if (!Array.isArray(list)) continue;
    for (const id of list) if (typeof id === 'string') choices.set(id, state);
  }
  return { collapsed: collapsed === true, choices };
}

export function serializeExplorerMemory(memory: ExplorerMemory): string {
  const open: string[] = [];
  const closed: string[] = [];
  for (const [id, state] of memory.choices) (state ? open : closed).push(id);
  return JSON.stringify({ collapsed: memory.collapsed, open, closed });
}

/** The same memory with one branch opened or closed by the user. */
export function withChoice(memory: ExplorerMemory, id: string, open: boolean): ExplorerMemory {
  const choices = new Map(memory.choices);
  choices.set(id, open);
  return { ...memory, choices };
}

/** The nodes that are open now: the user's choice where there is one, else the default. */
export function expandedIds(
  tree: RecordTree,
  choices: ReadonlyMap<string, boolean>,
  context: { currentFormula: string | null; openId: string | null },
): Set<string> {
  const defaults = defaultExpanded(tree, context);
  const open = new Set<string>();
  const decide = (id: string) => {
    if (choices.get(id) ?? defaults.has(id)) open.add(id);
  };
  for (const molecule of tree) {
    decide(molecule.id);
    for (const level of molecule.children) {
      decide(level.id);
      for (const child of level.children) if (child.kind === 'valley') decide(child.id);
    }
  }
  return open;
}

/**
 * The branches above a record (its molecule, its level and, when it is folded
 * inside a valley, the valley), outermost first. Empty when it is not in the
 * tree. A record that heads its valley is the valley's own row, so the valley
 * is not among them.
 */
export function ancestorsOf(tree: RecordTree, recordId: string): string[] {
  for (const molecule of tree) {
    for (const level of molecule.children) {
      for (const child of level.children) {
        if (child.kind === 'candidate') continue;
        const row = child.kind === 'record' ? child.entry : child.head;
        if (row.record.id === recordId) return [molecule.id, level.id];
        if (child.kind === 'valley' && child.rest.some((entry) => entry.record.id === recordId)) {
          return [molecule.id, level.id, child.id];
        }
      }
    }
  }
  return [];
}

/** The memory with the record's ancestors opened, as if the user had opened them. */
export function openAncestors(
  memory: ExplorerMemory,
  tree: RecordTree,
  recordId: string,
): ExplorerMemory {
  const ancestors = ancestorsOf(tree, recordId);
  if (ancestors.every((id) => memory.choices.get(id) === true)) return memory;
  const choices = new Map(memory.choices);
  for (const id of ancestors) choices.set(id, true);
  return { ...memory, choices };
}
