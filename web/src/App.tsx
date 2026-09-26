import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MoleculeViewer, type AtomCharge, type SceneAtom } from './scene/viewer';
import { findBonds } from './scene/bonds';
import { probeWebGl, type WebGlProbe } from './scene/webgl';
import { keyAction, type ViewerMode } from './scene/gestures';
import { measureAtoms, toggleMeasured } from './scene/measure';
import { LiveMeasurement } from './scene/liveMeasurement';
import { DftWorkerClient, RelaxationStopped } from './worker/workerClient';
import { PRESETS, toWorkerArrays } from './molecules/presets';
import { atomsFromFlat, withPositions } from './molecules/atoms';
import {
  ANION_CAVEAT,
  ION_GROUP_LABEL,
  ION_OPTIONS,
  chargeOfChoice,
  choiceOfCharge,
  hasAnion,
  hasIons,
  ionOptions,
  type IonChoice,
} from './components/ion';
import { PeriodicPicker } from './components/PeriodicPicker';
import { ISO_RANGES, IsoLevelSlider } from './components/IsoLevelSlider';
import {
  DEFAULT_REQUEST,
  channelLabel,
  channelNote,
  explainChannel,
  offeredChannels,
  type DensitySurface,
} from './components/density';
import { OrbitalPanel } from './components/OrbitalPanel';
import { DistanceScan } from './components/DistanceScan';
import { carryPick, samePick, type Bond, type OrbitalPick } from './components/orbital';
import { pickDirection, sameDirection, type Vec3 } from './components/orient';
import {
  SCAN_HEADING,
  SCAN_TEASER,
  atomFraction,
  buildCorrelation,
  diagramEnds,
  scanPairFor,
  type RungMakeup,
  type ScanPair,
} from './components/scan';
import { ProgressOverlay } from './components/ProgressOverlay';
import { ObservePanel } from './components/ObservePanel';
import { type JobKind, type JobState } from './components/progress';
import { divergenceFrames } from './animation/divergence';
import { FramePlayer } from './animation/framePlayer';
import { needsNudge, perturb, randomSeed, PERTURB_AMPLITUDE } from './records/perturb';
import {
  chargesOf,
  createRecord,
  headingOf,
  levelOfModel,
  moleculeHeading,
  type StructureRecord,
} from './records/record';
import { groupRecords } from './records/log';
import { openRecordStore, type RecordStore } from './records/store';
import { mergeRecords, readStructureLog, writeStructureLog } from './records/file';
import { RecordExplorer } from './components/RecordExplorer';
import {
  EXPLORER_WORDS,
  deleteConfirm,
  exportFileName,
  importProblemText,
  importedText,
} from './components/records';
import { SearchPanel } from './components/SearchPanel';
import { NUDGED_COUNT, canCancel } from './components/search';
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
  DensityRequest,
  ElementInfo,
  IsoMesh,
  ModelLevel,
  OrbitalCharacter,
  OrbitalLevel,
  ScanPoint,
  ScfOutcome,
  SpinChannel,
} from './worker/protocol';
import {
  ActionGrid,
  Choices,
  IconButton,
  RunButton,
  Segmented,
  type SegmentedOption,
} from './components/controls';
import { Fold } from './components/Fold';
import { FrameIcon } from './components/icons';
import { viewportHint } from './components/viewportHint';
import { StatusHeader } from './components/StatusHeader';
import { TabPanel, Tabs } from './components/Tabs';
import { useNarrow } from './components/useNarrow';
import { runSlots, stopSlots } from './components/actions';
import { describeMesh, describeOutcome, describeRelaxation, isPartWay } from './components/status';
import './App.css';

/** 形を探す / 形を測る, in the order the panel shows them. */
const LEVEL_OPTIONS: readonly SegmentedOption<ModelLevel>[] = LEVEL_ORDER.map((each) => ({
  value: each,
  label: levelLabel(each),
}));

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
  // The narrow screen's third tab (V5-10): the records in place of the tab's
  // body, without touching `mode`. Choosing a mode tab, or a calculation
  // moving the panel to 観察, puts it away. Ignored on a wide screen, where the
  // records have their own column.
  const narrow = useNarrow();
  const [narrowRecords, setNarrowRecords] = useState(false);
  const showRecords = narrow && narrowRecords;
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
  // The density button chosen, which is never the orbital: what is drawn is
  // `channel` below, and the two selections are kept apart so that coming back
  // from an orbital comes back to the density that was up before it.
  const [densityRequest, setDensityRequest] = useState<DensitySurface>(DEFAULT_REQUEST);
  /**
   * The orbital the section below is showing, or null while a density is.
   *
   * Only one surface is ever drawn, so this is also what says which of the two
   * sections the viewer belongs to: with an orbital picked no density button is
   * active, and picking a density button drops the orbital. Making it one
   * decision rather than two flags is what keeps them from both being on.
   */
  const [orbitalPick, setOrbitalPick] = useState<OrbitalPick | null>(null);
  // The same, for the places that drop it from inside an effect, where the
  // render's copy is a frame behind.
  const pickRef = useRef<OrbitalPick | null>(null);
  // Which way the picked orbital is turned, for a line that is one of a
  // degenerate set (`OrbitalPick.along`), or null. Worked out from the camera
  // when the line is pressed and kept with the pick: every threshold is cut
  // through the same orbital, however the view has been turned since (V6-8).
  // It is set and dropped with the pick, in the same handlers.
  const [orbitalDirection, setOrbitalDirection] = useState<Vec3 | null>(null);
  const directionRef = useRef<Vec3 | null>(null);
  // The orbital that was on screen when the marker of "近づけてみる" moved the
  // atoms, with the ladder it was picked from, until the ladder of the
  // calculation at the new separation arrives and it is found again in that
  // (`carryPick`). Any other edit drops it (`invalidateResult`).
  const carryRef = useRef<{
    pick: OrbitalPick;
    levels: OrbitalLevel[];
    direction: Vec3 | null;
  } | null>(null);
  // The calculation the marker starts once it has been still for a moment.
  const markerTimerRef = useRef<number | undefined>(undefined);
  // Whether the orbital section is open. It is closed to begin with, and the
  // ladder is only fetched while it is open (`components/OrbitalPanel.tsx`).
  const [orbitalsOpen, setOrbitalsOpen] = useState(false);
  // Whether "近づけてみる" is open, which is a closed section of its own after
  // that one (V5-6). The free atoms' levels are only fetched while it is open,
  // and it needs the ladder too: the middle column of its correlation diagram.
  const [scanOpen, setScanOpen] = useState(false);
  // The rungs of the calculation the worker is holding, once they have been
  // asked for. Null whenever there is no ladder that belongs to what is on
  // screen, which every calculation makes true again.
  const [orbitalLevels, setOrbitalLevels] = useState<OrbitalLevel[] | null>(null);
  // What the orbital picked above does to the bonds, and its sign above each
  // nucleus. Null until the round trip that fetches it answers, and fetched
  // when the orbital changes rather than when its threshold does - the
  // threshold cuts a new surface through the same orbital.
  const [orbitalCharacter, setOrbitalCharacter] = useState<OrbitalCharacter | null>(null);
  // How much of each rung of the ladder sits on each of the two nuclei, for the
  // correlation diagram. Only ever fetched for a molecule of two atoms, which
  // is the only shape that diagram can be drawn for, and one round trip per
  // rung: the same `orbitalCharacter` the words above are read out of.
  const [orbitalWeights, setOrbitalWeights] = useState<RungMakeup[]>([]);
  // The orbital levels of the two elements on screen as free atoms, which are
  // the two ends of that diagram. About the elements rather than about any
  // calculation, so it survives everything except a change of element.
  const [freeAtomLevels, setFreeAtomLevels] = useState<number[][] | null>(null);
  // What has come back from the distance scan that was run, which only ever
  // walks the two atoms on screen. `scanPair` is the pair as it was asked for,
  // so the axis of the figure does not move when the marker moves the atoms.
  const [scanPair, setScanPair] = useState<ScanPair | null>(null);
  const [scanPoints, setScanPoints] = useState<ScanPoint[]>([]);
  const [scanMarker, setScanMarker] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  // The same, for the handlers that have to know from inside a callback.
  const scanningRef = useRef(false);
  // Identifies the scan whose points are still wanted, as `requestRef` does for
  // a calculation: a point that arrives after the user gave up is dropped.
  const scanTokenRef = useRef(0);
  // A level per channel, so switching back and forth keeps each where it was.
  const [levels, setLevels] = useState<Record<DensityRequest, number>>({
    total: ISO_RANGES.total.initial,
    bonding: ISO_RANGES.bonding.initial,
    deformation: ISO_RANGES.deformation.initial,
    orbital: ISO_RANGES.orbital.initial,
  });
  /**
   * Whether the molecule on screen has electrons above and below a plane, as
   * far as anything here knows: it decides whether the bonding surface is
   * offered at all (`components/density.ts`).
   *
   * Only the engine can answer it, so it is read off a calculation - but it
   * belongs to the *molecule*, not to that calculation, which is why it is not
   * taken from `result`. `result` is dropped the moment a new run starts, and a
   * button that vanished for the fifteen seconds a molecule was being solved
   * again, taking the user's choice with it, would be worse than one that says
   * what was true a moment ago. It is cleared where the atoms are replaced or
   * edited instead, which is where the answer really does stop applying.
   */
  const [hasPi, setHasPi] = useState(false);
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
  // What is drawn: the orbital while one is picked, and the chosen density
  // otherwise. Derived rather than stored, so there is no state in which both
  // are on.
  const channel: DensityRequest = orbitalPick === null ? densityRequest : 'orbital';
  const isoLevel = levels[channel];
  // The density's own threshold, which its slider keeps showing while an
  // orbital is on screen.
  const densityLevel = levels[densityRequest];

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
  /**
   * The same, for the part of the screen that has to re-render when it changes:
   * a ref changes nothing on its own.
   *
   * `generation` counts the calculations rather than tracking `held`, because
   * a second calculation of the same structure never drops the density - it
   * replaces it - and the orbital ladder taken from the first is stale all the
   * same. Anything watching a calculation, rather than watching whether there
   * is one, watches this.
   */
  const [density, setDensity] = useState({ held: false, generation: 0 });
  const setHasDensity = useCallback((held: boolean) => {
    hasDensityRef.current = held;
    setDensity((previous) => ({ held, generation: previous.generation + 1 }));
  }, []);
  // Isosurface requests are coalesced. The worker is single-threaded, so
  // queueing every level a slider drag passes through would leave the surface
  // running seconds behind the pointer; instead one request is in flight and
  // the newest level waits its turn, replacing any older one that was waiting.
  //
  // `orbital` and `spin` ride along for `channel: 'orbital'`, which names one
  // orbital of one spin's ladder rather than a set of electrons; `atom` makes it
  // a free atom's orbital instead, and `along` turns a degenerate set's member
  // to point that way (V6-8).
  const wantedRef = useRef<{
    channel: DensityRequest;
    level: number;
    orbital?: number;
    spin?: SpinChannel;
    atom?: number;
    along?: Vec3;
  } | null>(null);
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
      setNarrowRecords(false);
      switchMode(next);
    },
    [switchMode],
  );

  /** A calculation is starting. */
  const observeWhileRunning = useCallback(() => {
    restoreModeRef.current = mode;
    setNarrowRecords(false);
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
    setHasDensity(false);
    clientRef.current?.cancelAll();
    setComputing(false);
    setJob(null);
    stopAnimation();
  }, [stopAnimation, restoreMode, setHasDensity]);

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
   * Gives up on the distance scan in flight, which is the brutal kind of stop.
   *
   * A scan cannot be asked to stop between points the way a relaxation can -
   * nothing about it is shared with the page - so the worker is replaced, and
   * that takes the calculation it was holding with it. The points already
   * received are kept, because each of them is a finished answer about a
   * geometry; the surface on screen is not, and has to be solved again from the
   * SCF. The section says so before the button is pressed (`SCAN_STOP_HINT`).
   */
  const stopScan = useCallback(() => {
    if (!scanningRef.current) return;
    scanTokenRef.current += 1;
    scanningRef.current = false;
    setScanning(false);
    setHasDensity(false);
    wantedRef.current = null;
    meshRequestRef.current += 1;
    setMesh(null);
    clientRef.current?.cancelAll();
  }, [setHasDensity]);

  /**
   * Every edit invalidates the last result and abandons a calculation that is
   * still running for the old geometry. Called from the edit handlers rather
   * than from an effect on `atoms`, so the molecule and the readout change in
   * the same render.
   */
  const invalidateResult = useCallback(() => {
    carryRef.current = null;
    window.clearTimeout(markerTimerRef.current);
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
    setHasDensity(false);
    // And these are different atoms now: whether they have a pi system is a
    // question nobody has asked yet.
    setHasPi(false);
    wantedRef.current = null;
    meshRequestRef.current += 1;
    setMesh(null);
    // A calculation that has finished may still be waiting for its first
    // surface, which will not be wanted now either.
    setJob(null);
    cancelCalculation();
    // A scan is of the two atoms on screen, and it is holding the one worker,
    // which whatever replaces these atoms wants back. The points already
    // received stay, and are drawn for as long as the same pair is on screen.
    stopScan();
  }, [cancelCalculation, stopAnimation, stopScan, setHasDensity]);

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

  /**
   * Makes the selected atom an ion, or neutral again (v7). Only the charge
   * changes: the positions are where they were, so `handBuilt` - which says
   * where the positions came from - and the measurements both stay. The answer
   * on screen was for another molecule, though, so it goes.
   */
  const chargeSelected = useCallback(
    (choice: IonChoice) => {
      if (selected === null) return;
      const charge = chargeOfChoice(choice);
      setAtoms((prev) =>
        prev.map((atom, i) => {
          if (i !== selected) return atom;
          // Neutral carries no `charge` at all, the shape `atoms.ts` builds.
          return charge === 0 ? { z: atom.z, pos: atom.pos } : { z: atom.z, pos: atom.pos, charge };
        }),
      );
      invalidateResult();
    },
    [selected, invalidateResult],
  );

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
              charges: candidate.charges,
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

  /** A molecule's or a level's records at once, from its "…" (V6-2). */
  const deleteRecords = useCallback((ids: string[], what: string) => {
    if (!window.confirm(deleteConfirm(what, ids.length))) return;
    const gone = new Set(ids);
    setRecords((previous) => previous.filter((existing) => !gone.has(existing.id)));
    setOpenRecordId((open) => (open !== null && gone.has(open) ? null : open));
    setRecordNotice(null);
    void storeRef.current?.removeMany(ids);
  }, []);

  const clearRecords = useCallback(() => {
    if (!window.confirm('記録をすべて消します。よろしいですか？')) return;
    setRecords([]);
    setOpenRecordId(null);
    setRecordNotice(null);
    void storeRef.current?.clear();
  }, []);

  /** Atoms from the flattened arrays the records and the search both keep (absent charges: neutral). */
  const atomsOfFlat = useCallback(
    (z: ArrayLike<number>, xyz: ArrayLike<number>, charges?: ArrayLike<number>): SceneAtom[] =>
      atomsFromFlat(z, xyz, charges),
    [],
  );

  /** The atoms of a structure kept in a record, which stores them flattened - ions and all. */
  const atomsOfRecord = useCallback(
    (record: StructureRecord, xyz: readonly number[]): SceneAtom[] =>
      atomsOfFlat(record.z, xyz, chargesOf(record)),
    [atomsOfFlat],
  );

  // --- viewer synchronisation ---------------------------------------------

  const elementsReady = elements.length > 0;

  const symbolOf = useCallback(
    (z: number) => elements.find((element) => element.z === z)?.symbol ?? `Z=${z}`,
    [elements],
  );

  // The same for the radii, which are what the bonds on screen are inferred
  // from (`scene/bonds.ts`). The fallback is only ever reached before the table
  // arrives, when there is nothing built to draw bonds between anyway.
  const covalentRadiusOf = useCallback(
    (z: number) => elements.find((element) => element.z === z)?.covalentRadius ?? 0.8,
    [elements],
  );

  useEffect(() => {
    symbolOfRef.current = symbolOf;
    covalentRadiusRef.current = covalentRadiusOf;
  }, [symbolOf, covalentRadiusOf]);

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
          const next = await client.isosurface(
            wanted.channel,
            wanted.level,
            wanted.orbital,
            wanted.spin,
            wanted.atom,
            wanted.along,
          );
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

  /**
   * Asks for a surface. `pick` is read only for the orbital channel, which
   * names one orbital of one spin's ladder rather than a set of electrons - or
   * of a free atom's, which has no spin to send - and `direction` only with it.
   */
  const requestIsosurface = useCallback(
    (
      wanted: DensityRequest,
      level: number,
      pick: OrbitalPick | null,
      direction: Vec3 | null = null,
    ) => {
      const along = direction === null ? {} : { along: direction };
      wantedRef.current =
        wanted !== 'orbital' || pick === null
          ? { channel: wanted, level }
          : pick.atom !== undefined
            ? { channel: wanted, level, orbital: pick.index, atom: pick.atom, ...along }
            : { channel: wanted, level, orbital: pick.index, spin: pick.spin, ...along };
      void pumpIsosurface();
    },
    [pumpIsosurface],
  );

  // A new threshold, a different channel, another orbital, or switching the
  // surface back on all ask for a fresh mesh. A finished calculation does the
  // same from its own handler, where the density first becomes available.
  useEffect(() => {
    if (showDensity && hasDensityRef.current) {
      requestIsosurface(channel, isoLevel, orbitalPick, orbitalDirection);
    }
  }, [channel, isoLevel, orbitalPick, orbitalDirection, showDensity, requestIsosurface]);

  /**
   * Drops the surface on screen rather than leaving it up while the next one is
   * cut: they are drawn in different colours and mean different things, so the
   * stale one would be read as the new one. An orbital and a density are the
   * worst pair of all, since both can be signed and only one of the two is
   * about how many electrons are anywhere.
   */
  const dropMesh = useCallback(() => {
    meshRequestRef.current += 1;
    setMesh(null);
  }, []);

  /** A density button: it is also how the user leaves an orbital. */
  const selectChannel = useCallback(
    (next: DensitySurface) => {
      if (pickRef.current !== null || next !== densityRequest) dropMesh();
      pickRef.current = null;
      setOrbitalPick(null);
      setOrbitalDirection(null);
      setDensityRequest(next);
    },
    [densityRequest, dropMesh],
  );

  /**
   * A row of the orbital ladder, or a line of the correlation diagram, with the
   * way it is turned if it is one of a set.
   *
   * The cloud is switched on if it was off: the surface is the whole of the
   * answer here, and a click that drew nothing would look like a failure. The
   * same pick again is drawn again only if it now points another way - the
   * same line pressed after turning the view (V6-8).
   */
  const selectOrbital = useCallback(
    (pick: OrbitalPick, direction: Vec3 | null) => {
      if (samePick(pickRef.current, pick) && sameDirection(directionRef.current, direction)) return;
      pickRef.current = pick;
      directionRef.current = direction;
      setOrbitalPick(pick);
      setOrbitalDirection(direction);
      setShowDensity(true);
      dropMesh();
    },
    [dropMesh],
  );

  /**
   * A line pressed in the section: turned, if it is one of a set, to the two
   * atoms and the camera as they are at this moment. Without a viewer (no
   * WebGL) the camera is taken as square on to the world.
   */
  const pressOrbital = useCallback(
    (pick: OrbitalPick) =>
      selectOrbital(
        pick,
        pickDirection(pick.along, atoms, viewerRef.current?.cameraAxes() ?? null),
      ),
    [atoms, selectOrbital],
  );

  /** Whatever the orbital belonged to has gone: back to the density. */
  const forgetOrbital = useCallback(() => {
    if (pickRef.current === null) return;
    pickRef.current = null;
    directionRef.current = null;
    setOrbitalPick(null);
    setOrbitalDirection(null);
    dropMesh();
  }, [dropMesh]);

  // The buttons the panel offers, which is not always all three.
  const offered = useMemo(() => offeredChannels(hasPi), [hasPi]);

  // A molecule edited until it is no longer flat loses the bonding button, and
  // must not be left showing a surface nobody can switch away from. Only the
  // density buttons are in question: an orbital is not one of them, and is not
  // sent back to the default by a molecule losing its pi system.
  useEffect(() => {
    if (!offered.includes(densityRequest)) selectChannel(DEFAULT_REQUEST);
  }, [offered, densityRequest, selectChannel]);

  /**
   * The orbital ladder of the calculation the worker is holding, while the
   * section that shows it is open.
   *
   * Every calculation invalidates it - a new one at the same geometry as much
   * as a new geometry - so it is dropped and, if the section is open, asked for
   * again. It is cheap enough for that: a few matrix products on a calculation
   * that is already solved, a fifth of a millisecond for benzene, and no
   * lattice. Sliding the threshold does not come through here, which is the
   * point of fetching it from a calculation rather than from a render.
   *
   * The orbital picked goes with it, because the rung it named belonged to that
   * calculation.
   *
   * Two sections want it: this one, and "近づけてみる" for the middle column of
   * its correlation diagram. They go in as one value, so that opening or
   * closing the second while the first is open neither fetches the ladder
   * again nor drops the orbital picked in it.
   */
  const wantLevels = orbitalsOpen || scanOpen;
  useEffect(() => {
    forgetOrbital();
    setOrbitalLevels(null);
    const client = clientRef.current;
    if (!wantLevels || !client || !hasDensityRef.current || resultLevel !== 'shape') return;
    let live = true;
    client
      .orbitals()
      .then((ladder) => {
        if (!live) return;
        setOrbitalLevels(ladder);
        // The marker moved the atoms with an orbital on screen: the same
        // orbital at the new separation, if there is one.
        const carried = carryRef.current;
        carryRef.current = null;
        const pick = carried && carryPick(carried.pick, carried.levels, ladder);
        // Along the same axis it was turned to, not the camera's now.
        if (pick) selectOrbital(pick, carried.direction);
      })
      .catch((e: Error) => {
        // The worker was replaced, or it is holding nothing. The section says
        // there is nothing to show, which is what the user can see anyway.
        if (live && import.meta.env.DEV) console.debug('no orbitals', e);
      });
    return () => {
      live = false;
    };
  }, [wantLevels, density, resultLevel, forgetOrbital, selectOrbital]);

  // Closing the orbital section drops the orbital picked in it, whether or not
  // the ladder stays for the other section: an orbital left on screen with
  // nothing to change it by would be a surface the user cannot leave.
  useEffect(() => {
    if (orbitalsOpen) return;
    carryRef.current = null;
    forgetOrbital();
  }, [orbitalsOpen, forgetOrbital]);

  /**
   * What the orbital on screen is like, in the words under it.
   *
   * Fetched when the orbital changes and at no other time. Moving the threshold
   * cuts a new surface through the same orbital, so none of this changes with
   * it - the one line that does is the count of blobs, and that is read off the
   * mesh rather than asked for. `orbitalPick` is a stable value for as long as
   * one orbital is picked, because `selectOrbital` drops a repeat of the same
   * one, so this runs once per choice; and every calculation drops the pick,
   * which brings these words down with it.
   */
  useEffect(() => {
    setOrbitalCharacter(null);
    const client = clientRef.current;
    // A free atom's orbital is not one of the molecule's, and its words are
    // not about bonds (`atomPickWords`).
    if (orbitalPick === null || orbitalPick.atom !== undefined) return;
    if (!client || !hasDensityRef.current) return;
    let live = true;
    client
      .orbitalCharacter(orbitalPick.index, orbitalPick.spin)
      .then((character) => {
        if (live) setOrbitalCharacter(character);
      })
      .catch((e: Error) => {
        // The worker was replaced, or it is holding nothing. The lines stay
        // away rather than describing another calculation's orbital.
        if (live && import.meta.env.DEV) console.debug('no orbital character', e);
      });
    return () => {
      live = false;
    };
  }, [orbitalPick]);

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
   * The two ends of the correlation diagram: the elements on screen as free
   * atoms.
   *
   * About the elements rather than about any calculation - the engine answers
   * it with nothing loaded at all - so it is asked for by the pair of atomic
   * numbers and kept until those change. Only while the section that draws it
   * is open - the molecular-orbital one since V6-4, where the diagram stands in
   * for the ladder of two atoms - and only for the two atoms it can be drawn
   * between.
   *
   * An atom made into an ion is the free ion at its end (V7-7), so the key is
   * each atom's number and charge, "1:1,1:0" for H⁺ beside H: a charge moved
   * from one atom to the other is a different pair of ends.
   */
  const scanPairKey =
    atoms.length === 2 ? atoms.map((atom) => `${atom.z}:${atom.charge ?? 0}`).join(',') : null;
  const scanPairEnds = useMemo(
    () =>
      scanPairKey === null
        ? null
        : scanPairKey.split(',').map((end) => {
            const [z, charge] = end.split(':').map(Number);
            return { z, charge };
          }),
    [scanPairKey],
  );
  useEffect(() => {
    setFreeAtomLevels(null);
    const client = clientRef.current;
    if (!orbitalsOpen || !client || scanPairEnds === null) return;
    let live = true;
    client
      .atomLevels(
        new Uint8Array(scanPairEnds.map((end) => end.z)),
        new Int8Array(scanPairEnds.map((end) => end.charge)),
      )
      .then((levels) => {
        if (live) setFreeAtomLevels(levels);
      })
      .catch((e: Error) => {
        // The worker was replaced. The diagram stays away rather than being
        // drawn with one end of it missing.
        if (live && import.meta.env.DEV) console.debug('no atom levels', e);
      });
    return () => {
      live = false;
    };
  }, [orbitalsOpen, scanPairEnds]);

  /**
   * How much of each rung sits on each nucleus, which is what the lines between
   * the columns of the correlation diagram are drawn from, and whether it is
   * bonding between them, which is the star on its name (V4-10).
   *
   * One round trip per rung, over the same `orbitalCharacter` the words under
   * the ladder are read out of, and a degenerate rung is asked about once: its
   * orbitals are one set rotated into each other and sit on the two atoms
   * alike. It goes with the ladder - once per calculation, while the section is
   * open - and only for a molecule of two atoms.
   */
  const atomCount = atoms.length;
  useEffect(() => {
    setOrbitalWeights([]);
    const client = clientRef.current;
    if (orbitalLevels === null || atomCount !== 2 || !client) return;
    let live = true;
    void (async () => {
      const found: RungMakeup[] = [];
      for (const level of orbitalLevels) {
        try {
          const character = await client.orbitalCharacter(level.first, level.spin);
          found.push({
            shares: [0, 1].map((atom) => atomFraction(character.populations, 2, atom)),
            overlap: character.populations[1] ?? 0,
          });
        } catch (e) {
          // The worker was replaced, or it is holding nothing: no lines rather
          // than lines belonging to another calculation.
          if (import.meta.env.DEV) console.debug('no orbital weights', e);
          return;
        }
        if (!live) return;
      }
      setOrbitalWeights(found);
    })();
    return () => {
      live = false;
    };
  }, [orbitalLevels, atomCount]);

  /**
   * The correlation diagram of the two atoms on screen, which the orbital
   * section draws in place of the ladder (V6-4). Only once both ends of it and
   * the molecule between them are in: one end missing would be a different
   * picture, not a partial one. The headings come from the same atomic
   * numbers and charges the free atoms were asked for, so the two cannot
   * disagree.
   */
  const correlationEnds = useMemo(
    () => (scanPairEnds === null ? [] : diagramEnds(scanPairEnds, symbolOf)),
    [scanPairEnds, symbolOf],
  );
  const correlation = useMemo(
    () =>
      correlationEnds.length !== 2 ||
      freeAtomLevels === null ||
      freeAtomLevels.length < 2 ||
      orbitalLevels === null ||
      orbitalLevels.length === 0
        ? null
        : buildCorrelation(freeAtomLevels, correlationEnds, orbitalLevels, orbitalWeights),
    [correlationEnds, freeAtomLevels, orbitalLevels, orbitalWeights],
  );

  /**
   * The pair a scan would walk: the two atoms on screen, and nothing else
   * (V5-11: offering other pairs put them in the viewer as the marker moved).
   */
  const screenPair = useMemo(() => {
    if (atoms.length !== 2) return null;
    const [a, b] = atoms;
    const distance = Math.hypot(
      b.pos[0] - a.pos[0],
      b.pos[1] - a.pos[1],
      b.pos[2] - a.pos[2],
    );
    return scanPairFor([a.z, b.z], distance, [a.charge ?? 0, b.charge ?? 0]);
  }, [atoms]);

  /**
   * Whether the scan that was run is of the atoms on screen. Moving the marker
   * keeps them the same elements in the same order, with the same charges; any
   * other edit that leaves two atoms (another preset, a record, an element or a
   * charge changed) makes the figure about a molecule that is not there, so it
   * is not drawn and its marker cannot put that other pair back.
   */
  const scanOnScreen =
    scanPair !== null &&
    screenPair !== null &&
    [0, 1].every(
      (i) => scanPair.z[i] === screenPair.z[i] && scanPair.charges[i] === screenPair.charges[i],
    );

  /**
   * Walks the chosen pair from one separation to the next, drawing as it goes.
   *
   * A calculation per point, streamed exactly as a relaxation's steps are, so
   * the figure grows while the rest of them are still being solved. It takes
   * the one front worker, which is why nothing else may be running - and why it
   * deliberately leaves the calculation that worker is holding alone: the
   * surface on screen survives a scan (`worker/protocol.ts`).
   */
  const startScan = useCallback(() => {
    const client = clientRef.current;
    const pair = screenPair;
    if (!client || pair === null || scanningRef.current || inFlightRef.current) return;
    const token = ++scanTokenRef.current;
    scanningRef.current = true;
    setScanning(true);
    setScanPair(pair);
    setScanPoints([]);
    setScanMarker(null);
    setError(null);
    client
      .scan(
        new Uint8Array(pair.z),
        pair.from,
        pair.to,
        pair.points,
        (point) => {
          if (scanTokenRef.current === token) setScanPoints((previous) => [...previous, point]);
        },
        undefined,
        new Int8Array(pair.charges),
      )
      .then(() => {
        if (scanTokenRef.current !== token) return;
        scanningRef.current = false;
        setScanning(false);
      })
      .catch((e: Error) => {
        // Not the user giving up, which bumps the token before it terminates
        // the worker: this is the engine refusing the pair or the range.
        if (scanTokenRef.current !== token) return;
        scanningRef.current = false;
        setScanning(false);
        reportFailure(e);
      });
  }, [screenPair, reportFailure]);

  /**
   * Puts the two atoms at the separation the marker was moved to.
   *
   * An edit as far as the rest of the app is concerned, and it goes through the
   * same invalidation: the numbers, the surface and the ladder all belong to
   * the geometry that was on screen a moment ago. What it deliberately does not
   * do is calculate - the button beside it does that - since a drag would
   * otherwise start one per step.
   */
  const placeScanPoint = useCallback(
    (index: number): SceneAtom[] | null => {
      setScanMarker(index);
      const point = scanPoints[index];
      if (point === undefined || scanPair === null || !scanOnScreen) return null;
      // Still waiting from a move a moment ago, or the orbital on screen now.
      const carry =
        carryRef.current ??
        (pickRef.current !== null && orbitalLevels !== null
          ? { pick: pickRef.current, levels: orbitalLevels, direction: directionRef.current }
          : null);
      const placed = alongTheAxis(atoms, scanPair, point.distance);
      setAtoms(placed);
      setPresetId(null);
      // A shape this app placed, along the axis the pair is already on: not the
      // flat, hand-built one the nudge before a relaxation is for.
      setHandBuilt(false);
      setSelected(null);
      invalidateResult();
      carryRef.current = carry;
      return placed;
    },
    [atoms, scanPoints, scanPair, scanOnScreen, orbitalLevels, invalidateResult],
  );

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

  const calculate = useCallback((structure: SceneAtom[] = atoms) => {
    const client = clientRef.current;
    if (!client || structure.length === 0) return;
    const { z, xyz, charges } = toWorkerArrays(structure);
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
      .scf(z, xyz, onProgress, level, charges)
      .then((outcome) => {
        if (requestRef.current !== token) return;
        inFlightRef.current = false;
        setComputing(false);
        setResult(outcome);
        setResultLevel(level);
        if (!outcome.converged) {
          endJob(false);
          restoreMode();
          showDivergence(structure);
          return;
        }
        keepObserving();
        // The worker is now holding a density; show it without making the user
        // ask, so placing atoms and seeing the cloud is one action.
        setHasDensity(true);
        setHasPi(outcome.hasPi);
        endJob(showDensity);
        // The density, never an orbital: the ladder this calculation replaced
        // has been dropped along with whatever was picked from it.
        if (showDensity) requestIsosurface(densityRequest, densityLevel, null);
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
    densityRequest,
    densityLevel,
    requestIsosurface,
    showDivergence,
    stopAnimation,
    observeWhileRunning,
    keepObserving,
    restoreMode,
    beginJob,
    endJob,
    reportFailure,
    setHasDensity,
  ]);

  /**
   * The marker moved: the atoms go there at once, and once it has been still
   * for {@link MARKER_SETTLE_MS} they are calculated, so the cloud or the
   * orbital that was on screen comes back at the new separation without a
   * button (V5-11: it used to wait for a 「この距離で計算」 button, now gone,
   * and read as the surface simply vanishing). A drag goes through many separations and only
   * the last is solved; a move while that is running cancels it, as any edit
   * does. Nothing is started over a calculation someone else began meanwhile.
   */
  const moveMarker = useCallback(
    (index: number) => {
      const placed = placeScanPoint(index);
      if (placed === null) return;
      markerTimerRef.current = window.setTimeout(() => {
        if (!inFlightRef.current && !scanningRef.current) calculate(placed);
      }, MARKER_SETTLE_MS);
    },
    [placeScanPoint, calculate],
  );

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
    const { z, xyz, charges } = toWorkerArrays(original);
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
    setHasDensity(false);
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
        charges,
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
            charges,
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

        setHasDensity(true);
        setHasPi(outcome.hasPi);
        endJob(showDensity);
        // The density, never an orbital: the ladder this calculation replaced
        // has been dropped along with whatever was picked from it.
        if (showDensity) requestIsosurface(densityRequest, densityLevel, null);
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
    densityRequest,
    densityLevel,
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
    setHasDensity,
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
      const { z, xyz, charges } = toWorkerArrays(structure);
      const token = ++requestRef.current;
      inFlightRef.current = true;
      relaxingRef.current = false;
      setComputing(true);
      const onProgress = beginJob('single', token);
      client
        .scf(z, xyz, onProgress, recordLevel, charges)
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
          setHasDensity(true);
          setHasPi(outcome.hasPi);
          endJob(true);
          requestIsosurface(densityRequest, densityLevel, null);
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
    [
      densityRequest,
      densityLevel,
      requestIsosurface,
      beginJob,
      endJob,
      reportFailure,
      setHasDensity,
    ],
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
      setHasDensity(false);
      // A record does not carry it - the oldest ones predate the question - so
      // it comes back from the single point the surface is solved from.
      setHasPi(false);
      wantedRef.current = null;
      meshRequestRef.current += 1;
      setMesh(null);
      if (showDensity && recorded !== null) solveForSurface(opened, recorded);
    },
    [
      atomsOfRecord,
      cancelCalculation,
      stopAnimation,
      switchMode,
      showDensity,
      solveForSurface,
      setHasDensity,
    ],
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
      const { z, xyz, charges } = toWorkerArrays(atoms);
      const source = {
        z,
        xyz,
        charges,
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
      const structure = atomsOfFlat(candidate.z, candidate.start, candidate.charges);
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
      setHasDensity(false);
      setHasPi(false);
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
      setHasDensity,
    ],
  );

  // The extra line under the choice of level, when there is one to say.
  const advice = atoms.length === 0 ? null : levelAdvice(level, handBuilt);
  // The ion row's atom: the selected one, while it is still there.
  const selectedAtom = selected === null ? undefined : atoms[selected];
  const ionRow =
    selected === null || selectedAtom === undefined ? ION_OPTIONS : ionOptions(atoms, selected);

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
      const chosen = only === null ? records : records.filter((r) => headingOf(r) === only);
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
  // The molecule on screen, whose branch of the records tree is open and marked:
  // its heading, the formula with the charge the user put on it (H₃O⁺).
  const currentFormula =
    atoms.length > 0
      ? moleculeHeading(
          atoms.map((a) => a.z),
          atoms.map((a) => a.charge ?? 0),
          symbolOf,
        )
      : null;
  // What the orbital section may talk about: the bonds the viewer is drawing -
  // a guess from the geometry the engine has never seen (`scene/bonds.ts`) -
  // and one symbol per atom. Computed rather than memoised: a molecule of this
  // app has a few tens of pairs, and the section is the only reader.
  const orbitalBonds: Bond[] = orbitalsOpen ? findBonds(atoms, covalentRadiusOf) : [];
  const orbitalSymbols = orbitalsOpen ? atoms.map((atom) => symbolOf(atom.z)) : [];

  // The tree orders the molecules itself, by when each was first recorded (V6-1),
  // so opening a record does not move its molecule.
  const recordGroups = useMemo(() => groupRecords(records), [records]);

  const relaxation = result?.optimization ?? null;
  const solved = result !== null && result.converged;
  const settled = solved && (relaxation === null || relaxation.converged);
  const measuredSymbols = measured
    .filter((i) => i < atoms.length)
    .map((i) => symbolOf(atoms[i].z));
  const measuredBefore =
    relaxedFrom !== null && measured.length >= 2 ? measureAtoms(relaxedFrom, measured) : null;

  // Drawn in one place only: the left column, or the narrow screen's sheet.
  const explorer = (
    <RecordExplorer
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
      onDeleteMany={deleteRecords}
      onClear={clearRecords}
      onExport={exportRecords}
      onImport={(file) => void importRecords(file)}
      notice={recordNotice}
      candidates={candidates}
      symbolOf={symbolOf}
      onOpenCandidate={openCandidate}
      onCancel={(candidate) => poolRef.current?.cancel(candidate.id)}
      onCancelAll={() => poolRef.current?.cancelAll()}
      onClearFinished={() => poolRef.current?.clearFinished()}
      foldable={!narrow}
    />
  );

  return (
    <div className="app">
      {!narrow && explorer}
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
        {/* What the pointer does here, for the tab that is showing. Only over
            a working view: with no engine or no WebGL the notice above says
            why there is nothing to point at. */}
        {!unavailable && webgl?.ok && (
          <p className="viewport-hint">{viewportHint(mode, atoms.length)}</p>
        )}
        {!unavailable && (
          <div className="viewport-tools">
            <IconButton
              label="全体表示"
              onClick={() => viewerRef.current?.frameAll()}
              disabled={atoms.length === 0}
            >
              <FrameIcon />
            </IconButton>
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
        <StatusHeader
          unavailable={unavailable !== null}
          error={error}
          computing={computing}
          job={job}
          relaxing={animation === 'optimization'}
          outcome={describeOutcome({ solved, settled, stopped, resultLevel })}
          relaxation={describeRelaxation(relaxation, solved, stopped)}
          energy={solved ? result.energy : null}
          stops={stopSlots({
            computing,
            stopping: job?.stopping ?? false,
            unavailable: unavailable !== null,
            atomCount: atoms.length,
          })}
          onStop={stopCalculation}
        />

        <Tabs
          mode={mode}
          onChoose={chooseMode}
          records={
            narrow
              ? {
                  chosen: narrowRecords,
                  onChoose: () => setNarrowRecords(true),
                  busy: candidates.some(canCancel),
                  busyLabel: EXPLORER_WORDS.running,
                }
              : undefined
          }
        />

        <div className={showRecords ? 'panel-body records' : 'panel-body'}>
          {!showRecords && (
            <p className="phase">原子を置くと、落ち着く形と電子の雲を計算します</p>
          )}

          {showRecords ? (
            <TabPanel tab="records">{explorer}</TabPanel>
          ) : mode === 'edit' ? (
            <TabPanel tab="edit">
              <h2>プリセット</h2>
              <ActionGrid columns={5}>
                {PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={preset.id === presetId ? 'btn active' : 'btn'}
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
              </ActionGrid>

              <h2>配置する元素</h2>
              <PeriodicPicker elements={elements} value={activeZ} onChange={setActiveZ} />

              {/* 削除 names no element: which atom goes is the one selected in
                  the view, and a name in the label would widen it. */}
              <ActionGrid columns={2}>
                <button
                  type="button"
                  className="btn"
                  onClick={deleteSelected}
                  disabled={selected === null}
                >
                  削除
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={clearAll}
                  disabled={atoms.length === 0}
                >
                  全消去
                </button>
              </ActionGrid>
              {/* The ion row (v7): the charge goes on the selected atom. Nothing
                  selected leaves all three there and disabled, like 削除; which
                  ones a selected atom cannot take is `ionOptions`. Fixed while a
                  calculation runs, like the level below. */}
              <Segmented
                label={ION_GROUP_LABEL}
                options={ionRow}
                value={choiceOfCharge(selectedAtom?.charge)}
                onChange={chargeSelected}
                disabled={selectedAtom === undefined || computing}
              />
              {hasAnion(atoms) && <p className="hint anion-caveat">{ANION_CAVEAT}</p>}

              <h2>次の計算</h2>
              {/* Fixed while a calculation runs: the answer on its way belongs to
                  the choice it was started with. */}
              <Segmented
                label={LEVEL_GROUP_LABEL}
                options={LEVEL_OPTIONS}
                value={level}
                onChange={setLevel}
                disabled={unavailable !== null || computing}
              />
              <p className="hint level-hint">{levelHint(level)}</p>
              {/* Advice, not a warning: what is about to be pressed still works, and
                  is not held back (`components/level.ts`). */}
              {advice !== null && <p className="hint level-hint">{advice}</p>}
              {/* The tab reads top to bottom as place, choose, run (V6-3). The
                  stops are at the top of the panel instead, and only while
                  something runs (StatusHeader): starting a calculation moves
                  the panel to the observe tab. */}
              <p className="hint">
                {'「安定な形にする」を押すと、原子どうしが引き合う力・押し合う力を計算して、' +
                  '落ち着く形まで少しずつ動かします。原子の数が多いほど時間がかかります。'}
              </p>
              <ActionGrid columns={2}>
                {runSlots({
                  computing,
                  unavailable: unavailable !== null,
                  atomCount: atoms.length,
                }).map((slot) => (
                  <RunButton
                    key={slot.action}
                    onClick={() => (slot.action === 'relax' ? relax() : calculate())}
                    disabled={slot.disabled}
                  >
                    {slot.label}
                  </RunButton>
                ))}
              </ActionGrid>
              {!computing && isPartWay(relaxation, solved, stopped) && (
                <p className="hint">もう一度「安定な形にする」を押すと、ここから続きを計算します。</p>
              )}

              <SearchPanel
                candidates={candidates}
                atomCount={atoms.length}
                unavailable={unavailable !== null}
                onTryCurrent={() => startSearch(0)}
                onTryNudged={() => startSearch(NUDGED_COUNT)}
              />
            </TabPanel>
          ) : (
            <TabPanel tab="observe">
              {/* Next to the numbers in the header, and above everything else in
                  the tab so that it appearing moves nothing it would cover. */}
              {hasAnion(atoms) && <p className="hint anion-caveat">{ANION_CAVEAT}</p>}
              <ObservePanel
                live={liveMeasurement}
                before={measuredBefore}
                symbols={measuredSymbols}
                showBondLengths={showBondLengths}
                onShowBondLengths={setShowBondLengths}
                onClear={() => setMeasured([])}
              />

              <div className="section-head">
                <h2>電子の雲</h2>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={showDensity}
                    onChange={(event) => setShowDensity(event.target.checked)}
                    aria-label="電子の雲を表示する"
                  />
                  表示する
                </label>
              </div>
              {/* None of them is chosen while an orbital is on screen: only one
                  surface is ever drawn, and pressing one of these is how the user
                  comes back to a density. Stacked, so the bonding row appearing
                  second moves nothing above it. */}
              <Choices
                label="電子の雲"
                options={offered.map((request) => ({
                  value: request,
                  label: channelLabel(request),
                  description: channelNote(request),
                }))}
                value={orbitalPick === null ? densityRequest : null}
                onChange={selectChannel}
                disabled={!showDensity}
              />
              {/* The density's own threshold, which keeps its place while an orbital
                  is up - and is not slid then, because it would move nothing. */}
              <IsoLevelSlider
                value={densityLevel}
                range={ISO_RANGES[densityRequest]}
                onChange={(level) => setLevels((prev) => ({ ...prev, [densityRequest]: level }))}
                disabled={!showDensity || !solved || orbitalPick !== null}
              />
              <p className="hint">
                {/* Ions are read off the atoms on screen, like `hasPi`, so the words
                    do not change back while a calculation runs. */}
                {explainChannel(densityRequest, orbitalPick === null ? mesh : null, hasIons(atoms))}
              </p>

              <OrbitalPanel
                open={orbitalsOpen}
                onOpenChange={setOrbitalsOpen}
                levels={orbitalLevels}
                // A ladder is on its way whenever the worker is holding a calculation
                // this section can read one from.
                loading={orbitalLevels === null && density.held && resultLevel === 'shape'}
                otherLevel={solved && resultLevel !== 'shape'}
                picked={orbitalPick}
                onPick={pressOrbital}
                isoLevel={levels.orbital}
                onIsoLevel={(level) => setLevels((prev) => ({ ...prev, orbital: level }))}
                character={orbitalCharacter}
                bonds={orbitalBonds}
                symbols={orbitalSymbols}
                ends={correlationEnds}
                // The blobs of the surface that is up now, and only while that
                // surface is the orbital's: a density's are a different picture.
                lobes={mesh !== null && mesh.channel === 'orbital' ? mesh.lobes : null}
                diatomic={atoms.length === 2}
                correlation={correlation}
              />

              {/* Two atoms approaching, which only two atoms can do, so the section
                  is not there otherwise. Outside everything the ladder is gated on:
                  a scan solves its own geometries, so it needs no calculation to
                  have been run first (the correlation diagram in it does). */}
              {atoms.length === 2 && (
                <Fold
                  heading={SCAN_HEADING}
                  teaser={SCAN_TEASER}
                  open={scanOpen}
                  onOpenChange={setScanOpen}
                >
                  <DistanceScan
                    running={scanning}
                    disabled={unavailable !== null || computing}
                    points={scanOnScreen ? scanPoints : []}
                    range={scanOnScreen ? scanPair : null}
                    markerIndex={scanMarker}
                    markerDisabled={unavailable !== null || (computing && job?.kind !== 'single')}
                    onMarker={moveMarker}
                    onStart={startScan}
                    onStop={stopScan}
                  />
                </Fold>
              )}

              {/* What is left of the list that used to end the panel: numbers for
                  the curious, closed until asked for. The state and the energy are
                  at the top (StatusHeader). */}
              <Fold heading="詳細" teaser="反復・計算時間・等値面" className="details">
                <dl>
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
              </Fold>
            </TabPanel>
          )}
        </div>
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
 * How long the marker of "近づけてみる" must be still before the separation it
 * is at is calculated. Long enough that a drag, which moves it every few
 * milliseconds, starts nothing until it stops; short next to the second or two
 * the calculation itself takes for a diatomic.
 */
const MARKER_SETTLE_MS = 400;

/**
 * The two atoms of a scan, placed at one of its separations.
 *
 * Along the axis the pair on screen is already on, about the middle of it, so
 * that dragging the marker stretches the molecule the user is looking at rather
 * than swinging it into some other orientation. The pair is always the one on
 * screen (V5-11), so the elements - and the charges on them - are the ones already there.
 */
function alongTheAxis(
  atoms: readonly SceneAtom[],
  { z, charges }: Pick<ScanPair, 'z' | 'charges'>,
  distance: number,
): SceneAtom[] {
  const a = atoms[0]?.pos ?? [0, 0, 0];
  const b = atoms[1]?.pos ?? [1, 0, 0];
  const away: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const length = Math.hypot(away[0], away[1], away[2]);
  const along = length > 1e-6 ? away.map((value) => value / length) : [1, 0, 0];
  const middle = atoms.length === 2 ? [0, 1, 2].map((i) => (a[i] + b[i]) / 2) : [0, 0, 0];
  const place = (sign: number): [number, number, number] => [
    middle[0] + sign * along[0] * distance * 0.5,
    middle[1] + sign * along[1] * distance * 0.5,
    middle[2] + sign * along[2] * distance * 0.5,
  ];
  // The ions stay the ions they were (V7-7); neutral carries no `charge` at all.
  const atom = (i: 0 | 1, pos: [number, number, number]): SceneAtom =>
    charges[i] === 0 ? { z: z[i], pos } : { z: z[i], pos, charge: charges[i] as AtomCharge };
  return [atom(0, place(-1)), atom(1, place(1))];
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
