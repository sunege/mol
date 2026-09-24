/**
 * The words of the status lines at the top of the panel (V5-2).
 *
 * Moved out of the App so the rules requirement F5 sets on them can be tested:
 * a calculation that did not converge is `—` and nothing else, "solved" (the
 * numbers may be shown) is not "settled" (the shape may be called finished),
 * and a relaxation the user stopped keeps saying how far it got.
 */
import type { IsoMesh, ModelLevel, OptimizationOutcome, ScfOutcome } from '../worker/protocol';
import { levelLabel } from './level';

/**
 * The state line once nothing is running.
 *
 * Which level the numbers are from is said, since the choice in the panel is
 * free to differ once the calculation is over. A structure stopped without
 * numbers is not the blank at the end: it was solved at every step, and only
 * the stop lost the last one. A calculation that did not converge is
 * deliberately blank rather than described: the molecule flying apart on
 * screen is what says it (requirement F5), and a line of text here would be
 * the error message that requirement rules out.
 */
export function describeOutcome({
  solved,
  settled,
  stopped,
  resultLevel,
}: {
  solved: boolean;
  settled: boolean;
  stopped: { level: ModelLevel } | null;
  resultLevel: ModelLevel | null;
}): string {
  if (solved) {
    const said = settled ? '完了' : stopped !== null ? '途中で止めました' : '途中で終了';
    return said + (resultLevel === null ? '' : `（${levelLabel(resultLevel)}）`);
  }
  if (stopped !== null) return `途中で止めました（${levelLabel(stopped.level)}）`;
  return '—';
}

/**
 * Whether the structure on screen is part of the way down, so that pressing
 * 安定な形にする again carries on from it.
 */
export function isPartWay(
  relaxation: OptimizationOutcome | null,
  solved: boolean,
  stopped: object | null,
): boolean {
  return (relaxation !== null && solved && relaxation.reason !== 'converged') || stopped !== null;
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
export function describeRelaxation(
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
export function describeMesh(
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
