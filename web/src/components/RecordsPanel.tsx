/**
 * The records section of the panel: every shape this browser has kept, gathered
 * by molecule and sorted by how deep the valley it found is.
 *
 * The group of the molecule on screen comes first, because during a lecture
 * that is the one being talked about. Everything else is in the order it was
 * last added to.
 */
import { useState } from 'react';
import type { LogGroup } from '../records/log';
import type { StructureRecord } from '../records/record';
import {
  ISOMER_CAVEAT,
  NO_RECORDS,
  NOT_KEPT_NOTICE,
  RECORDS_HINT,
  depthBar,
  groupHeading,
  relativeText,
  sameShapeText,
  savedAtText,
  settledCount,
  spreadOf,
} from './records';

interface Props {
  groups: LogGroup[];
  /** The record currently on screen, so the list can show which it is. */
  openId: string | null;
  /** False when this browser will not keep the records past the tab. */
  kept: boolean;
  /** Only once the engine's element table is here can a file be checked. */
  canImport: boolean;
  /** The molecule on screen, for the "this one only" export. */
  currentFormula: string | null;
  onOpen: (record: StructureRecord) => void;
  /** Replays the relaxation of the record that is open. */
  onReplay: (record: StructureRecord) => void;
  canReplay: boolean;
  onRename: (record: StructureRecord, name: string) => void;
  onDelete: (record: StructureRecord) => void;
  onClear: () => void;
  /** All of them, or only the records of one formula. */
  onExport: (only: string | null) => void;
  onImport: (file: File) => void;
  /** What the last file said, in either direction. */
  notice: string | null;
}

export function RecordsPanel({
  groups,
  openId,
  kept,
  canImport,
  currentFormula,
  onOpen,
  onReplay,
  canReplay,
  onRename,
  onDelete,
  onClear,
  onExport,
  onImport,
  notice,
}: Props) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const now = new Date();
  const total = groups.reduce((sum, group) => sum + group.entries.length, 0);

  return (
    <>
      <h2>記録</h2>
      {!kept && <p className="hint warning">{NOT_KEPT_NOTICE}</p>}
      {total === 0 ? (
        <p className="hint">{NO_RECORDS}</p>
      ) : (
        <>
          {/* Bounded, so a lecture's worth of records cannot push the rest of
              the panel out of reach. */}
          <div className="record-list">
          {groups.map((group) => {
            const spread = spreadOf(group);
            const settled = settledCount(group);
            return (
              <div className="record-group" key={group.key}>
                <h3>{groupHeading(group)}</h3>
                <ul className="records">
                  {group.entries.map((entry) => {
                    const record = entry.record;
                    const open = record.id === openId;
                    return (
                      <li key={record.id} className={open ? 'record open' : 'record'}>
                        <div
                          className="record-bar"
                          style={{ width: `${(depthBar(entry, spread) * 100).toFixed(1)}%` }}
                        />
                        <div className="record-row">
                          {renaming === record.id ? (
                            <input
                              className="record-name"
                              autoFocus
                              value={draft}
                              onChange={(event) => setDraft(event.target.value)}
                              onBlur={() => {
                                if (draft.trim()) onRename(record, draft.trim());
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
                              className="record-name"
                              onClick={() => onOpen(record)}
                              title="この形を開く"
                            >
                              {record.name}
                            </button>
                          )}
                          <span className="record-relative">
                            {relativeText(entry, settled)}
                          </span>
                        </div>
                        <div className="record-row record-meta">
                          <span>
                            {savedAtText(record.savedAt, now)}
                            {sameShapeText(entry) && ` · ${sameShapeText(entry)}`}
                          </span>
                          <span className="record-actions">
                            {open && canReplay && (
                              <button type="button" onClick={() => onReplay(record)}>
                                緩和を再生
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setDraft(record.name);
                                setRenaming(record.id);
                              }}
                            >
                              名前
                            </button>
                            <button type="button" onClick={() => onDelete(record)}>
                              削除
                            </button>
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
          </div>
          <p className="hint">
            {RECORDS_HINT}
            {'\u00a0'}
            {ISOMER_CAVEAT}
          </p>
        </>
      )}
      <div className="row">
        <button type="button" onClick={() => onExport(null)} disabled={total === 0}>
          書き出す
        </button>
        {currentFormula !== null && hasFormula(groups, currentFormula) && (
          <button type="button" onClick={() => onExport(currentFormula)}>
            {currentFormula} だけ
          </button>
        )}
        <label className={canImport ? 'file-button' : 'file-button disabled'}>
          読み込む
          <input
            type="file"
            accept="application/json,.json"
            disabled={!canImport}
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Cleared, so choosing the same file twice reads it twice.
              event.target.value = '';
              if (file) onImport(file);
            }}
          />
        </label>
        <button type="button" onClick={onClear} disabled={total === 0}>
          全部消す
        </button>
      </div>
      {notice && <p className="hint">{notice}</p>}
    </>
  );
}

/** Whether the log has anything of this molecule to export on its own. */
function hasFormula(groups: readonly LogGroup[], formula: string): boolean {
  return groups.some((group) => group.formula === formula);
}
