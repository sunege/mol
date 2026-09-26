/**
 * The structure log as a file: what gets written out, and what is let back in.
 *
 * The point of the file is a lecture on a different computer. Records are
 * prepared at home, carried on a memory stick, and opened in the classroom,
 * where they have to appear without anything being calculated again. So the
 * file carries whole records - including the trajectory, so a relaxation can be
 * replayed - and reading one is deliberately strict: a record that does not fit
 * would otherwise become a blank row, or a molecule the engine cannot solve, in
 * front of a class.
 *
 * Strict means the whole file is refused with a reason, not that bad records
 * are silently dropped. A file is written by this program for this program; if
 * part of it does not fit, the honest answer is that it does not, and the
 * records already in the browser are left alone.
 */
import type { OptimizationReason } from '../worker/protocol';
import { chargesOf, levelOfModel, type RecordSource, type StructureRecord } from './record';

export const LOG_FORMAT = 'mol-structure-log';

/**
 * The version a file written now carries.
 *
 * Version 2 (v7) is version 1 with the charge the user put on each atom: every
 * record carries `charges`, one per atom, each -1 / 0 / +1, adding up to the
 * total the engine solved for. Version 1 is still read, as records with every
 * atom neutral - which they were, since atoms had no charges then - and a
 * `charges` in one is dropped rather than trusted. A record made before v7
 * (in the browser, without `charges`) is written with every atom neutral, and
 * since the engine could then pick ±1 on its own, all zeros is the one set of
 * charges that need not add up to the total. Any other version is refused
 * rather than guessed at; when the format changes again, the reading of the
 * earlier ones stays here.
 *
 * Records came to carry their level (V3-5) without a new version, because the
 * shape of a record did not change: the level is read from `model`, which every
 * record already had, and every file written before then carries the one
 * string that means "形を探す". So files prepared before it still open, into the
 * groups they were in. What changed is that a `model` this program never wrote
 * is now refused, since such a record could not be solved again at its level.
 */
export const LOG_VERSION = 2;

/** The versions {@link readStructureLog} lets in. */
const READABLE_VERSIONS: readonly number[] = [1, LOG_VERSION];

export interface StructureLogFile {
  format: typeof LOG_FORMAT;
  version: number;
  /** ISO 8601, for the person looking at a folder of these. */
  exportedAt: string;
  records: StructureRecord[];
}

/** Why a file was refused. The wording for each is the panel's (P9-7). */
export type ImportProblem =
  /** Not JSON at all. */
  | { kind: 'unreadable' }
  /** JSON, but not one of these files. */
  | { kind: 'format' }
  /** One of these files, from a version this program does not read. */
  | { kind: 'version'; version: number }
  /** A record with an element this engine cannot calculate. */
  | { kind: 'element'; z: number }
  /**
   * A record that does not hold together - lengths that disagree, say. `detail`
   * says what, and `index` which record it was, both for the panel to word.
   */
  | { kind: 'shape'; detail: string; index: number };

export type ImportResult =
  | { ok: true; records: StructureRecord[] }
  | { ok: false; problem: ImportProblem };

/** The file text for `records`, pretty enough to look at in an editor. */
export function writeStructureLog(
  records: readonly StructureRecord[],
  exportedAt: Date = new Date(),
): string {
  const file: StructureLogFile = {
    format: LOG_FORMAT,
    version: LOG_VERSION,
    exportedAt: exportedAt.toISOString(),
    // Records kept in the browser since before v7 have no `charges`: a file
    // always has them.
    records: records.map((record) => ({ ...record, charges: chargesOf(record) })),
  };
  return JSON.stringify(file, null, 1) + '\n';
}

/**
 * Reads a file, or says why it would not.
 *
 * `isSupportedElement` is the engine's own list of elements (the worker's
 * `elements()`), rather than a range written here, so a file made by a later
 * version that knows more of them is refused for the right reason.
 */
export function readStructureLog(
  text: string,
  isSupportedElement: (z: number) => boolean,
): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail({ kind: 'unreadable' });
  }
  if (!isObject(parsed) || parsed.format !== LOG_FORMAT) return fail({ kind: 'format' });
  if (!READABLE_VERSIONS.includes(parsed.version as number)) {
    return fail({
      kind: 'version',
      version: typeof parsed.version === 'number' ? parsed.version : NaN,
    });
  }
  if (!Array.isArray(parsed.records)) return fail({ kind: 'format' });

  const records: StructureRecord[] = [];
  for (const [index, raw] of parsed.records.entries()) {
    const checked = checkRecord(raw, isSupportedElement, parsed.version as number);
    if ('problem' in checked) {
      const problem = checked.problem;
      return fail(problem.kind === 'shape' ? { ...problem, index } : problem);
    }
    records.push(checked.record);
  }
  return { ok: true, records };
}

/**
 * Adds `incoming` to `existing`, leaving records that are already there as they
 * are.
 *
 * Same `id` means the same record: it was exported from here, and the copy in
 * the browser may since have been renamed. Nothing is overwritten and nothing
 * is lost, which is what makes reading the same file twice harmless.
 */
export function mergeRecords(
  existing: readonly StructureRecord[],
  incoming: readonly StructureRecord[],
): { records: StructureRecord[]; added: StructureRecord[]; alreadyHere: number } {
  const known = new Set(existing.map((record) => record.id));
  const added: StructureRecord[] = [];
  for (const record of incoming) {
    if (known.has(record.id)) continue;
    known.add(record.id);
    added.push(record);
  }
  return {
    records: [...existing, ...added],
    added,
    alreadyHere: incoming.length - added.length,
  };
}

// --- checking ---------------------------------------------------------------

type Checked = { record: StructureRecord } | { problem: ImportProblem };

const REASONS: readonly OptimizationReason[] = ['converged', 'maxSteps', 'interrupted', 'scf'];
const SOURCES: readonly RecordSource[] = ['manual', 'search'];

function checkRecord(
  raw: unknown,
  isSupportedElement: (z: number) => boolean,
  version: number,
): Checked {
  if (!isObject(raw)) return bad('記録ではありません');
  for (const field of ['id', 'savedAt', 'name', 'model', 'formula'] as const) {
    if (typeof raw[field] !== 'string' || raw[field] === '') return bad(`${field} がありません`);
  }
  if (levelOfModel(raw.model as string) === null) return bad('model が違います');
  if (!Array.isArray(raw.z) || raw.z.length === 0) return bad('原子がありません');
  for (const z of raw.z) {
    if (!Number.isInteger(z) || (z as number) < 1) return bad('原子番号が数ではありません');
    if (!isSupportedElement(z as number)) return { problem: { kind: 'element', z: z as number } };
  }
  const width = raw.z.length * 3;
  for (const field of ['built', 'final'] as const) {
    if (!isNumbers(raw[field], width)) return bad(`${field} の座標の数が原子の数と合いません`);
  }
  if (!Array.isArray(raw.trajectory)) return bad('軌跡がありません');
  for (const frame of raw.trajectory) {
    if (!isNumbers(frame, width)) return bad('軌跡の座標の数が原子の数と合いません');
  }
  if (!isNumbers(raw.stepEnergies) || raw.stepEnergies.length !== raw.trajectory.length) {
    return bad('軌跡とエネルギーの数が合いません');
  }
  if (!SOURCES.includes(raw.source as RecordSource)) return bad('source が違います');
  if (raw.batch !== undefined && typeof raw.batch !== 'string') return bad('batch が違います');

  const outcome = checkOutcome(raw.outcome);
  if (outcome !== null) return bad(outcome);

  if (version === 1) {
    // Neutral atoms, which is what a record without `charges` means.
    const neutral = { ...raw };
    delete neutral.charges;
    return { record: neutral as unknown as StructureRecord };
  }
  const total = (raw.outcome as { charge: number }).charge;
  const charges = checkCharges(raw.charges, raw.z.length, total);
  if (charges !== null) return bad(charges);
  return { record: raw as unknown as StructureRecord };
}

/**
 * Null when `raw` is one charge per atom that adds up to the outcome's total -
 * or is all neutral, which is how a record from before v7 is written whatever
 * total the engine picked for it then.
 */
function checkCharges(raw: unknown, atoms: number, total: number): string | null {
  if (!Array.isArray(raw)) return '原子ごとの電荷がありません';
  if (raw.length !== atoms) return '原子ごとの電荷の数が原子の数と合いません';
  if (!raw.every((charge) => charge === -1 || charge === 0 || charge === 1)) {
    return '原子ごとの電荷が −1・0・+1 ではありません';
  }
  const sum = raw.reduce((sum: number, charge: number) => sum + charge, 0);
  if (sum !== total && raw.some((charge) => charge !== 0)) {
    return '原子ごとの電荷の和が計算結果の電荷と合いません';
  }
  return null;
}

/** Null when the outcome is one this program could have produced. */
function checkOutcome(raw: unknown): string | null {
  if (!isObject(raw)) return '計算結果がありません';
  if (raw.converged !== true) return '収束していない計算は記録にできません';
  for (const field of [
    'iterations',
    'multiplicity',
    'charge',
    'attempts',
    'energy',
    'basisFunctions',
    'electronsOnGrid',
    'elapsedMs',
  ] as const) {
    if (!Number.isFinite(raw[field])) return `計算結果の ${field} が数ではありません`;
  }
  if (raw.homoLumoGap !== null && !Number.isFinite(raw.homoLumoGap)) {
    return '計算結果の homoLumoGap が数ではありません';
  }
  if (!isObject(raw.components)) return '計算結果の内訳がありません';
  for (const field of ['core', 'coulomb', 'exchangeCorrelation', 'nuclearRepulsion'] as const) {
    if (!Number.isFinite(raw.components[field])) return `計算結果の ${field} が数ではありません`;
  }
  const optimization = raw.optimization;
  // Every record is a relaxation, and one that found no self-consistent density
  // is never kept: it has no structure and no numbers to show (requirement F5).
  if (!isObject(optimization)) return '構造最適化の結果がありません';
  if (!REASONS.includes(optimization.reason as OptimizationReason)) {
    return '構造最適化の終わり方が違います';
  }
  if (optimization.reason === 'scf') return '電子が解けなかった計算は記録にできません';
  if (typeof optimization.converged !== 'boolean') return '構造最適化の converged が違います';
  if (!Number.isInteger(optimization.steps) || (optimization.steps as number) < 0) {
    return '構造最適化の steps が違います';
  }
  if (!Number.isFinite(optimization.maxForce)) return '構造最適化の maxForce が違います';
  if (!isNumbers(optimization.xyz)) return '構造最適化の座標がありません';
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumbers(value: unknown, length?: number): value is number[] {
  if (!Array.isArray(value)) return false;
  if (length !== undefined && value.length !== length) return false;
  return value.every((v) => Number.isFinite(v));
}

function bad(detail: string): Checked {
  // The index is filled in by the caller, which is the one that knows it.
  return { problem: { kind: 'shape', detail, index: 0 } };
}

function fail(problem: ImportProblem): ImportResult {
  return { ok: false, problem };
}
