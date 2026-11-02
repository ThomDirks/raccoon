const SAMPLE_MODEL = (window.BOOTH_SAMPLES || {}).a || null;
const SAMPLE_NAME = "Local Player (1).json";

const ANGLES = [
  { deg: 0, name: "front" }, { deg: 45, name: "front-left" }, { deg: 90, name: "left" }, { deg: 135, name: "back-left" },
  { deg: 180, name: "back" }, { deg: 225, name: "back-right" }, { deg: 270, name: "right" }, { deg: 315, name: "front-right" },
];
// Light comes from the upper left, slightly in front of the camera (the game's own
// player light direction, re-expressed relative to the viewer).
const LIGHT_VIEW = new THREE.Vector3(-30, 50, 30).normalize();
const SUPERSAMPLE = 2;

const $ = (id) => document.getElementById(id);
var mode = "one", sceneReady = false;
const state = {
  yaw: 0, tilt: 0, ambient: 0.55, contrast: 0.7, height: 600, pad: 8,
  ticked: new Set(ANGLES.map((a) => a.deg)), modelName: SAMPLE_NAME, frame: 0,
};

/* ---------- colour ---------- */
// Creator's Kit stores each colour as [hue, lightness, saturation, alpha] in 0..1,
// built from the game's 6-bit hue / 7-bit lightness / 3-bit saturation, with hue
// running the opposite way round the wheel from standard HSL.
function hslToRgb(h, s, l, out, o) {
  if (s <= 0) { out[o] = out[o + 1] = out[o + 2] = l; return; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => {
    t -= Math.floor(t);
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  out[o] = f(h + 1 / 3); out[o + 1] = f(h); out[o + 2] = f(h - 1 / 3);
}

/* ---------- model ---------- */
let model = null; // { groups:[{mesh, faces:[], colorAttr}], verts:Float32Array, vnorm:Float32Array, ... }
const root = new THREE.Group();

function parseModel(data) {
  if (!data || !Array.isArray(data.vertices) || !Array.isArray(data.faces)) throw new Error("This file has no vertices or faces. Load a model .json exported from Creator's Kit.");
  const V = data.vertices, F = data.faces;
  if (!V.length || !F.length) throw new Error("This model is empty.");
  const nv = V.length, nf = F.length;
  for (let f = 0; f < nf; f++) {
    const t = F[f];
    if (!Array.isArray(t) || t.length < 3 || t[0] >= nv || t[1] >= nv || t[2] >= nv) throw new Error("A face points at a vertex that doesn't exist. The file may be cut off.");
  }
  const pos = toPositions(V);

  // Animation: Creator's Kit can store whole-model snapshots with the client tick
  // (20 ms) each one happens on. Without them the model has a single frame.
  let frames = [pos], ticks = null;
  const AV = data.animVertices;
  if (Array.isArray(AV) && AV.length) {
    if (!AV.every((fr) => Array.isArray(fr) && fr.length === nv)) throw new Error("The animation frames in this file don't match the model's vertex count, so they can't be played.");
    frames = AV.map(toPositions);
    const ct = data.clientTicks;
    if (Array.isArray(ct) && ct.length === AV.length && ct.every(Number.isFinite)) ticks = ct.slice();
  }

  const useVC = !!data.useVertexColours && Array.isArray(data.vertexColours) && data.vertexColours.length;
  const palette = useVC ? data.vertexColours : (data.faceColours || []);
  const fci = data.faceColourIndex || [];
  const vci = data.vertexColourIndex || [];
  const prio = data.priorities || [];

  // group faces by draw priority and transparency
  const buckets = new Map();
  for (let f = 0; f < nf; f++) {
    const cols = useVC ? [vci[f * 3], vci[f * 3 + 1], vci[f * 3 + 2]] : [fci[f], fci[f], fci[f]];
    const alpha = Math.min(...cols.map((ci) => (palette[ci] ? palette[ci][3] ?? 1 : 1)));
    if (alpha <= 0.01) continue;
    const p = prio[f] || 0, transparent = alpha < 0.99;
    const key = (transparent ? "t" : "o") + p;
    if (!buckets.has(key)) buckets.set(key, { p, transparent, faces: [], cols: [] });
    const bk = buckets.get(key); bk.faces.push(f); bk.cols.push(cols);
  }

  const groups = [];
  for (const bk of buckets.values()) {
    const m = bk.faces.length;
    const gp = new Float32Array(m * 9), gc = new Float32Array(m * 12);
    const geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(gp, 3);
    geo.setAttribute("position", posAttr);
    const colorAttr = new THREE.BufferAttribute(gc, 4);
    geo.setAttribute("color", colorAttr);
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.DoubleSide, transparent: bk.transparent, depthWrite: !bk.transparent,
      polygonOffset: bk.p > 0, polygonOffsetFactor: -bk.p * 0.1, polygonOffsetUnits: -bk.p * 4,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false; // the camera is always framed to the model
    mesh.renderOrder = (bk.transparent ? 1000 : 0) + bk.p;
    groups.push({ mesh, faces: bk.faces, cols: bk.cols, colorAttr, posAttr });
  }
  return { F, nv, nf, frames, ticks, normals: [], palette, groups, cur: -1 };
}

// game axes (y down) to a right-handed y-up frame
function toPositions(V) {
  const p = new Float32Array(V.length * 3);
  for (let i = 0; i < V.length; i++) { p[i * 3] = V[i][0]; p[i * 3 + 1] = -V[i][1]; p[i * 3 + 2] = -V[i][2]; }
  return p;
}

// smooth vertex normals for one frame, worked out on first use
function normalsFor(i, m = model) {
  if (m.normals[i]) return m.normals[i];
  const pos = m.frames[i], F = m.F, nv = m.nv;
  const vn = new Float32Array(nv * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let f = 0; f < F.length; f++) {
    const [i0, i1, i2] = F[f];
    a.fromArray(pos, i0 * 3); b.fromArray(pos, i1 * 3); c.fromArray(pos, i2 * 3);
    n.subVectors(b, a).cross(c.sub(a)).normalize();
    vn[i0 * 3] += n.x; vn[i0 * 3 + 1] += n.y; vn[i0 * 3 + 2] += n.z;
    vn[i1 * 3] += n.x; vn[i1 * 3 + 1] += n.y; vn[i1 * 3 + 2] += n.z;
    vn[i2 * 3] += n.x; vn[i2 * 3 + 1] += n.y; vn[i2 * 3 + 2] += n.z;
  }
  for (let v = 0; v < nv; v++) {
    n.fromArray(vn, v * 3); const L = n.length() || 1;
    vn[v * 3] /= L; vn[v * 3 + 1] /= L; vn[v * 3 + 2] /= L;
  }
  return (m.normals[i] = vn);
}

// move the mesh to one frame of the animation
function applyFrame(i, m = model) {
  if (m.cur === i) return;
  const pos = m.frames[i], F = m.F;
  for (const g of m.groups) {
    const arr = g.posAttr.array;
    for (let k = 0; k < g.faces.length; k++) {
      const t = F[g.faces[k]];
      for (let j = 0; j < 3; j++) { const s = t[j] * 3, o = k * 9 + j * 3; arr[o] = pos[s]; arr[o + 1] = pos[s + 1]; arr[o + 2] = pos[s + 2]; }
    }
    g.posAttr.needsUpdate = true;
    g.mesh.geometry.computeBoundingSphere();
  }
  m.cur = i;
}

function setModel(m, name) {
  if (model) model.groups.forEach((g) => { root.remove(g.mesh); g.mesh.geometry.dispose(); g.mesh.material.dispose(); });
  model = m; state.modelName = name;
  model.groups.forEach((g) => root.add(g.mesh));
  $("fileStatus").innerHTML = "";
  const b = document.createElement("b"); b.textContent = name;
  $("fileStatus").append("Loaded: ", b, name === SAMPLE_NAME ? " (example)" : "");
  baseHeight = null;
  stageFrame = null;
  stopPlayback(); state.frame = 0; setupTimeline();
  requestDraw(); scheduleSheet();
}

/* ---------- timeline ---------- */
const frameCount = () => (model ? model.frames.length : 1);
const TICK_MS = 20;
// how long a frame stays on screen: from the gap to the next keyframe's client tick,
// or a steady 120 ms when frames came from separate files
function frameMs(i) { return frameMsOf(model, i); }
function frameMsOf(m, i) {
  const tk = m && m.ticks;
  if (tk && tk.length > 1) {
    const next = i + 1 < tk.length ? tk[i + 1] : null;
    const gap = next !== null ? next - tk[i] : tk[i] - tk[i - 1];
    if (gap > 0) return gap * TICK_MS;
  }
  return 120;
}
// when each frame starts, in ms, and how long the whole animation runs
function timing(m) {
  if (m.timing && m.timing.n === m.frames.length) return m.timing;
  const starts = [0];
  for (let i = 0; i < m.frames.length; i++) starts.push(starts[i] + frameMsOf(m, i));
  return (m.timing = { starts, total: starts[m.frames.length], n: m.frames.length });
}
function frameAtTime(m, t) {
  const T = timing(m), n = m.frames.length;
  if (n < 2 || !T.total) return 0;
  const local = ((t % T.total) + T.total) % T.total;
  let lo = 0, hi = n - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (T.starts[mid] <= local) lo = mid; else hi = mid - 1; }
  return lo;
}
// moments to sample for an image sequence at a steady frame rate (Premiere wants even spacing)
function seqTimes(total, fps, speed) {
  const step = (1000 / fps) * speed, out = [];
  for (let t = 0; t < total - 1e-6; t += step) out.push(t);
  return out;
}
function frameLabel(i) {
  const n = frameCount(), tk = model && model.ticks;
  return `frame ${i + 1} / ${n}` + (tk ? ` · tick ${tk[i] - tk[0]}` : "");
}
function setupTimeline() {
  const n = frameCount(), animated = n > 1;
  $("frame").max = String(n - 1); $("frame").value = "0";
  $("frame").disabled = !animated; $("play").disabled = !animated; $("speed").disabled = !animated;
  $("frameOut").textContent = frameLabel(0);
  $("saveFrames").hidden = !animated; $("fpsField").hidden = !animated;
  $("animMsg").hidden = animated;
  $("gifMotion").querySelector('[value="anim"]').disabled = !animated;
  $("gifMotion").value = animated ? "anim" : "spin";
  if (typeof syncGifNotes === "function") syncGifNotes();
  if (typeof updateButtons === "function") updateButtons();
  const marks = $("tickMarks"); marks.innerHTML = "";
  if (animated && n <= 120) {
    for (let i = 0; i < n; i++) { const m = document.createElement("i"); m.style.left = `${(i / (n - 1)) * 100}%`; marks.append(m); }
  }
}
function setFrame(i, fromPlayback) {
  const n = frameCount();
  state.frame = ((i % n) + n) % n;
  $("frame").value = String(state.frame);
  $("frameOut").textContent = frameLabel(state.frame);
  requestDraw();
  if (!fromPlayback) scheduleSheet();
}
let playing = false, playLast = 0, playAcc = 0;
function playStep(now) {
  if (!playing) return;
  const speed = Number($("speed").value) || 1;
  playAcc += (now - playLast) * speed; playLast = now;
  let advanced = false;
  while (playAcc >= frameMs(state.frame)) { playAcc -= frameMs(state.frame); state.frame = (state.frame + 1) % frameCount(); advanced = true; }
  if (advanced) setFrame(state.frame, true);
  requestAnimationFrame(playStep);
}
function startPlayback() {
  if (frameCount() < 2) return;
  playing = true; playAcc = 0; playLast = performance.now();
  $("play").textContent = "Pause"; requestAnimationFrame(playStep);
}
function stopPlayback() {
  const was = playing; playing = false; $("play").textContent = "Play";
  if (was) scheduleSheet(); // refresh the contact sheet on the frame you stopped at
}

/* ---------- pose + lighting ---------- */
const rot = new THREE.Matrix4(), inv = new THREE.Matrix4();
function poseMatrix(yawDeg, tiltDeg) {
  const ry = new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(yawDeg));
  const rx = new THREE.Matrix4().makeRotationX(THREE.MathUtils.degToRad(tiltDeg));
  return rx.multiply(ry); // turn first, then tip toward the camera
}

// colour every vertex of one model for one frame, lit from a fixed direction on screen
function shadeModel(m, matrix, frame, amb, con) {
  applyFrame(frame, m);
  const L = LIGHT_VIEW.clone().transformDirection(inv.copy(matrix).invert()); // light direction in model space
  const vn = normalsFor(frame, m), { palette, F } = m;
  const lx = L.x, ly = L.y, lz = L.z;
  for (const g of m.groups) {
    const arr = g.colorAttr.array;
    for (let k = 0; k < g.faces.length; k++) {
      const tri = F[g.faces[k]], cols = g.cols[k];
      for (let j = 0; j < 3; j++) {
        const vi = tri[j], c = palette[cols[j]] || [0, 0.5, 0, 1];
        const d = vn[vi * 3] * lx + vn[vi * 3 + 1] * ly + vn[vi * 3 + 2] * lz;
        // the game scales a colour's lightness by (ambient + contrast * cos); shading 0 gives flat colour
        const intensity = (amb / 0.55) * (0.5 * con + 0.95 * (1 - con)) + con * 0.66 * d;
        const l = Math.min(0.99, Math.max(0.01, c[1] * intensity));
        const o = k * 12 + j * 4;
        hslToRgb(1 - c[0], c[2], l, arr, o);
        arr[o + 3] = c[3] ?? 1;
      }
    }
    g.colorAttr.needsUpdate = true;
  }
}
function relight(yawDeg, tiltDeg, frame = state.frame) {
  rot.copy(poseMatrix(yawDeg, tiltDeg));
  shadeModel(model, rot, frame, state.ambient, state.contrast);
  root.matrixAutoUpdate = false; root.matrix.copy(rot); root.matrixWorldNeedsUpdate = true;
}

// bounding box of the posed model in view space
function posedBox(yawDeg, tiltDeg, frame = state.frame) { return boxOf(model, poseMatrix(yawDeg, tiltDeg), frame); }
function mergeBox(b, p) {
  if (!p) return b; if (!b) return p;
  return { x0: Math.min(b.x0, p.x0), x1: Math.max(b.x1, p.x1), y0: Math.min(b.y0, p.y0), y1: Math.max(b.y1, p.y1), z0: Math.min(b.z0, p.z0), z1: Math.max(b.z1, p.z1) };
}
// bounding box of one model, placed by a full matrix (turn, tilt and position)
function boxOf(m, matrix, frame) {
  const e = matrix.elements, p = m.frames[frame];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < m.nv; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    const X = e[0] * x + e[4] * y + e[8] * z + e[12], Y = e[1] * x + e[5] * y + e[9] * z + e[13], Z = e[2] * x + e[6] * y + e[10] * z + e[14];
    if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y; if (Z < z0) z0 = Z; if (Z > z1) z1 = Z;
  }
  return { x0, x1, y0, y1, z0, z1 };
}

/* ---------- rendering ---------- */
const scene = new THREE.Scene(); scene.add(root);
const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
function frameCamera(box, marginUnits, aspect) {
  let w = box.x1 - box.x0 + marginUnits * 2, h = box.y1 - box.y0 + marginUnits * 2;
  const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
  if (aspect) { if (w / h > aspect) h = w / aspect; else w = h * aspect; }
  cam.left = cx - w / 2; cam.right = cx + w / 2; cam.top = cy + h / 2; cam.bottom = cy - h / 2;
  // the camera keeps its default orientation, looking down -z at the model
  cam.position.set(0, 0, box.z1 + 10); cam.near = 1; cam.far = box.z1 - box.z0 + 20;
  cam.updateProjectionMatrix();
}

const stageEl = $("stage"), stageCanvas = $("stageCanvas");
let stageRenderer, offRenderer;
try {
  stageRenderer = new THREE.WebGLRenderer({ canvas: stageCanvas, antialias: true, alpha: true });
  stageRenderer.setClearColor(0x000000, 0);
  offRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  offRenderer.setClearColor(0x000000, 0); offRenderer.setPixelRatio(1);
} catch (err) {
  $("loadMsg").textContent = "This browser couldn't start 3D rendering (WebGL is off or unavailable).";
  $("loadMsg").classList.add("err");
}

let stageFrame = null; // fixed framing across all turns, so the model doesn't jump
function stageBox() {
  if (stageFrame && stageFrame.tilt === state.tilt) return stageFrame.box;
  let box = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity };
  const nf = model.frames.length, step = Math.max(1, Math.ceil(nf / 24)); // sample long animations
  for (let fr = 0; fr < nf; fr += step) for (let d = 0; d < 360; d += 15) {
    const b = posedBox(d, state.tilt, fr);
    box = { x0: Math.min(box.x0, b.x0), x1: Math.max(box.x1, b.x1), y0: Math.min(box.y0, b.y0), y1: Math.max(box.y1, b.y1), z0: Math.min(box.z0, b.z0), z1: Math.max(box.z1, b.z1) };
  }
  stageFrame = { tilt: state.tilt, box };
  return box;
}

let drawQueued = false;
function requestDraw() { if (!drawQueued) { drawQueued = true; requestAnimationFrame(drawStage); } }
function drawStage() {
  drawQueued = false;
  if (!model || !stageRenderer || mode !== "one") return;
  const r = stageEl.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
  stageRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  stageRenderer.setSize(w, h, false);
  relight(state.yaw, state.tilt);
  const box = stageBox();
  frameCamera(box, (box.y1 - box.y0) * 0.06, w / h);
  stageRenderer.render(scene, cam);
  $("readout").textContent = `${state.yaw}° · tilt ${state.tilt}°`;
}
new ResizeObserver(requestDraw).observe(stageEl);

// pixels per model unit, fixed from the front view so every angle shares a scale
let baseHeight = null;
function unitScale(targetPx) {
  if (baseHeight === null) { const b = posedBox(0, 0, 0); baseHeight = b.y1 - b.y0; }
  return targetPx / baseHeight;
}

// Render one angle to a trimmed, transparent canvas.
function renderAngle(yawDeg, targetPx, padPx, frame = state.frame, fixedBox = null) {
  const scale = unitScale(targetPx);
  const box = fixedBox || posedBox(yawDeg, state.tilt, frame);
  const w = Math.max(1, Math.ceil((box.x1 - box.x0) * scale + padPx * 2));
  const h = Math.max(1, Math.ceil((box.y1 - box.y0) * scale + padPx * 2));
  const ss = Math.min(SUPERSAMPLE, Math.floor(4096 / Math.max(w, h)) || 1);
  offRenderer.setSize(w * ss, h * ss, false);
  relight(yawDeg, state.tilt, frame);
  frameCamera(box, padPx / scale, w / h);
  offRenderer.render(scene, cam);
  const out = document.createElement("canvas"); out.width = w; out.height = h;
  const ctx = out.getContext("2d"); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  ctx.drawImage(offRenderer.domElement, 0, 0, w, h);
  relight(state.yaw, state.tilt); // restore the stage pose
  return out;
}
// one box around the model across several frames and turns, so a sequence never jumps
function unionBox(yaws, frames) {
  let b = null;
  for (const fr of frames) for (const y of yaws) {
    const p = posedBox(y, state.tilt, fr);
    b = b ? { x0: Math.min(b.x0, p.x0), x1: Math.max(b.x1, p.x1), y0: Math.min(b.y0, p.y0), y1: Math.max(b.y1, p.y1), z0: Math.min(b.z0, p.z0), z1: Math.max(b.z1, p.z1) } : p;
  }
  return b;
}
const allFrames = () => [...Array(frameCount()).keys()];
const toBlob = (canvas) => new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("png"))), "image/png"));

/* ---------- contact sheet ---------- */
const frameEls = new Map();
function buildFrames() {
  const host = $("frames"); host.innerHTML = "";
  for (const a of ANGLES) {
    const fig = document.createElement("div"); fig.className = "frame";
    const pic = document.createElement("button"); pic.type = "button"; pic.className = "frame-pic";
    pic.setAttribute("aria-label", `Turn to ${a.deg}° (${a.name})`);
    const img = document.createElement("img"); img.alt = `${a.name}, ${a.deg}°`; pic.append(img);
    pic.addEventListener("click", () => setYaw(a.deg));
    const meta = document.createElement("label"); meta.className = "frame-meta";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.id = `tick-${a.deg}`; cb.checked = state.ticked.has(a.deg);
    cb.addEventListener("change", () => { cb.checked ? state.ticked.add(a.deg) : state.ticked.delete(a.deg); updateButtons(); });
    const t = document.createElement("b"); t.textContent = `${a.deg}°`; t.style.fontWeight = "500";
    const s = document.createElement("span"); s.textContent = a.name;
    meta.append(cb, t, s);
    fig.append(pic, meta); host.append(fig);
    frameEls.set(a.deg, { pic, img });
  }
}
let sheetTimer = null, sheetUrls = [];
function scheduleSheet() { clearTimeout(sheetTimer); sheetTimer = setTimeout(drawSheet, 120); }
async function drawSheet() {
  if (!model || !offRenderer) return;
  sheetUrls.forEach((u) => URL.revokeObjectURL(u)); sheetUrls = [];
  const thumbPx = saveMode === "fallback" ? state.height : 220;
  for (const a of ANGLES) {
    const c = renderAngle(a.deg, thumbPx, saveMode === "fallback" ? state.pad : 4);
    const url = URL.createObjectURL(await toBlob(c)); sheetUrls.push(url);
    frameEls.get(a.deg).img.src = url;
  }
  markCurrent();
}
function markCurrent() { for (const [deg, el] of frameEls) el.pic.classList.toggle("current", deg === state.yaw); }

/* ---------- controls ---------- */
function setYaw(d) { state.yaw = ((Math.round(d) % 360) + 360) % 360; $("yaw").value = state.yaw; $("yawOut").textContent = `${state.yaw}°`; syncPresets(); markCurrent(); updateButtons(); requestDraw(); }
function syncPresets() { document.querySelectorAll("#yawPresets .chip").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.deg) === state.yaw))); }
for (const a of ANGLES) {
  const b = document.createElement("button"); b.type = "button"; b.className = "chip"; b.dataset.deg = a.deg; b.textContent = `${a.deg}°`;
  b.title = a.name; b.addEventListener("click", () => setYaw(a.deg)); $("yawPresets").append(b);
}
$("yaw").addEventListener("input", (e) => setYaw(Number(e.target.value)));
$("tilt").addEventListener("input", (e) => { state.tilt = Number(e.target.value); $("tiltOut").textContent = `${state.tilt}°`; requestDraw(); scheduleSheet(); });
$("ambient").addEventListener("input", (e) => { state.ambient = Number(e.target.value) / 100; $("ambientOut").textContent = e.target.value; requestDraw(); scheduleSheet(); });
$("contrast").addEventListener("input", (e) => { state.contrast = Number(e.target.value) / 100; $("contrastOut").textContent = e.target.value; requestDraw(); scheduleSheet(); });
$("size").addEventListener("change", (e) => { state.height = Number(e.target.value); if (saveMode === "fallback") scheduleSheet(); });
$("pad").addEventListener("input", (e) => { state.pad = Number(e.target.value); $("padOut").textContent = `${state.pad} px`; if (saveMode === "fallback") scheduleSheet(); });

// drag to turn / tilt
let drag = null;
stageEl.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, yaw: state.yaw, tilt: state.tilt }; stageEl.setPointerCapture(e.pointerId); stageEl.classList.add("dragging"); });
stageEl.addEventListener("pointermove", (e) => {
  if (!drag) return;
  setYaw(drag.yaw + (e.clientX - drag.x) * 0.5);
  const t = Math.max(-20, Math.min(60, Math.round(drag.tilt + (e.clientY - drag.y) * 0.25)));
  if (t !== state.tilt) { state.tilt = t; $("tilt").value = t; $("tiltOut").textContent = `${t}°`; }
});
const endDrag = () => { if (drag) { const tiltChanged = drag.tilt !== state.tilt; drag = null; stageEl.classList.remove("dragging"); if (tiltChanged) scheduleSheet(); } };
stageEl.addEventListener("pointerup", endDrag); stageEl.addEventListener("pointercancel", endDrag);

// loading files
const readText = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error(`Couldn't read ${file.name}.`)); r.readAsText(file); });
function parseJson(text, name) {
  try { return JSON.parse(text); } catch { throw new Error(`${name} isn't valid JSON. Export it again from Creator's Kit and load the new file.`); }
}
// One file: a model, possibly with its own animation frames.
// Several files: single-pose exports of the same model, played in file-name order.
async function modelFromFiles(list) {
  const files = Array.from(list || []).filter((f) => /\.json$/i.test(f.name) || f.type === "application/json");
  if (!files.length) throw new Error("Those weren't .json files. Load the files Creator's Kit exports.");
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  {
    const datas = [];
    for (const f of files) datas.push(parseJson(await readText(f), f.name));
    const first = parseModel(datas[0]);
    let name = files[0].name, note;
    if (files.length > 1) {
      const frames = [];
      datas.forEach((d, k) => {
        if (!Array.isArray(d.vertices) || d.vertices.length !== first.nv || !Array.isArray(d.faces) || d.faces.length !== first.nf) {
          throw new Error(`${files[k].name} has a different vertex or face count from ${files[0].name}, so it isn't the same model. Export every frame from the same object.`);
        }
        frames.push(toPositions(d.vertices));
      });
      first.frames = frames; first.ticks = null; first.normals = [];
      name = files[0].name.replace(/[_\- ]*\d+(\.json)$/i, "$1");
      note = `${files.length} files loaded as frames, in this order: ${files.map((f) => f.name).join(", ")}.`;
    } else {
      note = `${first.nv} vertices, ${first.nf} faces` + (first.frames.length > 1 ? `, ${first.frames.length} animation frames.` : ". No animation frames in this file.");
    }
    return { model: first, name, note };
  }
}
async function loadFiles(list) {
  const msg = $("loadMsg");
  try {
    const r = await modelFromFiles(list);
    setModel(r.model, r.name);
    msg.classList.remove("err"); msg.textContent = r.note;
  } catch (err) { msg.classList.add("err"); msg.textContent = err.message; }
}
$("fileInput").addEventListener("change", (e) => { loadFiles(e.target.files); e.target.value = ""; });
$("play").addEventListener("click", () => (playing ? stopPlayback() : startPlayback()));
$("frame").addEventListener("input", (e) => { stopPlayback(); setFrame(Number(e.target.value)); });
document.addEventListener("keydown", (e) => {
  if (mode !== "one" || frameCount() < 2 || e.target.closest("input, select, textarea, button")) return;
  if (e.key === ",") { stopPlayback(); setFrame(state.frame - 1); }
  else if (e.key === ".") { stopPlayback(); setFrame(state.frame + 1); }
});
let dragDepth = 0;
stageEl.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; $("dropVeil").hidden = false; });
stageEl.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("dropVeil").hidden = true; } });
stageEl.addEventListener("dragover", (e) => e.preventDefault());
stageEl.addEventListener("drop", (e) => { e.preventDefault(); dragDepth = 0; $("dropVeil").hidden = true; const f = e.dataTransfer.files; if (backdropFromFiles(f) && !hasJson(f)) return; loadFiles(f); });

/* ---------- saving ---------- */
let downloads = null, saveMode = "pending";
const baseName = () => state.modelName.replace(/\.json$/i, "").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") || "model";
const angleName = (deg) => { const a = ANGLES.find((x) => x.deg === deg); return a ? `${a.name}_${deg}` : `${deg}deg`; };
const pad3 = (n) => String(n).padStart(3, "0");
const frameTag = (i = state.frame) => (frameCount() > 1 ? `_f${pad3(i + 1)}` : "");
function setSaveMsg(text, err) { const m = $("saveMsg"); m.textContent = text; m.classList.toggle("err", !!err); }
function updateButtons() {
  $("saveAll").textContent = `Save ${state.ticked.size} ticked angle${state.ticked.size === 1 ? "" : "s"} (.zip)`;
  $("saveAll").disabled = saveMode !== "ready" || state.ticked.size === 0;
  $("saveOne").disabled = saveMode !== "ready";
  $("saveFrames").textContent = `Save the animation at ${state.yaw}° as PNGs (.zip)`;
  $("saveFrames").disabled = saveMode !== "ready";
  updateSceneButtons();
}
function saveDirect(filename, blob, say = setSaveMsg) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  say(`Saved ${filename}.`);
}
async function offer(filename, data, say = setSaveMsg) {
  if (!downloads) { saveDirect(filename, data, say); return; }
  try { await downloads.save({ filename, data }); say(`Saved ${filename}.`); }
  catch (err) {
    const code = err && err.code;
    if (code === "declined") say("Save cancelled.");
    else if (code === "rate_limited") say("A save prompt is already open. Finish that one first.");
    else if (say === setSaveMsg) { setSaveMsg("Saving isn't available here. Right-click a frame in the contact sheet to save it instead.", true); enterFallback(); }
    else say("Saving isn't available in this view.", true);
  }
}
$("saveOne").addEventListener("click", async () => {
  if (!model) return;
  const blob = await toBlob(renderAngle(state.yaw, state.height, state.pad));
  offer(`${baseName()}_${angleName(state.yaw)}${frameTag()}.png`, blob);
});
$("saveAll").addEventListener("click", async () => {
  if (!model || !state.ticked.size) return;
  setSaveMsg("Rendering…");
  const zip = new JSZip();
  for (const a of ANGLES) {
    if (!state.ticked.has(a.deg)) continue;
    zip.file(`${baseName()}_${a.name}_${a.deg}${frameTag()}.png`, await toBlob(renderAngle(a.deg, state.height, state.pad)));
  }
  offer(`${baseName()}${frameTag()}_angles.zip`, await zip.generateAsync({ type: "blob" }));
});
$("saveFrames").addEventListener("click", async () => {
  if (!model || frameCount() < 2) return;
  stopPlayback(); setSaveMsg("Rendering frames…");
  // sampled at a steady frame rate, so an image-sequence import plays at the right speed
  const fps = Number($("seqFps").value) || 30, speed = Number($("speed").value) || 1;
  const frames = seqTimes(timing(model).total, fps, speed).map((tm) => frameAtTime(model, tm));
  const zip = new JSZip(), box = unionBox([state.yaw], [...new Set(frames)]); // same canvas size for every frame
  const cache = new Map(), digits = Math.max(3, String(frames.length).length);
  for (let i = 0; i < frames.length; i++) {
    if (!cache.has(frames[i])) cache.set(frames[i], await toBlob(renderAngle(state.yaw, state.height, state.pad, frames[i], box)));
    zip.file(`${baseName()}_${angleName(state.yaw)}_${String(i + 1).padStart(digits, "0")}.png`, cache.get(frames[i]));
  }
  relight(state.yaw, state.tilt); requestDraw();
  offer(`${baseName()}_${angleName(state.yaw)}_${fps}fps.zip`, await zip.generateAsync({ type: "blob" }));
});
/* ---------- GIF ---------- */
// A small GIF89a encoder: one shared palette for the whole clip (median cut, no dithering,
// which keeps the flat low-poly look), LZW-compressed frames, looping forever.
function buildPalette(frames, maxColors) {
  const total = frames.reduce((s, f) => s + f.data.length / 4, 0);
  const stride = Math.max(1, Math.floor(total / 250000));
  const px = [];
  let n = 0;
  for (const f of frames) {
    const d = f.data;
    for (let i = 0; i < d.length; i += 4, n++) if (n % stride === 0 && d[i + 3] >= 128) px.push((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
  }
  if (!px.length) px.push(0);
  let boxes = [Uint32Array.from(px)];
  const range = (a) => {
    let r0 = 255, r1 = 0, g0 = 255, g1 = 0, b0 = 255, b1 = 0;
    for (const c of a) { const r = c >> 16, g = (c >> 8) & 255, b = c & 255; if (r < r0) r0 = r; if (r > r1) r1 = r; if (g < g0) g0 = g; if (g > g1) g1 = g; if (b < b0) b0 = b; if (b > b1) b1 = b; }
    return [r1 - r0, g1 - g0, b1 - b0];
  };
  while (boxes.length < maxColors) {
    let bi = -1, best = 0, bestCh = 0;
    boxes.forEach((bx, i) => { if (bx.length < 2) return; const rg = range(bx); const ch = rg.indexOf(Math.max(...rg)); const score = rg[ch] * Math.sqrt(bx.length); if (score > best) { best = score; bi = i; bestCh = ch; } });
    if (bi < 0) break;
    const shift = [16, 8, 0][bestCh], bx = boxes[bi];
    const sorted = Array.from(bx).sort((a, b) => ((a >> shift) & 255) - ((b >> shift) & 255));
    const mid = sorted.length >> 1;
    boxes.splice(bi, 1, Uint32Array.from(sorted.slice(0, mid)), Uint32Array.from(sorted.slice(mid)));
  }
  return boxes.map((bx) => { let r = 0, g = 0, b = 0; for (const c of bx) { r += c >> 16; g += (c >> 8) & 255; b += c & 255; } const k = bx.length || 1; return [Math.round(r / k), Math.round(g / k), Math.round(b / k)]; });
}
function encodeGif(frames, delaysCs, transparent) {
  const w = frames[0].width, h = frames[0].height;
  const pal = buildPalette(frames, transparent ? 255 : 256);
  while (pal.length < 256) pal.push([0, 0, 0]);
  const TI = 255; // transparent index
  const cache = new Int16Array(32768).fill(-1);
  const nearest = (r, g, b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    if (cache[key] >= 0) return cache[key];
    let bi = 0, bd = Infinity;
    const lim = transparent ? 255 : 256;
    for (let i = 0; i < lim; i++) { const p = pal[i], dr = p[0] - r, dg = p[1] - g, db = p[2] - b, dd = dr * dr * 2 + dg * dg * 4 + db * db * 3; if (dd < bd) { bd = dd; bi = i; } }
    return (cache[key] = bi);
  };
  const out = [];
  const byte = (b) => out.push(b & 255), word = (v) => { byte(v); byte(v >> 8); }, str = (s) => { for (const ch of s) byte(ch.charCodeAt(0)); };
  str("GIF89a"); word(w); word(h); byte(0xf7); byte(0); byte(0);
  for (const p of pal) { byte(p[0]); byte(p[1]); byte(p[2]); }
  byte(0x21); byte(0xff); byte(11); str("NETSCAPE2.0"); byte(3); byte(1); word(0); byte(0); // loop forever
  const idx = new Uint8Array(w * h);
  frames.forEach((f, fi) => {
    const d = f.data;
    for (let i = 0, p = 0; p < idx.length; i += 4, p++) idx[p] = transparent && d[i + 3] < 128 ? TI : nearest(d[i], d[i + 1], d[i + 2]);
    byte(0x21); byte(0xf9); byte(4); byte((2 << 2) | (transparent ? 1 : 0)); word(delaysCs[fi]); byte(transparent ? TI : 0); byte(0);
    byte(0x2c); word(0); word(0); word(w); word(h); byte(0);
    lzw(idx, out);
  });
  byte(0x3b);
  return new Uint8Array(out);
}
function lzw(idx, out) {
  const MIN = 8, CLEAR = 256, EOI = 257;
  out.push(MIN);
  let block = [], acc = 0, bits = 0;
  const emitByte = (b) => { block.push(b); if (block.length === 255) { out.push(255, ...block); block = []; } };
  let size = MIN + 1;
  const emit = (code) => { acc |= code << bits; bits += size; while (bits >= 8) { emitByte(acc & 255); acc >>>= 8; bits -= 8; } };
  let dict = new Map(), next = EOI + 1;
  emit(CLEAR);
  let prefix = idx[0];
  for (let i = 1; i < idx.length; i++) {
    const k = idx[i], key = (prefix << 8) | k, hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix);
    if (next < 4096) { dict.set(key, next++); if (next > (1 << size) && size < 12) size++; }
    else { emit(CLEAR); dict = new Map(); next = EOI + 1; size = MIN + 1; }
    prefix = k;
  }
  emit(prefix); emit(EOI);
  if (bits > 0) emitByte(acc & 255);
  if (block.length) out.push(block.length, ...block);
  out.push(0);
}
function syncGifNotes() {
  const spin = $("gifMotion").value === "spin", solid = $("gifBg").value === "color";
  $("gifColor").hidden = !solid;
  $("gifMotionNote").textContent = spin ? "One turn in about 4 seconds, at the tilt and frame you're on now." : "Uses the playback speed you picked under the preview.";
  $("gifBgNote").textContent = solid ? "Pick the colour behind the GIF in your video, or green to key it out." : "GIF transparency has hard edges. A solid colour (green for keying in Premiere) keeps them smooth.";
}
["gifMotion", "gifBg"].forEach((id) => $(id).addEventListener("change", syncGifNotes));
$("saveGif").addEventListener("click", async () => {
  if (!model) return;
  const msg = $("gifMsg"), btn = $("saveGif");
  const spin = $("gifMotion").value === "spin" || frameCount() < 2;
  const px = Number($("gifSize").value), pad = Math.round(state.pad * px / state.height) || 0;
  const solid = $("gifBg").value === "color", color = $("gifColor").value;
  stopPlayback(); btn.disabled = true; msg.classList.remove("err");
  try {
    const SPIN_STEPS = 40;
    const yaws = spin ? [...Array(SPIN_STEPS).keys()].map((k) => state.yaw + (360 / SPIN_STEPS) * k) : [state.yaw];
    const frames = spin ? [state.frame] : allFrames();
    const box = unionBox(spin ? [...Array(24).keys()].map((k) => k * 15) : yaws, frames);
    const shots = spin ? yaws.map((y) => [y, state.frame]) : frames.map((f) => [state.yaw, f]);
    const speed = Number($("speed").value) || 1;
    const images = [], delays = [];
    for (let i = 0; i < shots.length; i++) {
      msg.textContent = `Rendering frame ${i + 1} of ${shots.length}…`;
      await new Promise((r) => setTimeout(r));
      const c = renderAngle(shots[i][0], px, pad, shots[i][1], box);
      const flat = document.createElement("canvas"); flat.width = c.width; flat.height = c.height;
      const ctx = flat.getContext("2d");
      if (solid) { ctx.fillStyle = color; ctx.fillRect(0, 0, c.width, c.height); }
      ctx.drawImage(c, 0, 0);
      images.push(ctx.getImageData(0, 0, c.width, c.height));
      delays.push(spin ? 10 : Math.max(2, Math.round(frameMs(shots[i][1]) / speed / 10)));
    }
    msg.textContent = "Encoding the GIF…";
    await new Promise((r) => setTimeout(r));
    const gif = encodeGif(images, delays, !solid);
    relight(state.yaw, state.tilt); requestDraw();
    const name = `${baseName()}_${spin ? `turntable_tilt${state.tilt}` : angleName(state.yaw)}.gif`;
    msg.textContent = `${images[0].width} × ${images[0].height} px, ${shots.length} frames, ${(gif.length / 1048576).toFixed(1)} MB.`;
    await offer(name, new Blob([gif], { type: "image/gif" }));
  } catch (err) {
    msg.classList.add("err"); msg.textContent = "Couldn't make the GIF. Try a smaller height.";
  } finally { btn.disabled = false; }
});

function enterFallback() {
  saveMode = "fallback"; updateButtons();
  setSaveMsg("Saving files isn't available in this view. The contact sheet below shows full-size images: right-click one and choose Save image.");
  scheduleSheet();
}

/* ---------- two models ---------- */
// Each model stands on the same floor at its real in-game size. A is on the left,
// B on the right; distance is measured in game tiles (128 model units). Both play on
// one shared clock, each looping its own animation from its own start frame.
const TILE = 128;
const SAMPLE_B = (window.BOOTH_SAMPLES || {}).b || null;
const SAMPLE_B_NAME = "Archive Guardian.json";
const scene2 = new THREE.Scene();
const sc = {
  yaw: 0, tilt: 0, ambient: 0.55, contrast: 0.7, dist: 2, depth: 0, time: 0, loop: "long", height: 600, pad: 8,
  actors: [90, -90].map((facing) => ({ model: null, name: "", facing, start: 0, animate: true, msg: "", group: new THREE.Group() })),
};
sc.actors.forEach((a) => { a.group.matrixAutoUpdate = false; scene2.add(a.group); });
const sStageEl = $("sStage");
let sRenderer = null;
try { if (offRenderer) { sRenderer = new THREE.WebGLRenderer({ canvas: $("sCanvas"), antialias: true, alpha: true }); sRenderer.setClearColor(0x000000, 0); } } catch { sRenderer = null; }

const isAnimated = (a) => !!a.model && a.model.frames.length > 1 && a.animate;
function actorFrame(a, t) {
  if (!isAnimated(a)) return Math.min(a.start, a.model.frames.length - 1);
  return frameAtTime(a.model, t + timing(a.model).starts[a.start]);
}
function actorLocal(k) {
  const side = k === 0 ? -1 : 1;
  return new THREE.Matrix4().makeTranslation(side * sc.dist * TILE / 2, 0, side * sc.depth * TILE / 2)
    .multiply(new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(sc.actors[k].facing)));
}
function poseScene(t, yaw = sc.yaw) {
  const P = poseMatrix(yaw, sc.tilt);
  sc.actors.forEach((a, k) => {
    if (!a.model) return;
    const M = P.clone().multiply(actorLocal(k));
    shadeModel(a.model, M, actorFrame(a, t), sc.ambient, sc.contrast);
    a.group.matrix.copy(M); a.group.matrixWorldNeedsUpdate = true;
  });
}
// box around both models for the given turns, with each model's own list of frames
function sceneBox(yaws, framesPerActor, only = null) {
  let b = null;
  for (const y of yaws) {
    const P = poseMatrix(y, sc.tilt);
    sc.actors.forEach((a, k) => {
      if (!a.model || (only && !only.includes(k))) return;
      const M = P.clone().multiply(actorLocal(k));
      for (const f of framesPerActor[k]) b = mergeBox(b, boxOf(a.model, M, f));
    });
  }
  return b;
}
const framesAt = (times) => sc.actors.map((a) => (a.model ? [...new Set(times.map((t) => actorFrame(a, t)))] : []));
function sampledFrames() {
  return sc.actors.map((a) => {
    if (!a.model) return [];
    if (!isAnimated(a)) return [actorFrame(a, 0)];
    const n = a.model.frames.length, step = Math.max(1, Math.ceil(n / 8)), out = [];
    for (let i = 0; i < n; i += step) out.push(i);
    return out;
  });
}
function sceneRefHeight() {
  let h = 0;
  sc.actors.forEach((a) => { if (a.model) { const b = boxOf(a.model, new THREE.Matrix4(), 0); h = Math.max(h, b.y1 - b.y0); } });
  return h || 1;
}

/* timeline */
function sceneLoop() {
  const D = sc.actors.map((a) => (isAnimated(a) ? timing(a.model).total : 0));
  if (sc.loop === "a" && D[0]) return D[0];
  if (sc.loop === "b" && D[1]) return D[1];
  return Math.max(D[0], D[1]);
}
// every moment in the loop where either model changes frame
function eventTimes(L, only = null) {
  const ev = new Set([0]);
  sc.actors.forEach((a, k) => {
    if (!isAnimated(a) || (only && !only.includes(k))) return;
    const T = timing(a.model), off = T.starts[a.start];
    for (let base = -off; base < L; base += T.total) {
      for (let i = 0; i < a.model.frames.length; i++) { const t = base + T.starts[i]; if (t > 0 && t < L) ev.add(Math.round(t)); }
    }
  });
  return [...ev].sort((x, y) => x - y);
}
function sceneTimeLabel() {
  const L = sceneLoop();
  if (!L) return "no animation";
  const parts = sc.actors.map((a, k) => (isAnimated(a) ? `${"AB"[k]} ${actorFrame(a, sc.time) + 1}/${a.model.frames.length}` : null)).filter(Boolean);
  return `${(sc.time / 1000).toFixed(2)} / ${(L / 1000).toFixed(2)} s · ${parts.join(" · ")}`;
}
function setSceneTime(t, fromPlayback) {
  const L = sceneLoop();
  sc.time = L ? ((t % L) + L) % L : 0;
  $("sTime").value = String(Math.round(sc.time));
  $("sTimeOut").textContent = sceneTimeLabel();
  requestSceneDraw();
}
function sceneTimelineSetup() {
  const L = sceneLoop(), any = L > 0;
  const both = sc.actors.every(isAnimated), D = sc.actors.map((a) => (isAnimated(a) ? timing(a.model).total : 0));
  $("sTime").max = String(Math.max(0, L - 10)); $("sTime").disabled = !any;
  $("sPlay").disabled = !any; $("sSpeed").disabled = !any;
  $("sAnimMsg").hidden = any;
  $("sLoopField").hidden = !(both && D[0] !== D[1]);
  if ($("sLoopField").hidden) { sc.loop = "long"; $("sLoop").value = "long"; }
  $("sLoop").options[1].textContent = `Model A's animation (${(D[0] / 1000).toFixed(2)} s)`;
  $("sLoop").options[2].textContent = `Model B's animation (${(D[1] / 1000).toFixed(2)} s)`;
  $("sGifMotion").querySelector('[value="anim"]').disabled = !any;
  if (!any) $("sGifMotion").value = "spin";
  else if ($("sGifMotion").dataset.touched !== "1") $("sGifMotion").value = "anim";
  $("sSaveFrames").hidden = !any; $("sFpsField").hidden = !any;
  if (!any) sStop();
  setSceneTime(sc.time);
  updateSceneButtons();
}
let sPlaying = false, sLast = 0;
function sStep(now) {
  if (!sPlaying) return;
  const speed = Number($("sSpeed").value) || 1;
  const dt = now - sLast; sLast = now;
  setSceneTime(sc.time + dt * speed, true);
  requestAnimationFrame(sStep);
}
function sStart() { if (!sceneLoop()) return; sPlaying = true; sLast = performance.now(); $("sPlay").textContent = "Pause"; requestAnimationFrame(sStep); }
function sStop() { sPlaying = false; $("sPlay").textContent = "Play"; }

/* stage */
let sStageFrame = null, sDrawQueued = false;
function placementChanged() { sStageFrame = null; syncPresetChips(); $("sTimeOut").textContent = sceneTimeLabel(); requestSceneDraw(); }
function requestSceneDraw() { if (!sDrawQueued) { sDrawQueued = true; requestAnimationFrame(drawScene); } }
function drawScene() {
  sDrawQueued = false;
  if (!sRenderer || mode !== "two" || !sc.actors.some((a) => a.model)) return;
  const r = sStageEl.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
  if (w < 4 || h < 4) return;
  sRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  sRenderer.setSize(w, h, false);
  poseScene(sc.time);
  if (!sStageFrame) { // fixed framing across every turn, so nothing jumps while you drag
    const yaws = []; for (let d = 0; d < 360; d += 30) yaws.push(d);
    sStageFrame = sceneBox(yaws, sampledFrames());
  }
  const box = sStageFrame;
  frameCamera(box, (box.y1 - box.y0) * 0.06, w / h);
  sRenderer.render(scene2, cam);
  $("sReadout").textContent = `${sc.yaw}° · tilt ${sc.tilt}°`;
}
new ResizeObserver(requestSceneDraw).observe(sStageEl);

// render one moment to a trimmed, transparent canvas
function renderScene(t, yaw, px, pad, fixedBox = null, only = null) {
  const scale = px / sceneRefHeight();
  const box = fixedBox || sceneBox([yaw], framesAt([t]), only);
  const w = Math.max(1, Math.ceil((box.x1 - box.x0) * scale + pad * 2));
  const h = Math.max(1, Math.ceil((box.y1 - box.y0) * scale + pad * 2));
  const ss = Math.min(SUPERSAMPLE, Math.floor(4096 / Math.max(w, h)) || 1);
  offRenderer.setSize(w * ss, h * ss, false);
  poseScene(t, yaw);
  frameCamera(box, pad / scale, w / h);
  sc.actors.forEach((a, k) => (a.group.visible = !only || only.includes(k))); // the other model is left out entirely
  offRenderer.render(scene2, cam);
  sc.actors.forEach((a) => (a.group.visible = true));
  const out = document.createElement("canvas"); out.width = w; out.height = h;
  const ctx = out.getContext("2d"); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  ctx.drawImage(offRenderer.domElement, 0, 0, w, h);
  return out;
}
function restoreScene() { poseScene(sc.time); requestSceneDraw(); }

/* models */
function setActor(k, m, name, msg = "") {
  const a = sc.actors[k];
  if (a.model) a.model.groups.forEach((g) => { a.group.remove(g.mesh); g.mesh.geometry.dispose(); g.mesh.material.dispose(); });
  a.model = m; a.name = name; a.start = 0; a.animate = true; a.msg = msg;
  m.groups.forEach((g) => a.group.add(g.mesh));
  m.cur = -1;
  syncActor(k); autoDistance(); sceneTimelineSetup(); placementChanged();
}
function syncActor(k) {
  const a = sc.actors[k], n = a.model ? a.model.frames.length : 1;
  $(`aName${k}`).textContent = a.model ? a.name.replace(/\.json$/i, "") : `Model ${"AB"[k]}`;
  $(`aName${k}`).title = a.name;
  $(`aFace${k}`).value = String(a.facing); $(`aFaceOut${k}`).textContent = `${a.facing}°`;
  $(`aStart${k}`).max = String(n - 1); $(`aStart${k}`).value = String(a.start); $(`aStart${k}`).disabled = n < 2;
  $(`aStartOut${k}`).textContent = `${a.start + 1} / ${n}`;
  $(`aAnim${k}`).checked = a.animate; $(`aAnim${k}`).disabled = n < 2;
  const m = $(`aMsg${k}`); m.textContent = a.msg; m.classList.toggle("err", false);
  syncWho();
}
// leave room for both models: the widest reach of each, plus a quarter tile
function reach(a) {
  let r = 0;
  const n = a.model.frames.length, step = Math.max(1, Math.ceil(n / 8));
  for (let f = 0; f < n; f += step) { const p = a.model.frames[f]; for (let i = 0; i < a.model.nv; i++) r = Math.max(r, Math.hypot(p[i * 3], p[i * 3 + 2])); }
  return r;
}
function autoDistance() {
  if (!sc.actors.every((a) => a.model)) return;
  const tiles = (reach(sc.actors[0]) + reach(sc.actors[1])) / TILE + 0.25;
  setDist(Math.min(8, Math.ceil(tiles * 4) / 4));
}
async function loadActor(k, list) {
  const msg = $(`aMsg${k}`);
  try {
    const r = await modelFromFiles(list);
    setActor(k, r.model, r.name, r.note);
  } catch (err) { msg.classList.add("err"); msg.textContent = err.message; }
}

/* controls */
const PRESETS = { face: [90, -90], side: [0, 0], back: [-90, 90] };
function syncPresetChips() {
  document.querySelectorAll("#sPresets .chip").forEach((b) => {
    const p = PRESETS[b.dataset.p];
    b.setAttribute("aria-pressed", String(p[0] === sc.actors[0].facing && p[1] === sc.actors[1].facing));
  });
}
document.querySelectorAll("#sPresets .chip").forEach((b) => b.addEventListener("click", () => {
  const p = PRESETS[b.dataset.p];
  sc.actors[0].facing = p[0]; sc.actors[1].facing = p[1];
  syncActor(0); syncActor(1); placementChanged();
}));
function setDist(v) { sc.dist = v; $("sDist").value = String(v); $("sDistOut").textContent = `${v} tile${v === 1 ? "" : "s"}`; placementChanged(); }
$("sDist").addEventListener("input", (e) => setDist(Number(e.target.value)));
$("sDepth").addEventListener("input", (e) => { sc.depth = Number(e.target.value); $("sDepthOut").textContent = `${sc.depth} tile${Math.abs(sc.depth) === 1 ? "" : "s"}`; placementChanged(); });
$("sSwap").addEventListener("click", () => {
  const [a, b] = sc.actors;
  [a.facing, b.facing] = [b.facing, a.facing]; // facing stays with the side, the models change places
  sc.actors = [b, a];
  syncActor(0); syncActor(1); sceneTimelineSetup(); placementChanged();
});
[0, 1].forEach((k) => {
  $(`aFile${k}`).addEventListener("change", (e) => { loadActor(k, e.target.files); e.target.value = ""; });
  $(`aFace${k}`).addEventListener("input", (e) => { sc.actors[k].facing = Number(e.target.value); $(`aFaceOut${k}`).textContent = `${e.target.value}°`; placementChanged(); });
  $(`aStart${k}`).addEventListener("input", (e) => {
    const a = sc.actors[k]; a.start = Number(e.target.value);
    $(`aStartOut${k}`).textContent = `${a.start + 1} / ${a.model.frames.length}`;
    if (!a.animate) sStageFrame = null;
    $("sTimeOut").textContent = sceneTimeLabel(); requestSceneDraw();
  });
  $(`aAnim${k}`).addEventListener("change", (e) => { sc.actors[k].animate = e.target.checked; sceneTimelineSetup(); placementChanged(); });
  const card = $(`actor${k}`);
  card.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); card.classList.add("over"); });
  card.addEventListener("dragleave", () => card.classList.remove("over"));
  card.addEventListener("drop", (e) => { e.preventDefault(); e.stopPropagation(); card.classList.remove("over"); loadActor(k, e.dataTransfer.files); });
});
function setSceneYaw(d) { sc.yaw = ((Math.round(d) % 360) + 360) % 360; $("sYaw").value = sc.yaw; $("sYawOut").textContent = `${sc.yaw}°`; requestSceneDraw(); }
function setSceneTilt(t) { sc.tilt = t; $("sTilt").value = t; $("sTiltOut").textContent = `${t}°`; sStageFrame = null; requestSceneDraw(); }
$("sYaw").addEventListener("input", (e) => setSceneYaw(Number(e.target.value)));
$("sTilt").addEventListener("input", (e) => setSceneTilt(Number(e.target.value)));
$("sAmbient").addEventListener("input", (e) => { sc.ambient = Number(e.target.value) / 100; $("sAmbientOut").textContent = e.target.value; requestSceneDraw(); });
$("sContrast").addEventListener("input", (e) => { sc.contrast = Number(e.target.value) / 100; $("sContrastOut").textContent = e.target.value; requestSceneDraw(); });
$("sSize").addEventListener("change", (e) => { sc.height = Number(e.target.value); });
$("sPad").addEventListener("input", (e) => { sc.pad = Number(e.target.value); $("sPadOut").textContent = `${sc.pad} px`; });
$("sPlay").addEventListener("click", () => (sPlaying ? sStop() : sStart()));
$("sTime").addEventListener("input", (e) => { sStop(); setSceneTime(Number(e.target.value)); });
$("sLoop").addEventListener("change", (e) => { sc.loop = e.target.value; sceneTimelineSetup(); });
$("sGifMotion").addEventListener("change", (e) => { e.target.dataset.touched = "1"; });
$("sGifBg").addEventListener("change", () => { $("sGifColor").hidden = $("sGifBg").value !== "color"; });
document.addEventListener("keydown", (e) => {
  if (mode !== "two" || (e.target.closest && e.target.closest("input, select, textarea, button"))) return;
  const L = sceneLoop(); if (!L || (e.key !== "," && e.key !== ".")) return;
  sStop();
  const ev = eventTimes(L), t = Math.round(sc.time);
  if (e.key === ".") setSceneTime(ev.find((x) => x > t) ?? 0);
  else setSceneTime([...ev].reverse().find((x) => x < t) ?? ev[ev.length - 1]);
});
// drag on the stage turns and tilts the camera
let sDrag = null;
sStageEl.addEventListener("pointerdown", (e) => { sDrag = { x: e.clientX, y: e.clientY, yaw: sc.yaw, tilt: sc.tilt }; sStageEl.setPointerCapture(e.pointerId); sStageEl.classList.add("dragging"); });
sStageEl.addEventListener("pointermove", (e) => {
  if (!sDrag) return;
  setSceneYaw(sDrag.yaw + (e.clientX - sDrag.x) * 0.5);
  const t = Math.max(-20, Math.min(60, Math.round(sDrag.tilt + (e.clientY - sDrag.y) * 0.25)));
  if (t !== sc.tilt) setSceneTilt(t);
});
const sEndDrag = () => { sDrag = null; sStageEl.classList.remove("dragging"); };
sStageEl.addEventListener("pointerup", sEndDrag); sStageEl.addEventListener("pointercancel", sEndDrag);
// dropping files on the left half loads A, the right half loads B
let sDragDepth = 0;
const halfAt = (e) => { const r = sStageEl.getBoundingClientRect(); return e.clientX - r.left < r.width / 2 ? 0 : 1; };
const markHalf = (k) => $("sVeil").querySelectorAll("div").forEach((d) => d.classList.toggle("on", Number(d.dataset.k) === k));
sStageEl.addEventListener("dragenter", (e) => { e.preventDefault(); sDragDepth++; $("sVeil").hidden = false; });
sStageEl.addEventListener("dragleave", () => { if (--sDragDepth <= 0) { sDragDepth = 0; $("sVeil").hidden = true; } });
sStageEl.addEventListener("dragover", (e) => { e.preventDefault(); markHalf(halfAt(e)); });
sStageEl.addEventListener("drop", (e) => { e.preventDefault(); sDragDepth = 0; $("sVeil").hidden = true; const f = e.dataTransfer.files; if (backdropFromFiles(f) && !hasJson(f)) return; loadActor(halfAt(e), f); });

/* saving */
const shortName = (a) => (a.name || "model").replace(/\.json$/i, "").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") || "model";
const sceneName = () => `${shortName(sc.actors[0])}_and_${shortName(sc.actors[1])}`;
// what goes into a saved file: both models, or one of them
function exportPlan() {
  const who = $("sWho").value, only = who === "both" ? null : [Number(who)];
  const align = !only || $("sAlign").checked;
  const name = only ? `${shortName(sc.actors[only[0]])}_${"AB"[only[0]]}` : sceneName();
  // with "same canvas" on, a single model is framed exactly like the full scene, so layers stack
  const boxFor = (yaws, frames) => sceneBox(yaws, frames, align ? null : only);
  return { only, name, boxFor, missing: only ? !sc.actors[only[0]].model : !sc.actors.some((a) => a.model) };
}
function syncWho() {
  sc.actors.forEach((a, k) => ($("sWho").options[k + 1].textContent = `Only model ${"AB"[k]}${a.model ? ` (${a.name.replace(/\.json$/i, "")})` : ""}`));
  const single = $("sWho").value !== "both";
  $("sAlignRow").hidden = !single;
  $("sWhoNote").textContent = !single ? "Applies to the PNG, the zip and the GIF."
    : $("sAlign").checked ? "Same size and position as the full scene, so the A and B files line up when you stack them in Premiere."
    : "Cropped tight around this model. Applies to the PNG, the zip and the GIF.";
}
$("sWho").addEventListener("change", syncWho);
$("sAlign").addEventListener("change", syncWho);
function setSceneMsg(text, err) { const m = $("sSaveMsg"); m.textContent = text; m.classList.toggle("err", !!err); }
function updateSceneButtons() {
  if (!sceneReady) return;
  const off = saveMode !== "ready" || !sc.actors.some((a) => a.model);
  ["sSavePng", "sSaveFrames", "sSaveGif"].forEach((id) => ($(id).disabled = off));
  if (saveMode === "fallback") setSceneMsg("Saving files isn't available in this view. Open the standalone copy of the Photo Booth to save scenes.");
}
$("sSavePng").addEventListener("click", async () => {
  sStop();
  const plan = exportPlan(); if (plan.missing) { setSceneMsg("That model isn't loaded yet.", true); return; }
  const blob = await toBlob(renderScene(sc.time, sc.yaw, sc.height, sc.pad, plan.boxFor([sc.yaw], framesAt([sc.time])), plan.only));
  restoreScene();
  offer(`${plan.name}_${sc.yaw}deg.png`, blob, setSceneMsg);
});
$("sSaveFrames").addEventListener("click", async () => {
  const L = sceneLoop(); if (!L) return;
  sStop(); const btn = $("sSaveFrames"); btn.disabled = true;
  try {
    const plan = exportPlan(); if (plan.missing) { setSceneMsg("That model isn't loaded yet.", true); return; }
    const fps = Number($("sFps").value) || 30, speed = Number($("sSpeed").value) || 1;
    const times = seqTimes(L, fps, speed), box = plan.boxFor([sc.yaw], framesAt(times));
    const zip = new JSZip(), cache = new Map(), digits = Math.max(3, String(times.length).length);
    for (let i = 0; i < times.length; i++) {
      setSceneMsg(`Rendering frame ${i + 1} of ${times.length}…`);
      const key = sc.actors.map((a, k) => (a.model && (!plan.only || plan.only.includes(k)) ? actorFrame(a, times[i]) : -1)).join("|");
      if (!cache.has(key)) { await new Promise((r) => setTimeout(r)); cache.set(key, await toBlob(renderScene(times[i], sc.yaw, sc.height, sc.pad, box, plan.only))); }
      zip.file(`${plan.name}_${String(i + 1).padStart(digits, "0")}.png`, cache.get(key));
    }
    restoreScene();
    setSceneMsg("Packing the zip…");
    await offer(`${plan.name}_${sc.yaw}deg_${fps}fps.zip`, await zip.generateAsync({ type: "blob" }), setSceneMsg);
  } catch { setSceneMsg("Couldn't render the frames. Try a smaller height.", true); restoreScene(); }
  finally { btn.disabled = false; }
});
$("sSaveGif").addEventListener("click", async () => {
  const msg = $("sGifMsg"), btn = $("sSaveGif");
  const L = sceneLoop(), spin = $("sGifMotion").value === "spin" || !L;
  const px = Number($("sGifSize").value), pad = Math.round(sc.pad * px / sc.height) || 0;
  const solid = $("sGifBg").value === "color", color = $("sGifColor").value;
  const plan = exportPlan(); if (plan.missing) { msg.classList.add("err"); msg.textContent = "That model isn't loaded yet."; return; }
  sStop(); btn.disabled = true; msg.classList.remove("err");
  try {
    const speed = Number($("sSpeed").value) || 1;
    let shots, delays, box;
    if (spin) {
      const STEPS = 40;
      shots = [...Array(STEPS).keys()].map((k) => [sc.time, sc.yaw + (360 / STEPS) * k]);
      delays = shots.map(() => 10);
      box = plan.boxFor([...Array(24).keys()].map((k) => k * 15), framesAt([sc.time]));
    } else {
      // same loop length as the full scene, so a single-model GIF stays in step with the other one
      const ev = eventTimes(L, plan.only);
      shots = ev.map((t) => [t, sc.yaw]);
      delays = ev.map((t, j) => Math.max(2, Math.round(((j + 1 < ev.length ? ev[j + 1] : L) - t) / speed / 10)));
      box = plan.boxFor([sc.yaw], framesAt(ev));
    }
    const images = [];
    for (let i = 0; i < shots.length; i++) {
      msg.textContent = `Rendering frame ${i + 1} of ${shots.length}…`;
      await new Promise((r) => setTimeout(r));
      const c = renderScene(shots[i][0], shots[i][1], px, pad, box, plan.only);
      const flat = document.createElement("canvas"); flat.width = c.width; flat.height = c.height;
      const ctx = flat.getContext("2d");
      if (solid) { ctx.fillStyle = color; ctx.fillRect(0, 0, c.width, c.height); }
      ctx.drawImage(c, 0, 0);
      images.push(ctx.getImageData(0, 0, c.width, c.height));
    }
    msg.textContent = "Encoding the GIF…";
    await new Promise((r) => setTimeout(r));
    const gif = encodeGif(images, delays, !solid);
    restoreScene();
    msg.textContent = `${images[0].width} × ${images[0].height} px, ${shots.length} frames, ${(gif.length / 1048576).toFixed(1)} MB.`;
    await offer(`${plan.name}_${spin ? `turntable_tilt${sc.tilt}` : `${sc.yaw}deg`}.gif`, new Blob([gif], { type: "image/gif" }), (t, e) => { msg.textContent = t; msg.classList.toggle("err", !!e); });
  } catch { msg.classList.add("err"); msg.textContent = "Couldn't make the GIF. Try a smaller height."; restoreScene(); }
  finally { btn.disabled = false; }
});

/* mode tabs */
function setMode(m) {
  mode = m;
  document.querySelectorAll(".modes [role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === m)));
  $("modeOne").hidden = m !== "one"; $("modeTwo").hidden = m !== "two";
  $("fileStatus").hidden = m !== "one";
  if (m === "two") { stopPlayback(); requestSceneDraw(); } else { sStop(); requestDraw(); }
}
document.querySelectorAll(".modes [role=tab]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

// start with your character facing the Archive Guardian
if (SAMPLE_MODEL) try { setActor(0, parseModel(SAMPLE_MODEL), SAMPLE_NAME, "Example. Load your own export to replace it."); } catch (err) { $("aMsg0").textContent = err.message; }
if (SAMPLE_B) try { setActor(1, parseModel(SAMPLE_B), SAMPLE_B_NAME, "Example. Load your own export to replace it."); } catch (err) { $("aMsg1").textContent = err.message; }
sceneReady = true; updateSceneButtons();

/* ---------- backdrop (composing only, never exported) ---------- */
// The image sits in the page behind the transparent 3D canvas. Exports render offscreen,
// so it can't end up in a saved file.
const bd = { blob: null, url: null, fit: "cover", zoom: 100, x: 0, y: 0, dim: 100, show: true };
const bdImgs = [...document.querySelectorAll(".bg-layer img")];
const isImageFile = (f) => f && /^image\//.test(f.type);
const hasJson = (list) => Array.from(list || []).some((f) => /\.json$/i.test(f.name) || f.type === "application/json");
function backdropFromFiles(list) { const img = Array.from(list || []).find(isImageFile); if (img) setBackdrop(img); return !!img; }
function applyBackdrop() {
  const on = !!bd.url && bd.show;
  bdImgs.forEach((img) => {
    img.parentElement.hidden = !on;
    if (bd.url && img.getAttribute("src") !== bd.url) img.src = bd.url;
    img.style.objectFit = bd.fit;
    img.style.transform = `translate(${bd.x}%, ${bd.y}%) scale(${bd.zoom / 100})`;
    img.style.filter = bd.dim < 100 ? `brightness(${bd.dim / 100})` : "";
  });
  $("bdControls").hidden = !bd.url; $("bdThumb").hidden = !bd.url;
  if (bd.url) $("bdThumb").querySelector("img").src = bd.url;
  $("bdHint").innerHTML = bd.url ? "Paste another screenshot to replace it, or" : "Press <kbd>Ctrl</kbd> + <kbd>V</kbd> to paste a screenshot behind the models, or";
  $("bdShow").checked = bd.show;
  $("bdFill").setAttribute("aria-pressed", String(bd.fit === "cover")); $("bdFit").setAttribute("aria-pressed", String(bd.fit === "contain"));
  $("bdZoom").value = bd.zoom; $("bdZoomOut").textContent = `${bd.zoom}%`;
  $("bdX").value = bd.x; $("bdY").value = bd.y;
  $("bdDim").value = bd.dim; $("bdDimOut").textContent = `${bd.dim}%`;
}
function setBackdrop(blob) {
  if (bd.url) URL.revokeObjectURL(bd.url);
  bd.blob = blob || null; bd.url = blob ? URL.createObjectURL(blob) : null;
  if (blob) bd.show = true;
  applyBackdrop(); saveBackdrop();
}
// kept in this browser between visits
const bdStore = {
  open() { return new Promise((res, rej) => { const r = indexedDB.open("photo-booth", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async get(k) { const db = await this.open(); return new Promise((res, rej) => { const q = db.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
  async set(k, v) { const db = await this.open(); return new Promise((res, rej) => { const tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").put(v, k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); },
};
let bdSaveTimer = null;
function saveBackdrop() {
  clearTimeout(bdSaveTimer);
  bdSaveTimer = setTimeout(() => {
    try { bdStore.set("backdrop", { blob: bd.blob, fit: bd.fit, zoom: bd.zoom, x: bd.x, y: bd.y, dim: bd.dim, show: bd.show }).catch(() => {}); } catch { /* no storage here */ }
  }, 250);
}
document.addEventListener("paste", (e) => {
  if (e.target.closest && e.target.closest("input, textarea")) return;
  const cd = e.clipboardData; if (!cd) return;
  let img = Array.from(cd.files || []).find(isImageFile);
  if (!img) for (const it of Array.from(cd.items || [])) if (it.kind === "file" && /^image\//.test(it.type)) { img = it.getAsFile(); break; }
  if (!img) return;
  e.preventDefault(); setBackdrop(img);
});
$("bdFile").addEventListener("change", (e) => { const f = Array.from(e.target.files || []).find(isImageFile); if (f) setBackdrop(f); e.target.value = ""; });
$("bdShow").addEventListener("change", (e) => { bd.show = e.target.checked; applyBackdrop(); saveBackdrop(); });
$("bdFill").addEventListener("click", () => { bd.fit = "cover"; applyBackdrop(); saveBackdrop(); });
$("bdFit").addEventListener("click", () => { bd.fit = "contain"; applyBackdrop(); saveBackdrop(); });
[["bdZoom", "zoom"], ["bdX", "x"], ["bdY", "y"], ["bdDim", "dim"]].forEach(([id, key]) => $(id).addEventListener("input", (e) => { bd[key] = Number(e.target.value); applyBackdrop(); saveBackdrop(); }));
$("bdClear").addEventListener("click", () => setBackdrop(null));
const bdBar = $("bdBar");
bdBar.addEventListener("dragover", (e) => { e.preventDefault(); bdBar.classList.add("over"); });
bdBar.addEventListener("dragleave", (e) => { if (!bdBar.contains(e.relatedTarget)) bdBar.classList.remove("over"); });
bdBar.addEventListener("drop", (e) => { e.preventDefault(); bdBar.classList.remove("over"); backdropFromFiles(e.dataTransfer.files); });
(async () => {
  try {
    const s = await bdStore.get("backdrop");
    if (!s || !s.blob || bd.blob) return;
    Object.assign(bd, { fit: s.fit === "contain" ? "contain" : "cover", zoom: s.zoom ?? 100, x: s.x ?? 0, y: s.y ?? 0, dim: s.dim ?? 100 });
    setBackdrop(s.blob); bd.show = s.show !== false; applyBackdrop();
  } catch { /* storage blocked: start without a backdrop */ }
})();

/* ---------- start ---------- */
buildFrames(); updateButtons(); syncPresets();
if (SAMPLE_MODEL) try { setModel(parseModel(SAMPLE_MODEL), SAMPLE_NAME); $("loadMsg").textContent = "Showing the example. Load your own export to replace it."; }
catch (err) { $("loadMsg").classList.add("err"); $("loadMsg").textContent = err.message; }
(async () => {
  try { downloads = window.claude && window.claude.use ? await window.claude.use("downloads") : null; } catch { downloads = null; }
  saveMode = "ready"; updateButtons(); // no Claude viewer here: files save straight to the browser
})();
