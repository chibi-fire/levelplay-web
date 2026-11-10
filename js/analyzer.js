// 解析キュー: 曲を順番にデコードしてラウドネスを測る。
// 結果はこのページを開いている間だけメモリに持つ（ブラウザには保存しない）。

import { measureLoudness } from "./loudness.js";

const MAX_PARALLEL = 2;
// 1曲あたりデコード後のサンプル数の上限（全チャンネル合計）。約 320MB。
// 長い録音はサンプルレートを下げてデコードし、メモリ不足を避ける。
const SAMPLE_BUDGET = 80_000_000;
const MIN_RATE = 16000;
const MAX_RATE = 48000;

// 再生時間だけを先に読む（デコード時のサンプルレートを決めるため）
function probeDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = new Audio();
    a.preload = "metadata";
    const done = (d) => {
      a.removeAttribute("src");
      a.load();
      URL.revokeObjectURL(url);
      resolve(d);
    };
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? a.duration : NaN);
    a.onerror = () => done(NaN);
    a.src = url;
  });
}

function chooseRate(duration) {
  if (!Number.isFinite(duration) || duration <= 0) return MAX_RATE;
  const r = Math.floor(SAMPLE_BUDGET / (duration * 2));
  return Math.max(MIN_RATE, Math.min(MAX_RATE, r));
}

export class Analyzer {
  constructor(onUpdate) {
    this.onUpdate = onUpdate; // (track) => void
    this.queue = [];
    this.running = new Set();
    this.memo = new Map(); // ファイル名+サイズ+更新日時 → 結果（メモリのみ）
  }

  key(file) {
    return `${file.name}|${file.size}|${file.lastModified}`;
  }

  enqueue(track, front = false) {
    if (track.status !== "pending") return;
    const hit = this.memo.get(this.key(track.file));
    if (hit) {
      Object.assign(track, hit, { status: "done" });
      this.onUpdate(track);
      return;
    }
    if (front) {
      this.queue = this.queue.filter((t) => t !== track);
      this.queue.unshift(track);
    } else if (!this.queue.includes(track)) {
      this.queue.push(track);
    }
    this.pump();
  }

  // 再生しようとした曲を最優先にする
  prioritize(track) {
    if (track.status === "pending") this.enqueue(track, true);
  }

  cancel(track) {
    this.queue = this.queue.filter((t) => t !== track);
    track.cancelled = true;
  }

  clear() {
    for (const t of this.queue) t.cancelled = true;
    for (const t of this.running) t.cancelled = true;
    this.queue = [];
    this.memo.clear();
  }

  get busyCount() {
    return this.queue.length + this.running.size;
  }

  pump() {
    while (this.running.size < MAX_PARALLEL && this.queue.length > 0) {
      const track = this.queue.shift();
      if (track.cancelled || track.status !== "pending") continue;
      this.running.add(track);
      this.run(track).finally(() => {
        // 実行中の一覧から外してから通知する（残り件数の表示を正しくするため）
        this.running.delete(track);
        if (!track.cancelled) this.onUpdate(track);
        this.pump();
      });
    }
  }

  async run(track) {
    track.status = "analyzing";
    this.onUpdate(track);
    try {
      const duration = await probeDuration(track.file);
      if (track.cancelled) return;
      const rate = chooseRate(duration);
      const data = await track.file.arrayBuffer();
      if (track.cancelled) return;
      // デコードは OfflineAudioContext で行う（音は鳴らない）。指定レートへ変換される。
      const ctx = new OfflineAudioContext(1, 1, rate);
      let buffer;
      try {
        buffer = await ctx.decodeAudioData(data);
      } catch {
        throw new Error("この形式は読み込めません");
      }
      if (track.cancelled) return;
      const r = await measureLoudness(buffer, () => track.cancelled);
      buffer = null;
      const result = {
        lufs: r.lufs,
        peakDb: r.peakDb,
        duration: Number.isFinite(duration) ? duration : r.duration,
        analysisRate: r.sampleRate,
      };
      this.memo.set(this.key(track.file), result);
      Object.assign(track, result, { status: "done" });
    } catch (e) {
      if (track.cancelled) return;
      track.status = "error";
      track.error = e && e.message ? e.message : String(e);
    }
  }
}
