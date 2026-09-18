/**
 * Message contract between the UI thread and the DFT worker.
 *
 * Every request carries an `id` that the matching responses echo back, so a
 * single worker can serve overlapping requests (a pending isosurface redraw
 * while a new geometry is being submitted, for example).
 *
 * Coordinates crossing this boundary are always in Angstrom; the engine
 * converts to Bohr internally.
 */

export interface ElementInfo {
  z: number;
  symbol: string;
  mass: number;
  covalentRadius: number;
  vdwRadius: number;
  /** Packed 0xRRGGBB, as Three.js Color accepts. */
  color: number;
}

export type WorkerRequest =
  | { id: number; type: 'elements' }
  | { id: number; type: 'nuclearRepulsion'; z: Uint8Array; xyz: Float64Array };

export type WorkerResponse =
  /** Emitted once, unsolicited, when the WASM module has finished loading. */
  | { id: 0; type: 'ready' }
  | { id: number; type: 'elements'; elements: ElementInfo[] }
  | { id: number; type: 'nuclearRepulsion'; energy: number }
  | { id: number; type: 'error'; message: string };
