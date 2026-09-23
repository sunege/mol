import { describe, expect, it } from 'vitest';
import { DEFAULT_REQUEST, channelLabel, explainChannel, offeredChannels } from './density';
import type { DensityChannel, DensityRequest, IsoMesh } from '../worker/protocol';

/** A mesh that only says which channel the engine drew, which is all this reads. */
const drew = (channel: DensityChannel) => ({ channel }) as IsoMesh;

const REQUESTS: DensityRequest[] = ['total', 'bonding', 'deformation'];

/** Everything this module puts on screen, as one string. */
const said = REQUESTS.flatMap((request) => [
  channelLabel(request),
  explainChannel(request, null),
  ...(['total', 'pi', 'deformation'] as DensityChannel[]).map((channel) =>
    explainChannel(request, drew(channel)),
  ),
]).join(' ');

describe('which surfaces are offered', () => {
  it('always offers every electron and the ones that moved', () => {
    // The deformation density exists for any molecule at all, so it is never
    // the button that disappears.
    expect(offeredChannels(false)).toEqual(['total', 'deformation']);
    expect(DEFAULT_REQUEST).toBe('total');
  });

  it('offers the bonding surface only where there is a pi system behind it', () => {
    expect(offeredChannels(true)).toEqual(['total', 'bonding', 'deformation']);
    expect(offeredChannels(false)).not.toContain('bonding');
  });

  it('keeps the same order whichever are offered, so a button does not move', () => {
    const many = offeredChannels(true);
    expect(offeredChannels(false)).toEqual(many.filter((request) => request !== 'bonding'));
  });
});

describe('the line under the slider', () => {
  it('explains the two surfaces that are answered only one way straight away', () => {
    // Nothing to wait for: what comes back is what was asked for, so the line
    // is the same before the first surface and after it.
    for (const request of ['total', 'deformation'] as DensityRequest[]) {
      const before = explainChannel(request, null);
      expect(before).toBe(explainChannel(request, drew(request as DensityChannel)));
      expect(before).not.toBe('');
    }
  });

  it('follows what the engine drew for a bonding request, not what was asked', () => {
    // The one request answered two ways, and the two look nothing alike: one is
    // a density above the plane, the other is signed and drawn in two colours.
    expect(explainChannel('bonding', drew('pi'))).toContain('面から上下');
    expect(explainChannel('bonding', drew('deformation'))).toContain('薄くなった場所');
    expect(explainChannel('bonding', drew('pi'))).not.toBe(
      explainChannel('bonding', drew('deformation')),
    );
  });

  it('says nothing specific about a bonding request until the surface arrives', () => {
    const waiting = explainChannel('bonding', null);
    expect(waiting).not.toContain('面から上下');
    expect(waiting).not.toContain('青');
  });

  it('says the same thing for the deformation density however it was reached', () => {
    // Asked for by name, or arrived at because the molecule has no pi system:
    // it is the same picture and needs the same words.
    expect(explainChannel('deformation', drew('deformation'))).toBe(
      explainChannel('bonding', drew('deformation')),
    );
  });

  it('names no DFT parameter, whichever button and whichever answer (requirement F4)', () => {
    const forbidden = [
      '基底',
      'STO-3G',
      '6-31G',
      '汎関数',
      'LDA',
      'VWN',
      '電荷',
      '多重度',
      'DFT',
      '軌道',
    ];
    for (const word of forbidden) {
      expect(said).not.toContain(word);
      expect(said.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });
});
