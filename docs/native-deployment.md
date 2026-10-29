# Native deployment / 直接复用本机 Blender

Run the API, runner, MCP and Blender directly on one Linux or macOS machine. No Blender Docker image is built or downloaded. Reuse means the existing **installed executable**; each project gets a new managed Blender process with an isolated scene. Unrelated Blender processes are never attached to or terminated.

## Prerequisites

- Node.js 22.12+ or 24 LTS, npm, Python 3.12+ with venv support.
- An installed Blender executable matching the machine architecture. Historical Linux integration tests used Blender 5.2.3; other installed versions need compatibility testing.
- A running PostgreSQL database and a connection URL. Production never silently substitutes SQLite/PGlite.
- Linux embedded mode: Xvfb, x11vnc, Openbox and Blender's native graphics libraries.

On Ubuntu/Debian, desktop helpers can be installed with:

```bash
sudo apt-get update
sudo apt-get install -y python3-venv xvfb x11vnc openbox libgl1 libegl1 libxrender1 libxi6 libxfixes3 libxkbcommon0
```

Install Node and Blender using their official distribution for your system. On macOS, `/Applications/Blender.app/Contents/MacOS/Blender` and the corresponding user Applications path are detected automatically. Linux searches `PATH`; `--blender` or `BLENDER_BIN` overrides discovery. If Blender is missing the native launcher stops with a specific message; use the existing Docker deployment to provision Blender automatically.

## PostgreSQL

Reuse a local PostgreSQL service, or start only a database container. For example, with Docker installed:

```bash
# Set POSTGRES_PASSWORD interactively so the password is not saved in shell history.
read -s -p 'Database password: ' POSTGRES_PASSWORD; echo
export POSTGRES_PASSWORD
docker run -d --name blender-pilot-db --restart unless-stopped \
  -e POSTGRES_USER=pilot -e POSTGRES_DB=pilot -e POSTGRES_PASSWORD \
  -p 127.0.0.1:5432:5432 -v blender-pilot-pg:/var/lib/postgresql \
  postgres:18
unset POSTGRES_PASSWORD
```

Do not rerun `docker run` for an existing named container: use `docker start blender-pilot-db`. Supply its URL when the native launcher prompts; passwords containing URL-reserved characters must be percent-encoded. You may instead set `DATABASE_URL` through your environment/secret manager. The launcher stores the connection URL and generated login/internal credentials in `.data/local-config.json` with owner-only permissions, and reuses them on restart. Keep this file private and backed up. `.env` is not sourced by the native launcher.

## Start

```bash
./local-up.sh --setup
# Later starts, without downloading dependencies or rebuilding:
./local-up.sh
# After updating source:
./local-up.sh --setup
```

`--setup` runs `npm ci`, installs the pinned Python MCP dependencies in `.local-runtime/mcp`, and builds the app. It never replaces Blender. `--check` validates the built app, dependencies, database connection and free HTTP ports without launching services. Node dependencies include the pinned Codex CLI.

The launcher waits for API/runner readiness before printing the URL and login password. Configure Base URL, API Key and model in Settings. Use a Codex-compatible Responses endpoint; provider/model compatibility is separate from successful platform startup.

## Display modes

| Option | Behavior |
| --- | --- |
| `--desktop auto` | Uses native windows on macOS or Linux with DISPLAY; embedded mode on headless Linux |
| `--desktop embedded` | Linux Xvfb/Openbox/x11vnc per project, interactive Blender inside the webpage |
| `--desktop native-window` | Blender opens local windows; webpage displays latest captured scene and refresh control |

Native-window preview is **not live remote control**. Operate Blender using its local window; the browser remains the conversation/asset workspace. Captures used by agent verification remain available. Use embedded mode if a server browser needs full keyboard/mouse control.

Each project receives a separate MCP port and process identity handshake. The runner manages up to three projects by default (`PILOT_MAX_STUDIOS`, maximum 16); memory use grows with open scenes. Closing a project saves its scene and stops only its owned processes. Ctrl+C shuts down services and managed instances. Avoid editing Blender manually while the agent is changing the same scene.

The legacy `PILOT_EXTERNAL_DESKTOP` developer mode is not used by this launcher; arbitrary pre-existing Blender windows are not adopted.

## Platforms

Linux embedded mode is the established architecture and can run natively with the same helper programs used in Docker. Native-window support avoids Linux desktop dependencies on macOS. macOS and WSL2 implementation paths have not yet passed physical-machine acceptance. Native Windows Python/Node deployment is intentionally rejected; use a WSL2 Linux environment. WSLg window mode requires a functional DISPLAY; otherwise use embedded mode.

## Network and storage

API defaults to `127.0.0.1:8090`; runner always uses `127.0.0.1:8091`. Change ports with `--port` and `--runner-port`. For remote access, explicitly set `--host 0.0.0.0`, use a reverse proxy with HTTPS and WebSocket/SSE support, and set `PILOT_SECURE_COOKIE=true` for HTTPS. Do not expose MCP, VNC, runner or PostgreSQL publicly.

`PILOT_DATA` defaults to the repository's `.data` directory. Both services inherit the same absolute path. No cross-container path mapping is needed. Moving an existing deployment requires a coordinated PostgreSQL + data-directory backup/restore; switching commands alone does not migrate Docker data. See [database](database.md) and [deployment](deployment.md).

## Troubleshooting

- **Blender not found:** pass the actual executable using `--blender`, not its parent directory or `.app` folder.
- **Missing desktop helper:** install the Linux packages above or use native-window on a machine with a desktop.
- **Database connection fails:** verify URL, user, database and service availability. No model key is needed for this check.
- **Project created, opening failed:** retry **Open project** on the existing project; do not create another project.
- **Port occupied:** stop the previous launcher cleanly or choose different HTTP ports. Existing Blender/MCP listeners are not silently reused.
- **Native preview empty:** open a project and click Update screenshot; this is a capture view, not VNC streaming.
- **MCP or Blender version incompatibility:** keep the pinned MCP dependencies, inspect project `runtime/*.log`, and record the Blender version in an issue.

The unified entry point also accepts `./docker-up.sh --native --setup` (same native launcher; Blender stays on the host).
