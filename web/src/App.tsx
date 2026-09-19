import { useCallback, useEffect, useRef, useState } from 'react';
import { MoleculeViewer, type SceneAtom } from './scene/viewer';
import { probeWebGl, type WebGlProbe } from './scene/webgl';
import { DftWorkerClient } from './worker/workerClient';
import { PRESETS, toWorkerArrays } from './molecules/presets';
import { PeriodicPicker } from './components/PeriodicPicker';
import { ISO_RANGES, IsoLevelSlider } from './components/IsoLevelSlider';
import { Elapsed, ProgressOverlay } from './components/ProgressOverlay';
import { headline, type JobKind, type JobState } from './components/progress';
import { divergenceFrames } from './animation/divergence';
import { FramePlayer } from './animation/framePlayer';
import { hasUsableStructure } from './worker/protocol';
import { EngineUnavailableError, engineNotice, type EngineProblem } from './worker/engineSupport';
import type {
  CalculationProgress,
  DensityChannel,
  DensityRequest,
  ElementInfo,
  IsoMesh,
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
 */
export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<MoleculeViewer | null>(null);
  const clientRef = useRef<DftWorkerClient | null>(null);

  const [atoms, setAtoms] = useState<SceneAtom[]>(PRESETS[0].atoms);
  const [presetId, setPresetId] = useState<string | null>(PRESETS[0].id);
  const [elements, setElements] = useState<ElementInfo[]>([]);
  const [activeZ, setActiveZ] = useState(6);
  const [selected, setSelected] = useState<number | null>(null);
  const [result, setResult] = useState<ScfOutcome | null>(null);
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

  // Identifies the calculation whose result is still wanted. Cancelling or
  // editing bumps it, so a reply that arrives afterwards is ignored instead of
  // overwriting the state of a newer request.
  const requestRef = useRef(0);
  const inFlightRef = useRef(false);

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

  const cancelCalculation = useCallback(() => {
    // Replacing the worker is not free, so only do it when something is actually
    // running - every edit comes through here.
    if (!inFlightRef.current) return;
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
  }, [stopAnimation]);

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
    setError(null);
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
      setSelected(null);
      invalidateResult();
    },
    [activeZ, invalidateResult],
  );

  const moveAtom = useCallback(
    (index: number, pos: [number, number, number]) => {
      setAtoms((prev) => prev.map((atom, i) => (i === index ? { ...atom, pos } : atom)));
      setPresetId(null);
      invalidateResult();
    },
    [invalidateResult],
  );

  const deleteSelected = useCallback(() => {
    setSelected((index) => {
      if (index === null) return null;
      setAtoms((prev) => prev.filter((_, i) => i !== index));
      setPresetId(null);
      return null;
    });
    invalidateResult();
  }, [invalidateResult]);

  const clearAll = useCallback(() => {
    setAtoms([]);
    setPresetId(null);
    setSelected(null);
    invalidateResult();
  }, [invalidateResult]);

  // The viewer is created once, so it calls through a ref that always holds the
  // current handlers rather than the ones captured at mount.
  const handlers = useRef({ placeAtom, moveAtom, setSelected, finishAnimation });
  handlers.current = { placeAtom, moveAtom, setSelected, finishAnimation };

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
      client.dispose();
      viewerRef.current = null;
      clientRef.current = null;
      playerRef.current = null;
    };
  }, []);

  // --- viewer synchronisation ---------------------------------------------

  const elementsReady = elements.length > 0;

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
    stopAnimation();
    setComputing(true);
    // Drop the previous answer immediately: leaving it on screen next to
    // "計算中…" reads as though it belonged to the run in progress.
    setResult(null);
    setError(null);
    const onProgress = beginJob('single', token);
    client
      .scf(z, xyz, onProgress)
      .then((outcome) => {
        if (requestRef.current !== token) return;
        inFlightRef.current = false;
        setComputing(false);
        setResult(outcome);
        if (!outcome.converged) {
          endJob(false);
          showDivergence(atoms);
          return;
        }
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
        reportFailure(e);
      });
  }, [
    atoms,
    showDensity,
    channel,
    isoLevel,
    requestIsosurface,
    showDivergence,
    stopAnimation,
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
    const token = ++requestRef.current;
    inFlightRef.current = true;
    stopAnimation();
    setComputing(true);
    setResult(null);
    setError(null);
    // The geometry is about to change under it, so the surface on screen belongs
    // to a molecule that will not exist in a moment.
    hasDensityRef.current = false;
    wantedRef.current = null;
    meshRequestRef.current += 1;
    setMesh(null);
    setAnimation('optimization');
    const onProgress = beginJob('relax', token);

    client
      .optimize(
        z,
        xyz,
        (step) => {
          if (requestRef.current !== token) return;
          player.push(step.xyz);
        },
        onProgress,
      )
      .then((outcome) => {
        if (requestRef.current !== token) return;
        inFlightRef.current = false;
        setComputing(false);
        setResult(outcome);

        const relaxed = outcome.optimization;
        if (!outcome.converged || !relaxed || !hasUsableStructure(relaxed)) {
          endJob(false);
          showDivergence(original);
          return;
        }
        // Whatever stopped it, the structure it reached is one the electrons
        // were solved for, so it is the molecule now - partly relaxed if the
        // budget ran out, fully relaxed if it settled. It is committed here
        // rather than when the animation ends, so that the answer does not
        // depend on frames the browser may not be drawing.
        setAtoms(withPositions(original, relaxed.xyz));
        setPresetId(null);
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
        setComputing(false);
        endJob(false);
        stopAnimation();
        reportFailure(e);
      });
  }, [
    atoms,
    showDensity,
    channel,
    isoLevel,
    requestIsosurface,
    showDivergence,
    stopAnimation,
    finishAnimation,
    beginJob,
    endJob,
    reportFailure,
  ]);

  // --- keyboard ------------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selected !== null) {
          event.preventDefault();
          deleteSelected();
        }
      } else if (event.key === 'Escape') {
        setSelected(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selected, deleteSelected]);

  // Narrowed once, so every readout below agrees on what counts as an answer.
  //
  // The gate is the *electrons*, not the structure. Every number below - the
  // energy, the iteration count, the density surface - describes the molecule
  // currently on screen, and that description is true whenever its SCF
  // converged, whether or not the optimiser had time to reach the bottom. What
  // the optimiser managed is a separate line of its own.
  const relaxation = result?.optimization ?? null;
  const solved = result !== null && result.converged;
  const settled = solved && (relaxation === null || relaxation.converged);
  const selectedAtom = selected === null ? null : atoms[selected];
  const selectedSymbol = selectedAtom
    ? (elements.find((e) => e.z === selectedAtom.z)?.symbol ?? `Z=${selectedAtom.z}`)
    : null;

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
                setSelected(null);
                invalidateResult();
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <h2>計算</h2>
        <div className="row">
          <button
            type="button"
            className={computing ? '' : 'active'}
            onClick={computing ? cancelCalculation : relax}
            disabled={unavailable !== null || atoms.length === 0}
          >
            {computing ? '中止' : '安定な形にする'}
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
          {relaxation !== null && solved && relaxation.reason !== 'converged'
            ? 'いまの形は途中までのものです。もう一度「安定な形にする」を押すと、' +
              'ここから続きを計算します。'
            : '「安定な形にする」を押すと、原子どうしが引き合う力・押し合う力を計算して、' +
              '落ち着く形まで少しずつ動かします。原子の数が多いほど時間がかかります。'}
        </p>

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
              settled ? '完了' : '途中で終了'
            ) : (
              // A calculation that did not converge is deliberately blank rather
              // than described: the molecule flying apart on screen is what says
              // it (requirement F5), and a line of text here would be the error
              // message that requirement rules out.
              '—'
            )}
          </dd>
          <dt>形の調整</dt>
          <dd>{describeRelaxation(relaxation, solved)}</dd>
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
 * (requirement F5). The other two do get words, and they are about the clock
 * rather than about chemistry: "it ran out of time" is a fact about this
 * computer, and hiding it would leave a half-relaxed structure looking like a
 * finished one.
 */
function describeRelaxation(
  relaxation: OptimizationOutcome | null,
  solved: boolean,
): string {
  if (relaxation === null || !solved) return '—';
  const moved = `${relaxation.steps} 回動いたところまで`;
  switch (relaxation.reason) {
    case 'converged':
      return relaxation.steps === 0
        ? 'すでに安定な形でした'
        : `${relaxation.steps} 回動いて落ち着きました`;
    case 'interrupted':
      return `時間切れ · ${moved}`;
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
