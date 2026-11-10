// LevelPlay Web 版の画面とキュー操作
//
// 方針: 読み込んだ曲（ファイル本体・曲名・フォルダの参照）はブラウザに保存しない。
// File オブジェクトをメモリに持つだけなので、タブやブラウザを閉じれば消え、
// 次に開いたときはキューが空になる。保存するのは音量・速度などの設定だけ。

import { Analyzer } from "./analyzer.js";
import { Player } from "./player.js";

const AUDIO_EXT = new Set(["mp3", "wav", "flac", "aac", "m4a", "ogg", "oga", "opus"]);
const MAX_BOOST_DB = 20;
const SETTINGS_KEY = "levelplay.settings.v1";
const REPEAT_LABEL = { none: "リピート: なし", all: "リピート: 全体", one: "リピート: 1曲" };
const REPEAT_NEXT = { none: "all", all: "one", one: "none" };

const $ = (id) => document.getElementById(id);
const el = {
  nowTitle: $("nowTitle"), nowSub: $("nowSub"), seek: $("seek"), pos: $("posText"), dur: $("durText"),
  play: $("btnPlay"), prev: $("btnPrev"), next: $("btnNext"), stop: $("btnStop"), repeat: $("btnRepeat"),
  normalize: $("chkNormalize"), target: $("selTarget"), speed: $("selSpeed"), volume: $("volume"), volText: $("volText"),
  list: $("list"), empty: $("empty"), count: $("countText"), queue: $("dropZone"),
  addFiles: $("btnAddFiles"), addFolder: $("btnAddFolder"), remove: $("btnRemove"), clear: $("btnClear"),
  fileInput: $("fileInput"), folderInput: $("folderInput"), toast: $("toast"),
};

// ---- 設定（曲の情報は含めない） ----
const settings = { volume: 100, speed: 1, repeat: "none", normalize: true, target: -14 };
try {
  const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  for (const k of Object.keys(settings)) if (k in s && typeof s[k] === typeof settings[k]) settings[k] = s[k];
} catch { /* 保存領域が使えない環境でも既定値で動く */ }
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* 無視 */ }
}

// ---- 状態 ----
let tracks = [];
let current = null;        // 再生中（または一時停止中）の曲
let waitingFor = null;     // 解析が終わったら再生を始める曲
let selected = new Set();
let anchor = null;         // Shift 選択の起点
let nextId = 1;
let errorStreak = 0;

const analyzer = new Analyzer(onAnalyzed);
const player = new Player();

// ---- 表示用 ----
const fmtTime = (sec) => {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
};
const fmtDb = (db) => (db > 0 ? "+" : db < 0 ? "−" : "±") + Math.abs(db).toFixed(1);

function gainFor(track) {
  if (track.status !== "done" || !Number.isFinite(track.lufs)) return 0;
  return Math.min(MAX_BOOST_DB, settings.target - track.lufs);
}

function statusText(t) {
  switch (t.status) {
    case "pending": return "解析待ち";
    case "analyzing": return "解析中…";
    case "error": return t.error || "解析に失敗しました";
    case "done": {
      if (!Number.isFinite(t.lufs)) return "無音（補正なし）";
      let s = `${t.lufs.toFixed(1)} LUFS  /  補正 ${fmtDb(gainFor(t))} dB`;
      if (t.analysisRate && t.analysisRate < 44100) s += `  （長時間のため ${Math.round(t.analysisRate / 1000)}kHz で解析）`;
      if (t.playError) s = t.playError;
      return s;
    }
  }
  return "";
}

let toastTimer = 0;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("show"), 3200);
}

// ---- キュー一覧の描画 ----
function rowFor(track) {
  return el.list.querySelector(`[data-id="${track.id}"]`);
}

function buildRow(track) {
  const li = document.createElement("li");
  li.className = "row";
  li.dataset.id = track.id;
  li.draggable = true;
  li.innerHTML = `<span class="mark"></span><span class="name"></span><span class="dur"></span><span class="stat"></span>`;
  li.querySelector(".name").textContent = track.name;
  li.querySelector(".name").title = track.path || track.name;
  return li;
}

function updateRow(track) {
  const li = rowFor(track);
  if (!li) return;
  li.classList.toggle("playing", track === current);
  li.classList.toggle("selected", selected.has(track));
  li.querySelector(".mark").textContent = track === current ? (player.paused ? "❚❚" : "▶") : "";
  li.querySelector(".dur").textContent = track.duration ? fmtTime(track.duration) : "";
  const st = li.querySelector(".stat");
  st.textContent = statusText(track);
  st.classList.toggle("error", track.status === "error" || !!track.playError);
}

function renderList() {
  el.list.replaceChildren(...tracks.map(buildRow));
  tracks.forEach(updateRow);
  renderMeta();
}

function renderMeta() {
  const busy = analyzer.busyCount;
  el.count.textContent = `${tracks.length} 曲` + (busy > 0 ? `（解析中 残り ${busy}）` : "");
  el.empty.hidden = tracks.length > 0;
  el.remove.disabled = selected.size === 0;
  el.clear.disabled = tracks.length === 0;
}

function renderNow() {
  if (!current) {
    el.nowTitle.textContent = "再生していません";
    el.nowSub.textContent = tracks.length ? "曲をダブルクリックすると再生します" : "準備完了";
  } else {
    el.nowTitle.textContent = current.name;
    if (waitingFor === current) {
      el.nowSub.textContent = "音量を解析しています。終わりしだい再生します…";
    } else if (current.status === "done" && Number.isFinite(current.lufs)) {
      el.nowSub.textContent = settings.normalize
        ? `${current.lufs.toFixed(1)} LUFS → 目標 ${settings.target} LUFS（補正 ${fmtDb(current.appliedGain ?? 0)} dB）`
        : `${current.lufs.toFixed(1)} LUFS（補正オフ）`;
    } else {
      el.nowSub.textContent = "補正なしで再生中";
    }
  }
  const playing = current && !player.paused;
  el.play.textContent = playing ? "⏸" : "▶";
  el.play.setAttribute("aria-label", playing ? "一時停止" : "再生");
  el.seek.disabled = !player.hasTrack;
  if (!player.hasTrack) {
    el.seek.value = 0;
    el.pos.textContent = "0:00";
    el.dur.textContent = current?.duration ? fmtTime(current.duration) : "0:00";
  }
  updateMediaSession();
}

// ---- 追加 ----
function extOf(name) {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

function addFiles(items) {
  // items: { file, path }[]
  const accepted = [];
  let skipped = 0;
  for (const { file, path } of items) {
    if (!AUDIO_EXT.has(extOf(file.name))) { skipped++; continue; }
    accepted.push({ id: nextId++, file, name: file.name, path, status: "pending" });
  }
  accepted.sort((a, b) => (a.path || a.name).localeCompare(b.path || b.name, "ja", { numeric: true }));
  if (accepted.length) {
    tracks.push(...accepted);
    renderList();
    for (const t of accepted) analyzer.enqueue(t);
    renderNow();
  }
  if (skipped) toast(`対応していない形式のため ${skipped} 件を追加しませんでした`);
  else if (accepted.length) toast(`${accepted.length} 曲を追加しました`);
}

// ドロップされたフォルダの中身を再帰的に読む
async function collectEntries(dataTransfer) {
  const out = [];
  const entries = [];
  for (const item of dataTransfer.items) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    if (entry) entries.push(entry);
    else { const f = item.getAsFile(); if (f) out.push({ file: f, path: f.name }); }
  }
  const walk = async (entry) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: entry.fullPath.replace(/^\//, "") });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e);
      }
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

// ---- 再生 ----
async function playTrack(track) {
  if (!track) return;
  current = track;
  track.playError = null;
  if (track.status === "pending" || track.status === "analyzing") {
    // 解析前に再生すると、あとで音量が急に変わってしまう。終わるまで待つ。
    player.stop();
    waitingFor = track;
    analyzer.prioritize(track);
    tracks.forEach(updateRow);
    renderNow();
    return;
  }
  waitingFor = null;
  // 補正のオン/オフは Player 側で切り替えるので、ここでは常に曲の補正量を渡す
  const gain = gainFor(track);
  track.appliedGain = gain;
  try {
    await player.load(track.file, gain);
    errorStreak = 0;
  } catch (e) {
    if (e && e.name === "AbortError") return; // 別の曲に切り替えた
    onPlayError(track);
    return;
  }
  tracks.forEach(updateRow);
  renderNow();
}

function onPlayError(track) {
  track.playError = "この曲は再生できません";
  updateRow(track);
  errorStreak++;
  if (errorStreak < tracks.length) {
    const n = neighbor(track, +1, settings.repeat !== "none");
    if (n) { playTrack(n); return; }
  }
  stopAll();
}

function neighbor(track, dir, wrap) {
  const i = tracks.indexOf(track);
  if (i < 0) return tracks[0] || null;
  let j = i + dir;
  if (j >= tracks.length) j = wrap ? 0 : -1;
  if (j < 0 && dir < 0) j = wrap ? tracks.length - 1 : -1;
  return j >= 0 ? tracks[j] : null;
}

function stopAll() {
  player.stop();
  waitingFor = null;
  current = null;
  tracks.forEach(updateRow);
  renderNow();
}

function togglePlay() {
  if (waitingFor) return;
  if (current && player.hasTrack) {
    if (player.paused) player.resume();
    else player.pause();
  } else {
    const first = [...selected][0] || tracks[0];
    if (first) playTrack(first);
  }
}

function playNext(manual) {
  if (!current) { if (tracks[0]) playTrack(tracks[0]); return; }
  const n = neighbor(current, +1, manual || settings.repeat === "all");
  if (n) playTrack(n);
  else stopAll();
}

function playPrev() {
  if (current && player.currentTime > 3) { player.seek(0); return; }
  const p = current ? neighbor(current, -1, true) : tracks[0];
  if (p) playTrack(p);
}

player.addEventListener("ended", () => {
  if (!current) return;
  if (settings.repeat === "one") playTrack(current);
  else playNext(false);
});
player.addEventListener("error", () => {
  if (current && player.hasTrack) onPlayError(current);
});
for (const ev of ["play", "pause"]) {
  player.addEventListener(ev, () => { if (current) updateRow(current); renderNow(); });
}

// 解析が1曲終わるたびに呼ばれる
function onAnalyzed(track) {
  updateRow(track);
  renderMeta();
  if (waitingFor === track && (track.status === "done" || track.status === "error")) {
    waitingFor = null;
    playTrack(track);
  }
}

// ---- シークバー ----
let seeking = false;
function updateSeek() {
  if (seeking || !player.hasTrack) return;
  const d = player.duration;
  el.seek.value = d ? Math.round((player.currentTime / d) * 1000) : 0;
  el.pos.textContent = fmtTime(player.currentTime);
  el.dur.textContent = fmtTime(d);
}
player.addEventListener("timeupdate", updateSeek);
player.addEventListener("loadedmetadata", () => {
  if (current && !current.duration) { current.duration = player.duration; updateRow(current); }
  updateSeek();
});
el.seek.addEventListener("input", () => {
  seeking = true;
  el.pos.textContent = fmtTime((el.seek.value / 1000) * player.duration);
});
el.seek.addEventListener("change", () => {
  player.seek((el.seek.value / 1000) * player.duration);
  seeking = false;
});

// ---- ボタン・設定 ----
el.play.addEventListener("click", togglePlay);
el.stop.addEventListener("click", stopAll);
el.next.addEventListener("click", () => playNext(true));
el.prev.addEventListener("click", playPrev);
el.repeat.addEventListener("click", () => {
  settings.repeat = REPEAT_NEXT[settings.repeat];
  el.repeat.textContent = REPEAT_LABEL[settings.repeat];
  saveSettings();
});
el.normalize.addEventListener("change", () => {
  settings.normalize = el.normalize.checked;
  player.normalize = settings.normalize;
  saveSettings();
  renderNow();
});
el.target.addEventListener("change", () => {
  settings.target = Number(el.target.value);
  saveSettings();
  // 再生中の曲は変えない。次の曲から新しい目標で補正する。
  tracks.forEach(updateRow);
  if (current && player.hasTrack) toast("新しい目標は次の曲から反映されます");
  renderNow();
});
el.speed.addEventListener("change", () => {
  settings.speed = Number(el.speed.value);
  player.speed = settings.speed;
  saveSettings();
});
el.volume.addEventListener("input", () => {
  settings.volume = Number(el.volume.value);
  player.volume = settings.volume / 100;
  el.volText.textContent = `${settings.volume}%`;
  saveSettings();
});

el.addFiles.addEventListener("click", () => el.fileInput.click());
el.addFolder.addEventListener("click", () => el.folderInput.click());
el.fileInput.addEventListener("change", () => {
  addFiles([...el.fileInput.files].map((f) => ({ file: f, path: f.name })));
  el.fileInput.value = "";
});
el.folderInput.addEventListener("change", () => {
  addFiles([...el.folderInput.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name })));
  el.folderInput.value = "";
});

function removeTracks(list) {
  const set = new Set(list);
  if (!set.size) return;
  for (const t of set) analyzer.cancel(t);
  if (current && set.has(current)) stopAll();
  tracks = tracks.filter((t) => !set.has(t));
  selected = new Set([...selected].filter((t) => !set.has(t)));
  renderList();
  renderNow();
}
el.remove.addEventListener("click", () => removeTracks([...selected]));
el.clear.addEventListener("click", () => {
  stopAll();
  analyzer.clear();
  tracks = [];
  selected.clear();
  renderList();
  renderNow();
});

// ---- 選択・ダブルクリック ----
const trackOf = (node) => {
  const li = node.closest?.(".row");
  return li ? tracks.find((t) => String(t.id) === li.dataset.id) : null;
};
el.list.addEventListener("click", (e) => {
  const t = trackOf(e.target);
  if (!t) return;
  if (e.shiftKey && anchor && tracks.includes(anchor)) {
    const [a, b] = [tracks.indexOf(anchor), tracks.indexOf(t)].sort((x, y) => x - y);
    if (!e.ctrlKey) selected.clear();
    for (let i = a; i <= b; i++) selected.add(tracks[i]);
  } else if (e.ctrlKey || e.metaKey) {
    selected.has(t) ? selected.delete(t) : selected.add(t);
    anchor = t;
  } else {
    selected = new Set([t]);
    anchor = t;
  }
  tracks.forEach(updateRow);
  renderMeta();
});
el.list.addEventListener("dblclick", (e) => {
  const t = trackOf(e.target);
  if (t) playTrack(t);
});

document.addEventListener("keydown", (e) => {
  const tag = e.target.tagName;
  if (tag === "INPUT" && e.target.type !== "range" && e.target.type !== "checkbox") return;
  if (tag === "SELECT") return;
  if (e.key === " " && tag !== "BUTTON") { e.preventDefault(); togglePlay(); }
  else if (e.key === "Delete" && selected.size) { removeTracks([...selected]); }
  else if (e.key === "Enter" && selected.size === 1 && document.activeElement === el.list) { playTrack([...selected][0]); }
  else if ((e.key === "a" || e.key === "A") && e.ctrlKey && document.activeElement === el.list) {
    e.preventDefault(); selected = new Set(tracks); tracks.forEach(updateRow); renderMeta();
  }
});

// ---- ドラッグ&ドロップ（外部ファイルの追加と、曲順の並べ替え） ----
const REORDER_TYPE = "application/x-levelplay-track";
let dragTrack = null;
let dragDepth = 0;

el.list.addEventListener("dragstart", (e) => {
  const t = trackOf(e.target);
  if (!t) return;
  dragTrack = t;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData(REORDER_TYPE, String(t.id));
});
el.list.addEventListener("dragend", () => { dragTrack = null; clearDropMarks(); });

function clearDropMarks() {
  el.list.querySelectorAll(".drag-over-top,.drag-over-bottom")
    .forEach((n) => n.classList.remove("drag-over-top", "drag-over-bottom"));
}
const isFileDrag = (e) => [...e.dataTransfer.types].includes("Files");

el.queue.addEventListener("dragenter", (e) => {
  if (isFileDrag(e)) { dragDepth++; el.queue.classList.add("dragging-files"); }
});
el.queue.addEventListener("dragleave", (e) => {
  if (isFileDrag(e) && --dragDepth <= 0) { dragDepth = 0; el.queue.classList.remove("dragging-files"); }
});
el.queue.addEventListener("dragover", (e) => {
  if (isFileDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; return; }
  if (!dragTrack) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  clearDropMarks();
  const li = e.target.closest?.(".row");
  if (li) {
    const r = li.getBoundingClientRect();
    li.classList.add(e.clientY < r.top + r.height / 2 ? "drag-over-top" : "drag-over-bottom");
  }
});
el.queue.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  el.queue.classList.remove("dragging-files");
  if (isFileDrag(e)) {
    try { addFiles(await collectEntries(e.dataTransfer)); }
    catch { toast("ファイルを読み込めませんでした"); }
    return;
  }
  if (!dragTrack) return;
  const li = e.target.closest?.(".row");
  const moving = selected.has(dragTrack) ? tracks.filter((t) => selected.has(t)) : [dragTrack];
  const rest = tracks.filter((t) => !moving.includes(t));
  let at = rest.length;
  if (li) {
    const over = trackOf(li);
    const r = li.getBoundingClientRect();
    const i = rest.indexOf(over);
    if (i >= 0) at = e.clientY < r.top + r.height / 2 ? i : i + 1;
    else at = tracks.indexOf(over) - moving.filter((t) => tracks.indexOf(t) < tracks.indexOf(over)).length;
  }
  rest.splice(at, 0, ...moving);
  tracks = rest; // 再生中の曲は参照で持っているので、並べ替えても追従する
  dragTrack = null;
  clearDropMarks();
  renderList();
});
// ウィンドウの他の場所に落としても、ブラウザがファイルを開かないようにする
window.addEventListener("dragover", (e) => { if (isFileDrag(e)) e.preventDefault(); });
window.addEventListener("drop", (e) => { if (isFileDrag(e) && !el.queue.contains(e.target)) e.preventDefault(); });

// ---- メディアキー（キーボードの再生ボタンなど） ----
function updateMediaSession() {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = current ? new MediaMetadata({ title: current.name, artist: "LevelPlay" }) : null;
  navigator.mediaSession.playbackState = current ? (player.paused ? "paused" : "playing") : "none";
}
if ("mediaSession" in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler("play", togglePlay);
  ms.setActionHandler("pause", togglePlay);
  ms.setActionHandler("previoustrack", playPrev);
  ms.setActionHandler("nexttrack", () => playNext(true));
  ms.setActionHandler("stop", stopAll);
}

// ---- 閉じるとき: 再生中の曲の参照を解放する ----
window.addEventListener("pagehide", () => {
  player.stop();
  analyzer.clear();
  tracks = [];
});

// ---- 初期表示 ----
el.normalize.checked = settings.normalize;
el.target.value = String(settings.target);
if (el.target.value === "") { settings.target = -14; el.target.value = "-14"; }
el.speed.value = String(settings.speed);
if (el.speed.value === "") { settings.speed = 1; el.speed.value = "1"; }
el.volume.value = settings.volume;
el.volText.textContent = `${settings.volume}%`;
el.repeat.textContent = REPEAT_LABEL[settings.repeat] || REPEAT_LABEL.none;
player.volume = settings.volume / 100;
player.speed = settings.speed;
player.normalize = settings.normalize;
renderList();
renderNow();

// アプリとしてインストールできるようにする（アプリ本体のファイルだけをキャッシュ）
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// 動作確認用（ローカルで開いたときだけ、開発者ツールから曲を追加できるようにする）
if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
  window.__levelplay = { addFiles, get tracks() { return tracks; }, player, analyzer, playTrack };
}
