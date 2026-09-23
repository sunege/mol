import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LEVEL,
  LEVEL_GROUP_LABEL,
  LEVEL_ORDER,
  levelAdvice,
  levelHint,
  levelLabel,
} from './level';

/** Everything this module puts on screen, as one string. */
const said = [
  LEVEL_GROUP_LABEL,
  ...LEVEL_ORDER.flatMap((level) => [
    levelLabel(level),
    levelHint(level),
    levelAdvice(level, true) ?? '',
  ]),
].join(' ');

describe('the choice of what a calculation is for', () => {
  it('has the two decided names, finding the shape first', () => {
    expect(LEVEL_ORDER).toEqual(['shape', 'measure']);
    expect(LEVEL_ORDER.map(levelLabel)).toEqual(['形を探す', '形を測る']);
  });

  it('starts at finding the shape, which is what every calculation was before', () => {
    expect(DEFAULT_LEVEL).toBe('shape');
    expect(LEVEL_ORDER[0]).toBe(DEFAULT_LEVEL);
  });

  it('says what each one is for and how long it takes', () => {
    expect(levelHint('shape')).toBe(
      'どんな形に落ち着くかを見るための計算です。かかる時間の目安は数秒〜数十秒です。',
    );
    expect(levelHint('measure')).toBe(
      '結合の角度を数値として読むための計算です。かかる時間の目安は数十秒〜数分です。',
    );
  });

  it('tells someone measuring a structure they built to find its shape first', () => {
    // Measured: the moves are what a measurement costs, and a hand-built
    // structure makes many more of them than one that has already settled.
    expect(levelAdvice('measure', true)).toBe(
      '手で作った形は、先に「形を探す」で落ち着かせてから測ると早く終わります。',
    );
  });

  it('says nothing about a shape the app supplied, or while finding one', () => {
    // A preset, a record, or a shape a relaxation just found: already near a
    // minimum, so there is nothing to go round again.
    expect(levelAdvice('measure', false)).toBeNull();
    expect(levelAdvice('shape', true)).toBeNull();
    expect(levelAdvice('shape', false)).toBeNull();
  });

  it('does not call them better and worse', () => {
    // Measured, the slower one is not better at everything, and every result
    // here is approximate anyway.
    for (const word of ['精度', '正確', '正しく', '高い', '低い']) expect(said).not.toContain(word);
  });

  it('says it without naming a single DFT parameter (requirement F4)', () => {
    const forbidden = ['基底', 'STO-3G', '6-31G', '汎関数', 'LDA', '電荷', '多重度', 'DFT'];
    for (const word of forbidden) expect(said).not.toContain(word);
  });
});
