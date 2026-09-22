/**
 * One entry in the structure log: a shape the molecule settled into, and
 * everything needed to put it back on screen without calculating it again.
 *
 * A record is made every time "安定な形にする" finishes with a structure worth
 * keeping (`hasUsableStructure`), so that a class can go back and compare the
 * valleys a molecule fell into - which is the point of the log: not archiving,
 * but "you started it there and it came out here, and this one is deeper".
 *
 * Two things in a record are diagnostics rather than interface. The whole
 * `ScfOutcome` is kept, charge and multiplicity included, because a record has
 * to reproduce what was on screen; requirement F4 keeps those off the screen,
 * here as everywhere else. The charge is also the one DFT parameter the log
 * *uses*: two runs of the same atoms that the engine had to give different
 * charges are not the same system and their energies cannot be subtracted, so
 * it goes into {@link comparisonKey} without ever being shown.
 */
import type { ModelLevel, ScfOutcome } from '../worker/protocol';

/**
 * What the engine is at each level, as strings a record can be compared on.
 *
 * Energies from different bases or functionals are not on the same scale, so
 * records made with one must never be ranked against another's - and the two
 * levels are two bases (`ModelLevel`). There is no way to ask the WebAssembly
 * module what it is, so these are written here and **changed whenever the
 * basis, the functional or the optimiser's grid changes** - see CLAUDE.md.
 * Records carrying an older string stay readable and simply group apart; for
 * them still to open at their own level, the older string has to stay known to
 * {@link levelOfModel} as the level it was.
 *
 * The string for "形を探す" is the one every record before V3-5 was written with,
 * so those records fall into its groups as they are.
 */
const ENGINE_MODELS: Readonly<Record<ModelLevel, string>> = {
  shape: 'sto-3g/lda-vwn5/fine',
  measure: '6-31gs/lda-vwn5/fine',
};

/** The model a record made at `level` carries. */
export function engineModel(level: ModelLevel): string {
  return ENGINE_MODELS[level];
}

/**
 * The level a record was calculated at, from the model it carries.
 *
 * Null for a string this program never wrote. Such a record cannot be solved
 * again at its own level - which is what opening one with its surface does - so
 * a file carrying one is refused (`file.ts`), and the App opens one already in
 * the browser with its numbers and no surface.
 */
export function levelOfModel(model: string): ModelLevel | null {
  for (const level of Object.keys(ENGINE_MODELS) as ModelLevel[]) {
    if (ENGINE_MODELS[level] === model) return level;
  }
  return null;
}

/** Where a record came from: the button, or (P10) a background search. */
export type RecordSource = 'manual' | 'search';

export interface StructureRecord {
  id: string;
  /** ISO 8601, in UTC. */
  savedAt: string;
  /** Shown in the list and editable; defaults to formula and time of day. */
  name: string;
  /**
   * {@link engineModel} of the level it was calculated at, as it was when this
   * was recorded. The level itself is read back from this ({@link levelOfModel})
   * rather than kept beside it, so the two cannot disagree.
   */
  model: string;
  /** Hill formula, with subscript digits, as the interface spells it. */
  formula: string;
  /** Atomic numbers, in the order every coordinate list below uses. */
  z: number[];
  /** The structure the user built, in Angstrom - before the nudge. */
  built: number[];
  /**
   * Every geometry the optimiser accepted, in Angstrom, rounded to
   * {@link TRAJECTORY_DECIMALS} places so the file stays small. Index 0 is the structure as
   * submitted, which is the nudged one when it was nudged (`perturb.ts`).
   */
  trajectory: number[][];
  /** Total energy in Hartree at each geometry of `trajectory`. */
  stepEnergies: number[];
  /** The geometry it ended on, at full precision: this is what gets restored. */
  final: number[];
  outcome: ScfOutcome;
  source: RecordSource;
  /** Set when several candidates were started together (P10). */
  batch?: string;
}

/**
 * Decimal places kept for trajectory coordinates, in Angstrom.
 *
 * It is a replay of an animation, not a structure anyone measures: a ten
 * thousandth of an Angstrom is already finer than what the optimiser's own
 * convergence leaves, and it keeps a twenty-step benzene from filling the file
 * with digits nobody will look at. The final structure is kept whole.
 */
export const TRAJECTORY_DECIMALS = 4;

/**
 * Whether this record is a structure that came to rest.
 *
 * The other kind - out of time, out of steps - is a real structure that the
 * electrons were solved for at every geometry along the way, so it is kept and
 * shown; it is just not a minimum, so it is not ranked against ones that are
 * and does not count towards a valley.
 */
export function isSettled(record: StructureRecord): boolean {
  return record.outcome.optimization?.reason === 'converged';
}

/**
 * The records that may be compared with this one: same molecule, same charge,
 * same engine - which includes the same level, since each level is its own
 * {@link engineModel}.
 *
 * Same molecule means the same formula, not the same structure - that is the
 * whole point. Charge is in here because the engine picks it: a molecule it
 * could only solve as an ion has a different number of electrons, and the
 * energies are not differences of the same thing. It never reaches the screen.
 */
export function comparisonKey(record: StructureRecord): string {
  return `${record.model}|${record.outcome.charge}|${record.formula}`;
}

/**
 * The formula in Hill order: carbon, then hydrogen, then everything else
 * alphabetically - and with no carbon, everything alphabetically.
 *
 * `symbolOf` comes from the engine's element table rather than from a list
 * here, so the spelling is the one the picker and the 3D view use.
 */
export function hillFormula(z: readonly number[], symbolOf: (z: number) => string): string {
  const counts = new Map<string, number>();
  for (const atomic of z) {
    const symbol = symbolOf(atomic);
    counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
  }
  const rest = [...counts.keys()].filter((s) => s !== 'C' && s !== 'H').sort();
  const order = counts.has('C')
    ? ['C', ...(counts.has('H') ? ['H'] : []), ...rest]
    : [...counts.keys()].sort();
  return order
    .map((symbol) => symbol + (counts.get(symbol) === 1 ? '' : subscript(counts.get(symbol)!)))
    .join('');
}

/** Digits as the subscripts the rest of the interface writes formulas with. */
function subscript(n: number): string {
  return String(n).replace(/\d/g, (d) => '₀₁₂₃₄₅₆₇₈₉'[Number(d)]);
}

/**
 * What a new record is called until someone renames it: the formula and the
 * time of day, which is what tells two runs of the same molecule apart during a
 * lecture.
 */
export function defaultRecordName(formula: string, savedAt: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${formula} · ${two(savedAt.getHours())}:${two(savedAt.getMinutes())}`;
}

/** Everything about a finished relaxation that only the App knows. */
export interface RecordDraft {
  z: number[];
  built: number[];
  /** As the steps arrived, in Angstrom. */
  trajectory: ArrayLike<number>[];
  stepEnergies: number[];
  outcome: ScfOutcome;
  /** What the relaxation was solved at: the one choice a record must not guess. */
  level: ModelLevel;
  source?: RecordSource;
  batch?: string;
}

/**
 * Turns a finished relaxation into a record.
 *
 * `id` and `savedAt` are arguments so that a test can say which record it is
 * talking about; the App leaves them out.
 */
export function createRecord(
  draft: RecordDraft,
  symbolOf: (z: number) => string,
  savedAt: Date = new Date(),
  id: string = crypto.randomUUID(),
): StructureRecord {
  const formula = hillFormula(draft.z, symbolOf);
  return {
    id,
    savedAt: savedAt.toISOString(),
    name: defaultRecordName(formula, savedAt),
    model: engineModel(draft.level),
    formula,
    z: [...draft.z],
    built: [...draft.built],
    trajectory: draft.trajectory.map((frame) => Array.from(frame, roundStep)),
    stepEnergies: [...draft.stepEnergies],
    final: [...(draft.outcome.optimization?.xyz ?? [])],
    outcome: draft.outcome,
    source: draft.source ?? 'manual',
    ...(draft.batch === undefined ? {} : { batch: draft.batch }),
  };
}

function roundStep(value: number): number {
  const scale = 10 ** TRAJECTORY_DECIMALS;
  return Math.round(value * scale) / scale;
}
