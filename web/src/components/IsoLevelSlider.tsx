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
 *
 * The words at the two ends say what the level means, so they belong to the
 * caller: a density thins out from the whole molecule to the core at its
 * nuclei, and an orbital has no core to walk in towards
 * (`components/orbital.ts`).
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
  // An orbital is an amplitude rather than a density, and one orbital's is
  // larger than the share of the density it carries: a lobe of ethylene's pi
  // peaks near 0.3. Both ends were measured on every orbital of water, O2,
  // ethylene, benzene, NH3, CH4 and formaldehyde (`docs/dev-notes.md`, "V4-9
  // の実測"). The floor is where no surface reaches the edge of the sampled box
  // any more: ethylene's pi and pi* still touch it at 0.01 and are clear at
  // 0.012, formaldehyde's pi* touches at 0.008 - below that the lobes come out
  // cut open by a flat face. The ceiling is under the weakest valence orbital:
  // benzene's eleventh peaks at 0.143 on the lattice, so at the old ceiling of
  // 0.15 it drew nothing at all, and at 0.1 every orbital still shows both of
  // its signs. The initial level shows every HOMO measured with its lobes apart.
  orbital: { min: 0.015, max: 0.1, initial: 0.03 },
};

/** What the two ends of the scale mean, for whatever the slider is cutting. */
export interface IsoScale {
  /** The low end, where the surface is at its widest. */
  low: string;
  /** The high end, where only the strongest part of it is left. */
  high: string;
}

/** The ends of a density's scale, which is what most of the panel slides. */
export const DENSITY_SCALE: IsoScale = { low: '広がり', high: '密な芯' };

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
  /** What the ends of the travel mean. A density's, unless one is given. */
  scale?: IsoScale;
  onChange: (level: number) => void;
  disabled?: boolean;
}

export function IsoLevelSlider({
  value,
  range,
  scale = DENSITY_SCALE,
  onChange,
  disabled,
}: IsoLevelSliderProps) {
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
        <span>{scale.low}</span>
        <span className="iso-slider-value">{value.toFixed(3)}</span>
        <span>{scale.high}</span>
      </div>
    </div>
  );
}
