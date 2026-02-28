"""
Start the Blender MCP Server.
Run with: blender --background --python start_server.py
Or with GUI: blender --python start_server.py
"""
import bpy
import sys
import os

# Add the skill directory to path so we can find the addon
skill_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
addon_path = os.path.join(skill_dir, 'blender_mcp.py')

# Install addon if not already installed
addon_dir = os.path.join(bpy.utils.user_resource('SCRIPTS'), 'addons')
os.makedirs(addon_dir, exist_ok=True)
dest = os.path.join(addon_dir, 'blender_mcp.py')

# Copy if newer or missing
import shutil
if not os.path.exists(dest) or os.path.getmtime(addon_path) > os.path.getmtime(dest):
    shutil.copy2(addon_path, dest)
    print(f"[Blender MCP] Addon installed to {dest}")

# Enable the addon
bpy.ops.preferences.addon_enable(module='blender_mcp')
print("[Blender MCP] Addon enabled")

# The addon auto-starts the server when enabled via the panel
# But in headless mode, we need to trigger it manually
# Import the module and start
import importlib
mod = importlib.import_module('blender_mcp')
if hasattr(mod, 'MCP_OT_start_server'):
    bpy.ops.mcp.start_server()
    print("[Blender MCP] Server started on http://localhost:8000")
else:
    print("[Blender MCP] Looking for server start operator...")
    # Try alternative approaches
    for attr in dir(mod):
        if 'start' in attr.lower() and 'server' in attr.lower():
            print(f"  Found: {attr}")

# Keep Blender alive in background mode
if bpy.app.background:
    print("[Blender MCP] Running in background mode. Press Ctrl+C to stop.")
    import time
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[Blender MCP] Shutting down...")
