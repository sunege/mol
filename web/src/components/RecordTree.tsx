/**
 * The records as a tree (V5-8): molecule › level › record, with the records of
 * one valley folded under the deepest (`records/tree.ts`).
 *
 * The rows only draw: what is open comes in as `expanded` (the column decides
 * it and remembers it), and every word comes from `records.ts`. A molecule or a
 * level is one button that opens and closes it. A valley is a record row too -
 * pressing it opens its deepest record - so only its chevron folds it.
 *
 * A record is two lines: its name, which has the width to itself, and under
 * it where it sits (`+19.7 kJ/mol`, `×2`) with when it was made on the right.
 *
 * The record on screen is the one row with actions under it, so a long list
 * does not carry three icons on every line: replay, rename (typed in place,
 * Enter to keep and Escape to drop) and delete. A molecule's and a level's
 * "…" delete every record under it at once (V6-2); candidates stay.
 */
import { useState, type CSSProperties } from 'react';
import type { LogEntry, LogGroup } from '../records/log';
import type { StructureRecord } from '../records/record';
import {
  recordIdsUnder,
  type CandidateNode,
  type FormulaNode,
  type LevelNode,
  type RecordTree as Tree,
  type ValleyNode,
} from '../records/tree';
import { IconButton } from './controls';
import { ChevronIcon, DeleteIcon, PlayIcon, RenameIcon, StopIcon } from './icons';
import { MoreMenu } from './MoreMenu';
import {
  EXPLORER_WORDS as WORDS,
  deleteWhat,
  depthBar,
  formulaMeta,
  levelHeading,
  levelMeta,
  relativeText,
  savedAtText,
  settledCount,
  spreadOf,
  valleySizeText,
} from './records';

/** One level of the tree is indented this much. */
const INDENT_PX = 14;

interface Props {
  tree: Tree;
  expanded: ReadonlySet<string>;
  onToggle: (id: string, open: boolean) => void;
  /** The record currently on screen. */
  openId: string | null;
  /** The molecule on screen, whose row is marked (it stays where it is in the tree). */
  currentFormula: string | null;
  onOpen: (record: StructureRecord) => void;
  onReplay: (record: StructureRecord) => void;
  canReplay: boolean;
  onRename: (record: StructureRecord, name: string) => void;
  onDelete: (record: StructureRecord) => void;
  /** The records of one molecule only. */
  onExport: (formula: string) => void;
  /**
   * The records under a molecule or a level, all at once (V6-2). `what` names
   * them for the confirmation (`deleteWhat`).
   */
  onDeleteMany: (ids: string[], what: string) => void;
  /** A candidate the engine could not solve: shows it coming apart. */
  onOpenCandidate: (candidateId: string) => void;
  onCancelCandidate: (candidateId: string) => void;
}

const indent = (depth: number): CSSProperties => ({ paddingLeft: depth * INDENT_PX });

export function RecordTree(props: Props) {
  const { tree, expanded } = props;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const now = new Date();

  const recordRow = (
    entry: LogEntry,
    group: LogGroup,
    depth: number,
    valley: ValleyNode | null,
  ) => {
    const record = entry.record;
    const open = record.id === props.openId;
    const settled = settledCount(group);
    const bar = depthBar(entry, spreadOf(group));
    const valleyOpen = valley !== null && expanded.has(valley.id);
    return (
      <li key={record.id} className={open ? 'tree-item open' : 'tree-item'}>
        <div className="tree-row" style={indent(depth)}>
          {valley ? (
            <IconButton
              label={valleyOpen ? WORDS.foldValley : WORDS.unfoldValley}
              expanded={valleyOpen}
              onClick={() => props.onToggle(valley.id, !valleyOpen)}
            >
              <ChevronIcon open={valleyOpen} />
            </IconButton>
          ) : (
            <span className="tree-spacer" />
          )}
          {renaming === record.id ? (
            <input
              className="tree-rename"
              autoFocus
              aria-label={WORDS.rename}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => {
                if (draft.trim()) props.onRename(record, draft.trim());
                setRenaming(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') {
                  setDraft(record.name);
                  setRenaming(null);
                }
              }}
            />
          ) : (
            <button
              type="button"
              className={entry.settled ? 'tree-record' : 'tree-record unsettled'}
              title={WORDS.open}
              aria-current={open ? 'true' : undefined}
              onClick={() => props.onOpen(record)}
            >
              <span className="tree-name">{record.name}</span>
              <span className="tree-sub">
                <span className="tree-relative">{relativeText(entry, settled)}</span>
                {valley && <span className="tree-count">{valleySizeText(valley)}</span>}
                <span className="tree-time">{savedAtText(record.savedAt, now)}</span>
              </span>
              <span className="tree-bar" style={{ width: `${(bar * 100).toFixed(1)}%` }} />
            </button>
          )}
        </div>
        {open && (
          <div className="tree-actions" style={indent(depth)}>
            <span className="tree-spacer" />
            <IconButton
              label={WORDS.replay}
              disabled={!props.canReplay}
              onClick={() => props.onReplay(record)}
            >
              <PlayIcon />
            </IconButton>
            <IconButton
              label={WORDS.rename}
              onClick={() => {
                setDraft(record.name);
                setRenaming(record.id);
              }}
            >
              <RenameIcon />
            </IconButton>
            <IconButton label={WORDS.remove} onClick={() => props.onDelete(record)}>
              <DeleteIcon />
            </IconButton>
          </div>
        )}
        {valley && valleyOpen && (
          <ul role="group">
            {valley.rest.map((rest) => recordRow(rest, group, depth + 1, null))}
          </ul>
        )}
      </li>
    );
  };

  /**
   * A candidate of the search with no record: what it is doing, and the one
   * thing that can be done about it. Still going, it can be stopped; unsolved,
   * it can be opened (requirement F5: the row says nothing, the picture does);
   * stopped or never run, there is nothing to do.
   */
  const candidateRow = (candidate: CandidateNode) => {
    const going = candidate.status === 'waiting' || candidate.status === 'running';
    const body = (
      <>
        <span className="tree-name">{candidate.name}</span>
        <span className="tree-sub">
          <span className="tree-relative">{candidate.text}</span>
        </span>
      </>
    );
    return (
      <li key={candidate.id} className="tree-item">
        <div className="tree-row" style={indent(2)}>
          <span className="tree-spacer">
            {going && <span className="spinner" aria-hidden="true" />}
          </span>
          {candidate.status === 'failed' ? (
            <button
              type="button"
              className="tree-record"
              title={WORDS.open}
              onClick={() => props.onOpenCandidate(candidate.candidateId)}
            >
              {body}
            </button>
          ) : (
            <div className={going ? 'tree-record static' : 'tree-record static unsettled'}>
              {body}
            </div>
          )}
          {going && (
            <IconButton
              label={WORDS.cancelCandidate}
              onClick={() => props.onCancelCandidate(candidate.candidateId)}
            >
              <StopIcon />
            </IconButton>
          )}
        </div>
      </li>
    );
  };

  const levelRow = (molecule: FormulaNode, level: LevelNode) => {
    const open = expanded.has(level.id);
    const ids = recordIdsUnder(level);
    return (
      <li key={level.id} className="tree-item">
        <div className="tree-row" style={indent(1)}>
          <button
            type="button"
            className="tree-toggle"
            aria-expanded={open}
            onClick={() => props.onToggle(level.id, !open)}
          >
            <span className="tree-chevron">
              <ChevronIcon open={open} />
            </span>
            <span className="tree-name">{levelHeading(level.level)}</span>
            <span className="tree-meta">{levelMeta(level.group)}</span>
          </button>
          <MoreMenu
            label={WORDS.levelMore}
            items={[
              {
                label: WORDS.deleteLevel,
                disabled: ids.length === 0,
                onSelect: () => props.onDeleteMany(ids, deleteWhat(molecule, level)),
              },
            ]}
          />
        </div>
        {open && (
          <ul role="group">
            {level.children.map((child) => {
              if (child.kind === 'candidate') return candidateRow(child);
              // A level with records has its group; only candidates live without one.
              const group = level.group!;
              return child.kind === 'valley'
                ? recordRow(child.head, group, 2, child)
                : recordRow(child.entry, group, 2, null);
            })}
          </ul>
        )}
      </li>
    );
  };

  const formulaRow = (molecule: FormulaNode) => {
    const open = expanded.has(molecule.id);
    const ids = recordIdsUnder(molecule);
    return (
      <li key={molecule.id} className="tree-item">
        <div className={molecule.formula === props.currentFormula ? 'tree-row current' : 'tree-row'}>
          <button
            type="button"
            className="tree-toggle formula"
            aria-expanded={open}
            onClick={() => props.onToggle(molecule.id, !open)}
          >
            <span className="tree-chevron">
              <ChevronIcon open={open} />
            </span>
            <span className="tree-name">{molecule.formula}</span>
            <span className="tree-meta">{formulaMeta(molecule)}</span>
          </button>
          <MoreMenu
            label={WORDS.moleculeMore}
            items={[
              { label: WORDS.exportMolecule, onSelect: () => props.onExport(molecule.formula) },
              {
                label: WORDS.deleteMolecule,
                disabled: ids.length === 0,
                onSelect: () => props.onDeleteMany(ids, deleteWhat(molecule)),
              },
            ]}
          />
        </div>
        {open && <ul role="group">{molecule.children.map((level) => levelRow(molecule, level))}</ul>}
      </li>
    );
  };

  return <ul className="tree">{tree.map(formulaRow)}</ul>;
}
