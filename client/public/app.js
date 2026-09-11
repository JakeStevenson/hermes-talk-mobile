/* talk-mobile — controller. Wire the lifted TalkTransport to the mobile UI.
 * Mobile-first, touch-first: a big tap-to-talk button, live status, an
 * always-visible mute banner, transcript, and background runs. Same visual
 * language as Jake's voice-ui, but driving the DUPLEX realtime lane.
 */

"use strict";

(function () {
  const $ = (id) => document.getElementById(id);

  const els = {
    lane: $("lane"),
    statusDot: $("statusDot"),
    statusText: $("statusText"),
    muteBanner: $("muteBanner"),
    micButton: $("micButton"),
    avatarBadge: $("avatarBadge"),
    avatarCanvas: $("avatarCanvas"),
    controlsRow: $("controlsRow"),
    hint: $("hint"),
    muteButton: $("muteButton"),
    stopButton: $("stopButton"),
    newSessionButton: $("newSessionButton"),
    tokenBox: $("tokenBox"),
    tokenInput: $("tokenInput"),
    tokenButton: $("tokenButton"),
    httpsWarn: $("httpsWarn"),
    transcript: $("transcript"),
    transcriptEmpty: $("transcriptEmpty"),
    runs: $("runs"),
    conn: $("conn"),
    connDot: $("connDot"),
    connText: $("connText"),
  };

  let transport = null;
  let phase = "idle"; // idle | starting | active
  let muted = false;
  let status = null;
  let rowId = 1;
  let runsTimer = 0;

  // -- status helpers -------------------------------------------------------

  function setConn(text, ok) {
    els.connText.textContent = text;
    els.connDot.className = "conn-dot " + (ok === null ? "idle" : ok ? "on" : "err");
  }
  function setStatus(text, ok) {
    els.statusText.textContent = text;
    els.statusDot.className = "status-dot " + (ok === null ? "idle" : ok ? "on" : "err");
  }
  function setError(text) {
    setStatus(text, false);
  }

  // -- Live2D avatar ---------------------------------------------------------
  let avatar = null;
  function setAvatarState(state) {
    if (avatar && avatar.setState) avatar.setState(state);
  }
  function setAvatarMuted(m) {
    const badge = els.avatarBadge;
    if (!badge) return;
    // Only surface the mic/muted state while the avatar is gone (idle/starting
    // is the avatar showing itself — no badge needed). Show 🔇 while muted.
    badge.textContent = m ? "🔇" : "";
  }

  function renderButton() {
    if (phase === "active") {
      setAvatarState("active");
      els.micButton.classList.toggle("muted", muted);
      els.micButton.disabled = false;
      els.controlsRow.style.display = "flex";
      els.muteButton.style.display = "inline-block";
      els.stopButton.style.display = "inline-block";
      els.newSessionButton.style.display = "inline-block";
      els.muteButton.textContent = muted ? "Unmute" : "Mute";
      els.hint.textContent = muted ? "Mic is off — tap Unmute to talk" : "Tap to end the session";
      els.muteBanner.style.display = muted ? "flex" : "none";
      setAvatarMuted(muted);
    } else if (phase === "starting") {
      setAvatarState("starting");
      els.micButton.disabled = true;
      els.controlsRow.style.display = "none";
      els.muteBanner.style.display = "none";
      els.hint.textContent = "Starting a live voice session…";
      setAvatarMuted(false);
    } else {
      setAvatarState("idle");
      els.micButton.disabled = !(status && status.configured);
      els.controlsRow.style.display = "none";
      els.muteBanner.style.display = "none";
      els.hint.textContent = "Tap to start a live voice session";
      setAvatarMuted(false);
    }
  }

  // -- transcript & runs ----------------------------------------------------

  function appendTranscript(role, text, final) {
    els.transcriptEmpty.style.display = "none";
    const rows = els.transcript.querySelectorAll(".row:not(.dummy)");
    const last = rows.length ? rows[rows.length - 1] : null;
    if (!final && last && last.dataset.role === role && !last.dataset.final) {
      const span = last.querySelector(".ttext");
      span.textContent = last.dataset.text + text;
      last.dataset.text = last.dataset.text + text;
    } else if (final && last && last.dataset.role === role && !last.dataset.final) {
      const span = last.querySelector(".ttext");
      span.textContent = text;
      last.dataset.text = text;
      last.dataset.final = "1";
    } else {
      const div = document.createElement("div");
      div.className = "row " + role;
      div.dataset.role = role;
      div.dataset.final = final ? "1" : "";
      div.dataset.text = text;
      const who = document.createElement("div");
      who.className = "who";
      who.textContent = (role === "user" ? "You" : "Hermes") + (final ? "" : " …");
      const span = document.createElement("div");
      span.className = "ttext";
      span.textContent = text;
      div.appendChild(who);
      div.appendChild(span);
      els.transcript.appendChild(div);
      els.transcript.scrollTop = els.transcript.scrollHeight;
    }
    rowId++;
  }

  function renderRuns(runs) {
    els.runs.textContent = "";
    if (!runs.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Nothing running.";
      els.runs.appendChild(empty);
      return;
    }
    runs.forEach((run) => {
      const div = document.createElement("div");
      div.className = "run";
      const head = document.createElement("div");
      head.className = "run-head";
      head.innerHTML = '<span class="badge ' + run.status + '">' + run.status +
        "</span> run " + run.runId + " · " + (run.kind || "?");
      const label = document.createElement("div");
      label.className = "run-label";
      label.textContent = run.label || "";
      div.appendChild(head);
      div.appendChild(label);
      if (run.output) {
        const out = document.createElement("div");
        out.className = "run-out";
        out.textContent = String(run.output);
        div.appendChild(out);
      }
      els.runs.appendChild(div);
    });
  }

  async function refreshRuns() {
    try {
      const res = await apiFetchJSON("/runs");
      renderRuns((res && res.runs) || []);
    } catch (e) {
      /* runs panel is a status board — a failed poll is not a page error */
    }
  }

  // -- session control ------------------------------------------------------

  async function refresh() {
    setStatus("Checking readiness…", null);
    setConn("Checking…", null);
    try {
      const res = await apiFetchJSON("/status");
      status = res;
      els.lane.textContent = "ready via " + describeSource(res.source);
      setStatus(res.detail || "Ready", true);
      setConn("Connected", true);
    } catch (err) {
      status = null;
      els.lane.textContent = "not configured";
      if (isAuthError(err)) {
        els.tokenBox.style.display = "block";
        setError("Token required");
      } else {
        setError(errorText(err));
        setConn("Unreachable", false);
      }
    }
    renderButton();
  }

  async function startTalk() {
    // Big button is the start/stop toggle (voice-ui muscle memory): tap to
    // end the session, not mute. Mute lives on the separate pill only.
    if (phase === "active") {
      stopTalk();
      return;
    }
    setError("");
    if (typeof RTCPeerConnection === "undefined" || !navigator.mediaDevices) {
      setError("Talk needs a browser with WebRTC and microphone access.");
      return;
    }
    phase = "starting";
    renderButton();
    try {
      // Live (GPT-Live) mode: there is no upfront ephemeral mint — the
      // transport builds the WebRTC offer and POSTs it (with the SDP) to
      // /session, which relays to /v1/live/sessions and returns the answer.
      // Calling /session here with just {} would 400 in live mode (an SDP
      // offer is required), so pass a minimal live session and let the
      // transport's postOffer do the mint.
      const isLive = status && status.voiceMode === "live";
      const session = isLive
        ? { voiceMode: "live", voice: status.voice || "" }
        : await apiPost("/session", {});
      const t = new TalkTransport(session, {
        onStatus: (s) => setStatus(s, true),
        onTranscript: appendTranscript,
        onError: setError,
        onAnalyser: (an) => {
          // Feed the avatar her actual playback analyser for lip-sync.
          bootAvatar().then((a) => { if (a && a.setAnalyser) a.setAnalyser(an); });
        },
        onRemoteStream: (stream) => {
          // Kept for non-cascade (WebRTC track) sessions — analyser is the
          // primary path; this is a harmless no-op if cascade never used it.
          bootAvatar().then((a) => { if (a && a.setEnergyStream) a.setEnergyStream(stream); });
        },
      });
      transport = t;
      await t.start();
      phase = "active";
      muted = false;
      setConn("Live", true);
    } catch (err) {
      if (transport) transport.stop();
      transport = null;
      phase = "idle";
      if (isAuthError(err)) {
        els.tokenBox.style.display = "block";
        setError("Token required");
      } else {
        setError(errorText(err));
      }
      setConn("Disconnected", false);
    }
    renderButton();
  }

  function stopTalk() {
    // Teardown must never leave the UI stuck "active". If transport.stop()
    // throws (a nulled track, a closed peer), we still reset phase and the
    // controls — and surface the error so it's not silent.
    let stopError = "";
    if (transport) {
      try {
        transport.stop();
      } catch (e) {
        stopError = errorText(e);
      }
    }
    transport = null;
    phase = "idle";
    muted = false;
    setConn("Disconnected", false);
    renderButton();
    if (stopError) setError("Stop: " + stopError);
    refresh();
  }

  function toggleMute() {
    if (!transport || !transport.media) return;
    muted = !muted;
    transport.media.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
    if (muted) {
      setStatus("Muted", null);
    } else {
      setStatus("Listening…", true);
    }
    renderButton();
  }

  function newSession() {
    stopTalk();
  }

  function saveToken() {
    writeToken(els.tokenInput.value.trim());
    els.tokenInput.value = "";
    els.tokenBox.style.display = "none";
    void refresh();
  }

  // -- wire -------------------------------------------------------------

  // Boot the Live2D avatar lazily on first mic tap (browser autoplay policies
  // don't matter for a canvas; we just avoid loading it before it's needed).
  let avatarPromise = null;
  function bootAvatar() {
    if (avatarPromise) return avatarPromise;
    avatarPromise = initLive2dAvatar(els.avatarCanvas, {
      base: "/static/live2d",
    }).then((a) => {
      avatar = a;
      setAvatarState("idle");
      return a;
    });
    return avatarPromise;
  }
  els.micButton.addEventListener("click", () => {
    void startTalk();
  });
  els.stopButton.addEventListener("click", stopTalk);
  els.muteButton.addEventListener("click", toggleMute);
  els.newSessionButton.addEventListener("click", newSession);
  els.tokenButton.addEventListener("click", saveToken);

  // Mobile HTTPS enforcement (mirrors voice-ui)
  if (window.location.protocol === "http:" && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) {
    els.httpsWarn.style.display = "block";
    els.micButton.disabled = true;
  }

  void refresh();

  // Boot the Live2D avatar lazily, AFTER the readiness check so a slow/absent
  // avatar never delays the status UI. If it fails it resolves a no-op API.
  void bootAvatar();

  // Poll runs while the page lives (dashboard behavior).
  setInterval(() => void refreshRuns(), 8000);
  window.addEventListener("beforeunload", () => {
    if (transport) transport.stop();
  });
})();
