// Straightening the page inside four corners onto a rectangle, as Android's Matrix.setPolyToPoly
// and a filtered drawBitmap do for the app (PageCropper.crop, PageLooks.straightened): a
// perspective map with bilinear sampling. On the graphics processor (WebGL 2) when the browser has
// it, which straightens a 12-megapixel photo's page in a few milliseconds; otherwise in typed
// arrays, a band of rows at a time so the page stays responsive.
import { makeCanvas, releaseCanvas, context2d, pixelsOf, yieldNow } from './image-canvas.js';
import { checkCancelled } from '../../core/errors.js';

/**
 * The perspective map, row by row (3 × 3), that takes the unit square's corners (0,0), (1,0),
 * (1,1), (0,1) to the four points `q` = [x0, y0, x1, y1, x2, y2, x3, y3] (Heckbert's
 * square-to-quad). Null when the points don't make a shape it can map onto.
 */
export function squareToQuad(q) {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = q;
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  if (den === 0 || !Number.isFinite(den)) return null;
  const g = (dx3 * dy2 - dx2 * dy3) / den;
  const h = (dx1 * dy3 - dx3 * dy1) / den;
  const m = [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
  return m.every(Number.isFinite) ? m : null;
}

/**
 * The page inside `corners` (8 numbers, pixels of `source`, in a page's corner order) straightened
 * onto a new canvas `width` × `height`. Where the page reaches past the source, it is white, or
 * see-through when `transparent`. `source` is an ImageBitmap or a canvas. Throws RangeError when
 * memory or the canvas runs out, and Error when the corners can't be straightened.
 * @returns {Promise<HTMLCanvasElement|OffscreenCanvas>}
 */
export async function straightenOnto(source, corners, width, height, { transparent = false, signal } = {}) {
  const m = squareToQuad(corners);
  if (!m) throw new Error("The corners can't be straightened");
  const viaGpu = gpuWarp(source, m, width, height, transparent);
  if (viaGpu) return viaGpu;
  return cpuWarp(source, m, width, height, transparent, signal);
}

// ---- On the graphics processor ----

const VERTEX = `#version 300 es
void main() {
  // One triangle covering the whole canvas.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D picture;
uniform mat3 toSource;
uniform vec2 outSize;
uniform vec2 sourceSize;
uniform vec4 background;
out vec4 colour;
void main() {
  // The output pixel's centre, as a fraction of the page from its top-left.
  vec2 uv = vec2(gl_FragCoord.x / outSize.x, 1.0 - gl_FragCoord.y / outSize.y);
  vec3 p = toSource * vec3(uv, 1.0);
  vec2 s = p.xy / p.z;
  if (p.z <= 0.0 || s.x < 0.0 || s.y < 0.0 || s.x > sourceSize.x || s.y > sourceSize.y) {
    colour = background;
    return;
  }
  // Premultiplied, so a see-through edge doesn't darken; then on the background.
  vec4 c = texture(picture, s / sourceSize);
  colour = c + background * (1.0 - c.a);
}`;

let gpu = null;
let noGpu = false;

/** The WebGL 2 context the pages are straightened with, made once; null without WebGL 2. */
function gpuContext() {
  if (noGpu) return null;
  if (gpu && !gpu.gl.isContextLost()) return gpu;
  gpu = null;
  try {
    const canvas = makeCanvas(1, 1);
    const gl = canvas.getContext('webgl2', {
      alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false, depth: false, stencil: false,
    });
    if (!gl) throw new Error('No WebGL 2');
    const shader = (type, source) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'Shader');
      return s;
    };
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'Program');
    const at = (name) => gl.getUniformLocation(program, name);
    gpu = {
      canvas, gl, program,
      toSource: at('toSource'), outSize: at('outSize'), sourceSize: at('sourceSize'), background: at('background'), picture: at('picture'),
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxViewport: gl.getParameter(gl.MAX_VIEWPORT_DIMS),
    };
    return gpu;
  } catch {
    // No WebGL 2 here (or it is switched off): typed arrays from now on.
    noGpu = true;
    return null;
  }
}

/**
 * The warp on the graphics processor, onto a new 2D canvas; null when it can't be done there (no
 * WebGL 2, a source larger than its largest texture), for the typed arrays to do it.
 */
function gpuWarp(source, m, width, height, transparent) {
  const g = gpuContext();
  if (!g) return null;
  if (source.width > g.maxTexture || source.height > g.maxTexture || width > g.maxViewport[0] || height > g.maxViewport[1]) return null;
  const { gl, canvas } = g;
  const texture = gl.createTexture();
  try {
    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
    gl.useProgram(g.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(g.picture, 0);
    // GLSL matrices are given column by column.
    gl.uniformMatrix3fv(g.toSource, false, [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
    gl.uniform2f(g.outSize, width, height);
    gl.uniform2f(g.sourceSize, source.width, source.height);
    if (transparent) gl.uniform4f(g.background, 0, 0, 0, 0);
    else gl.uniform4f(g.background, 1, 1, 1, 1);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (gl.getError() !== gl.NO_ERROR || gl.isContextLost()) return null;
    // Copied out, so the context is free for the next page.
    const out = makeCanvas(width, height);
    let ctx;
    try {
      ctx = context2d(out, { alpha: transparent });
    } catch (e) {
      releaseCanvas(out);
      throw new RangeError(e.message);
    }
    ctx.drawImage(canvas, 0, 0);
    return out;
  } finally {
    gl.deleteTexture(texture);
    // The drawing buffer goes back to almost nothing until the next page.
    canvas.width = 1;
    canvas.height = 1;
  }
}

// ---- In typed arrays ----

/** The warp in typed arrays, a band of rows at a time, onto a new 2D canvas. */
async function cpuWarp(source, m, width, height, transparent, signal) {
  let src;
  try {
    src = source.data ? source : pixelsOf(source);
  } catch (e) {
    throw new RangeError(e.message);
  }
  const sw = src.width;
  const sh = src.height;
  const s = src.data;
  const out = makeCanvas(width, height);
  let ctx;
  let image;
  try {
    ctx = context2d(out, { alpha: transparent });
    image = ctx.createImageData(width, height);
  } catch (e) {
    releaseCanvas(out);
    throw new RangeError(e.message);
  }
  const d = image.data;
  const bg = transparent ? 0 : 255;
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = m;
  const maxX = sw - 1;
  const maxY = sh - 1;
  const rowSize = sw * 4;
  let started = performance.now();
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    // Along a row only u changes: each of the three sums moves by a fixed step.
    let nx = m0 * (0.5 / width) + m1 * v + m2;
    let ny = m3 * (0.5 / width) + m4 * v + m5;
    let nz = m6 * (0.5 / width) + m7 * v + m8;
    const stepX = m0 / width;
    const stepY = m3 / width;
    const stepZ = m6 / width;
    let o = y * width * 4;
    for (let x = 0; x < width; x++, o += 4, nx += stepX, ny += stepY, nz += stepZ) {
      const px = nx / nz;
      const py = ny / nz;
      if (!(nz > 0 && px >= 0 && py >= 0 && px <= sw && py <= sh)) {
        d[o] = d[o + 1] = d[o + 2] = bg;
        d[o + 3] = bg;
        continue;
      }
      let fx = px - 0.5;
      let fy = py - 0.5;
      if (fx < 0) fx = 0; else if (fx > maxX) fx = maxX;
      if (fy < 0) fy = 0; else if (fy > maxY) fy = maxY;
      const x0 = fx | 0;
      const y0 = fy | 0;
      const tx = fx - x0;
      const ty = fy - y0;
      const i00 = y0 * rowSize + x0 * 4;
      const i01 = x0 < maxX ? i00 + 4 : i00;
      const i10 = y0 < maxY ? i00 + rowSize : i00;
      const i11 = x0 < maxX ? i10 + 4 : i10;
      const w00 = (1 - tx) * (1 - ty);
      const w01 = tx * (1 - ty);
      const w10 = (1 - tx) * ty;
      const w11 = tx * ty;
      const a00 = s[i00 + 3];
      const a01 = s[i01 + 3];
      const a10 = s[i10 + 3];
      const a11 = s[i11 + 3];
      // d is a clamped byte array: it rounds what it is given to the nearest level by itself.
      if ((a00 & a01 & a10 & a11) === 255) {
        d[o] = s[i00] * w00 + s[i01] * w01 + s[i10] * w10 + s[i11] * w11;
        d[o + 1] = s[i00 + 1] * w00 + s[i01 + 1] * w01 + s[i10 + 1] * w10 + s[i11 + 1] * w11;
        d[o + 2] = s[i00 + 2] * w00 + s[i01 + 2] * w01 + s[i10 + 2] * w10 + s[i11 + 2] * w11;
        d[o + 3] = 255;
        continue;
      }
      // See-through pixels mix weighted by their alpha, then sit on the background.
      const b00 = w00 * a00;
      const b01 = w01 * a01;
      const b10 = w10 * a10;
      const b11 = w11 * a11;
      const alpha = b00 + b01 + b10 + b11;
      const cover = alpha / 255;
      for (let c = 0; c < 3; c++) {
        const mixed = alpha > 0 ? (s[i00 + c] * b00 + s[i01 + c] * b01 + s[i10 + c] * b10 + s[i11 + c] * b11) / alpha : 0;
        d[o + c] = transparent ? mixed : mixed * cover + 255 * (1 - cover);
      }
      d[o + 3] = transparent ? alpha : 255;
    }
    if (performance.now() - started > 40) {
      await yieldNow();
      checkCancelled(signal);
      started = performance.now();
    }
  }
  ctx.putImageData(image, 0, 0);
  return out;
}

/** Whether pages are straightened on the graphics processor here (for the tests and diagnostics). */
export function warpsOnGpu() {
  return gpuContext() != null;
}

/** Straightens on the graphics processor (`true`, when there is WebGL 2) or always in typed arrays. */
export function setGpuWarp(enabled) {
  noGpu = !enabled;
  if (!enabled) gpu = null;
}
