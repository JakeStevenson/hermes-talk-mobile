/* live2d-avatar.js — energy-driven Live2D avatar for talk-mobile.
 *
 * Wraps pixi-live2d-display (PIXI v6) + a vendored .model3.json so we can
 * swap in any model (Haru today, a custom Mercer model later) without touching
 * the UI wiring.
 *
 * Lip-sync strategy: the remote WebRTC track is tapped by an independent
 * AnalyserNode (meter-only — playback still goes through the hidden <audio>
 * element, untouched). Per-frame RMS is mapped to the model's mouthOpenY.
 * The model's native auto-blink + an Idle motion loop keep it alive when quiet.
 *
 * IMPORTANT: this function NEVER throws synchronously. PIXI/WebGL init is
 * fallible (headless, zero-size canvas, GPU unavailable), and a synchronous
 * throw would freeze app.js's IIFE before it reaches refresh(). We therefore
 * guard the whole body and resolve a no-op API on any failure.
 *
 * Exposes:
 *   initLive2dAvatar(canvasEl, { base }) -> Promise<{
 *     setEnergy(rms), setEnergyStream(stream), setState(state), destroy
 *   }>
 */
(function () {
  "use strict";

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function noopApi() {
    return {
      setEnergy() {},
      setEnergyStream() {},
      setState() {},
      destroy() {},
    };
  }

  function initLive2dAvatar(canvasEl, opts) {
    opts = opts || {};
    const base = opts.base || "/static/live2d";
    const modelUrl = (opts.modelUrl || base + "/Haru/Haru.model3.json");

    if (typeof PIXI === "undefined" || !PIXI.live2d || !PIXI.live2d.Live2DModel) {
      console.warn("[live2dAvatar] pixi-live2d-display not loaded; avatar off.");
      return Promise.resolve(noopApi());
    }

    // Guard the ENTIRE body so a fallible sync PIXI/WebGL failure resolves a
    // no-op API rather than throwing into the caller's async flow.
    return (function () {
      let app;
      try {
        app = new PIXI.Application({
          view: canvasEl,
          transparent: true,
          antialias: true,
          autoStart: true,
          autoDensity: true,
          resizeTo: canvasEl.parentElement || canvasEl,
          resolution: Math.min(window.devicePixelRatio || 1, 2),
        });
      } catch (e) {
        console.error("[live2dAvatar] PIXI init failed:", e);
        return Promise.resolve(noopApi());
      }

      let model = null;
      let analyser = null;
      let audioCtx = null;
      let raf = 0;
      let rafOn = false;
      let energySmooth = 0;      // 0..1 smoothed RMS
      let currentState = "idle";

      // Mouth smoothing: faster attack than release so lips snap open but ease
      // closed (feels natural, avoids flutter on low-volume tails).
      const ATTACK = 0.45, RELEASE = 0.12;
      const DATA = new Uint8Array(2048);
      const MIN_RMS = 0.015;      // below this = silence
      const MAX_RMS = 0.20;       // above this = fully open

      function rmsFromAnalyser() {
        analyser.getByteTimeDomainData(DATA);
        let sum = 0;
        for (let i = 0; i < DATA.length; i++) {
          const v = (DATA[i] - 128) / 128;
          sum += v * v;
        }
        return Math.sqrt(sum / DATA.length);
      }

      function tick() {
        raf = requestAnimationFrame(tick);
        if (!model || !model.internalModel) return;
        let target = 0;
        if (analyser) {
          const rms = rmsFromAnalyser();
          if (rms > MIN_RMS) target = clamp((rms - MIN_RMS) / (MAX_RMS - MIN_RMS), 0, 1);
        }
        const k = target > energySmooth ? ATTACK : RELEASE;
        energySmooth += (target - energySmooth) * k;
        model.internalModel.mouthOpenY = energySmooth;
      }

      function stopLoop() {
        if (raf && rafOn) { cancelAnimationFrame(raf); rafOn = false; }
      }
      function startLoop() {
        if (!rafOn) { rafOn = true; tick(); }
      }

      // Meter-only sink: consume the remote track for RMS without touching
      // playback. Safe to re-call with a new stream (e.g. after reconnect).
      function setEnergyStream(stream) {
        if (audioCtx) {
          try { audioCtx.close(); } catch (e) { /* ignore */ }
          audioCtx = null; analyser = null;
        }
        const track = stream && stream.getAudioTracks && stream.getAudioTracks()[0];
        if (!track) { energySmooth = 0; return; }
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        try {
          const ctx = new Ctx();
          audioCtx = ctx;
          const src = ctx.createMediaStreamSource(stream);
          analyser = ctx.createAnalyser();
          analyser.fftSize = 2048;
          analyser.smoothingTimeConstant = 0.1;
          src.connect(analyser); // analyser feeds nothing onward — meter only
          startLoop();
        } catch (e) {
          console.warn("[live2dAvatar] audio tap failed:", e);
        }
      }

      function setEnergy(rms) {
        if (analyser) return;
        const target = clamp(rms, 0, 1);
        energySmooth += (target - energySmooth) * (target > energySmooth ? ATTACK : RELEASE);
        if (model && model.internalModel) model.internalModel.mouthOpenY = energySmooth;
      }

      function setState(state) {
        currentState = state;
        if (!model) return;
        try { model.motion("Idle"); } catch (e) { /* non-fatal */ }
      }

      const api = { setEnergy, setEnergyStream, setState, destroy: null };

      // Center + fit the model against the CURRENT renderer size. PIXI reads
      // the canvas size at boot, but on iOS Safari the layout (dynamic toolbar)
      // settles AFTER boot — so a size captured at creation can be stale there,
      // making model.x land off-center. Re-running on resize fixes it.
      function fitModel() {
        if (!model) return;
        const cw = app.renderer.width || 1;
        const ch = app.renderer.height || 1;
        const lb = model.getLocalBounds();
        const nw = lb.width || 2;          // natural width (px at scale 1)
        const nh = lb.height || 2;         // natural height (px at scale 1)
        const fit = Math.min(cw / nw, ch / nh) * 0.9;
        model.scale.set(fit);
        model.x = cw / 2;
        model.y = ch;
      }

      return PIXI.live2d.Live2DModel.from(modelUrl)
        .then((m) => {
          model = m;
          model.autoInteract = false;        // we own taps (avatar doubles as button)
          model.anchor.set(0.5, 0.9);        // near the feet so it stands on the base
          app.stage.addChild(model);
          fitModel();                        // center + fit using current size
          window.addEventListener("resize", fitModel);
          setState("idle");
          startLoop();
          api.destroy = function () {
            window.removeEventListener("resize", fitModel);
            stopLoop();
            if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; analyser = null; }
            try { model.destroy({ children: true }); } catch (e) {}
            try { app.destroy(true, { children: true, texture: true }); } catch (e) {}
          };
          return api;
        })
        .catch((err) => {
          console.error("[live2dAvatar] model load failed:", err);
          try { app.destroy(true); } catch (e) {}
          api.destroy = stopLoop;
          return api; // resolve anyway; UI shows a placeholder
        });
    })();
  }

  window.initLive2dAvatar = initLive2dAvatar;
})();
