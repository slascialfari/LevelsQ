// LevelQ Proto — layered levels + HOME in carousel + HOME intro state machine
//
// Draw order (back -> front):
// 1) Background (REQUIRED)            [1:1, no zoom/pan]
// 2) Layer 1 (optional)               [image or frames; 1:1]
// 3) Hero (normal gameplay only)
// 4) Layer 2 (optional)
// 5) Layer 3 (optional)
// 6) Layer 4 (optional)
// 7) Foreground (optional; TRUE FG)   [zoom+pan follow; ONLY parallax layer]

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

const W = canvas.width;
const H = canvas.height;

// Logical floor (never drawn)
const FLOOR_Y = 600;

// =========================
// SPRITES (normal gameplay hero)
// =========================
const SPRITES = {
  idle: { folder: "assets/sprites/hero_idle", count: 27, fps: 6 },
  walk: { folder: "assets/sprites/hero_walk", count: 8, fps: 12 },
};

// -------- TWEAKABLE VISUAL CONSTANTS --------
const SPRITE_SCALE = 0.34;
const FEET_FUDGE_PX = 0;
const WALK_BOB_PX = 0; // 0 disables
const HOME_DROP_OFFSET_X = 40; // px → + right, - left
// -------------------------------------------

// -------- FOREGROUND PARALLAX ONLY --------
const FG_ZOOM = 1.02;
const FG_FOLLOW = 0.55;
const MAX_PAN_PX = 55;
// -------------------------------------------

const DEFAULT_LAYER_FPS = 12;

// =========================
// HOME AMBIENT AUDIO (NEW)
// =========================
const HOME_AUDIO = {
  // FIXED: "ome" -> "home"
  ambientSrc: "assets/audio/home_ambient.mp3",

  ambient: null,
  _fadeRaf: 0,

  init() {
    if (this.ambient) return;

    const a = new Audio(this.ambientSrc);
    a.preload = "auto";
    a.loop = true;
    a.volume = 0;           // start silent, fade in on Enter
    a.crossOrigin = "anonymous";
    this.ambient = a;
  },

  // Smooth volume ramp using rAF
  fadeTo(audio, targetVol, durationMs = 1000, { stopWhenZero = false } = {}) {
    if (!audio) return;

    // cancel any existing fade
    if (this._fadeRaf) cancelAnimationFrame(this._fadeRaf);

    const startVol = Number(audio.volume || 0);
    const target = Math.max(0, Math.min(1, Number(targetVol)));
    const dur = Math.max(1, Number(durationMs));
    const t0 = performance.now();

    const tick = (t) => {
      const u = Math.max(0, Math.min(1, (t - t0) / dur));
      // easeInOut (smooth)
      const eased = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      audio.volume = startVol + (target - startVol) * eased;

      if (u < 1) {
        this._fadeRaf = requestAnimationFrame(tick);
      } else {
        audio.volume = target;
        this._fadeRaf = 0;

        if (stopWhenZero && audio.volume <= 0.001) {
          try { audio.pause(); } catch (_) {}
        }
      }
    };

    this._fadeRaf = requestAnimationFrame(tick);
  },

  // Called on Enter (user gesture)
  async startAmbient({ target = 0.4, fadeMs = 1200 } = {}) {
    this.init();
    const a = this.ambient;
    if (!a) return;

    // If already playing, just fade up
    if (!a.paused) {
      this.fadeTo(a, target, fadeMs);
      return;
    }

    // Ensure volume is 0 before play, then fade in
    a.volume = 0;

    try {
      await a.play(); // should succeed because called from Enter gesture
      this.fadeTo(a, target, fadeMs);
    } catch (e) {
      // If blocked for any reason, fail silently (you still have radio later)
      console.warn("[HOME_AUDIO] Ambient play blocked:", e);
    }
  },

  // Called when leaving HOME phase 3 -> phase 5 (crossfade moment)
  stopAmbient({ fadeMs = 1200 } = {}) {
    this.init();
    const a = this.ambient;
    if (!a) return;
    this.fadeTo(a, 0, fadeMs, { stopWhenZero: true });
  },
};

// =========================
// HOME OVERLAY AUDIO (NEW)
// =========================
const HOME_OVERLAY = {
  // Put your overlay file here:
  // assets/audio/home_overlay.mp3
  src: "assets/audio/home_overlay.mp3",

  audio: null,

  init() {
    if (this.audio) return;

    const a = new Audio(this.src);
    a.preload = "auto";
    a.loop = false;
    a.volume = 1.0;
    a.crossOrigin = "anonymous";
    this.audio = a;
  },

  async playOnce({ volume = 1.0 } = {}) {
    this.init();
    const a = this.audio;
    if (!a) return;

    try {
      a.pause();
      a.currentTime = 0;
      a.volume = Math.max(0, Math.min(1, volume));
      await a.play();
    } catch (e) {
      console.warn("[HOME_OVERLAY] play blocked:", e);
    }
  },

  stop() {
    if (!this.audio) return;
    try {
      this.audio.pause();
      this.audio.currentTime = 0;
    } catch (_) {}
  },
};

// =========================
// RADIO
// =========================
const RADIO = {
  stations: [],
  index: 0,

  audio: null,

  // best-effort preload trackers
  preloads: [],

  // UI
  widgetEl: null,
  nameEl: null,
  statusEl: null,

  loaded: false,
  visible: false,

  // playback state
  warmStarted: false,   // stream started muted after user gesture
  liveEnabled: false,   // we unmuted/faded in
  switching: false,
  lastSwitchAt: 0,

  // widget placement
  _placedOnce: false,

  async loadStations() {
    try {
      const res = await fetch("data/radio.json", { cache: "no-store" });
      if (!res.ok) throw new Error(`Failed to fetch data/radio.json (${res.status})`);
      const json = await res.json();

      const list = Array.isArray(json?.stations) ? json.stations : [];
      this.stations = list
        .map((s) => ({
          name: String(s?.name || "").trim(),
          url: String(s?.url || "").trim(),
        }))
        .filter((s) => s.name && s.url);

      this.widgetEl = document.getElementById("radioWidget");
      this.nameEl = document.getElementById("radioStationName");
      this.statusEl = document.getElementById("radioStatus");

      // main audio element
      this.audio = new Audio();
      this.audio.preload = "none";
      this.audio.crossOrigin = "anonymous";
      this.audio.volume = 0;

      this.audio.addEventListener("playing", () => {
        this.setStatus(this.liveEnabled ? "Playing" : "Prebuffering…");
      });
      this.audio.addEventListener("waiting", () => {
        this.setStatus(this.liveEnabled ? "Buffering…" : "Prebuffering…");
      });
      this.audio.addEventListener("stalled", () => {
        this.setStatus("Stalled…");
      });
      this.audio.addEventListener("error", () => {
        this.setStatus("Error… trying next");
        this.tryNextStation(+1, { forcePlay: this.warmStarted || this.liveEnabled });
      });

      // best-effort preloads
      this.preloads = this.stations.map((st) => {
        const a = new Audio();
        a.preload = "auto";
        a.crossOrigin = "anonymous";
        a.src = st.url;
        try { a.load(); } catch (_) {}
        return { audio: a, ready: false, url: st.url };
      });
      this.preloads.forEach((p) => {
        p.audio.addEventListener("canplay", () => { p.ready = true; });
      });

      this.loaded = true;
      this.updateUI();
      this.setStatus("Ready");
    } catch (e) {
      console.warn("[RADIO] Failed to load stations:", e);
      this.loaded = false;
    }
  },

  // Place widget OUTSIDE the canvas, aligned with canvas top-right corner,
  // but offset to the RIGHT so it does not overlap the canvas.
  placeWidget() {
    if (!this.loaded || !this.widgetEl) return;

    const rect = canvas.getBoundingClientRect();
    const gap = 12;

    // Measure widget (needs to be display:block at least once to measure properly)
    const prevDisplay = this.widgetEl.style.display;
    if (!this.visible) this.widgetEl.style.display = "block";
    const wRect = this.widgetEl.getBoundingClientRect();
    if (!this.visible) this.widgetEl.style.display = prevDisplay || "none";

    // TARGET: above the canvas, right-aligned to canvas
    let left = rect.right - wRect.width - gap;
    let top = rect.top - wRect.height - gap;

    const ww = window.innerWidth;
    const wh = window.innerHeight;

    // Clamp horizontally inside viewport
    left = Math.max(8, Math.min(left, ww - wRect.width - 8));

    // If there is not enough space ABOVE the canvas, fallback to the RIGHT side (like before)
    if (top < 8) {
      top = rect.top + gap;         // align with top of canvas
      left = rect.right + gap;      // place to the right outside canvas

      // If no room on the right, place to the left outside canvas
      if (left + wRect.width > ww - 8) {
        left = rect.left - gap - wRect.width;
      }

      // Final clamp
      left = Math.max(8, Math.min(left, ww - wRect.width - 8));
      top = Math.max(8, Math.min(top, wh - wRect.height - 8));
    }

    // Normal clamp vertically (for the "above" placement)
    top = Math.max(8, Math.min(top, wh - wRect.height - 8));

    this.widgetEl.style.left = `${Math.round(left)}px`;
    this.widgetEl.style.top = `${Math.round(top)}px`;
    this._placedOnce = true;
  },

  ensureVisible() {
    if (!this.loaded || !this.widgetEl) return;
    if (!this.visible) {
      this.visible = true;
      this.widgetEl.style.display = "block";
    }
    // Place now (and keep updating on resize/scroll)
    this.placeWidget();
  },

  setStatus(text) {
    if (!this.loaded || !this.statusEl) return;
    this.statusEl.textContent = text;
  },

  updateUI() {
    if (!this.loaded || !this.nameEl) return;
    if (!this.stations.length) {
      this.nameEl.textContent = "No stations";
      return;
    }
    const s = this.stations[this.index];
    this.nameEl.textContent = s?.name || "—";
  },

  // Start stream early (muted) right after FIRST Enter press (user gesture).
  async warmUpFromGesture() {
    if (!this.loaded || !this.audio || !this.stations.length) return;
    if (this.warmStarted) return;

    // pick first “ready-looking” preload if any, else first in order
    const firstReadyIndex = this.preloads.findIndex((p) => p.ready);
    if (firstReadyIndex >= 0) this.index = firstReadyIndex;

    this.updateUI();
    this.setStatus("Prebuffering…");

    try {
      this.audio.pause();
      this.audio.src = this.stations[this.index].url;
      try { this.audio.load(); } catch (_) {}

      // start muted (volume 0) so it can buffer/play in background
      this.audio.muted = true;
      this.audio.volume = 0;

      await this.audio.play(); // should succeed because it's called on Enter gesture
      this.warmStarted = true;
      this.setStatus("Prebuffering…");
    } catch (e) {
      const msg = String(e?.name || e?.message || e);
      if (msg.includes("NotAllowedError")) {
        // In case Enter gesture wasn't considered (rare), we'll still try later
        this.setStatus("Warmup blocked");
      } else {
        this.setStatus("Warmup failed…");
        // try next quickly
        await this.tryNextStation(+1, { forcePlay: true });
      }
    }
  },

  // When you reach HOME idle (state 4), show widget and fade audio in.
  async goLive() {
    if (!this.loaded || !this.audio || !this.stations.length) return;

    this.ensureVisible();

    // If warmup never started, try starting now (may still work since Enter was used earlier)
    if (!this.warmStarted) {
      await this.warmUpFromGesture();
    }

    // If audio still isn't actually playing, force a play attempt
    if (this.audio.paused) {
      this.setStatus("Starting…");
      try {
        this.audio.muted = true;
        this.audio.volume = 0;
        await this.audio.play();
        this.warmStarted = true;
      } catch (e) {
        this.setStatus("Autoplay blocked (press Q/W)");
        return;
      }
    }

    // Fade in
    this.liveEnabled = true;
    this.audio.muted = false;
    this.setStatus("Playing");

    const target = 1.0;
    const step = 0.06;     // per tick
    const intervalMs = 60; // fade speed

    // start from current volume
    if (this.audio.volume < 0.01) this.audio.volume = 0;

    const fade = setInterval(() => {
      if (!this.audio) return clearInterval(fade);
      const v = this.audio.volume;
      if (v >= target - 0.02) {
        this.audio.volume = target;
        clearInterval(fade);
      } else {
        this.audio.volume = Math.min(target, v + step);
      }
    }, intervalMs);
  },

  async playIndexWithFastFail(i) {
    if (!this.loaded || !this.audio || !this.stations.length) return;

    this.index = ((i % this.stations.length) + this.stations.length) % this.stations.length;
    const station = this.stations[this.index];
    this.updateUI();

    try {
      this.audio.pause();
      this.audio.src = station.url;
      try { this.audio.load(); } catch (_) {}

      // keep current mute/volume policy (warm or live)
      const playPromise = this.audio.play();

      const fastFailMs = 1800;
      const fastFail = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), fastFailMs));
      await Promise.race([playPromise, fastFail]);

      this.setStatus(this.liveEnabled ? "Playing" : "Prebuffering…");
      this.warmStarted = true;
    } catch (e) {
      this.setStatus("Failed… trying next");
      await this.tryNextStation(+1, { forcePlay: true });
    }
  },

  async tryNextStation(direction, { forcePlay }) {
    if (!this.loaded || !this.stations.length) return;

    const now = performance.now();
    if (now - this.lastSwitchAt < 120) return;
    this.lastSwitchAt = now;

    const next = this.index + (direction >= 0 ? 1 : -1);
    this.index = ((next % this.stations.length) + this.stations.length) % this.stations.length;
    this.updateUI();

    if (forcePlay) {
      await this.playIndexWithFastFail(this.index);
      return;
    }

    if (this.audio) {
      this.audio.pause();
      this.audio.src = this.stations[this.index].url;
      try { this.audio.load(); } catch (_) {}
    }
    this.setStatus("Selected");
  },

  async switchByKey(direction) {
    if (!this.loaded || !this.stations.length) return;

    this.ensureVisible();

    // switching is a user gesture, so try play loudly if live, or keep muted if not live yet
    await this.tryNextStation(direction, { forcePlay: true });

    // if user is already in “live” phase, ensure unmuted
    if (this.liveEnabled && this.audio) {
      this.audio.muted = false;
      if (this.audio.volume < 0.2) this.audio.volume = 0.6;
      this.setStatus("Playing");
    }
  },
};

// keep widget aligned when page scrolls/resizes (important if you have centered layout)
window.addEventListener("resize", () => RADIO.placeWidget());
window.addEventListener("scroll", () => RADIO.placeWidget(), { passive: true });

// =========================

let levelData = [];
let heroIdleFrames = [];
let heroWalkFrames = [];

// levelAssets.get(level.id) => { bgImg, fgImg|null, l1|null, l2|null, l3|null, l4|null }
const levelAssets = new Map();

const state = {
  levelIndex: 0,
  transitioning: false,
  transitionUntil: 0,
  lastEdge: null,

  // Carousel stores LEVEL INDICES (not ids)
  carousel: [],
  carouselPos: 0,

  // Home index in levelData (or -1)
  homeIndex: -1,

  // Gameplay enabled only after HOME handoff
  gameplayEnabled: false,

  // Popup: has player left home at least once?
  hasLeftHome: false,
  // x where hero was originally dropped in (set on handoff)
  dropX: null,
  // prevent re-firing every frame while standing on the spot
  popupTriggeredThisReturn: false,
  // timestamp (performance.now()) when hero entered the current level
  levelEnteredAt: 0,
};

const player = {
  x: Math.floor(W / 2),
  speed: 90,
  visible: true,
  facing: 1,
  anim: "idle",
  frameIndex: 0,
  frameTimer: 0,
  renderW: 26,
  renderH: 56,
};

const input = {
  left: false,
  right: false,
  enter: false,
  enterPressedThisFrame: false,
  arrowPressedThisFrame: false,
};

// ----------------- INPUT -----------------
window.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") input.left = true;
  if (e.key === "ArrowRight") input.right = true;

  if (e.key === "Enter") {
    if (!input.enter) input.enterPressedThisFrame = true;
    input.enter = true;
  }

  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    input.arrowPressedThisFrame = true;
  }

  // Radio controls (Q/W)
  if (e.key === "q" || e.key === "Q") RADIO.switchByKey(-1);
  if (e.key === "w" || e.key === "W") RADIO.switchByKey(+1);
});

window.addEventListener("keyup", (e) => {
  if (e.key === "ArrowLeft") input.left = false;
  if (e.key === "ArrowRight") input.right = false;
  if (e.key === "Enter") input.enter = false;
});

// ---------- Helpers ----------
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function randInt(min, maxInclusive) {
  return Math.floor(Math.random() * (maxInclusive - min + 1)) + min;
}

function warnOnce(key, msg) {
  if (!warnOnce._seen) warnOnce._seen = new Set();
  if (warnOnce._seen.has(key)) return;
  warnOnce._seen.add(key);
  console.warn(msg);
}

function isHomeIndex(i) {
  return state.homeIndex !== -1 && i === state.homeIndex;
}

// ---------- Carousel helpers ----------
function nonHomeIndices() {
  const out = [];
  for (let i = 0; i < levelData.length; i++) {
    if (!isHomeIndex(i)) out.push(i);
  }
  return out;
}

function usedNonHomeCount() {
  return state.carousel.filter((i) => !isHomeIndex(i)).length;
}

function pickUnusedNonHomeLevelIndex() {
  const used = new Set(state.carousel);
  const pool = nonHomeIndices().filter((i) => !used.has(i));
  if (pool.length === 0) {
    const nonHome = nonHomeIndices();
    return nonHome[0] ?? 0;
  }
  return pool[randInt(0, pool.length - 1)];
}

function initCarouselWithHomeOrFallback() {
  if (state.homeIndex !== -1) {
    state.carousel = [state.homeIndex];
    state.carouselPos = 0;
    state.levelIndex = state.homeIndex;
    return;
  }

  const startIdx = randInt(0, levelData.length - 1);
  state.carousel = [startIdx];
  state.carouselPos = 0;
  state.levelIndex = startIdx;
}

function carouselMoveRight() {
  if (levelData.length <= 1) return state.levelIndex;

  const nonHome = nonHomeIndices();
  const allUsed = usedNonHomeCount() >= nonHome.length;

  if (allUsed) {
    state.carouselPos = (state.carouselPos + 1) % state.carousel.length;
    return state.carousel[state.carouselPos];
  }

  if (state.carouselPos < state.carousel.length - 1) {
    state.carouselPos += 1;
    return state.carousel[state.carouselPos];
  }

  const nextIdx = pickUnusedNonHomeLevelIndex();
  state.carousel.push(nextIdx);
  state.carouselPos = state.carousel.length - 1;
  return nextIdx;
}

function carouselMoveLeft() {
  if (levelData.length <= 1) return state.levelIndex;

  const nonHome = nonHomeIndices();
  const allUsed = usedNonHomeCount() >= nonHome.length;

  if (allUsed) {
    state.carouselPos =
      (state.carouselPos - 1 + state.carousel.length) % state.carousel.length;
    return state.carousel[state.carouselPos];
  }

  if (state.carouselPos > 0) {
    state.carouselPos -= 1;
    return state.carousel[state.carouselPos];
  }

  const prevIdx = pickUnusedNonHomeLevelIndex();
  state.carousel.unshift(prevIdx);
  state.carouselPos = 0;
  return prevIdx;
}

function setAnim(next) {
  if (player.anim === next) return;
  player.anim = next;
  player.frameIndex = 0;
  player.frameTimer = 0;
}

function getHeroNormalizedX() {
  const range = Math.max(1, W - player.renderW);
  const t = clamp(player.x / range, 0, 1);
  return t * 2 - 1;
}

function drawZoomPanFollow(img, zoom, followStrength) {
  if (!img) return;

  const drawW = W * zoom;
  const drawH = H * zoom;

  const maxFromZoom = (drawW - W) / 2;
  const maxPan = Math.min(maxFromZoom, MAX_PAN_PX);

  const heroN = getHeroNormalizedX();
  const pan = clamp(heroN * maxPan * clamp(followStrength, 0, 1), -maxPan, maxPan);

  const x = -(drawW - W) / 2 + pan;
  const y = -(drawH - H) / 2;

  ctx.drawImage(img, x, y, drawW, drawH);
}

// ---------- Loaders ----------
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.src = src;
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
  });
}

function loadFrameSequenceCounted(folder, count) {
  const frames = [];
  const promises = [];

  for (let i = 1; i <= count; i++) {
    const n = String(i).padStart(2, "0");
    const img = new Image();
    img.src = `${folder}/frame_${n}.png`;
    frames.push(img);

    promises.push(
      new Promise((res, rej) => {
        img.onload = res;
        img.onerror = () => rej(new Error(`Failed to load ${img.src}`));
      })
    );
  }

  return Promise.all(promises).then(() => frames);
}

// ---------- Legacy layer loader (HOME level only) ----------
async function loadOptionalLayer(levelId, layerSpec, layerName) {
  if (!layerSpec) return null;
  const type = String(layerSpec.type || "frames").toLowerCase();
  const align = String(layerSpec.align || "screen").toLowerCase();
  const safeAlign = align === "bg" ? "bg" : "screen";

  if (type === "image") {
    const src = layerSpec.src;
    if (!src) { warnOnce(`${levelId}:${layerName}:missingSrc`, `[${levelId}] ${layerName} type=image missing "src".`); return null; }
    try {
      const img = await loadImage(src);
      return { kind: "image", img, align: safeAlign };
    } catch (e) {
      warnOnce(`${levelId}:${layerName}:loadFail`, `[${levelId}] ${layerName} image failed. (${e.message})`);
      return null;
    }
  }

  if (type === "frames") {
    const count = Number(layerSpec.count || 0);
    const folder = layerSpec.folder;
    const fps = Number(layerSpec.fps || DEFAULT_LAYER_FPS);
    if (!count || !folder) { warnOnce(`${levelId}:${layerName}:missing`, `[${levelId}] ${layerName} missing count/folder.`); return null; }
    try {
      const frames = await loadFrameSequenceCounted(folder, count);
      return { kind: "frames", frames, fps, timer: 0, frameIndex: 0, align: safeAlign };
    } catch (e) {
      warnOnce(`${levelId}:${layerName}:loadFail`, `[${levelId}] ${layerName} frames failed. (${e.message})`);
      return null;
    }
  }
  return null;
}

// ---------- New overlay/underlay loader (spec-driven from levels.json) ----------

// Load a single layer from a spec entry in levels.json.
// spec = { folder, type, rendering?, fps?, count?, parallax?, startMs?, ... }
async function loadLayerFromSpec(levelId, spec) {
  if (!spec?.folder) return null;

  const base = `assets/levels/${levelId}/${spec.folder}`;
  const type = String(spec.type || "frames").toLowerCase();
  const rendering = String(spec.rendering || "loop").toLowerCase();
  const parallax = Boolean(spec.parallax);
  const startMs = Number(spec.startMs ?? 0);
  const intervalMs = Number(spec.intervalMs ?? 0);
  const randomInterval = Boolean(spec.randomInterval);
  const minIntervalMs = Number(spec.minIntervalMs ?? 2000);
  const maxIntervalMs = Number(spec.maxIntervalMs ?? 8000);
  const repeatCount = Number(spec.repeatCount ?? -1);
  const showFirstFrame = Boolean(spec.showFirstFrame);

  const playState = {
    frameIndex: 0,
    frameTimer: 0,
    phase: "idle",     // idle | playing | waiting
    phaseTimer: 0,
    playCount: 0,
    nextIntervalMs: 0,
  };

  if (type === "static") {
    const candidates = [`${base}/foreground.png`, `${base}/overlay.png`, `${base}/underlay.png`, `${base}/image.png`];
    let img = null;
    for (const src of candidates) {
      try { img = await loadImage(src); break; } catch { /* try next */ }
    }
    if (!img) {
      warnOnce(`${levelId}:${spec.folder}:noImage`, `[${levelId}] ${spec.folder}: no image found. Skipping.`);
      return null;
    }
    return { kind: "static", img, parallax, rendering, startMs, intervalMs, randomInterval, minIntervalMs, maxIntervalMs, repeatCount, showFirstFrame, playState };
  }

  if (type === "frames") {
    const count = Number(spec.count || 0);
    const fps = Number(spec.fps || DEFAULT_LAYER_FPS);
    if (!count) {
      warnOnce(`${levelId}:${spec.folder}:noCount`, `[${levelId}] ${spec.folder}: type=frames requires "count". Skipping.`);
      return null;
    }
    try {
      const frames = await loadFrameSequenceCounted(base, count);
      return { kind: "frames", frames, fps, parallax, rendering, startMs, intervalMs, randomInterval, minIntervalMs, maxIntervalMs, repeatCount, showFirstFrame, playState };
    } catch (e) {
      warnOnce(`${levelId}:${spec.folder}:loadFail`, `[${levelId}] ${spec.folder}: failed to load frames. (${e.message})`);
      return null;
    }
  }

  warnOnce(`${levelId}:${spec.folder}:badType`, `[${levelId}] ${spec.folder}: unsupported type="${spec.type}". Skipping.`);
  return null;
}

// Load an ordered array of layer specs (overlays or underlays) from levels.json.
async function loadLayerSet(levelId, specs) {
  if (!Array.isArray(specs)) return [];
  const results = await Promise.all(specs.map((s) => loadLayerFromSpec(levelId, s)));
  return results.filter(Boolean);
}

async function loadLevels() {
  const res = await fetch("data/levels.json");
  if (!res.ok) throw new Error(`Failed to fetch data/levels.json (${res.status})`);

  const json = await res.json();
  if (!json.levels || !Array.isArray(json.levels) || json.levels.length === 0) {
    throw new Error("data/levels.json must contain { levels: [ ... ] } with at least 1 level");
  }

  const loadedLevels = [];

  for (const lvl of json.levels) {
    const id = lvl.id || "(missing id)";

    // ---- HOME level: keep legacy layer loading intact ----
    if (lvl.isHome) {
      const bgSrc = lvl.background;
      if (!bgSrc) { console.warn(`[${id}] HOME missing "background". Excluded.`); continue; }
      try {
        const bgImg = await loadImage(bgSrc);
        const l1 = await loadOptionalLayer(id, lvl.layer1, "layer1");
        const l2 = await loadOptionalLayer(id, lvl.layer2, "layer2");
        const l3 = await loadOptionalLayer(id, lvl.layer3, "layer3");
        const l4 = await loadOptionalLayer(id, lvl.layer4, "layer4");
        loadedLevels.push(lvl);
        levelAssets.set(id, { bgImg, fgImg: null, l1, l2, l3, l4, overlays: [], underlays: [] });
      } catch (e) {
        console.warn(`[${id}] HOME background failed. Excluded. (${e.message})`);
      }
      continue;
    }

    // ---- Normal gameplay level: background.png implicit, layers from levels.json ----
    const bgSrc = `assets/levels/${id}/background.png`;
    try {
      const bgImg = await loadImage(bgSrc);
      const overlays  = await loadLayerSet(id, lvl.overlays);
      const underlays = await loadLayerSet(id, lvl.underlays);
      loadedLevels.push(lvl);
      levelAssets.set(id, { bgImg, overlays, underlays });
    } catch (e) {
      console.warn(`[${id}] background.png failed to load. Level excluded. (${e.message})`);
    }
  }

  if (loadedLevels.length === 0) {
    throw new Error("No valid levels loaded. Check backgrounds.");
  }

  levelData = loadedLevels;

  state.homeIndex = levelData.findIndex((l) => l && l.isHome === true);
  initCarouselWithHomeOrFallback();
}

async function loadSprites() {
  [heroIdleFrames, heroWalkFrames] = await Promise.all([
    loadFrameSequenceCounted(SPRITES.idle.folder, SPRITES.idle.count),
    loadFrameSequenceCounted(SPRITES.walk.folder, SPRITES.walk.count),
  ]);

  const base = heroIdleFrames[0];
  player.renderW = Math.round(base.width * SPRITE_SCALE);
  player.renderH = Math.round(base.height * SPRITE_SCALE);
  player.x = clamp(player.x, 0, W - player.renderW);
}

// ---------- Rendering helpers ----------
function currentLevel() {
  return levelData[state.levelIndex];
}

function currentLevelAssets() {
  const lvl = currentLevel();
  if (!lvl) return null;
  return levelAssets.get(lvl.id) || null;
}

function drawBackground() {
  const assets = currentLevelAssets();
  if (!assets?.bgImg) return;
  ctx.drawImage(assets.bgImg, 0, 0, W, H);
}

// HOME-only: keep legacy draw helpers for l1-l4 (used by home intro pipeline)
function drawForeground() {
  const assets = currentLevelAssets();
  if (!assets?.fgImg) return;
  drawZoomPanFollow(assets.fgImg, FG_ZOOM, FG_FOLLOW);
}

function drawOptionalLayerAsset(layerAsset, dt) {
  if (!layerAsset) return;
  let img = null;
  if (layerAsset.kind === "image") {
    img = layerAsset.img;
  } else if (layerAsset.kind === "frames") {
    const frames = layerAsset.frames;
    if (!frames || frames.length === 0) return;
    layerAsset.timer += dt;
    const spf = 1 / Math.max(1, layerAsset.fps || DEFAULT_LAYER_FPS);
    while (layerAsset.timer >= spf) {
      layerAsset.timer -= spf;
      layerAsset.frameIndex = (layerAsset.frameIndex + 1) % frames.length;
    }
    img = frames[layerAsset.frameIndex];
  }
  if (!img) return;
  ctx.drawImage(img, 0, 0, W, H);
}

function drawLayerN(key, dt) {
  const assets = currentLevelAssets();
  if (!assets) return;
  const layerAsset = assets[key];
  if (!layerAsset) return;
  drawOptionalLayerAsset(layerAsset, dt);
}

function drawLayer1(dt) { drawLayerN("l1", dt); }
function drawLayer2(dt) { drawLayerN("l2", dt); }
function drawLayer3(dt) { drawLayerN("l3", dt); }
function drawLayer4(dt) { drawLayerN("l4", dt); }

// ---------- New overlay/underlay draw system ----------

// Update and draw a single gameplay layer asset.
// levelTime = seconds since hero entered this level (for once/intermittent).
function updateAndDrawLayer(layer, dt, levelTime) {
  const ps = layer.playState;

  // Resolve the image to draw for this frame
  let img = null;
  let shouldDraw = true;

  if (layer.kind === "static") {
    img = layer.img;
    // For "once" static: only show after startMs
    if (layer.rendering === "once" && levelTime * 1000 < layer.startMs) shouldDraw = false;
  } else if (layer.kind === "frames") {
    const frames = layer.frames;
    if (!frames || frames.length === 0) return;

    if (layer.rendering === "loop") {
      const hasInterval = layer.intervalMs > 0 || layer.randomInterval;

      if (!hasInterval) {
        // Simple back-to-back loop
        ps.frameTimer += dt;
        const spf = 1 / Math.max(1, layer.fps);
        while (ps.frameTimer >= spf) {
          ps.frameTimer -= spf;
          ps.frameIndex = (ps.frameIndex + 1) % frames.length;
        }
      } else {
        // Loop with interval between repetitions
        if (ps.phase === "idle") {
          ps.phase = "playing";
          ps.frameIndex = 0;
          ps.frameTimer = 0;
        }
        if (ps.phase === "playing") {
          ps.frameTimer += dt;
          const spf = 1 / Math.max(1, layer.fps);
          while (ps.frameTimer >= spf) {
            ps.frameTimer -= spf;
            ps.frameIndex++;
            if (ps.frameIndex >= frames.length) {
              ps.frameIndex = 0;
              // Completed one loop — enter wait phase
              ps.phase = "waiting";
              ps.nextIntervalMs = layer.randomInterval
                ? layer.minIntervalMs + Math.random() * (layer.maxIntervalMs - layer.minIntervalMs)
                : layer.intervalMs;
              ps.phaseTimer = 0;
              break;
            }
          }
        }
        if (ps.phase === "waiting") {
          ps.phaseTimer += dt * 1000;
          if (ps.phaseTimer >= ps.nextIntervalMs) ps.phase = "playing";
          if (layer.showFirstFrame) { ps.frameIndex = 0; }
          else { shouldDraw = false; }
        }
      }
      img = frames[ps.frameIndex];

    } else if (layer.rendering === "once") {
      const ltMs = levelTime * 1000;
      if (ltMs < layer.startMs) { shouldDraw = false; }
      else {
        if (ps.phase === "idle") { ps.phase = "playing"; ps.frameIndex = 0; ps.frameTimer = 0; }
        if (ps.phase === "playing") {
          ps.frameTimer += dt;
          const spf = 1 / Math.max(1, layer.fps);
          while (ps.frameTimer >= spf) {
            ps.frameTimer -= spf;
            ps.frameIndex++;
            if (ps.frameIndex >= frames.length) { ps.frameIndex = frames.length - 1; ps.phase = "done"; break; }
          }
        }
        img = frames[ps.frameIndex];
      }

    } else if (layer.rendering === "intermittent") {
      const ltMs = levelTime * 1000;
      if (ltMs < layer.startMs) { shouldDraw = false; }
      else {
        if (ps.phase === "idle") { ps.phase = "playing"; ps.frameIndex = 0; ps.frameTimer = 0; }
        if (ps.phase === "playing") {
          ps.frameTimer += dt;
          const spf = 1 / Math.max(1, layer.fps);
          while (ps.frameTimer >= spf) {
            ps.frameTimer -= spf;
            ps.frameIndex++;
            if (ps.frameIndex >= frames.length) {
              ps.frameIndex = 0;
              ps.playCount++;
              if (layer.repeatCount >= 0 && ps.playCount >= layer.repeatCount) {
                ps.phase = "done"; break;
              }
              ps.phase = "waiting";
              ps.nextIntervalMs = layer.randomInterval
                ? layer.minIntervalMs + Math.random() * (layer.maxIntervalMs - layer.minIntervalMs)
                : layer.intervalMs;
              ps.phaseTimer = 0;
              break;
            }
          }
        }
        if (ps.phase === "waiting") {
          ps.phaseTimer += dt * 1000;
          if (ps.phaseTimer >= ps.nextIntervalMs) ps.phase = "playing";
          if (layer.showFirstFrame) { ps.frameIndex = 0; }
          else { shouldDraw = false; }
        }
        if (ps.phase === "done") { shouldDraw = false; }
        else img = frames[ps.frameIndex];
      }
    }
  }

  if (!shouldDraw || !img) return;

  if (layer.parallax) {
    drawZoomPanFollow(img, FG_ZOOM, FG_FOLLOW);
  } else {
    ctx.drawImage(img, 0, 0, W, H);
  }
}

// Draw order: underlay[max]...underlay[1] → hero → overlay[1]...overlay[max]
function drawUnderlays(dt) {
  const assets = currentLevelAssets();
  if (!assets?.underlays?.length) return;
  const lt = (performance.now() - (state.levelEnteredAt ?? performance.now())) / 1000;
  // Draw from highest index (furthest back) to lowest (closest to hero)
  for (let i = assets.underlays.length - 1; i >= 0; i--) {
    updateAndDrawLayer(assets.underlays[i], dt, lt);
  }
}

function drawOverlays(dt) {
  const assets = currentLevelAssets();
  if (!assets?.overlays?.length) return;
  const lt = (performance.now() - (state.levelEnteredAt ?? performance.now())) / 1000;
  // Draw from lowest index (closest to hero) to highest (on top of everything)
  for (let i = 0; i < assets.overlays.length; i++) {
    updateAndDrawLayer(assets.overlays[i], dt, lt);
  }
}

// Reset per-level playback state when entering a new level
function resetLevelLayerStates(id) {
  const assets = levelAssets.get(id);
  if (!assets) return;
  const reset = (layer) => {
    layer.playState.frameIndex = 0;
    layer.playState.frameTimer = 0;
    layer.playState.phase = "idle";
    layer.playState.phaseTimer = 0;
    layer.playState.playCount = 0;
    layer.playState.nextIntervalMs = 0;
  };
  assets.overlays?.forEach(reset);
  assets.underlays?.forEach(reset);
}

// ---------- Player ----------
function currentFrames() {
  return player.anim === "walk" ? heroWalkFrames : heroIdleFrames;
}

function currentFps() {
  return player.anim === "walk" ? SPRITES.walk.fps : SPRITES.idle.fps;
}

function drawPlayer() {
  if (!player.visible) return;

  const frames = currentFrames();
  if (!frames.length) return;

  player.frameIndex = player.frameIndex % frames.length;
  const img = frames[player.frameIndex];
  if (!img) return;

  const drawW = Math.round(img.width * SPRITE_SCALE);
  const drawH = Math.round(img.height * SPRITE_SCALE);

  let walkBob = 0;
  if (player.anim === "walk" && WALK_BOB_PX > 0 && heroWalkFrames.length) {
    const phase = (player.frameIndex / heroWalkFrames.length) * Math.PI * 2;
    walkBob = Math.sin(phase) * WALK_BOB_PX;
  }

  const x = Math.round(player.x);
  const y = Math.round(FLOOR_Y - drawH - FEET_FUDGE_PX + walkBob);

  ctx.save();
  if (player.facing === -1) {
    ctx.translate(x + drawW, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(img, 0, y, drawW, drawH);
  } else {
    ctx.drawImage(img, x, y, drawW, drawH);
  }
  ctx.restore();
}

// ---------- Universe switching ----------
// NEW BEHAVIOR:
// - Trigger when hero CENTER crosses the portal line (x=0 or x=W),
//   so the hero is half-way through.
// - After switching, spawn half-inside the new universe so the half that
//   already entered stays visible.
// ---------- Return popup ----------
const POPUP = {
  active: false,
  timer: 0,
  duration: 3.5,
  fadeIn: 0.4,
  fadeOut: 0.8,
  text: "You've come full circle!",
};

function triggerReturnPopup() {
  POPUP.active = true;
  POPUP.timer = 0;
}

function drawPopup(dt) {
  if (!POPUP.active) return;
  POPUP.timer += dt;
  const t = POPUP.timer;
  const d = POPUP.duration;
  if (t >= d) { POPUP.active = false; return; }

  let alpha;
  if (t < POPUP.fadeIn) {
    alpha = t / POPUP.fadeIn;
  } else if (t > d - POPUP.fadeOut) {
    alpha = (d - t) / POPUP.fadeOut;
  } else {
    alpha = 1;
  }
  alpha = Math.max(0, Math.min(1, alpha));

  const boxW = 360;
  const boxH = 72;
  const boxX = (W - boxW) / 2;
  const boxY = H / 2 - boxH / 2;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
  ctx.beginPath();
  ctx.roundRect(boxX, boxY, boxW, boxH, 14);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 26px ui-sans-serif, system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(POPUP.text, W / 2, boxY + boxH / 2);
  ctx.restore();
}

function triggerEdge(edge) {
  if (state.transitioning) return;
  if (!state.gameplayEnabled) return;

  state.transitioning = true;
  state.transitionUntil = performance.now() + 60;
  state.lastEdge = edge;
  player.visible = false;
}

function finishTransition() {
  const wasHome = state.homeIndex !== -1 && state.levelIndex === state.homeIndex;
  state.levelIndex = state.lastEdge === "left" ? carouselMoveLeft() : carouselMoveRight();

  if (wasHome) {
    state.hasLeftHome = true;
    state.popupTriggeredThisReturn = false; // reset so next visit can fire
  }

  // Spawn half-in on the correct side:
  // - came from LEFT edge => you were walking left => new level, appear on RIGHT, half-visible
  // - came from RIGHT edge => you were walking right => new level, appear on LEFT, half-visible
const w = player.renderW;
const off = w * 0.25;     // 1/4 off-screen
const visible = w * 0.75; // 3/4 visible

if (state.lastEdge === "left") {
  // come from left edge -> appear on right, 1/4 off to the right
  player.x = W - visible; // == W - 0.75w
  player.facing = -1;
} else {
  // come from right edge -> appear on left, 1/4 off to the left
  player.x = -off;        // == -0.25w
  player.facing = 1;
}


  setAnim("idle");
  player.visible = true;
  state.transitioning = false;

  // Reset layer animation states and start level timer for the new level
  const newLvl = levelData[state.levelIndex];
  if (newLvl) resetLevelLayerStates(newLvl.id);
  state.levelEnteredAt = performance.now();
}

// =========================
// HOME INTRO STATE MACHINE
// =========================
const HOME = {
  active: false,
  phase: 0,
  phaseTimer: 0,

  preStart: null,
  start1: null,
  start2: null,
  idle: null,

  instrStart: null,
  instrCommands: null,

  underlayImg: null,

  promptEnter: "Press Enter",
  promptArrows: "Use ← →",

  pauseMs: 0,

  // Radio: trigger live only once
  _radioWentLive: false,
};

function isHomeLevel() {
  return isHomeIndex(state.levelIndex);
}

function framePlayerUpdate(seq, dt) {
  if (!seq || !seq.frames?.length) return;

  seq.timer += dt;
  const spf = 1 / Math.max(1, seq.fps || 12);

  while (seq.timer >= spf) {
    seq.timer -= spf;
    const next = seq.idx + 1;
    if (next >= seq.frames.length) {
      seq.idx = seq.loop ? 0 : seq.frames.length - 1;
      seq.done = !seq.loop;
    } else {
      seq.idx = next;
    }
  }
}

function drawFrameSeq(seq) {
  if (!seq || !seq.frames?.length) return;
  const img = seq.frames[seq.idx] || null;
  if (!img) return;
  ctx.drawImage(img, 0, 0, W, H);
}

function drawHomeUnderlayIfAny() {
  if (!HOME.underlayImg) return;
  ctx.drawImage(HOME.underlayImg, 0, 0, W, H);
}

// remove temporary text prompts
function drawHomePrompts() {
  return;
}

async function loadHomeIntroAssetsIfNeeded() {
  const lvl = currentLevel();
  const spec = lvl?.homeIntro;
  if (!spec) return;

  if (
    HOME.preStart && HOME.start1 && HOME.start2 && HOME.idle &&
    HOME.instrStart && HOME.instrCommands
  ) return;

  HOME.promptEnter = spec.promptEnter || HOME.promptEnter;
  HOME.promptArrows = spec.promptArrows || HOME.promptArrows;
  HOME.pauseMs = Number(spec.pauseMs ?? HOME.pauseMs);

  const mkSeq = async (s) => {
    if (!s?.folder || !s?.count) return null;
    const frames = await loadFrameSequenceCounted(s.folder, Number(s.count));
    return {
      frames,
      fps: Number(s.fps || 12),
      loop: Boolean(s.loop),
      timer: 0,
      idx: 0,
      done: false,
    };
  };

  if (!HOME.preStart) HOME.preStart = await mkSeq(spec.preStart);
  if (!HOME.start1) HOME.start1 = await mkSeq(spec.start1);
  if (!HOME.start2) HOME.start2 = await mkSeq(spec.start2);
  if (!HOME.idle) HOME.idle = await mkSeq(spec.idle);

  const instr = spec.instructions || {};
  if (!HOME.instrStart) HOME.instrStart = await mkSeq(instr.start);
  if (!HOME.instrCommands) HOME.instrCommands = await mkSeq(instr.commands);

  if (!HOME.underlayImg && spec.start1?.underlay) {
    HOME.underlayImg = await loadImage(spec.start1.underlay);
  }
}

function enterHomeIntroMode() {
  HOME.active = true;
  HOME.phase = 0;
  HOME.phaseTimer = 0;
  HOME._radioWentLive = false;

  state.gameplayEnabled = false;
  player.visible = false;

  for (const seq of [
    HOME.preStart, HOME.start1, HOME.start2, HOME.idle,
    HOME.instrStart, HOME.instrCommands
  ]) {
    if (!seq) continue;
    seq.timer = 0;
    seq.idx = 0;
    seq.done = false;
  }
}

function handoffHomeToGameplay() {
  player.x = Math.floor(W / 2 - player.renderW / 2) + HOME_DROP_OFFSET_X;
  player.x = clamp(player.x, 0, W - player.renderW);
  state.dropX = player.x;
  state.levelEnteredAt = performance.now();

  if (input.left) player.facing = -1;
  if (input.right) player.facing = 1;

  state.gameplayEnabled = true;
  player.visible = true;

  const vx = (input.left ? -1 : 0) + (input.right ? 1 : 0);
  setAnim(vx === 0 ? "idle" : "walk");

  HOME.active = false;

  // Keep widget visible afterwards if it was shown
  if (RADIO.loaded) RADIO.ensureVisible();
}

function drawCommandsOverlayUnderHero(dt) {
  if (!isHomeLevel()) return;
  if (!HOME.instrCommands) return;

  framePlayerUpdate(HOME.instrCommands, dt);
  drawFrameSeq(HOME.instrCommands);
}

function updateAndDrawHome(dt) {
  if (!HOME.active) return;

  const drawTopUI = () => {
    drawLayer3(dt); // title
    drawHomePrompts();
  };

  // Phase 0
  if (HOME.phase === 0) {
    framePlayerUpdate(HOME.preStart, dt);
    drawFrameSeq(HOME.preStart);
    drawBackground();

    if (HOME.instrStart) {
      framePlayerUpdate(HOME.instrStart, dt);
      drawFrameSeq(HOME.instrStart);
    }

    drawTopUI();

    if (input.enterPressedThisFrame) {
      // IMPORTANT: start warmup here (user gesture)
      RADIO.warmUpFromGesture();

      // NEW: start home ambient (user gesture)
      HOME_AUDIO.startAmbient({ target: 0.4, fadeMs: 1200 });

      HOME.phase = 1;
      HOME.start1.timer = 0;
      HOME.start1.idx = 0;
      HOME.start1.done = false;
    }
    return;
  }

  // Phase 1
  if (HOME.phase === 1) {
    framePlayerUpdate(HOME.start1, dt);
    drawFrameSeq(HOME.start1);
    drawBackground();
    drawTopUI();

    if (HOME.start1?.done) {
      HOME.phase = 2;
      HOME.phaseTimer = 0;

      // NEW: play overlay once at the beginning of phase 2
      HOME_OVERLAY.playOnce({ volume: 1.0 });
    }
    return;
  }

  // Phase 2 pause
  if (HOME.phase === 2) {
    drawHomeUnderlayIfAny();
    drawBackground();
    drawTopUI();

    HOME.phaseTimer += dt * 1000;
    if (HOME.phaseTimer >= HOME.pauseMs) {
      HOME.phase = 3;
      HOME.start2.timer = 0;
      HOME.start2.idx = 0;
      HOME.start2.done = false;
    }
    return;
  }

  // Phase 3 start2
  if (HOME.phase === 3) {
    drawHomeUnderlayIfAny();
    drawBackground();

    framePlayerUpdate(HOME.start2, dt);
    drawFrameSeq(HOME.start2);
    drawTopUI();

    if (HOME.start2?.done) {
      // NEW: we’re about to enter idle/radio phase → fade out ambient
      HOME_AUDIO.stopAmbient({ fadeMs: 1400 });

      HOME.phase = 5; // jump directly to idle mode
      HOME.idle.timer = 0;
      HOME.idle.idx = 0;
      HOME.idle.done = false;

      if (HOME.instrCommands) {
        HOME.instrCommands.timer = 0;
        HOME.instrCommands.idx = 0;
        HOME.instrCommands.done = false;
      }
    }
    return;
  }

  // HOME idle mode (your “state 4”)
  if (HOME.phase === 5) {
    drawHomeUnderlayIfAny();
    drawBackground();

    if (HOME.instrCommands) {
      framePlayerUpdate(HOME.instrCommands, dt);
      drawFrameSeq(HOME.instrCommands);
    }

    framePlayerUpdate(HOME.idle, dt);
    drawFrameSeq(HOME.idle);

    drawTopUI();

    // RADIO: show widget + unmute/fade in (should be ready because warmup started earlier)
    if (!HOME._radioWentLive) {
      HOME._radioWentLive = true;
      RADIO.goLive();
    }

    if (input.arrowPressedThisFrame) {
      handoffHomeToGameplay();
    }
    return;
  }
}

// ---------- Loop ----------
let lastT = performance.now();

function loop(t) {
  const dt = Math.min(0.033, (t - lastT) / 1000);
  lastT = t;

  ctx.clearRect(0, 0, W, H);

  // HOME intro pipeline
  if (isHomeLevel() && !state.gameplayEnabled) {
    if (
      !HOME.preStart || !HOME.start1 || !HOME.start2 || !HOME.idle ||
      !HOME.instrStart || !HOME.instrCommands
    ) {
      drawBackground();
      drawLayer3(dt);

      ctx.save();
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.font = "18px ui-sans-serif, system-ui";
      ctx.fillText("Loading...", 20, 30);
      ctx.restore();

      if (!HOME._loading) {
        HOME._loading = true;
        loadHomeIntroAssetsIfNeeded()
          .then(() => {
            HOME._loading = false;
            enterHomeIntroMode();
          })
          .catch((e) => {
            HOME._loading = false;
            console.error(e);
          });
      }

      input.enterPressedThisFrame = false;
      input.arrowPressedThisFrame = false;

      requestAnimationFrame(loop);
      return;
    }

    if (!HOME.active) enterHomeIntroMode();
    updateAndDrawHome(dt);

    // keep radio widget tracking canvas position even while hidden
    if (RADIO.loaded) RADIO.placeWidget();

    input.enterPressedThisFrame = false;
    input.arrowPressedThisFrame = false;

    requestAnimationFrame(loop);
    return;
  }

  // ============ Normal gameplay ============
  if (!state.transitioning) {
    let vx = 0;
    if (input.left) vx -= 1;
    if (input.right) vx += 1;

    if (vx !== 0) player.facing = vx > 0 ? 1 : -1;
    setAnim(vx === 0 ? "idle" : "walk");

    player.x += vx * player.speed * dt;

    // NEW: allow some off-screen travel so the HERO CENTER can cross the edge
    // (portal swap happens at center crossing)
    player.x = clamp(player.x, -player.renderW, W);

   const w = player.renderW;
const off = w * 0.35;       // trigger when 1/4 is off-screen
const rightTriggerX = W - (w * 0.75); // == W - 0.75w

if (vx < 0 && player.x <= -off) {
  triggerEdge("left");
} else if (vx > 0 && player.x >= rightTriggerX) {
  triggerEdge("right");
}

    // Check if player has walked back to the original drop-in x on home
    if (
      state.hasLeftHome &&
      isHomeLevel() &&
      state.dropX !== null &&
      !state.popupTriggeredThisReturn &&
      Math.abs(player.x - state.dropX) <= 12
    ) {
      state.popupTriggeredThisReturn = true;
      triggerReturnPopup();
    }


    const fps = currentFps();
    player.frameTimer += dt;
    if (player.frameTimer >= 1 / fps) {
      player.frameTimer -= 1 / fps;
      const framesLen = currentFrames().length || 1;
      player.frameIndex = (player.frameIndex + 1) % framesLen;
    }
  } else if (performance.now() >= state.transitionUntil) {
    finishTransition();
  }

  // keep widget anchored if visible (and also keeps it ready if you resize)
  if (RADIO.loaded) {
    if (RADIO.visible) RADIO.placeWidget();
  }

  // Draw normal level
  if (isHomeLevel()) {
    // HOME uses legacy layer system (untouched)
    drawLayer1(dt);
    drawBackground();
    drawCommandsOverlayUnderHero(dt);
    drawPlayer();
    drawLayer2(dt);
    drawLayer3(dt);
    drawLayer4(dt);
    drawForeground();
  } else {
    // Gameplay levels use new overlay/underlay system
    // Order (back → front): background → underlays → hero → overlays
    drawBackground();
    drawUnderlays(dt);
    drawPlayer();
    drawOverlays(dt);
  }

  drawPopup(dt);

  input.enterPressedThisFrame = false;
  input.arrowPressedThisFrame = false;

  requestAnimationFrame(loop);
}

// ---------- Boot ----------
Promise.all([
  loadLevels(),
  loadSprites(),
  RADIO.loadStations(), // load radio.json early
])
  .then(() => requestAnimationFrame(loop))
  .catch((e) => {
    console.error(e);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#111";
    ctx.font = "18px ui-sans-serif, system-ui";
    ctx.fillText("Asset loading error. Check console.", 20, 30);
  });
