/**
 * The structure log as the panel shows it: records gathered into the sets that
 * may be compared, and within a set, sorted into valleys.
 *
 * The question the log answers is "which of these shapes is the deepest, and
 * how many different ones did we find". So two things happen here. Records that
 * cannot be compared - a different molecule, a different charge, a different
 * engine or level - are kept apart (`comparisonKey`); and
 * within a set, records whose energies are within {@link SAME_VALLEY_KJ_PER_MOL}
 * of each other are one valley, because the same minimum reached from two
 * directions does not come out to the same digit.
 *
 * Only settled structures take part. One that ran out of time or steps is real
 * and is listed, but it was still moving when it stopped: ranking it against a
 * minimum would be comparing a finished thing with an unfinished one.
 */
import type { ModelLevel } from '../worker/protocol';
import {
  comparisonKey,
  headingOf,
  isSettled,
  levelOfModel,
  type StructureRecord,
} from './record';
import { kilojoulesPerMole } from './units';

/**
 * Energies closer than this are the same valley, in kJ/mol.
 *
 * Measured (`docs/dev-notes.md`, "P9 の実測"): the same minimum reached from
 * different nudges came out within 0.03 kJ/mol at worst, since the optimiser
 * stops at slightly different points along the way. This is thirty times that,
 * and still far below anything a lecture would want told apart - the rotation
 * barrier of ethane is about 12 kJ/mol, the inversion of ammonia 39.
 */
export const SAME_VALLEY_KJ_PER_MOL = 1;

export interface LogEntry {
  record: StructureRecord;
  /** False for a structure that ran out of time or steps. */
  settled: boolean;
  /**
   * Which valley of its group this is, deepest first, or null when it did not
   * settle. Records sharing a valley share a number.
   */
  valley: number | null;
  /** How many records of the group are in this one's valley. */
  valleySize: number | null;
  /**
   * How far above the group's deepest settled structure, in kJ/mol. Zero for
   * the deepest itself, null for a structure that did not settle.
   */
  relative: number | null;
}

export interface LogGroup {
  /** Internal, and not shown: it carries the model string. */
  key: string;
  /** What the group is called on screen: the formula with its charge (`headingOf`). */
  formula: string;
  /**
   * What its records were calculated for, which the heading says in the words
   * of the choice. Null for a model this program does not know
   * (`levelOfModel`); every record of a group has the same model.
   */
  level: ModelLevel | null;
  /** Settled entries first, deepest valley first; then the unsettled ones. */
  entries: LogEntry[];
  /** Distinct valleys among the settled records. */
  valleys: number;
  /** The most recent `savedAt` in the group, which is how groups are ordered. */
  latest: string;
}

/**
 * Gathers records into comparable groups, newest group first.
 *
 * Within a group the settled records come first, deepest valley first and
 * oldest first inside a valley (so the one that found it is at the top), then
 * the unsettled ones, newest first.
 */
export function groupRecords(records: readonly StructureRecord[]): LogGroup[] {
  const groups = new Map<string, StructureRecord[]>();
  for (const record of records) {
    const key = comparisonKey(record);
    const existing = groups.get(key);
    if (existing) existing.push(record);
    else groups.set(key, [record]);
  }

  const built = [...groups].map(([key, members]) => {
    const settled = members
      .filter(isSettled)
      .sort((a, b) => a.outcome.energy - b.outcome.energy || compareSaved(a, b));
    const unsettled = members.filter((record) => !isSettled(record)).sort(compareLatest);

    // Sorted by energy, a record opens a new valley when it is more than the
    // threshold above the deepest record of the one before it.
    const valleyOf = new Map<string, number>();
    const sizes: number[] = [];
    let floor = Number.NEGATIVE_INFINITY;
    for (const record of settled) {
      const above = kilojoulesPerMole(record.outcome.energy - floor);
      if (!Number.isFinite(above) || above > SAME_VALLEY_KJ_PER_MOL) {
        floor = record.outcome.energy;
        sizes.push(0);
      }
      valleyOf.set(record.id, sizes.length - 1);
      sizes[sizes.length - 1] += 1;
    }

    const deepest = settled[0]?.outcome.energy;
    const entries: LogEntry[] = [
      ...settled.map((record) => {
        const valley = valleyOf.get(record.id)!;
        return {
          record,
          settled: true,
          valley,
          valleySize: sizes[valley],
          relative: kilojoulesPerMole(record.outcome.energy - deepest!),
        };
      }),
      ...unsettled.map((record) => ({
        record,
        settled: false,
        valley: null,
        valleySize: null,
        relative: null,
      })),
    ];

    return {
      key,
      formula: headingOf(members[0]),
      level: levelOfModel(members[0].model),
      entries,
      valleys: sizes.length,
      latest: members.reduce((newest, r) => (r.savedAt > newest ? r.savedAt : newest), ''),
    };
  });

  return built.sort((a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0));
}

/**
 * The entry for one record, and the group it is compared inside.
 *
 * What the search section needs: a candidate becomes a record under its own id,
 * and the row wants to say how deep the shape it found is - which is a fact
 * about the group, not about the record on its own.
 */
export function entryFor(
  groups: readonly LogGroup[],
  recordId: string,
): { entry: LogEntry; group: LogGroup } | null {
  for (const group of groups) {
    const entry = group.entries.find((each) => each.record.id === recordId);
    if (entry) return { entry, group };
  }
  return null;
}

/** The group these records belong with, if the log has one. */
export function groupFor(groups: readonly LogGroup[], key: string): LogGroup | null {
  return groups.find((group) => group.key === key) ?? null;
}

function compareSaved(a: StructureRecord, b: StructureRecord): number {
  return a.savedAt < b.savedAt ? -1 : a.savedAt > b.savedAt ? 1 : 0;
}

function compareLatest(a: StructureRecord, b: StructureRecord): number {
  return -compareSaved(a, b);
}
