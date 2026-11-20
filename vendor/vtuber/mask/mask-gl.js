// V4 MASK: the small WebGL2 layer under the three looks. No engine: the mask is a handful of draw calls and a
// bloom chain, so it can sit in any page (its own canvas) and nothing here is loaded from outside.
//   const G = VTMaskGL.create(canvas);            // WebGL2, HDR (RGBA16F) scene target with 4x MSAA
//   G.program(vs, fs) -> { use(), u(name, ...values), a(name) }
//   G.beginScene(); ...draw...; G.endScene({ bloom, exposure, grain, vignette, time });
// The picture is built in linear light, bloomed (6-level down / up chain, only what is bright spreads), tone-mapped
// (a shoulder on the brightest channel: a crimson light keeps its hue, only the hottest cores go to warm white), graded,
// vignetted, and finished with fine grain that also hides banding in the dark gradients.
(function (root) {
  'use strict';
  const FS_TRI = `#version 300 es
  out vec2 vUv;
  void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); vUv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
  const DOWN = `#version 300 es
  precision highp float; in vec2 vUv; out vec4 o; uniform sampler2D uTex; uniform vec2 uTexel; uniform float uFirst;
  vec3 S(vec2 d) { return texture(uTex, vUv + d * uTexel).rgb; }
  float kw(vec3 c) { return 1.0 / (1.0 + max(c.r, max(c.g, c.b))); }
  void main() {
    vec3 a = S(vec2(-2, 2)), b = S(vec2(0, 2)), c = S(vec2(2, 2)), d = S(vec2(-2, 0)), e = S(vec2(0, 0)), f = S(vec2(2, 0)), g = S(vec2(-2, -2)), h = S(vec2(0, -2)), i = S(vec2(2, -2));
    vec3 j = S(vec2(-1, 1)), k = S(vec2(1, 1)), l = S(vec2(-1, -1)), m = S(vec2(1, -1));
    vec3 col;
    if (uFirst > 0.5) {                                 // first step: weigh down single hot pixels (no fireflies), keep only light above a soft knee
      vec3 g0 = (j + k + l + m) * 0.25, g1 = (a + b + d + e) * 0.25, g2 = (b + c + e + f) * 0.25, g3 = (d + e + g + h) * 0.25, g4 = (e + f + h + i) * 0.25;
      float w0 = kw(g0) * 0.5, w1 = kw(g1) * 0.125, w2 = kw(g2) * 0.125, w3 = kw(g3) * 0.125, w4 = kw(g4) * 0.125;
      col = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
      float br = max(col.r, max(col.g, col.b)), knee = smoothstep(0.6, 2.4, br);
      col *= mix(0.03, 1.0, knee);
    } else col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
    o = vec4(max(col, 0.0), 1.0);
  }`;
  const UP = `#version 300 es
  precision highp float; in vec2 vUv; out vec4 o; uniform sampler2D uTex; uniform vec2 uTexel; uniform float uRadius;
  void main() {
    vec2 d = uTexel * uRadius;
    vec3 c = texture(uTex, vUv).rgb * 4.0;
    c += (texture(uTex, vUv + vec2(d.x, 0)).rgb + texture(uTex, vUv - vec2(d.x, 0)).rgb + texture(uTex, vUv + vec2(0, d.y)).rgb + texture(uTex, vUv - vec2(0, d.y)).rgb) * 2.0;
    c += texture(uTex, vUv + d).rgb + texture(uTex, vUv - d).rgb + texture(uTex, vUv + vec2(d.x, -d.y)).rgb + texture(uTex, vUv + vec2(-d.x, d.y)).rgb;
    o = vec4(c / 16.0, 1.0);
  }`;
  const FINAL = `#version 300 es
  precision highp float; in vec2 vUv; out vec4 o;
  uniform sampler2D uScene, uBloom; uniform float uBloomK, uExposure, uGrain, uVignette, uTime; uniform vec2 uRes; uniform vec3 uLift; uniform float uCool;
  float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
  void main() {
    vec3 c = texture(uScene, vUv).rgb + texture(uBloom, vUv).rgb * uBloomK;
    vec2 q = vUv - 0.5; q.x *= uRes.x / uRes.y;
    c *= mix(1.0, smoothstep(1.15, 0.25, length(q) * 1.05), uVignette);
    // shoulder on the brightest channel, colour kept: a crimson light stays crimson however bright; only the very
    // hottest cores lean toward warm white
    float m = max(c.r, max(c.g, c.b)) + 1e-5, tm = 1.0 - exp(-m * uExposure);
    c = c / m * tm; c = mix(c, vec3(tm), smoothstep(3.0, 14.0, m) * 0.75);
    c = mix(c, c * c * (3.0 - 2.0 * c), 0.35);                       // a little more contrast in the middle
    c += uLift * (1.0 - c);                                          // warm lift of the blacks (0 by default)
    c = pow(max(c, 0.0), vec3(1.0 / 2.2));
    float n = hash(gl_FragCoord.xy + fract(uTime * 7.13) * 311.0) + hash(gl_FragCoord.yx * 1.37 + fract(uTime * 3.71) * 173.0) - 1.0;   // triangular
    float lum = dot(c, vec3(0.3, 0.6, 0.1));
    c += n * (uGrain * (0.45 + 0.55 * smoothstep(0.0, 0.25, lum)) + 0.5 / 255.0);
    // warm blacks only: whatever is left in the dark is never bluer than it is red
    // (only in the dark: a bright flash may be any colour, round 3)
    float dk = (1.0 - smoothstep(0.04, 0.14, max(c.g, c.b))) * (1.0 - uCool);      // (and not at all on the ice background, his exception)
    c.b = mix(c.b, min(c.b, max(c.g, c.r * 0.8)), dk); c.g = mix(c.g, min(c.g, c.r + 0.004), dk);
    o = vec4(c, 1.0);
  }`;

  function create(canvas, { msaa = 4 } = {}) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('mask: WebGL2 is not available');
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) throw new Error('mask: no float render targets');
    gl.getExtension('OES_texture_float_linear');
    const W = canvas.width, H = canvas.height;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const info = { renderer: dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '', w: W, h: H };

    function shader(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s), m = /ERROR: \d+:(\d+)/.exec(log || '');
        const line = m ? src.split('\n')[Number(m[1]) - 1] : '';
        throw new Error('mask shader: ' + log + (line ? ' >> ' + line.trim() : ''));
      }
      return s;
    }
    function program(vs, fs) {
      const p = gl.createProgram();
      gl.attachShader(p, shader(gl.VERTEX_SHADER, vs)); gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('mask program: ' + gl.getProgramInfoLog(p));
      const locs = new Map();
      const loc = (n) => { if (!locs.has(n)) locs.set(n, gl.getUniformLocation(p, n)); return locs.get(n); };
      return {
        p, use() { gl.useProgram(p); return this; },
        a: (n) => gl.getAttribLocation(p, n),
        /** u('name', number | [2..4] | Float32Array(9 | 16)), ui for ints / samplers, uv(name, size, Float32Array) for arrays */
        u(n, v) {
          const l = loc(n); if (l === null) return this;
          if (typeof v === 'number') gl.uniform1f(l, v);
          else if (v.length === 2) gl.uniform2fv(l, v); else if (v.length === 3) gl.uniform3fv(l, v); else if (v.length === 4) gl.uniform4fv(l, v);
          else if (v.length === 9) gl.uniformMatrix3fv(l, false, v); else if (v.length === 16) gl.uniformMatrix4fv(l, false, v);
          return this;
        },
        ui(n, v) { const l = loc(n); if (l !== null) gl.uniform1i(l, v); return this; },
        uv(n, size, arr) { const l = loc(n); if (l === null) return this; if (size === 1) gl.uniform1fv(l, arr); else if (size === 2) gl.uniform2fv(l, arr); else if (size === 3) gl.uniform3fv(l, arr); else gl.uniform4fv(l, arr); return this; },
      };
    }
    function target(w, h, filter) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter || gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter || gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fbo, w, h };
    }
    // the scene: multisampled HDR colour + depth, resolved into a texture
    const samples = Math.min(msaa, gl.getParameter(gl.MAX_SAMPLES));
    const msFbo = gl.createFramebuffer(), msColor = gl.createRenderbuffer(), msDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, msColor); gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA16F, W, H);
    gl.bindRenderbuffer(gl.RENDERBUFFER, msDepth); gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, msFbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, msColor);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, msDepth);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('mask: the HDR scene target is not supported here');
    const scene = target(W, H);
    const chain = [];
    for (let i = 0, w = W >> 1, h = H >> 1; i < 6 && w > 8 && h > 8; i++, w >>= 1, h >>= 1) chain.push(target(w, h));
    const pDown = program(FS_TRI, DOWN), pUp = program(FS_TRI, UP), pFinal = program(FS_TRI, FINAL);
    const triVao = gl.createVertexArray();
    const fsTri = () => { gl.bindVertexArray(triVao); gl.drawArrays(gl.TRIANGLES, 0, 3); };
    const bindTex = (unit, tex) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); };

    function beginScene() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, msFbo);
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 1); gl.clearDepth(1);
      gl.depthMask(true);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }
    function endScene({ bloom = 0.6, exposure = 1, grain = 1.6 / 255, vignette = 0.6, time = 0, radius = 1.0, lift = [0, 0, 0], cool = 0 } = {}) {
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.depthMask(false);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msFbo); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, scene.fbo);
      gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      pDown.use();
      for (let i = 0; i < chain.length; i++) {
        const src = i === 0 ? scene : chain[i - 1], dst = chain[i];
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo); gl.viewport(0, 0, dst.w, dst.h);
        bindTex(0, src.tex); pDown.ui('uTex', 0).u('uTexel', [1 / src.w, 1 / src.h]).u('uFirst', i === 0 ? 1 : 0);
        fsTri();
      }
      pUp.use(); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = chain.length - 1; i > 0; i--) {
        const src = chain[i], dst = chain[i - 1];
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo); gl.viewport(0, 0, dst.w, dst.h);
        bindTex(0, src.tex); pUp.ui('uTex', 0).u('uTexel', [1 / src.w, 1 / src.h]).u('uRadius', radius);
        fsTri();
      }
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H);
      pFinal.use(); bindTex(0, scene.tex); bindTex(1, chain[0].tex);
      pFinal.ui('uScene', 0).ui('uBloom', 1).u('uBloomK', bloom / chain.length * 2.0).u('uExposure', exposure).u('uGrain', grain).u('uVignette', vignette).u('uTime', time).u('uRes', [W, H]).u('uLift', lift).u('uCool', cool);
      fsTri();
    }
    /** a static or dynamic vertex buffer */
    function buffer(data, dynamic) { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW); return b; }
    function attrib(prog, name, buf, size, { type = gl.FLOAT, int = false, stride = 0, offset = 0 } = {}) {
      const l = prog.a(name); if (l < 0) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(l);
      if (int) gl.vertexAttribIPointer(l, size, type, stride, offset); else gl.vertexAttribPointer(l, size, type, false, stride, offset);
    }
    /** an RGBA32F data texture (read with texelFetch) */
    function dataTex(w, h) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return { tex, w, h, set(data) { gl.bindTexture(gl.TEXTURE_2D, tex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, data); } };
    }
    /** V8: back to the HDR scene target after drawing into a target of its own (mask-v8.js: the goo / fire field) */
    function bindScene() { gl.bindFramebuffer(gl.FRAMEBUFFER, msFbo); gl.viewport(0, 0, W, H); }
    return { gl, W, H, info, program, buffer, attrib, dataTex, beginScene, endScene, fsTri, bindTex, FS_TRI, target, bindScene };
  }

  // ---------------------------------------------------------------- small matrix helpers (column-major Float32Array(16))
  const M4 = {
    perspective(fovy, aspect, near, far) { const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far); return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]); },
    lookAt(e, c, up) {
      let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2]; let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
      let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx; l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
      const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
      return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0, -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1]);
    },
    mul(a, b) { const o = new Float32Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]; return o; },
    /** rotation R (row-major 3x3), uniform scale s, translation t */
    trs(R, s, t) { return new Float32Array([R[0] * s, R[3] * s, R[6] * s, 0, R[1] * s, R[4] * s, R[7] * s, 0, R[2] * s, R[5] * s, R[8] * s, 0, t[0], t[1], t[2], 1]); },
  };
  root.VTMaskGL = { create, M4 };
})(typeof globalThis !== 'undefined' ? globalThis : self);
