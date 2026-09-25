/**
 * The records column on the left of the screen (V5-8): every shape this browser
 * has kept, as a tree of molecule › level › record (`RecordTree`).
 *
 * From the top: the heading with the count and the button that folds the column
 * to a 40px strip, the file buttons (all records out, a file in, and behind "…"
 * the one that clears everything), what the store and the last file said, the
 * tree - the only part that scrolls - and what the ranking may not be read as,
 * one sentence for each level the tree holds (`isomerCaveats`).
 *
 * The handlers are the App's own, unchanged. What this column adds is memory
 * (`explorer.ts`): whether it is folded and which branches the user opened or
 * closed, kept in `localStorage` behind a try/catch so a browser that will not
 * keep it still works, with the defaults every time.
 *
 * The 3D view needs nothing from here: the grid column is `auto`, and the viewer
 * follows its own size with a `ResizeObserver`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LogGroup } from '../records/log';
import { hillFormula, type StructureRecord } from '../records/record';
import { buildRecordTree, type PendingCandidate } from '../records/tree';
import type { Candidate } from '../search/pool';
import { IconButton } from './controls';
import { ChevronIcon } from './icons';
import { MoreMenu } from './MoreMenu';
import { RecordTree } from './RecordTree';
import {
  EXPLORER_KEY,
  EMPTY_MEMORY,
  ancestorsOf,
  expandedIds,
  openAncestors,
  parseExplorerMemory,
  serializeExplorerMemory,
  withChoice,
  type ExplorerMemory,
} from './explorer';
import {
  EXPLORER_WORDS as WORDS,
  NO_RECORDS,
  NOT_KEPT_NOTICE,
  RECORDS_HINT,
  isomerCaveats,
} from './records';
import { canCancel, candidateName, statusText } from './search';
import { useNow } from './useNow';

interface Props {
  groups: LogGroup[];
  /** The record currently on screen, so the tree can show which it is. */
  openId: string | null;
  /** False when this browser will not keep the records past the tab. */
  kept: boolean;
  /** Only once the engine's element table is here can a file be checked. */
  canImport: boolean;
  /** The molecule on screen, whose branch opens by default. */
  currentFormula: string | null;
  onOpen: (record: StructureRecord) => void;
  /** Replays the relaxation of the record that is open. */
  onReplay: (record: StructureRecord) => void;
  canReplay: boolean;
  onRename: (record: StructureRecord, name: string) => void;
  onDelete: (record: StructureRecord) => void;
  /** A molecule's or a level's records at once; the App asks first (V6-2). */
  onDeleteMany: (ids: string[], what: string) => void;
  onClear: () => void;
  /** All of them, or only the records of one formula. */
  onExport: (only: string | null) => void;
  onImport: (file: File) => void;
  /** What the last file said, in either direction. */
  notice: string | null;
  /** The search's candidates; those that left a record are drawn as that record. */
  candidates: Candidate[];
  /** For the formula a candidate hangs under. */
  symbolOf: (z: number) => string;
  /** Plays an unsolved candidate coming apart. */
  onOpenCandidate: (candidate: Candidate) => void;
  onCancel: (candidate: Candidate) => void;
  onCancelAll: () => void;
  onClearFinished: () => void;
  /**
   * False in the narrow screen's sheet (V5-10): no fold button, and a folded
   * column remembered from the wide screen is drawn open. Default true.
   */
  foldable?: boolean;
}

function loadMemory(): ExplorerMemory {
  try {
    return parseExplorerMemory(window.localStorage.getItem(EXPLORER_KEY));
  } catch {
    return EMPTY_MEMORY;
  }
}

export function RecordExplorer(props: Props) {
  const { groups, openId, currentFormula, candidates, symbolOf, foldable = true } = props;
  const [memory, setMemory] = useState(loadMemory);
  // The candidates' clocks tick here, and only while one of them is going, so
  // the App is not redrawn ten times a second for them.
  const going = candidates.some(canCancel);
  const now = useNow(going);
  const pending = useMemo(
    (): PendingCandidate[] =>
      candidates.map((candidate) => ({
        id: candidate.id,
        formula: hillFormula(Array.from(candidate.z), symbolOf),
        name: candidateName(candidates, candidate),
        status: candidate.status,
        text: statusText(candidate, now),
      })),
    [candidates, symbolOf, now],
  );
  const tree = useMemo(() => buildRecordTree(groups, pending), [groups, pending]);
  const total = groups.reduce((sum, group) => sum + group.entries.length, 0);
  const caveats = isomerCaveats(groups.map((group) => group.level));
  const finished = candidates.length - candidates.filter(canCancel).length;
  const byId = (id: string) => candidates.find((candidate) => candidate.id === id);

  useEffect(() => {
    try {
      window.localStorage.setItem(EXPLORER_KEY, serializeExplorerMemory(memory));
    } catch {
      // Not kept: the next visit starts from the defaults.
    }
  }, [memory]);

  // A newly opened record's branches open, over whatever was remembered. Once
  // per record, and only once it is in the tree (the log may still be loading),
  // so the user can close them again afterwards.
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (openId === null) {
      revealed.current = null;
      return;
    }
    if (revealed.current === openId || ancestorsOf(tree, openId).length === 0) return;
    revealed.current = openId;
    setMemory((current) => openAncestors(current, tree, openId));
  }, [openId, tree]);

  const expanded = expandedIds(tree, memory.choices, { currentFormula, openId });
  const setCollapsed = (collapsed: boolean) =>
    setMemory((current) => ({ ...current, collapsed }));

  if (foldable && memory.collapsed) {
    return (
      <aside className="explorer collapsed" aria-label={WORDS.heading}>
        <IconButton label={WORDS.unfold} onClick={() => setCollapsed(false)}>
          <ChevronIcon open={false} />
        </IconButton>
        <span className="badge">{total}</span>
        {going && <span className="spinner" role="img" aria-label={WORDS.running} />}
      </aside>
    );
  }

  return (
    <aside className={foldable ? 'explorer' : 'explorer in-sheet'} aria-label={WORDS.heading}>
      <div className="explorer-head">
        <h2 title={RECORDS_HINT}>{WORDS.heading}</h2>
        <span className="badge">{total}</span>
        {going && <span className="spinner" role="img" aria-label={WORDS.running} />}
        {foldable && (
          <IconButton label={WORDS.fold} onClick={() => setCollapsed(true)}>
            <span className="chevron-left">
              <ChevronIcon open />
            </span>
          </IconButton>
        )}
      </div>
      <div className="explorer-tools">
        <button
          type="button"
          className="btn small"
          onClick={() => props.onExport(null)}
          disabled={total === 0}
        >
          {WORDS.exportAll}
        </button>
        <label
          className={props.canImport ? 'btn small file-label' : 'btn small file-label disabled'}
        >
          {WORDS.importFile}
          <input
            type="file"
            accept="application/json,.json"
            disabled={!props.canImport}
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Cleared, so choosing the same file twice reads it twice.
              event.target.value = '';
              if (file) props.onImport(file);
            }}
          />
        </label>
        <MoreMenu
          label={WORDS.more}
          items={[
            { label: WORDS.cancelAll, onSelect: props.onCancelAll, disabled: !going },
            { label: WORDS.clearFinished, onSelect: props.onClearFinished, disabled: finished === 0 },
            { label: WORDS.clear, onSelect: props.onClear, disabled: total === 0 },
          ]}
          note={RECORDS_HINT}
        />
      </div>
      {!props.kept && <p className="hint warning">{NOT_KEPT_NOTICE}</p>}
      {props.notice && <p className="hint">{props.notice}</p>}
      <div className="explorer-tree">
        {tree.length === 0 ? (
          <p className="hint">{NO_RECORDS}</p>
        ) : (
          <RecordTree
            tree={tree}
            expanded={expanded}
            onToggle={(id, open) => setMemory((current) => withChoice(current, id, open))}
            openId={openId}
            currentFormula={currentFormula}
            onOpen={props.onOpen}
            onReplay={props.onReplay}
            canReplay={props.canReplay}
            onRename={props.onRename}
            onDelete={props.onDelete}
            onDeleteMany={props.onDeleteMany}
            onExport={props.onExport}
            onOpenCandidate={(id) => {
              const candidate = byId(id);
              if (candidate) props.onOpenCandidate(candidate);
            }}
            onCancelCandidate={(id) => {
              const candidate = byId(id);
              if (candidate) props.onCancel(candidate);
            }}
          />
        )}
      </div>
      {caveats.map((caveat) => (
        <p key={caveat} className="explorer-caveat">
          {caveat}
        </p>
      ))}
    </aside>
  );
}
