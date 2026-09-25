/// <reference lib="webworker" />
/**
 * Runs the WebAssembly DFT engine off the UI thread.
 *
 * The worker owns the WASM instance and the converged calculation, which is
 * what makes the isosurface threshold cheap to move: the SCF result and the
 * sampled density stay here, and a new threshold sends back only a mesh.
 *
 * It never throws across the message boundary: failures come back as `error`
 * responses, and a non-converged SCF is a normal `scf` response with
 * `converged: false`.
 *
 * A geometry optimisation streams: the engine calls back into JavaScript for
 * every structure it accepts, and each of those is posted immediately. The
 * computation is synchronous and blocks this worker's message loop, but
 * `postMessage` is not - the frames reach the UI thread while the next step is
 * still being solved, which is what lets a slow molecule still animate.
 *
 * The same goes for `progress`: the engine says which part of the work it is
 * starting, and that is posted as it happens, so the interface can name the
 * wait while the atoms stand still.
 */
import init, {
  supportedElements,
  scf,
  optimize,
  scan,
  atomLevels,
  type Calculation,
} from '../wasm/dft_wasm.js';
import wasmUrl from '../wasm/dft_wasm_bg.wasm?url';
import { MAX_SCAN_POINTS, progressFromEngine, stopRequested } from './protocol';
import type {
  DensityChannel,
  ElementInfo,
  IsoMesh,
  OrbitalLevel,
  ScanPoint,
  ScfOutcome,
  WorkerRequest,
  WorkerResponse,
} from './protocol';

/** What the engine hands the step callback, before it is put on the wire. */
interface RawStep {
  step: number;
  /** Angstrom, flattened. */
  xyz: number[];
  energy: number;
  maxForce: number;
}

const post = (message: WorkerResponse, transfer: Transferable[] = []) =>
  self.postMessage(message, transfer);

/** The engine's progress callback, posting each report under the request's id. */
const reportProgress = (id: number) => (stage: string, step: number) => {
  const progress = progressFromEngine(stage, step);
  if (progress) post({ id, type: 'progress', progress });
};

// A module that cannot be loaded - a browser without WebAssembly SIMD, a failed
// download - is reported rather than left to hang: the client would otherwise
// wait for `ready` forever, and every request with it.
const ready = init({ module_or_path: wasmUrl }).then(
  () => post({ id: 0, type: 'ready' }),
  (error: unknown) =>
    post({
      id: 0,
      type: 'unavailable',
      message: error instanceof Error ? error.message : String(error),
    }),
);

/**
 * The most recent converged calculation, which the isosurface requests draw
 * from. WASM memory is not garbage collected, so the previous one is released
 * explicitly before it is replaced.
 */
let current: Calculation | null = null;

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    await ready;
    switch (request.type) {
      case 'elements':
        post({
          id: request.id,
          type: 'elements',
          elements: supportedElements() as ElementInfo[],
        });
        break;
      case 'scf': {
        // Timed here rather than in Rust: `std::time::Instant` is not available
        // on wasm32-unknown-unknown.
        const started = performance.now();
        const calculation = scf(request.z, request.xyz, reportProgress(request.id), request.level);
        current?.free();
        current = calculation;
        const result = calculation.summary() as Omit<ScfOutcome, 'elapsedMs'>;
        if (import.meta.env.DEV) {
          // The one place the chosen spin state is visible. It must not reach
          // the interface (requirement F4), but a developer checking that O2
          // really was solved as a triplet has to be able to see it somewhere.
          console.debug(
            `[dft] charge ${result.charge}, multiplicity ${result.multiplicity}` +
              ` after ${result.attempts} state(s), converged=${result.converged}`,
          );
        }
        post({
          id: request.id,
          type: 'scf',
          result: { ...result, elapsedMs: performance.now() - started },
        });
        break;
      }
      case 'optimize': {
        const started = performance.now();
        // A budget shorter than the engine's own is enforced from here, because
        // the engine's is a Rust constant. Throwing out of the step callback is
        // what stops a relaxation from JavaScript: the engine takes a callback
        // that threw as "there is nobody left to send steps to" and ends the
        // relaxation where it is, with `reason: 'interrupted'` and the structure
        // it had reached - which is the whole point, since terminating the
        // worker would throw that structure away with it. Like the engine's own
        // budget it is only tested between steps, so a single step always runs
        // to the end.
        //
        // The user's 中止 takes the same way out, through the flag the page
        // shares with this worker: the one thing that reaches it while the
        // relaxation is blocking its message loop. The calculation it ends on
        // is kept like any other, so the surface can still be cut from it.
        const deadline =
          request.budgetMs === undefined || request.budgetMs === null
            ? Infinity
            : started + request.budgetMs;
        const calculation = optimize(
          request.z,
          request.xyz,
          (raw: RawStep) => {
            // A fresh array each time, so it can be transferred rather than
            // copied; the worker has no use for it afterwards.
            const xyz = new Float32Array(raw.xyz);
            post(
              {
                id: request.id,
                type: 'step',
                step: {
                  step: raw.step,
                  xyz,
                  energy: raw.energy,
                  maxForce: raw.maxForce,
                },
              },
              [xyz.buffer],
            );
            if (performance.now() >= deadline) throw new Error('candidate budget');
            if (stopRequested(request.stop)) throw new Error('stopped by the user');
          },
          reportProgress(request.id),
          request.level,
        );
        current?.free();
        current = calculation;
        const result = calculation.summary() as Omit<ScfOutcome, 'elapsedMs'>;
        if (import.meta.env.DEV) {
          console.debug(
            `[dft] relaxed in ${result.optimization?.steps ?? 0} step(s), ` +
              `${result.optimization?.reason}, multiplicity ${result.multiplicity}`,
          );
        }
        post({
          id: request.id,
          type: 'scf',
          result: { ...result, elapsedMs: performance.now() - started },
        });
        break;
      }
      case 'orbitals': {
        if (!current) throw new Error('no calculation to read the orbitals of');
        // No lattice and no SCF: a few matrix products on a calculation that is
        // already solved, so this answers in the same tick it arrives in.
        post({
          id: request.id,
          type: 'orbitals',
          levels: current.orbitals() as OrbitalLevel[],
        });
        break;
      }
      case 'orbitalCharacter': {
        if (!current) throw new Error('no calculation to read an orbital of');
        // No lattice here either: sums over the basis functions of pairs of
        // atoms, and one evaluation of the orbital per nucleus.
        const character = current.orbitalCharacter(request.index, request.spin);
        const populations = character.populations;
        // The engine returns nothing at all for a molecule with no plane to
        // probe above; the contract says null.
        const amplitudes = character.amplitudes ?? null;
        character.free();
        post(
          { id: request.id, type: 'orbitalCharacter', populations, amplitudes },
          amplitudes === null
            ? [populations.buffer]
            : [populations.buffer, amplitudes.buffer],
        );
        break;
      }
      case 'scan': {
        // The one request that runs a calculation per answer. Nothing it does
        // touches `current`: the scan solves its own geometries and keeps none
        // of them, so a surface already on screen survives it. The user's way
        // of stopping it is the other one - the worker is terminated, and the
        // held calculation goes with it.
        if (
          !Number.isInteger(request.points) ||
          request.points < 1 ||
          request.points > MAX_SCAN_POINTS
        ) {
          throw new Error(
            `a distance scan takes 1 to ${MAX_SCAN_POINTS} points, not ${request.points}`,
          );
        }
        const started = performance.now();
        // The same budget as a relaxation's, enforced the same way: throwing
        // out of the callback ends the scan where it is, and the points already
        // posted stand. Only tested between points, so one point always runs to
        // the end.
        const deadline =
          request.budgetMs === undefined || request.budgetMs === null
            ? Infinity
            : started + request.budgetMs;
        scan(request.z, request.from, request.to, request.points, (point: ScanPoint) => {
          post({ id: request.id, type: 'scanPoint', point });
          if (performance.now() >= deadline) throw new Error('scan budget');
        });
        post({ id: request.id, type: 'scanDone' });
        break;
      }
      case 'atomLevels': {
        // About the elements rather than about anything on screen, so it needs
        // no calculation loaded: a handful of tiny atomic SCFs.
        post({
          id: request.id,
          type: 'atomLevels',
          levels: atomLevels(request.z) as number[][],
        });
        break;
      }
      case 'isosurface': {
        if (!current) throw new Error('no calculation to draw a surface from');
        const started = performance.now();
        // `orbital`, `spin`, `atom` and `along` are read only for the orbital
        // channel; a density ignores them, and the engine refuses a spin the
        // calculation has no orbitals for rather than drawing the other one.
        // The direction crosses as a typed array, which is how wasm-bindgen
        // takes a `Vec<f64>`; the engine checks it is three numbers.
        const iso = current.isosurface(
          request.channel,
          request.isoLevel,
          request.orbital,
          request.spin,
          request.atom,
          request.along ? Float64Array.from(request.along) : undefined,
        );
        // Each getter copies its buffer out of WASM memory into a plain
        // ArrayBuffer, so the meshes can be transferred rather than cloned.
        const mesh: IsoMesh = {
          channel: iso.channel as DensityChannel,
          isoLevel: iso.isoLevel,
          positive: {
            positions: iso.positivePositions,
            normals: iso.positiveNormals,
            indices: iso.positiveIndices,
          },
          negative: {
            positions: iso.negativePositions,
            normals: iso.negativeNormals,
            indices: iso.negativeIndices,
          },
          densityMax: iso.densityMax,
          densityMin: iso.densityMin,
          lobes: { positive: iso.lobesPositive, negative: iso.lobesNegative },
          elapsedMs: performance.now() - started,
        };
        iso.free();
        post({ id: request.id, type: 'mesh', mesh }, [
          mesh.positive.positions.buffer,
          mesh.positive.normals.buffer,
          mesh.positive.indices.buffer,
          mesh.negative.positions.buffer,
          mesh.negative.normals.buffer,
          mesh.negative.indices.buffer,
        ]);
        break;
      }
    }
  } catch (error) {
    post({
      id: request.id,
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
