// Lokaal transcript: opnemen, transcriberen met Voz en sprekers onderscheiden
// met Who (Desert Ant Labs). Alle audio blijft op het apparaat; alleen de
// modelbestanden worden eenmalig van Hugging Face gedownload.

const RATE = 16000;            // beide modellen werken op 16 kHz mono
const LIVE_MIN_SECONDS = 20;   // live transcriberen per blok van minstens zoveel seconden
const LIVE_TAIL_SECONDS = 1.5; // laatste stuk van een blok wachten we af (woord kan nog doorlopen)
const LIVE_MAX_SECONDS = 60;   // daarna wordt een blok hoe dan ook vastgelegd
const PARAGRAPH_GAP = 4;       // seconden stilte waarna een nieuwe alinea begint
const MIN_SPEAKER_SHARE = 0.02;
const STORE_KEY = "lt.transcript.v1";
const LOAD_FLAG = "lt.loading";
const MODEL_CACHE = "lt-models-v1"; // gelijk aan sw.js
// Met service worker bewaart die de modelbestanden; Voz hoeft dat dan niet zelf.
const HAS_SW = "serviceWorker" in navigator;

const $ = (id) => document.getElementById(id);
const ui = {
  pillVoz: $("pillVoz"), pillWho: $("pillWho"), pillOffline: $("pillOffline"), btnLoad: $("btnLoad"),
  btnRec: $("btnRec"), timer: $("timer"), level: $("level"),
  status: $("status"), progress: $("progress"), fileInput: $("fileInput"), btnImport: $("btnImport"),
  speakers: $("speakers"), scroll: $("scroll"), empty: $("empty"), segments: $("segments"),
  btnCopy: $("btnCopy"), btnTxt: $("btnTxt"), btnWav: $("btnWav"), btnClear: $("btnClear"), toast: $("toast"),
};

const models = { voz: null, who: null, loading: null };
const rec = {
  active: false, ctx: null, stream: null, node: null, sink: null,
  chunks: [], total: 0, startedAt: 0, timerId: 0, liveId: 0,
  committed: 0, liveBusy: null,
};
let liveWords = [];   // woorden met absolute tijden, nog zonder spreker
let result = null;    // { segments, names, speakers: [{id, share}], duration }
let audio = null;     // Float32Array van de laatste opname of import (16 kHz)
let busy = false;     // verwerking na opname/import loopt
let wakeLock = null;

// ---------- Modellen ----------

function setPill(pill, state, text) {
  pill.dataset.state = state;
  pill.lastElementChild.textContent = text;
}

function loadModels() {
  if (models.loading) return models.loading;
  models.loading = (async () => {
    ui.btnLoad.disabled = true;
    try { localStorage.setItem(LOAD_FLAG, String(Date.now())); } catch {}
    try {
      // Pas laden als de service worker de downloads kan opvangen, anders
      // werkt de app de volgende keer niet offline.
      await serviceWorkerControl();
      if (!models.who) {
        setPill(ui.pillWho, "loading", "Who: laden…");
        const { Who } = await import("@desert-ant-labs/who");
        models.who = await Who.load({
          litertWasmDir: new URL("litert/", location.href).href,
          onProgress: (f) => setPill(ui.pillWho, "loading", `Who: ${pct(f)}`),
        });
        setPill(ui.pillWho, "ready", "Who: klaar");
      }
      if (!models.voz) {
        setPill(ui.pillVoz, "loading", "Voz: laden…");
        models.voz = await loadVoz((f) => setPill(ui.pillVoz, "loading", `Voz: ${pct(f)}`));
        setPill(ui.pillVoz, "ready", "Voz: klaar");
      }
      updateOfflinePill();
      ui.btnLoad.hidden = true;
      if (!rec.active && !busy) setStatus("Klaar. Druk op de opnameknop of kies een audiobestand.");
    } catch (err) {
      console.error(err);
      if (!models.who) setPill(ui.pillWho, "error", "Who: fout");
      if (!models.voz) setPill(ui.pillVoz, "error", "Voz: fout");
      setStatus(`<strong>Laden mislukt.</strong> ${escapeHtml(friendlyError(err))}`);
      ui.btnLoad.disabled = false;
      models.loading = null;
      throw err;
    } finally {
      try { localStorage.removeItem(LOAD_FLAG); } catch {}
    }
  })();
  return models.loading;
}

// Voz draait bij voorkeur in een worker. Lukt dat niet (bijvoorbeeld omdat
// de browser WebGPU niet in workers aanbiedt), dan in de pagina zelf.
async function loadVoz(onProgress) {
  const wasmDir = new URL("ort/", location.href).href;
  try {
    const worker = new Worker(new URL("./voz-worker.js", import.meta.url), { type: "module" });
    const calls = new Map();
    let next = 0;
    const call = (msg, progress, transfer) => new Promise((resolve, reject) => {
      const id = ++next;
      calls.set(id, { resolve, reject, progress });
      worker.postMessage({ ...msg, id }, transfer ?? []);
    });
    worker.onmessage = ({ data }) => {
      const c = calls.get(data.id);
      if (!c) return;
      if (data.progress != null) return c.progress?.(data.progress);
      calls.delete(data.id);
      data.error ? c.reject(new Error(data.error)) : c.resolve(data.result);
    };
    worker.onerror = (e) => {
      for (const c of calls.values()) c.reject(new Error(e.message || "Voz-worker gestopt"));
      calls.clear();
    };
    await call({ type: "load", wasmDir, cache: !HAS_SW }, onProgress);
    return {
      // De samples worden overgedragen, dus altijd een kopie meegeven.
      transcribe: (samples, opts = {}) => {
        const copy = samples.slice();
        return call({ type: "transcribe", samples: copy }, opts.onProgress, [copy.buffer]);
      },
    };
  } catch (err) {
    console.warn("Voz in worker mislukt, verder in de pagina:", err);
    const { Voz } = await import("@desert-ant-labs/voz");
    return Voz.load({ wasmDir, onProgress, cache: !HAS_SW });
  }
}

function friendlyError(err) {
  const msg = String(err?.message ?? err);
  if (/Float16Array/i.test(msg)) return "Deze browser mist Float16Array. Werk iPadOS/Safari bij (Safari 26 of nieuwer).";
  if (/fetch|network|HTTP/i.test(msg)) return `Download mislukt; controleer de internetverbinding. (${msg})`;
  return msg;
}

async function modelsCached() {
  try {
    if (!HAS_SW) return (await caches.keys()).some((k) => k.startsWith("desert-ant-voz"));
    const urls = (await (await caches.open(MODEL_CACHE)).keys()).map((r) => r.url);
    return ["/desert-ant-labs/voz/", "/desert-ant-labs/who/"].every((m) => urls.some((u) => u.includes(m)));
  } catch { return false; }
}

// ---------- Offline ----------

async function registerServiceWorker() {
  if (!HAS_SW) return;
  try {
    const reg = await navigator.serviceWorker.register("sw.js");
    // Een nieuwe versie direct gebruiken zolang er nog niets loopt.
    if (reg.waiting && navigator.serviceWorker.controller) {
      navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true });
      reg.waiting.postMessage("skipWaiting");
      return;
    }
    navigator.serviceWorker.addEventListener("controllerchange", updateOfflinePill);
    navigator.storage?.persist?.().catch(() => {});
  } catch (err) {
    console.warn("Service worker niet geregistreerd:", err);
  }
}

// Wacht (maximaal tien seconden) tot de service worker deze pagina beheert.
async function serviceWorkerControl() {
  if (!HAS_SW || navigator.serviceWorker.controller) return;
  await Promise.race([
    new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true })),
    new Promise((resolve) => setTimeout(resolve, 10000)),
  ]);
}

async function updateOfflinePill() {
  if (!HAS_SW) return setPill(ui.pillOffline, "error", "Offline: niet mogelijk");
  const app = !!navigator.serviceWorker.controller;
  const cached = app && (await modelsCached());
  setPill(ui.pillOffline, cached ? "ready" : "idle", cached ? "Offline: klaar" : "Offline: nog niet");
}

// ---------- Opnemen ----------

const WORKLET = `
class Recorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / ${RATE};
    this.pos = 0; this.acc = 0; this.cnt = 0;
    this.buf = new Float32Array(${RATE / 4}); this.n = 0; this.sq = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channels = input.length, len = input[0].length;
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let c = 0; c < channels; c++) s += input[c][i];
      this.acc += s / channels; this.cnt++; this.pos++;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = this.acc / this.cnt;
        this.acc = 0; this.cnt = 0;
        this.buf[this.n++] = v; this.sq += v * v;
        if (this.n === this.buf.length) {
          this.port.postMessage({ samples: this.buf, rms: Math.sqrt(this.sq / this.n) }, [this.buf.buffer]);
          this.buf = new Float32Array(${RATE / 4}); this.n = 0; this.sq = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("recorder", Recorder);
`;

async function startRecording() {
  if (busy) return;
  if (audio && !confirm("De huidige opname en tekst worden vervangen. Doorgaan?")) return;
  // De AudioContext moet binnen de tik ontstaan, anders blijft hij op iOS stil.
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });
  } catch (err) {
    ctx.close();
    setStatus(`<strong>Geen toegang tot de microfoon.</strong> ${escapeHtml(err.message)}. Sta de microfoon toe in Safari (aA-menu › Website-instellingen).`);
    return;
  }
  await ctx.resume();
  const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);

  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "recorder", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(node).connect(sink).connect(ctx.destination);
  node.port.onmessage = ({ data }) => {
    rec.chunks.push(data.samples);
    rec.total += data.samples.length;
    ui.level.style.width = `${Math.min(100, Math.round(Math.sqrt(data.rms) * 160))}%`;
  };
  ctx.onstatechange = () => {
    if (rec.active && ctx.state !== "running") {
      setStatus("<strong>Opname onderbroken</strong> door het systeem (bijvoorbeeld een ander geluid of app). Tik op stop en begin opnieuw als dat nodig is.");
    }
  };

  clearResult();
  Object.assign(rec, { active: true, ctx, stream, node, sink, chunks: [], total: 0, committed: 0, startedAt: Date.now() });
  liveWords = [];
  ui.btnRec.dataset.recording = "true";
  ui.btnRec.setAttribute("aria-label", "Opname stoppen");
  ui.btnImport.classList.add("disabled");
  ui.fileInput.disabled = true;
  rec.timerId = setInterval(() => { ui.timer.textContent = clock(rec.total / RATE); }, 250);
  rec.liveId = setInterval(liveTick, 2000);
  keepAwake(true);
  setStatus(models.voz
    ? "<strong>Opname loopt.</strong> De tekst verschijnt per blok van ongeveer 20 seconden."
    : "<strong>Opname loopt.</strong> Modellen zijn nog niet geladen; de tekst volgt na het stoppen.");
  updateButtons();
}

async function stopRecording() {
  if (!rec.active) return;
  rec.active = false;
  clearInterval(rec.timerId);
  clearInterval(rec.liveId);
  rec.node.port.onmessage = null;
  rec.stream.getTracks().forEach((t) => t.stop());
  await rec.ctx.close().catch(() => {});
  ui.level.style.width = "0%";
  ui.btnRec.dataset.recording = "false";
  ui.btnRec.setAttribute("aria-label", "Opname starten");
  ui.fileInput.disabled = false;
  ui.btnImport.classList.remove("disabled");
  audio = concat(rec.chunks, rec.total);
  rec.chunks = [];
  ui.timer.textContent = clock(audio.length / RATE);
  if (audio.length < RATE) {
    setStatus("Opname is te kort om te verwerken.");
    keepAwake(false);
    updateButtons();
    return;
  }
  await process({ fromLive: true });
}

function currentSamples(from, to) {
  // Kopieert [from, to) uit de lopende lijst met blokken.
  const out = new Float32Array(to - from);
  let offset = 0, written = 0;
  for (const c of rec.chunks) {
    const end = offset + c.length;
    if (end > from && offset < to) {
      const a = Math.max(from, offset) - offset, b = Math.min(to, end) - offset;
      out.set(c.subarray(a, b), written);
      written += b - a;
    }
    offset = end;
    if (offset >= to) break;
  }
  return out;
}

function liveTick() {
  if (!rec.active || !models.voz || rec.liveBusy) return;
  const available = rec.total - rec.committed;
  if (available < LIVE_MIN_SECONDS * RATE) return;
  const from = rec.committed, to = rec.total;
  rec.liveBusy = (async () => {
    try {
      const r = await models.voz.transcribe(currentSamples(from, to));
      const length = (to - from) / RATE, offset = from / RATE;
      const force = length >= LIVE_MAX_SECONDS;
      const keep = force ? r.words : r.words.filter((w) => w.end <= length - LIVE_TAIL_SECONDS);
      if (keep.length) {
        liveWords.push(...keep.map((w) => ({ text: w.text, start: w.start + offset, end: w.end + offset })));
        rec.committed = force ? to : from + Math.round(keep[keep.length - 1].end * RATE);
      } else if (!r.words.length) {
        // Stilte: alles behalve de laatste seconden overslaan.
        rec.committed = Math.max(from, to - 2 * RATE);
      }
      renderLive();
    } catch (err) {
      console.error(err);
    } finally {
      rec.liveBusy = null;
    }
  })();
}

// ---------- Verwerken ----------

async function process({ fromLive }) {
  busy = true;
  updateButtons();
  keepAwake(true);
  try {
    if (!models.voz || !models.who) {
      setStatus("<strong>Modellen laden…</strong>");
      await loadModels();
    }
    if (fromLive && rec.liveBusy) {
      setStatus("<strong>Laatste blok afronden…</strong>");
      await rec.liveBusy;
    }
    const start = fromLive ? rec.committed : 0;
    if (!fromLive) liveWords = [];
    if (audio.length - start > RATE / 4) {
      setStatus(fromLive && start > 0 ? "<strong>Laatste deel transcriberen…</strong>" : "<strong>Transcriberen…</strong>");
      showProgress(0);
      const r = await models.voz.transcribe(audio.subarray(start), { onProgress: showProgress });
      const offset = start / RATE;
      liveWords.push(...r.words.map((w) => ({ text: w.text, start: w.start + offset, end: w.end + offset })));
      renderLive();
    }
    setStatus("<strong>Sprekers onderscheiden…</strong>");
    showProgress(null);
    let diar = await models.who.diarize({ samples: audio, sampleRate: RATE });
    if (diar.speakerCount > 1) diar = diar.keepingSpeakers({ minimumShare: MIN_SPEAKER_SHARE });
    result = buildResult(liveWords, diar, audio.length / RATE);
    liveWords = [];
    save();
    render();
    const n = result.speakers.length;
    setStatus(`Klaar: ${n} ${n === 1 ? "spreker" : "sprekers"}, ${clock(result.duration)} audio. Tik op een naam om die te wijzigen.`);
  } catch (err) {
    console.error(err);
    setStatus(`<strong>Verwerking mislukt.</strong> ${escapeHtml(friendlyError(err))}`);
  } finally {
    hideProgress();
    busy = false;
    keepAwake(false);
    updateButtons();
  }
}

async function importFile(file) {
  if (!file || busy || rec.active) return;
  if (audio && !confirm("De huidige opname en tekst worden vervangen. Doorgaan?")) return;
  clearResult();
  setStatus(`<strong>Bestand inlezen…</strong> ${escapeHtml(file.name)}`);
  try {
    audio = await decodeFile(file);
  } catch (err) {
    console.error(err);
    setStatus(`<strong>Dit bestand kan niet worden gelezen.</strong> ${escapeHtml(err.message ?? String(err))}`);
    return;
  }
  ui.timer.textContent = clock(audio.length / RATE);
  await process({ fromLive: false });
}

async function decodeFile(file) {
  const bytes = await file.arrayBuffer();
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const buffer = await new Offline(1, 1, RATE).decodeAudioData(bytes);
  if (buffer.sampleRate === RATE && buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice();
  // Omzetten naar mono 16 kHz.
  const ctx = new Offline(1, Math.ceil(buffer.duration * RATE), RATE);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  return (await ctx.startRendering()).getChannelData(0);
}

// Koppelt elk woord aan de spreker wiens beurt er het meest mee overlapt.
function buildResult(words, diar, duration) {
  const turns = [...diar.turns].sort((a, b) => a.start - b.start);
  let first = 0;
  const assigned = words.map((w) => {
    while (first < turns.length && turns[first].end < w.start - 5) first++;
    let best = -1, bestOverlap = 0, nearest = -1, nearestDist = Infinity;
    const mid = (w.start + w.end) / 2;
    for (let i = first; i < turns.length && turns[i].start <= w.end + 5; i++) {
      const t = turns[i];
      const overlap = Math.min(w.end, t.end) - Math.max(w.start, t.start);
      if (overlap > bestOverlap) { bestOverlap = overlap; best = t.speaker; }
      const dist = mid < t.start ? t.start - mid : mid > t.end ? mid - t.end : 0;
      if (dist < nearestDist) { nearestDist = dist; nearest = t.speaker; }
    }
    return { ...w, speaker: best >= 0 ? best : nearestDist <= 2 ? nearest : -1 };
  });
  // Woorden zonder beurt erven de spreker van het vorige woord.
  let last = assigned.find((w) => w.speaker >= 0)?.speaker ?? 0;
  for (const w of assigned) { if (w.speaker < 0) w.speaker = last; else last = w.speaker; }

  const segments = [];
  for (const w of assigned) {
    const seg = segments[segments.length - 1];
    if (seg && seg.speaker === w.speaker && w.start - seg.end < PARAGRAPH_GAP) {
      seg.words.push(w.text); seg.end = w.end;
    } else {
      segments.push({ speaker: w.speaker, start: w.start, end: w.end, words: [w.text] });
    }
  }
  const spoken = new Map();
  for (const t of turns) spoken.set(t.speaker, (spoken.get(t.speaker) ?? 0) + (t.end - t.start));
  const used = [...new Set(segments.map((s) => s.speaker))].sort((a, b) => a - b);
  const totalSpoken = used.reduce((sum, id) => sum + (spoken.get(id) ?? 0), 0) || 1;
  return {
    duration,
    names: Object.fromEntries(used.map((id, i) => [id, `Spreker ${i + 1}`])),
    speakers: used.map((id) => ({ id, share: (spoken.get(id) ?? 0) / totalSpoken })),
    segments: segments.map((s) => ({ speaker: s.speaker, start: s.start, end: s.end, text: joinWords(s.words) })),
  };
}

function joinWords(words) {
  return words.join(" ").replace(/\s+([,.!?;:%)\]])/g, "$1").replace(/([(\[])\s+/g, "$1").replace(/\s{2,}/g, " ").trim();
}

// ---------- Weergave ----------

function speakerColor(id) {
  const index = result ? result.speakers.findIndex((s) => s.id === id) : id;
  return `var(--s${Math.max(0, index) % 8})`;
}

function render() {
  ui.segments.textContent = "";
  ui.empty.hidden = !!(result?.segments.length || liveWords.length);
  if (!result) {
    ui.speakers.innerHTML = '<span class="label">Sprekers verschijnen na verwerking. Tik op een naam om die aan te passen.</span>';
    renderLive();
    return;
  }
  ui.speakers.innerHTML = '<span class="label">Sprekers</span>';
  for (const s of result.speakers) {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.innerHTML = `<span class="sw" style="background:${speakerColor(s.id)}"></span><span></span><span class="share">${Math.round(s.share * 100)}%</span>`;
    chip.children[1].textContent = result.names[s.id];
    chip.onclick = () => rename(s.id);
    ui.speakers.append(chip);
  }
  const frag = document.createDocumentFragment();
  for (const seg of result.segments) {
    const el = document.createElement("div");
    el.className = "seg";
    el.style.setProperty("--c", speakerColor(seg.speaker));
    el.innerHTML = '<div class="who"><b></b><time></time></div><p></p>';
    el.querySelector("b").textContent = result.names[seg.speaker];
    el.querySelector("b").onclick = () => rename(seg.speaker);
    el.querySelector("time").textContent = clock(seg.start);
    el.querySelector("p").textContent = seg.text;
    frag.append(el);
  }
  ui.segments.append(frag);
}

function renderLive() {
  ui.segments.querySelectorAll(".seg.live").forEach((el) => el.remove());
  if (!liveWords.length) return;
  ui.empty.hidden = true;
  const stick = ui.scroll.scrollHeight - ui.scroll.scrollTop - ui.scroll.clientHeight < 60;
  const paragraphs = [];
  for (const w of liveWords) {
    const p = paragraphs[paragraphs.length - 1];
    if (p && w.start - p.end < PARAGRAPH_GAP) { p.words.push(w.text); p.end = w.end; }
    else paragraphs.push({ start: w.start, end: w.end, words: [w.text] });
  }
  const frag = document.createDocumentFragment();
  for (const p of paragraphs) {
    const el = document.createElement("div");
    el.className = "seg live";
    el.innerHTML = '<div class="who"><b>…</b><time></time></div><p></p>';
    el.querySelector("time").textContent = clock(p.start);
    el.querySelector("p").textContent = joinWords(p.words);
    frag.append(el);
  }
  ui.segments.append(frag);
  if (stick) ui.scroll.scrollTop = ui.scroll.scrollHeight;
}

function rename(id) {
  const name = prompt("Naam van deze spreker", result.names[id]);
  if (name == null || !name.trim()) return;
  result.names[id] = name.trim();
  save();
  render();
}

function setStatus(html) { ui.status.innerHTML = html; }

function showProgress(f) {
  ui.progress.classList.add("on");
  ui.progress.firstElementChild.style.width = f == null ? "100%" : `${Math.round(f * 100)}%`;
  ui.progress.firstElementChild.style.opacity = f == null ? ".35" : "1";
}
function hideProgress() { ui.progress.classList.remove("on"); }

function updateButtons() {
  const hasText = !!result?.segments.length;
  ui.btnRec.disabled = busy;
  ui.btnCopy.disabled = !hasText;
  ui.btnTxt.disabled = !hasText;
  ui.btnWav.disabled = !audio || rec.active;
  ui.btnClear.disabled = rec.active || busy || (!hasText && !audio);
  ui.fileInput.disabled = rec.active || busy;
}

function toast(text) {
  ui.toast.textContent = text;
  ui.toast.classList.add("on");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => ui.toast.classList.remove("on"), 1800);
}

// ---------- Export en opslag ----------

function asText() {
  return result.segments.map((s) => `[${clock(s.start)}] ${result.names[s.speaker]}: ${s.text}`).join("\n\n") + "\n";
}

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function wav(samples) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true); view.setUint32(28, RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view], { type: "audio/wav" });
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(result)); } catch {}
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved?.segments?.length) { result = saved; ui.timer.textContent = clock(saved.duration); }
  } catch {}
}

function clearResult() {
  result = null; audio = null; liveWords = [];
  try { localStorage.removeItem(STORE_KEY); } catch {}
  ui.timer.textContent = "00:00";
  render();
  updateButtons();
}

// ---------- Hulpmiddelen ----------

function concat(chunks, total) {
  const out = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function clock(seconds) {
  const s = Math.floor(seconds), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(r)}` : `${p(m)}:${p(r)}`;
}

function pct(f) { return `${Math.round((f ?? 0) * 100)}%`; }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function keepAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!on && wakeLock && !rec.active && !busy) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {}
}

// ---------- Start ----------

ui.btnLoad.onclick = () => loadModels().catch(() => {});
ui.btnRec.onclick = () => (rec.active ? stopRecording() : startRecording());
ui.fileInput.onchange = () => { const f = ui.fileInput.files[0]; ui.fileInput.value = ""; importFile(f); };
ui.btnCopy.onclick = async () => {
  try { await navigator.clipboard.writeText(asText()); toast("Tekst gekopieerd"); }
  catch { toast("Kopiëren lukt niet in deze browser"); }
};
ui.btnTxt.onclick = () => download(new Blob([asText()], { type: "text/plain;charset=utf-8" }), `transcript_${stamp()}.txt`);
ui.btnWav.onclick = () => download(wav(audio), `opname_${stamp()}.wav`);
ui.btnClear.onclick = () => { if (confirm("Opname en tekst wissen?")) { clearResult(); setStatus("Gewist."); } };
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && (rec.active || busy)) keepAwake(true);
});
window.addEventListener("beforeunload", (e) => {
  if (rec.active || busy || (audio && !result)) { e.preventDefault(); e.returnValue = ""; }
});

restore();
render();
updateButtons();
registerServiceWorker().then(updateOfflinePill);

if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
  setStatus("<strong>Microfoon niet beschikbaar.</strong> Open deze pagina via https (of localhost); vanaf een los bestand werkt opnemen niet.");
}

(async () => {
  let crashed = null;
  try { crashed = localStorage.getItem(LOAD_FLAG); } catch {}
  if (crashed) {
    try { localStorage.removeItem(LOAD_FLAG); } catch {}
    setStatus("<strong>De vorige laadpoging is afgebroken</strong>, waarschijnlijk door te weinig geheugen. Sluit andere tabbladen en apps en probeer opnieuw.");
    return;
  }
  if (await modelsCached()) loadModels().catch(() => {});
})();
