/* talk-mobile — lifted from hermes-talk dashboard/dist/index.js
 *
 * The RealtimeSession transport, ported verbatim (vanilla JS, no React SDK —
 * that only exists inside the Hermes dashboard). This is the SAME duplex
 * WebRTC flow the Talk tab uses: mint an ephemeral secret, dial OpenAI
 * directly, relay every function call to the backend, poll background runs.
 *
 * apiFetch / postOffer point at the SAME /api/plugins/hermes-talk/* routes
 * the dashboard uses, so the standalone server mounts them unchanged.
 * The token gate (x-talk-token) is carried like the dashboard does.
 */

"use strict";

const PCM_RATE = 24000;
const OFFER_TIMEOUT_MS = 30000;
const TOOL_TIMEOUT_MS = 6500;
const RUN_POLL_MS = 5000;
const IDLE_POLL_MS = 20000;
const RUN_POLL_CAPS_MS = { agent: 2700000, skill: 600000 };
const DEFAULT_RUN_CAP_MS = 600000;
const WORK_STARTED_RE = /WORK_STARTED #(\d+) kind=(\w+)/;

const TOKEN_KEY = "talk-mobile-token";

function readToken() {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY) || "";
  } catch (e) {
    return "";
  }
}
function writeToken(value) {
  try {
    if (value) window.sessionStorage.setItem(TOKEN_KEY, value);
    else window.sessionStorage.removeItem(TOKEN_KEY);
  } catch (e) {
    /* no-op */
  }
}

function isAuthError(err) {
  return /^(401|403)\b/.test(String((err && err.message) || ""));
}
function errorText(err) {
  const raw = String((err && err.message) || err || "unknown error");
  return raw.length > 400 ? raw.slice(0, 400) + "…" : raw;
}
function describeSource(source) {
  if (source === "configured") return "API key";
  if (source === "env") return "OPENAI_API_KEY";
  if (source === "codex-oauth") return "ChatGPT sign-in";
  return "not configured";
}

const API = "/api/plugins/hermes-talk";

async function apiFetchJSON(path, init, timeoutMs) {
  const opts = Object.assign({}, init || {});
  const headers = Object.assign({}, opts.headers || {});
  const token = readToken();
  if (token) headers["x-talk-token"] = token;
  if (opts.body) headers["content-type"] = "application/json";
  opts.headers = headers;
  const controller = new AbortController();
  opts.signal = controller.signal;
  let timer = 0;
  if (timeoutMs) timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(API + path, opts);
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (e) {
      throw new Error(res.status + ": " + text.slice(0, 200));
    }
    if (!res.ok) {
      const detail = (body && body.detail) || res.status;
      throw new Error(res.status + ": " + String(detail));
    }
    return body;
  } finally {
    window.clearTimeout(timer);
  }
}

function apiPost(path, body, timeoutMs) {
  return apiFetchJSON(path, { method: "POST", body: JSON.stringify(body || {}) }, timeoutMs);
}

let relayEncoder = null;
function encodeRelayLine(line) {
  if (!relayEncoder) relayEncoder = new TextEncoder();
  return relayEncoder.encode(JSON.stringify(line) + "\n");
}

function pcmBuffer(ctx, values, rate, scale) {
  const buffer = ctx.createBuffer(1, values.length, rate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < values.length; i++) channel[i] = values[i] / scale;
  return buffer;
}

function makePcmContext() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  try {
    return new Ctx({ sampleRate: PCM_RATE });
  } catch (e) {
    return new Ctx();
  }
}

let canStreamUploadCache = null;
function canStreamUpload() {
  if (canStreamUploadCache !== null) return canStreamUploadCache;
  canStreamUploadCache = false;
  try {
    const nav = (typeof performance !== "undefined" && performance.getEntriesByType)
      ? (performance.getEntriesByType("navigation")[0] || null)
      : null;
    const hop = String((nav && nav.nextHopProtocol) || "").toLowerCase();
    if (!/^h[23]/.test(hop)) return canStreamUploadCache;
    if (typeof Request === "undefined" || typeof ReadableStream === "undefined") {
      return canStreamUploadCache;
    }
    new Request("/", { method: "POST", body: new ReadableStream(), duplex: "half" });
    canStreamUploadCache = true;
  } catch (e) {
    canStreamUploadCache = false;
  }
  return canStreamUploadCache;
}

/* ------------------------------------------------------------------ *
 * TalkTransport — duplex Realtime session (ported, verbatim contract)
 * ------------------------------------------------------------------ */
class TalkTransport {
  constructor(session, cb) {
    this.session = session;
    this.cb = cb || {};
    this.peer = null;
    this.channel = null;
    this.media = null;
    this.audio = null;
    this.offerAbort = null;
    this.closed = false;
    this.responseActive = false;
    this.continuationPending = false;
    this.toolBatch = null;
    this.toolTail = Promise.resolve();
    this.cascade = session && session.voiceMode === "cascade";
    this.cascadeReq = null;
    this.cascadeReqs = new Set();
    this.pcmContext = null;
    this.pcmNextTime = 0;
    this.pcmSources = [];
    this.pcmGeneration = 0;
    this.pcmPrev = null;
    this.pcmPos = 0;
    this.cascadeFailureLogged = false;
  }

  async start() {
    if (typeof RTCPeerConnection === "undefined" || !navigator.mediaDevices) {
      throw new Error("This browser has no WebRTC or microphone access.");
    }
    this.closed = false;
    const peer = new RTCPeerConnection();
    this.peer = peer;

    this.audio = document.createElement("audio");
    this.audio.autoplay = true;
    this.audio.playsInline = true;
    this.audio.style.display = "none";
    document.body.appendChild(this.audio);
    peer.addEventListener("track", (event) => {
      const stream = event.streams[0];
      if (this.audio && stream) this.audio.srcObject = stream;
      if (stream && this.cb.onRemoteStream) this.cb.onRemoteStream(stream);
    });

    const media = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (this.closed) {
      media.getTracks().forEach((track) => track.stop());
      return;
    }
    this.media = media;
    media.getAudioTracks().forEach((track) => peer.addTrack(track, media));

    const channel = peer.createDataChannel("oai-events");
    this.channel = channel;
    channel.addEventListener("open", () => this.cb.onStatus && this.cb.onStatus("Listening…"));
    channel.addEventListener("message", (event) => this.handleEvent(event.data));
    peer.addEventListener("connectionstatechange", () => {
      if (this.closed) return;
      if (peer.connectionState === "failed" || peer.connectionState === "closed") {
        this.cb.onError && this.cb.onError("Realtime connection closed.");
        this.stop();
      }
    });

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const answer = await this.postOffer(offer);
    if (this.closed) return;
    await peer.setRemoteDescription({ type: "answer", sdp: answer });
  }

  async postOffer(offer) {
    const controller = new AbortController();
    this.offerAbort = controller;
    const timer = window.setTimeout(() => controller.abort(), OFFER_TIMEOUT_MS);
    try {
      const res = await fetch(this.session.offerUrl, {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: "Bearer " + this.session.clientSecret,
          "Content-Type": "application/sdp",
        },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error("Realtime WebRTC setup failed (" + res.status + ")");
      return await res.text();
    } finally {
      window.clearTimeout(timer);
      if (this.offerAbort === controller) this.offerAbort = null;
    }
  }

  stop() {
    this.closed = true;
    if (this.offerAbort) this.offerAbort.abort();
    this.offerAbort = null;
    this.abortCascade();
    if (this.pcmContext) {
      const ctx = this.pcmContext;
      this.pcmContext = null;
      if (ctx.close) Promise.resolve(ctx.close()).catch(() => {});
    }
    // Idempotent teardown: every close below throws if the object is already
    // closed/removed (a dropped connection, or a prior stop). Guard each so
    // stop() can never throw and strand the UI in "active".
    if (this.channel) {
      try {
        if (this.channel.readyState === "open" || this.channel.readyState === "connecting") {
          this.channel.close();
        }
      } catch (e) {
        /* already closed */
      }
      this.channel = null;
    }
    if (this.peer) {
      try {
        if (this.peer.connectionState !== "closed") this.peer.close();
      } catch (e) {
        /* already closed */
      }
      this.peer = null;
    }
    if (this.media) {
      try {
        this.media.getTracks().forEach((track) => track.stop());
      } catch (e) {
        /* already stopped */
      }
      this.media = null;
    }
    if (this.audio) {
      try {
        this.audio.remove();
      } catch (e) {
        /* already removed */
      }
      this.audio = null;
    }
  }

  send(payload) {
    if (this.channel && this.channel.readyState === "open") {
      if (payload && payload.type === "response.create") this.continuationPending = true;
      this.channel.send(JSON.stringify(payload));
    }
  }

  handleEvent(data) {
    if (this.closed) return;
    let event;
    try {
      event = JSON.parse(String(data));
    } catch (e) {
      return;
    }
    switch (event.type) {
      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) this.cb.onTranscript && this.cb.onTranscript("user", event.transcript, true);
        return;
      case "response.output_audio_transcript.delta":
        if (event.delta) this.cb.onTranscript && this.cb.onTranscript("assistant", event.delta, false);
        return;
      case "response.output_audio_transcript.done":
        if (event.transcript) this.cb.onTranscript && this.cb.onTranscript("assistant", event.transcript, true);
        return;
      case "response.output_text.delta":
        if (event.delta) this.cb.onTranscript && this.cb.onTranscript("assistant", event.delta, false);
        if (event.delta && this.cascade) this.cascadeSend({ delta: event.delta });
        return;
      case "response.output_text.done": {
        const text = typeof event.text === "string" ? event.text : "";
        if (text) this.cb.onTranscript && this.cb.onTranscript("assistant", text, true);
        if (this.cascade) {
          this.cascadeSend({ done: text });
          this.finishCascadeStream();
        }
        return;
      }
      case "response.created":
        this.continuationPending = false;
        this.responseActive = true;
        this.cb.onStatus && this.cb.onStatus("Thinking…");
        return;
      case "response.done":
        this.responseActive = false;
        if (this.cascade && this.cascadeReq && this.cascadeReq.sink) this.abortCascade();
        this.finishToolResponse();
        this.cb.onStatus && this.cb.onStatus("Listening…");
        return;
      case "input_audio_buffer.speech_started":
        this.cb.onStatus && this.cb.onStatus("Listening…");
        if (this.cascade) this.abortCascade();
        if (this.responseActive) this.send({ type: "response.cancel" });
        return;
      case "input_audio_buffer.speech_stopped":
        this.cb.onStatus && this.cb.onStatus("Processing…");
        return;
      case "response.function_call_arguments.done":
        this.enqueueFunctionCall(event);
        return;
      case "error":
        this.handleError(event.error);
        return;
      default:
        return;
    }
  }

  handleError(error) {
    let detail = "";
    if (error && typeof error === "object") {
      detail = String(error.message || error.code || error.type || "");
    } else if (typeof error === "string") {
      detail = error;
    }
    if (detail.toLowerCase().indexOf("no active response") !== -1) return;
    this.cb.onError && this.cb.onError(detail ? "Realtime error: " + detail : "Realtime error.");
  }

  /* -- cascade relay —----------------------------------------------- */

  startCascadeStream() {
    if (this.cascadeFailureLogged) return;
    if (!canStreamUpload()) {
      this.cascadeReq = { controller: new AbortController(), buffered: [], sink: null };
      this.cascadeReqs.add(this.cascadeReq);
      return;
    }
    const controller = new AbortController();
    const req = { controller: controller, buffered: null, sink: null };
    this.cascadeReqs.add(req);
    this.cascadeReq = req;
    let stream;
    try {
      stream = new ReadableStream({
        start: (c) => {
          req.sink = c;
        },
      });
    } catch (e) {
      this.cascadeReqs.delete(req);
      if (this.cascadeReq === req) this.cascadeReq = null;
      this.cascadeFailure("browser cannot open its request stream");
      return;
    }
    this.sendCascadeRequest(req, stream, true);
    this.cb.onStatus && this.cb.onStatus("Speaking…");
  }

  onCascadeFailure(detail) {
    if (this.cascadeFailureLogged) return;
    this.cascadeFailureLogged = true;
    const message = "Custom voice unavailable — answers stay text-only. " + detail;
    if (typeof console !== "undefined" && console.warn) console.warn(message);
    if (this.cb && this.cb.onError) {
      try {
        this.cb.onError(message);
      } catch (e) {
        /* UI must not kill audio */
      }
    }
  }

  cascadeSend(line) {
    const open = this.cascadeReq && (this.cascadeReq.sink || this.cascadeReq.buffered);
    if (!open) this.startCascadeStream();
    const req = this.cascadeReq;
    if (!req) return;
    if (req.sink) req.sink.enqueue(encodeRelayLine(line));
    else if (req.buffered) req.buffered.push(encodeRelayLine(line));
  }

  finishCascadeStream() {
    const req = this.cascadeReq;
    if (!req) return;
    if (req.sink) {
      try {
        req.sink.close();
      } catch (e) {
        /* an errored stream is already closed */
      }
      req.sink = null;
      return;
    }
    if (req.buffered) {
      const lines = req.buffered;
      req.buffered = null;
      if (!lines.length) {
        this.cascadeReqs.delete(req);
        if (this.cascadeReq === req) this.cascadeReq = null;
        return;
      }
      let total = 0;
      for (let i = 0; i < lines.length; i++) total += lines[i].length;
      const body = new Uint8Array(total);
      let offset = 0;
      for (let i = 0; i < lines.length; i++) {
        body.set(lines[i], offset);
        offset += lines[i].length;
      }
      this.sendCascadeRequest(req, body, false);
    }
  }

  abortCascade() {
    const reqs = this.cascadeReqs;
    this.cascadeReqs = new Set();
    this.cascadeReq = null;
    reqs.forEach((req) => {
      if (req.sink) {
        try {
          req.sink.close();
        } catch (e) {
          /* already closed */
        }
      }
      req.buffered = null;
      req.controller.abort();
    });
    this.stopPcmPlayback();
  }

  sendCascadeRequest(req, body, streaming) {
    const onFailure = (detail) => {
      this.cascadeReqs.delete(req);
      if (this.cascadeReq === req) this.cascadeReq = null;
      this.onCascadeFailure(detail);
    };
    fetch(API + "/cascade-tts", {
      method: "POST",
      headers: { "content-type": "application/x-ndjson", "x-talk-token": readToken() },
      body: body,
      duplex: streaming ? "half" : undefined,
      signal: req.controller.signal,
    })
      .then((res) => {
        if (!res.ok || !res.body) throw new Error("relay " + res.status);
        const reader = res.body.getReader();
        this.playCascadePcm(req, reader);
      })
      .catch((err) => {
        if (req.controller.signal.aborted) return;
        onFailure(String((err && err.message) || err));
      });
  }

  async playCascadePcm(req, reader) {
    const generation = this.pcmGeneration;
    let pending = new Uint8Array(0);
    try {
      for (;;) {
        const step = await reader.read();
        if (step.done || !this.cascadeReqs.has(req)) break;
        const chunk = step.value;
        const joined = new Uint8Array(pending.length + chunk.length);
        joined.set(pending, 0);
        joined.set(chunk, pending.length);
        const even = joined.length - (joined.length % 2);
        pending = joined.slice(even);
        if (even > 0) this.schedulePcm(joined.slice(0, even), generation);
      }
    } catch (e) {
      /* aborted fetch rejects the reader — the barge-in already spoke */
    }
    this.cascadeReqs.delete(req);
    if (this.cascadeReq === req) this.cascadeReq = null;
  }

  resampleToContext(samples, rate) {
    const ratio = PCM_RATE / rate;
    const prev = this.pcmPrev === null ? samples[0] : this.pcmPrev;
    const n = samples.length;
    const at = (i) => (i === 0 ? prev : samples[i - 1]) / 32768;
    const out = [];
    let p = this.pcmPos;
    while (p < n) {
      const i = Math.floor(p);
      const frac = p - i;
      out.push(at(i) * (1 - frac) + at(i + 1) * frac);
      p += ratio;
    }
    this.pcmPrev = samples[n - 1];
    this.pcmPos = Math.max(0, p - n);
    return out;
  }

  schedulePcm(bytes, generation) {
    if (generation !== this.pcmGeneration) return;
    if (!this.pcmContext) {
      this.pcmContext = makePcmContext();
      if (!this.pcmContext) return;
      this.pcmNextTime = 0;
    }
    const ctx = this.pcmContext;
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
    if (!samples.length) return;
    let buffer;
    if (ctx.sampleRate === PCM_RATE) {
      buffer = pcmBuffer(ctx, samples, PCM_RATE, 32768);
    } else {
      const resampled = this.resampleToContext(samples, ctx.sampleRate);
      if (!resampled.length) return;
      buffer = pcmBuffer(ctx, resampled, ctx.sampleRate, 1);
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const at = Math.max(ctx.currentTime || 0, this.pcmNextTime);
    source.start(at);
    this.pcmNextTime = at + buffer.duration;
    this.pcmSources.push(source);
    if (this.pcmSources.length > 512) this.pcmSources.splice(0, 256);
  }

  /* -- tool relay —--------------------------------------------------- */

  enqueueFunctionCall(event) {
    if (typeof event.call_id !== "string" || typeof event.name !== "string" ||
        !event.call_id || !event.name) return;
    if (!this.toolBatch) this.toolBatch = { done: false, results: [] };
    const batch = this.toolBatch;
    const position = batch.results.length;
    batch.results.push(null);
    this.toolTail = this.toolTail.then(async () => {
      batch.results[position] = await this.handleFunctionCall(event);
      this.flushToolResponse(batch);
    });
  }

  finishToolResponse() {
    if (!this.toolBatch) return;
    this.toolBatch.done = true;
    this.flushToolResponse(this.toolBatch);
  }

  flushToolResponse(batch) {
    if (this.toolBatch !== batch || !batch.done || batch.results.some((item) => !item)) return;
    for (let i = 0; i < batch.results.length; i++) this.send(batch.results[i].message);
    this.send({ type: "response.create" });
    for (let i = 0; i < batch.results.length; i++) this.watchForRun(batch.results[i].output);
    this.toolBatch = null;
  }

  async handleFunctionCall(event) {
    const callId = typeof event.call_id === "string" ? event.call_id : "";
    const name = typeof event.name === "string" ? event.name : "";
    if (!callId || !name) return;
    let args = {};
    try {
      const parsed = JSON.parse(event.arguments || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
    } catch (e) {
      /* malformed arguments execute with {} */
    }
    this.cb.onStatus && this.cb.onStatus("Using " + name + "…");
    let output;
    try {
      const res = await apiPost("/tool", { name: name, arguments: args }, TOOL_TIMEOUT_MS);
      output = res && res.output ? String(res.output) : "(no output)";
    } catch (err) {
      output = name + " failed: " + errorText(err);
    }
    return {
      output: output,
      message: {
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output: output },
      },
    };
  }

  watchForRun(text) {
    const started = WORK_STARTED_RE.exec(String(text || ""));
    if (started) this.pollRun(Number(started[1]), started[2]);
  }

  pollRun(runId, kind) {
    const startedAt = Date.now();
    const cap = RUN_POLL_CAPS_MS[kind] || DEFAULT_RUN_CAP_MS;
    const tick = async () => {
      if (this.closed || Date.now() - startedAt > cap) return;
      let run = null;
      try {
        const res = await apiFetchJSON("/runs");
        const runs = (res && res.runs) || [];
        for (let i = 0; i < runs.length; i++) {
          if (Number(runs[i].runId) === runId) {
            run = runs[i];
            break;
          }
        }
      } catch (e) {
        window.setTimeout(tick, RUN_POLL_MS);
        return;
      }
      if (!run || run.status === "running") {
        window.setTimeout(tick, RUN_POLL_MS);
        return;
      }
      if (this.responseActive || this.continuationPending || this.toolBatch) {
        window.setTimeout(tick, RUN_POLL_MS);
        return;
      }
      const result = run.output || "(no output)";
      this.send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "Work run #" + runId + " (" + (run.kind || kind) + ") finished with " +
                "status '" + run.status + "'. Result: " + result + "\n\n" +
                "Summarize this aloud in one to three spoken sentences.",
            },
          ],
        },
      });
      this.send({ type: "response.create" });
      this.watchForRun(result);
    };
    void tick();
  }
}
