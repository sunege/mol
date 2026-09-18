/**
 * WebGL availability probe.
 *
 * The 3D view is the whole point of the app, so when a context cannot be
 * created the user needs to know *why* rather than staring at a blank panel.
 * The probe runs on its own throwaway canvas before the renderer is built, and
 * reports the driver strings the browser exposes.
 */

export interface WebGlProbe {
  ok: boolean;
  /** Which context type succeeded, if any. */
  context: 'webgl2' | 'webgl' | null;
  /** Driver strings, when the browser exposes them. */
  vendor: string | null;
  renderer: string | null;
  /** True when the browser knows the API but the GPU path is unavailable. */
  disabled: boolean;
}

export function probeWebGl(): WebGlProbe {
  const result: WebGlProbe = {
    ok: false,
    context: null,
    vendor: null,
    renderer: null,
    disabled: false,
  };

  if (typeof WebGLRenderingContext === 'undefined') {
    // The browser does not implement WebGL at all.
    return result;
  }

  const canvas = document.createElement('canvas');
  for (const type of ['webgl2', 'webgl'] as const) {
    let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
    try {
      gl = canvas.getContext(type) as WebGLRenderingContext | null;
    } catch {
      gl = null;
    }
    if (!gl) continue;

    result.ok = true;
    result.context = type;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    if (info) {
      result.vendor = gl.getParameter(info.UNMASKED_VENDOR_WEBGL) as string;
      result.renderer = gl.getParameter(info.UNMASKED_RENDERER_WEBGL) as string;
    } else {
      result.vendor = gl.getParameter(gl.VENDOR) as string;
      result.renderer = gl.getParameter(gl.RENDERER) as string;
    }
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return result;
  }

  // The constructor exists but no context could be made: the GPU path is off
  // (headless/sandboxed Chromium, hardware acceleration disabled, or a
  // blocklisted driver).
  result.disabled = true;
  return result;
}
