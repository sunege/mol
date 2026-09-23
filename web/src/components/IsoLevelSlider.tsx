/**
 * Threshold control for the electron-density surfaces.
 *
 * The interesting densities span more than two orders of magnitude - the
 * contour that outlines a molecule's shape sits near 0.002 electrons per cubic
 * Bohr, the one that shows where the bonds are near 0.2 - so the slider is
 * logarithmic. A linear one would spend nine tenths of its travel on levels
 * that all look the same.
 *
 * Each channel gets its own range, because what a bonding surface is made of is
 * an order of magnitude thinner than the total density. The range is keyed on
 * what the user asked for rather than on what the engine chose to show, so it
 * never shifts under their finger once they start dragging.
 */
import type { DensityRequest } from '../worker/protocol';

/** Levels worth sliding through, in electrons per cubic Bohr. */
export interface IsoRange {
  min: number;
  max: number;
  /** Where the slider starts: a level that shows something for most molecules. */
  initial: number;
}

export const ISO_RANGES: Record<DensityRequest, IsoRange> = {
  // From roughly the van der Waals surface down to lobes hugging the nuclei.
  total: { min: 0.002, max: 0.5, initial: 0.05 },
  // A pi system peaks near 0.19, and a deformation density is smaller still
  // away from the nuclei, so the useful levels stop much sooner.
  bonding: { min: 0.002, max: 0.15, initial: 0.02 },
  // The same range: a bonding request is answered with one or the other of
  // these two densities, so the levels that show something are the same ones.
  deformation: { min: 0.002, max: 0.15, initial: 0.02 },
};

/** Slider stops. Its positions are integers so the control steps evenly. */
export const ISO_STEPS = 200;

/** Slider position, 0 to [`ISO_STEPS`], for a density level. */
export function positionOf(level: number, range: IsoRange): number {
  const clamped = Math.min(Math.max(level, range.min), range.max);
  const fraction = Math.log(clamped / range.min) / Math.log(range.max / range.min);
  return Math.round(fraction * ISO_STEPS);
}

/** Density level, in electrons per cubic Bohr, for a slider position. */
export function levelAt(position: number, range: IsoRange): number {
  const fraction = Math.min(Math.max(position, 0), ISO_STEPS) / ISO_STEPS;
  return range.min * Math.pow(range.max / range.min, fraction);
}

export interface IsoLevelSliderProps {
  /** Current level, in electrons per cubic Bohr. */
  value: number;
  range: IsoRange;
  onChange: (level: number) => void;
  disabled?: boolean;
}

export function IsoLevelSlider({ value, range, onChange, disabled }: IsoLevelSliderProps) {
  return (
    <div className="iso-slider">
      <input
        type="range"
        min={0}
        max={ISO_STEPS}
        step={1}
        value={positionOf(value, range)}
        disabled={disabled}
        aria-label="等値面のしきい値"
        onChange={(event) => onChange(levelAt(Number(event.target.value), range))}
      />
      <div className="iso-slider-scale">
        <span>広がり</span>
        <span className="iso-slider-value">{value.toFixed(3)}</span>
        <span>密な芯</span>
      </div>
    </div>
  );
}
