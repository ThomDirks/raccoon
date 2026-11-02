const EXAMPLES = [];
const EXAMPLE_TITLES = [
  "A quiet night on the farm to fall asleep to | Road to Chambers #1",
  "Farming the greenhouse until you fall asleep (2 hours of calm chat)",
  "Everything my ironman still needs before Chambers, to fall asleep to",
];
const EXAMPLE_DUR = ["2:47:12", "2:05:40", "3:01:09"];
const AGES = ["3 hours ago", "1 day ago", "2 days ago", "5 days ago", "1 week ago", "2 weeks ago", "1 month ago", "3 months ago", "8 months ago", "1 year ago", "2 years ago"];
const DURS = ["1:58:20", "3:00:00", "45:12", "2:31:47", "12:08", "1:10:33", "4:02:15", "28:41", "2:00:04", "19:57"];
const SVG = {
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7.5"/><path d="M12 8v4.5l3 1.8"/></svg>',
  queue: '<svg viewBox="0 0 24 24"><path d="M4 7h11M4 11.5h11M4 16h6M17 13v7M13.5 16.5h7"/></svg>',
  mute: '<svg viewBox="0 0 24 24"><path d="M4 10v4h3l4 3.5v-11L7 10z"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5"/></svg>',
  cc: '<svg viewBox="0 0 24 24"><rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M10.5 10.5a2 2 0 1 0 0 3M16.5 10.5a2 2 0 1 0 0 3"/></svg>',
  kebab: '<svg viewBox="0 0 24 24"><circle cx="12" cy="5.5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="18.5" r="1.7"/></svg>',
};

const $ = (id) => document.getElementById(id);
let uid = 0;
const state = {
  mine: [], others: [], channel: "Your channel", yt: "dark", cols: 4, every: 7, dev: "pc", orient: "land",
  preview: true, shorts: true, mark: false, bar: false, gray: false, blur: false, seed: 0,
};

/* ---------- storage: images in IndexedDB, so swaps survive a reload ---------- */
const store = {
  db: null,
  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((res, rej) => {
      const r = indexedDB.open("thumbnail-bench", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return this.db;
  },
  async get(k) { const db = await this.open(); return new Promise((res, rej) => { const q = db.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
  async set(k, v) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); },
};
function dataUrlToBlob(u) {
  const [head, b64] = u.split(","); const mime = head.match(/:(.*?);/)[1];
  const bin = atob(b64), arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
const SETTINGS = ["channel", "yt", "cols", "every", "preview", "shorts", "mark", "bar", "gray", "blur", "dev", "orient"];
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const pick = ({ blob, title, duration, file, mod, size, folder }) => ({ blob, title, duration, file, mod, size, folder });
      const s = { mine: state.mine.map(pick), others: state.others.map(pick) };
      SETTINGS.forEach((k) => (s[k] = state[k]));
      await store.set("state-v2", s);
    } catch { /* storage blocked: the page still works for this visit */ }
  }, 300);
}
function makeItem(blob, extra = {}) { return { id: ++uid, blob, url: URL.createObjectURL(blob), ...extra }; }
function loadExamples() {
  state.mine.forEach((m) => URL.revokeObjectURL(m.url));
  state.mine = EXAMPLES.map((u, i) => makeItem(dataUrlToBlob(u), { title: EXAMPLE_TITLES[i], duration: EXAMPLE_DUR[i], example: true }));
}
// a title from a screenshot's file name, unless it's just "Screenshot 2026-..."
function titleFromFile(name) {
  const base = name.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!base || /^(screenshot|screen shot|schermafbeelding|bildschirmfoto|image|img|capture|snip)/i.test(base) || /^[\d\s\-:.()]+$/.test(base)) return null;
  return base;
}

/* ---------- top strip ---------- */
const isImage = (f) => f && /^image\//.test(f.type);
const imagesOf = (list) => Array.from(list || []).filter(isImage);
let swapTarget = null;
function renderCards() {
  const host = $("cards"); host.innerHTML = "";
  state.mine.forEach((m, idx) => {
    const card = document.createElement("div"); card.className = "card";
    const imgBtn = document.createElement("button"); imgBtn.type = "button"; imgBtn.className = "card-img";
    imgBtn.setAttribute("aria-label", `Replace thumbnail ${idx + 1}`);
    const img = document.createElement("img"); img.src = m.url; img.alt = "";
    const sw = document.createElement("span"); sw.className = "swap"; sw.textContent = "Replace";
    imgBtn.append(img, sw);
    imgBtn.addEventListener("click", () => { swapTarget = m.id; $("swapInput").click(); });

    const tf = document.createElement("div"); tf.className = "field";
    const tl = document.createElement("label"); tl.htmlFor = `title-${m.id}`; tl.textContent = "Title";
    const ti = document.createElement("input"); ti.id = `title-${m.id}`; ti.value = m.title || "";
    const cnt = document.createElement("span"); cnt.className = "count";
    const setCount = () => { const n = ti.value.length; cnt.textContent = `${n} / 100` + (n > 100 ? " · too long for YouTube" : ""); cnt.classList.toggle("over", n > 100); };
    ti.addEventListener("input", () => { m.title = ti.value; setCount(); renderFeed(); save(); });
    setCount(); tf.append(tl, ti, cnt);

    const row = document.createElement("div"); row.className = "row2";
    const df = document.createElement("div"); df.className = "field";
    const dl = document.createElement("label"); dl.htmlFor = `dur-${m.id}`; dl.textContent = "Length";
    const di = document.createElement("input"); di.id = `dur-${m.id}`; di.value = m.duration || ""; di.placeholder = "2:47:12";
    di.addEventListener("input", () => { m.duration = di.value; renderFeed(); save(); });
    df.append(dl, di);
    const rm = document.createElement("button"); rm.type = "button"; rm.className = "mini"; rm.textContent = "Remove";
    rm.addEventListener("click", () => { URL.revokeObjectURL(m.url); state.mine = state.mine.filter((x) => x.id !== m.id); renderAll(); save(); });
    row.append(df, rm);
    card.append(imgBtn, tf, row);
    card.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); card.classList.add("over"); });
    card.addEventListener("dragleave", () => card.classList.remove("over"));
    card.addEventListener("drop", (e) => { e.preventDefault(); e.stopPropagation(); card.classList.remove("over"); const f = imagesOf(e.dataTransfer.files)[0]; if (f) replaceImage(m.id, f); });
    host.append(card);
  });
  const add = document.createElement("button"); add.type = "button"; add.className = "drop-card";
  add.innerHTML = "<b>Add yours</b><span>Click, drop, or paste</span>";
  add.addEventListener("click", () => $("addInput").click());
  add.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); add.classList.add("over"); });
  add.addEventListener("dragleave", () => add.classList.remove("over"));
  add.addEventListener("drop", (e) => { e.preventDefault(); e.stopPropagation(); add.classList.remove("over"); addMine(e.dataTransfer.files); });
  host.append(add);
  $("mineSub").textContent = state.mine.some((m) => m.example)
    ? "Your three designs, with example titles. Click one or drop a new export onto its card to replace it."
    : state.mine.length ? "Click a thumbnail, or drop a new export onto its card, to replace it."
    : "Point it at your thumbnail export folder, or click Add yours, drop, or paste.";
  $("resetBtn").hidden = !EXAMPLES.length;
}
function renderPile() {
  const host = $("pile"); host.innerHTML = "";
  state.others.forEach((o, i) => {
    const el = document.createElement("div"); el.className = "o";
    const img = document.createElement("img"); img.src = o.url; img.alt = ""; img.loading = "lazy";
    const rm = document.createElement("button"); rm.type = "button"; rm.textContent = "Remove"; rm.setAttribute("aria-label", `Remove other thumbnail ${i + 1}`);
    rm.addEventListener("click", () => { URL.revokeObjectURL(o.url); state.others = state.others.filter((x) => x.id !== o.id); renderAll(); save(); });
    el.append(img, rm); host.append(el);
  });
  $("otherCount").textContent = String(state.others.length);
  $("clearOthers").disabled = !state.others.length;
}
function replaceImage(id, file) {
  const m = state.mine.find((x) => x.id === id); if (!m) return;
  URL.revokeObjectURL(m.url); m.blob = file; m.url = URL.createObjectURL(file); m.example = false;
  renderAll(); save();
}
function addMine(list) {
  const files = imagesOf(list); if (!files.length) return;
  files.forEach((f) => state.mine.push(makeItem(f, { title: titleFromFile(f.name) || "Untitled video", duration: "2:30:00" })));
  renderAll(); save();
}
function addOthers(list) {
  const files = imagesOf(list); if (!files.length) return;
  files.forEach((f) => state.others.push(makeItem(f, { title: titleFromFile(f.name) })));
  renderAll(); save();
}

/* ---------- building the feed ---------- */
// small seeded random, so the made-up view counts stay put between renders
function rand(seed) { let t = (seed + 0x6D2B79F5) | 0; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
function viewsText(r) {
  const v = Math.floor(Math.pow(10, 2.5 + r * 3.8));
  if (v >= 1e6) return `${(v / 1e6).toFixed(v < 1e7 ? 1 : 0)}M views`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(v < 1e4 ? 1 : 0)}K views`;
  return `${v} views`;
}
// The same feed for every device: others in order, yours dropped in every N videos.
// With few or no other thumbnails, grey placeholder tiles keep the spacing honest.
function feedList(rowLen) {
  let others = state.others.map((o) => ({ kind: "other", o }));
  if (state.seed) others = others.map((x, i) => ({ x, k: rand(state.seed * 977 + i) })).sort((a, b) => a.k - b.k).map((z) => z.x);
  const every = Math.max(2, state.every | 0);
  const offset = state.seed ? Math.floor(rand(state.seed) * every) : Math.min(2, every - 1);
  const M = state.mine.length;
  const needOthers = Math.max(0, offset + (M - 1) * every + 1 - M);
  const minTotal = Math.max(rowLen * 4, 12, M + others.length, needOthers + M);
  let k = 0;
  while (others.length + M < minTotal) others.push({ kind: "empty", n: k++ });
  const list = [];
  let mi = 0, oi = 0;
  for (let pos = 0; oi < others.length || mi < M; pos++) {
    const mineHere = mi < M && pos >= offset && (pos - offset) % every === 0;
    if (mineHere || oi >= others.length) list.push({ kind: "mine", m: state.mine[mi++] });
    else list.push(others[oi++]);
  }
  while (list.length % rowLen) list.push({ kind: "empty", n: k++ });
  return list;
}
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }
function textEl(tag, cls, text) { const e = document.createElement(tag); e.className = cls; e.textContent = text; return e; }
function tileEl(item, index, dev) {
  const r = rand((item.kind === "mine" ? 1e5 + item.m.id : item.kind === "other" ? 2e5 + item.o.id : 3e5 + item.n) + state.seed * 31);
  const tile = el("div", "tile" + (item.kind === "mine" ? " mine" : ""));
  const thumb = el("div", "thumb");
  let title, chan, meta, dur;
  if (item.kind === "mine") {
    const img = document.createElement("img"); img.src = item.m.url; img.alt = ""; thumb.append(img);
    title = item.m.title || "Untitled video"; chan = state.channel || "Your channel"; meta = "No views · Just now"; dur = item.m.duration;
  } else if (item.kind === "other") {
    const img = document.createElement("img"); img.src = item.o.url; img.alt = ""; img.loading = "lazy"; thumb.append(img);
    title = item.o.title || "Another video in the feed, with a title long enough to need two lines";
    chan = "Another channel"; meta = `${viewsText(r)} · ${AGES[Math.floor(r * AGES.length)]}`; dur = DURS[Math.floor(rand(r * 1e6) * DURS.length)];
  } else {
    thumb.classList.add("empty"); thumb.textContent = index < 8 ? "Add other thumbnails to fill the feed" : "";
    title = "Other video"; chan = "Another channel"; meta = `${viewsText(r)} · ${AGES[Math.floor(r * AGES.length)]}`; dur = null;
    tile.style.opacity = "0.7";
  }
  if (dur) thumb.append(textEl("span", "dur", dur));
  thumb.append(el("span", "ico idle", `<i>${SVG.clock}</i><i>${SVG.queue}</i>`));
  thumb.append(el("span", "ico play", `<i>${SVG.mute}</i><i>${SVG.cc}</i>`));
  thumb.append(el("span", "scrub")); thumb.append(el("span", "watched"));
  const info = el("div", "info"), txt = el("div", "txt");
  txt.append(textEl("p", "f-title", title));
  if (dev === "phone") txt.append(textEl("p", "f-meta", `${chan} · ${meta}`)); // the phone app puts it all on one line
  else txt.append(textEl("p", "f-meta", chan), textEl("p", "f-meta", meta));
  txt.append(el("span", "kebab", SVG.kebab));
  info.append(el("div", "avatar"), txt);
  tile.append(thumb, info);
  return tile;
}
function shelfEl(count) {
  const s = el("div", "shelf");
  const h = el("h3"); h.append(el("i"), document.createTextNode("Shorts")); s.append(h);
  const row = el("div", "shorts"); row.style.setProperty("--shorts", String(count));
  for (let i = 0; i < count; i++) { const c = el("div", "short"); c.append(el("div", "v"), el("div", "t"), el("div", "t s")); row.append(c); }
  s.append(row);
  return s;
}
// fill a container with tiles, dropping the Shorts shelf in after `shelfAt` videos
function fillList(host, list, dev, shelfAt, shelfCount) {
  list.forEach((item, i) => {
    if (state.shorts && i === shelfAt) host.append(shelfEl(shelfCount));
    host.append(tileEl(item, i, dev));
  });
  if (!state.mine.length) host.prepend(textEl("p", "empty-hint", "Add one of your thumbnails at the top to see it in the feed."));
}
const CHIPS = ["All", "Gaming", "Old School RuneScape", "Ambient music", "Podcasts", "Live", "Relaxation", "Recently uploaded", "New to you"];
function appBar() {
  const bar = el("div", "appbar");
  bar.append(el("div", "status", "<span>22:41</span><b><i></i><i></i></b>"));
  bar.append(el("div", "topbar", '<span class="brand"></span><i></i><i></i><i></i>'));
  const chips = el("div", "chips"); CHIPS.forEach((c) => chips.append(textEl("span", "", c))); bar.append(chips);
  return bar;
}
const navBar = () => el("div", "navbar", "<i></i><i></i><i></i><i></i><i></i>");

function renderPC() {
  const grid = $("grid"); grid.innerHTML = ""; grid.style.setProperty("--cols", String(state.cols));
  fillList(grid, feedList(state.cols), "pc", state.cols * 2, state.cols + 1);
}
function renderTablet() {
  const port = state.orient === "port", cols = port ? 2 : 3;
  const scr = $("tabletScreen"); scr.innerHTML = "";
  scr.style.width = port ? "820px" : "1180px"; scr.style.height = port ? "1180px" : "820px";
  $("tabletOuter").dataset.w = port ? "848" : "1208"; $("tabletOuter").dataset.h = port ? "1208" : "848";
  const grid = el("div", "tgrid"); grid.style.setProperty("--tcols", String(cols));
  fillList(grid, feedList(cols), "tablet", cols * 2, cols + 2);
  scr.append(appBar(), grid, navBar());
  scr.scrollTop = 0;
}
function renderPhone() {
  const scr = $("phoneScreen"); scr.innerHTML = "";
  const list = el("div", "plist");
  fillList(list, feedList(1), "phone", 2, 3);
  scr.append(appBar(), list, navBar());
  scr.scrollTop = 0;
}
function renderTV() {
  const scr = $("tvScreen"); scr.innerHTML = "";
  const app = el("div", "tvapp");
  app.append(el("div", "rail", "<i></i><i></i><i></i><i></i><i></i>"));
  const main = el("div", "tvmain"), scroll = el("div", "tvscroll"); scroll.id = "tvScroll";
  const chips = el("div", "tvchips"); ["All", "Gaming", "Music", "Live", "Relaxation", "Podcasts"].forEach((c) => chips.append(textEl("span", "", c)));
  const grid = el("div", "tvgrid"); grid.id = "tvGrid";
  fillList(grid, feedList(4), "tv", 8, 6);
  scroll.append(chips, grid); main.append(scroll); app.append(main); scr.append(app);
  tvTiles = Array.from(grid.querySelectorAll(".tile"));
  setTvFocus(Math.min(tvFocus, tvTiles.length - 1), true);
}

function renderFeed() {
  clearPreview();
  document.querySelectorAll(".feed").forEach((f) => {
    f.dataset.yt = f.id === "tvScreen" ? "dark" : state.yt; // the TV app has no light mode
    [["mark-mine", state.mark], ["show-bar", state.bar], ["gray", state.gray], ["blur", state.blur]].forEach(([c, on]) => f.classList.toggle(c, on));
  });
  ({ pc: renderPC, tablet: renderTablet, phone: renderPhone, tv: renderTV })[state.dev]();
  fitDevices();
  if (state.dev === "phone" || state.dev === "tablet") requestAnimationFrame(pickCenter);
}
function renderAll() { renderCards(); renderPile(); renderFeed(); }

/* ---------- device frames: native size, scaled down to fit the page ---------- */
function fitDevices() {
  document.querySelectorAll(".bay:not([hidden]) .device-outer").forEach((outer) => {
    const w = Number(outer.dataset.w), h = Number(outer.dataset.h);
    const avail = outer.parentElement.clientWidth;
    const s = Math.min(1, avail / w);
    outer.style.width = `${w * s}px`; outer.style.height = `${h * s}px`;
    outer.firstElementChild.style.transform = `scale(${s})`;
  });
}
new ResizeObserver(fitDevices).observe(document.querySelector(".wrap"));

/* ---------- previews: one playing video at a time, whatever the device ---------- */
let previewTile = null, previewRaf = 0, previewTimer = null;
function startPreview(tile, delay) {
  if (previewTile === tile) return;
  clearPreview();
  if (!state.preview || !tile || !tile.querySelector("img")) return;
  previewTile = tile;
  previewTimer = setTimeout(() => {
    if (previewTile !== tile) return;
    tile.classList.add("preview");
    const start = performance.now(), bar = tile.querySelector(".scrub");
    const step = (now) => { if (previewTile !== tile) return; bar.style.setProperty("--p", `${Math.min(100, ((now - start) / 30000) * 100)}%`); previewRaf = requestAnimationFrame(step); };
    previewRaf = requestAnimationFrame(step);
  }, delay);
}
function clearPreview() {
  clearTimeout(previewTimer); cancelAnimationFrame(previewRaf);
  if (previewTile) { previewTile.classList.remove("preview"); previewTile.querySelector(".scrub")?.style.setProperty("--p", "0%"); }
  previewTile = null;
}

// PC: pointer on a video shows the watch-later and queue buttons and the menu dots at once.
// Rest there about a second and the site starts a muted preview: corners square off, the
// length badge gives way to a progress bar, and mute and captions buttons take over.
let hoverTile = null;
$("grid").addEventListener("mouseover", (e) => {
  const tile = e.target.closest(".tile");
  if (tile === hoverTile) return;
  if (hoverTile) hoverTile.classList.remove("hover");
  hoverTile = tile;
  if (!tile) { clearPreview(); return; }
  tile.classList.add("hover");
  startPreview(tile, 1000);
});
$("grid").addEventListener("mouseleave", () => { if (hoverTile) hoverTile.classList.remove("hover"); hoverTile = null; clearPreview(); });

// Phone and tablet: no hover. With playback in feeds on, the video sitting in the
// middle of the screen plays muted while you scroll.
let centerQueued = false;
function pickCenter() {
  centerQueued = false;
  const scr = state.dev === "phone" ? $("phoneScreen") : state.dev === "tablet" ? $("tabletScreen") : null;
  if (!scr) return;
  const box = scr.getBoundingClientRect(), mid = box.top + box.height / 2;
  let best = null, bestD = Infinity;
  scr.querySelectorAll(".tile").forEach((t) => {
    const r = t.querySelector(".thumb").getBoundingClientRect();
    if (r.top < box.top || r.bottom > box.bottom) return; // only fully visible videos play
    const d = Math.abs((r.top + r.bottom) / 2 - mid);
    if (d < bestD) { bestD = d; best = t; }
  });
  if (best) startPreview(best, 600); else clearPreview();
}
["phoneScreen", "tabletScreen"].forEach((id) => $(id).addEventListener("scroll", () => { if (!centerQueued) { centerQueued = true; requestAnimationFrame(pickCenter); } }, { passive: true }));

// TV: a remote moves a focus highlight around the grid; resting on a video previews it.
let tvTiles = [], tvFocus = 0;
function setTvFocus(i, instant) {
  if (!tvTiles.length) return;
  tvFocus = Math.max(0, Math.min(tvTiles.length - 1, i));
  tvTiles.forEach((t, k) => t.classList.toggle("focus", k === tvFocus));
  const t = tvTiles[tvFocus], scroll = $("tvScroll");
  const y = Math.max(0, t.offsetTop - 200);
  scroll.style.transition = instant ? "none" : "";
  scroll.style.transform = `translateY(${-y}px)`;
  startPreview(t, 1500);
}
document.addEventListener("keydown", (e) => {
  if (state.dev !== "tv" || (e.target.closest && e.target.closest("input, select, textarea"))) return;
  const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -4, ArrowDown: 4 };
  if (!(e.key in moves)) return;
  e.preventDefault();
  setTvFocus(tvFocus + moves[e.key]);
});
$("tvScreen").addEventListener("mouseover", (e) => {
  const t = e.target.closest(".tile"); const i = tvTiles.indexOf(t);
  if (i >= 0 && i !== tvFocus) setTvFocus(i);
});

/* ---------- controls ---------- */
const PREVIEW_LABEL = { pc: "Preview on hover", tablet: "Preview in feed", phone: "Preview in feed", tv: "Preview on focus" };
function setDev(dev) {
  state.dev = dev;
  document.querySelectorAll(".tabs [role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.dev === dev)));
  ["pc", "tablet", "phone", "tv"].forEach((d) => ($(`stage-${d}`).hidden = d !== dev));
  document.querySelectorAll(".toolbar [data-for]").forEach((g) => (g.hidden = g.dataset.for !== dev));
  document.querySelectorAll("#themeSeg button").forEach((b) => (b.disabled = dev === "tv"));
  $("previewLabel").textContent = PREVIEW_LABEL[dev];
  renderFeed(); save();
}
document.querySelectorAll(".tabs [role=tab]").forEach((b) => b.addEventListener("click", () => setDev(b.dataset.dev)));
function setYt(v) { state.yt = v; $("ytDark").setAttribute("aria-pressed", String(v === "dark")); $("ytLight").setAttribute("aria-pressed", String(v === "light")); renderFeed(); save(); }
$("ytDark").addEventListener("click", () => setYt("dark"));
$("ytLight").addEventListener("click", () => setYt("light"));
function setCols(c) { state.cols = c; document.querySelectorAll("#colsSeg button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.c) === c))); renderFeed(); save(); }
document.querySelectorAll("#colsSeg button").forEach((b) => b.addEventListener("click", () => setCols(Number(b.dataset.c))));
function setOrient(o) { state.orient = o; document.querySelectorAll("#orientSeg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.o === o))); renderFeed(); save(); }
document.querySelectorAll("#orientSeg button").forEach((b) => b.addEventListener("click", () => setOrient(b.dataset.o)));
$("every").addEventListener("input", (e) => { const v = Math.round(Number(e.target.value)); if (v >= 2 && v <= 40) { state.every = v; renderFeed(); save(); } });
$("channel").addEventListener("input", (e) => { state.channel = e.target.value; renderFeed(); save(); });
const TOGGLES = [["tPreview", "preview"], ["tShorts", "shorts"], ["tMark", "mark"], ["tBar", "bar"], ["tGray", "gray"], ["tBlur", "blur"]];
TOGGLES.forEach(([id, key]) => $(id).addEventListener("change", (e) => { state[key] = e.target.checked; renderFeed(); save(); }));
$("shuffleBtn").addEventListener("click", () => { state.seed = 1 + Math.floor(Math.random() * 1e6); renderFeed(); });
$("resetBtn").addEventListener("click", () => { loadExamples(); renderAll(); save(); });
$("addInput").addEventListener("change", (e) => { addMine(e.target.files); e.target.value = ""; });
$("swapInput").addEventListener("change", (e) => { const f = imagesOf(e.target.files)[0]; if (f && swapTarget) replaceImage(swapTarget, f); e.target.value = ""; swapTarget = null; });
$("addOther").addEventListener("click", () => $("otherInput").click());
$("otherInput").addEventListener("change", (e) => { addOthers(e.target.files); e.target.value = ""; });
$("clearOthers").addEventListener("click", () => { state.others.forEach((o) => URL.revokeObjectURL(o.url)); state.others = []; renderAll(); save(); });
const op = $("othersPanel");
op.addEventListener("dragover", (e) => { e.preventDefault(); op.classList.add("over"); });
op.addEventListener("dragleave", (e) => { if (!op.contains(e.relatedTarget)) op.classList.remove("over"); });
op.addEventListener("drop", (e) => { e.preventDefault(); op.classList.remove("over"); addOthers(e.dataTransfer.files); });
// images dropped onto any feed count as other videos too
document.querySelectorAll("[role=tabpanel]").forEach((p) => {
  p.addEventListener("dragover", (e) => e.preventDefault());
  p.addEventListener("drop", (e) => { e.preventDefault(); addOthers(e.dataTransfer.files); });
});
// paste: adds to yours; hold Shift while pasting to add to other videos
let shiftDown = false;
document.addEventListener("keydown", (e) => { if (e.key === "Shift") shiftDown = true; });
document.addEventListener("keyup", (e) => { if (e.key === "Shift") shiftDown = false; });
document.addEventListener("paste", (e) => {
  if (e.target.closest && e.target.closest("input")) return;
  const files = imagesOf(e.clipboardData?.files);
  if (files.length) { e.preventDefault(); shiftDown ? addOthers(files) : addMine(files); }
});

/* ---------- folders ---------- */
// Chrome and Edge (in a normal tab) can watch a folder: every image saved there shows up,
// changed files swap in place, deleted ones disappear. Elsewhere, including inside Claude,
// the folder is read once and can be read again with one click.
const IMG_RE = /\.(png|jpe?g|webp|gif|avif)$/i;
const canWatch = (() => { try { return typeof window.showDirectoryPicker === "function" && window.self === window.top; } catch { return false; } })();
const folders = { mine: null, others: null }; // { mode: "watch" | "once" | "reconnect", name, handle, timer, busy }
const listOf = (kind) => (kind === "mine" ? state.mine : state.others);
async function copyFile(f) { // a snapshot, so later edits to the file on disk can't break the image
  return new File([await f.arrayBuffer()], f.name, { type: f.type || "image/png", lastModified: f.lastModified });
}
async function syncFolder(kind, files) {
  files = files.filter((f) => IMG_RE.test(f.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  let list = listOf(kind), changed = false;
  if (kind === "mine" && list.some((m) => m.example)) { list.filter((m) => m.example).forEach((m) => URL.revokeObjectURL(m.url)); list = list.filter((m) => !m.example); changed = true; }
  const byName = new Map(list.filter((x) => x.folder).map((x) => [x.file, x])), seen = new Set();
  for (const f of files) {
    seen.add(f.name);
    const it = byName.get(f.name);
    if (it && it.mod === f.lastModified && it.size === f.size) continue;
    let copy; try { copy = await copyFile(f); } catch { continue; } // mid-save: try again next round
    if (it) { URL.revokeObjectURL(it.url); it.blob = copy; it.url = URL.createObjectURL(copy); it.mod = f.lastModified; it.size = f.size; }
    else list.push(makeItem(copy, { file: f.name, mod: f.lastModified, size: f.size, folder: true, title: titleFromFile(f.name) || (kind === "mine" ? "Untitled video" : null), ...(kind === "mine" ? { duration: "2:30:00" } : {}) }));
    changed = true;
  }
  const gone = list.filter((x) => x.folder && !seen.has(x.file));
  if (gone.length) { gone.forEach((x) => URL.revokeObjectURL(x.url)); list = list.filter((x) => !gone.includes(x)); changed = true; }
  if (kind === "mine") state.mine = list; else state.others = list;
  if (changed) { renderAll(); save(); }
  updateFolderUI(kind);
}
async function scanHandle(kind) {
  const fo = folders[kind]; if (!fo || fo.mode !== "watch" || fo.busy || document.hidden) return;
  fo.busy = true;
  try {
    const files = [];
    for await (const [name, entry] of fo.handle.entries()) if (entry.kind === "file" && IMG_RE.test(name)) files.push(await entry.getFile());
    await syncFolder(kind, files);
  } catch { // permission gone or folder moved
    stopWatch(kind); folders[kind] = { mode: "reconnect", name: fo.name, handle: fo.handle }; updateFolderUI(kind);
  } finally { if (folders[kind] === fo) fo.busy = false; }
}
async function startWatch(kind, handle) {
  stopWatch(kind);
  folders[kind] = { mode: "watch", name: handle.name, handle, busy: false };
  await scanHandle(kind);
  if (folders[kind] && folders[kind].mode === "watch") folders[kind].timer = setInterval(() => scanHandle(kind), 1200);
  updateFolderUI(kind);
}
function stopWatch(kind) { const fo = folders[kind]; if (fo && fo.timer) clearInterval(fo.timer); }
async function chooseFolder(kind) {
  if (!canWatch) { $(`${kind}Dir`).click(); return; }
  let handle;
  try { handle = await window.showDirectoryPicker({ id: `bench-${kind}`, mode: "read" }); } catch { return; } // cancelled
  try { await store.set(`dir-${kind}`, handle); } catch { /* remembered for this visit only */ }
  startWatch(kind, handle);
}
function forgetFolder(kind) {
  stopWatch(kind); folders[kind] = null;
  listOf(kind).forEach((x) => (x.folder = false)); // the images stay, they just stop following the folder
  store.set(`dir-${kind}`, null).catch(() => {});
  save(); updateFolderUI(kind);
}
function updateFolderUI(kind) {
  const box = $(`${kind}Folder`), fo = folders[kind];
  box.hidden = !fo; box.innerHTML = "";
  $(`${kind}FolderBtn`).textContent = fo && fo.mode !== "reconnect" ? "Change folder" : "Use a folder";
  if (!fo) return;
  const n = listOf(kind).filter((x) => x.folder).length, dot = document.createElement("span"), txt = document.createElement("span"), b = document.createElement("b");
  dot.className = "dot" + (fo.mode === "watch" ? "" : " off"); b.textContent = fo.name;
  const btn = document.createElement("button"); btn.type = "button"; btn.className = "mini";
  if (fo.mode === "watch") {
    txt.append("Watching ", b, ` · ${n} image${n === 1 ? "" : "s"} · new and changed exports show up by themselves`);
    btn.textContent = "Stop watching"; btn.addEventListener("click", () => forgetFolder(kind));
  } else if (fo.mode === "once") {
    txt.append("Loaded from ", b, ` · ${n} image${n === 1 ? "" : "s"} · this browser can't watch folders here, so load it again after changes`);
    btn.textContent = "Load again"; btn.addEventListener("click", () => $(`${kind}Dir`).click());
  } else {
    txt.append("Folder ", b, " needs your OK again before the bench can read it");
    btn.textContent = "Reconnect"; btn.className = "mini primary";
    btn.addEventListener("click", async () => { try { if ((await fo.handle.requestPermission({ mode: "read" })) === "granted") startWatch(kind, fo.handle); } catch { /* still no access */ } });
  }
  box.append(dot, txt, btn);
}
["mine", "others"].forEach((kind) => {
  $(`${kind}FolderBtn`).addEventListener("click", () => chooseFolder(kind));
  $(`${kind}Dir`).addEventListener("change", (e) => {
    const files = Array.from(e.target.files || []).filter((f) => (f.webkitRelativePath || f.name).split("/").length <= 2); // top level only
    e.target.value = "";
    if (!files.length) return;
    folders[kind] = { mode: "once", name: (files[0].webkitRelativePath || "").split("/")[0] || "folder" };
    syncFolder(kind, files);
  });
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) ["mine", "others"].forEach(scanHandle); });
async function restoreFolders() {
  if (!canWatch) return;
  for (const kind of ["mine", "others"]) {
    try {
      const h = await store.get(`dir-${kind}`); if (!h) continue;
      if ((await h.queryPermission({ mode: "read" })) === "granted") await startWatch(kind, h);
      else { folders[kind] = { mode: "reconnect", name: h.name, handle: h }; updateFolderUI(kind); }
    } catch { /* stored folder unusable: skip */ }
  }
}

/* ---------- start ---------- */
function syncControls() {
  $("channel").value = state.channel; $("every").value = state.every;
  TOGGLES.forEach(([id, key]) => ($(id).checked = !!state[key]));
  $("ytDark").setAttribute("aria-pressed", String(state.yt === "dark")); $("ytLight").setAttribute("aria-pressed", String(state.yt === "light"));
  document.querySelectorAll("#colsSeg button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.c) === state.cols)));
  document.querySelectorAll("#orientSeg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.o === state.orient)));
}
loadExamples(); syncControls(); renderCards(); renderPile(); setDev(state.dev);
(async () => {
  try {
    const saved = (await store.get("state-v2")) || (await store.get("state"));
    if (!saved) return;
    state.mine.forEach((m) => URL.revokeObjectURL(m.url));
    const keep = (x) => ({ file: x.file, mod: x.mod, size: x.size, folder: !!x.folder });
    state.mine = (saved.mine || []).filter((m) => m.blob).map((m) => makeItem(m.blob, { title: m.title, duration: m.duration, ...keep(m) }));
    state.others = (saved.others || []).filter((o) => o.blob).map((o) => makeItem(o.blob, { title: o.title || (o.blob.name ? titleFromFile(o.blob.name) : null), ...keep(o) }));
    SETTINGS.forEach((k) => { if (saved[k] !== undefined) state[k] = saved[k]; });
    if (![3, 4, 5].includes(state.cols)) state.cols = 4;
    if (!["pc", "tablet", "phone", "tv"].includes(state.dev)) state.dev = "pc";
    if (state.orient !== "port") state.orient = "land";
    syncControls(); renderCards(); renderPile(); setDev(state.dev);
  } catch { /* no storage here: start from the examples */ }
})().then(restoreFolders);
