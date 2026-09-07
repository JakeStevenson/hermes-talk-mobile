/* live2d-avatar.js — energy-driven Live2D avatar for talk-mobile.
 *
 * Wraps pixi-live2d-display (PIXI v6) + a vendored .model3.json so we can
 * swap in any model (Haru today, a custom Mercer model later) without touching
 * the UI wiring.
 *
 * Lip-sync strategy: the agent's audio is metered by an AnalyserNode and
 * per-frame RMS is smoothed into `energySmooth`, which is written to Haru's
 * mouth param (ParamMouthOpenY) inside the internal model's
 * "beforeModelUpdate" event — the point in the PIXI update cycle right before
 * coreModel.update() renders, so the value can't be clobbered by the motion
 * manager. The model's native auto-blink + an Idle motion keep it alive when
 * quiet.
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
        // iOS Safari quirk: combining autoDensity + devicePixelRatio > 1 makes
        // PIXI's logical space diverge from the on-screen canvas (model placed
        // at renderer center lands bottom-right). Side-step it: fixed resolution
        // 1 and explicit canvas CSS size, so logical px == CSS px 1:1 everywhere.
        app = new PIXI.Application({
          view: canvasEl,
          transparent: true,
          antialias: true,
          autoStart: true,
          resolution: 1,
          autoDensity: false,
        });
        // Pin the canvas element to its parent's box explicitly so the renderer
        // matches actual layout on every engine.
        const parent = canvasEl.parentElement || canvasEl;
        const rect = parent.getBoundingClientRect();
        const w = (rect.width || 200) | 0;
        const h = (rect.height || 200) | 0;
        app.renderer.resize(w, h);
        canvasEl.style.width = w + "px";
        canvasEl.style.height = h + "px";
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
      let lastFitW = 0, lastFitH = 0;   // last renderer size we fit against
      let mouthIdx = -1;         // core-model index of ParamMouthOpenY

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

      // Resolve + cache the mouth param index once so we can guard the write.
      function paramInfo(core) {
        if (!core) return -1;
        if (mouthIdx >= 0) return mouthIdx;
        try { mouthIdx = Number(core.getParameterIndex("ParamMouthOpenY")) || -1; }
        catch (e) { mouthIdx = -1; }
        return mouthIdx;
      }

      // THE one real lip-sync write. Runs inside the internal model's update
      // cycle via the "beforeModelUpdate" event — AFTER the motion manager has
      // reset ParamMouthOpenY for this frame and immediately BEFORE
      // coreModel.update() renders. A rAF write outside the cycle always races
      // the render and lands too late (mouth never moved for exactly that
      // reason). weight=1 = full overwrite of the param this frame.
      function attachLipsyncHook() {
        const im = model && model.internalModel;
        if (!im || !im.on) return;
        im.on("beforeModelUpdate", function applyMouth() {
          const core = im.coreModel;
          if (!core || !core.setParameterValueById || paramInfo(core) < 0) return;
          core.setParameterValueById("ParamMouthOpenY", energySmooth, 1);
        });
      }

      function tick() {
        raf = requestAnimationFrame(tick);
        if (!model || !model.internalModel) return;
        fitModel();                          // reconcile layout drift (iOS settle)
        let target = 0;
        let rms = 0;
        if (analyser) {
          rms = rmsFromAnalyser();
          if (rms > MIN_RMS) target = clamp((rms - MIN_RMS) / (MAX_RMS - MIN_RMS), 0, 1);
        }
        const k = target > energySmooth ? ATTACK : RELEASE;
        energySmooth += (target - energySmooth) * k;
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
        if (analyser) return;              // cascade analyser already owns the mouth
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

      // Meter from her actual playback context (cascade PCM path). talk.js
      // routes each created AudioBufferSource through an analyser to reach here.
      function setAnalyser(an) {
        if (audioCtx) {
          try { audioCtx.close(); } catch (e) { /* ignore */ }
          audioCtx = null;
        }
        analyser = an || null;
        if (analyser) startLoop();
      }

      function setEnergy(rms) {
        if (analyser) return;
        const target = clamp(rms, 0, 1);
        energySmooth += (target - energySmooth) * (target > energySmooth ? ATTACK : RELEASE);
        // The mouth write itself happens in the internal model's
        // "beforeModelUpdate" hook (attachLipsyncHook) — keep it in one place.
      }

      function setState(state) {
        currentState = state;
        if (!model) return;
        try { model.motion("Idle"); } catch (e) { /* non-fatal */ }
      }

      const api = { setEnergy, setEnergyStream, setAnalyser, setState, destroy: null };

      // Center + fit the model against the LIVE parent box (not renderer boot
      // state). Reads getBoundingClientRect each frame so any layout change
      // self-corrects, and logs once so we can see the real geometry iOS uses.
      function fitModel() {
        if (!model) return;
        const rect = (canvasEl.parentElement || canvasEl).getBoundingClientRect();
        const cw = (rect.width || 200) | 0;
        const ch = (rect.height || 200) | 0;
        if (!cw || !ch) return;
        if (cw === lastFitW && ch === lastFitH) return;  // nothing moved
        lastFitW = cw; lastFitH = ch;
        const lb = model.getLocalBounds();
        const nw = lb.width || 2;          // natural width (px at scale 1)
        const nh = lb.height || 2;         // natural height (px at scale 1)
        // Full-body fit (what we previously wanted)...
        const fullFit = Math.min(cw / nw, ch / nh);
        // ...zoomed in for a face close-up: anchor at TOP-center so the head
        // sits up top and large, filling the frame. FACE_ZOOM trades body for
        // face; ~2.7x brings her head+shoulders into the canvas.
        const scale = fullFit * 2.7;
        model.scale.set(scale);
        model.x = cw / 2;                  // head centered horizontally
        model.y = ch * 0.05;               // top of the head just inside the frame
      }

      return PIXI.live2d.Live2DModel.from(modelUrl)
        .then((m) => {
          model = m;
          model.autoInteract = false;        // we own taps (avatar doubles as button)
          // Face-zoom framing: anchor near the TOP-center (head/chest), not the
          // feet, so fitModel can pin her head up top and scale it large.
          model.anchor.set(0.5, 0.08);
          app.stage.addChild(model);
          attachLipsyncHook();           // the real mouth write lives here
          fitModel();                    // center + fit using current size
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
