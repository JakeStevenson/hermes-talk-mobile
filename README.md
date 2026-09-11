# talk-mobile

A standalone, mobile-optimized voice surface for [hermes-talk](https://github.com/TheSmokeDev/hermes-talk). It mounts the **same FastAPI router** the Hermes dashboard's Talk tab uses (`dashboard/plugin_api.py`) behind its own uvicorn process, so the mobile UI works independently of the dashboard — the dashboard can be down and this still talks.

The frontend is a plain vanilla-JS lift of the dashboard's `TalkTransport` (duplex WebRTC; Realtime mints an ephemeral secret and dials OpenAI directly, GPT-Live relays the offer server-side — see [Voice modes](#voice-modes)), with a **Live2D avatar** that lip-syncs to the agent's voice.

## Features

- **Live2D avatar** (default free Haru model) with lip-sync driven by an `AnalyserNode` RMS tap on the agent's playback audio — no visemes, no per-word timing.
- **Cascade voice** (hermes-talk's cloned-voice path), **native** (WebRTC remote track), and **GPT-Live** all supported; the avatar meters whichever is live.

## Voice modes

The surface speaks whichever lane hermes-talk is configured for. Mode is a
runtime config on the **server side** (`TALK_VOICE_MODE` in `~/.hermes/.env`);
the client just reads the session's `voiceMode` and wires accordingly. No
client change or redeploy is needed to flip modes — just the env value and a
`talk-mobile.service` restart.

- **`native`** (default) — OpenAI **Realtime**: the client mints an ephemeral `client_secret` server-side, then dials OpenAI directly over WebRTC.
- **`live`** — **GPT-Live** (`gpt-live-1`), OpenAI's full-duplex successor: the client builds the WebRTC offer and POSTs it to the plugin's `/session` route, which relays it to `POST /v1/live/sessions` **server-side** — the raw API key never touches the browser, and the response carries only `{sessionId, sdp}`. Live mode talks the `session.*` event set (input/output transcript deltas, `delegation.created`) and dispatches delegated work through the **same** `/tool` + `/runs` lane Realtime tool-calls use. See the [hermes-talk GPT-Live fork](https://github.com/TheSmokeDev/hermes-talk) for the wire contract.

To switch:

```bash
# ~/.hermes/.env
TALK_VOICE_MODE=live      # or native
systemctl --user restart talk-mobile.service
```

GPT-Live requires an OpenAI **project API key** on a paid (Tier 1+) API
account (`TALK_OPENAI_API_KEY`); a ChatGPT/Codex-OAuth login is not
GPT-Live-entitled (returns 403 "Voice session access denied").
- **Idempotent teardown** — End / New Session can never strand the session (the `stop()` fix is upstreamed in [hermes-talk#130](https://github.com/TheSmokeDev/hermes-talk/pull/130)).
- **No build step** — static files served fresh from disk; bump the `?v=N` cache-buster in `index.html` to deploy.

## How it connects to hermes-talk

- **Backend:** `server.py` puts the hermes-talk plugin root on `sys.path` and mounts `dashboard.plugin_api.router` at `/api/plugins/hermes-talk` — the same prefix the dashboard uses, so the frontend's relative calls work unchanged.
- **Agent lane:** resolves over the Hermes **api_server platform** (`127.0.0.1:8642`), not the dashboard. Real tools + background delegation work standalone.
- **Auth:** the talk routes carry their own gate (`TALK_DASHBOARD_TOKEN` via `require_dashboard_auth`). This app binds loopback by default; a reverse proxy (e.g. Caddy) exposes it.

## Run

```bash
# 1) Fetch the Live2D proprietary runtime + Haru sample model (NOT vendored —
#     they're Live2D's proprietary assets, see LICENSE note below).
./scripts/fetch-vendor.sh

# 2) Requires a hermes-talk install (the plugin root is resolved from HERMES_HOME
#    or TALK_PLUGIN_ROOT) and HERMES_HOME/.env with API_SERVER_KEY + TALK_VOICE.
pip install -r requirements.txt   # fastapi, uvicorn, python-dotenv
python server.py                   # binds 127.0.0.1:3010 (TALK_MOBILE_PORT to change)
```

Set `TALK_DASHBOARD_TOKEN` in the environment (or `~/.hermes/.env`) so the talk routes accept the frontend's token.

## Layout

```
server.py                 # mounts the hermes-talk router + serves /static
scripts/fetch-vendor.sh   # downloads the Live2D runtime + Haru model (proprietary)
client/public/
  index.html              # the page; bump ?v=N cache-busters to deploy
  talk.js                 # TalkTransport — lifted from the dashboard bundle
  app.js                  # controller wiring transport ↔ UI ↔ avatar
  live2d-avatar.js        # Live2D avatar + lip-sync (AnalyserNode RMS → ParamMouthOpenY)
  live2d/Haru/            # default free Live2D model (fetched, not vendored)
  vendor/                 # pixi + pixi-live2d-display (MIT, vendored)
```

## License

The code in this repo is MIT — see [LICENSE](LICENSE).

**The Live2D runtime and Haru model are NOT MIT.** They are Live2D's
proprietary assets, distributed under the [Live2D Proprietary Software License
Agreement](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)
and the [Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html).
They are not vendored here; `scripts/fetch-vendor.sh` downloads them from
Live2D's official sources so each user accepts Live2D's own terms. Review
those terms before distributing your app.
