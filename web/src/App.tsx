import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MoleculeViewer, type SceneAtom } from './scene/viewer';
import { probeWebGl, type WebGlProbe } from './scene/webgl';
import { keyAction, type ViewerMode } from './scene/gestures';
import { measureAtoms, toggleMeasured } from './scene/measure';
import { LiveMeasurement } from './scene/liveMeasurement';
import { DftWorkerClient, RelaxationStopped } from './worker/workerClient';
import { PRESETS, toWorkerArrays } from './molecules/presets';
import { PeriodicPicker } from './components/PeriodicPicker';
import { ISO_RANGES, IsoLevelSlider } from './components/IsoLevelSlider';
import { Elapsed, ProgressOverlay } from './components/ProgressOverlay';
import { ObservePanel } from './components/ObservePanel';
import { headline, type JobKind, type JobState } from './components/progress';
import { divergenceFrames } from './animation/divergence';
import { FramePlayer } from './animation/framePlayer';
import { needsNudge, perturb, randomSeed, PERTURB_AMPLITUDE } from './records/perturb';
import {
  createRecord,
  hillFormula,
  levelOfModel,
  type StructureRecord,
} from './records/record';
import { entryFor, groupRecords } from './records/log';
import { openRecordStore, type RecordStore } from './records/store';
import { mergeRecords, readStructureLog, writeStructureLog } from './records/file';
import { RecordsPanel } from './components/RecordsPanel';
import { exportFileName, importProblemText, importedText, settledCount } from './components/records';
import { SearchPanel } from './components/SearchPanel';
import { NUDGED_COUNT } from './components/search';
import {
  DEFAULT_LEVEL,
  LEVEL_GROUP_LABEL,
  LEVEL_ORDER,
  levelAdvice,
  levelHint,
  levelLabel,
} from './components/level';
import { SEARCH_LEVEL, SearchPool, poolSize, type Candidate } from './search/pool';
import { candidateAsBuilt, nudgedCandidates } from './search/candidates';
import { hasUsableStructure } from './worker/protocol';
import { EngineUnavailableError, engineNotice, type EngineProblem } from './worker/engineSupport';
import type {
  CalculationProgress,
  DensityChannel,
  DensityRequest,
  ElementInfo,
  IsoMesh,
  ModelLevel,
  OptimizationOutcome,
  ScfOutcome,
} from './worker/protocol';
import './App.css';

/**
 * What the frame player is showing.
 *
 * The two differ in what they leave behind. A divergence is a picture: the
 * molecule comes apart and reassembles, and the structure is exactly as the user
 * built it afterwards. An optimisation is not: the atoms genuinely move, and the
 * relaxed positions replace the ones on screen when it finishes.
 */
type AnimationKind = 'divergence' | 'optimization';

/**
 * Phase 5: build a molecule by hand, watch it relax into a stable shape, and
 * look at the electron density that comes out.
 *
 * Relaxing is the headline action, and it is the one that answers "what shape
 * does this actually want to be" - the engine computes the forces on every
 * nucleus and moves them downhill until nothing is pulling. Each step it accepts
 * arrives here as it is produced and goes straight into the frame player, so the
 * molecule is moving on screen while the next step is still being solved.
 *
 * The calculation is started explicitly rather than on every edit: benzene takes
 * seconds, so running it while the user drags an atom would be worse than
 * useless.
 *
 * The density surface is a second, much cheaper round trip over the same
 * converged calculation, which is what lets the threshold slider stay live.
 *
 * Two things can be drawn from that density: every electron, or just the ones
 * that made the bonds. Which surface the second one turns out to be is the
 * engine's decision - it depends on whether the molecule has a pi system - so
 * the UI asks for "bonding" and reads back what it got.
 *
 * Nothing here knows what a spin state is. The engine tries the ones that could
 * be the ground state and keeps the best (requirement F4), and an arrangement of
 * nuclei it cannot solve at any of them comes back as an ordinary answer with
 * `converged: false`. That is not an error and is never written as one: the
 * molecule flies apart on screen and reassembles, which says what happened
 * without a word of chemistry (requirement F5).
 *
 * Running out of time is *not* that, and is deliberately shown differently. A
 * relaxation that hits the worker's budget has solved the electrons at every
 * geometry it visited; what it has is a real structure that is partly relaxed.
 * So it stops where it is, keeps that structure, and says it ran out of time -
 * because flying the molecule apart there would be saying "this cannot exist"
 * when the true statement is "the computer was too slow".
 *
 * While a calculation runs, a card over the molecule names the part of the work
 * under way and counts the seconds. For benzene the first several seconds move
 * nothing at all, and without it the screen would simply stand still. The card
 * lasts until the first density surface is up, because that is when the answer
 * is on screen; a calculation that does not converge drops it at once and lets
 * the divergence speak for itself.
 *
 * The view has two modes. Edit mode builds the molecule. Observe mode is for
 * showing it: clicks and drags there cannot change the structure - which while
 * a calculation runs would also cancel it - and clicking atoms measures
 * distances, angles and dihedrals between them instead. Starting a calculation
 * switches to observe mode, so the class can watch the values change as the
 * molecule relaxes; a calculation that ends with nothing to look at (it did
 * not converge, was refused, or was cancelled) switches back, since what comes
 * next is editing.
 */
export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<MoleculeViewer | null>(null);
  const clientRef = useRef<DftWorkerClient | null>(null);

  const [atoms, setAtoms] = useState<SceneAtom[]>(PRESETS[0].atoms);
  const [presetId, setPresetId] = useState<string | null>(PRESETS[0].id);
  // Whether the structure on screen is one the user built or edited, which is
  // what decides the nudge before a relaxation (`records/perturb.ts`) and the
  // advice under the choice of level (`components/level.ts`). It is not the
  // same as having no preset: a record, a candidate and the shape a relaxation
  // has just produced are all shapes this app supplied, and clear it too.
  const [handBuilt, setHandBuilt] = useState(false);
  const [elements, setElements] = useState<ElementInfo[]>([]);
  const [activeZ, setActiveZ] = useState(6);
  const [selected, setSelected] = useState<number | null>(null);
  const [mode, setMode] = useState<ViewerMode>('edit');
  // Atoms picked for measuring, in the order they were picked. They survive
  // anything that only moves atoms (a drag, a relaxation) - the value follows
  // - and are dropped by anything that changes which atoms there are.
  const [measured, setMeasured] = useState<number[]>([]);
  const [showBondLengths, setShowBondLengths] = useState(false);
  // The structure the last relaxation started from, so a measurement can say
  // how it changed. Only while the atoms on screen are that relaxation's.
  const [relaxedFrom, setRelaxedFrom] = useState<SceneAtom[] | null>(null);
  // What the picked atoms measure as drawn, written by the viewer. See
  // `LiveMeasurement` for why the viewer and not `atoms`.
  const [liveMeasurement] = useState(() => new LiveMeasurement());
  const [result, setResult] = useState<ScfOutcome | null>(null);
  // What the next calculation is for (`components/level.ts`). Chosen per
  // calculation and fixed while one runs.
  const [level, setLevel] = useState<ModelLevel>(DEFAULT_LEVEL);
  // What the numbers in `result` were solved for, which is not necessarily the
  // choice above: that can change as soon as the calculation is over. Set
  // wherever `result` gets an answer; null only for a record whose level this
  // program does not know (`levelOfRecord`).
  const [resultLevel, setResultLevel] = useState<ModelLevel | null>(DEFAULT_LEVEL);
  // Set when the user stopped a relaxation part way and the structure on screen
  // is where it got to: how many moves that was, and what it was solved for.
  // Beside `result`, which has no numbers for it unless the worker survived the
  // stop. Cleared wherever `result` is.
  const [stopped, setStopped] = useState<{ steps: number; level: ModelLevel } | null>(null);
  const [computing, setComputing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when this browser cannot run the engine at all, which is a notice in
  // place of the app rather than an error about one calculation.
  const [unavailable, setUnavailable] = useState<EngineProblem | null>(null);
  const [webgl, setWebgl] = useState<WebGlProbe | null>(null);
  const [showDensity, setShowDensity] = useState(true);
  const [channel, setChannel] = useState<DensityRequest>('total');
  // A level per channel, so switching back and forth keeps each where it was.
  const [levels, setLevels] = useState<Record<DensityRequest, number>>({
    total: ISO_RANGES.total.initial,
    bonding: ISO_RANGES.bonding.initial,
  });
  // The structure log. `kept` is false in a browser that will not keep it -
  // a private window - which the panel says rather than treating as an error.
  const [records, setRecords] = useState<StructureRecord[]>([]);
  const [recordsKept, setRecordsKept] = useState(true);
  // The record whose structure is on screen, so the list can show which, and
  // so a measurement can compare against the structure it started from.
  const [openRecordId, setOpenRecordId] = useState<string | null>(null);
  const [recordNotice, setRecordNotice] = useState<string | null>(null);
  const storeRef = useRef<RecordStore | null>(null);

  // Shapes being tried on workers of their own, behind the one the screen uses.
  // They never touch `atoms`, the player or the front worker: a candidate that
  // finishes becomes a record, and only opening one puts anything on screen.
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const poolRef = useRef<SearchPool | null>(null);
  // The element table arrives from the worker, and a record is made inside a
  // callback that must not be rebuilt when it does.
  const symbolOfRef = useRef<(z: number) => string>((z) => `Z=${z}`);
  // The same, for the overlap check a search candidate is drawn against
  // (`search/candidates.ts`). The fallback is only ever used before the table
  // arrives, when there is nothing to search from anyway.
  const covalentRadiusRef = useRef<(z: number) => number>(() => 0.8);
  const [mesh, setMesh] = useState<IsoMesh | null>(null);
  // When the surface being cut now was asked for, or null when none is.
  const [meshingSince, setMeshingSince] = useState<number | null>(null);
  const meshing = meshingSince !== null;
  // The calculation the progress card describes. It outlives `computing` by the
  // first surface, which is part of the wait as far as the user is concerned.
  const [job, setJob] = useState<JobState | null>(null);
  // What the frame player is showing, if anything. While this is set the player
  // owns the atom positions and the effect that draws `atoms` stands aside.
  const [animation, setAnimation] = useState<AnimationKind | null>(null);
  const isoLevel = levels[channel];

  // Plays the steps of a geometry optimisation and the frames of a failed
  // calculation - the same queue, fed by two different producers. It drives the
  // viewer directly rather than through React state: the positions change every
  // display frame, which is not something to re-render for.
  const playerRef = useRef<FramePlayer | null>(null);

  /**
   * Whether whatever is feeding the player has finished producing frames.
   *
   * The distinction matters only for an optimisation. The player running dry
   * there usually means the next step is still being solved, not that the
   * animation is over, so going idle must not end it. Until this is set, the
   * idle callback waits.
   *
   * It deliberately does *not* carry the structure to commit. A relaxed geometry
   * is the answer, not a frame of an animation, so it is committed the moment
   * the engine returns it; the animation only has to hand the viewer back
   * afterwards. Waiting for the player would mean a tab left in the background -
   * where `requestAnimationFrame` does not run at all - finishes a relaxation,
   * says so in the panel, and still holds the structure the user started from.
   */
  const producerDoneRef = useRef(false);

  // The geometries of the relaxation in flight, collected as they arrive: they
  // are what a record replays. Float32 frames are copied, because the player
  // keeps the ones it is handed.
  const stepsRef = useRef<{ xyz: number[]; energy: number }[]>([]);

  // Identifies the calculation whose result is still wanted. Cancelling or
  // editing bumps it, so a reply that arrives afterwards is ignored instead of
  // overwriting the state of a newer request.
  const requestRef = useRef(0);
  const inFlightRef = useRef(false);
  // Whether the calculation in flight is a relaxation, which is the only kind
  // that leaves a before-and-after behind when it is cancelled.
  const relaxingRef = useRef(false);
  // Whether the user has asked the relaxation in flight to stop after its
  // step. It is what tells their stop from the engine's own budget, which end
  // with the same reason, and what makes a second press stop at once.
  const stopRequestedRef = useRef(false);
  // The mode to go back to if the calculation that switched to observe mode
  // ends with nothing to observe. Cleared when it succeeds, and when the user
  // picks a mode themselves - their choice is not undone afterwards.
  const restoreModeRef = useRef<ViewerMode | null>(null);

  // Whether the worker is still holding a converged calculation to cut surfaces
  // from. A ref rather than state: the isosurface pump reads it from inside a
  // running loop, where a stale render's copy would be wrong.
  const hasDensityRef = useRef(false);
  // Isosurface requests are coalesced. The worker is single-threaded, so
  // queueing every level a slider drag passes through would leave the surface
  // running seconds behind the pointer; instead one request is in flight and
  // the newest level waits its turn, replacing any older one that was waiting.
  const wantedRef = useRef<{ channel: DensityRequest; level: number } | null>(null);
  const meshInFlightRef = useRef(false);
  const meshRequestRef = useRef(0);

  /**
   * Ends whatever the player is showing, wherever it is. The molecule on screen
   * is put back by the effect that watches `animation`, so this does not have to
   * know what the current geometry is - and it deliberately does not commit a
   * half-finished relaxation, because a structure the optimiser was still moving
   * is not an answer.
   */
  const stopAnimation = useCallback(() => {
    producerDoneRef.current = false;
    playerRef.current?.stop();
    setAnimation(null);
  }, []);

  /** Selection for editing means nothing in observe mode, so it goes. */
  const switchMode = useCallback((next: ViewerMode) => {
    setMode(next);
    if (next === 'observe') setSelected(null);
  }, []);

  /** The mode switch in the panel: the user's choice, which nothing reverts. */
  const chooseMode = useCallback(
    (next: ViewerMode) => {
      restoreModeRef.current = null;
      switchMode(next);
    },
    [switchMode],
  );

  /** A calculation is starting. */
  const observeWhileRunning = useCallback(() => {
    restoreModeRef.current = mode;
    switchMode('observe');
  }, [mode, switchMode]);

  /** The calculation has an answer on screen: stay and look at it. */
  const keepObserving = useCallback(() => {
    restoreModeRef.current = null;
  }, []);

  /** It has nothing to look at: back to the mode it started from. */
  const restoreMode = useCallback(() => {
    const previous = restoreModeRef.current;
    restoreModeRef.current = null;
    if (previous !== null) switchMode(previous);
  }, [switchMode]);

  const cancelCalculation = useCallback(() => {
    // Replacing the worker is not free, so only do it when something is actually
    // running - every edit comes through here.
    if (!inFlightRef.current) return;
    // A cancelled relaxation leaves the structure as it was, so there is no
    // before and after to show. A cancelled single point leaves the last
    // relaxation's alone.
    if (relaxingRef.current) setRelaxedFrom(null);
    relaxingRef.current = false;
    restoreMode();
    // A single-threaded WASM calculation cannot be interrupted from outside, so
    // the client terminates the worker and spawns a fresh one.
    inFlightRef.current = false;
    requestRef.current += 1;
    // The worker being replaced takes the converged calculation with it.
    hasDensityRef.current = false;
    clientRef.current?.cancelAll();
    setComputing(false);
    setJob(null);
    stopAnimation();
  }, [stopAnimation, restoreMode]);

  /**
   * The 中止 button, and only that: a relaxation keeps the structure it had
   * reached rather than going back to where it started.
   *
   * Not `cancelCalculation`, which every edit, preset and record also goes
   * through - after writing the atoms they want, so keeping a step there would
   * overwrite them. Here nothing is replaced, and the relaxation's own
   * handlers keep what it reached: on a page that can share memory with the
   * worker it is asked to stop after its step and `.then` hears the numbers
   * too, as for a budget that ran out; anywhere else the worker goes, and
   * `.catch` hears how far it got (`RelaxationStopped`). A second press is the
   * user who will not wait for the step. A single point has nothing part way
   * to keep, and is cancelled as it always was.
   */
  const stopCalculation = useCallback(() => {
    if (!inFlightRef.current) return;
    if (!relaxingRef.current) {
      cancelCalculation();
      return;
    }
    const outcome = clientRef.current?.stopRelaxations(stopRequestedRef.current);
    if (outcome === 'stopping') {
      stopRequestedRef.current = true;
      setJob((current) => current && { ...current, stopping: true });
    }
  }, [cancelCalculation]);

  /**
   * Hands the viewer back to React once the frames have run out for good.
   *
   * Called from the player when it runs dry, and directly when the producer
   * finishes after the player has already caught up - in which case the idle
   * callback has come and gone and nothing else will call it. Either way the
   * molecule it lands on is whatever `atoms` already holds.
   */
  const finishAnimation = useCallback(() => {
    if (!producerDoneRef.current) return;
    producerDoneRef.current = false;
    setAnimation(null);
  }, []);

  /**
   * Every edit invalidates the last result and abandons a calculation that is
   * still running for the old geometry. Called from the edit handlers rather
   * than from an effect on `atoms`, so the molecule and the readout change in
   * the same render.
   */
  const invalidateResult = useCallback(() => {
    setResult(null);
    setStopped(null);
    setError(null);
    // Whatever changed, the atoms are no longer where a relaxation left them,
    // nor the ones a record was opened at.
    setRelaxedFrom(null);
    setOpenRecordId(null);
    stopAnimation();
    // The worker's copy of the density belongs to the old geometry, so the
    // surface on screen is stale whether or not the worker survives.
    hasDensityRef.current = false;
    wantedRef.current = null;
    meshRequestRef.current += 1;
    setMesh(null);
    // A calculation that has finished may still be waiting for its first
    // surface, which will not be wanted now either.
    setJob(null);
    cancelCalculation();
  }, [cancelCalculation, stopAnimation]);

  // --- edit operations -----------------------------------------------------

  const placeAtom = useCallback(
    (pos: [number, number, number]) => {
      setAtoms((prev) => [...prev, { z: activeZ, pos }]);
      setPresetId(null);
      setHandBuilt(true);
      setSelected(null);
      setMeasured([]);
      invalidateResult();
    },
    [activeZ, invalidateResult],
  );

  const moveAtom = useCallback(
    (index: number, pos: [number, number, number]) => {
      setAtoms((prev) => prev.map((atom, i) => (i === index ? { ...atom, pos } : atom)));
      setPresetId(null);
      setHandBuilt(true);
      invalidateResult();
    },
    [invalidateResult],
  );

  const deleteSelected = useCallback(() => {
    setSelected((index) => {
      if (index === null) return null;
      setAtoms((prev) => prev.filter((_, i) => i !== index));
      setPresetId(null);
      setHandBuilt(true);
      setMeasured([]);
      return null;
    });
    invalidateResult();
  }, [invalidateResult]);

  const clearAll = useCallback(() => {
    setAtoms([]);
    setPresetId(null);
    setHandBuilt(true);
    setSelected(null);
    setMeasured([]);
    invalidateResult();
  }, [invalidateResult]);

  const pickForMeasuring = useCallback((index: number) => {
    setMeasured((prev) => toggleMeasured(prev, index));
  }, []);

  // The viewer is created once, so it calls through a ref that always holds the
  // current handlers rather than the ones captured at mount.
  const handlers = useRef({ placeAtom, moveAtom, setSelected, pickForMeasuring, finishAnimation });
  handlers.current = { placeAtom, moveAtom, setSelected, pickForMeasuring, finishAnimation };

  // --- viewer and worker lifetime -----------------------------------------

  useEffect(() => {
    if (!containerRef.current) return;

    // A missing WebGL context must not take the whole app down: the engine and
    // the readouts still work, only the 3D view is unavailable.
    const probe = probeWebGl();
    setWebgl(probe);
    let viewer: MoleculeViewer | null = null;
    if (probe.ok) {
      try {
        viewer = new MoleculeViewer(containerRef.current);
        viewer.onPlace = (pos) => handlers.current.placeAtom(pos);
        viewer.onMove = (i, pos) => handlers.current.moveAtom(i, pos);
        viewer.onSelect = (i) => handlers.current.setSelected(i);
        viewer.onMeasure = (i) => handlers.current.pickForMeasuring(i);
        viewer.onMeasurement = (m) => liveMeasurement.set(m);
      } catch (e) {
        setWebgl({ ...probe, ok: false, disabled: true });
        console.error('WebGL renderer could not be created', e);
      }
    }
    const client = new DftWorkerClient();
    const player = new FramePlayer({
      // Roughly eight display frames per keyframe at 60 Hz: fast enough to feel
      // like one motion, slow enough that the interpolation has something to do.
      frameMs: 55,
      onFrame: (positions) => viewer?.setPositions(positions),
      // Running dry does not necessarily mean the animation is over: during an
      // optimisation it usually means the next step is still being solved.
      onIdle: () => handlers.current.finishAnimation(),
    });
    viewerRef.current = viewer;
    clientRef.current = client;
    playerRef.current = player;

    // Only load the element table here; drawing is left to the effects below so
    // the molecule on screen is always the current one.
    let stale = false;
    client
      .elements()
      .then((list) => {
        if (stale) return;
        viewer?.setElements(list);
        setElements(list);
      })
      .catch((e: Error) => {
        if (stale) return;
        if (e instanceof EngineUnavailableError) {
          // The detail is for whoever is debugging; the notice is for the user.
          console.error(e);
          setUnavailable(e.problem);
        } else {
          setError(e.message);
        }
      });

    return () => {
      stale = true;
      setElements([]);
      player.stop();
      viewer?.dispose();
      liveMeasurement.set(null);
      client.dispose();
      viewerRef.current = null;
      clientRef.current = null;
      playerRef.current = null;
    };
  }, [liveMeasurement]);

  // --- the structure log ---------------------------------------------------

  // Opening the database is the one thing here that can fail, and it does not:
  // a browser that will not keep records gets one that lasts the tab, and the
  // panel says so.
  useEffect(() => {
    let stale = false;
    openRecordStore().then(async ({ store, persistent }) => {
      if (stale) return;
      storeRef.current = store;
      setRecordsKept(persistent);
      const kept = await store.load();
      if (!stale) setRecords(kept);
    });
    return () => {
      stale = true;
    };
  }, []);

  /** Writes a record through to the store, and into the list on screen. */
  const keepRecord = useCallback((record: StructureRecord) => {
    setRecords((previous) => {
      const at = previous.findIndex((existing) => existing.id === record.id);
      if (at === -1) return [...previous, record];
      const next = [...previous];
      next[at] = record;
      return next;
    });
    void storeRef.current?.put(record);
  }, []);

  const renameRecord = useCallback(
    (record: StructureRecord, name: string) => keepRecord({ ...record, name }),
    [keepRecord],
  );

  /**
   * The workers the search runs on, built once and kept for the session.
   *
   * How many run at once is decided from the machine rather than from what the
   * browser reports having (`search/pool.ts`), because the one thing the size
   * must not cost is the front worker's answering speed. Nor does it read
   * `level`: every candidate is solved for its shape (`SEARCH_LEVEL`), whatever
   * the calculations in front are for.
   *
   * A candidate that ends with a structure worth keeping becomes a record here,
   * under the candidate's own id - which is what lets a row in the search
   * section say how deep the shape it found is, and open it.
   */
  useEffect(() => {
    const pool = new SearchPool({
      size: poolSize(navigator.hardwareConcurrency),
      onChange: setCandidates,
      onFinished: (candidate) => {
        if (!candidate.outcome) return;
        keepRecord(
          createRecord(
            {
              z: Array.from(candidate.z),
              built: Array.from(candidate.built),
              trajectory: candidate.trajectory,
              stepEnergies: candidate.stepEnergies,
              outcome: candidate.outcome,
              // The level the pool asked for, from the one place both read.
              level: SEARCH_LEVEL,
              source: 'search',
              batch: candidate.batch,
            },
            symbolOfRef.current,
            new Date(),
            candidate.id,
          ),
        );
      },
    });
    poolRef.current = pool;
    return () => {
      pool.dispose();
      poolRef.current = null;
    };
  }, [keepRecord]);

  const deleteRecord = useCallback((record: StructureRecord) => {
    setRecords((previous) => previous.filter((existing) => existing.id !== record.id));
    setOpenRecordId((open) => (open === record.id ? null : open));
    setRecordNotice(null);
    void storeRef.current?.remove(record.id);
  }, []);

  const clearRecords = useCallback(() => {
    if (!window.confirm('記録をすべて消します。よろしいですか？')) return;
    setRecords([]);
    setOpenRecordId(null);
    setRecordNotice(null);
    void storeRef.current?.clear();
  }, []);

  /** Atoms from the flattened pair the records and the search both keep. */
  const atomsOfFlat = useCallback(
    (z: ArrayLike<number>, xyz: ArrayLike<number>): SceneAtom[] =>
      Array.from({ length: z.length }, (_, i) => ({
        z: z[i],
        pos: [xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]] as [number, number, number],
      })),
    [],
  );

  /** The atoms of a structure kept in a record, which stores them flattened. */
  const atomsOfRecord = useCallback(
    (record: StructureRecord, xyz: readonly number[]): SceneAtom[] =>
      atomsOfFlat(record.z, xyz),
    [atomsOfFlat],
  );

  // --- viewer synchronisation ---------------------------------------------

  const elementsReady = elements.length > 0;

  const symbolOf = useCallback(
    (z: number) => elements.find((element) => element.z === z)?.symbol ?? `Z=${z}`,
    [elements],
  );

  useEffect(() => {
    symbolOfRef.current = symbolOf;
    covalentRadiusRef.current = (z: number) =>
      elements.find((element) => element.z === z)?.covalentRadius ?? 0.8;
  }, [symbolOf, elements]);

  useEffect(() => {
    viewerRef.current?.setMode(mode);
  }, [mode]);

  // Ahead of the molecule below, so that when both change in one render - an
  // atom deleted, say - the old indices are never measured on the new atoms.
  useEffect(() => {
    viewerRef.current?.setMeasured(measured);
  }, [measured]);

  useEffect(() => {
    viewerRef.current?.setShowBondLengths(showBondLengths);
  }, [showBondLengths]);

  // While the animation is running it owns the positions; when it ends - because
  // it finished, or because the user edited the molecule out from under it - the
  // structure as built comes straight back.
  useEffect(() => {
    if (elementsReady && animation === null) viewerRef.current?.setMolecule(atoms);
  }, [atoms, elementsReady, animation]);

  useEffect(() => {
    viewerRef.current?.setActiveElement(activeZ);
  }, [activeZ]);

  useEffect(() => {
    viewerRef.current?.setSelected(selected);
  }, [selected]);

  // Refit the camera only when a whole molecule is swapped in, never while the
  // user is dragging an atom.
  useEffect(() => {
    if (presetId && elementsReady) viewerRef.current?.frameAll();
  }, [presetId, elementsReady]);

  useEffect(() => {
    viewerRef.current?.setIsosurface(showDensity ? mesh : null);
  }, [mesh, showDensity]);

  // --- engine --------------------------------------------------------------

  /**
   * Draws whatever level is wanted, then whatever level became wanted while
   * that was happening, until there is nothing left to catch up on.
   */
  const pumpIsosurface = useCallback(async () => {
    const client = clientRef.current;
    if (!client || meshInFlightRef.current) return;
    if (wantedRef.current === null || !hasDensityRef.current) return;

    meshInFlightRef.current = true;
    setMeshingSince(performance.now());
    try {
      while (wantedRef.current !== null && hasDensityRef.current) {
        const wanted = wantedRef.current;
        wantedRef.current = null;
        const token = ++meshRequestRef.current;
        try {
          const next = await client.isosurface(wanted.channel, wanted.level);
          if (meshRequestRef.current === token) setMesh(next);
        } catch {
          // The worker was replaced, or there is no calculation to cut. Neither
          // is something to put in front of the user: the surface just goes.
          if (meshRequestRef.current === token) setMesh(null);
        }
        // The first surface after a calculation is the end of its wait,
        // whichever way it went. A newer calculation's card is left alone.
        setJob((current) => (current?.drawing ? null : current));
      }
    } finally {
      meshInFlightRef.current = false;
      setMeshingSince(null);
    }
  }, []);

  const requestIsosurface = useCallback(
    (wanted: DensityRequest, level: number) => {
      wantedRef.current = { channel: wanted, level };
      void pumpIsosurface();
    },
    [pumpIsosurface],
  );

  // A new threshold, a different channel, or switching the surface back on all
  // ask for a fresh mesh. A finished calculation does the same from its own
  // handler, where the density first becomes available.
  useEffect(() => {
    if (showDensity && hasDensityRef.current) requestIsosurface(channel, isoLevel);
  }, [channel, isoLevel, showDensity, requestIsosurface]);

  /**
   * Switching channel drops the surface on screen rather than leaving it up
   * while the new density is sampled: the two are drawn in different colours and
   * mean different things, so the stale one would be read as the new one.
   */
  const selectChannel = useCallback((next: DensityRequest) => {
    setChannel((current) => {
      if (current !== next) {
        meshRequestRef.current += 1;
        setMesh(null);
      }
      return next;
    });
  }, []);

  /**
   * Shows a calculation that would not converge as the molecule coming apart.
   *
   * There is no message and no density: the engine found no bound arrangement of
   * electrons for these nuclei, so there is nothing true to draw, and the
   * animation is the whole of the answer (requirement F5).
   */
  const showDivergence = useCallback((current: SceneAtom[]) => {
    const player = playerRef.current;
    if (!player || current.length === 0) return;
    setAnimation('divergence');
    // Queued rather than cut in: an optimisation that fell apart has steps still
    // waiting, and letting them play means the molecule is seen relaxing as far
    // as it got before it comes apart, with no jump between the two.
    //
    // Nothing is committed here. A divergence is a picture of what the engine
    // found, not a move the molecule made, so the structure the user built is
    // still the structure afterwards.
    producerDoneRef.current = true;
    player.push(...divergenceFrames(toWorkerArrays(current).xyz));
  }, []);

  /**
   * A calculation that was refused. Usually that is the geometry (two atoms on
   * top of each other); an engine that stopped being able to start at all is a
   * notice about the browser instead.
   */
  const reportFailure = useCallback((e: Error) => {
    if (e instanceof EngineUnavailableError) {
      console.error(e);
      setUnavailable(e.problem);
    } else {
      setError(describeEngineError(e.message));
    }
  }, []);

  /**
   * Starts the progress card for a calculation, and returns the listener that
   * keeps it current. Reports from a calculation that has since been replaced
   * are dropped, the same way its answer is.
   */
  const beginJob = useCallback((kind: JobKind, token: number) => {
    setJob({
      kind,
      startedAt: performance.now(),
      engine: null,
      drawsSurface: showDensity,
      drawing: false,
      stopping: false,
    });
    return (progress: CalculationProgress) => {
      if (requestRef.current !== token) return;
      setJob((current) => current && { ...current, engine: progress });
    };
  }, [showDensity]);

  /**
   * The engine has answered. If a surface is coming, the card stays up until it
   * arrives (the isosurface pump takes it down); otherwise it goes now.
   */
  const endJob = useCallback((surfaceComing: boolean) => {
    setJob((current) => (current && surfaceComing ? { ...current, drawing: true } : null));
  }, []);

  const calculate = useCallback(() => {
    const client = clientRef.current;
    if (!client || atoms.length === 0) return;
    const { z, xyz } = toWorkerArrays(atoms);
    const token = ++requestRef.current;
    inFlightRef.current = true;
    relaxingRef.current = false;
    stopAnimation();
    observeWhileRunning();
    setComputing(true);
    // Drop the previous answer immediately: leaving it on screen next to
    // "計算中…" reads as though it belonged to the run in progress.
    setResult(null);
    setStopped(null);
    setError(null);
    const onProgress = beginJob('single', token);
    client
      .scf(z, xyz, onProgress, level)
      .then((outcome) => {
        if (requestRef.current !== token) return;
        inFlightRef.current = false;
        setComputing(false);
        setResult(outcome);
        setResultLevel(level);
        if (!outcome.converged) {
          endJob(false);
          restoreMode();
          showDivergence(atoms);
          return;
        }
        keepObserving();
        // The worker is now holding a density; show it without making the user
        // ask, so placing atoms and seeing the cloud is one action.
        hasDensityRef.current = true;
        endJob(showDensity);
        if (showDensity) requestIsosurface(channel, isoLevel);
      })
      .catch((e: Error) => {
        if (requestRef.current !== token) return;
        inFlightRef.current = false;
        setComputing(false);
        endJob(false);
        restoreMode();
        reportFailure(e);
      });
  }, [
    atoms,
    level,
    showDensity,
    channel,
    isoLevel,
    requestIsosurface,
    showDivergence,
    stopAnimation,
    observeWhileRunning,
    keepObserving,
    restoreMode,
    beginJob,
    endJob,
    reportFailure,
  ]);

  /**
   * Relaxes the structure and plays it moving (requirement F2).
   *
   * The engine streams a geometry per accepted step; each one goes straight into
   * the frame player, which shows them at a steady rate however unevenly they
   * arrive. When it finishes, the relaxed structure replaces the one the user
   * built - unlike a divergence, the atoms really did move.
   *
   * A structure that will not relax - no self-consistent density, or still
   * moving when the step limit or the time budget runs out - is not written as
   * an error. The frames already queued play out and the molecule then comes
   * apart, which is the same answer the single point gives and needs no words
   * (requirement F5).
   */
  const relax = useCallback(() => {
    const client = clientRef.current;
    const player = playerRef.current;
    if (!client || !player || atoms.length === 0) return;
    const original = atoms;
    const { z, xyz } = toWorkerArrays(original);
    // A structure the user built by clicking, with every atom in one plane, is
    // one the optimiser cannot leave: it would report the flat shape settled.
    // Nudge it off the plane first. A shape this app supplied - a preset, a
    // record, or the one a relaxation has just found - goes in as it is: its
    // symmetry is the molecule's own, and nudging a shape that has already
    // settled only makes the optimiser walk back down to it
    // (`records/perturb.ts`).
    const start = needsNudge(xyz, handBuilt)
      ? perturb(xyz, PERTURB_AMPLITUDE, randomSeed())
      : xyz;
    const token = ++requestRef.current;
    inFlightRef.current = true;
    relaxingRef.current = true;
    stopRequestedRef.current = false;
    stopAnimation();
    observeWhileRunning();
    // Measurements compare against this, live while the molecule moves.
    setRelaxedFrom(original);
    setComputing(true);
    setResult(null);
    setStopped(null);
    setError(null);
    // The geometry is about to change under it, so the surface on screen belongs
    // to a molecule that will not exist in a moment.
    hasDensityRef.current = false;
    wantedRef.current = null;
    meshRequestRef.current += 1;
    setMesh(null);
    setAnimation('optimization');
    stepsRef.current = [];
    const onProgress = beginJob('relax', token);

    client
      .optimize(
        z,
        start,
        (step) => {
          if (requestRef.current !== token) return;
          // Kept for the record before the player takes the frame.
          stepsRef.current.push({ xyz: Array.from(step.xyz), energy: step.energy });
          player.push(step.xyz);
        },
        onProgress,
        // The front worker has no budget of its own: the user stops it.
        null,
        level,
      )
      .then((outcome) => {
        if (requestRef.current !== token) return;
        inFlightRef.current = false;
        relaxingRef.current = false;
        setComputing(false);
        setResult(outcome);
        setResultLevel(level);

        const relaxed = outcome.optimization;
        // One that settled on the step it was asked to stop after has simply
        // settled; only one that ended short of that was stopped.
        const stoppedByUser = stopRequestedRef.current && relaxed?.reason === 'interrupted';
        stopRequestedRef.current = false;
        if (!outcome.converged || !relaxed || !hasUsableStructure(relaxed)) {
          endJob(false);
          // The structure stays as built, so there is no before and after.
          setRelaxedFrom(null);
          restoreMode();
          showDivergence(original);
          return;
        }
        keepObserving();
        if (stoppedByUser) setStopped({ steps: relaxed.steps, level });
        // A shape worth keeping: into the log, whether it settled, ran out of
        // time or was stopped, under the level it was solved at - which keeps
        // it apart from the other level's records. What it was built from is
        // the structure before the nudge.
        const record = createRecord(
          {
            z: Array.from(z),
            built: Array.from(xyz),
            trajectory: stepsRef.current.map((step) => step.xyz),
            stepEnergies: stepsRef.current.map((step) => step.energy),
            outcome,
            level,
          },
          symbolOfRef.current,
        );
        keepRecord(record);
        setOpenRecordId(record.id);
        // Whatever stopped it, the structure it reached is one the electrons
        // were solved for, so it is the molecule now - partly relaxed if the
        // budget ran out, fully relaxed if it settled. It is committed here
        // rather than when the animation ends, so that the answer does not
        // depend on frames the browser may not be drawing.
        setAtoms(withPositions(original, relaxed.xyz));
        setPresetId(null);
        setHandBuilt(false);
        producerDoneRef.current = true;
        // The player may already have caught up with the engine, in which case
        // its idle callback has been and gone and nothing will call it again.
        if (!player.playing) finishAnimation();

        hasDensityRef.current = true;
        endJob(showDensity);
        if (showDensity) requestIsosurface(channel, isoLevel);
      })
      .catch((e: Error) => {
        if (requestRef.current !== token) return;
        inFlightRef.current = false;
        relaxingRef.current = false;
        stopRequestedRef.current = false;
        setComputing(false);
        endJob(false);
        if (e instanceof RelaxationStopped && e.last !== null) {
          // Stopped by the user part way, by replacing the worker. The
          // structure it reached is one the electrons were solved for, so it
          // is the molecule now, as when the budget runs out - committed at
          // once for the same reason, and with the frames already queued left
          // to play up to it. Its numbers went with the worker, so there is no
          // record and no surface, and the readouts say how far it got.
          keepObserving();
          setAtoms(withPositions(original, Array.from(e.last.xyz)));
          setPresetId(null);
          setHandBuilt(false);
          setOpenRecordId(null);
          setStopped({ steps: e.last.step, level });
          producerDoneRef.current = true;
          if (!player.playing) finishAnimation();
          return;
        }
        stopAnimation();
        setRelaxedFrom(null);
        restoreMode();
        // Stopped before anything moved: as if it had never started.
        if (!(e instanceof RelaxationStopped)) reportFailure(e);
      });
  }, [
    atoms,
    handBuilt,
    level,
    showDensity,
    channel,
    isoLevel,
    requestIsosurface,
    showDivergence,
    stopAnimation,
    finishAnimation,
    observeWhileRunning,
    keepObserving,
    restoreMode,
    keepRecord,
    beginJob,
    endJob,
    reportFailure,
  ]);

  /**
   * Solves the electrons of `structure` for its density alone.
   *
   * What opening a record needs: the record has the numbers, but a density is
   * megabytes of grid and is not in it, so a surface has to come from the
   * worker. Nothing here touches `result` - the numbers on screen stay the
   * record's, computed on the optimiser's finer grid - and a structure that
   * will not solve simply gets no surface.
   *
   * It is solved at `recordLevel`, never at the level chosen in the panel: the
   * surface has to belong to the numbers beside it, and the choice may have
   * moved on.
   */
  const solveForSurface = useCallback(
    (structure: SceneAtom[], recordLevel: ModelLevel) => {
      const client = clientRef.current;
      if (!client || structure.length === 0) return;
      const { z, xyz } = toWorkerArrays(structure);
      const token = ++requestRef.current;
      inFlightRef.current = true;
      relaxingRef.current = false;
      setComputing(true);
      const onProgress = beginJob('single', token);
      client
        .scf(z, xyz, onProgress, recordLevel)
        .then((outcome) => {
          if (requestRef.current !== token) return;
          inFlightRef.current = false;
          setComputing(false);
          if (!outcome.converged) {
            // Nothing to cut, and nothing to say: the record's own numbers are
            // still the answer (requirement F5 keeps this silent).
            endJob(false);
            return;
          }
          hasDensityRef.current = true;
          endJob(true);
          requestIsosurface(channel, isoLevel);
        })
        .catch((e: Error) => {
          if (requestRef.current !== token) return;
          inFlightRef.current = false;
          setComputing(false);
          endJob(false);
          // Only an engine that has stopped working is worth a notice; anything
          // else here costs a surface, not the record.
          if (e instanceof EngineUnavailableError) reportFailure(e);
          else if (import.meta.env.DEV) console.debug('no surface for the record', e);
        });
    },
    [channel, isoLevel, requestIsosurface, beginJob, endJob, reportFailure],
  );

  /**
   * Puts a record back on screen (requirement: open a shape without waiting for
   * it to be calculated again).
   *
   * The numbers in the panel become the record's own, unchanged: they were
   * computed on the optimiser's finer grid, and a fresh single point would
   * differ in the last digits for no reason the user could see. What is *not*
   * in the record is the density - it is megabytes of grid - so if a surface is
   * being shown, the electrons are solved again at the structure the record
   * ended on and only the surface is taken from that. A structure that will not
   * solve simply gets no surface; its record still says what it said.
   *
   * The choice of what to calculate for goes back to what the record was made
   * for, so that pressing a button next continues the way it was made.
   */
  const openRecord = useCallback(
    (record: StructureRecord) => {
      const client = clientRef.current;
      if (!client) return;
      // Whatever is running belongs to the molecule about to be replaced.
      cancelCalculation();
      stopAnimation();
      const opened = atomsOfRecord(record, record.final);
      setAtoms(opened);
      setPresetId(null);
      setHandBuilt(false);
      setSelected(null);
      setMeasured([]);
      setError(null);
      setResult(record.outcome);
      setStopped(null);
      const recorded = levelOfRecord(record);
      setResultLevel(recorded);
      if (recorded !== null) setLevel(recorded);
      // "Before" is the structure this record was built from, so the observe
      // panel reads the same as it did when the relaxation finished.
      setRelaxedFrom(atomsOfRecord(record, record.built));
      setOpenRecordId(record.id);
      setRecordNotice(null);
      switchMode('observe');
      hasDensityRef.current = false;
      wantedRef.current = null;
      meshRequestRef.current += 1;
      setMesh(null);
      if (showDensity && recorded !== null) solveForSurface(opened, recorded);
    },
    [atomsOfRecord, cancelCalculation, stopAnimation, switchMode, showDensity, solveForSurface],
  );

  // --- the search ----------------------------------------------------------

  /**
   * Queues shapes to try in the background.
   *
   * `count` of zero is "今の形を試す" - the structure exactly as it is, which is
   * what a structure with no symmetry relaxes from anyway. Anything more is a
   * set of nudged starts, each drawn in its own directions, because what finds
   * another shape is trying several directions rather than nudging harder
   * (`search/candidates.ts`).
   *
   * Nothing here touches the front worker, the player or `atoms`: the point of
   * the section is that the screen keeps working while these run.
   */
  const startSearch = useCallback(
    (count: number) => {
      const pool = poolRef.current;
      if (!pool || atoms.length === 0) return;
      const { z, xyz } = toWorkerArrays(atoms);
      const source = {
        z,
        xyz,
        covalentRadius: covalentRadiusRef.current,
        batch: crypto.randomUUID(),
        id: () => crypto.randomUUID(),
      };
      pool.add(
        count <= 0
          ? [candidateAsBuilt(source)]
          : nudgedCandidates(source, count, randomSeed()),
      );
    },
    [atoms],
  );

  /**
   * Puts a finished candidate on screen.
   *
   * One that settled or ran out of time is a record by now, and goes through
   * the same door as any other record. One the engine could not solve is not a
   * record and never will be: what it has is a starting structure and the fact
   * that no arrangement of electrons held it together, so the molecule is put
   * there and comes apart, with no number and no message (requirement F5).
   */
  const openCandidate = useCallback(
    (candidate: Candidate) => {
      if (candidate.status !== 'failed') {
        const record = records.find((each) => each.id === candidate.id);
        if (record) openRecord(record);
        return;
      }
      const structure = atomsOfFlat(candidate.z, candidate.start);
      if (structure.length === 0) return;
      cancelCalculation();
      stopAnimation();
      setAtoms(structure);
      setPresetId(null);
      setHandBuilt(false);
      setSelected(null);
      setMeasured([]);
      setError(null);
      setResult(null);
      setStopped(null);
      setRelaxedFrom(null);
      setOpenRecordId(null);
      setRecordNotice(null);
      switchMode('observe');
      hasDensityRef.current = false;
      wantedRef.current = null;
      meshRequestRef.current += 1;
      setMesh(null);
      showDivergence(structure);
    },
    [
      records,
      openRecord,
      atomsOfFlat,
      cancelCalculation,
      stopAnimation,
      switchMode,
      showDivergence,
    ],
  );

  // The extra line under the choice of level, when there is one to say.
  const advice = atoms.length === 0 ? null : levelAdvice(level, handBuilt);

  const openedRecord = records.find((record) => record.id === openRecordId) ?? null;
  // A string rather than the record, so the effect below does not run again
  // every time the log changes around it. Null with no record open, and for a
  // record whose level is not known: neither has a level to solve a surface at.
  const openedLevel = openedRecord === null ? null : levelOfRecord(openedRecord);

  /**
   * Turning the cloud on while a record is open.
   *
   * Opening one does not solve anything unless a surface is being shown, so the
   * worker may be holding no density for the structure on screen. Anywhere else
   * the toggle has a density to cut already.
   */
  useEffect(() => {
    if (!showDensity || hasDensityRef.current || openedLevel === null) return;
    if (inFlightRef.current) return;
    solveForSurface(atoms, openedLevel);
  }, [showDensity, openRecordId, openedLevel, atoms, solveForSurface]);

  /**
   * Plays the relaxation this record was made by, from the structure it started
   * at to the one it ended on.
   *
   * The frames are the record's own atoms, so the viewer is given the molecule
   * before the player starts pushing positions into it: `setPositions` keeps
   * whatever elements are on screen and drops a frame whose length disagrees.
   * Only the open record can be replayed, so `atoms` is already the structure
   * the animation ends on and the viewer returns to it by itself.
   */
  const replayRecord = useCallback(
    (record: StructureRecord) => {
      const player = playerRef.current;
      const viewer = viewerRef.current;
      if (!player || !viewer || record.trajectory.length === 0) return;
      stopAnimation();
      viewer.setMolecule(atomsOfRecord(record, record.trajectory[0]));
      setAnimation('optimization');
      producerDoneRef.current = true;
      player.push(...record.trajectory.map((frame) => Float32Array.from(frame)));
    },
    [atomsOfRecord, stopAnimation],
  );

  /** Hands the log to the browser as a file to save. */
  const exportRecords = useCallback(
    (only: string | null) => {
      const chosen = only === null ? records : records.filter((r) => r.formula === only);
      if (chosen.length === 0) return;
      const url = URL.createObjectURL(
        new Blob([writeStructureLog(chosen)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = exportFileName(only);
      // In the document and revoked later: Firefox ignores a click on a link
      // that is not in the page, and revoking while the download is starting
      // cancels it.
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setRecordNotice(`${chosen.length} 件を書き出しました。`);
    },
    [records],
  );

  /**
   * Reads a file into the log.
   *
   * A file that does not fit is refused whole, with a reason, and the records
   * already here are untouched - the alternative is a blank row in front of a
   * class. Records that are already here keep the copy that is here, so reading
   * the same file twice changes nothing.
   */
  const importRecords = useCallback(
    async (file: File) => {
      const result = readStructureLog(await file.text(), (z) =>
        elements.some((element) => element.z === z),
      );
      if (!result.ok) {
        setRecordNotice(importProblemText(result.problem));
        return;
      }
      const merged = mergeRecords(records, result.records);
      setRecords(merged.records);
      void storeRef.current?.putAll(merged.added);
      setRecordNotice(importedText(merged.added.length, merged.alreadyHere));
    },
    [elements, records],
  );

  // --- keyboard ------------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      switch (keyAction(mode, event.key)) {
        case 'delete':
          if (selected !== null) {
            event.preventDefault();
            deleteSelected();
          }
          break;
        case 'deselect':
          setSelected(null);
          break;
        case 'clearMeasured':
          setMeasured([]);
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mode, selected, deleteSelected]);

  // Narrowed once, so every readout below agrees on what counts as an answer.
  //
  // The gate is the *electrons*, not the structure. Every number below - the
  // energy, the iteration count, the density surface - describes the molecule
  // currently on screen, and that description is true whenever its SCF
  // converged, whether or not the optimiser had time to reach the bottom. What
  // the optimiser managed is a separate line of its own.
  // The molecule on screen, so its own records are the ones at the top of the
  // list. The formula alone, because the charge that completes a comparison key
  // is only known once the engine has chosen one.
  const currentFormula = atoms.length > 0 ? hillFormula(atoms.map((a) => a.z), symbolOf) : null;
  const recordGroups = useMemo(() => {
    const all = groupRecords(records);
    // A stable sort, so within each half the newest group stays first.
    return all.sort(
      (a, b) => Number(b.formula === currentFormula) - Number(a.formula === currentFormula),
    );
  }, [records, currentFormula]);

  /** The log entry a candidate's record became, once it has one. */
  const entryOfCandidate = useCallback(
    (candidateId: string) => entryFor(recordGroups, candidateId)?.entry ?? null,
    [recordGroups],
  );

  /** How many records of that candidate's molecule settled, for the comparison. */
  const settledOfCandidate = useCallback(
    (candidateId: string) => {
      const found = entryFor(recordGroups, candidateId);
      return found ? settledCount(found.group) : 0;
    },
    [recordGroups],
  );
  const relaxation = result?.optimization ?? null;
  const solved = result !== null && result.converged;
  const settled = solved && (relaxation === null || relaxation.converged);
  const selectedAtom = selected === null ? null : atoms[selected];
  const selectedSymbol = selectedAtom ? symbolOf(selectedAtom.z) : null;
  const measuredSymbols = measured
    .filter((i) => i < atoms.length)
    .map((i) => symbolOf(atoms[i].z));
  const measuredBefore =
    relaxedFrom !== null && measured.length >= 2 ? measureAtoms(relaxedFrom, measured) : null;

  return (
    <div className="app">
      <div className="viewport" ref={containerRef}>
        {unavailable && (
          <div className="engine-unavailable" role="alert">
            <p className="title">{engineNotice(unavailable).title}</p>
            <p>{engineNotice(unavailable).body}</p>
          </div>
        )}
        {!unavailable && webgl && !webgl.ok && (
          <div className="webgl-error">
            <p>
              このブラウザでは WebGL を初期化できないため、3D 表示は利用できません。
              計算エンジンは動作しています。
            </p>
            <p className="hint">
              {webgl.disabled
                ? 'GPU アクセラレーションが無効な環境です。Safari や Firefox で http://localhost:5173 を開くと表示されます。'
                : 'このブラウザは WebGL に対応していません。'}
            </p>
          </div>
        )}
        <ProgressOverlay
          job={job}
          // A surface cut on its own, not as the end of a calculation: the
          // first one for a channel. Only while nothing is on screen yet - a
          // slider move keeps the old surface up until the new one replaces it.
          surfaceSince={
            job === null && showDensity && solved && mesh === null ? meshingSince : null
          }
        />
      </div>

      <aside className="panel">
        <h1>分子シミュレータ</h1>
        <p className="phase">原子を置くと、落ち着く形と電子の雲を計算します</p>

        <div className="row mode-switch" role="group" aria-label="モード">
          <button
            type="button"
            className={mode === 'edit' ? 'active' : ''}
            aria-pressed={mode === 'edit'}
            onClick={() => chooseMode('edit')}
          >
            編集
          </button>
          <button
            type="button"
            className={mode === 'observe' ? 'active' : ''}
            aria-pressed={mode === 'observe'}
            onClick={() => chooseMode('observe')}
          >
            観測
          </button>
        </div>

        {mode === 'edit' ? (
          <>
            <h2>配置する元素</h2>
            <PeriodicPicker elements={elements} value={activeZ} onChange={setActiveZ} />

            <p className="hint">
              何もない場所をクリックで配置 · 原子をドラッグで移動 · 原子を Shift+クリックで
              結合距離に隣接配置 · 背景をドラッグで回転
            </p>

            <h2>編集</h2>
            <div className="row">
              <button type="button" onClick={deleteSelected} disabled={selected === null}>
                削除{selectedSymbol ? `（${selectedSymbol}）` : ''}
              </button>
              <button type="button" onClick={clearAll} disabled={atoms.length === 0}>
                全消去
              </button>
              <button
                type="button"
                onClick={() => viewerRef.current?.frameAll()}
                disabled={atoms.length === 0}
              >
                全体表示
              </button>
            </div>
          </>
        ) : (
          <ObservePanel
            live={liveMeasurement}
            before={measuredBefore}
            symbols={measuredSymbols}
            showBondLengths={showBondLengths}
            onShowBondLengths={setShowBondLengths}
            onClear={() => setMeasured([])}
            onFrame={() => viewerRef.current?.frameAll()}
            canFrame={atoms.length > 0}
          />
        )}

        <h2>プリセット</h2>
        <div className="row">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={preset.id === presetId ? 'active' : ''}
              onClick={() => {
                setPresetId(preset.id);
                setAtoms(preset.atoms);
                setHandBuilt(false);
                setSelected(null);
                setMeasured([]);
                invalidateResult();
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <h2>計算</h2>
        {/* Fixed while a calculation runs: the answer on its way belongs to
            the choice it was started with. */}
        <div className="row level-switch" role="group" aria-label={LEVEL_GROUP_LABEL}>
          {LEVEL_ORDER.map((each) => (
            <button
              key={each}
              type="button"
              className={level === each ? 'active' : ''}
              aria-pressed={level === each}
              disabled={unavailable !== null || computing}
              onClick={() => setLevel(each)}
            >
              {levelLabel(each)}
            </button>
          ))}
        </div>
        <p className="hint level-hint">{levelHint(level)}</p>
        {/* Advice, not a warning: what is about to be pressed still works, and
            is not held back (`components/level.ts`). */}
        {advice !== null && <p className="hint level-hint">{advice}</p>}
        <div className="row">
          <button
            type="button"
            className={computing ? '' : 'active'}
            onClick={computing ? stopCalculation : relax}
            disabled={unavailable !== null || atoms.length === 0}
          >
            {computing ? (job?.stopping ? 'すぐ止める' : '中止') : '安定な形にする'}
          </button>
          <button
            type="button"
            onClick={calculate}
            disabled={unavailable !== null || computing || atoms.length === 0}
          >
            この形のまま計算
          </button>
        </div>
        <p className="hint">
          {computing && job?.stopping
            ? 'いまの一歩が終わったところで止まり、そこまでの形と数値が残ります。' +
              '待たずに止めるときは「すぐ止める」を押してください（形だけが残ります）。'
            : (relaxation !== null && solved && relaxation.reason !== 'converged') ||
                stopped !== null
              ? 'いまの形は途中までのものです。もう一度「安定な形にする」を押すと、' +
                'ここから続きを計算します。'
              : '「安定な形にする」を押すと、原子どうしが引き合う力・押し合う力を計算して、' +
                '落ち着く形まで少しずつ動かします。原子の数が多いほど時間がかかります。'}
        </p>

        <SearchPanel
          candidates={candidates}
          entryOf={entryOfCandidate}
          settledOf={settledOfCandidate}
          openId={openRecordId}
          atomCount={atoms.length}
          unavailable={unavailable !== null}
          onTryCurrent={() => startSearch(0)}
          onTryNudged={() => startSearch(NUDGED_COUNT)}
          onOpen={openCandidate}
          onCancel={(candidate) => poolRef.current?.cancel(candidate.id)}
          onCancelAll={() => poolRef.current?.cancelAll()}
          onClearFinished={() => poolRef.current?.clearFinished()}
        />

        <RecordsPanel
          groups={recordGroups}
          openId={openRecordId}
          kept={recordsKept}
          canImport={elementsReady}
          currentFormula={currentFormula}
          onOpen={openRecord}
          onReplay={replayRecord}
          canReplay={openedRecord !== null && openedRecord.trajectory.length > 1}
          onRename={renameRecord}
          onDelete={deleteRecord}
          onClear={clearRecords}
          onExport={exportRecords}
          onImport={(file) => void importRecords(file)}
          notice={recordNotice}
        />

        <h2>電子密度</h2>
        <label className="toggle">
          <input
            type="checkbox"
            checked={showDensity}
            onChange={(event) => setShowDensity(event.target.checked)}
          />
          電子の雲を表示する
        </label>
        <div className="row">
          <button
            type="button"
            className={channel === 'total' ? 'active' : ''}
            disabled={!showDensity}
            onClick={() => selectChannel('total')}
          >
            すべての電子
          </button>
          <button
            type="button"
            className={channel === 'bonding' ? 'active' : ''}
            disabled={!showDensity}
            onClick={() => selectChannel('bonding')}
          >
            結合に寄与する電子
          </button>
        </div>
        <IsoLevelSlider
          value={isoLevel}
          range={ISO_RANGES[channel]}
          onChange={(level) => setLevels((prev) => ({ ...prev, [channel]: level }))}
          disabled={!showDensity || !solved}
        />
        <p className="hint">{explainChannel(channel, mesh)}</p>

        <dl>
          <dt>原子数</dt>
          <dd>{atoms.length}</dd>
          <dt>状態</dt>
          <dd>
            {unavailable ? (
              <span className="error">このブラウザでは計算できません</span>
            ) : error ? (
              <span className="error">{error}</span>
            ) : computing ? (
              job ? (
                <>
                  {headline(job)} · <Elapsed since={job.startedAt} />
                </>
              ) : animation === 'optimization' ? (
                '形を調整中…'
              ) : (
                '計算中…'
              )
            ) : solved ? (
              // Which of the two the numbers are from, since the choice in the
              // panel is free to differ once the calculation is over.
              (settled ? '完了' : stopped !== null ? '途中で止めました' : '途中で終了') +
              (resultLevel === null ? '' : `（${levelLabel(resultLevel)}）`)
            ) : stopped !== null ? (
              // A structure without numbers, which is not the blank below: it
              // was solved at every step, and only the stop lost the last one.
              `途中で止めました（${levelLabel(stopped.level)}）`
            ) : (
              // A calculation that did not converge is deliberately blank rather
              // than described: the molecule flying apart on screen is what says
              // it (requirement F5), and a line of text here would be the error
              // message that requirement rules out.
              '—'
            )}
          </dd>
          <dt>形の調整</dt>
          <dd>{describeRelaxation(relaxation, solved, stopped)}</dd>
          <dt>全エネルギー</dt>
          {/* The energy of the structure on screen, which is a real number
              about a real structure even when the optimiser ran out of time
              before reaching the bottom. What is never shown is the last
              iterate of a diverging SCF: that is a number about the iteration,
              not about the molecule. */}
          <dd>{solved ? `${result.energy.toFixed(6)} Ha` : '—'}</dd>
          <dt>反復</dt>
          <dd>{solved ? `${result.iterations} 回` : '—'}</dd>
          <dt>計算時間</dt>
          <dd>{result ? `${(result.elapsedMs / 1000).toFixed(2)} 秒` : '—'}</dd>
          <dt>等値面</dt>
          <dd>{describeMesh(result, mesh, meshing)}</dd>
          <dt>WebGL</dt>
          <dd>
            {webgl === null
              ? '確認中…'
              : webgl.ok
                ? `${webgl.context} · ${webgl.renderer ?? 'renderer 不明'}`
                : webgl.disabled
                  ? '利用不可（GPU 無効）'
                  : '非対応'}
          </dd>
        </dl>
      </aside>
    </div>
  );
}

/**
 * What a record was calculated for: the one place the App reads it.
 *
 * Opening a record sets the choice back to this, and its surface is solved at
 * this rather than at whatever is chosen, so that the surface belongs to the
 * numbers beside it. Null for a model this program does not know, which only a
 * record let in before files were checked for it could carry: that one opens
 * with its numbers, and without a surface, since there is no level it could be
 * solved again at.
 */
function levelOfRecord(record: StructureRecord): ModelLevel | null {
  return levelOfModel(record.model);
}

/**
 * The same atoms at new positions, which is what a finished relaxation returns.
 *
 * Elements never change - only the optimiser's coordinates do - so the element
 * list comes from the structure that went in.
 */
function withPositions(atoms: SceneAtom[], xyz: number[]): SceneAtom[] {
  return atoms.map((atom, i) => ({
    z: atom.z,
    pos: [xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]] as [number, number, number],
  }));
}

/**
 * How far the structure got, and what stopped it.
 *
 * Only reached when the electrons were solved, so `'scf'` cannot appear here -
 * that case is the molecule coming apart on screen and gets no words at all
 * (requirement F5). The other two do get words, and they are about the
 * relaxation rather than about chemistry: hiding them would leave a
 * half-relaxed structure looking like a finished one.
 *
 * `'interrupted'` is said without saying why, because a record cannot tell: the
 * engine's budget and the user's 中止 end a relaxation the same way. Only the
 * relaxation that has just been stopped is known to be the user's (`stopped`),
 * and it is also the one exception to "only when solved": stopped by replacing
 * the worker, its structure is kept without the numbers, and how far it got is
 * still true.
 */
function describeRelaxation(
  relaxation: OptimizationOutcome | null,
  solved: boolean,
  stopped: { steps: number } | null,
): string {
  if (stopped !== null) return `中止 · ${stopped.steps} 回動いたところまで`;
  if (relaxation === null || !solved) return '—';
  const moved = `${relaxation.steps} 回動いたところまで`;
  switch (relaxation.reason) {
    case 'converged':
      return relaxation.steps === 0
        ? 'すでに安定な形でした'
        : `${relaxation.steps} 回動いて落ち着きました`;
    case 'interrupted':
      return `途中で止まりました · ${moved}`;
    case 'maxSteps':
      return `回数の上限 · ${moved}`;
    case 'scf':
      return '—';
  }
}

/**
 * What the isosurface readout says, in the states it can be in.
 *
 * An empty mesh is one of them: a threshold above the densest point of the
 * molecule has no surface to draw, which is an answer rather than a failure.
 */
function describeMesh(
  result: ScfOutcome | null,
  mesh: IsoMesh | null,
  meshing: boolean,
): string {
  if (result === null || !result.converged) return '—';
  if (meshing && mesh === null) return '生成中…';
  if (mesh === null) return '—';
  const faces = [mesh.positive, mesh.negative]
    .filter((surface) => surface.indices.length > 0)
    .map((surface) => (surface.indices.length / 3).toLocaleString());
  if (faces.length === 0) return 'しきい値が高すぎます';
  return `${faces.join(' + ')} 面 · ${Math.round(mesh.elapsedMs)} ms`;
}

/**
 * The line under the slider, which has to explain what is on screen without
 * naming a single orbital or functional (requirement F4).
 *
 * The bonding channel needs two explanations because the engine answers it two
 * different ways, so the text follows what came back rather than what was asked
 * for, and says nothing specific until the first surface arrives.
 */
function explainChannel(request: DensityRequest, mesh: IsoMesh | null): string {
  const shown: DensityChannel | null = mesh?.channel ?? null;
  if (request === 'total') {
    return 'しきい値を下げると分子全体を包む形に、上げると原子核や結合のまわりに残ります。';
  }
  if (shown === 'pi') {
    return '平らな分子なので、面から上下にはみ出している電子だけを表示しています。二重結合や環がある分子で、結合がどこに広がっているかが見えます。';
  }
  if (shown === 'deformation') {
    return '原子がばらばらだったときと比べて、電子が濃くなった場所（青）と薄くなった場所（赤）です。青が結合のできたところにあたります。';
  }
  return '原子が結びついたことで動いた電子だけを表示します。';
}

/**
 * Turns an engine-side geometry rejection into something readable.
 *
 * Only geometries the engine refuses to accept reach here. A calculation that
 * runs but does not converge is not an error and never comes through this path.
 */
function describeEngineError(message: string): string {
  if (message.includes('CoincidentAtoms')) return '原子が重なっています';
  if (message.includes('UnsupportedElement')) return '対応していない元素です';
  if (message.includes('NoElectrons')) return '電子がありません';
  return message;
}
