import shutil
import subprocess
import importlib.util, pathlib, tempfile, unittest, unittest.mock as mock, os

spec = importlib.util.spec_from_file_location(
    "pilot_deploy", pathlib.Path(__file__).parents[1] / "scripts" / "deploy.py"
)
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DeploymentTests(unittest.TestCase):
    def configure(self, extra=None):
        folder = pathlib.Path(tempfile.mkdtemp(prefix="pilot-deploy-"))
        env = folder / "config.env"
        with mock.patch.object(
            deploy,
            "resolve_blender",
            return_value=(deploy.DEFAULT_VERSION, deploy.DEFAULT_SHA),
        ):
            args = deploy.parser().parse_args(
                ["--configure-only", "--env-file", str(env)] + (extra or [])
            )
            result = deploy.configure(args)
        return folder, args, result

    def test_rerun_retains_secrets_and_pinned_versions(self):
        folder, args, (_, config, created) = self.configure(
            ["--port", "8095", "--max-studios", "2"]
        )
        self.assertTrue(created)
        with mock.patch.object(
            deploy,
            "resolve_blender",
            side_effect=AssertionError("must not re-resolve pinned version"),
        ):
            _, again, created = deploy.configure(args)
        self.assertEqual(config, again)
        self.assertFalse(created)
        self.assertEqual(os.stat(folder / "config.env").st_mode & 0o777, 0o600)

    def test_password_literals_are_round_trip_safe_and_not_shell_evaluated(self):
        cases = [
            "safe-$(touch NEVER)-`id`-$HOME-quote'\\backslash",
            "trailing-password-" + chr(92),
            "double-password-" + chr(92) * 2,
            "literal-password-$$-${MISSING}",
            '中文-Password-with-"quotes"',
        ]
        for password in cases:
            with self.subTest(case=password):
                _, _, (env, c, _) = self.configure(["--password", password])
                self.assertEqual(deploy.read_env(env)["PILOT_PASSWORD"], password)
                self.assertEqual(c["PILOT_PASSWORD"], password)
                compose = (
                    [os.environ["PILOT_COMPOSE_BIN"]]
                    if os.environ.get("PILOT_COMPOSE_BIN")
                    else (["docker", "compose"] if shutil.which("docker") else None)
                )
                if compose:
                    raw = subprocess.check_output(
                        compose
                        + [
                            "--env-file",
                            str(env),
                            "-f",
                            str(deploy.ROOT / "compose.yaml"),
                            "--profile",
                            "bundled-db",
                            "config",
                            "--environment",
                        ],
                        text=True,
                    )
                    values = dict(
                        line.split("=", 1) for line in raw.splitlines() if "=" in line
                    )
                    self.assertEqual(values["PILOT_PASSWORD"], password)
        self.assertFalse((deploy.ROOT / "NEVER").exists())

    def test_bad_values_do_not_write_config(self):
        for extra in [
            ["--port", "65536"],
            ["--max-studios", "0"],
            ["--bind", "evil;cmd"],
            ["--password", "short"],
            ["--database-url", "https://db.invalid"],
            ["--resolution", "bad"],
            ["--data-dir", "/"],
            ["--data-dir", "/srv/pilot", "--database-dir", "/srv/pilot/pgsql"],
        ]:
            with self.subTest(extra=extra):
                with self.assertRaises(RuntimeError):
                    self.configure(extra)

    def test_external_database_and_local_paths(self):
        _, _, (_, c, _) = self.configure(
            [
                "--database-url",
                "postgresql://test:secret@pg.internal:5432/pilot?sslmode=require",
                "--data-dir",
                "/srv/pilot/files",
                "--database-dir",
                "/srv/pilot/pgsql",
            ]
        )
        self.assertEqual(c["PILOT_BUNDLED_DB"], "false")
        self.assertEqual(c["PILOT_DATA_DIR"], "/srv/pilot/files")
        self.assertIn("sslmode=require", c["DATABASE_URL"])
        with mock.patch.dict(
            os.environ, {"DATABASE_URL": "postgresql://wrong:wrong@other/db"}
        ):
            old_path = os.environ.get("PATH")
            deploy.pin_compose_environment(c)
            self.assertEqual(os.environ["DATABASE_URL"], c["DATABASE_URL"])
            self.assertEqual(os.environ.get("PATH"), old_path)

    def test_latest_excludes_beta_and_verifies_checksum(self):
        def fetch(url):
            if url == deploy.OFFICIAL + "/":
                return '<a href="Blender5.3/">x</a><a href="Blender5.2/">x</a>'
            if url.endswith("Blender5.3/"):
                return '<a href="blender-5.3.0-beta-linux-x64.tar.xz">beta</a>'
            if url.endswith("Blender5.2/"):
                return '<a href="blender-5.2.2-linux-x64.tar.xz">x</a><a href="blender-5.2.3-linux-x64.tar.xz">x</a>'
            return deploy.DEFAULT_SHA + "  blender-5.2.3-linux-x64.tar.xz\n"

        with mock.patch.object(deploy, "fetch", side_effect=fetch):
            self.assertEqual(
                deploy.resolve_blender("latest"),
                (deploy.DEFAULT_VERSION, deploy.DEFAULT_SHA),
            )
        with mock.patch.object(deploy, "fetch", return_value="no checksum"):
            with self.assertRaises(RuntimeError):
                deploy.resolve_blender("5.2.3")

    def test_model_key_is_not_saved_in_dotenv(self):
        _, _, (env, c, _) = self.configure(
            [
                "--model-url",
                "https://model.example",
                "--model",
                "example",
                "--api-key-file",
                "/tmp/key-file",
            ]
        )
        self.assertNotIn("API_KEY", env.read_text())
        self.assertNotIn("api-key-file", env.read_text())

    def test_legacy_volume_is_read_only_and_nonempty_target_is_preserved(self):
        folder = pathlib.Path(tempfile.mkdtemp(prefix="pilot-volume-"))
        args = deploy.parser().parse_args(["--legacy-volume", "old_pilot"])
        c = {"PILOT_DATA_DIR": str(folder)}
        cmd = ["docker", "compose", "--env-file", "test.env"]
        with mock.patch.object(
            deploy.subprocess, "run", return_value=mock.Mock(returncode=0)
        ) as run:
            deploy.import_legacy_volume(cmd, c, args)
            calls = [x.args[0] for x in run.call_args_list]
            self.assertIn("old_pilot:/legacy:ro", calls[-1])
            self.assertIn("stop", calls[-2])
            self.assertFalse((folder / ".legacy-volume-import.pending").exists())
        (folder / "keep.blend").write_text("existing data")
        with mock.patch.object(
            deploy.subprocess,
            "run",
            side_effect=[mock.Mock(returncode=0), mock.Mock(returncode=1)],
        ) as run:
            deploy.import_legacy_volume(cmd, c, args)
            self.assertEqual(run.call_count, 2)
            self.assertEqual((folder / "keep.blend").read_text(), "existing data")


if __name__ == "__main__":
    unittest.main()
