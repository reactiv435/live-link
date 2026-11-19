// Painted face expressions on the 3D heroes (Babylon PBR material plugin). Needs window.BABYLON.
//
// Each expression is a straight-on picture of the hero's face (a cell of one atlas per hero, built by
// tools/build_faces.py). The shader lays the picture on the head in HEAD SPACE: it follows the Head joint, and only
// lands on the front surface (a depth cell in the atlas says where that is), so hair in front of the face, the glasses
// and the back of the head are never painted. The model files are unchanged; the sculpted mouth (Ryo's grin relief,
// Melanie's open-mouth hollow) is smoothed at load time, in memory, so a closed mouth has nothing behind it.
// Drawn each frame: the base face (eyes, brows, resting mouth) + an optional MOUTH AREA from a second face (talking)
// + an optional blink laid over the eyes only. Where the art replaces the model's face, the normal map is flattened and
// the skin's roughness used, because the original features are also baked into those maps.
(function () {
  'use strict';
  const B = window.BABYLON;

  /** An expression's cell in atlas UV space: [u0, v0, du, dv]. */
  function cellRect(data, name) {
    const index = data.order.indexOf(name);
    if (index < 0) throw new Error(data.id + " has no '" + name + "' face");
    const col = index % data.cols, row = Math.floor(index / data.cols);
    return [col / data.cols, row / data.rows, 1 / data.cols, 1 / data.rows];
  }

  const GLSL = {
    definitions: `
#ifdef VTFACE
uniform vec4 vtfState; uniform vec4 vtfCellA; uniform vec4 vtfCellM; uniform vec4 vtfCellB; uniform vec4 vtfMouth; uniform vec4 vtfMix;
uniform vec4 vtfZoneA; uniform vec4 vtfZoneB;
uniform sampler2D vtfSampler;
uniform mat4 vtfFace; uniform vec4 vtfDepthCell; uniform vec4 vtfDepth;
float vtfZone(vec2 c, vec4 e) { return 1.0 - smoothstep(0.8, 1.0, length((c - e.xy) / e.zw)); }
float vtfEyes(vec2 c, vec4 e) { return 1.0 - smoothstep(0.9, 1.0, length((c - e.xy) / e.zw)); }
#endif
`,
    albedo: `vec4 albedoTexture=TEXRD(albedoSampler,vAlbedoUV+uvOffset);
float vtfW=0.0;
#ifdef VTFACE
if (vtfState.x > 0.5) {
  vec4 vtfP = vtfFace * vec4(vPositionW, 1.0);
  vec2 vtfL = vtfP.xy;
  vec2 vtfC = clamp(vtfL, 0.002, 0.998);
  float vtfRef = texture2D(vtfSampler, vtfDepthCell.xy + vtfC * vtfDepthCell.zw).a * vtfDepth.y + vtfDepth.x;
  float vtfIn = step(0.0, vtfL.x) * step(vtfL.x, 1.0) * step(0.0, vtfL.y) * step(vtfL.y, 1.0)
    * (1.0 - smoothstep(vtfDepth.z * 0.6, vtfDepth.z, abs(vtfP.z - vtfRef)));
  vec2 vtfCrop = vtfC * 1024.0;
  vec4 vtfA = texture2D(vtfSampler, vtfCellA.xy + vtfC * vtfCellA.zw);
  float vtfWa = vtfA.a;
  vec3 vtfRgb = mix(albedoTexture.rgb, vtfA.rgb, vtfWa);
  if (vtfMix.x > 0.001) {
    vec4 vtfM = texture2D(vtfSampler, vtfCellM.xy + vtfC * vtfCellM.zw);
    float vtfZ = vtfZone(vtfCrop, vtfMouth) * vtfMix.x;
    vtfRgb = mix(vtfRgb, mix(albedoTexture.rgb, vtfM.rgb, vtfM.a), vtfZ);
    vtfWa = mix(vtfWa, vtfM.a, vtfZ);
  }
  if (vtfState.z > 0.5) {
    vec4 vtfBl = texture2D(vtfSampler, vtfCellB.xy + vtfC * vtfCellB.zw);
    float vtfBw = vtfBl.a * max(vtfEyes(vtfCrop, vtfZoneA), vtfEyes(vtfCrop, vtfZoneB));
    vtfRgb = mix(vtfRgb, vtfBl.rgb, vtfBw);
    vtfWa = max(vtfWa, vtfBw);
  }
  float vtfOn = vtfIn * vtfState.y;
  vtfW = vtfWa * vtfOn;
  albedoTexture.rgb = mix(albedoTexture.rgb, vtfRgb, vtfOn);
  normalW = normalize(mix(normalW, geometricNormalW, vtfW));
}
#endif
`,
    reflectivity: `
#if defined(VTFACE) && defined(METALLICWORKFLOW)
surfaceMetallicOrReflectivityColorMap.g = mix(surfaceMetallicOrReflectivityColorMap.g, vtfState.w, vtfW);
surfaceMetallicOrReflectivityColorMap.b = mix(surfaceMetallicOrReflectivityColorMap.b, 0.0, vtfW);
#endif
vec4 baseReflectivity=surfaceMetallicOrReflectivityColorMap;`,
  };
  const UNIFORMS = ['vtfState', 'vtfCellA', 'vtfCellM', 'vtfCellB', 'vtfMouth', 'vtfMix', 'vtfZoneA', 'vtfZoneB',
    'vtfFace', 'vtfDepthCell', 'vtfDepth'];

  class VTFacePlugin extends B.MaterialPluginBase {
    constructor(material, data, texture) {
      super(material, 'VTFace', 220, { VTFACE: false }, true, false);
      this.data = data; this.texture = texture;
      // what to draw (set by FaceRig)
      this.on = true; this.weight = 1; this.blink = false; this.mouthMix = 0;
      this.cellA = cellRect(data, data.order[0]); this.cellM = this.cellA; this.mouthZone = [0, 0, 1, 1];
      this.cellB = cellRect(data, 'blink');
      this.faceMatrix = B.Matrix.Identity();
      this.registerForExtraEvents = true;
      this.doNotSerialize = true;
      this._enable(true);
    }
    getClassName() { return 'VTFacePlugin'; }
    isCompatible(shaderLanguage) { return shaderLanguage === 0; }   // GLSL (WebGL)
    isReadyForSubMesh() { return this.texture.isReady(); }
    prepareDefines(defines) {
      defines.VTFACE = !!this._material.albedoTexture;
    }
    getSamplers(samplers) { samplers.push('vtfSampler'); }
    getUniforms() { return { externalUniforms: UNIFORMS }; }
    hardBindForSubMesh(_ubo, _scene, _engine, subMesh) {
      const effect = subMesh.effect;
      if (!effect || !effect.getUniform('vtfState')) return;
      const d = this.data, a = this.cellA, m = this.cellM, b = this.cellB, z = this.mouthZone, za = d.blinkZones[0], zb = d.blinkZones[1] || za;
      effect.setFloat4('vtfState', this.on ? 1 : 0, this.weight, this.blink ? 1 : 0, d.skinRoughness);
      effect.setFloat4('vtfCellA', a[0], a[1], a[2], a[3]);
      effect.setFloat4('vtfCellM', m[0], m[1], m[2], m[3]);
      effect.setFloat4('vtfCellB', b[0], b[1], b[2], b[3]);
      effect.setFloat4('vtfMouth', z[0], z[1], z[2], z[3]);
      effect.setFloat4('vtfMix', this.mouthMix, 0, 0, 0);
      effect.setFloat4('vtfZoneA', za[0], za[1], za[2], za[3]);
      effect.setFloat4('vtfZoneB', zb[0], zb[1], zb[2], zb[3]);
      const c = this.depthCell || (this.depthCell = cellRect(d, 'depth'));
      effect.setMatrix('vtfFace', this.faceMatrix);
      effect.setFloat4('vtfDepthCell', c[0], c[1], c[2], c[3]);
      effect.setFloat4('vtfDepth', d.depthRange[0], d.depthRange[1] - d.depthRange[0], d.slab, 0);
      effect.setTexture('vtfSampler', this.texture);
    }
    getCustomCode(shaderType) {
      if (shaderType !== 'fragment') return null;
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: GLSL.definitions,
        '!vec4 albedoTexture=TEXRD\\(albedoSampler,vAlbedoUV\\+uvOffset\\);': GLSL.albedo,
        '!vec4 baseReflectivity=surfaceMetallicOrReflectivityColorMap;': GLSL.reflectivity,
      };
    }
  }

  function loadAtlas(data, scene, like) {
    return new Promise((resolve, reject) => {
      const texture = new B.Texture(data.url, scene, {
        noMipmap: false, invertY: like && like.invertY != null ? like.invertY : false,
        samplingMode: B.Texture.TRILINEAR_SAMPLINGMODE,
        useSRGBBuffer: !!(like && like._useSRGBBuffer === true),
        onLoad: () => resolve(texture),
        onError: message => reject(new Error('Face atlas failed: ' + (message || data.url))),
      });
      texture.wrapU = B.Texture.CLAMP_ADDRESSMODE; texture.wrapV = B.Texture.CLAMP_ADDRESSMODE;
      texture.anisotropicFilteringLevel = 4;
    });
  }

  /** The model's base colour with its own brows, eyes and mouth painted out (a separate picture; the model file is untouched). */
  function swapBase(material, url, scene, slot) {
    slot = slot || 'albedoTexture';
    const old = material[slot];
    if (!old) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const clean = new B.Texture(url, scene, {
        noMipmap: false, invertY: old.invertY, samplingMode: old.samplingMode, useSRGBBuffer: old._useSRGBBuffer === true,
        onLoad: () => {
          clean.wrapU = old.wrapU; clean.wrapV = old.wrapV; clean.coordinatesIndex = old.coordinatesIndex;
          clean.anisotropicFilteringLevel = old.anisotropicFilteringLevel; clean.hasAlpha = old.hasAlpha;
          clean.level = old.level; clean.gammaSpace = old.gammaSpace;
          material[slot] = clean;
          resolve(clean);
        },
        onError: message => reject(new Error('Clean base texture failed: ' + (message || url))),
      });
    });
  }

  /** The body material: the first with a base-colour texture that is not the player's accent band. */
  function bodyMaterialOf(meshes) {
    for (const mesh of meshes) {
      const m = mesh.material;
      if (m && m.name !== 'PlayerAccent' && m.albedoTexture) return m;
    }
    return null;
  }

  /** Smooth the sculpted mouth away (vertex positions and normals in memory; the file is untouched). */
  function flattenMouth(meshes, fix) {
    const mesh = meshes.find(m => m.getTotalVertices && m.getTotalVertices() === fix.vertexCount && m.material && m.material.name !== 'PlayerAccent');
    if (!mesh) return false;
    const pos = mesh.getVerticesData(B.VertexBuffer.PositionKind), nor = mesh.getVerticesData(B.VertexBuffer.NormalKind);
    if (!pos || pos.length !== fix.vertexCount * 3) return false;
    fix.index.forEach((vi, k) => {
      pos[vi * 3] = fix.position[k * 3]; pos[vi * 3 + 1] = fix.position[k * 3 + 1]; pos[vi * 3 + 2] = fix.position[k * 3 + 2];
      if (nor) { nor[vi * 3] = fix.normal[k * 3]; nor[vi * 3 + 1] = fix.normal[k * 3 + 1]; nor[vi * 3 + 2] = fix.normal[k * 3 + 2]; }
    });
    mesh.setVerticesData(B.VertexBuffer.PositionKind, pos, false);
    if (nor) mesh.setVerticesData(B.VertexBuffer.NormalKind, nor, false);
    return true;
  }

  /** One hero's face: load the atlas, add the plugin, then `show(base, mouth, blink)` every frame. */
  class FaceRig {
    static async create(scene, meshes, data, headNode) {
      const material = bodyMaterialOf(meshes);
      if (!material) throw new Error(data.id + ': no body material');
      if (data.mouthFlatten && !flattenMouth(meshes, data.mouthFlatten)) throw new Error(data.id + ': mouth flatten did not match the model');
      const texture = await loadAtlas(data, scene, material.albedoTexture);
      if (data.baseUrl) await swapBase(material, data.baseUrl, scene);
      if (data.normalUrl) await swapBase(material, data.normalUrl, scene, 'bumpTexture');
      if (data.ormUrl) await swapBase(material, data.ormUrl, scene, 'metallicTexture');
      const plugin = new VTFacePlugin(material, data, texture);
      const rig = new FaceRig(data, plugin, headNode);
      const own = meshes.filter(m => m.material === material);
      await Promise.all(own.map(m => material.forceCompilationAsync(m).catch(() => undefined)));
      return rig;
    }
    constructor(data, plugin, headNode) {
      this.data = data; this.plugin = plugin; this.headNode = headNode;
      this.base = null; this.mouth = null;
      const A = data.faceAxesInHead, c = data.centreHead, s = data.side;
      const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      // head-local point -> (picture u, picture v, depth along the face axis), as a Babylon (row-vector) matrix
      this.cropFromHead = B.Matrix.FromValues(
        A.x[0] / s, -A.y[0] / s, A.z[0], 0,
        A.x[1] / s, -A.y[1] / s, A.z[1], 0,
        A.x[2] / s, -A.y[2] / s, A.z[2], 0,
        0.5 - dot(c, A.x) / s, 0.5 + dot(c, A.y) / s, -dot(c, A.z), 1);
      this.inv = new B.Matrix();
    }
    /** base: a face name; mouth: a face whose mouth area is laid over it (or null); blink: eyes closed. */
    show(base, mouth, blink) {
      const p = this.plugin, d = this.data;
      if (base !== this.base) { p.cellA = cellRect(d, base); this.base = base; }
      if (mouth !== this.mouth) {
        if (mouth) { p.cellM = cellRect(d, mouth); p.mouthZone = d.mouthZones[mouth]; }
        this.mouth = mouth;
      }
      p.mouthMix = mouth ? 1 : 0;
      p.blink = !!blink;
    }
    /** The pictures follow the head: call after the skeleton moved, before rendering. */
    update() {
      this.headNode.computeWorldMatrix(true).invertToRef(this.inv);
      this.inv.multiplyToRef(this.cropFromHead, this.plugin.faceMatrix);
    }
  }

  window.VTFace = { cellRect, FaceRig, GLSL, loadAtlas, swapBase, bodyMaterialOf, flattenMouth };   // the last four: shared with js/face2.js
})();
