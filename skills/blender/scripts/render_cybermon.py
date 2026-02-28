#!/usr/bin/env python3
"""
Cybermon Generator v2 — Pokémon-style 3D creatures with toon shading.
Run: blender --background --python render_cybermon.py -- --animal fox --elements fire shadow --mood cute --output /tmp/cybermon.png

Key improvements over v1:
- Toon/cel shading with hard shadow edges
- Big expressive eyes (sclera + iris + pupil + highlight)
- Visible chunky arms and legs
- Prominent ears and tails
- Black outline edges (Freestyle)
- Better camera framing and composition
"""
import bpy
import sys
import math
import os
import random
from mathutils import Vector

# Parse args after --
argv = sys.argv
if "--" in argv:
    argv = argv[argv.index("--") + 1:]
else:
    argv = []

import argparse
parser = argparse.ArgumentParser()
parser.add_argument("--animal", default="fox")
parser.add_argument("--elements", nargs="+", default=["fire"])
parser.add_argument("--mood", default="cute", choices=["cute", "fierce", "chill", "angry", "playful"])
parser.add_argument("--size", default="medium", choices=["small", "medium", "large"])
parser.add_argument("--output", default="/tmp/cybermon.png")
parser.add_argument("--res", type=int, default=512)
parser.add_argument("--seed", type=int, default=None)
args = parser.parse_args(argv)

if args.seed is not None:
    random.seed(args.seed)
else:
    random.seed(hash(args.animal + "".join(args.elements) + args.mood))

# =========================================
# ELEMENT PALETTES
# =========================================
ELEMENT_COLORS = {
    "fire":     {"primary": (0.95, 0.30, 0.05), "secondary": (1.0, 0.65, 0.1), "accent": (1.0, 0.85, 0.2), "belly": (1.0, 0.8, 0.5), "iris": (1.0, 0.5, 0.0)},
    "water":    {"primary": (0.2, 0.45, 0.9),   "secondary": (0.4, 0.7, 1.0),  "accent": (0.6, 0.9, 1.0),  "belly": (0.7, 0.85, 1.0), "iris": (0.2, 0.4, 0.9)},
    "electric": {"primary": (1.0, 0.85, 0.0),   "secondary": (1.0, 0.7, 0.0),  "accent": (1.0, 1.0, 0.6),  "belly": (1.0, 1.0, 0.7),  "iris": (1.0, 0.8, 0.0)},
    "nature":   {"primary": (0.25, 0.72, 0.25), "secondary": (0.5, 0.85, 0.3), "accent": (0.7, 1.0, 0.5),  "belly": (0.8, 1.0, 0.7),  "iris": (0.2, 0.7, 0.2)},
    "shadow":   {"primary": (0.25, 0.1, 0.35),  "secondary": (0.45, 0.2, 0.6), "accent": (0.7, 0.3, 1.0),  "belly": (0.5, 0.35, 0.6), "iris": (0.6, 0.2, 0.9)},
    "ice":      {"primary": (0.6, 0.85, 1.0),   "secondary": (0.8, 0.93, 1.0), "accent": (0.9, 0.97, 1.0), "belly": (0.92, 0.96, 1.0),"iris": (0.4, 0.7, 1.0)},
    "steel":    {"primary": (0.55, 0.58, 0.65),  "secondary": (0.72, 0.75, 0.8),"accent": (0.85, 0.88, 0.92),"belly": (0.8, 0.82, 0.85),"iris": (0.5, 0.55, 0.65)},
    "toxic":    {"primary": (0.45, 0.15, 0.6),  "secondary": (0.6, 0.9, 0.15), "accent": (0.8, 1.0, 0.3),  "belly": (0.7, 0.5, 0.8),  "iris": (0.5, 1.0, 0.3)},
    "cyber":    {"primary": (0.0, 0.65, 0.85),  "secondary": (0.0, 0.9, 1.0),  "accent": (0.3, 1.0, 1.0),  "belly": (0.5, 0.9, 1.0),  "iris": (0.0, 0.8, 1.0)},
}

def mix_palette(elements):
    palettes = [ELEMENT_COLORS.get(e, ELEMENT_COLORS["cyber"]) for e in elements]
    if len(palettes) == 1:
        return palettes[0]
    p1, p2 = palettes[0], palettes[1]
    return {
        "primary": tuple((a * 0.6 + b * 0.4) for a, b in zip(p1["primary"], p2["primary"])),
        "secondary": p2["secondary"],
        "accent": p2["accent"],
        "belly": tuple((a * 0.5 + b * 0.5) for a, b in zip(p1["belly"], p2["belly"])),
        "iris": p1["iris"],
    }

palette = mix_palette(args.elements)

# =========================================
# MOOD MODIFIERS
# =========================================
MOOD = {
    "cute":     {"head_s": 1.35, "eye_s": 1.5, "body_round": 1.2, "limb_thick": 1.15, "mouth": "smile", "brow": "none"},
    "fierce":   {"head_s": 1.0,  "eye_s": 0.9, "body_round": 0.95,"limb_thick": 1.1,  "mouth": "grin",  "brow": "angry"},
    "chill":    {"head_s": 1.15, "eye_s": 1.2, "body_round": 1.15,"limb_thick": 1.1,  "mouth": "neutral","brow": "none"},
    "angry":    {"head_s": 0.95, "eye_s": 0.85,"body_round": 0.9, "limb_thick": 1.15, "mouth": "frown",  "brow": "angry"},
    "playful":  {"head_s": 1.25, "eye_s": 1.35,"body_round": 1.1, "limb_thick": 1.1,  "mouth": "open",   "brow": "none"},
}
mood = MOOD[args.mood]

SIZE_SCALE = {"small": 0.7, "medium": 1.0, "large": 1.4}
S = SIZE_SCALE[args.size]

# =========================================
# BLENDER UTILS
# =========================================
def clear_all():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete()
    for col in [bpy.data.materials, bpy.data.meshes, bpy.data.curves, bpy.data.lights, bpy.data.cameras]:
        for item in col:
            col.remove(item)

def make_toon_mat(name, color, shadow_color=None, specular=0.3):
    """Create a toon/cel-shaded material using Shader to RGB."""
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()

    # Nodes
    output = nodes.new('ShaderNodeOutputMaterial')
    output.location = (600, 0)

    diffuse = nodes.new('ShaderNodeBsdfDiffuse')
    diffuse.inputs['Color'].default_value = (*color, 1)
    diffuse.location = (-200, 100)

    shader_to_rgb = nodes.new('ShaderNodeShaderToRGB')
    shader_to_rgb.location = (0, 100)

    color_ramp = nodes.new('ShaderNodeValToRGB')
    color_ramp.location = (200, 100)
    # Two-step toon ramp: shadow and lit
    cr = color_ramp.color_ramp
    cr.interpolation = 'CONSTANT'
    cr.elements[0].position = 0.0
    if shadow_color:
        cr.elements[0].color = (*shadow_color, 1)
    else:
        cr.elements[0].color = (*(c * 0.5 for c in color), 1)
    cr.elements[1].position = 0.35
    cr.elements[1].color = (*color, 1)
    # Add a highlight step
    highlight = cr.elements.new(0.85)
    highlight.color = (*(min(c * 1.2, 1.0) for c in color), 1)

    # Final mix output (use emission to avoid further shading)
    emission = nodes.new('ShaderNodeEmission')
    emission.location = (400, 100)

    links.new(diffuse.outputs['BSDF'], shader_to_rgb.inputs['Shader'])
    links.new(shader_to_rgb.outputs['Color'], color_ramp.inputs['Fac'])
    links.new(color_ramp.outputs['Color'], emission.inputs['Color'])
    emission.inputs['Strength'].default_value = 1.0
    links.new(emission.outputs['Emission'], output.inputs['Surface'])

    return mat

def make_flat_mat(name, color):
    """Simple flat emission material (for eyes, highlights etc)."""
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()
    output = nodes.new('ShaderNodeOutputMaterial')
    output.location = (200, 0)
    emission = nodes.new('ShaderNodeEmission')
    emission.inputs['Color'].default_value = (*color, 1)
    emission.inputs['Strength'].default_value = 1.0
    emission.location = (0, 0)
    links.new(emission.outputs['Emission'], output.inputs['Surface'])
    return mat

def make_glossy_mat(name, color, roughness=0.15):
    """Glossy material for eyes."""
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = 0.0
    # Add some specular
    bsdf.inputs[12].default_value = 1.0  # Specular IOR Level
    return mat

def obj_add(primitive_fn, name, loc, mat=None, **kwargs):
    """Add a primitive, name it, smooth it, optionally assign material."""
    primitive_fn(location=loc, **kwargs)
    o = bpy.context.active_object
    o.name = name
    bpy.ops.object.shade_smooth()
    if mat:
        o.data.materials.append(mat)
    return o

def add_subsurf(obj, levels=2):
    mod = obj.modifiers.new("Sub", 'SUBSURF')
    mod.levels = levels
    mod.render_levels = levels
    return mod

def parent_to(child, parent):
    child.parent = parent
    child.matrix_parent_inverse = parent.matrix_world.inverted()

# Shorthand primitives
def sphere(name, loc, r, mat=None):
    o = obj_add(bpy.ops.mesh.primitive_uv_sphere_add, name, loc, mat, radius=r, segments=24, ring_count=16)
    add_subsurf(o, 1)
    return o

def cube(name, loc, size, mat=None):
    o = obj_add(bpy.ops.mesh.primitive_cube_add, name, loc, mat, size=size)
    add_subsurf(o, 2)
    return o

def cone(name, loc, r, depth, mat=None, verts=16):
    o = obj_add(bpy.ops.mesh.primitive_cone_add, name, loc, mat, radius1=r, depth=depth, vertices=verts)
    return o

def cylinder(name, loc, r, depth, mat=None):
    o = obj_add(bpy.ops.mesh.primitive_cylinder_add, name, loc, mat, radius=r, depth=depth, vertices=16)
    return o

# =========================================
# BUILD CYBERMON
# =========================================
print(f"=== Cybermon v2: {args.animal} + {'+'.join(args.elements)} ({args.mood}/{args.size}) ===")
clear_all()

# ----- MATERIALS -----
mat_body = make_toon_mat("Body", palette["primary"])
mat_secondary = make_toon_mat("Secondary", palette["secondary"])
mat_accent = make_toon_mat("Accent", palette["accent"])
mat_belly = make_toon_mat("Belly", palette["belly"])
mat_dark = make_toon_mat("Dark", (0.12, 0.1, 0.1))

# Eye materials
mat_eye_white = make_flat_mat("EyeWhite", (1, 1, 1))
mat_iris = make_flat_mat("Iris", palette["iris"])
mat_pupil = make_flat_mat("Pupil", (0.02, 0.02, 0.02))
mat_highlight = make_flat_mat("Highlight", (1, 1, 1))
mat_mouth = make_flat_mat("Mouth", (0.15, 0.05, 0.05))

# =========================================
# ANIMAL BODY PLANS
# =========================================
# All measurements in "units" at scale=1, multiplied by S

# Common function to make an expressive eye
def make_eye(name_prefix, center, size, direction=(0, -1, 0)):
    """Create a full Pokémon-style eye: sclera + iris + pupil + highlight.
    Eyes are placed ON the surface, protruding outward so they're clearly visible."""
    ex, ey, ez = center
    r = size
    # Push entire eye assembly further forward (out of the head)
    forward_y = -r * 0.75

    # White sclera — big, protruding, oval
    sclera = sphere(f"{name_prefix}_Sclera", (ex, ey + forward_y, ez), r, mat_eye_white)
    sclera.scale = (1.0, 0.65, 1.15)

    # Colored iris — large, sits on front face of sclera
    iris_r = r * 0.72
    iris = sphere(f"{name_prefix}_Iris", (ex, ey + forward_y - r * 0.3, ez - r * 0.06), iris_r, mat_iris)
    iris.scale = (1.0, 0.55, 1.05)

    # Black pupil — clearly visible
    pupil_r = iris_r * 0.55
    pupil = sphere(f"{name_prefix}_Pupil", (ex, ey + forward_y - r * 0.45, ez - r * 0.04), pupil_r, mat_pupil)
    pupil.scale = (1.0, 0.45, 1.1)

    # White highlight — big shiny dot, upper-right of eye
    hl_r = r * 0.3
    hl = sphere(f"{name_prefix}_Highlight", (ex + r * 0.22, ey + forward_y - r * 0.4, ez + r * 0.25), hl_r, mat_highlight)

    # Second smaller highlight — lower-left
    hl2 = sphere(f"{name_prefix}_Highlight2", (ex - r * 0.18, ey + forward_y - r * 0.35, ez - r * 0.2), hl_r * 0.45, mat_highlight)

    return sclera

# Mouth
def make_mouth(center, width, mouth_type="smile"):
    mx, my, mz = center
    if mouth_type == "smile":
        mouth = sphere("Mouth", (mx, my, mz), width * 0.5, mat_mouth)
        mouth.scale = (1.5, 0.5, 0.4)
    elif mouth_type == "grin":
        mouth = sphere("Mouth", (mx, my, mz), width * 0.6, mat_mouth)
        mouth.scale = (2.0, 0.5, 0.5)
    elif mouth_type == "frown":
        mouth = sphere("Mouth", (mx, my, mz), width * 0.4, mat_mouth)
        mouth.scale = (1.2, 0.4, 0.3)
    elif mouth_type == "open":
        mouth = sphere("Mouth", (mx, my, mz), width * 0.35, mat_mouth)
        mouth.scale = (1.0, 0.6, 0.8)
    else:  # neutral
        mouth = sphere("Mouth", (mx, my, mz), width * 0.3, mat_mouth)
        mouth.scale = (1.5, 0.3, 0.2)

# Angry eyebrows
def make_brows(eye_positions, brow_r, brow_type="angry"):
    if brow_type == "none":
        return
    for i, (ex, ey, ez, er) in enumerate(eye_positions):
        brow = cube(f"Brow_{i}", (ex, ey - er * 0.3, ez + er * 1.0), er * 0.6, mat_dark)
        brow.scale = (2.0, 0.5, 0.3)
        brow.rotation_euler = (0, 0, math.radians(15 * (1 if i == 0 else -1)))

# =========================================
# ANIMAL-SPECIFIC BUILDS
# =========================================
# Each animal function returns key positions for camera framing

def build_quadruped(animal_type):
    """Build fox, cat, dog, wolf, bear, dragon, turtle."""
    configs = {
        "fox":    {"bw": 0.55, "bd": 0.4, "bh": 0.42, "hr": 0.38, "neck_len": 0.15, "snout_l": 0.22, "snout_w": 0.12, "ear_h": 0.32, "ear_w": 0.14, "ear_type": "pointed", "tail_type": "fluffy", "leg_r": 0.07, "leg_h": 0.28, "arm_r": 0.0, "has_arms": False},
        "cat":    {"bw": 0.45, "bd": 0.35, "bh": 0.38, "hr": 0.36, "neck_len": 0.1,  "snout_l": 0.1,  "snout_w": 0.1,  "ear_h": 0.25, "ear_w": 0.15, "ear_type": "pointed", "tail_type": "long_curvy", "leg_r": 0.06, "leg_h": 0.26, "arm_r": 0.0, "has_arms": False},
        "dog":    {"bw": 0.55, "bd": 0.42, "bh": 0.4,  "hr": 0.38, "neck_len": 0.12, "snout_l": 0.25, "snout_w": 0.12, "ear_h": 0.22, "ear_w": 0.16, "ear_type": "floppy",  "tail_type": "wagging", "leg_r": 0.08, "leg_h": 0.3,  "arm_r": 0.0, "has_arms": False},
        "wolf":   {"bw": 0.6,  "bd": 0.42, "bh": 0.45, "hr": 0.38, "neck_len": 0.15, "snout_l": 0.28, "snout_w": 0.12, "ear_h": 0.24, "ear_w": 0.13, "ear_type": "pointed", "tail_type": "bushy_down", "leg_r": 0.07, "leg_h": 0.32, "arm_r": 0.0, "has_arms": False},
        "bear":   {"bw": 0.7,  "bd": 0.55, "bh": 0.6,  "hr": 0.42, "neck_len": 0.08, "snout_l": 0.18, "snout_w": 0.15, "ear_h": 0.15, "ear_w": 0.15, "ear_type": "round",   "tail_type": "puff", "leg_r": 0.12, "leg_h": 0.28, "arm_r": 0.12, "has_arms": True},
        "dragon": {"bw": 0.6,  "bd": 0.45, "bh": 0.5,  "hr": 0.4,  "neck_len": 0.2,  "snout_l": 0.25, "snout_w": 0.13, "ear_h": 0.28, "ear_w": 0.1,  "ear_type": "horns",   "tail_type": "long_spike", "leg_r": 0.09, "leg_h": 0.3,  "arm_r": 0.08, "has_arms": True, "wings": True},
        "turtle": {"bw": 0.6,  "bd": 0.5,  "bh": 0.35, "hr": 0.3,  "neck_len": 0.12, "snout_l": 0.08, "snout_w": 0.08, "ear_h": 0.0,  "ear_w": 0.0,  "ear_type": "none",    "tail_type": "stubby", "leg_r": 0.1,  "leg_h": 0.18, "arm_r": 0.0, "has_arms": False, "shell": True},
    }
    c = configs[animal_type]

    # Scale everything
    bw, bd, bh = c["bw"] * S, c["bd"] * S, c["bh"] * S
    hr = c["hr"] * S * mood["head_s"]
    snout_l, snout_w = c["snout_l"] * S, c["snout_w"] * S
    ear_h, ear_w = c["ear_h"] * S, c["ear_w"] * S
    leg_r, leg_h = c["leg_r"] * S * mood["limb_thick"], c["leg_h"] * S
    arm_r = c["arm_r"] * S * mood["limb_thick"]
    neck_len = c["neck_len"] * S
    body_round = mood["body_round"]

    bw *= body_round
    bd *= body_round

    ground = 0
    leg_bottom = ground
    body_z = leg_bottom + leg_h + bh * 0.4
    head_z = body_z + bh * 0.4 + neck_len + hr * 0.6

    # BODY
    body = sphere("Body", (0, 0, body_z), max(bw, bh) * 0.5, mat_body)
    body.scale = (bw / max(bw, bh), bd / max(bw, bh), bh / max(bw, bh))

    # BELLY (lighter underside)
    belly = sphere("Belly", (0, -bd * 0.15, body_z - bh * 0.1), max(bw, bh) * 0.42, mat_belly)
    belly.scale = (0.8, 0.65, 0.7)

    # SHELL (turtle)
    if c.get("shell"):
        shell = sphere("Shell", (0, bd * 0.05, body_z + bh * 0.15), max(bw, bd) * 0.58, mat_accent)
        shell.scale = (1.1, 0.9, 0.65)

    # HEAD
    head = sphere("Head", (0, -bd * 0.2 - neck_len * 0.3, head_z), hr, mat_body)

    # SNOUT / NOSE
    if snout_l > 0:
        snout_z = head_z - hr * 0.2
        snout_y = -bd * 0.2 - neck_len * 0.3 - hr * 0.75
        snout = sphere("Snout", (0, snout_y, snout_z), max(snout_l, snout_w), mat_belly)
        snout.scale = (snout_w / max(snout_l, snout_w), snout_l / max(snout_l, snout_w), snout_w * 0.7 / max(snout_l, snout_w))
        # Nose tip
        nose = sphere("Nose", (0, snout_y - snout_l * 0.5, snout_z + snout_w * 0.2), snout_w * 0.35, mat_dark)

    # EYES
    eye_size = hr * 0.32 * mood["eye_s"]
    eye_z = head_z + hr * 0.08
    eye_y_base = -bd * 0.2 - neck_len * 0.3 - hr * 0.6
    eye_x_spread = hr * 0.42

    make_eye("LEye", (-eye_x_spread, eye_y_base, eye_z), eye_size)
    make_eye("REye", (eye_x_spread, eye_y_base, eye_z), eye_size)

    # EYEBROWS
    eye_positions = [
        (-eye_x_spread, eye_y_base, eye_z, eye_size),
        (eye_x_spread, eye_y_base, eye_z, eye_size),
    ]
    make_brows(eye_positions, eye_size * 0.4, mood["brow"])

    # MOUTH
    mouth_z = head_z - hr * 0.35
    mouth_y = -bd * 0.2 - neck_len * 0.3 - hr * 0.55
    if snout_l > 0.15 * S:
        mouth_y -= snout_l * 0.3
        mouth_z -= snout_w * 0.2
    make_mouth((0, mouth_y, mouth_z), hr * 0.3, mood["mouth"])

    # EARS
    head_top_z = head_z + hr * 0.75
    head_y = -bd * 0.2 - neck_len * 0.3

    if c["ear_type"] == "pointed":
        for i, side in enumerate([-1, 1]):
            ex = side * hr * 0.5
            # Ears sit well above head, angled outward
            ear = cone(f"Ear_{i}", (ex, head_y, head_top_z + ear_h * 0.55), ear_w * 1.2, ear_h * 1.3, mat_body)
            ear.rotation_euler = (0, math.radians(12 * side), 0)
            # Inner ear (contrasting color)
            inner = cone(f"EarInner_{i}", (ex, head_y - ear_w * 0.25, head_top_z + ear_h * 0.55),
                        ear_w * 0.75, ear_h * 1.0, mat_secondary)
            inner.rotation_euler = (0, math.radians(12 * side), 0)

    elif c["ear_type"] == "floppy":
        for i, side in enumerate([-1, 1]):
            ex = side * hr * 0.7
            ear = sphere(f"Ear_{i}", (ex, head_y, head_z + hr * 0.25), ear_h * 0.55, mat_body)
            ear.scale = (0.5, 0.3, 1.5)
            ear.rotation_euler = (0, 0, math.radians(25 * side))
            inner = sphere(f"EarInner_{i}", (ex, head_y - 0.02, head_z + hr * 0.25), ear_h * 0.4, mat_secondary)
            inner.scale = (0.4, 0.25, 1.3)
            inner.rotation_euler = (0, 0, math.radians(25 * side))

    elif c["ear_type"] == "round":
        for i, side in enumerate([-1, 1]):
            ex = side * hr * 0.6
            ear = sphere(f"Ear_{i}", (ex, head_y, head_top_z + ear_h * 0.25), ear_h * 0.55, mat_body)
            inner = sphere(f"EarInner_{i}", (ex, head_y - ear_w * 0.2, head_top_z + ear_h * 0.25), ear_h * 0.4, mat_secondary)

    elif c["ear_type"] == "horns":
        for i, side in enumerate([-1, 1]):
            ex = side * hr * 0.45
            horn = cone(f"Horn_{i}", (ex, head_y, head_top_z + ear_h * 0.7),
                       ear_w * 0.5, ear_h * 1.5, mat_accent)
            horn.rotation_euler = (math.radians(-10), math.radians(18 * side), 0)

    # LEGS (4 legs, visible and chunky)
    leg_positions = [
        (-bw * 0.35, -bd * 0.2, "FL"), (bw * 0.35, -bd * 0.2, "FR"),
        (-bw * 0.35, bd * 0.2, "BL"),  (bw * 0.35, bd * 0.2, "BR"),
    ]
    for lx, ly, label in leg_positions:
        leg_center_z = leg_bottom + leg_h * 0.5
        leg = cylinder(f"Leg_{label}", (lx, ly, leg_center_z), leg_r, leg_h, mat_body)
        add_subsurf(leg, 1)
        # Foot (wider, flat bottom)
        foot = sphere(f"Foot_{label}", (lx, ly - leg_r * 0.3, leg_bottom), leg_r * 1.4, mat_secondary)
        foot.scale = (1.2, 1.4, 0.5)
        # Toes (3 small bumps)
        for t, tx_off in enumerate([-leg_r * 0.6, 0, leg_r * 0.6]):
            toe = sphere(f"Toe_{label}_{t}", (lx + tx_off, ly - leg_r * 0.8, leg_bottom), leg_r * 0.35, mat_secondary)

    # ARMS (if present — bear, dragon)
    if c.get("has_arms") and arm_r > 0:
        for i, side in enumerate([-1, 1]):
            ax = side * (bw * 0.55)
            az = body_z + bh * 0.15
            arm = cylinder(f"Arm_{i}", (ax, -bd * 0.1, az), arm_r, leg_h * 0.7, mat_body)
            arm.rotation_euler = (0, math.radians(30 * side), 0)
            add_subsurf(arm, 1)
            # Hand/paw
            hand = sphere(f"Hand_{i}", (ax + side * leg_h * 0.25, -bd * 0.15, az - leg_h * 0.25),
                         arm_r * 1.3, mat_secondary)
            hand.scale = (1.1, 1.2, 0.8)

    # WINGS (dragon)
    if c.get("wings"):
        for i, side in enumerate([-1, 1]):
            wx = side * bw * 0.6
            wz = body_z + bh * 0.35
            # Wing bone
            wing_bone = cylinder(f"WingBone_{i}", (wx, bd * 0.1, wz), 0.03 * S, 0.5 * S, mat_dark)
            wing_bone.rotation_euler = (math.radians(20), 0, math.radians(55 * side))
            # Wing membrane
            wing_mem = cone(f"WingMem_{i}", (wx + side * 0.3 * S, bd * 0.05, wz + 0.1 * S),
                           0.3 * S, 0.05 * S, mat_secondary)
            wing_mem.rotation_euler = (0, math.radians(90), math.radians(30 * side))
            wing_mem.scale = (1.5, 0.4, 1)

    # TAIL
    tail_base_y = bd * 0.45
    tail_base_z = body_z

    if c["tail_type"] == "fluffy":
        for j in range(5):
            t = j / 4.0
            ty = tail_base_y + t * 0.5 * S
            tz = tail_base_z + math.sin(t * math.pi * 0.5) * 0.15 * S
            r = (0.12 + math.sin(t * math.pi) * 0.08) * S
            seg = sphere(f"Tail_{j}", (0, ty, tz), r, mat_secondary if j < 3 else mat_accent)
        # Fluffy tip
        tip = sphere("TailTip", (0, tail_base_y + 0.55 * S, tail_base_z + 0.12 * S), 0.15 * S, mat_accent)

    elif c["tail_type"] == "long_curvy":
        for j in range(6):
            t = j / 5.0
            ty = tail_base_y + t * 0.45 * S
            tz = tail_base_z + math.sin(t * math.pi) * 0.2 * S
            tx = math.sin(t * math.pi * 1.5) * 0.08 * S
            r = (0.06 - t * 0.008) * S
            seg = sphere(f"Tail_{j}", (tx, ty, tz), r, mat_body)
        tip = sphere("TailTip", (0.05 * S, tail_base_y + 0.48 * S, tail_base_z + 0.1 * S), 0.07 * S, mat_accent)

    elif c["tail_type"] == "wagging":
        for j in range(4):
            t = j / 3.0
            ty = tail_base_y + t * 0.3 * S
            tz = tail_base_z + t * 0.18 * S
            r = (0.08 - t * 0.015) * S
            seg = sphere(f"Tail_{j}", (0, ty, tz), r, mat_body)
        tip = sphere("TailTip", (0, tail_base_y + 0.32 * S, tail_base_z + 0.22 * S), 0.06 * S, mat_accent)

    elif c["tail_type"] == "bushy_down":
        for j in range(5):
            t = j / 4.0
            ty = tail_base_y + t * 0.4 * S
            tz = tail_base_z - t * 0.12 * S
            r = (0.1 + math.sin(t * math.pi) * 0.06) * S
            seg = sphere(f"Tail_{j}", (0, ty, tz), r, mat_secondary)

    elif c["tail_type"] == "long_spike":
        for j in range(6):
            t = j / 5.0
            ty = tail_base_y + t * 0.55 * S
            tz = tail_base_z - t * 0.15 * S
            r = (0.1 - t * 0.012) * S
            seg = sphere(f"Tail_{j}", (0, ty, tz), r, mat_body if j < 4 else mat_accent)
        spike = cone("TailSpike", (0, tail_base_y + 0.6 * S, tail_base_z - 0.2 * S),
                     0.06 * S, 0.15 * S, mat_accent)
        spike.rotation_euler = (math.radians(70), 0, 0)

    elif c["tail_type"] == "puff":
        tail = sphere("Tail", (0, tail_base_y, tail_base_z - bh * 0.1), 0.1 * S, mat_secondary)

    elif c["tail_type"] == "stubby":
        tail = sphere("Tail", (0, tail_base_y, tail_base_z - bh * 0.05), 0.07 * S, mat_secondary)

    return head_z, body_z

def build_biped(animal_type):
    """Build bird, owl, bat, rabbit, frog."""
    configs = {
        "bird":   {"bw": 0.35, "bh": 0.42, "hr": 0.28, "beak_l": 0.18, "ear_type": "crest", "ear_h": 0.2, "tail": "fan", "leg_type": "bird", "wing": "feathered"},
        "owl":    {"bw": 0.38, "bh": 0.45, "hr": 0.38, "beak_l": 0.1,  "ear_type": "tufts", "ear_h": 0.2, "tail": "fan_small", "leg_type": "bird", "wing": "feathered"},
        "bat":    {"bw": 0.28, "bh": 0.32, "hr": 0.28, "beak_l": 0.0,  "ear_type": "bat",   "ear_h": 0.32,"tail": "none", "leg_type": "tiny", "wing": "bat"},
        "rabbit": {"bw": 0.4,  "bh": 0.42, "hr": 0.36, "beak_l": 0.0,  "ear_type": "long",  "ear_h": 0.42,"tail": "puff", "leg_type": "strong", "wing": "none"},
        "frog":   {"bw": 0.45, "bh": 0.35, "hr": 0.38, "beak_l": 0.0,  "ear_type": "none",  "ear_h": 0.0, "tail": "none", "leg_type": "strong", "wing": "none"},
    }
    c = configs[animal_type]

    bw, bh = c["bw"] * S * mood["body_round"], c["bh"] * S * mood["body_round"]
    hr = c["hr"] * S * mood["head_s"]
    bd = bw * 0.85

    ground = 0
    leg_h = 0.25 * S
    body_z = ground + leg_h + bh * 0.5
    head_z = body_z + bh * 0.4 + hr * 0.65

    # BODY
    body = sphere("Body", (0, 0, body_z), max(bw, bh) * 0.5, mat_body)
    body.scale = (bw / max(bw, bh), bd / max(bw, bh), bh / max(bw, bh))

    # BELLY
    belly = sphere("Belly", (0, -bd * 0.2, body_z - bh * 0.05), max(bw, bh) * 0.4, mat_belly)
    belly.scale = (0.75, 0.6, 0.7)

    # HEAD
    head = sphere("Head", (0, -bd * 0.15, head_z), hr, mat_body)

    # EYES
    eye_size = hr * 0.35 * mood["eye_s"]
    eye_z = head_z + hr * 0.1
    eye_y = -bd * 0.15 - hr * 0.6
    eye_x = hr * 0.38

    if animal_type == "frog":
        # Bulging eyes on top
        eye_z = head_z + hr * 0.6
        eye_y = -bd * 0.15 - hr * 0.35
        eye_size *= 1.2

    if animal_type == "owl":
        eye_size *= 1.3  # Big owl eyes

    make_eye("LEye", (-eye_x, eye_y, eye_z), eye_size)
    make_eye("REye", (eye_x, eye_y, eye_z), eye_size)

    eye_positions = [(-eye_x, eye_y, eye_z, eye_size), (eye_x, eye_y, eye_z, eye_size)]
    make_brows(eye_positions, eye_size * 0.4, mood["brow"])

    # BEAK / MOUTH
    head_y = -bd * 0.15
    if c["beak_l"] > 0:
        beak_l = c["beak_l"] * S
        # Upper beak
        beak_up = cone("BeakUpper", (0, head_y - hr * 0.7, head_z - hr * 0.15),
                      0.08 * S, beak_l, mat_accent)
        beak_up.rotation_euler = (math.radians(80), 0, 0)
        # Lower beak (smaller)
        beak_lo = cone("BeakLower", (0, head_y - hr * 0.75, head_z - hr * 0.28),
                      0.05 * S, beak_l * 0.6, mat_secondary)
        beak_lo.rotation_euler = (math.radians(95), 0, 0)
    else:
        mouth_z = head_z - hr * 0.3
        mouth_y = head_y - hr * 0.55
        make_mouth((0, mouth_y, mouth_z), hr * 0.3, mood["mouth"])

    # Nose for non-beak creatures
    if c["beak_l"] == 0 and animal_type not in ("frog",):
        nose = sphere("Nose", (0, head_y - hr * 0.65, head_z - hr * 0.12), hr * 0.08, mat_dark)

    # EARS
    ear_h_scaled = c["ear_h"] * S
    if c["ear_type"] == "crest":
        # Bird crest — feathery tuft on top
        for j in range(3):
            feather = cone(f"Crest_{j}",
                          (0, head_y + 0.02 * j, head_z + hr * 0.7 + j * 0.06 * S),
                          0.04 * S, ear_h_scaled * (1 - j * 0.2), mat_accent)
            feather.rotation_euler = (math.radians(-15 + j * 10), 0, 0)

    elif c["ear_type"] == "tufts":
        for i, side in enumerate([-1, 1]):
            tuft = cone(f"Tuft_{i}", (side * hr * 0.4, head_y, head_z + hr * 0.75),
                       0.06 * S, ear_h_scaled, mat_secondary)
            tuft.rotation_euler = (0, math.radians(12 * side), 0)

    elif c["ear_type"] == "bat":
        for i, side in enumerate([-1, 1]):
            ear = cone(f"Ear_{i}", (side * hr * 0.55, head_y, head_z + hr * 0.75),
                      ear_h_scaled * 0.5, ear_h_scaled * 1.4, mat_body)
            ear.rotation_euler = (0, math.radians(20 * side), 0)
            inner = cone(f"EarInner_{i}", (side * hr * 0.55, head_y - 0.025, head_z + hr * 0.75),
                        ear_h_scaled * 0.32, ear_h_scaled * 1.1, mat_secondary)
            inner.rotation_euler = (0, math.radians(20 * side), 0)

    elif c["ear_type"] == "long":
        for i, side in enumerate([-1, 1]):
            ex = side * hr * 0.35
            ear = cylinder(f"Ear_{i}", (ex, head_y, head_z + hr + ear_h_scaled * 0.6),
                          ear_h_scaled * 0.18, ear_h_scaled * 1.2, mat_body)
            ear.rotation_euler = (0, math.radians(8 * side), 0)
            add_subsurf(ear, 1)
            inner = cylinder(f"EarInner_{i}", (ex, head_y - 0.025, head_z + hr + ear_h_scaled * 0.6),
                            ear_h_scaled * 0.11, ear_h_scaled * 1.0, mat_secondary)
            add_subsurf(inner, 1)

    # LEGS
    if c["leg_type"] == "bird":
        for i, side in enumerate([-1, 1]):
            lx = side * bw * 0.3
            # Thin bird leg
            leg = cylinder(f"Leg_{i}", (lx, 0, ground + leg_h * 0.45), 0.03 * S, leg_h * 0.9, mat_secondary)
            add_subsurf(leg, 1)
            # Wide bird foot with toes
            foot = sphere(f"Foot_{i}", (lx, -0.05 * S, ground), 0.06 * S, mat_secondary)
            foot.scale = (1.0, 1.8, 0.35)
            for t, off in enumerate([(-0.03, -0.06), (0, -0.08), (0.03, -0.06)]):
                toe = sphere(f"Toe_{i}_{t}", (lx + off[0] * S, off[1] * S, ground), 0.025 * S, mat_secondary)
                toe.scale = (0.6, 1.5, 0.4)

    elif c["leg_type"] == "strong":
        for i, side in enumerate([-1, 1]):
            lx = side * bw * 0.35
            # Thick legs
            thigh = sphere(f"Thigh_{i}", (lx, 0.02 * S, body_z - bh * 0.35), 0.1 * S * mood["limb_thick"], mat_body)
            thigh.scale = (1.0, 0.9, 1.3)
            shin = cylinder(f"Shin_{i}", (lx, -0.02 * S, ground + leg_h * 0.4), 0.06 * S * mood["limb_thick"], leg_h * 0.8, mat_body)
            add_subsurf(shin, 1)
            foot = sphere(f"Foot_{i}", (lx, -0.04 * S, ground), 0.09 * S, mat_secondary)
            foot.scale = (1.2, 1.5, 0.45)
            for t, off in enumerate([(-0.04, -0.06), (0, -0.08), (0.04, -0.06)]):
                toe = sphere(f"Toe_{i}_{t}", (lx + off[0] * S, off[1] * S, ground), 0.03 * S, mat_secondary)

    elif c["leg_type"] == "tiny":
        for i, side in enumerate([-1, 1]):
            lx = side * bw * 0.25
            leg = sphere(f"Leg_{i}", (lx, 0, body_z - bh * 0.35), 0.05 * S, mat_body)

    # ARMS / WINGS
    if c["wing"] == "feathered":
        for i, side in enumerate([-1, 1]):
            wx = side * bw * 0.55
            wz = body_z + bh * 0.1
            # Wing (cone shaped, angled out)
            wing = cone(f"Wing_{i}", (wx, 0, wz), 0.15 * S, 0.45 * S, mat_secondary)
            wing.rotation_euler = (math.radians(10), 0, math.radians(50 * side))
            add_subsurf(wing, 1)
            # Wing tip colored
            tip = cone(f"WingTip_{i}", (wx + side * 0.25 * S, 0, wz + 0.08 * S),
                      0.08 * S, 0.25 * S, mat_accent)
            tip.rotation_euler = (math.radians(5), 0, math.radians(60 * side))

    elif c["wing"] == "bat":
        for i, side in enumerate([-1, 1]):
            wx = side * bw * 0.45
            wz = body_z + bh * 0.15
            # Bat wing membrane
            wing = cone(f"Wing_{i}", (wx + side * 0.15 * S, 0, wz), 0.25 * S, 0.04 * S, mat_secondary)
            wing.rotation_euler = (0, math.radians(80), math.radians(25 * side))
            wing.scale = (2.0, 0.3, 1.2)
            # Wing arm
            arm = cylinder(f"WingArm_{i}", (wx, 0, wz + 0.05 * S), 0.02 * S, 0.35 * S, mat_dark)
            arm.rotation_euler = (0, 0, math.radians(55 * side))

    elif c["wing"] == "none":
        # Give arms to rabbit and frog
        if animal_type in ("rabbit", "frog"):
            for i, side in enumerate([-1, 1]):
                ax = side * bw * 0.5
                az = body_z + bh * 0.1
                arm = cylinder(f"Arm_{i}", (ax, -bd * 0.1, az), 0.05 * S * mood["limb_thick"],
                              0.2 * S, mat_body)
                arm.rotation_euler = (math.radians(10), math.radians(25 * side), 0)
                add_subsurf(arm, 1)
                hand = sphere(f"Hand_{i}", (ax + side * 0.08 * S, -bd * 0.15, az - 0.1 * S),
                             0.055 * S, mat_secondary)

    # TAIL
    if c["tail"] == "fan":
        for j in range(5):
            angle = (j - 2) * 18
            tx = math.sin(math.radians(angle)) * 0.1 * S
            ty = bd * 0.4 + math.cos(math.radians(angle)) * 0.02 * S
            feather = cone(f"TailF_{j}", (tx, ty, body_z + 0.05 * S),
                          0.04 * S, 0.2 * S, mat_accent if j % 2 == 0 else mat_secondary)
            feather.rotation_euler = (math.radians(-25), math.radians(angle * 0.3), 0)

    elif c["tail"] == "fan_small":
        for j in range(3):
            angle = (j - 1) * 22
            tx = math.sin(math.radians(angle)) * 0.06 * S
            ty = bd * 0.4
            feather = cone(f"TailF_{j}", (tx, ty, body_z),
                          0.03 * S, 0.12 * S, mat_secondary)
            feather.rotation_euler = (math.radians(-20), 0, 0)

    elif c["tail"] == "puff":
        tail = sphere("Tail", (0, bd * 0.45, body_z - bh * 0.15), 0.1 * S, mat_accent)

    return head_z, body_z

def build_aquatic(animal_type):
    """Build fish, shark, snake."""
    configs = {
        "fish":  {"bw": 0.3, "bl": 0.55, "bh": 0.35, "hr": 0.3, "fin_type": "pectoral", "tail_type": "fan"},
        "shark": {"bw": 0.32, "bl": 0.7, "bh": 0.32, "hr": 0.32, "fin_type": "dorsal", "tail_type": "shark"},
        "snake": {"bw": 0.2, "bl": 0.15, "bh": 0.2, "hr": 0.25, "fin_type": "none", "tail_type": "coil"},
    }
    c = configs[animal_type]

    bw, bl, bh = c["bw"] * S, c["bl"] * S, c["bh"] * S
    hr = c["hr"] * S * mood["head_s"]

    ground = 0
    # Floating slightly above ground
    base_z = bh * 0.6 + 0.05 * S

    if animal_type == "snake":
        # Upright snake with coiled body
        body_z = base_z + 0.3 * S
        head_z = body_z + 0.35 * S + hr * 0.6

        # Coil segments
        for j in range(6):
            t = j / 5.0
            cz = base_z + t * 0.35 * S
            cx = math.sin(t * math.pi * 2) * 0.12 * S
            cy = math.cos(t * math.pi * 2) * 0.08 * S
            r = (0.12 - t * 0.015) * S * mood["body_round"]
            seg_mat = mat_body if j % 2 == 0 else mat_secondary
            seg = sphere(f"Coil_{j}", (cx, cy, cz), r, seg_mat)

        # Tail on ground
        for j in range(4):
            t = j / 3.0
            tz = base_z - 0.05 * S - t * 0.08 * S
            ty = 0.1 * S + t * 0.15 * S
            r = (0.1 - t * 0.02) * S
            tail_seg = sphere(f"Tail_{j}", (0, ty, tz), r, mat_body)

        body_z = base_z + 0.3 * S
    else:
        body_z = base_z
        head_z = body_z + hr * 0.3

        # Fish/shark body (elongated oval)
        body = sphere("Body", (0, 0, body_z), max(bw, bl, bh) * 0.5, mat_body)
        body.scale = (bw / max(bw, bl, bh) * mood["body_round"],
                     bl / max(bw, bl, bh),
                     bh / max(bw, bl, bh) * mood["body_round"])
        # Belly
        belly = sphere("Belly", (0, -bl * 0.1, body_z - bh * 0.15), max(bw, bl) * 0.4, mat_belly)
        belly.scale = (0.7, 0.8, 0.5)

    # HEAD
    head_y_off = -bl * 0.4 if animal_type != "snake" else 0
    head = sphere("Head", (0, head_y_off, head_z), hr, mat_body)

    # EYES
    eye_size = hr * 0.35 * mood["eye_s"]
    eye_z = head_z + hr * 0.1
    eye_y = head_y_off - hr * 0.55
    eye_x = hr * 0.4

    if animal_type == "snake":
        eye_size *= 0.85
        eye_y = -hr * 0.55

    make_eye("LEye", (-eye_x, eye_y, eye_z), eye_size)
    make_eye("REye", (eye_x, eye_y, eye_z), eye_size)

    eye_positions = [(-eye_x, eye_y, eye_z, eye_size), (eye_x, eye_y, eye_z, eye_size)]
    make_brows(eye_positions, eye_size * 0.4, mood["brow"])

    # MOUTH
    if animal_type == "shark":
        # Wide shark grin
        mouth = sphere("Mouth", (0, head_y_off - hr * 0.65, head_z - hr * 0.3), hr * 0.25, mat_mouth)
        mouth.scale = (2.5, 0.5, 0.4)
        # Teeth
        for t in range(5):
            tx = (t - 2) * hr * 0.18
            tooth = cone(f"Tooth_{t}", (tx, head_y_off - hr * 0.72, head_z - hr * 0.22),
                        0.02 * S, 0.06 * S, mat_eye_white)
            tooth.rotation_euler = (math.radians(180), 0, 0)
    elif animal_type == "snake":
        # Snake mouth + forked tongue
        mouth_z = head_z - hr * 0.25
        make_mouth((0, -hr * 0.6, mouth_z), hr * 0.2, mood["mouth"])
        # Tongue
        tongue = cylinder("Tongue", (0, -hr * 0.85, mouth_z - 0.02 * S), 0.01 * S, 0.12 * S, mat_mouth)
        tongue.rotation_euler = (math.radians(85), 0, 0)
    else:
        mouth_z = head_z - hr * 0.25
        make_mouth((0, head_y_off - hr * 0.6, mouth_z), hr * 0.2, mood["mouth"])

    # FINS
    if c["fin_type"] == "pectoral":
        for i, side in enumerate([-1, 1]):
            fx = side * bw * 0.55 if animal_type != "snake" else side * 0.15 * S
            fz = body_z
            fin = cone(f"Fin_{i}", (fx, 0, fz), 0.12 * S, 0.04 * S, mat_secondary)
            fin.rotation_euler = (0, math.radians(75), math.radians(30 * side))
            fin.scale = (1.5, 0.3, 1)

    elif c["fin_type"] == "dorsal":
        # Dorsal fin
        dorsal = cone("DorsalFin", (0, 0, body_z + bh * 0.5), 0.04 * S, 0.2 * S, mat_accent)
        # Side fins
        for i, side in enumerate([-1, 1]):
            fin = cone(f"PecFin_{i}", (side * bw * 0.5, -bl * 0.1, body_z - bh * 0.1),
                      0.1 * S, 0.04 * S, mat_secondary)
            fin.rotation_euler = (0, math.radians(70), math.radians(35 * side))
            fin.scale = (1.3, 0.3, 1)

    # Snake features
    if animal_type == "snake":
        # Hood/markings
        hood_l = sphere("Hood_L", (-hr * 0.55, 0, head_z - hr * 0.1), hr * 0.25, mat_accent)
        hood_l.scale = (0.5, 0.8, 0.8)
        hood_r = sphere("Hood_R", (hr * 0.55, 0, head_z - hr * 0.1), hr * 0.25, mat_accent)
        hood_r.scale = (0.5, 0.8, 0.8)
        # Eye marks
        for i, side in enumerate([-1, 1]):
            mark = sphere(f"EyeMark_{i}", (side * hr * 0.45, -hr * 0.35, eye_z + eye_size * 0.5),
                         eye_size * 0.3, mat_accent)

    # TAIL
    if c["tail_type"] == "fan":
        # Fish tail fin
        tail_y = bl * 0.45
        for i, side in enumerate([-1, 1]):
            lobe = cone(f"TailLobe_{i}", (0, tail_y, body_z + side * 0.08 * S),
                       0.12 * S, 0.04 * S, mat_accent)
            lobe.rotation_euler = (math.radians(90 + 15 * side), 0, 0)
            lobe.scale = (0.7, 0.3, 1.5)

    elif c["tail_type"] == "shark":
        tail_y = bl * 0.5
        top = cone("TailTop", (0, tail_y, body_z + 0.12 * S), 0.05 * S, 0.22 * S, mat_body)
        top.rotation_euler = (math.radians(-30), 0, 0)
        bot = cone("TailBot", (0, tail_y, body_z - 0.05 * S), 0.04 * S, 0.12 * S, mat_body)
        bot.rotation_euler = (math.radians(25), 0, 0)

    return head_z, body_z

# =========================================
# ELEMENT ACCENTS
# =========================================
def add_element_accents(head_z, body_z, elements):
    el = elements[0]
    if el == "fire":
        for j in range(3):
            flame = cone(f"Flame_{j}", (random.uniform(-0.05, 0.05) * S, random.uniform(-0.1, 0.05) * S,
                         head_z + 0.3 * S + j * 0.05 * S),
                        0.04 * S, (0.15 - j * 0.03) * S, mat_accent)
            flame.rotation_euler = (random.uniform(-0.2, 0.2), random.uniform(-0.2, 0.2), 0)
    elif el == "electric":
        for i, side in enumerate([-1, 1]):
            bolt = cone(f"Bolt_{i}", (side * 0.25 * S, -0.15 * S, head_z - 0.05 * S),
                       0.03 * S, 0.1 * S, mat_accent)
            bolt.rotation_euler = (math.radians(90), 0, math.radians(25 * side))
    elif el == "ice":
        crystal = cone("Crystal", (0, -0.05 * S, head_z + 0.25 * S), 0.05 * S, 0.18 * S, mat_accent)
        # Small crystals
        for j in range(2):
            cx = (j - 0.5) * 0.12 * S
            mini = cone(f"MiniCrystal_{j}", (cx, -0.03 * S, head_z + 0.2 * S),
                       0.025 * S, 0.1 * S, mat_accent)
            mini.rotation_euler = (0, math.radians(15 * (j * 2 - 1)), 0)
    elif el == "shadow":
        for j in range(4):
            angle = j * 90 + 45
            wr = 0.35 * S
            wx = math.sin(math.radians(angle)) * wr
            wy = math.cos(math.radians(angle)) * wr
            wisp = sphere(f"Wisp_{j}", (wx, wy, body_z + random.uniform(0.1, 0.3) * S),
                         random.uniform(0.04, 0.07) * S, mat_accent)
    elif el == "toxic":
        for j in range(5):
            bx = random.uniform(-0.2, 0.2) * S
            by = random.uniform(-0.2, 0.2) * S
            bz = body_z + random.uniform(0.15, 0.5) * S
            bubble = sphere(f"Bubble_{j}", (bx, by, bz), random.uniform(0.025, 0.055) * S, mat_accent)
    elif el == "cyber":
        for j in range(4):
            angle = j * 90
            nr = 0.22 * S
            nx = math.sin(math.radians(angle)) * nr
            ny = math.cos(math.radians(angle)) * nr
            node = sphere(f"Node_{j}", (nx, ny, body_z + 0.2 * S), 0.02 * S, mat_accent)
    elif el == "steel":
        # Armor plates
        plate = cube("ArmorPlate", (0, 0.08 * S, body_z + 0.15 * S), 0.18 * S, mat_accent)
        plate.scale = (1.5, 0.8, 0.5)
    elif el == "nature":
        # Leaf on head
        leaf = cone("Leaf", (0.08 * S, -0.05 * S, head_z + 0.22 * S), 0.06 * S, 0.03 * S, mat_accent)
        leaf.rotation_euler = (math.radians(20), 0, math.radians(30))
        leaf.scale = (1, 0.3, 2)
    elif el == "water":
        # Water droplets
        for j in range(3):
            dx = random.uniform(-0.15, 0.15) * S
            dy = random.uniform(-0.15, 0.15) * S
            dz = body_z + random.uniform(0.2, 0.45) * S
            drop = sphere(f"Drop_{j}", (dx, dy, dz), random.uniform(0.03, 0.05) * S, mat_accent)

    # Second element — subtle pattern
    if len(elements) > 1:
        el2 = elements[1]
        if el2 == "steel":
            for j in range(2):
                rivet = sphere(f"Rivet_{j}", ((j - 0.5) * 0.2 * S, -0.2 * S, body_z), 0.025 * S, mat_accent)
        elif el2 == "shadow":
            mist = sphere("Mist", (0, 0, 0.02 * S), 0.35 * S, mat_accent)
            mist.scale = (1.5, 1.5, 0.2)

# =========================================
# DISPATCH BUILD
# =========================================
quadrupeds = ["fox", "cat", "dog", "wolf", "bear", "dragon", "turtle"]
bipeds = ["bird", "owl", "bat", "rabbit", "frog"]
aquatics = ["fish", "shark", "snake"]

if args.animal in quadrupeds:
    head_z, body_z = build_quadruped(args.animal)
elif args.animal in bipeds:
    head_z, body_z = build_biped(args.animal)
elif args.animal in aquatics:
    head_z, body_z = build_aquatic(args.animal)
else:
    print(f"Unknown animal: {args.animal}")
    sys.exit(1)

add_element_accents(head_z, body_z, args.elements)

# =========================================
# CAMERA
# =========================================
# Camera — mostly front-on, slight 3/4 angle for depth
cam_height = (head_z + body_z) * 0.5 + 0.15 * S
cam_dist = 2.4 * S
bpy.ops.object.camera_add(location=(cam_dist * 0.25, -cam_dist * 0.92, cam_height + 0.12 * S))
cam = bpy.context.active_object
cam.name = "Camera"

# Track to point between head and body
bpy.ops.object.empty_add(location=(0, 0, (head_z + body_z) * 0.5))
focus = bpy.context.active_object
focus.name = "CamFocus"

constraint = cam.constraints.new('TRACK_TO')
constraint.target = focus
constraint.track_axis = 'TRACK_NEGATIVE_Z'
constraint.up_axis = 'UP_Y'
bpy.context.scene.camera = cam
cam.data.lens = 58

# =========================================
# LIGHTING (toon-friendly)
# =========================================
# Strong key light from upper-front-left
bpy.ops.object.light_add(type='SUN', location=(3, -4, 5))
key = bpy.context.active_object
key.data.energy = 4.0
key.rotation_euler = (math.radians(45), math.radians(-20), math.radians(25))

# Soft fill from right
bpy.ops.object.light_add(type='AREA', location=(-2.5, -1.5, 2))
fill = bpy.context.active_object
fill.data.energy = 40
fill.data.size = 3

# Subtle rim light (element colored)
bpy.ops.object.light_add(type='POINT', location=(0, 2.5, cam_height + 0.5))
rim = bpy.context.active_object
rim.data.energy = 80
rim.data.color = palette["accent"]

# =========================================
# RENDER
# =========================================
scene = bpy.context.scene
try:
    scene.render.engine = 'BLENDER_EEVEE_NEXT'
except:
    scene.render.engine = 'BLENDER_EEVEE'

scene.render.resolution_x = args.res
scene.render.resolution_y = args.res
scene.render.film_transparent = True
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.eevee.taa_render_samples = 64

# Enable Freestyle outlines for cartoon look
scene.render.use_freestyle = True
scene.view_layers[0].freestyle_settings.linesets[0].select_silhouette = True
scene.view_layers[0].freestyle_settings.linesets[0].select_border = True
scene.view_layers[0].freestyle_settings.linesets[0].select_crease = True
# Line thickness
scene.view_layers[0].freestyle_settings.linesets[0].linestyle.thickness = 1.8

# World
world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes.get("Background")
if bg:
    bg.inputs["Color"].default_value = (0.02, 0.02, 0.03, 1)
    bg.inputs["Strength"].default_value = 0.2

# Render
os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
scene.render.filepath = os.path.abspath(args.output)
bpy.ops.render.render(write_still=True)
print(f"✓ Rendered: {args.output} ({args.animal} + {'+'.join(args.elements)}, {args.mood}/{args.size})")
