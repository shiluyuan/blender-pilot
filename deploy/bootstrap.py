"""Load the pinned upstream addon and start a persistent localhost MCP endpoint."""
import bpy
import importlib.util
import os
import sys
from bpy.app.handlers import persistent
addon_path = os.environ.get('PILOT_ADDON_PATH', '/opt/pilot/addon.py')
spec = importlib.util.spec_from_file_location('blender_mcp', addon_path)
addon = importlib.util.module_from_spec(spec)
sys.modules['blender_mcp'] = addon
spec.loader.exec_module(addon)
addon.register()
bpy.context.preferences.filepaths.use_scripts_auto_execute = False
bpy.context.preferences.view.show_splash = False
@persistent
def changed(scene, depsgraph):
    bpy.app.driver_namespace['pilot_revision'] = bpy.app.driver_namespace.get('pilot_revision', 0) + 1
bpy.app.handlers.depsgraph_update_post.append(changed)
server = addon.BlenderMCPServer(host='127.0.0.1', port=int(os.environ.get('BLENDER_PORT', '9876')))
server.start()
# Module reference survives file loads; addon's command timer is persistent.
addon._pilot_server = server
print('BLENDER_PILOT_READY', flush=True)
