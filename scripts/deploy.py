#!/usr/bin/env python3
"""One-entry deployment. No dotenv is ever sourced or evaluated as shell code."""
import argparse, contextlib, hashlib, ipaddress, json, os, pathlib, re, secrets, shutil, subprocess, sys, tempfile, time, urllib.error, urllib.parse, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OFFICIAL = "https://download.blender.org/release"
DEFAULT_VERSION = "5.2.3"
DEFAULT_SHA = "78486c018b4443efe5e75ab54c290ed8c15abafd249b862c2c9ce2530a918eec"


def fail(message):
    raise RuntimeError(message)


def read_env(file):
    result = {}
    if not file.exists():
        return result
    for line in file.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", line):
            fail("Invalid .env line; use KEY=value format.")
        key, value = line.split("=", 1)
        if value.startswith("'") and value.endswith("'"):
            value = value[1:-1].replace("\\'", "'")
        elif value.startswith('"') and value.endswith('"'):
            value = json.loads(value).replace("$$", "$")
        result[key] = value
    return result


def write_env(file, config):
    file.parent.mkdir(parents=True, exist_ok=True)
    content = "# Managed by docker-up.sh. Contains secrets; do not commit.\n"
    for key, value in config.items():
        value = str(value)
        if "\n" in value or "\r" in value or "\x00" in value:
            fail("Configuration values must be single-line strings.")
        # Compose decodes double-quoted JSON escapes and treats $$ as a literal
        # dollar. Single quotes keep backslashes verbatim and cannot safely
        # round-trip every password, including trailing backslashes.
        content += (
            key + "=" + json.dumps(value.replace("$", "$$"), ensure_ascii=False) + "\n"
        )
    fd, temp = tempfile.mkstemp(prefix="." + file.name + "-", dir=file.parent)
    try:
        os.fchmod(fd, 0o600)
        if (
            os.geteuid() == 0
            and os.environ.get("SUDO_UID")
            and os.environ.get("SUDO_GID")
        ):
            os.fchown(fd, int(os.environ["SUDO_UID"]), int(os.environ["SUDO_GID"]))
        with os.fdopen(fd, "w") as stream:
            stream.write(content)
        os.replace(temp, file)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temp)


def fetch(url):
    return subprocess.check_output(
        [
            "curl",
            "--fail",
            "--silent",
            "--show-error",
            "--location",
            "--retry",
            "2",
            "--connect-timeout",
            "15",
            "--max-time",
            "60",
            url,
        ],
        text=True,
    )


def resolve_blender(version):
    if version == "latest":
        series = sorted(
            set(re.findall(r'href="Blender(\d+\.\d+)/"', fetch(OFFICIAL + "/"))),
            key=lambda s: tuple(map(int, s.split("."))),
            reverse=True,
        )
        for branch in series:
            versions = re.findall(
                r'href="blender-(\d+\.\d+\.\d+)-linux-x64\.tar\.xz"',
                fetch(OFFICIAL + "/Blender" + branch + "/"),
            )
            if versions:
                version = max(versions, key=lambda s: tuple(map(int, s.split("."))))
                break
        else:
            fail(
                "No stable Linux x64 Blender release found on the official download site."
            )
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        fail("Blender version must be latest or an exact stable version, e.g. 5.2.3.")
    branch = ".".join(version.split(".")[:2])
    filename = f"blender-{version}-linux-x64.tar.xz"
    checksums = fetch(f"{OFFICIAL}/Blender{branch}/blender-{version}.sha256")
    found = [
        line.split()[0]
        for line in checksums.splitlines()
        if len(line.split()) == 2 and line.split()[1].lstrip("*") == filename
    ]
    if len(found) != 1 or not re.fullmatch("[0-9a-fA-F]{64}", found[0]):
        fail("Official SHA256 entry missing or ambiguous.")
    return version, found[0].lower()


def parser():
    p = argparse.ArgumentParser(
        description="Deploy Blender Pilot + PostgreSQL + Blender with one command. Host Blender is not required."
    )
    p.add_argument("--env-file", default=str(ROOT / ".env"))
    p.add_argument("--port", type=int)
    p.add_argument("--bind", help="Bind IP, default 0.0.0.0")
    p.add_argument("--password")
    p.add_argument("--password-file")
    p.add_argument(
        "--data-dir",
        help="Absolute or repo-relative directory for models, textures, captures and sessions",
    )
    p.add_argument("--database-dir", help="Directory for bundled PostgreSQL data")
    p.add_argument(
        "--database-url",
        help="Use an existing PostgreSQL server instead of the bundled service",
    )
    p.add_argument(
        "--blender-version",
        help="latest (first-deploy default), or exact version; reruns retain saved version unless explicitly changed",
    )
    p.add_argument("--max-studios", type=int)
    p.add_argument("--resolution", help="e.g. 1440x900x24")
    p.add_argument(
        "--secure-cookie", action=argparse.BooleanOptionalAction, default=None
    )
    p.add_argument("--gpu", action=argparse.BooleanOptionalAction, default=None)
    p.add_argument(
        "--install-docker",
        action="store_true",
        help="Install Docker Engine and Compose from the official apt repository on Ubuntu/Debian",
    )
    p.add_argument(
        "--configure-only",
        action="store_true",
        help="Write configuration without creating directories or starting services",
    )
    p.add_argument(
        "--legacy-volume",
        help="Import an old named volume into an empty data directory; default auto-detects blender-pilot_pilot-data",
    )
    p.add_argument("--no-build", action="store_true")
    p.add_argument("--skip-smoke", action="store_true")
    p.add_argument("--wait-timeout", type=int, default=300)
    p.add_argument("--model-url")
    p.add_argument("--model")
    p.add_argument(
        "--api-key-file",
        help="Read model API key from a local file; never put the key in argv or .env",
    )
    return p


def configure(args):
    envfile = pathlib.Path(args.env_file).expanduser().resolve()
    old = read_env(envfile)
    c = dict(old)
    defaults = {
        "PILOT_PORT": "8090",
        "PILOT_BIND": "0.0.0.0",
        "PILOT_SECURE_COOKIE": "false",
        "PILOT_RESOLUTION": "1440x900x24",
        "PILOT_MAX_STUDIOS": "3",
        "PILOT_GPU": "false",
        "POSTGRES_DB": "blender_pilot",
        "POSTGRES_USER": "blender_pilot",
        "POSTGRES_IMAGE": "postgres:18.6-bookworm",
        "PILOT_DATA_DIR": str(ROOT / "data"),
        "PILOT_POSTGRES_DIR": str(ROOT / "postgres-data"),
    }
    for k, v in defaults.items():
        c.setdefault(k, v)
    for k, n in [
        ("PILOT_PORT", "port"),
        ("PILOT_BIND", "bind"),
        ("PILOT_MAX_STUDIOS", "max_studios"),
        ("PILOT_RESOLUTION", "resolution"),
    ]:
        if getattr(args, n) is not None:
            c[k] = str(getattr(args, n))
    for k, n in [
        ("PILOT_DATA_DIR", "data_dir"),
        ("PILOT_POSTGRES_DIR", "database_dir"),
    ]:
        if getattr(args, n):
            c[k] = str((ROOT / pathlib.Path(getattr(args, n)).expanduser()).resolve())
    for k in ["PILOT_DATA_DIR", "PILOT_POSTGRES_DIR"]:
        c[k] = str(pathlib.Path(c[k]).expanduser().resolve())
        if any(x in c[k] for x in [":", "\n", "\r"]):
            fail(
                "Storage directory paths must not contain colon or newline characters."
            )
    if args.password and args.password_file:
        fail("Choose --password or --password-file.")
    if args.password_file:
        c["PILOT_PASSWORD"] = (
            pathlib.Path(args.password_file).read_text().rstrip("\r\n")
        )
    elif args.password is not None:
        c["PILOT_PASSWORD"] = args.password
    created_password = "PILOT_PASSWORD" not in c
    c.setdefault("PILOT_PASSWORD", secrets.token_hex(16))
    c.setdefault("PILOT_INTERNAL_TOKEN", secrets.token_hex(32))
    c.setdefault("POSTGRES_PASSWORD", secrets.token_hex(32))
    if len(c["PILOT_PASSWORD"]) < 12:
        fail("Workspace password must contain at least 12 characters.")
    if len(c["PILOT_INTERNAL_TOKEN"]) < 24:
        fail("Internal token must contain at least 24 characters.")
    try:
        if (
            not 1 <= int(c["PILOT_PORT"]) <= 65535
            or not 1 <= int(c["PILOT_MAX_STUDIOS"]) <= 16
        ):
            raise ValueError()
        ipaddress.ip_address(c["PILOT_BIND"])
    except ValueError:
        fail("Invalid bind IP, port or max-studios (1..16).")
    if not re.fullmatch(r"\d{3,4}x\d{3,4}x24", c["PILOT_RESOLUTION"]):
        fail("Resolution must be WIDTHxHEIGHTx24.")
    if args.secure_cookie is not None:
        c["PILOT_SECURE_COOKIE"] = str(args.secure_cookie).lower()
    if args.gpu is not None:
        c["PILOT_GPU"] = str(args.gpu).lower()
    if args.wait_timeout < 30:
        fail("Wait timeout must be at least 30 seconds.")
    if args.database_url:
        c["DATABASE_URL"] = args.database_url
        c["PILOT_BUNDLED_DB"] = "false"
    else:
        c.setdefault(
            "PILOT_BUNDLED_DB",
            (
                "false"
                if c.get("DATABASE_URL") and old.get("PILOT_BUNDLED_DB") == "false"
                else "true"
            ),
        )
        if c["PILOT_BUNDLED_DB"] == "true":
            c["DATABASE_URL"] = (
                "postgresql://"
                + urllib.parse.quote(c["POSTGRES_USER"], safe="")
                + ":"
                + urllib.parse.quote(c["POSTGRES_PASSWORD"], safe="")
                + "@db:5432/"
                + urllib.parse.quote(c["POSTGRES_DB"], safe="")
            )
    u = urllib.parse.urlsplit(c["DATABASE_URL"])
    if (
        u.scheme not in ["postgres", "postgresql"]
        or not u.hostname
        or not u.path.strip("/")
    ):
        fail("Database URL must point to a PostgreSQL database.")
    if not re.fullmatch(
        "[A-Za-z_][A-Za-z0-9_]*", c["POSTGRES_USER"]
    ) or not re.fullmatch("[A-Za-z_][A-Za-z0-9_]*", c["POSTGRES_DB"]):
        fail("Invalid bundled PostgreSQL user/database name.")
    protected = {
        "/",
        "/etc",
        "/usr",
        "/bin",
        "/sbin",
        "/var",
        "/var/lib",
        "/home",
        "/root",
        "/opt",
        "/srv",
        "/tmp",
        "/run",
        "/dev",
        "/proc",
        "/sys",
    }
    if any(c[k] in protected for k in ["PILOT_DATA_DIR", "PILOT_POSTGRES_DIR"]):
        fail(
            "Use dedicated application storage subdirectories, not a system directory."
        )
    files = pathlib.Path(c["PILOT_DATA_DIR"])
    pgdata = pathlib.Path(c["PILOT_POSTGRES_DIR"])
    if c["PILOT_BUNDLED_DB"] == "true" and (
        files.is_relative_to(pgdata) or pgdata.is_relative_to(files)
    ):
        fail(
            "File and PostgreSQL directories must be separate and must not contain each other."
        )
    version = args.blender_version or c.get("BLENDER_VERSION") or "latest"
    if (
        version != c.get("BLENDER_VERSION")
        or args.blender_version
        or not c.get("BLENDER_SHA256")
    ):
        if not shutil.which("curl"):
            fail("curl is required to resolve official Blender releases.")
        c["BLENDER_VERSION"], c["BLENDER_SHA256"] = resolve_blender(version)
    if not re.fullmatch(r"\d+\.\d+\.\d+", c["BLENDER_VERSION"]) or not re.fullmatch(
        "[0-9a-f]{64}", c["BLENDER_SHA256"]
    ):
        fail("Invalid pinned Blender version/checksum.")
    if any([args.model_url, args.model, args.api_key_file]) and not all(
        [args.model_url, args.model, args.api_key_file]
    ):
        fail(
            "Model bootstrap requires --model-url, --model and --api-key-file together."
        )
    write_env(envfile, c)
    return envfile, c, created_password


def install_docker():
    info = {}
    for line in pathlib.Path("/etc/os-release").read_text().splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            info[k] = v.strip('"')
    distro = info.get("ID")
    codename = info.get("VERSION_CODENAME")
    if distro not in ["ubuntu", "debian"] or not codename:
        fail("--install-docker supports Ubuntu/Debian only.")
    prefix = [] if os.geteuid() == 0 else ["sudo"]

    def run(cmd):
        subprocess.run(prefix + cmd, check=True)

    run(["apt-get", "update"])
    run(["apt-get", "install", "-y", "ca-certificates", "curl", "gnupg"])
    run(["install", "-m", "0755", "-d", "/etc/apt/keyrings"])
    run(
        [
            "curl",
            "-fsSL",
            f"https://download.docker.com/linux/{distro}/gpg",
            "-o",
            "/etc/apt/keyrings/docker.asc",
        ]
    )
    run(["chmod", "a+r", "/etc/apt/keyrings/docker.asc"])
    arch = subprocess.check_output(["dpkg", "--print-architecture"], text=True).strip()
    content = f"deb [arch={arch} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/{distro} {codename} stable\n"
    subprocess.run(
        prefix + ["tee", "/etc/apt/sources.list.d/docker.list"],
        input=content,
        text=True,
        check=True,
        stdout=subprocess.DEVNULL,
    )
    run(["apt-get", "update"])
    run(
        [
            "apt-get",
            "install",
            "-y",
            "docker-ce",
            "docker-ce-cli",
            "containerd.io",
            "docker-buildx-plugin",
            "docker-compose-plugin",
        ]
    )
    run(["systemctl", "enable", "--now", "docker"])


def pin_compose_environment(config):
    # Compose gives exported shell variables precedence over --env-file.
    # Keep the reviewed deployment configuration authoritative even when the
    # operator previously exported another project's DATABASE_URL/password.
    for key, value in config.items():
        if key == "DATABASE_URL" or key.startswith(("PILOT_", "POSTGRES_", "BLENDER_")):
            os.environ[key] = str(value)


def compose_command(envfile, c):
    docker = ["docker"]
    if subprocess.run(
        docker + ["info"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    ).returncode:
        if (
            os.geteuid() != 0
            and shutil.which("sudo")
            and subprocess.run(
                ["sudo", "-n", "docker", "info"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            ).returncode
            == 0
        ):
            docker = ["sudo", "-n", "docker"]
        else:
            fail(
                "Docker daemon is not accessible. Start Docker and grant this user access, or run with sudo."
            )
    subprocess.run(
        docker + ["compose", "version"], check=True, stdout=subprocess.DEVNULL
    )
    cmd = docker + [
        "compose",
        "--project-directory",
        str(ROOT),
        "--env-file",
        str(envfile),
        "-f",
        str(ROOT / "compose.yaml"),
    ]
    if c["PILOT_GPU"] == "true":
        cmd += ["-f", str(ROOT / "compose.gpu.yaml")]
    if c["PILOT_BUNDLED_DB"] == "true":
        cmd += ["--profile", "bundled-db"]
    return cmd


def import_legacy_volume(cmd, c, args):
    volume = args.legacy_volume or "blender-pilot_pilot-data"
    if not re.fullmatch("[a-zA-Z0-9][a-zA-Z0-9_.-]+", volume):
        fail("Invalid legacy volume name.")
    docker = cmd[: cmd.index("compose")]
    exists = (
        subprocess.run(
            docker + ["volume", "inspect", volume],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode
        == 0
    )
    if args.legacy_volume and not exists:
        fail("Requested legacy volume does not exist.")
    if not exists:
        return
    check = subprocess.run(
        cmd
        + [
            "run",
            "--rm",
            "--no-deps",
            "--user",
            "0:0",
            "--entrypoint",
            "sh",
            "web",
            "-c",
            'test -e /data/.legacy-volume-import.pending || test -z "$(find /data -mindepth 1 -maxdepth 1 -print -quit)"',
        ],
        stdout=subprocess.DEVNULL,
    )
    if check.returncode == 1:
        return
    if check.returncode != 0:
        fail("Cannot inspect the local data directory through Docker.")
    subprocess.run(cmd + ["stop", "web", "studio"], check=True)
    subprocess.run(
        cmd
        + [
            "run",
            "--rm",
            "--no-deps",
            "--user",
            "0:0",
            "--entrypoint",
            "sh",
            "-v",
            volume + ":/legacy:ro",
            "web",
            "-c",
            "touch /data/.legacy-volume-import.pending && cp -a /legacy/. /data/ && rm /data/.legacy-volume-import.pending",
        ],
        check=True,
    )
    print("Copied legacy volume into the local data directory; source volume retained.")


def smoke(c, args):
    host = c["PILOT_BIND"]
    host = "127.0.0.1" if host in ["0.0.0.0", "::"] else host
    if ":" in host:
        host = "[" + host + "]"
    base = "http://" + host + ":" + c["PILOT_PORT"]
    cookie = ""

    def api(route, payload=None, method=None):
        nonlocal cookie
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(
            base + "/api" + route,
            data=data,
            method=method or ("POST" if data is not None else "GET"),
            headers={"Content-Type": "application/json", "Cookie": cookie},
        )
        # Local service checks must not be sent through an outbound proxy.
        try:
            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(
                req, timeout=190
            ) as res:
                if route == "/auth/login":
                    cookie = res.headers.get("Set-Cookie", "").split(";")[0]
                return json.load(res)
        except urllib.error.HTTPError as e:
            try:
                message = json.load(e).get("error", "HTTP " + str(e.code))
            except Exception:
                message = "HTTP " + str(e.code)
            fail("Deployment smoke check failed: " + route + ": " + message)

    api("/auth/login", {"password": c["PILOT_PASSWORD"]})
    h = api("/health")
    if not h.get("database", {}).get("ok"):
        fail("PostgreSQL readiness check failed.")
    if args.api_key_file:
        key = pathlib.Path(args.api_key_file).read_text().strip()
        if not key:
            fail("API key file is empty.")
        api(
            "/settings",
            {
                "baseUrl": args.model_url,
                "model": args.model,
                "apiKey": key,
                "effort": "medium",
            },
            "PUT",
        )
        if not api("/settings/test", {}).get("ok"):
            fail("Model connection check failed.")
    projects = api("/projects")
    idle_ids = [
        s["projectId"]
        for s in h.get("execution", {}).get("studios", [])
        if s.get("status") == "ready" and not s.get("runId")
    ]
    p = next((p for p in projects if p["id"] in idle_ids), None) or (
        projects[0] if projects else api("/projects", {"name": "我的第一个场景"})
    )
    api("/projects/" + p["id"] + "/activate", {})
    scene = api("/projects/" + p["id"] + "/scene")
    if str(scene.get("version", "")).split()[0] != c["BLENDER_VERSION"].split()[0]:
        fail("Running Blender version does not match the configured build.")
    if not isinstance(scene.get("objects"), list):
        fail("Blender scene check returned no objects.")
    cap = api("/projects/" + p["id"] + "/captures", {})
    if not cap.get("id"):
        fail("Blender screenshot check failed.")
    req = urllib.request.Request(
        base + "/api/files/capture/" + cap["id"], headers={"Cookie": cookie}
    )
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(
        req, timeout=30
    ) as response:
        image = response.read()
        if not image.startswith(b"\xff\xd8") or len(image) < 1000:
            fail("Blender screenshot download is invalid.")
    api("/projects/" + p["id"] + "/save", {})
    print(
        "Verified: PostgreSQL, login, Blender "
        + scene["version"]
        + ", MCP scene read, screenshot and save."
    )


def main(argv=None):
    args = parser().parse_args(argv)
    if not args.configure_only:
        if sys.platform != "linux" or os.uname().machine not in ["x86_64", "amd64"]:
            fail("Studio deployment currently supports Linux x86_64.")
        if args.install_docker:
            install_docker()
        if not shutil.which("docker"):
            fail("Docker is missing. On Ubuntu/Debian rerun with --install-docker.")
    envfile, c, created = configure(args)
    print("Configuration saved: " + str(envfile))
    print(
        "Blender: "
        + c["BLENDER_VERSION"]
        + "; PostgreSQL: "
        + ("bundled" if c["PILOT_BUNDLED_DB"] == "true" else "external")
    )
    if args.configure_only:
        if created:
            print("Workspace password: " + c["PILOT_PASSWORD"])
        return 0
    for key in ["PILOT_DATA_DIR", "PILOT_POSTGRES_DIR"]:
        if key == "PILOT_POSTGRES_DIR" and c["PILOT_BUNDLED_DB"] != "true":
            continue
        pathlib.Path(c[key]).mkdir(parents=True, exist_ok=True, mode=0o700)
    pin_compose_environment(c)
    cmd = compose_command(envfile, c)
    subprocess.run(cmd + ["config", "--quiet"], check=True)
    if not args.no_build:
        subprocess.run(cmd + ["build"], check=True)
    import_legacy_volume(cmd, c, args)
    subprocess.run(
        cmd
        + [
            "run",
            "--rm",
            "--no-deps",
            "--user",
            "0:0",
            "--entrypoint",
            "sh",
            "web",
            "-c",
            "mkdir -p /data/config && chown -R 1000:1000 /data",
        ],
        check=True,
    )
    if c["PILOT_BUNDLED_DB"] == "true":
        subprocess.run(
            cmd
            + ["up", "-d", "--wait", "--wait-timeout", str(args.wait_timeout), "db"],
            check=True,
        )
    legacy = subprocess.run(
        cmd
        + [
            "run",
            "--rm",
            "--no-deps",
            "--user",
            "0:0",
            "--entrypoint",
            "sh",
            "web",
            "-c",
            'test -f /data/database/PG_VERSION || test -n "$(find /data/library -mindepth 2 -maxdepth 2 -name asset.json -print -quit 2>/dev/null)"',
        ],
        stdout=subprocess.DEVNULL,
    )
    if legacy.returncode not in [0, 1]:
        fail("Cannot inspect legacy metadata through Docker.")
    if legacy.returncode == 0:
        subprocess.run(cmd + ["stop", "web", "studio"], check=True)
        subprocess.run(
            cmd
            + [
                "run",
                "--rm",
                "--no-deps",
                "web",
                "node",
                "dist/server/apps/server/migrate.js",
            ],
            check=True,
        )
    subprocess.run(
        cmd + ["up", "-d", "--wait", "--wait-timeout", str(args.wait_timeout)],
        check=True,
    )
    if not args.skip_smoke:
        smoke(c, args)
    host = (
        c["PILOT_BIND"] if c["PILOT_BIND"] not in ["0.0.0.0", "::"] else "<server-ip>"
    )
    print(f'Ready: http://{host}:{c["PILOT_PORT"]}')
    if created:
        print("Workspace password: " + c["PILOT_PASSWORD"])
    print(
        "Re-run this command to retain configuration and pinned versions. Back up both local directories before upgrading."
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, ValueError, OSError, subprocess.CalledProcessError) as e:
        # Do not echo subprocess argv, URL credentials or model keys.
        print(
            "Deployment failed: "
            + (
                str(e)
                if isinstance(e, (RuntimeError, ValueError))
                else type(e).__name__ + ". See the preceding command output."
            ),
            file=sys.stderr,
        )
        sys.exit(1)
