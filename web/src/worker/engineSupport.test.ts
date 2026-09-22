/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canStopInPlace,
  checkEngineSupport,
  engineNotice,
  EngineUnavailableError,
  SIMD_PROBE,
  SUPPORTED_BROWSERS,
  type EngineProblem,
} from './engineSupport';

const PROBLEMS: EngineProblem[] = ['no-webassembly', 'no-simd', 'failed-to-load'];

describe('the SIMD probe', () => {
  it('is a module this engine accepts', () => {
    // Node has had WebAssembly SIMD since 16.4, like every browser the app runs in.
    expect(WebAssembly.validate(SIMD_PROBE)).toBe(true);
  });

  it('differs from a plain module only in its SIMD instruction', () => {
    // The same module with the v128 result and `v128.const` swapped for an i32
    // and `i32.const 0`, section sizes adjusted. That it validates shows the
    // framing is right, so the only thing a browser without SIMD can reject in
    // the probe is the SIMD itself - which is the question being asked.
    const plain = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f, // () -> i32
      0x03, 0x02, 0x01, 0x00,
      0x0a, 0x06, 0x01, 0x04, 0x00, // one 4-byte body
      0x41, 0x00, // i32.const 0
      0x0b,
    ]);
    expect(WebAssembly.validate(plain)).toBe(true);
    expect([...SIMD_PROBE.slice(0, 8)]).toEqual([...plain.slice(0, 8)]);
    // v128 is the result type, and the body is the SIMD prefix and v128.const.
    expect(SIMD_PROBE[14]).toBe(0x7b);
    expect([...SIMD_PROBE.slice(24, 26)]).toEqual([0xfd, 0x0c]);
  });

  it('is asked of the same engine that runs the real module', () => {
    // And the real module, which needs SIMD, is accepted where the probe is.
    const engine = readFileSync(new URL('../wasm/dft_wasm_bg.wasm', import.meta.url));
    expect(WebAssembly.validate(engine)).toBe(true);
  });
});

describe('checking a browser', () => {
  it('passes one with WebAssembly SIMD', () => {
    expect(checkEngineSupport()).toBeNull();
  });

  it('asks about SIMD with the probe', () => {
    const asked: BufferSource[] = [];
    checkEngineSupport({
      validate: (bytes) => {
        asked.push(bytes);
        return true;
      },
    });
    expect(asked).toEqual([SIMD_PROBE]);
  });

  it('recognises one without SIMD', () => {
    expect(checkEngineSupport({ validate: () => false })).toBe('no-simd');
  });

  it('recognises one without WebAssembly', () => {
    expect(checkEngineSupport(null)).toBe('no-webassembly');
    expect(checkEngineSupport({} as never)).toBe('no-webassembly');
  });

  it('does not trust an engine that throws on a well-formed module', () => {
    const broken = {
      validate: () => {
        throw new Error('internal error');
      },
    };
    expect(checkEngineSupport(broken)).toBe('no-simd');
  });
});

/**
 * Whether 中止 can keep the numbers too. Never a reason not to calculate: a
 * page without it stops the way it always did, by replacing the worker.
 */
describe('stopping a worker in place', () => {
  it('needs a page that is cross-origin isolated', () => {
    expect(canStopInPlace({ crossOriginIsolated: true, SharedArrayBuffer })).toBe(true);
    // Served without COOP/COEP, or embedded by a page that is not isolated:
    // the constructor may be there, and memory still cannot be shared.
    expect(canStopInPlace({ crossOriginIsolated: false, SharedArrayBuffer })).toBe(false);
    expect(canStopInPlace({ SharedArrayBuffer })).toBe(false);
  });

  it('needs SharedArrayBuffer itself', () => {
    expect(canStopInPlace({ crossOriginIsolated: true })).toBe(false);
  });

  it('is not something the engine support check knows about', () => {
    // Node is not a page and is not isolated, and the engine runs in it.
    expect(canStopInPlace()).toBe(false);
    expect(checkEngineSupport()).toBeNull();
  });
});

describe('telling the user', () => {
  it.each(PROBLEMS)('says which browsers work, for %s', (problem) => {
    const notice = engineNotice(problem);
    expect(notice.title.length).toBeGreaterThan(0);
    expect(notice.body).toContain(SUPPORTED_BROWSERS);
  });

  it('names the versions that were checked', () => {
    // webassembly.org (SIMD, reference types) and MDN (module workers). A change
    // here should come from those tables again, not from memory.
    expect(SUPPORTED_BROWSERS).toContain('Chrome / Edge 96');
    expect(SUPPORTED_BROWSERS).toContain('Firefox 114');
    expect(SUPPORTED_BROWSERS).toContain('Safari 16.4');
  });

  it.each(PROBLEMS)('never names a DFT parameter, for %s', (problem) => {
    const { title, body } = engineNotice(problem);
    expect(title + body).not.toMatch(/多重度|スピン|電荷|基底|STO|LDA|汎関数|SCF|DFT/);
  });

  it('keeps what went wrong on the error, for whoever is debugging', () => {
    const error = new EngineUnavailableError('failed-to-load', 'CompileError: invalid opcode 0xfd');
    expect(error).toBeInstanceOf(Error);
    expect(error.problem).toBe('failed-to-load');
    expect(error.message).toContain('invalid opcode 0xfd');
  });
});
