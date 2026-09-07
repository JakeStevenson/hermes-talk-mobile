# talk-mobile

A standalone, mobile-optimized voice surface for [hermes-talk](https://github.com/TheSmokeDev/hermes-talk). It mounts the **same FastAPI router** the Hermes dashboard's Talk tab uses (`dashboard/plugin_api.py`) behind its own uvicorn process, so the mobile UI works independently of the dashboard — the dashboard can be down and this still talks.

The frontend is a plain vanilla-JS lift of the dashboard's `TalkTransport` (duplex WebRTC: mint an ephemeral secret → dial OpenAI directly → `oai-events` data channel → tool relay → run polling), with a **Live2D avatar** that lip-syncs to the agent's voice.

## Features

- **Live2D avatar** (default free Haru model) with lip-sync driven by an `AnalyserNode` RMS tap on the agent's playback audio — no visemes, no per-word timing.
- **Cascade voice** (hermes-talk's cloned-voice path) and **native** (WebRTC remote track) both supported; the avatar meters whichever is live.
- **Idempotent teardown** — End / New Session can never strand the session (the `stop()` fix is upstreamed in [hermes-talk#130](https://github.com/TheSmokeDev/hermes-talk/pull/130)).
- **No build step** — static files served fresh from disk; bump the `?v=N` cache-buster in `index.html` to deploy.

## How it connects to hermes-talk

- **Backend:** `server.py` puts the hermes-talk plugin root on `sys.path` and mounts `dashboard.plugin_api.router` at `/api/plugins/hermes-talk` — the same prefix the dashboard uses, so the frontend's relative calls work unchanged.
- **Agent lane:** resolves over the Hermes **api_server platform** (`127.0.0.1:8642`), not the dashboard. Real tools + background delegation work standalone.
- **Auth:** the talk routes carry their own gate (`TALK_DASHBOARD_TOKEN` via `require_dashboard_auth`). This app binds loopback by default; a reverse proxy (e.g. Caddy) exposes it.

## Run

```bash
# Requires a hermes-talk install (the plugin root is resolved from HERMES_HOME
# or TALK_PLUGIN_ROOT) and HERMES_HOME/.env with API_SERVER_KEY + TALK_VOICE.
pip install -r requirements.txt   # fastapi, uvicorn, python-dotenv
python server.py                   # binds 127.0.0.1:3010 (TALK_MOBILE_PORT to change)
```

Set `TALK_DASHBOARD_TOKEN` in the environment (or `~/.hermes/.env`) so the talk routes accept the frontend's token.

## Layout

```
server.py                 # mounts the hermes-talk router + serves /static
client/public/
  index.html              # the page; bump ?v=N cache-busters to deploy
  talk.js                 # TalkTransport — lifted from the dashboard bundle
  app.js                  # controller wiring transport ↔ UI ↔ avatar
  live2d-avatar.js        # Live2D avatar + lip-sync (AnalyserNode RMS → ParamMouthOpenY)
  live2d/Haru/            # default free Live2D model
  vendor/                 # pixi, live2d cubism runtimes, pixi-live2d-display
```

## License

MIT — see [LICENSE](LICENSE).
