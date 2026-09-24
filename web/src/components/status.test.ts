import { describe, expect, it } from 'vitest';
import type {
  IsoMesh,
  OptimizationOutcome,
  OptimizationReason,
  ScfOutcome,
} from '../worker/protocol';
import { describeMesh, describeOutcome, describeRelaxation, isPartWay } from './status';

function relaxed(reason: OptimizationReason, steps: number): OptimizationOutcome {
  return { converged: reason === 'converged', reason, steps, xyz: [], maxForce: 0 };
}

const converged = { converged: true } as ScfOutcome;
const diverged = { converged: false } as ScfOutcome;

function meshOf(positive: number, negative: number): IsoMesh {
  const surface = (faces: number) => ({ indices: new Uint32Array(3 * faces) });
  return { positive: surface(positive), negative: surface(negative), elapsedMs: 41.6 } as IsoMesh;
}

describe('how far the structure got', () => {
  it('says a settled relaxation settled, and whether it had to move at all', () => {
    expect(describeRelaxation(relaxed('converged', 0), true, null)).toBe('すでに安定な形でした');
    expect(describeRelaxation(relaxed('converged', 7), true, null)).toBe(
      '7 回動いて落ち着きました',
    );
  });

  it('says a relaxation that ran out of time or steps did not settle, and how far it got', () => {
    expect(describeRelaxation(relaxed('interrupted', 4), true, null)).toBe(
      '途中で止まりました · 4 回動いたところまで',
    );
    expect(describeRelaxation(relaxed('maxSteps', 200), true, null)).toBe(
      '回数の上限 · 200 回動いたところまで',
    );
  });

  it('says how far a stopped relaxation got, with or without the numbers', () => {
    expect(describeRelaxation(relaxed('interrupted', 3), true, { steps: 3 })).toBe(
      '中止 · 3 回動いたところまで',
    );
    expect(describeRelaxation(null, false, { steps: 5 })).toBe('中止 · 5 回動いたところまで');
  });

  it('says nothing about a calculation that did not converge (F5)', () => {
    expect(describeRelaxation(relaxed('scf', 2), false, null)).toBe('—');
    expect(describeRelaxation(relaxed('interrupted', 2), false, null)).toBe('—');
    expect(describeRelaxation(null, true, null)).toBe('—');
  });
});

describe('the state line once nothing runs', () => {
  it('calls only a settled result finished, and names its level', () => {
    const base = { solved: true, stopped: null, resultLevel: 'shape' as const };
    expect(describeOutcome({ ...base, settled: true })).toBe('完了（形を探す）');
    expect(describeOutcome({ ...base, settled: false })).toBe('途中で終了（形を探す）');
    expect(describeOutcome({ ...base, settled: true, resultLevel: null })).toBe('完了');
  });

  it('says a stop was the user’s, with or without the numbers', () => {
    const stopped = { level: 'measure' as const };
    expect(describeOutcome({ solved: true, settled: false, stopped, resultLevel: 'measure' })).toBe(
      '途中で止めました（形を測る）',
    );
    expect(describeOutcome({ solved: false, settled: false, stopped, resultLevel: null })).toBe(
      '途中で止めました（形を測る）',
    );
  });

  it('is a dash for a calculation that did not converge (F5)', () => {
    expect(
      describeOutcome({ solved: false, settled: false, stopped: null, resultLevel: 'shape' }),
    ).toBe('—');
  });
});

describe('whether pressing relax again carries on', () => {
  it('holds for a relaxation that stopped short, or one the user stopped', () => {
    expect(isPartWay(relaxed('interrupted', 3), true, null)).toBe(true);
    expect(isPartWay(relaxed('maxSteps', 200), true, null)).toBe(true);
    expect(isPartWay(null, false, { steps: 2 })).toBe(true);
  });

  it('does not hold for a settled one, a single point or one that fell apart', () => {
    expect(isPartWay(relaxed('converged', 5), true, null)).toBe(false);
    expect(isPartWay(null, true, null)).toBe(false);
    expect(isPartWay(relaxed('scf', 2), false, null)).toBe(false);
  });
});

describe('the isosurface readout', () => {
  it('is a dash without a converged calculation (F5)', () => {
    expect(describeMesh(null, null, false)).toBe('—');
    expect(describeMesh(diverged, meshOf(10, 0), false)).toBe('—');
  });

  it('says a surface is being cut, and counts the faces of each sign', () => {
    expect(describeMesh(converged, null, true)).toBe('生成中…');
    expect(describeMesh(converged, meshOf(120, 0), false)).toBe('120 面 · 42 ms');
    expect(describeMesh(converged, meshOf(10, 20), false)).toBe('10 + 20 面 · 42 ms');
  });

  it('says a threshold above the whole molecule is too high, not a failure', () => {
    expect(describeMesh(converged, meshOf(0, 0), false)).toBe('しきい値が高すぎます');
  });
});
