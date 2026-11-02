# Raccoon · OSRS YouTube Tools

Free browser tools for making Old School RuneScape videos. Everything runs in the browser: nothing you load is uploaded anywhere.

- **Photo Booth** (`photo-booth/`): load models exported from the Creator's Kit RuneLite plugin, pose one or two of them (each with its own animation), and save transparent PNGs, PNG sequences for Premiere, or looping GIFs.
- **Thumbnail Bench** (`thumbnail-bench/`): see your thumbnails mixed into a realistic YouTube feed on PC, tablet, phone and TV, next to other channels' videos. In Chrome or Edge it can watch your export folder and pick up new versions as you save them.

## Structure

```
index.html              landing page
assets/
  site.css              shared colours, type, navigation and landing styles
  raccoon.svg           logo and favicon
  hero-scene.png        landing page art (rendered from the sample models)
  turntable.png
  vendor/               three.js r128 and JSZip 3.10.1, so the site needs no outside CDN
photo-booth/
  index.html  booth.css  booth.js
  loader.js             loads the sample models, then starts booth.js
  samples/              the two example models shown on first open
thumbnail-bench/
  index.html  bench.css  bench.js
```

## Running it locally

The Photo Booth fetches its sample models, which browsers block on `file://` pages. Serve the folder instead:

```
python -m http.server 8000
```

then open http://localhost:8000. Opened straight from disk, the Photo Booth still works but starts without the examples.

## Hosting

It's a static site. On GitHub: Settings → Pages → Deploy from a branch → `main`, folder `/ (root)`.

## Credits

- [three.js](https://threejs.org) (MIT) for the 3D rendering, and [JSZip](https://stuk.github.io/jszip/) (MIT or GPLv3) for the zip downloads.
- Models come from the game through the [Creator's Kit](https://github.com/ScreteMonge) plugin by ScreteMonge.

Not affiliated with Jagex. Old School RuneScape is a trademark of Jagex Ltd.
