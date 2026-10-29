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
