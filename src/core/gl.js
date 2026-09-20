// Thin WebGL2 helpers. Nothing clever -- just enough to stop the simulation
// code from drowning in boilerplate.

export class GLError extends Error {}

export function createContext(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  if (!gl) {
    throw new GLError(
      'This browser has no WebGL2. The paint simulation needs it -- try a current Chrome, Edge, Firefox or Safari.'
    );
  }
  if (!gl.getExtension('EXT_color_buffer_float')) {
    throw new GLError(
      'This GPU cannot render to floating point textures (EXT_color_buffer_float), which the wet-paint simulation needs.'
    );
  }
  // Not fatal: without it, dab edges are a touch harder.
  gl.getExtension('OES_texture_float_linear');
  return gl;
}

export function compileShader(gl, type, source, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new GLError(`Shader "${label}" failed to compile:\n${log}\n${numberLines(source)}`);
  }
  return sh;
}

function numberLines(src) {
  return src
    .split('\n')
    .map((l, i) => `${String(i + 1).padStart(4)}| ${l}`)
    .join('\n');
}

/**
 * Builds a program from a fragment shader body. Every pass in this app is a
 * full-screen (or full-quad) draw, so they all share one vertex shader.
 */
export class Program {
  constructor(gl, fragSource, label, vertSource = DEFAULT_VERT) {
    this.gl = gl;
    this.label = label;
    const vs = compileShader(gl, gl.VERTEX_SHADER, vertSource, `${label}.vert`);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSource, `${label}.frag`);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, 'aCorner');
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new GLError(`Program "${label}" failed to link:\n${log}`);
    }
    this.program = p;
    this.uniforms = new Map();
  }

  loc(name) {
    if (!this.uniforms.has(name)) {
      this.uniforms.set(name, this.gl.getUniformLocation(this.program, name));
    }
    return this.uniforms.get(name);
  }

  use() {
    this.gl.useProgram(this.program);
    return this;
  }

  /** Sets uniforms from a plain object; arrays become vecN, numbers floats. */
  set(values) {
    const gl = this.gl;
    let unit = 0;
    for (const [name, value] of Object.entries(values)) {
      const l = this.loc(name);
      if (l === null) continue; // optimised out -- harmless
      if (value instanceof WebGLTexture) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, value);
        gl.uniform1i(l, unit);
        unit++;
      } else if (typeof value === 'number') {
        gl.uniform1f(l, value);
      } else if (typeof value === 'boolean') {
        gl.uniform1i(l, value ? 1 : 0);
      } else if (value.length === 2) {
        gl.uniform2fv(l, value);
      } else if (value.length === 3) {
        gl.uniform3fv(l, value);
      } else if (value.length === 4) {
        gl.uniform4fv(l, value);
      } else if (value.length === 9) {
        gl.uniformMatrix3fv(l, false, value);
      } else {
        throw new GLError(`Cannot set uniform "${name}" of length ${value.length}`);
      }
    }
    return this;
  }
}

export const DEFAULT_VERT = /* glsl */ `#version 300 es
// Draws a quad from gl_VertexID, so no vertex buffers anywhere in the app.
// uRect is (x, y, w, h) in 0..1 clip-space-normalised target coordinates;
// the default covers the whole target.
uniform vec4 uRect;
out vec2 vUV;
void main() {
  vec2 corner = vec2((gl_VertexID & 1), (gl_VertexID >> 1) & 1);
  vUV = uRect.xy + corner * uRect.zw;
  gl_Position = vec4(vUV * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** A float texture plus its framebuffer. */
export class RenderTarget {
  constructor(gl, width, height, { internalFormat = gl.RGBA16F, filter = gl.LINEAR, count = 1 } = {}) {
    this.gl = gl;
    this.width = width;
    this.height = height;
    this.textures = [];
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    const attachments = [];
    for (let i = 0; i < count; i++) {
      const tex = createTexture(gl, width, height, internalFormat, filter);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0 + i,
        gl.TEXTURE_2D,
        tex,
        0
      );
      this.textures.push(tex);
      attachments.push(gl.COLOR_ATTACHMENT0 + i);
    }
    gl.drawBuffers(attachments);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new GLError(`Framebuffer incomplete (0x${status.toString(16)}) at ${width}x${height}`);
    }
    this.attachments = attachments;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  get texture() {
    return this.textures[0];
  }

  bind() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.drawBuffers(this.attachments);
    gl.viewport(0, 0, this.width, this.height);
    // Screen drawing scissors to the stage; an offscreen pass must never
    // inherit that rectangle or it silently clips half the canvas away.
    gl.disable(gl.SCISSOR_TEST);
    return this;
  }

  dispose() {
    const gl = this.gl;
    gl.deleteFramebuffer(this.fbo);
    for (const t of this.textures) gl.deleteTexture(t);
    this.textures = [];
  }
}

export function createTexture(gl, width, height, internalFormat, filter) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/** Two matched targets you can flip between, for read-modify-write passes. */
export class PingPong {
  constructor(gl, width, height, options) {
    this.a = new RenderTarget(gl, width, height, options);
    this.b = new RenderTarget(gl, width, height, options);
    this.width = width;
    this.height = height;
  }

  get read() {
    return this.a;
  }

  get write() {
    return this.b;
  }

  swap() {
    const t = this.a;
    this.a = this.b;
    this.b = t;
  }

  dispose() {
    this.a.dispose();
    this.b.dispose();
  }
}

/** Issues the 4-vertex quad draw every pass in this app uses. */
export function drawQuad(gl) {
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

export const FULL_RECT = [0, 0, 1, 1];
