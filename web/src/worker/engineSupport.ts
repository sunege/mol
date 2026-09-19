/**
 * Whether this browser can run the DFT engine at all.
 *
 * The engine is WebAssembly compiled with SIMD (`.cargo/config.toml`), and a
 * browser without SIMD cannot compile the module - not run it slowly, not
 * compile it. Before this check existed that failure happened inside the worker
 * and was never reported: the worker never said it was ready, every request
 * waited for it forever, and the app sat on an empty periodic table without a
 * word. Asking first, on the main thread, costs a 43-byte validation and means
 * the answer can be a sentence instead.
 *
 * SIMD is the last WebAssembly feature this build needs to arrive in every
 * engine. The versions below are the first with *everything* the app needs -
 * WebAssembly SIMD, reference types (on by default in Rust's wasm target) and
 * ES-module workers - taken from the webassembly.org feature table and MDN's
 * compatibility data rather than from memory. SIMD only decides the Safari
 * figure; Chrome's comes from reference types and Firefox's from module workers.
 */

/** Why the engine cannot run here. */
export type EngineProblem =
  /** No `WebAssembly` at all: very old, or switched off by a setting or policy. */
  | 'no-webassembly'
  /** WebAssembly without SIMD, which this build is compiled for. */
  | 'no-simd'
  /** Everything checked out, and the module still did not load. */
  | 'failed-to-load';

/** The first browser versions that run the whole app. */
export const SUPPORTED_BROWSERS =
  'Chrome / Edge 96 以降、Firefox 114 以降、Safari 16.4 以降（iPhone・iPad は iOS 16.4 以降）';

/**
 * The smallest module that needs SIMD: one function returning a `v128`,
 *
 * ```wat
 * (module (func (result v128) (v128.const i64x2 0 0)))
 * ```
 *
 * Checked with wasm-opt when it was written: valid with SIMD enabled, and
 * rejected with only the MVP features ("all used features should be allowed").
 * `validate` compiles nothing and runs nothing, so asking is instant.
 */
export const SIMD_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // "\0asm", version 1
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b, // type section: () -> v128
  0x03, 0x02, 0x01, 0x00, // function section: function 0 has type 0
  0x0a, 0x16, 0x01, 0x14, 0x00, // code section: one 20-byte body, no locals
  0xfd, 0x0c, ...new Array<number>(16).fill(0), // v128.const, sixteen zero bytes
  0x0b, // end
]);

/** The part of the `WebAssembly` namespace the check uses. */
export type WebAssemblyLike = Pick<typeof WebAssembly, 'validate'>;

/**
 * What stops the engine from running in this browser, or null if nothing
 * visible does. `wasm` is injectable so the tests can play an old browser;
 * `null` is a browser with no WebAssembly at all.
 */
export function checkEngineSupport(
  wasm: WebAssemblyLike | null | undefined = globalThis.WebAssembly,
): EngineProblem | null {
  if (typeof wasm?.validate !== 'function') return 'no-webassembly';
  try {
    return wasm.validate(SIMD_PROBE) ? null : 'no-simd';
  } catch {
    // An engine that throws on a well-formed module is not one to trust with
    // the real one either.
    return 'no-simd';
  }
}

/**
 * The engine could not be started, and nothing sent to it will be answered.
 *
 * Distinct from an ordinary rejection because the interface does something
 * different with it: an ordinary failure is about one request, this one is
 * about the browser, and says so in place of the whole app.
 */
export class EngineUnavailableError extends Error {
  readonly problem: EngineProblem;

  constructor(problem: EngineProblem, detail?: string) {
    super(detail ? `engine unavailable (${problem}): ${detail}` : `engine unavailable (${problem})`);
    this.name = 'EngineUnavailableError';
    this.problem = problem;
  }
}

/** What to tell the user, in the place the app would otherwise be. */
export function engineNotice(problem: EngineProblem): { title: string; body: string } {
  switch (problem) {
    case 'no-simd':
      return {
        title: 'このブラウザでは計算エンジンが動きません',
        body:
          '計算に必要な機能（WebAssembly SIMD）に対応していないためです。' +
          `${SUPPORTED_BROWSERS}で開いてください。`,
      };
    case 'no-webassembly':
      return {
        title: 'このブラウザでは計算エンジンが動きません',
        body:
          'WebAssembly が使えないためです。ブラウザの設定やセキュリティ機能で無効になっていないかを確かめるか、' +
          `${SUPPORTED_BROWSERS}で開いてください。`,
      };
    case 'failed-to-load':
      return {
        title: '計算エンジンを読み込めませんでした',
        body:
          'ページを再読み込みしてください。直らない場合はブラウザが古い可能性があります。' +
          `${SUPPORTED_BROWSERS}で開いてください。`,
      };
  }
}
