/**
 * The words of the observe section of the panel.
 *
 * Only geometry is ever shown here - lengths in Angstrom and angles in degrees
 * - which is all requirement F4 allows beyond the energy.
 */
import {
  formatMeasurement,
  formatValue,
  UNITS,
  type Measurement,
  type MeasurementKind,
} from '../scene/measure';

export const KIND_LABELS: Record<MeasurementKind, string> = {
  distance: '距離',
  angle: '角度',
  dihedral: '二面角',
};

/**
 * The value, or how it changed: `1.512 Å` on its own, `1.540 → 1.512 Å` when
 * there is a value from before the relaxation to compare with.
 */
export function readout(now: Measurement | null, before: Measurement | null): string {
  if (now === null) return '—';
  if (before === null || before.kind !== now.kind) return formatMeasurement(now);
  if (before.value !== null && now.value !== null) {
    return `${formatValue(before.kind, before.value)} → ${formatValue(now.kind, now.value)}${UNITS[now.kind]}`;
  }
  // One side is undefined (a dihedral straightening out, or the reverse), so
  // each side carries its own unit, or none.
  return `${formatMeasurement(before)} → ${formatMeasurement(now)}`;
}

/** The picked atoms in order, e.g. `H–C–H`, so the vertex of an angle is visible. */
export function atomPath(symbols: readonly string[]): string {
  return symbols.join('–');
}

/** What clicking another atom will do, given how many are picked. */
export function pickingHint(count: number): string {
  switch (count) {
    case 0:
      return '原子をクリックして選ぶと、2 個で距離、3 個で角度、4 個で二面角を測ります。';
    case 1:
      return 'もう 1 個クリックすると、2 つの原子の距離を測ります。';
    case 2:
      return '3 個目をクリックすると角度になります（2 番目に選んだ原子が頂点）。';
    case 3:
      return '4 個目をクリックすると二面角（2・3 番目の原子を結ぶ軸のまわりのねじれ）になります。';
    default:
      return '選んだ原子をもう一度クリックすると外れます。別の原子をクリックすると、そこから選び直します。';
  }
}

/** Why a measurement shows a dash, when it does. */
export function undefinedReason(now: Measurement | null): string | null {
  if (now === null || now.value !== null) return null;
  if (now.kind === 'dihedral') {
    return '3 つの原子がほぼ一直線に並んでいるため、二面角は決まりません。';
  }
  return '原子が重なっているため、測れません。';
}

/**
 * The explanation under a before-and-after readout: which number is which.
 */
export const BEFORE_AFTER_HINT = '左が「安定な形にする」を押したときの値、右が今の値です。';
