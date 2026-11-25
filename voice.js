/*
 * VoiceTimer — times a spoken joke using the microphone.
 *
 * - Voice activity detection (Web Audio API) works in every modern browser:
 *   it can start the clock when you start talking, trims dead air at the end,
 *   and can stop automatically after a stretch of silence.
 * - Speech-to-text uses the browser's Web Speech API where available
 *   (Chrome, Edge, Safari). Firefox doesn't support it; timing still works.
 * - Without microphone access it falls back to a plain stopwatch.
 */
(function () {
  'use strict';

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const TICK_MS = 40;
  const CALIBRATE_MS = 400;   // listen to the room this long before detecting speech
  const SPEECH_FRAMES = 3;    // consecutive loud frames needed to count as speech
  const END_PAD_MS = 400;     // keep a little air after the last word

  class VoiceTimer {
    /**
     * @param {object} opts
     *  voiceTrigger  start the clock on first speech instead of on start()
     *  autoStop      stop after `silenceSec` of silence once speech was heard
     *  silenceSec    seconds of silence before auto-stop
     *  sensitivity   1 (needs loud speech) … 10 (picks up whispers)
     *  transcribe    run speech-to-text
     *  lang          BCP-47 language for speech-to-text
     *  onTick({elapsed, level, threshold, calibrating, waiting, speaking, silentFor})
     *  onTranscript(finalText, interimText)
     *  onAutoStop(result)
     *  onError(message)
     */
    constructor(opts) {
      this.opts = Object.assign({
        voiceTrigger: true, autoStop: false, silenceSec: 4, sensitivity: 5,
        transcribe: false, lang: navigator.language || 'en-US',
      }, opts);
      this.running = false;
      this.result = null;
    }

    static get speechSupported() { return !!SR; }
    static get micSupported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia); }

    get threshold() {
      const s = Math.min(10, Math.max(1, Number(this.opts.sensitivity) || 5));
      const k = 0.0035 * (11 - s);              // s=10 → 0.0035, s=5 → 0.021, s=1 → 0.035
      return Math.min(0.3, (this.floor || 0) * 2.5 + k);
    }

    async start() {
      this.running = true;
      this.result = null;
      this.micOk = false;
      this.firstSpeechAt = null;
      this.lastSpeechAt = null;
      this.loudFrames = 0;
      this.floor = null;
      this.calib = [];
      this.finalText = '';
      this.interim = '';
      this.speechBlocked = false;

      if (VoiceTimer.micSupported) {
        try {
          this.stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
          this.micOk = true;
        } catch (err) {
          this.emitError(err && err.name === 'NotAllowedError'
            ? 'Microphone access was blocked. Running as a plain stopwatch.'
            : 'No microphone found. Running as a plain stopwatch.');
        }
      } else {
        this.emitError('This browser can’t use the microphone here (it needs https or localhost). Running as a plain stopwatch.');
      }

      if (!this.running) { this.cleanup(); return; } // cancelled while waiting for permission

      if (this.micOk) {
        try {
          const AC = window.AudioContext || window.webkitAudioContext;
          this.ctx = new AC();
          if (this.ctx.state === 'suspended') await this.ctx.resume();
          const src = this.ctx.createMediaStreamSource(this.stream);
          this.analyser = this.ctx.createAnalyser();
          this.analyser.fftSize = 1024;
          src.connect(this.analyser);
          this.buf = new Float32Array(this.analyser.fftSize);
        } catch (err) {
          this.analyser = null;
          this.emitError('Couldn’t read the microphone level. Running as a plain stopwatch.');
        }
      }

      this.startAt = performance.now();
      if (this.opts.transcribe && SR && this.micOk) this.startRecognition();
      this.interval = setInterval(() => this.tick(), TICK_MS);
      this.tick();
    }

    get usesVoice() { return !!this.analyser; }

    tick() {
      if (!this.running) return;
      const now = performance.now();
      let level = 0;

      if (this.analyser) {
        this.analyser.getFloatTimeDomainData(this.buf);
        let sum = 0;
        for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
        level = Math.sqrt(sum / this.buf.length);

        if (this.floor == null) {
          this.calib.push(level);
          if (now - this.startAt >= CALIBRATE_MS) {
            const sorted = this.calib.slice().sort((a, b) => a - b);
            this.floor = sorted[Math.floor(sorted.length / 2)] || 0;
            if (!this.opts.voiceTrigger) this.firstSpeechAt = this.startAt;
          }
        } else if (level > this.threshold) {
          this.loudFrames++;
          if (this.loudFrames >= SPEECH_FRAMES) {
            if (this.firstSpeechAt == null) this.firstSpeechAt = now - SPEECH_FRAMES * TICK_MS;
            this.lastSpeechAt = now;
          }
        } else {
          this.loudFrames = 0;
        }
      }

      const clockStart = this.clockStart;
      const waiting = clockStart == null;
      const silentFor = this.lastSpeechAt == null ? null : now - this.lastSpeechAt;

      if (this.opts.autoStop && this.usesVoice && silentFor != null && silentFor > this.opts.silenceSec * 1000) {
        const result = this.stop('silence');
        if (this.opts.onAutoStop) this.opts.onAutoStop(result);
        return;
      }

      if (this.opts.onTick) {
        this.opts.onTick({
          elapsed: waiting ? 0 : now - clockStart,
          level,
          threshold: this.floor == null ? null : this.threshold,
          calibrating: this.usesVoice && this.floor == null,
          waiting,
          speaking: this.loudFrames >= SPEECH_FRAMES,
          silentFor,
          usesVoice: this.usesVoice,
        });
      }
    }

    /** When the clock started (ms, performance.now), or null if still waiting for speech. */
    get clockStart() {
      if (!this.usesVoice || !this.opts.voiceTrigger) return this.startAt;
      return this.firstSpeechAt;
    }

    stop(reason) {
      if (!this.running) return this.result;
      this.running = false;
      clearInterval(this.interval);
      const now = performance.now();
      const start = this.clockStart;
      let end = now;
      if (this.usesVoice && this.lastSpeechAt != null) end = Math.min(now, this.lastSpeechAt + END_PAD_MS);
      this.result = {
        durationMs: start == null ? 0 : Math.max(0, end - start),
        rawMs: start == null ? 0 : Math.max(0, now - start),
        heardSpeech: this.lastSpeechAt != null,
        usedVoice: this.usesVoice,
        reason: reason || 'manual',
      };
      if (this.rec) { try { this.rec.stop(); } catch (e) { /* already stopped */ } }
      this.cleanup();
      return this.result;
    }

    cancel() {
      this.running = false;
      clearInterval(this.interval);
      if (this.rec) {
        this.rec.onresult = null;
        try { this.rec.abort(); } catch (e) { /* ignore */ }
      }
      this.cleanup();
    }

    cleanup() {
      if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
      if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; }
      this.analyser = null;
    }

    startRecognition() {
      const rec = new SR();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = this.opts.lang;

      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          const text = r[0].transcript.trim();
          if (!text) continue;
          if (r.isFinal) this.finalText = (this.finalText ? this.finalText + ' ' : '') + text;
          else interim += (interim ? ' ' : '') + text;
        }
        this.interim = interim;
        if (this.opts.onTranscript) this.opts.onTranscript(this.finalText, this.interim);
      };
      rec.onerror = (e) => {
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          this.speechBlocked = true;
          this.emitError('Speech-to-text isn’t allowed here. Timing still works; type the script yourself.');
        } else if (e.error === 'network') {
          this.speechBlocked = true;
          this.emitError('Speech-to-text needs an internet connection. Timing still works.');
        } else {
          this.emitError('Speech-to-text error: ' + e.error);
        }
      };
      rec.onend = () => {
        if (this.running && !this.speechBlocked) {
          // Browsers end recognition after pauses; keep it going while we're recording.
          try { rec.start(); } catch (e) { /* ignore */ }
        } else if (this.interim) {
          this.finalText = (this.finalText ? this.finalText + ' ' : '') + this.interim;
          this.interim = '';
          if (this.opts.onTranscript) this.opts.onTranscript(this.finalText, '');
        }
      };
      try {
        rec.start();
        this.rec = rec;
      } catch (e) {
        this.emitError('Speech-to-text couldn’t start. Timing still works.');
      }
    }

    emitError(msg) { if (this.opts.onError) this.opts.onError(msg); }
  }

  window.VoiceTimer = VoiceTimer;
})();
