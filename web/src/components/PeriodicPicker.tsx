import type { ElementInfo } from '../worker/protocol';
import './PeriodicPicker.css';

/**
 * Element picker for the supported range H-Ar.
 *
 * Laid out as a short-form periodic table: since only main-group elements are
 * in scope, the ten transition-metal columns are absent entirely, so eight
 * columns place every element in its real group without shrinking the cells.
 */

/** Period (row) and group column 1-8 for an element in H-Ar. */
export function tablePosition(z: number): { row: number; column: number } {
  if (z <= 2) return { row: 1, column: z === 1 ? 1 : 8 };
  if (z <= 10) return { row: 2, column: z - 2 };
  return { row: 3, column: z - 10 };
}

interface Props {
  elements: ElementInfo[];
  value: number;
  onChange: (z: number) => void;
}

export function PeriodicPicker({ elements, value, onChange }: Props) {
  return (
    <div className="periodic">
      {elements.map((element) => {
        const { row, column } = tablePosition(element.z);
        return (
          <button
            key={element.z}
            type="button"
            className={element.z === value ? 'cell active' : 'cell'}
            style={{
              gridRow: row,
              gridColumn: column,
              '--element-color': `#${element.color.toString(16).padStart(6, '0')}`,
            } as React.CSSProperties}
            onClick={() => onChange(element.z)}
            title={`${element.symbol} (Z = ${element.z})`}
            aria-pressed={element.z === value}
          >
            <span className="z">{element.z}</span>
            <span className="symbol">{element.symbol}</span>
          </button>
        );
      })}
    </div>
  );
}
