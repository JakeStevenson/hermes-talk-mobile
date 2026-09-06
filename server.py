"""talk-mobile — standalone mobile-optimized surface for hermes-talk.

Mounts the SAME FastAPI router the Hermes dashboard's Talk tab uses
(dashboard/plugin_api.py from the hermes-talk plugin) behind its own
uvicorn process, so the mobile UI works independently of the dashboard —
the dashboard can be down and this still talks.

The router is loaded by path exactly like the dashboard's
``_mount_plugin_api_routes`` does: the plugin root goes on sys.path and the
flat ``talk_*`` modules resolve. HERMES_HOME + ~/.hermes/.env are loaded so
the agent lane (api_server key) and voice config resolve.

Security: the talk routes carry their OWN gate (TALK_DASHBOARD_TOKEN via
``require_dashboard_auth``). This app additionally binds loopback by
default; Caddy is what exposes it. Run with TALK_DASHBOARD_TOKEN set.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# --- env -------------------------------------------------------------------

DOTENV_HOME = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
HERMES_DOTENV = DOTENV_HOME / ".env"
if HERMES_DOTENV.exists():
    from dotenv import load_dotenv

    load_dotenv(HERMES_DOTENV, override=False)

PLUGIN_ROOT = Path(
    os.environ.get("TALK_PLUGIN_ROOT")
    or DOTENV_HOME / "plugins" / "hermes-talk"
)
if str(PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(PLUGIN_ROOT))

# --- fastapi app -----------------------------------------------------------

from fastapi import FastAPI  # noqa: E402
from fastapi.responses import FileResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

# Mount the plugin's router at the SAME prefix the dashboard uses, so the
# frontend's relative /api/plugins/hermes-talk/... calls work unchanged.
from dashboard import plugin_api  # noqa: E402

app = FastAPI(title="talk-mobile", version="0.1.0")
app.include_router(plugin_api.router, prefix="/api/plugins/hermes-talk")

# --- static mobile UI ------------------------------------------------------

PUBLIC = Path(__file__).resolve().parent / "client" / "public"
if PUBLIC.exists():
    app.mount("/static", StaticFiles(directory=str(PUBLIC)), name="static")


@app.middleware("http")
async def no_cache_static(request, call_next):
    """Static assets must always revalidate — no Cache-Control means Safari
    heuristically caches app.js/talk.js and serves stale JS after a deploy,
    which made the stop-button fix look like it "did nothing". Force
    revalidation on every static response."""
    response = await call_next(request)
    if request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(str(PUBLIC / "index.html"))


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("TALK_MOBILE_PORT", "3010"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
