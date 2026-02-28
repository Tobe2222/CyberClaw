#!/usr/bin/env python3
"""
Generate a Pokémon-style companion creature in Blender via MCP API.
Usage: python3 generate_companion.py --name "Voltix" --element electric --output /tmp/voltix.png

Requires Blender MCP server running on localhost:8000.
"""

import argparse
import json
import requests
import sys
import math

SERVER = "http://localhost:8000"

PALETTES = {
    "cyber":    {"primary": [0, 0.83, 1, 1], "secondary": [0, 0.53, 0.67, 1], "accent": [1, 0.42, 0.21, 1], "glow": [0, 0.83, 1, 1]},
    "fire":     {"primary": [1, 0.42, 0.21, 1], "secondary": [0.8, 0.27, 0, 1], "accent": [1, 0.67, 0, 1], "glow": [1, 0.42, 0.21, 1]},
    "electric": {"primary": [1, 0.87, 0, 1], "secondary": [0.8, 0.67, 0, 1], "accent": [1, 0.42, 0.21, 1], "glow": [1, 0.87, 0, 1]},
    "nature":   {"primary": [0.29, 0.87, 0.5, 1], "secondary": [0.13, 0.67, 0.27, 1], "accent": [0.53, 1, 0.53, 1], "glow": [0.29, 0.87, 0.5, 1]},
    "shadow":   {"primary": [0.6, 0.4, 1, 1], "secondary": [0.4, 0.2, 0.8, 1], "accent": [1, 0.4, 1, 1], "glow": [0.6, 0.4, 1, 1]},
    "ice":      {"primary": [0.53, 0.87, 1, 1], "secondary": [0.27, 0.6, 0.8, 1], "accent": [1, 1, 1, 1], "glow": [0.53, 0.87, 1, 1]},
    "steel":    {"primary": [0.67, 0.73, 0.8, 1], "secondary": [0.47, 0.53, 0.6, 1], "accent": [1, 0.42, 0.21, 1], "glow": [0.67, 0.73, 0.8, 1]},
    "toxic":    {"primary": [0.4, 1, 0.4, 1], "secondary": [0.2, 0.8, 0.2, 1], "accent": [1, 1, 0, 1], "glow": [0.4, 1, 0.4, 1]},
}

BODY_TYPES = {
    "round":   {"body": "UV_SPHERE", "body_scale": [1.0, 1.0, 0.9], "body_size": 1.0},
    "angular": {"body": "CUBE",      "body_scale": [0.8, 0.8, 0.9], "body_size": 0.8},
    "slim":    {"body": "CYLINDER",   "body_scale": [0.6, 0.6, 1.2], "body_size": 0.7},
    "bulky":   {"body": "UV_SPHERE", "body_scale": [1.3, 1.1, 1.0], "body_size": 1.2},
}

def invoke(tool, params=None):
    """Call a Blender MCP tool."""
    try:
        resp = requests.post(f"{SERVER}/mcp/invoke/{tool}",
                           json=params or {},
                           timeout=30)
        return resp.json()
    except Exception as e:
        print(f"Error calling {tool}: {e}")
        return None

def generate(name, element="cyber", body_type="round", output="/tmp/companion.png", size=256):
    palette = PALETTES.get(element, PALETTES["cyber"])
    body_cfg = BODY_TYPES.get(body_type, BODY_TYPES["round"])

    print(f"Generating companion: {name} ({element}/{body_type})")

    # 1. Clear scene
    invoke("clear_scene")

    # 2. Create body
    invoke("create_object", {
        "type": body_cfg["body"],
        "name": "Body",
        "location": [0, 0, 0.5],
        "size": body_cfg["body_size"]
    })
    invoke("set_scale", {
        "object_name": "Body",
        "scale": body_cfg["body_scale"]
    })

    # 3. Add subdivision for smooth look
    invoke("add_modifier", {
        "object_name": "Body",
        "modifier_type": "SUBSURF",
        "settings": {"levels": 2, "render_levels": 2}
    })

    # 4. Create head
    invoke("create_object", {
        "type": "UV_SPHERE",
        "name": "Head",
        "location": [0, 0, 1.4],
        "size": 0.7
    })
    invoke("add_modifier", {
        "object_name": "Head",
        "modifier_type": "SUBSURF",
        "settings": {"levels": 2}
    })

    # 5. Eyes
    for i, x_off in enumerate([-0.25, 0.25]):
        invoke("create_object", {
            "type": "UV_SPHERE",
            "name": f"Eye_{i}",
            "location": [x_off, -0.55, 1.55],
            "size": 0.15
        })
        # Pupil
        invoke("create_object", {
            "type": "UV_SPHERE",
            "name": f"Pupil_{i}",
            "location": [x_off, -0.65, 1.55],
            "size": 0.08
        })

    # 6. Ears/horns based on element
    if element in ["electric", "fire", "toxic"]:
        # Pointy ears
        for i, x_off in enumerate([-0.4, 0.4]):
            invoke("create_object", {
                "type": "CONE",
                "name": f"Ear_{i}",
                "location": [x_off, 0, 2.0],
                "size": 0.25
            })
            invoke("set_rotation", {
                "object_name": f"Ear_{i}",
                "rotation": [0, 15 * (-1 if x_off < 0 else 1), 0]
            })
    elif element in ["shadow", "steel", "ice"]:
        # Horns
        for i, x_off in enumerate([-0.35, 0.35]):
            invoke("create_object", {
                "type": "CONE",
                "name": f"Horn_{i}",
                "location": [x_off, 0, 2.1],
                "size": 0.2
            })
            invoke("set_scale", {
                "object_name": f"Horn_{i}",
                "scale": [0.5, 0.5, 1.5]
            })
    else:
        # Round ears
        for i, x_off in enumerate([-0.45, 0.45]):
            invoke("create_object", {
                "type": "UV_SPHERE",
                "name": f"Ear_{i}",
                "location": [x_off, 0, 1.9],
                "size": 0.2
            })

    # 7. Tail
    invoke("create_object", {
        "type": "UV_SPHERE",
        "name": "Tail",
        "location": [0, 0.8, 0.5],
        "size": 0.25
    })
    invoke("set_scale", {
        "object_name": "Tail",
        "scale": [0.6, 1.2, 0.6]
    })

    # 8. Feet
    for i, (x, y) in enumerate([(-0.35, -0.2), (0.35, -0.2), (-0.35, 0.2), (0.35, 0.2)]):
        invoke("create_object", {
            "type": "UV_SPHERE",
            "name": f"Foot_{i}",
            "location": [x, y, -0.3],
            "size": 0.2
        })
        invoke("set_scale", {
            "object_name": f"Foot_{i}",
            "scale": [1, 1.2, 0.6]
        })

    # 9. Materials
    # Body material (primary color)
    invoke("create_material", {
        "name": "BodyMat",
        "color": palette["primary"],
        "metallic": 0.2,
        "roughness": 0.5
    })
    for obj in ["Body", "Head", "Tail", "Ear_0", "Ear_1"]:
        invoke("assign_material", {"object_name": obj, "material_name": "BodyMat"})
    if any(invoke("get_object_info", {"object_name": f"Horn_{i}"}) for i in range(2)):
        for i in range(2):
            invoke("assign_material", {"object_name": f"Horn_{i}", "material_name": "BodyMat"})

    # Secondary for feet
    invoke("create_material", {
        "name": "FeetMat",
        "color": palette["secondary"],
        "metallic": 0.1,
        "roughness": 0.6
    })
    for i in range(4):
        invoke("assign_material", {"object_name": f"Foot_{i}", "material_name": "FeetMat"})

    # Eye whites
    invoke("create_material", {
        "name": "EyeWhite",
        "color": [1, 1, 1, 1],
        "metallic": 0,
        "roughness": 0.3
    })
    for i in range(2):
        invoke("assign_material", {"object_name": f"Eye_{i}", "material_name": "EyeWhite"})

    # Pupil
    invoke("create_material", {
        "name": "PupilMat",
        "color": [0.05, 0.05, 0.05, 1],
        "metallic": 0,
        "roughness": 0.2
    })
    for i in range(2):
        invoke("assign_material", {"object_name": f"Pupil_{i}", "material_name": "PupilMat"})

    # 10. Camera
    invoke("create_camera", {
        "location": [2.5, -2.5, 1.8],
        "target": [0, 0, 0.8]
    })

    # 11. Lighting — 3-point setup
    invoke("create_light", {
        "type": "SUN",
        "name": "KeyLight",
        "location": [3, -2, 5],
        "energy": 3.0
    })
    invoke("create_light", {
        "type": "POINT",
        "name": "FillLight",
        "location": [-3, -1, 3],
        "energy": 100.0
    })
    # Rim light with element color
    invoke("create_light", {
        "type": "POINT",
        "name": "RimLight",
        "location": [0, 3, 2],
        "energy": 150.0,
        "color": palette["glow"][:3]
    })

    # 12. Render settings
    invoke("set_render_settings", {
        "resolution_x": size,
        "resolution_y": size,
        "engine": "EEVEE",
        "samples": 64,
        "film_transparent": True
    })

    # 13. Render
    result = invoke("render_image", {"filepath": output})
    print(f"✓ Companion '{name}' rendered to {output}")
    return output

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate a Pokémon-style companion")
    parser.add_argument("--name", default="Companion", help="Companion name")
    parser.add_argument("--element", default="cyber", choices=list(PALETTES.keys()))
    parser.add_argument("--body", default="round", choices=list(BODY_TYPES.keys()))
    parser.add_argument("--output", default="/tmp/companion.png")
    parser.add_argument("--size", type=int, default=256)
    args = parser.parse_args()

    generate(args.name, args.element, args.body, args.output, args.size)
