"""Native launcher. Keeps Blender, MCP, API and files on the same host."""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent

def blender_binary(explicit=None):
    candidates = [explicit, os.environ.get('BLENDER_BIN'), shutil.which('blender')]
    if sys.platform == 'darwin':
        candidates += ['/Applications/Blender.app/Contents/MacOS/Blender', str(Path.home() / 'Applications/Blender.app/Contents/MacOS/Blender')]
    for candidate in candidates:
        if candidate and Path(candidate).is_file() and os.access(candidate, os.X_OK):
            return str(Path(candidate).resolve())
    raise RuntimeError('Blender not found. Install Blender or pass --blender /absolute/path/to/blender. No existing Blender installation is replaced.')

def run(command, **kwargs):
    subprocess.run(command, cwd=ROOT, check=True, **kwargs)

def free_port(port):
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', port))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--blender', help='Existing Blender executable; paths with spaces are supported')
    parser.add_argument('--desktop', choices=['auto', 'embedded', 'native-window'], default='auto')
    parser.add_argument('--setup', action='store_true', help='Install pinned Node/MCP dependencies and build the app')
    parser.add_argument('--check', action='store_true', help='Validate dependencies/configuration without starting services')
    parser.add_argument('--port', type=int, default=8090)
    parser.add_argument('--runner-port', type=int, default=8091)
    parser.add_argument('--host', default='127.0.0.1')
    args = parser.parse_args()
    if sys.platform not in ('linux', 'darwin'):
        raise RuntimeError('Use WSL2 on Windows; native Windows is not supported in v0.1.0.')
    if args.port == args.runner_port or not all(1024 <= n <= 65535 for n in (args.port, args.runner_port)):
        raise RuntimeError('Choose two different ports between 1024 and 65535.')
    blender = blender_binary(args.blender)
    mode = args.desktop
    if mode == 'auto':
        mode = 'native-window' if sys.platform == 'darwin' or os.environ.get('DISPLAY') else 'embedded'
    if mode == 'embedded' and sys.platform != 'linux':
        raise RuntimeError('Embedded desktop requires Linux. Use --desktop native-window on macOS.')
    if mode == 'native-window' and sys.platform == 'linux' and not os.environ.get('DISPLAY'):
        raise RuntimeError('Native windows need DISPLAY (X11/XWayland/WSLg). Use --desktop embedded on headless Linux.')
    data = Path(os.environ.get('PILOT_DATA', ROOT / '.data')).expanduser().resolve()
    data.mkdir(parents=True, exist_ok=True)
    config_path = data / 'local-config.json'
    config = json.loads(config_path.read_text()) if config_path.exists() else {}
    env = {**os.environ}
    for key in ('DATABASE_URL', 'PILOT_PASSWORD', 'PILOT_INTERNAL_TOKEN'):
        if not env.get(key) and config.get(key):
            env[key] = config[key]
    if not env.get('DATABASE_URL'):
        if args.check or not sys.stdin.isatty():
            raise RuntimeError('Set DATABASE_URL to your PostgreSQL connection URL; see docs/native-deployment.md.')
        import getpass
        env['DATABASE_URL'] = getpass.getpass('PostgreSQL URL (hidden): ').strip()
    if not env['DATABASE_URL'].startswith(('postgres://', 'postgresql://')):
        raise RuntimeError('DATABASE_URL must be a PostgreSQL URL.')
    env.setdefault('PILOT_PASSWORD', secrets.token_urlsafe(18))
    env.setdefault('PILOT_INTERNAL_TOKEN', secrets.token_urlsafe(32))
    venv = ROOT / '.local-runtime' / 'mcp'
    python = venv / 'bin/python'
    npm = shutil.which('npm')
    node = shutil.which('node')
    if not npm or not node:
        raise RuntimeError('Install Node.js 22.12+ (or 24 LTS), including npm.')
    version = subprocess.check_output([node, '-p', 'process.versions.node'], text=True).strip().split('.')
    if int(version[0]) < 22 or (int(version[0]) == 22 and int(version[1]) < 12):
        raise RuntimeError('Node.js 22.12+ is required.')
    if args.setup:
        run([npm, 'ci', '--no-audit', '--no-fund'])
        if not python.exists():
            run([sys.executable, '-m', 'venv', str(venv)])
        run([str(python), '-m', 'pip', 'install', '-r', 'deploy/requirements.lock'])
        run([npm, 'run', 'build'])
    if not python.exists() or not (ROOT / 'dist/server/apps/server/index.js').exists():
        raise RuntimeError('Run ./local-up.sh --setup first.')
    addon = subprocess.check_output([str(python), '-c', "from importlib.resources import files; print(files('blender_mcp') / 'bundled' / 'addon.py')"], text=True).strip()
    if not Path(addon).is_file():
        raise RuntimeError('Pinned Blender MCP addon not found; rerun --setup.')
    if mode == 'embedded':
        for executable in ('Xvfb', 'openbox', 'x11vnc'):
            if not shutil.which(executable):
                raise RuntimeError('Missing ' + executable + '. See Linux packages in docs/native-deployment.md.')
    env.update(PILOT_DATA=str(data), BLENDER_BIN=blender, MCP_BIN=str(venv / 'bin/mcp-for-blender'),
               PILOT_ADDON_PATH=addon, PILOT_BOOTSTRAP_PATH=str(ROOT / 'deploy/bootstrap.py'),
               PILOT_DESKTOP_MODE=mode, PILOT_EXTERNAL_DESKTOP='false', HOST=args.host,
               PORT=str(args.port), RUNNER_HOST='127.0.0.1', RUNNER_PORT=str(args.runner_port),
               PILOT_RUNNER_URL=f'http://127.0.0.1:{args.runner_port}',
               PATH=str(ROOT / 'node_modules/.bin') + os.pathsep + env.get('PATH', ''))
    # No credentials in command arguments or diagnostics.
    run([node, '--input-type=module', '-e', "import pg from 'pg'; const c=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000}); await c.connect(); await c.query('SELECT 1'); await c.end();"], env=env)
    run([blender, '--version'], env=env)
    for port in (args.port, args.runner_port):
        free_port(port)
    if args.check:
        print('Native preflight passed:', mode)
        return
    config = {key: env[key] for key in ('DATABASE_URL', 'PILOT_PASSWORD', 'PILOT_INTERNAL_TOKEN')}
    fd = os.open(config_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(config, stream)
    children = []
    def stop(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    try:
        for entry in ('runner', 'server'):
            children.append(subprocess.Popen([node, f'dist/server/apps/{entry}/index.js'], cwd=ROOT, env=env))
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if any(p.poll() is not None for p in children):
                raise RuntimeError('A service exited during startup; inspect the error above.')
            try:
                request = urllib.request.Request(env['PILOT_RUNNER_URL'] + '/health', headers={'Authorization': 'Bearer ' + env['PILOT_INTERNAL_TOKEN']})
                with urllib.request.urlopen(request, timeout=2) as response:
                    ready = json.load(response).get('ok')
                with urllib.request.urlopen(f'http://127.0.0.1:{args.port}/api/auth/status', timeout=2):
                    pass
                if ready:
                    break
            except (OSError, ValueError):
                time.sleep(.3)
        else:
            raise RuntimeError('Services did not become ready within 60 seconds.')
        print(f'Blender Pilot: http://localhost:{args.port} | mode: {mode}', flush=True)
        print('Login password: ' + env['PILOT_PASSWORD'], flush=True)
        print('Ctrl+C stops services and saves managed Blender scenes.', flush=True)
        while all(p.poll() is None for p in children):
            time.sleep(.5)
        raise RuntimeError('A service exited; stopping the other service.')
    except KeyboardInterrupt:
        pass
    finally:
        for p in children:
            if p.poll() is None:
                p.terminate()
        for p in children:
            try:
                p.wait(timeout=40)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait()

if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print('Native startup failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
