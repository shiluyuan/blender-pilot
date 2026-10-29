import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('pilot_local', Path(__file__).resolve().parents[1] / 'scripts/local.py')
local = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local)

class NativeDiscovery(unittest.TestCase):
    def test_existing_blender_with_spaces_is_reused(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / 'Blender App'
            executable.write_text('#!/bin/sh\nexit 0\n')
            executable.chmod(0o755)
            self.assertEqual(local.blender_binary(str(executable)), str(executable))
            self.assertEqual(executable.read_text(), '#!/bin/sh\nexit 0\n')
    def test_missing_blender_explains_action(self):
        with patch.object(local.sys, 'platform', 'linux'), patch.dict(os.environ, {}, clear=True), patch.object(local.shutil, 'which', return_value=None):
            with self.assertRaisesRegex(RuntimeError, 'Blender not found'):
                local.blender_binary()

    def test_explicit_missing_binary_never_falls_back(self):
        with patch.object(local.shutil, 'which', return_value='/bin/sh'):
            with self.assertRaisesRegex(RuntimeError, 'Blender not found'):
                local.blender_binary('/missing/intentionally-selected-blender')

    def test_failed_config_replace_preserves_credentials_and_cleans_temp(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'local-config.json'
            local.save_config(file, {'PILOT_PASSWORD': 'original-fixture'})
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            with patch.object(local.os, 'replace', side_effect=OSError('disk failure')):
                with self.assertRaises(OSError):
                    local.save_config(file, {'PILOT_PASSWORD': 'new-fixture'})
            self.assertEqual(local.load_config(file), {'PILOT_PASSWORD': 'original-fixture'})
            self.assertEqual([p.name for p in Path(directory).iterdir()], ['local-config.json'])

    def test_corrupt_config_is_not_silently_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'local-config.json'
            self.assertEqual(local.load_config(file), {})
            for body in ['{broken', '[]', '{"PILOT_PASSWORD": null}']:
                file.write_text(body)
                with self.assertRaises(RuntimeError):
                    local.load_config(file)
                self.assertEqual(file.read_text(), body)
