# Blender MCP Skill

Control Blender 3D via the Blender MCP Server addon. This skill lets you create, modify, and render 3D objects, materials, animations, and scenes programmatically through HTTP API calls.

## Prerequisites

1. **Blender** installed (`snap install blender --classic` or download from blender.org)
2. **Blender MCP addon** installed (included in this skill as `blender_mcp.py`)

## Setup (First Time)

### Install the addon in Blender:

```bash
# Option A: Copy addon to Blender's addon directory
cp blender_mcp.py ~/.config/blender/*/scripts/addons/

# Option B: Install via Blender CLI
blender --background --python-expr "
import bpy, shutil, os
addon_dir = os.path.join(bpy.utils.user_resource('SCRIPTS'), 'addons')
os.makedirs(addon_dir, exist_ok=True)
shutil.copy('$(pwd)/blender_mcp.py', addon_dir)
print('Addon installed to', addon_dir)
"
```

### Start Blender with MCP server:

```bash
# Headless mode (no GUI) — best for agent use
blender --background --python scripts/start_server.py

# With GUI (for visual feedback)
blender --python scripts/start_server.py
```

The MCP server runs on `http://localhost:8000`.

## API Usage

### List available tools
```bash
curl http://localhost:8000/mcp/list_tools
```

### Invoke a tool
```bash
curl -X POST http://localhost:8000/mcp/invoke/create_object \
  -H "Content-Type: application/json" \
  -d '{"type": "CUBE", "name": "MyCube", "location": [0, 0, 0], "size": 2.0}'
```

## Tool Categories

### Object Operations
- `create_object` — Create primitives (CUBE, SPHERE, CYLINDER, CONE, TORUS, MONKEY, PLANE)
- `delete_object` — Delete by name
- `duplicate_object` — Clone objects
- `select_object` — Select by name
- `get_object_info` — Get transform, dimensions, type
- `list_objects` — List all scene objects

### Transformations
- `set_location` — Move object (x, y, z)
- `set_rotation` — Rotate object (x, y, z in degrees)
- `set_scale` — Scale object (x, y, z)
- `apply_transforms` — Apply location/rotation/scale

### Materials & Shading
- `create_material` — Create material with color + metallic + roughness
- `assign_material` — Assign material to object
- `set_material_color` — Change material base color (RGBA)
- `create_emission_material` — Glowing materials

### Modifiers
- `add_modifier` — Add modifier (SUBSURF, MIRROR, ARRAY, SOLIDIFY, BEVEL, etc.)
- `apply_modifier` — Apply modifier
- `boolean_operation` — UNION, DIFFERENCE, INTERSECT

### Animation
- `insert_keyframe` — Keyframe location/rotation/scale
- `set_frame_range` — Set start/end frames
- `set_current_frame` — Jump to frame

### Camera & Lighting
- `create_camera` — Create camera at position looking at target
- `create_light` — Create light (POINT, SUN, SPOT, AREA)
- `set_camera_active` — Set render camera

### Rendering
- `render_image` — Render to file
- `set_render_settings` — Resolution, engine (EEVEE/CYCLES), samples
- `set_output_path` — Set render output

### Scene Management
- `get_scene_info` — Scene statistics
- `clear_scene` — Delete all objects
- `save_file` — Save .blend file
- `export_file` — Export as FBX, OBJ, GLB, USD

### Batch Operations
- `batch_create` — Create multiple objects at once
- `batch_transform` — Transform multiple objects

### Physics
- `add_rigid_body` — Rigid body physics
- `add_cloth_sim` — Cloth simulation
- `add_fluid` — Fluid simulation

## Workflow: Creating a Companion Sprite

```bash
# 1. Clear scene
curl -X POST http://localhost:8000/mcp/invoke/clear_scene

# 2. Create body (sphere)
curl -X POST http://localhost:8000/mcp/invoke/create_object \
  -d '{"type": "UV_SPHERE", "name": "Body", "location": [0, 0, 0], "size": 1.0}'

# 3. Add material
curl -X POST http://localhost:8000/mcp/invoke/create_material \
  -d '{"name": "CyberBlue", "color": [0, 0.83, 1, 1], "metallic": 0.3, "roughness": 0.4}'

# 4. Assign material
curl -X POST http://localhost:8000/mcp/invoke/assign_material \
  -d '{"object_name": "Body", "material_name": "CyberBlue"}'

# 5. Set up camera
curl -X POST http://localhost:8000/mcp/invoke/create_camera \
  -d '{"location": [3, -3, 2], "target": [0, 0, 0]}'

# 6. Add light
curl -X POST http://localhost:8000/mcp/invoke/create_light \
  -d '{"type": "SUN", "location": [5, 5, 5], "energy": 3.0}'

# 7. Render
curl -X POST http://localhost:8000/mcp/invoke/set_render_settings \
  -d '{"resolution_x": 256, "resolution_y": 256, "engine": "EEVEE", "samples": 64}'
curl -X POST http://localhost:8000/mcp/invoke/render_image \
  -d '{"filepath": "/tmp/companion.png"}'
```

## Helper Script

Use `scripts/blender-cli.sh` for quick commands:
```bash
./scripts/blender-cli.sh create cube MyCube 0 0 0 2
./scripts/blender-cli.sh material CyberOrange 1.0 0.42 0.21 1.0
./scripts/blender-cli.sh render /tmp/output.png 512 512
```

## Notes

- The MCP server runs inside Blender's Python environment
- All operations are thread-safe (queued execution)
- Blender must be running for the API to work
- Use `--background` for headless operation (no GPU rendering unless configured)
- EEVEE is faster for previews, CYCLES for quality renders
- Transparent backgrounds: set `film_transparent = true` in render settings
