// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  backgroundFile: null,
  overlays: [],   // [{ files: [], config: {} }]
  underlays: [],  // [{ files: [], config: {} }]
  existingLevels: [],
  nextId: "001",
};

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  await fetchLevels();
  setupBackgroundDropzone();
  document.getElementById("addOverlay").addEventListener("click", () => addLayer("overlay"));
  document.getElementById("addUnderlay").addEventListener("click", () => addLayer("underlay"));
  document.getElementById("uploadBtn").addEventListener("click", uploadLevel);
  document.getElementById("levelTarget").addEventListener("change", onTargetChange);
});

async function fetchLevels() {
  try {
    const res = await fetch("/api/levels");
    const data = await res.json();
    state.existingLevels = data.levels || [];
    state.nextId = data.nextId || "001";
    populateLevelSelector();
  } catch (err) {
    setStatus("Failed to load levels: " + err.message, "error");
  }
}

function populateLevelSelector() {
  const sel = document.getElementById("levelTarget");
  sel.innerHTML = "";

  // New level option
  const opt = document.createElement("option");
  opt.value = "__new__";
  opt.textContent = `New level (${state.nextId})`;
  sel.appendChild(opt);

  // Existing levels (for overwrite)
  for (const lv of state.existingLevels) {
    const o = document.createElement("option");
    o.value = lv.id;
    o.textContent = `Overwrite ${lv.id} — ${lv.name}`;
    sel.appendChild(o);
  }
}

function onTargetChange() {
  const val = document.getElementById("levelTarget").value;
  const warn = document.getElementById("overwriteWarning");
  if (val === "__new__") {
    warn.classList.add("hidden");
  } else {
    warn.classList.remove("hidden");
  }
  updateUploadBtn();
}

// ---------------------------------------------------------------------------
// Background dropzone
// ---------------------------------------------------------------------------

function setupBackgroundDropzone() {
  const dz = document.getElementById("bgDropzone");
  const input = dz.querySelector("input[type=file]");
  const listEl = document.getElementById("bgFiles");

  wireDropzone(dz, input, (files) => {
    if (files.length > 0) {
      state.backgroundFile = files[0];
      renderFileList(listEl, [state.backgroundFile], "background.png", (idx) => {
        state.backgroundFile = null;
        renderFileList(listEl, [], null, null);
        updateUploadBtn();
      });
      updateUploadBtn();
    }
  });
}

// ---------------------------------------------------------------------------
// Layers (overlay / underlay)
// ---------------------------------------------------------------------------

let layerCounter = 0;

function addLayer(kind) {
  const idx = kind === "overlay" ? state.overlays.length : state.underlays.length;
  const layer = {
    files: [],
    config: {
      type: "static",
      rendering: "loop",
      fps: 12,
      parallax: false,
      startMs: 0,
      intervalMs: 0,
      randomInterval: false,
      minIntervalMs: 2000,
      maxIntervalMs: 8000,
      repeatCount: -1,
      showFirstFrame: false,
    },
  };

  if (kind === "overlay") {
    state.overlays.push(layer);
  } else {
    state.underlays.push(layer);
  }

  const container = document.getElementById(kind === "overlay" ? "overlayLayers" : "underlayLayers");
  const tmpl = document.getElementById("layerTemplate");
  const card = tmpl.content.cloneNode(true).querySelector(".layer-card");
  const uid = `layer_${layerCounter++}`;

  card.dataset.kind = kind;
  card.dataset.index = idx;

  const num = String(idx + 1).padStart(2, "0");
  card.querySelector(".layer-title").textContent =
    kind === "overlay" ? `Overlay ${num}` : `Underlay ${num}`;

  // Radio names need to be unique
  const radios = card.querySelectorAll('input[type="radio"]');
  radios.forEach((r) => (r.name = `type_${uid}`));

  // Show parallax row only for overlays
  if (kind === "overlay") {
    card.querySelector(".parallax-row").classList.remove("hidden");
  }

  // Wire dropzone
  const dz = card.querySelector(".layer-dropzone");
  const input = dz.querySelector("input[type=file]");
  const listEl = card.querySelector(".file-list");

  wireDropzone(dz, input, (files) => {
    layer.files = layer.files.concat(Array.from(files));
    renderLayerFileList(listEl, layer);
    updateUploadBtn();
  });

  // Wire config controls
  wireLayerConfig(card, layer, listEl);

  // Remove button
  card.querySelector(".remove-layer-btn").addEventListener("click", () => {
    const arr = kind === "overlay" ? state.overlays : state.underlays;
    const i = arr.indexOf(layer);
    if (i !== -1) arr.splice(i, 1);
    card.remove();
    renumberLayers(kind);
    updateUploadBtn();
  });

  container.appendChild(card);
}

function wireLayerConfig(card, layer, listEl) {
  const radios = card.querySelectorAll('input[type="radio"]');
  const framesOpts = card.querySelector(".frames-options");
  const timedOpts = card.querySelector(".timed-options");
  const intermittentOpts = card.querySelector(".intermittent-options");
  const randomOpts = card.querySelector(".random-interval-options");
  const renderingSel = card.querySelector(".rendering-select");
  const fpsInput = card.querySelector(".fps-input");
  const parallaxCheck = card.querySelector(".parallax-check");
  const randomCheck = card.querySelector(".random-interval-check");

  function updateVisibility() {
    const isFrames = layer.config.type === "frames";
    framesOpts.classList.toggle("hidden", !isFrames);

    const rendering = layer.config.rendering;
    const showTimed = isFrames && (rendering === "once" || rendering === "intermittent");
    timedOpts.classList.toggle("hidden", !showTimed);
    intermittentOpts.classList.toggle("hidden", !(isFrames && rendering === "intermittent"));
    randomOpts.classList.toggle("hidden", !layer.config.randomInterval);
  }

  // Type radio
  radios.forEach((r) => {
    r.addEventListener("change", () => {
      layer.config.type = r.value;
      updateVisibility();
      renderLayerFileList(listEl, layer);
    });
  });

  // Rendering
  renderingSel.addEventListener("change", () => {
    layer.config.rendering = renderingSel.value;
    updateVisibility();
  });

  // FPS
  fpsInput.addEventListener("input", () => {
    layer.config.fps = parseInt(fpsInput.value, 10) || 12;
  });

  // Parallax
  parallaxCheck.addEventListener("change", () => {
    layer.config.parallax = parallaxCheck.checked;
  });

  // Random interval
  randomCheck.addEventListener("change", () => {
    layer.config.randomInterval = randomCheck.checked;
    updateVisibility();
  });

  // Show first frame during interval
  const showFirstFrameCheck = card.querySelector(".show-first-frame-check");
  showFirstFrameCheck.addEventListener("change", () => {
    layer.config.showFirstFrame = showFirstFrameCheck.checked;
  });

  // Numeric inputs
  const numInputs = [
    { sel: ".start-ms-input", key: "startMs" },
    { sel: ".interval-ms-input", key: "intervalMs" },
    { sel: ".min-interval-input", key: "minIntervalMs" },
    { sel: ".max-interval-input", key: "maxIntervalMs" },
    { sel: ".repeat-count-input", key: "repeatCount" },
  ];
  for (const ni of numInputs) {
    const el = card.querySelector(ni.sel);
    el.addEventListener("input", () => {
      layer.config[ni.key] = parseInt(el.value, 10) || 0;
    });
  }
}

function renumberLayers(kind) {
  const container = document.getElementById(kind === "overlay" ? "overlayLayers" : "underlayLayers");
  const cards = container.querySelectorAll(".layer-card");
  cards.forEach((card, i) => {
    card.dataset.index = i;
    const num = String(i + 1).padStart(2, "0");
    card.querySelector(".layer-title").textContent =
      kind === "overlay" ? `Overlay ${num}` : `Underlay ${num}`;
  });
}

// ---------------------------------------------------------------------------
// File list rendering
// ---------------------------------------------------------------------------

/**
 * Extract a number from a filename for sorting/renaming.
 */
function extractIndex(filename) {
  const base = filename.replace(/\.[^.]+$/, "");
  let m = base.match(/\((\d+)\)\s*$/);
  if (m) return parseInt(m[1], 10);
  m = base.match(/(\d+)\s*$/);
  if (m) return parseInt(m[1], 10);
  return null;
}

/**
 * Render background file list with rename preview.
 */
function renderFileList(el, files, renameTo, onRemove) {
  el.innerHTML = "";
  for (let i = 0; i < files.length; i++) {
    const tag = document.createElement("span");
    tag.className = "file-tag";

    let html = escapeHtml(files[i].name);
    if (renameTo) {
      html += ` <span class="rename-arrow">&rarr;</span> <span class="new-name">${escapeHtml(renameTo)}</span>`;
    }
    if (onRemove) {
      html += ` <button class="remove-file" data-idx="${i}">&times;</button>`;
    }
    tag.innerHTML = html;
    el.appendChild(tag);
  }

  if (onRemove) {
    el.querySelectorAll(".remove-file").forEach((btn) => {
      btn.addEventListener("click", () => onRemove(parseInt(btn.dataset.idx, 10)));
    });
  }
}

/**
 * Render file list for a layer, showing rename previews.
 */
function renderLayerFileList(el, layer) {
  el.innerHTML = "";
  const files = layer.files;
  if (files.length === 0) return;

  if (layer.config.type === "static") {
    // Only show first file, renamed to overlay.png / underlay.png
    const tag = document.createElement("span");
    tag.className = "file-tag";
    const kind = el.closest(".layer-card").dataset.kind;
    const renameTo = kind === "overlay" ? "overlay.png" : "underlay.png";
    tag.innerHTML =
      escapeHtml(files[0].name) +
      ` <span class="rename-arrow">&rarr;</span> <span class="new-name">${renameTo}</span>` +
      ` <button class="remove-file" data-idx="0">&times;</button>`;
    el.appendChild(tag);

    if (files.length > 1) {
      const extra = document.createElement("span");
      extra.className = "file-tag";
      extra.style.color = "var(--warning)";
      extra.textContent = `+${files.length - 1} extra (only first used for static)`;
      el.appendChild(extra);
    }
  } else {
    // Frames: sort and show rename preview
    const indexed = files.map((f, i) => ({ file: f, origIdx: i, num: extractIndex(f.name) }));
    indexed.sort((a, b) => {
      if (a.num !== null && b.num !== null) return a.num - b.num;
      if (a.num !== null) return -1;
      if (b.num !== null) return 1;
      return a.file.name.localeCompare(b.file.name);
    });

    for (let i = 0; i < indexed.length; i++) {
      const seq = String(i + 1).padStart(2, "0");
      const tag = document.createElement("span");
      tag.className = "file-tag";
      tag.innerHTML =
        escapeHtml(indexed[i].file.name) +
        ` <span class="rename-arrow">&rarr;</span> <span class="new-name">frame_${seq}.png</span>` +
        ` <button class="remove-file" data-idx="${indexed[i].origIdx}">&times;</button>`;
      el.appendChild(tag);
    }
  }

  el.querySelectorAll(".remove-file").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx, 10);
      layer.files.splice(idx, 1);
      renderLayerFileList(el, layer);
      updateUploadBtn();
    });
  });
}

// ---------------------------------------------------------------------------
// Drag & drop wiring
// ---------------------------------------------------------------------------

function wireDropzone(dz, input, onFiles) {
  const browseBtn = dz.querySelector(".browse-btn");

  browseBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    input.click();
  });

  dz.addEventListener("click", (e) => {
    if (e.target === browseBtn) return;
    input.click();
  });

  input.addEventListener("change", () => {
    if (input.files.length > 0) {
      onFiles(Array.from(input.files));
      input.value = "";
    }
  });

  dz.addEventListener("dragover", (e) => {
    e.preventDefault();
    dz.classList.add("drag-over");
  });

  dz.addEventListener("dragleave", () => {
    dz.classList.remove("drag-over");
  });

  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("drag-over");
    if (e.dataTransfer.files.length > 0) {
      onFiles(Array.from(e.dataTransfer.files));
    }
  });
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

function updateUploadBtn() {
  const btn = document.getElementById("uploadBtn");
  btn.disabled = !state.backgroundFile;
}

async function uploadLevel() {
  const btn = document.getElementById("uploadBtn");
  btn.disabled = true;
  btn.classList.add("uploading");
  btn.textContent = "Uploading...";
  setStatus("Uploading level...", "");

  try {
    const targetVal = document.getElementById("levelTarget").value;
    const isOverwrite = targetVal !== "__new__";

    // Build config JSON
    const config = {
      underlays: state.underlays.map((l) => l.config),
      overlays: state.overlays.map((l) => l.config),
    };

    // Build FormData
    const fd = new FormData();
    fd.append("config", JSON.stringify(config));

    // Background
    fd.append("background", state.backgroundFile);

    // Underlays
    for (let i = 0; i < state.underlays.length; i++) {
      const layer = state.underlays[i];
      // Sort files by detected index before sending
      const sorted = sortFilesByIndex(layer.files);
      for (const f of sorted) {
        fd.append(`underlay_${i}`, f);
      }
    }

    // Overlays
    for (let i = 0; i < state.overlays.length; i++) {
      const layer = state.overlays[i];
      const sorted = sortFilesByIndex(layer.files);
      for (const f of sorted) {
        fd.append(`overlay_${i}`, f);
      }
    }

    const url = isOverwrite ? `/api/upload/${targetVal}` : "/api/upload";
    const res = await fetch(url, { method: "POST", body: fd });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Upload failed");
    }

    setStatus(`Level ${data.levelId} uploaded successfully!`, "success");

    // Reset state
    state.backgroundFile = null;
    state.overlays = [];
    state.underlays = [];
    document.getElementById("bgFiles").innerHTML = "";
    document.getElementById("overlayLayers").innerHTML = "";
    document.getElementById("underlayLayers").innerHTML = "";

    // Refresh level list
    await fetchLevels();
  } catch (err) {
    setStatus("Upload failed: " + err.message, "error");
  } finally {
    btn.classList.remove("uploading");
    btn.textContent = "Upload Level";
    updateUploadBtn();
  }
}

function sortFilesByIndex(files) {
  const indexed = files.map((f) => ({ file: f, num: extractIndex(f.name) }));
  indexed.sort((a, b) => {
    if (a.num !== null && b.num !== null) return a.num - b.num;
    if (a.num !== null) return -1;
    if (b.num !== null) return 1;
    return a.file.name.localeCompare(b.file.name);
  });
  return indexed.map((x) => x.file);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setStatus(msg, type) {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.className = "status" + (type ? " " + type : "");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
