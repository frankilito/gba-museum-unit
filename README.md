# GBA · Museum Unit

A museum-scale 3D Game Boy Advance that runs real GBA ROMs in the browser.
The console is a high-fidelity AGB-001 model in a photo studio; cartridges
live in a zip pouch — drag one into the slot and it boots on a real mGBA
WASM core. No build step beyond Vite, no runtime CDN, no telemetry.

**Unofficial interactive experiment. Not affiliated with, endorsed by, or
sponsored by Nintendo.** “Game Boy Advance” is a trademark of its respective
owner. No commercial ROMs or BIOS are bundled; commercial titles can only be
played from a local backup you import yourself — files never leave your
browser.

## Live

**https://deploymeum-unit-dekongzezm.cn-beijing-vpc.fcapp.run**

Deployed as a static bundle (`dist/`) via the internal deploy service
(配方 B). First visit may show a LOADING chip while the 8 MB GLB downloads —
the camera refits once the model is ready. To redeploy after changes:
`npm run build`, zip `dist/`, POST to the deploy API (see project history in
INTEGRATION-PROGRESS.md).

## Run

```sh
./start.sh         # one-command launcher: install/build if needed, serve dist/, open browser
./start.sh status  # check state
./start.sh stop    # stop our server (and ONLY ours)
```

The launcher serves the production build at **http://127.0.0.1:7391/** — a
dedicated port declared in `./PORT` (never a vite default; `strictPort`, and
it refuses to start if a foreign process holds the port rather than hopping).
It only ever manages its own pidfile (`.runtime/preview.pid`) and never kills
processes by name pattern, so it cannot disturb other servers on this machine.

Manual workflow:

```sh
npm install
npm run dev        # http://127.0.0.1:5180 (COOP/COEP headers required for mGBA threads)
npm run build      # tsc --noEmit && vite build
npm run preview    # serves dist/ on :5181 with the same isolation headers
node tests/e2e.mjs # full acceptance suite (Chromium + vite preview, ~3 min)
node tests/slowload.mjs # slow-network first-paint framing check (delayed GLB, 3 viewports)
node tests/mobile-grip.mjs # iPhone viewport grip-mode suite (portrait hint + landscape immersion)
node tests/mobile-insert.mjs # iPhone portrait CDP touch drag-insert (depth-gap magnetic snap)
```

Controls: arrows/WASD = D-pad · K/J = A/B · Q/E = L/R · Enter = Start ·
Shift = Select (rebindable in ⚙ Settings). Or click the physical buttons on
the model. Drag carts with the mouse; drag the inserted cart upward to eject.

Mobile: in portrait the cartridge pouch sits in front of the device — a
touch drag on a cart pulls it toward the slot with a magnetic snap once your
finger nears the slot on screen. While playing in portrait a small hint
suggests rotating the phone.
Held sideways, the view becomes an immersive **grip mode** — the device face
fills the screen width with the LCD centered, the D-pad and A/B under your
thumbs, and the cartridge pouch parked out of frame. Tap the physical 3D
buttons to play, drag the exposed cartridge upward to eject (returns to the
normal layout), or use the small EXIT GRIP chip in the corner. On Android the
app may also try to lock the landscape orientation from a tap; if the browser
refuses (or on iOS, where the API doesn't exist) nothing breaks — the
rotate hint remains the fallback.

Top bar: **SAVE / LOAD** — manual save-state snapshots of the running game
(one per ROM, keyed by content hash in IndexedDB; enabled only while playing,
and the toast says so honestly when a core can't snapshot or no state exists).
**CARTS** — manage the two upload slots: pick or replace a .gba in either
slot, or clear a slot back to blank (unreferenced ROM bytes are evicted from
IndexedDB). In-game SRAM saves are written automatically on eject and when the
game writes its save memory.

## Credits & licensing

### 3D console model (CC-BY-4.0)

This work is based on **"Gameboy Advance - Zelda Concept" by yassineCGI**,
licensed under **CC-BY-4.0**.

- Source page: <https://sketchfab.com/3d-models/gameboy-advance-zelda-concept-2c77feea6c1a42d0b20adea68d09b756>
- Downloaded: **2026-07-13** via the author's official Sketchfab download
- Original format: **FBX + 4K PBR textures** (30,949 tris / 21,075 verts;
  BaseColor / MetallicRoughness / Normal / Emissive atlas)
- License evidence (official archive `license.txt`, download-dialog screenshot)
  and the untouched source files are kept in `~/gba-assets/source/`.

**Adaptations applied** (full record in `~/gba-assets/ACCEPTANCE.md`):

1. Split the single mesh into named parts by topological island
   (shellFront / shellBack / shellMid / bezel / screen / dpad / btnA / btnB /
   btnStart / btnSelect / shoulderL / shoulderR / led / batteryCover / screws /
   linkPortCover / volumeWheel / bandDecals) — no vertices modified.
2. Repainted the 4K BaseColor atlas: removed all Zelda artwork and grime,
   resprayed the shell classic indigo, recolored A/B and Start/Select to
   stock hardware colors. Roughness/Normal atlases untouched.
3. Added the two small parts the source model lacked, per reference photos:
   the **power slider** (right edge) and the **volume wheel** (bottom edge) —
   the only non-scan geometry, as explicitly required by the task.
4. Separated the screen island for runtime material replacement: dark glass
   when off, fading backlight, and the 240×160 emulator CanvasTexture
   (NearestFilter, strict 3:2) on an LCD plane fitted to the molded LCD area.
5. Normalized: 144.5 mm wide, Y-up, screen facing +Z, origin at body center,
   exported as a single GLB (2K atlas). Part inventory with bounding boxes:
   `public/models/parts-map.json`.

**Commercial candidate not used:** warfalker's "Nintendo Game Boy Advance
Indigo 2001" (CGTrader #4518038) was the first choice but costs **$10 and
requires checkout** — it was not purchased without user authorization, and the
same author's Sketchfab copy is not downloadable. The yassineCGI model is the
only high-fidelity AGB-001 that is legally and freely obtainable with a
license that permits this use. If the commercial model is ever acquired it can
replace the GLB drop-in; the part-name/material/animation layer is unchanged.

### Emulator core

- **mGBA** © Jeffrey Pfau — MPL-2.0 · <https://mgba.io>
- WASM build **@thenick775/mgba-wasm 2.4.1** (MPL-2.0) from the
  [gbajs3](https://github.com/thenick775/gbajs3) project — vendored in
  `public/cores/`, no runtime CDN.

### Bundled homebrew cartridges (MIT License)

- **CASCADE7** — Mick Schroeder · <https://github.com/mick-schroeder/gba-cascade7>
- **GBArcade v0.1.4** — Emma Britton · <https://github.com/emmabritton/gba_gbarcade> ·
  <https://emmatothemax.itch.io/gbarcade>

The pouch holds these two presets plus two independent **LOAD YOUR ROM** slots
for your own backups. (The MIT-licensed
[Pong-Homebrew-GBA](https://github.com/ZeroDayArcade/Pong-Homebrew-GBA) ROM file
still ships in `public/roms/` — it is used by the test suite via the upload
path, but no longer occupies a preset slot.)

### Rendering & infrastructure

- three.js (MIT) — rendering; the cartridge pouch and cartridges are original
  procedural models.
- coi-serviceworker v0.1.7 (MIT) — cross-origin isolation on static hosts.
- All button / insert / power sounds are synthesized at runtime with WebAudio —
  original, no samples.

### Your ROMs

No commercial ROMs and no GBA BIOS are bundled or downloadable here. To play a
commercial title, use one of the two **LOAD YOUR ROM** slots and import a backup
you legally own — each slot keeps its own cartridge, and both are restored from
IndexedDB on your next visit. Imported files are read with the File API and
stored only in this browser's IndexedDB — never uploaded, analyzed, or
telemetered. This site collects no ROM data, filenames, saves, or input
telemetry.
