// 再生エンジン
// 経路: <audio>（デコード・速度変更）→ 補正ゲイン → リミッター → マスター音量 → スピーカー
// 補正ゲインは曲の再生開始時に1回だけ設定し、再生中は変えない（exe 版と同じ方針）。

const dbToLin = (db) => Math.pow(10, db / 20);

export class Player extends EventTarget {
  constructor() {
    super();
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.audio.preservesPitch = true;
    this.ctx = null;
    this.trackGain = null;
    this.master = null;
    this.url = null;
    this._volume = 1;
    this._speed = 1;
    this._normGainDb = 0;
    this._normalize = true;

    for (const ev of ["play", "pause", "ended", "timeupdate", "loadedmetadata", "error", "seeked"]) {
      this.audio.addEventListener(ev, () => this.dispatchEvent(new Event(ev)));
    }
  }

  // AudioContext はユーザー操作の後でないと音が出ないので、初回再生時に作る
  async ensureGraph() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") await this.ctx.resume();
      return;
    }
    const ctx = new AudioContext({ latencyHint: "playback" });
    await ctx.audioWorklet.addModule(new URL("./limiter-worklet.js", import.meta.url));
    const src = ctx.createMediaElementSource(this.audio);
    this.trackGain = ctx.createGain();
    const limiter = new AudioWorkletNode(ctx, "levelplay-limiter");
    this.master = ctx.createGain();
    src.connect(this.trackGain).connect(limiter).connect(this.master).connect(ctx.destination);
    this.ctx = ctx;
    this.applyGain(false);
    this.master.gain.value = this._volume;
  }

  applyGain(smooth) {
    if (!this.trackGain) return;
    const g = this._normalize ? dbToLin(this._normGainDb) : 1;
    const p = this.trackGain.gain;
    if (smooth) {
      p.setTargetAtTime(g, this.ctx.currentTime, 0.03);
    } else {
      p.cancelScheduledValues(0);
      p.value = g;
    }
  }

  /** 曲を読み込んで再生する。gainDb はこの曲の補正量。 */
  async load(file, gainDb) {
    await this.ensureGraph();
    this.stopInternal();
    this._normGainDb = gainDb;
    this.applyGain(false);
    this.url = URL.createObjectURL(file);
    this.audio.src = this.url;
    this.audio.defaultPlaybackRate = this._speed;
    this.audio.playbackRate = this._speed;
    await this.audio.play();
  }

  // 再生中の曲を外し、blob URL を解放する（音源への参照をできるだけ早く手放す）
  stopInternal() {
    this.audio.pause();
    if (this.url) {
      this.audio.removeAttribute("src");
      this.audio.load();
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
  }

  stop() {
    this.stopInternal();
  }

  get hasTrack() {
    return !!this.url;
  }

  get paused() {
    return this.audio.paused;
  }

  async resume() {
    if (!this.url) return;
    await this.ensureGraph();
    await this.audio.play();
  }

  pause() {
    this.audio.pause();
  }

  get currentTime() {
    return this.audio.currentTime || 0;
  }

  get duration() {
    const d = this.audio.duration;
    return Number.isFinite(d) ? d : 0;
  }

  seek(sec) {
    if (this.url) this.audio.currentTime = Math.max(0, Math.min(sec, this.duration || sec));
  }

  set volume(v) {
    this._volume = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  set speed(s) {
    this._speed = s;
    this.audio.defaultPlaybackRate = s;
    this.audio.playbackRate = s;
  }

  // 補正のオン/オフは利用者の操作なので、再生中でもすぐ反映する（短いフェード付き）
  set normalize(on) {
    this._normalize = on;
    this.applyGain(true);
  }
}
