// Loads the two example models, then starts the Photo Booth.
// Opened straight from disk (file://) the browser blocks these requests, and the tool starts empty.
(async () => {
  const get = async (url) => {
    try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch { return null; }
  };
  const [a, b] = await Promise.all([get("samples/local-player.json"), get("samples/archive-guardian.json")]);
  window.BOOTH_SAMPLES = { a, b };
  const s = document.createElement("script");
  s.src = "booth.js";
  document.body.append(s);
})();
