#!/usr/bin/env python3
"""
Cybermon Generator v3 — Pokémon-style 3D creatures with toon shading.
Run: blender --background --python render_cybermon.py -- --animal fox --elements fire shadow --mood cute --output /tmp/cybermon.png

Inspired by Pokémon: real animal bases with elemental characteristics woven into
their bodies (lightning bolts on fur, fire mane, ice crystals on shell, etc).

NO ground planes, NO platforms, NO shadow discs — creatures float on transparent bg.

Animals: fox, cat, dog, wolf, bear, dragon, turtle, horse, capybara, badger,
         bird, owl, bat, rabbit, frog, deer, penguin, raccoon, fish, shark, snake
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
    "fire":     {"primary": (0.95, 0.25, 0.05), "secondary": (1.0, 0.55, 0.1),  "accent": (1.0, 0.85, 0.15), "belly": (1.0, 0.75, 0.45), "iris": (1.0, 0.45, 0.0)},
    "water":    {"primary": (0.15, 0.40, 0.88), "secondary": (0.35, 0.65, 1.0),  "accent": (0.55, 0.88, 1.0),  "belly": (0.65, 0.82, 1.0), "iris": (0.15, 0.35, 0.9)},
    "electric": {"primary": (1.0, 0.82, 0.0),   "secondary": (1.0, 0.65, 0.0),  "accent": (1.0, 1.0, 0.5),   "belly": (1.0, 1.0, 0.65),  "iris": (1.0, 0.75, 0.0)},
    "nature":   {"primary": (0.22, 0.68, 0.22), "secondary": (0.45, 0.82, 0.28), "accent": (0.65, 1.0, 0.45),  "belly": (0.75, 1.0, 0.65), "iris": (0.18, 0.65, 0.18)},
    "shadow":   {"primary": (0.22, 0.08, 0.32), "secondary": (0.42, 0.18, 0.55), "accent": (0.65, 0.25, 0.95), "belly": (0.45, 0.30, 0.55),"iris": (0.55, 0.15, 0.85)},
    "ice":      {"primary": (0.55, 0.82, 1.0),  "secondary": (0.75, 0.92, 1.0),  "accent": (0.88, 0.96, 1.0),  "belly": (0.90, 0.95, 1.0), "iris": (0.35, 0.65, 1.0)},
    "steel":    {"primary": (0.50, 0.53, 0.60), "secondary": (0.68, 0.72, 0.78), "accent": (0.82, 0.85, 0.90), "belly": (0.75, 0.78, 0.82),"iris": (0.45, 0.50, 0.60)},
    "toxic":    {"primary": (0.42, 0.12, 0.55), "secondary": (0.55, 0.85, 0.12), "accent": (0.75, 1.0, 0.25),  "belly": (0.65, 0.45, 0.75),"iris": (0.45, 1.0, 0.25)},
    "cyber":    {"primary": (0.0, 0.60, 0.82),  "secondary": (0.0, 0.85, 1.0),   "accent": (0.25, 1.0, 1.0),   "belly": (0.45, 0.85, 1.0), "iris": (0.0, 0.75, 1.0)},
}

def mix_palette(elements):
    palettes = [ELEMENT_COLORS.get(e, ELEMENT_COLORS["cyber"]) for e in elements]
    if len(palettes) == 1:
        return palettes[0]
    p1, p2 = palettes[0], palettes[1]
    return {
        "primary": tuple((a * 0.65 + b * 0.35) for a, b in zip(p1["primary"], p2["primary"])),
        "secondary": tuple((a * 0.4 + b * 0.6) for a, b in zip(p1["secondary"], p2["secondary"])),
        "accent": p2["accent"],
        "belly": tuple((a * 0.5 + b * 0.5) for a, b in zip(p1["belly"], p2["belly"])),
        "iris": p1["iris"],
    }

palette = mix_palette(args.elements)

# =========================================
# MOOD MODIFIERS
# =========================================
MOOD = {
    "cute":     {"head_s": 1.35, "eye_s": 1.5,  "body_round": 1.2,  "limb_thick": 1.15, "mouth": "smile",   "brow": "none"},
    "fierce":   {"head_s": 1.0,  "eye_s": 0.85, "body_round": 0.95, "limb_thick": 1.1,  "mouth": "grin",    "brow": "angry"},
    "chill":    {"head_s": 1.15, "eye_s": 1.2,  "body_round": 1.15, "limb_thick": 1.1,  "mouth": "neutral", "brow": "none"},
    "angry":    {"head_s": 0.95, "eye_s": 0.82, "body_round": 0.9,  "limb_thick": 1.15, "mouth": "frown",   "brow": "angry"},
    "playful":  {"head_s": 1.25, "eye_s": 1.35, "body_round": 1.1,  "limb_thick": 1.1,  "mouth": "open",    "brow": "none"},
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

def make_toon_mat(name, color, shadow_color=None):
    """Toon/cel-shaded material via Shader-to-RGB."""
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()

    output = nodes.new('ShaderNodeOutputMaterial'); output.location = (600, 0)
    diffuse = nodes.new('ShaderNodeBsdfDiffuse'); diffuse.location = (-200, 100)
    diffuse.inputs['Color'].default_value = (*color, 1)
    s2r = nodes.new('ShaderNodeShaderToRGB'); s2r.location = (0, 100)
    ramp = nodes.new('ShaderNodeValToRGB'); ramp.location = (200, 100)
    cr = ramp.color_ramp
    cr.interpolation = 'CONSTANT'
    cr.elements[0].position = 0.0
    cr.elements[0].color = (*(c * 0.45 for c in color), 1) if not shadow_color else (*shadow_color, 1)
    cr.elements[1].position = 0.32
    cr.elements[1].color = (*color, 1)
    hl = cr.elements.new(0.82)
    hl.color = (*(min(c * 1.25, 1.0) for c in color), 1)
    emission = nodes.new('ShaderNodeEmission'); emission.location = (400, 100)
    emission.inputs['Strength'].default_value = 1.0
    links.new(diffuse.outputs['BSDF'], s2r.inputs['Shader'])
    links.new(s2r.outputs['Color'], ramp.inputs['Fac'])
    links.new(ramp.outputs['Color'], emission.inputs['Color'])
    links.new(emission.outputs['Emission'], output.inputs['Surface'])
    return mat

def make_flat_mat(name, color):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes; links = mat.node_tree.links
    nodes.clear()
    output = nodes.new('ShaderNodeOutputMaterial'); output.location = (200, 0)
    emission = nodes.new('ShaderNodeEmission'); emission.location = (0, 0)
    emission.inputs['Color'].default_value = (*color, 1)
    emission.inputs['Strength'].default_value = 1.0
    links.new(emission.outputs['Emission'], output.inputs['Surface'])
    return mat

def obj_add(prim_fn, name, loc, mat=None, **kw):
    prim_fn(location=loc, **kw)
    o = bpy.context.active_object
    o.name = name
    bpy.ops.object.shade_smooth()
    if mat:
        o.data.materials.append(mat)
    return o

def add_ss(obj, lvl=2):
    m = obj.modifiers.new("Sub", 'SUBSURF')
    m.levels = lvl; m.render_levels = lvl
    return m

# Shorthands
def sp(name, loc, r, mat=None):
    o = obj_add(bpy.ops.mesh.primitive_uv_sphere_add, name, loc, mat, radius=r, segments=24, ring_count=16)
    add_ss(o, 1); return o

def cn(name, loc, r, depth, mat=None, verts=16):
    return obj_add(bpy.ops.mesh.primitive_cone_add, name, loc, mat, radius1=r, depth=depth, vertices=verts)

def cy(name, loc, r, depth, mat=None):
    o = obj_add(bpy.ops.mesh.primitive_cylinder_add, name, loc, mat, radius=r, depth=depth, vertices=16)
    return o

def cu(name, loc, size, mat=None):
    o = obj_add(bpy.ops.mesh.primitive_cube_add, name, loc, mat, size=size)
    add_ss(o, 2); return o

# =========================================
# MATERIALS SETUP
# =========================================
print(f"=== Cybermon v3: {args.animal} + {'+'.join(args.elements)} ({args.mood}/{args.size}) ===")
clear_all()

mat_body = make_toon_mat("Body", palette["primary"])
mat_sec = make_toon_mat("Secondary", palette["secondary"])
mat_acc = make_toon_mat("Accent", palette["accent"])
mat_belly = make_toon_mat("Belly", palette["belly"])
mat_dark = make_toon_mat("Dark", (0.10, 0.08, 0.08))

mat_eye_w = make_flat_mat("EyeWhite", (1, 1, 1))
mat_iris = make_flat_mat("Iris", palette["iris"])
mat_pupil = make_flat_mat("Pupil", (0.02, 0.02, 0.02))
mat_hl = make_flat_mat("Highlight", (1, 1, 1))
mat_mouth = make_flat_mat("Mouth", (0.15, 0.05, 0.05))

# =========================================
# EXPRESSIVE EYES
# =========================================
def make_eye(pfx, center, size):
    ex, ey, ez = center
    r = size
    fy = -r * 0.75
    sclera = sp(f"{pfx}_Scl", (ex, ey + fy, ez), r, mat_eye_w)
    sclera.scale = (1.0, 0.65, 1.15)
    iris = sp(f"{pfx}_Iris", (ex, ey + fy - r * 0.3, ez - r * 0.06), r * 0.72, mat_iris)
    iris.scale = (1.0, 0.55, 1.05)
    pupil = sp(f"{pfx}_Pup", (ex, ey + fy - r * 0.45, ez - r * 0.04), r * 0.72 * 0.55, mat_pupil)
    pupil.scale = (1.0, 0.45, 1.1)
    h1 = sp(f"{pfx}_HL1", (ex + r * 0.22, ey + fy - r * 0.4, ez + r * 0.25), r * 0.3, mat_hl)
    h2 = sp(f"{pfx}_HL2", (ex - r * 0.18, ey + fy - r * 0.35, ez - r * 0.2), r * 0.13, mat_hl)
    return sclera

def make_mouth(center, width, mtype="smile"):
    mx, my, mz = center
    m = sp("Mouth", (mx, my, mz), width * 0.5, mat_mouth)
    scales = {"smile": (1.5, 0.5, 0.4), "grin": (2.0, 0.5, 0.5), "frown": (1.2, 0.4, 0.3),
              "open": (1.0, 0.6, 0.8), "neutral": (1.5, 0.3, 0.2)}
    m.scale = scales.get(mtype, (1.5, 0.3, 0.2))

def make_brows(eye_pos, brow_r, btype="angry"):
    if btype == "none": return
    for i, (ex, ey, ez, er) in enumerate(eye_pos):
        b = cu(f"Brow_{i}", (ex, ey - er * 0.3, ez + er * 1.0), er * 0.6, mat_dark)
        b.scale = (2.0, 0.5, 0.3)
        b.rotation_euler = (0, 0, math.radians(15 * (1 if i == 0 else -1)))

# =========================================
# ELEMENT MARKINGS — integrated into body
# =========================================
def add_element_markings(head_z, body_z, body_w, elements):
    """Add element-specific features woven into the creature's body."""
    el = elements[0]

    if el == "fire":
        # Fire mane / flames along spine
        for j in range(5):
            t = j / 4.0
            fz = body_z + (head_z - body_z) * t * 0.6 + 0.08 * S
            fy = 0.05 * S + t * 0.04 * S
            fh = (0.12 + math.sin(t * math.pi) * 0.06) * S
            flame = cn(f"Flame_{j}", (random.uniform(-0.02, 0.02) * S, fy, fz + fh * 0.5),
                       0.035 * S, fh, mat_acc)
            flame.rotation_euler = (random.uniform(-0.15, 0.15), random.uniform(-0.1, 0.1), 0)
        # Ember tip on tail area
        ember = sp("Ember", (0, body_w * 0.6, body_z), 0.06 * S, mat_acc)

    elif el == "electric":
        # Lightning bolt-shaped ear tips / zigzag markings
        for i, side in enumerate([-1, 1]):
            # Zigzag bolt on cheeks
            for j in range(3):
                bz = head_z - 0.05 * S + j * 0.04 * S
                bx = side * (body_w * 0.3 + 0.05 * S)
                bolt = cn(f"Bolt_{i}_{j}", (bx, -0.15 * S, bz),
                          0.015 * S, 0.06 * S, mat_acc)
                bolt.rotation_euler = (math.radians(90), 0, math.radians(30 * side + j * 15))
        # Spark tips on body
        for j in range(3):
            angle = j * 120
            sr = body_w * 0.45
            sx = math.sin(math.radians(angle)) * sr
            sy = math.cos(math.radians(angle)) * sr
            spark = cn(f"Spark_{j}", (sx, sy, body_z + 0.1 * S),
                       0.02 * S, 0.08 * S, mat_acc)
            spark.rotation_euler = (random.uniform(-0.3, 0.3), random.uniform(-0.3, 0.3), 0)

    elif el == "ice":
        # Ice crystals growing from body
        crystal = cn("Crystal", (0, -0.02 * S, head_z + 0.2 * S), 0.04 * S, 0.16 * S, mat_acc)
        for j in range(3):
            angle = j * 120 + 60
            cr = body_w * 0.35
            cx = math.sin(math.radians(angle)) * cr
            cy = math.cos(math.radians(angle)) * cr
            mini = cn(f"IceShard_{j}", (cx, cy, body_z + 0.12 * S),
                      0.025 * S, 0.10 * S, mat_acc)
            mini.rotation_euler = (random.uniform(-0.2, 0.2), random.uniform(-0.2, 0.2), 0)
        # Frost patches on body
        for j in range(2):
            fp = sp(f"Frost_{j}", (random.uniform(-0.1, 0.1) * S, random.uniform(-0.08, 0.08) * S,
                    body_z + random.uniform(-0.05, 0.1) * S), 0.06 * S, mat_acc)
            fp.scale = (1.2, 0.8, 0.3)

    elif el == "shadow":
        # Wispy shadow aura tendrils rising from body
        for j in range(5):
            angle = j * 72
            wr = body_w * (0.35 + random.uniform(0, 0.15))
            wx = math.sin(math.radians(angle)) * wr
            wy = math.cos(math.radians(angle)) * wr
            wz = body_z + random.uniform(0.08, 0.25) * S
            wisp = sp(f"Wisp_{j}", (wx, wy, wz), random.uniform(0.03, 0.06) * S, mat_acc)
            wisp.scale = (0.6, 0.6, random.uniform(1.5, 2.5))

    elif el == "toxic":
        # Poison sacs / bubbling patches
        for j in range(4):
            angle = j * 90 + random.uniform(-15, 15)
            br = body_w * 0.35
            bx = math.sin(math.radians(angle)) * br
            by = math.cos(math.radians(angle)) * br
            bz = body_z + random.uniform(-0.05, 0.12) * S
            sac = sp(f"ToxSac_{j}", (bx, by, bz), random.uniform(0.035, 0.06) * S, mat_acc)
        # Drip marks on face
        for j in range(2):
            dx = (j - 0.5) * body_w * 0.3
            drip = sp(f"Drip_{j}", (dx, -body_w * 0.4, head_z - 0.08 * S), 0.02 * S, mat_acc)
            drip.scale = (0.7, 0.5, 1.8)

    elif el == "cyber":
        # Circuit line nodes along body
        for j in range(6):
            t = j / 5.0
            nz = body_z + (head_z - body_z) * t * 0.5
            ny = -body_w * 0.25 - 0.02 * S
            node = sp(f"Node_{j}", (0, ny, nz), 0.018 * S, mat_acc)
        # Antenna on head
        ant = cy("Antenna", (0, -0.05 * S, head_z + 0.22 * S), 0.01 * S, 0.14 * S, mat_acc)
        tip = sp("AntTip", (0, -0.05 * S, head_z + 0.30 * S), 0.025 * S, mat_acc)

    elif el == "steel":
        # Armor plates on back and shoulders
        plate = cu("BackPlate", (0, 0.06 * S, body_z + 0.12 * S), 0.15 * S, mat_acc)
        plate.scale = (1.5, 0.8, 0.4)
        for i, side in enumerate([-1, 1]):
            sp_plate = cu(f"ShPlate_{i}", (side * body_w * 0.35, -0.02 * S, body_z + 0.06 * S),
                          0.08 * S, mat_acc)
            sp_plate.scale = (0.6, 0.8, 0.5)

    elif el == "nature":
        # Leaf crown and vine markings
        for j in range(3):
            angle = j * 50 - 50
            lx = math.sin(math.radians(angle)) * 0.08 * S
            ly = math.cos(math.radians(angle)) * 0.04 * S - 0.03 * S
            leaf = cn(f"Leaf_{j}", (lx, ly, head_z + 0.18 * S + j * 0.02 * S),
                      0.04 * S, 0.02 * S, mat_acc)
            leaf.rotation_euler = (math.radians(15 + j * 10), 0, math.radians(angle * 0.5))
            leaf.scale = (0.8, 0.3, 2.0)
        # Flower/bud on back
        bud = sp("Bud", (0, 0.08 * S, body_z + 0.15 * S), 0.05 * S, mat_acc)

    elif el == "water":
        # Water droplets / bubble trail
        for j in range(4):
            dx = random.uniform(-0.12, 0.12) * S
            dy = random.uniform(-0.12, 0.12) * S
            dz = body_z + random.uniform(0.15, 0.4) * S
            drop = sp(f"Drop_{j}", (dx, dy, dz), random.uniform(0.025, 0.045) * S, mat_acc)
        # Fin-like ridge on back
        ridge = cn("WaterRidge", (0, 0.05 * S, body_z + 0.14 * S),
                    body_w * 0.3, 0.03 * S, mat_acc)
        ridge.scale = (0.3, 1.5, 1)

    # Second element — subtle accent
    if len(elements) > 1:
        el2 = elements[1]
        if el2 == "fire":
            # Small flame tips on ears/extremities
            for j in range(2):
                ft = cn(f"FireTip_{j}", ((j - 0.5) * 0.15 * S, 0, head_z + 0.15 * S),
                        0.02 * S, 0.06 * S, mat_sec)
        elif el2 == "electric":
            # Subtle spark aura
            for j in range(2):
                sp(f"SubSpark_{j}", ((j - 0.5) * body_w * 0.5, -0.1 * S, body_z + 0.15 * S),
                   0.02 * S, mat_sec)
        elif el2 == "steel":
            # Small rivets
            for j in range(3):
                sp(f"Rivet_{j}", ((j - 1) * 0.1 * S, -body_w * 0.28, body_z), 0.018 * S, mat_sec)
        elif el2 == "shadow":
            # Dark wisps (NO ground disc)
            for j in range(3):
                sp(f"DarkWisp_{j}", (random.uniform(-0.1, 0.1) * S, random.uniform(-0.1, 0.1) * S,
                    body_z + random.uniform(0.1, 0.3) * S), 0.03 * S, mat_sec)
        elif el2 == "ice":
            sp("IceTip", (0, -0.05 * S, head_z + 0.15 * S), 0.03 * S, mat_sec)
        elif el2 == "nature":
            cn("VineTip", (0.06 * S, -0.03 * S, head_z + 0.12 * S),
               0.02 * S, 0.05 * S, mat_sec)
            cn("VineTip2", (-0.06 * S, -0.03 * S, head_z + 0.12 * S),
               0.02 * S, 0.05 * S, mat_sec)
        elif el2 == "toxic":
            for j in range(2):
                sp(f"ToxDot_{j}", ((j - 0.5) * body_w * 0.3, -body_w * 0.22, body_z + 0.05 * S),
                   0.02 * S, mat_sec)
        elif el2 == "cyber":
            for j in range(2):
                sp(f"SubNode_{j}", ((j - 0.5) * 0.12 * S, -body_w * 0.3, body_z + 0.05 * S),
                   0.015 * S, mat_sec)
        elif el2 == "water":
            for j in range(2):
                sp(f"SubDrop_{j}", (random.uniform(-0.08, 0.08) * S, random.uniform(-0.08, 0.08) * S,
                    body_z + 0.25 * S + j * 0.06 * S), 0.02 * S, mat_sec)


# =========================================
# QUADRUPEDS: fox, cat, dog, wolf, bear, dragon, turtle, horse, capybara, badger, deer
# =========================================
def build_quadruped(animal):
    configs = {
        "fox":      {"bw": 0.50, "bd": 0.38, "bh": 0.40, "hr": 0.36, "neck": 0.14, "snout_l": 0.20, "snout_w": 0.11,
                     "ear_h": 0.30, "ear_w": 0.13, "ear": "pointed", "tail": "fluffy", "leg_r": 0.065, "leg_h": 0.26},
        "cat":      {"bw": 0.42, "bd": 0.33, "bh": 0.36, "hr": 0.35, "neck": 0.10, "snout_l": 0.09, "snout_w": 0.09,
                     "ear_h": 0.24, "ear_w": 0.14, "ear": "pointed", "tail": "long_curvy", "leg_r": 0.055, "leg_h": 0.24},
        "dog":      {"bw": 0.52, "bd": 0.40, "bh": 0.40, "hr": 0.37, "neck": 0.12, "snout_l": 0.22, "snout_w": 0.11,
                     "ear_h": 0.20, "ear_w": 0.15, "ear": "floppy", "tail": "wagging", "leg_r": 0.075, "leg_h": 0.28},
        "wolf":     {"bw": 0.58, "bd": 0.42, "bh": 0.44, "hr": 0.37, "neck": 0.15, "snout_l": 0.26, "snout_w": 0.11,
                     "ear_h": 0.22, "ear_w": 0.12, "ear": "pointed", "tail": "bushy_down", "leg_r": 0.07, "leg_h": 0.30},
        "bear":     {"bw": 0.68, "bd": 0.52, "bh": 0.58, "hr": 0.40, "neck": 0.08, "snout_l": 0.16, "snout_w": 0.14,
                     "ear_h": 0.14, "ear_w": 0.14, "ear": "round", "tail": "puff", "leg_r": 0.11, "leg_h": 0.26,
                     "arms": True, "arm_r": 0.11},
        "dragon":   {"bw": 0.58, "bd": 0.44, "bh": 0.48, "hr": 0.38, "neck": 0.18, "snout_l": 0.22, "snout_w": 0.12,
                     "ear_h": 0.26, "ear_w": 0.09, "ear": "horns", "tail": "long_spike", "leg_r": 0.085, "leg_h": 0.28,
                     "arms": True, "arm_r": 0.08, "wings": True},
        "turtle":   {"bw": 0.58, "bd": 0.48, "bh": 0.33, "hr": 0.28, "neck": 0.12, "snout_l": 0.07, "snout_w": 0.07,
                     "ear_h": 0.0, "ear_w": 0.0, "ear": "none", "tail": "stubby", "leg_r": 0.09, "leg_h": 0.16,
                     "shell": True},
        "horse":    {"bw": 0.55, "bd": 0.50, "bh": 0.50, "hr": 0.38, "neck": 0.22, "snout_l": 0.28, "snout_w": 0.13,
                     "ear_h": 0.18, "ear_w": 0.08, "ear": "pointed", "tail": "flowing", "leg_r": 0.06, "leg_h": 0.38,
                     "mane": True},
        "capybara": {"bw": 0.62, "bd": 0.48, "bh": 0.42, "hr": 0.38, "neck": 0.06, "snout_l": 0.18, "snout_w": 0.15,
                     "ear_h": 0.10, "ear_w": 0.10, "ear": "round", "tail": "none", "leg_r": 0.08, "leg_h": 0.20},
        "badger":   {"bw": 0.52, "bd": 0.42, "bh": 0.35, "hr": 0.32, "neck": 0.08, "snout_l": 0.20, "snout_w": 0.10,
                     "ear_h": 0.10, "ear_w": 0.10, "ear": "round", "tail": "stubby", "leg_r": 0.08, "leg_h": 0.18,
                     "face_stripe": True},
        "deer":     {"bw": 0.48, "bd": 0.40, "bh": 0.45, "hr": 0.34, "neck": 0.20, "snout_l": 0.15, "snout_w": 0.10,
                     "ear_h": 0.18, "ear_w": 0.12, "ear": "pointed", "tail": "puff", "leg_r": 0.05, "leg_h": 0.36,
                     "antlers": True},
    }
    c = configs[animal]

    bw = c["bw"] * S * mood["body_round"]
    bd = c["bd"] * S * mood["body_round"]
    bh = c["bh"] * S
    hr = c["hr"] * S * mood["head_s"]
    neck = c["neck"] * S
    snout_l = c["snout_l"] * S
    snout_w = c["snout_w"] * S
    ear_h = c["ear_h"] * S
    leg_r = c["leg_r"] * S * mood["limb_thick"]
    leg_h = c["leg_h"] * S

    # Layout
    body_z = leg_h + bh * 0.4
    head_z = body_z + bh * 0.4 + neck + hr * 0.6

    # BODY
    body = sp("Body", (0, 0, body_z), max(bw, bh) * 0.5, mat_body)
    body.scale = (bw / max(bw, bh), bd / max(bw, bh), bh / max(bw, bh))

    # Belly
    belly = sp("Belly", (0, -bd * 0.15, body_z - bh * 0.1), max(bw, bh) * 0.42, mat_belly)
    belly.scale = (0.8, 0.65, 0.7)

    # Shell (turtle)
    if c.get("shell"):
        shell = sp("Shell", (0, bd * 0.05, body_z + bh * 0.15), max(bw, bd) * 0.58, mat_acc)
        shell.scale = (1.1, 0.9, 0.65)

    # Mane (horse)
    if c.get("mane"):
        for j in range(6):
            t = j / 5.0
            mz = head_z - hr * 0.3 - t * (head_z - body_z - bh * 0.2)
            my = 0.02 * S + t * 0.03 * S
            seg = sp(f"Mane_{j}", (0, my, mz), 0.05 * S, mat_sec)
            seg.scale = (0.5, 0.8, 1.2)

    # Face stripe (badger)
    if c.get("face_stripe"):
        stripe = sp("Stripe", (0, -bd * 0.2 - neck * 0.3 - hr * 0.5, head_z + hr * 0.15),
                     hr * 0.15, mat_belly)
        stripe.scale = (0.4, 0.5, 2.5)

    # Antlers (deer)
    if c.get("antlers"):
        hy = -bd * 0.2 - neck * 0.3
        for i, side in enumerate([-1, 1]):
            ax = side * hr * 0.35
            # Main branch
            main = cy(f"Antler_{i}", (ax, hy, head_z + hr * 0.8 + 0.1 * S),
                       0.02 * S, 0.22 * S, mat_sec)
            main.rotation_euler = (0, math.radians(15 * side), 0)
            add_ss(main, 1)
            # Side branch
            branch = cy(f"AntBranch_{i}", (ax + side * 0.06 * S, hy, head_z + hr * 0.8 + 0.15 * S),
                         0.015 * S, 0.10 * S, mat_sec)
            branch.rotation_euler = (0, math.radians(40 * side), 0)
            add_ss(branch, 1)

    # HEAD
    head = sp("Head", (0, -bd * 0.2 - neck * 0.3, head_z), hr, mat_body)

    # Snout
    if snout_l > 0:
        sy = -bd * 0.2 - neck * 0.3 - hr * 0.75
        sz = head_z - hr * 0.2
        snout = sp("Snout", (0, sy, sz), max(snout_l, snout_w), mat_belly)
        snout.scale = (snout_w / max(snout_l, snout_w), snout_l / max(snout_l, snout_w),
                       snout_w * 0.7 / max(snout_l, snout_w))
        nose = sp("Nose", (0, sy - snout_l * 0.5, sz + snout_w * 0.2), snout_w * 0.35, mat_dark)

    # Eyes
    eye_s = hr * 0.32 * mood["eye_s"]
    eye_z = head_z + hr * 0.08
    eye_y = -bd * 0.2 - neck * 0.3 - hr * 0.6
    eye_x = hr * 0.42
    make_eye("LE", (-eye_x, eye_y, eye_z), eye_s)
    make_eye("RE", (eye_x, eye_y, eye_z), eye_s)
    make_brows([(-eye_x, eye_y, eye_z, eye_s), (eye_x, eye_y, eye_z, eye_s)], eye_s * 0.4, mood["brow"])

    # Mouth
    mz = head_z - hr * 0.35
    my = -bd * 0.2 - neck * 0.3 - hr * 0.55
    if snout_l > 0.15 * S:
        my -= snout_l * 0.3; mz -= snout_w * 0.2
    make_mouth((0, my, mz), hr * 0.3, mood["mouth"])

    # EARS
    htop_z = head_z + hr * 0.75
    hy = -bd * 0.2 - neck * 0.3

    if c["ear"] == "pointed":
        for i, side in enumerate([-1, 1]):
            ex = side * hr * 0.5
            ear = cn(f"Ear_{i}", (ex, hy, htop_z + ear_h * 0.55), c["ear_w"] * S * 1.2, ear_h * 1.3, mat_body)
            ear.rotation_euler = (0, math.radians(12 * side), 0)
            inner = cn(f"EarIn_{i}", (ex, hy - c["ear_w"] * S * 0.25, htop_z + ear_h * 0.55),
                       c["ear_w"] * S * 0.75, ear_h * 1.0, mat_sec)
            inner.rotation_euler = (0, math.radians(12 * side), 0)
    elif c["ear"] == "floppy":
        for i, side in enumerate([-1, 1]):
            ex = side * hr * 0.7
            ear = sp(f"Ear_{i}", (ex, hy, head_z + hr * 0.25), ear_h * 0.55, mat_body)
            ear.scale = (0.5, 0.3, 1.5)
            ear.rotation_euler = (0, 0, math.radians(25 * side))
            inner = sp(f"EarIn_{i}", (ex, hy - 0.02, head_z + hr * 0.25), ear_h * 0.4, mat_sec)
            inner.scale = (0.4, 0.25, 1.3)
            inner.rotation_euler = (0, 0, math.radians(25 * side))
    elif c["ear"] == "round":
        for i, side in enumerate([-1, 1]):
            ex = side * hr * 0.6
            sp(f"Ear_{i}", (ex, hy, htop_z + ear_h * 0.25), ear_h * 0.55, mat_body)
            sp(f"EarIn_{i}", (ex, hy - c["ear_w"] * S * 0.2, htop_z + ear_h * 0.25), ear_h * 0.4, mat_sec)
    elif c["ear"] == "horns":
        for i, side in enumerate([-1, 1]):
            cn(f"Horn_{i}", (side * hr * 0.45, hy, htop_z + ear_h * 0.7),
               c["ear_w"] * S * 0.5, ear_h * 1.5, mat_acc)

    # LEGS (4 legs)
    legs = [(-bw * 0.35, -bd * 0.2, "FL"), (bw * 0.35, -bd * 0.2, "FR"),
            (-bw * 0.35, bd * 0.2, "BL"),  (bw * 0.35, bd * 0.2, "BR")]
    for lx, ly, label in legs:
        leg = cy(f"Leg_{label}", (lx, ly, leg_h * 0.5), leg_r, leg_h, mat_body)
        add_ss(leg, 1)
        foot = sp(f"Foot_{label}", (lx, ly - leg_r * 0.3, 0), leg_r * 1.4, mat_sec)
        foot.scale = (1.2, 1.4, 0.5)
        for t, tx in enumerate([-leg_r * 0.6, 0, leg_r * 0.6]):
            sp(f"Toe_{label}_{t}", (lx + tx, ly - leg_r * 0.8, 0), leg_r * 0.35, mat_sec)

    # ARMS (bear, dragon)
    if c.get("arms"):
        arm_r = c.get("arm_r", 0.08) * S * mood["limb_thick"]
        for i, side in enumerate([-1, 1]):
            ax = side * (bw * 0.55)
            az = body_z + bh * 0.15
            arm = cy(f"Arm_{i}", (ax, -bd * 0.1, az), arm_r, leg_h * 0.7, mat_body)
            arm.rotation_euler = (0, math.radians(30 * side), 0)
            add_ss(arm, 1)
            sp(f"Hand_{i}", (ax + side * leg_h * 0.25, -bd * 0.15, az - leg_h * 0.25),
               arm_r * 1.3, mat_sec).scale = (1.1, 1.2, 0.8)

    # WINGS (dragon)
    if c.get("wings"):
        for i, side in enumerate([-1, 1]):
            wx = side * bw * 0.6
            wz = body_z + bh * 0.35
            bone = cy(f"WBone_{i}", (wx, bd * 0.1, wz), 0.03 * S, 0.5 * S, mat_dark)
            bone.rotation_euler = (math.radians(20), 0, math.radians(55 * side))
            mem = cn(f"WMem_{i}", (wx + side * 0.3 * S, bd * 0.05, wz + 0.1 * S),
                     0.3 * S, 0.05 * S, mat_sec)
            mem.rotation_euler = (0, math.radians(90), math.radians(30 * side))
            mem.scale = (1.5, 0.4, 1)

    # TAIL
    tby = bd * 0.45
    tbz = body_z

    if c["tail"] == "fluffy":
        for j in range(5):
            t = j / 4.0
            ty = tby + t * 0.5 * S
            tz = tbz + math.sin(t * math.pi * 0.5) * 0.15 * S
            r = (0.12 + math.sin(t * math.pi) * 0.08) * S
            sp(f"Tail_{j}", (0, ty, tz), r, mat_sec if j < 3 else mat_acc)
        sp("TailTip", (0, tby + 0.55 * S, tbz + 0.12 * S), 0.15 * S, mat_acc)
    elif c["tail"] == "long_curvy":
        for j in range(6):
            t = j / 5.0
            sp(f"Tail_{j}", (math.sin(t * math.pi * 1.5) * 0.08 * S,
                             tby + t * 0.45 * S,
                             tbz + math.sin(t * math.pi) * 0.2 * S),
               (0.06 - t * 0.008) * S, mat_body)
        sp("TailTip", (0.05 * S, tby + 0.48 * S, tbz + 0.1 * S), 0.07 * S, mat_acc)
    elif c["tail"] == "wagging":
        for j in range(4):
            t = j / 3.0
            sp(f"Tail_{j}", (0, tby + t * 0.3 * S, tbz + t * 0.18 * S),
               (0.08 - t * 0.015) * S, mat_body)
        sp("TailTip", (0, tby + 0.32 * S, tbz + 0.22 * S), 0.06 * S, mat_acc)
    elif c["tail"] == "bushy_down":
        for j in range(5):
            t = j / 4.0
            sp(f"Tail_{j}", (0, tby + t * 0.4 * S, tbz - t * 0.12 * S),
               (0.1 + math.sin(t * math.pi) * 0.06) * S, mat_sec)
    elif c["tail"] == "long_spike":
        for j in range(6):
            t = j / 5.0
            sp(f"Tail_{j}", (0, tby + t * 0.55 * S, tbz - t * 0.15 * S),
               (0.1 - t * 0.012) * S, mat_body if j < 4 else mat_acc)
        spike = cn("TailSpike", (0, tby + 0.6 * S, tbz - 0.2 * S), 0.06 * S, 0.15 * S, mat_acc)
        spike.rotation_euler = (math.radians(70), 0, 0)
    elif c["tail"] == "flowing":
        # Horse flowing tail
        for j in range(7):
            t = j / 6.0
            sp(f"Tail_{j}", (0, tby + t * 0.45 * S, tbz - t * 0.2 * S - 0.05 * S),
               (0.08 + math.sin(t * math.pi) * 0.04) * S, mat_sec)
    elif c["tail"] == "puff":
        sp("Tail", (0, tby, tbz - bh * 0.1), 0.1 * S, mat_sec)
    elif c["tail"] == "stubby":
        sp("Tail", (0, tby, tbz - bh * 0.05), 0.07 * S, mat_sec)
    # "none" — no tail (capybara)

    return head_z, body_z, bw


# =========================================
# BIPEDS: bird, owl, bat, rabbit, frog, penguin, raccoon
# =========================================
def build_biped(animal):
    configs = {
        "bird":    {"bw": 0.33, "bh": 0.40, "hr": 0.27, "beak": 0.16, "ear": "crest",  "ear_h": 0.18, "tail": "fan",
                    "leg": "bird", "wing": "feathered"},
        "owl":     {"bw": 0.36, "bh": 0.43, "hr": 0.36, "beak": 0.09, "ear": "tufts",  "ear_h": 0.18, "tail": "fan_s",
                    "leg": "bird", "wing": "feathered"},
        "bat":     {"bw": 0.26, "bh": 0.30, "hr": 0.26, "beak": 0.0,  "ear": "bat",    "ear_h": 0.30, "tail": "none",
                    "leg": "tiny", "wing": "bat"},
        "rabbit":  {"bw": 0.38, "bh": 0.40, "hr": 0.34, "beak": 0.0,  "ear": "long",   "ear_h": 0.40, "tail": "puff",
                    "leg": "strong", "wing": "none"},
        "frog":    {"bw": 0.42, "bh": 0.33, "hr": 0.36, "beak": 0.0,  "ear": "none",   "ear_h": 0.0,  "tail": "none",
                    "leg": "strong", "wing": "none"},
        "penguin": {"bw": 0.35, "bh": 0.45, "hr": 0.30, "beak": 0.12, "ear": "none",   "ear_h": 0.0,  "tail": "stub",
                    "leg": "waddle", "wing": "flipper"},
        "raccoon": {"bw": 0.40, "bh": 0.40, "hr": 0.34, "beak": 0.0,  "ear": "round",  "ear_h": 0.14, "tail": "striped",
                    "leg": "strong", "wing": "none", "mask": True},
    }
    c = configs[animal]

    bw = c["bw"] * S * mood["body_round"]
    bh = c["bh"] * S
    hr = c["hr"] * S * mood["head_s"]
    bd = bw * 0.85
    leg_h = 0.25 * S
    body_z = leg_h + bh * 0.5
    head_z = body_z + bh * 0.4 + hr * 0.65

    # Body
    body = sp("Body", (0, 0, body_z), max(bw, bh) * 0.5, mat_body)
    body.scale = (bw / max(bw, bh), bd / max(bw, bh), bh / max(bw, bh))

    # Belly
    belly = sp("Belly", (0, -bd * 0.2, body_z - bh * 0.05), max(bw, bh) * 0.4, mat_belly)
    belly.scale = (0.75, 0.6, 0.7)

    # Penguin belly is very prominent
    if animal == "penguin":
        belly.scale = (0.85, 0.7, 0.85)

    # Raccoon face mask
    if c.get("mask"):
        hy = -bd * 0.15 - hr * 0.55
        for i, side in enumerate([-1, 1]):
            mask = sp(f"Mask_{i}", (side * hr * 0.32, hy, head_z + hr * 0.05), hr * 0.2, mat_dark)
            mask.scale = (1.2, 0.5, 0.8)

    # Head
    head = sp("Head", (0, -bd * 0.15, head_z), hr, mat_body)

    # Eyes
    eye_s = hr * 0.35 * mood["eye_s"]
    eye_z = head_z + hr * 0.1
    eye_y = -bd * 0.15 - hr * 0.6
    eye_x = hr * 0.38
    if animal == "frog":
        eye_z = head_z + hr * 0.6; eye_y = -bd * 0.15 - hr * 0.35; eye_s *= 1.2
    if animal == "owl":
        eye_s *= 1.3
    make_eye("LE", (-eye_x, eye_y, eye_z), eye_s)
    make_eye("RE", (eye_x, eye_y, eye_z), eye_s)
    make_brows([(-eye_x, eye_y, eye_z, eye_s), (eye_x, eye_y, eye_z, eye_s)], eye_s * 0.4, mood["brow"])

    # Beak / mouth
    hy = -bd * 0.15
    if c["beak"] > 0:
        bl = c["beak"] * S
        cn("BeakUp", (0, hy - hr * 0.7, head_z - hr * 0.15), 0.08 * S, bl, mat_acc).rotation_euler = (math.radians(80), 0, 0)
        cn("BeakLo", (0, hy - hr * 0.75, head_z - hr * 0.28), 0.05 * S, bl * 0.6, mat_sec).rotation_euler = (math.radians(95), 0, 0)
    else:
        make_mouth((0, hy - hr * 0.55, head_z - hr * 0.3), hr * 0.3, mood["mouth"])
        if animal not in ("frog",):
            sp("Nose", (0, hy - hr * 0.65, head_z - hr * 0.12), hr * 0.08, mat_dark)

    # Ears
    ehs = c["ear_h"] * S
    if c["ear"] == "crest":
        for j in range(3):
            cn(f"Crest_{j}", (0, hy + 0.02 * j, head_z + hr * 0.7 + j * 0.06 * S),
               0.04 * S, ehs * (1 - j * 0.2), mat_acc).rotation_euler = (math.radians(-15 + j * 10), 0, 0)
    elif c["ear"] == "tufts":
        for i, side in enumerate([-1, 1]):
            cn(f"Tuft_{i}", (side * hr * 0.4, hy, head_z + hr * 0.75),
               0.06 * S, ehs, mat_sec).rotation_euler = (0, math.radians(12 * side), 0)
    elif c["ear"] == "bat":
        for i, side in enumerate([-1, 1]):
            cn(f"Ear_{i}", (side * hr * 0.55, hy, head_z + hr * 0.75),
               ehs * 0.5, ehs * 1.4, mat_body).rotation_euler = (0, math.radians(20 * side), 0)
            cn(f"EarIn_{i}", (side * hr * 0.55, hy - 0.025, head_z + hr * 0.75),
               ehs * 0.32, ehs * 1.1, mat_sec).rotation_euler = (0, math.radians(20 * side), 0)
    elif c["ear"] == "long":
        for i, side in enumerate([-1, 1]):
            ex = side * hr * 0.35
            ear = cy(f"Ear_{i}", (ex, hy, head_z + hr + ehs * 0.6), ehs * 0.18, ehs * 1.2, mat_body)
            ear.rotation_euler = (0, math.radians(8 * side), 0); add_ss(ear, 1)
            inner = cy(f"EarIn_{i}", (ex, hy - 0.025, head_z + hr + ehs * 0.6), ehs * 0.11, ehs * 1.0, mat_sec)
            add_ss(inner, 1)
    elif c["ear"] == "round":
        for i, side in enumerate([-1, 1]):
            ex = side * hr * 0.55
            sp(f"Ear_{i}", (ex, hy, head_z + hr * 0.7 + ehs * 0.2), ehs * 0.5, mat_body)
            sp(f"EarIn_{i}", (ex, hy - 0.02, head_z + hr * 0.7 + ehs * 0.2), ehs * 0.35, mat_sec)

    # Legs
    if c["leg"] == "bird":
        for i, side in enumerate([-1, 1]):
            lx = side * bw * 0.3
            cy(f"Leg_{i}", (lx, 0, leg_h * 0.45), 0.03 * S, leg_h * 0.9, mat_sec)
            foot = sp(f"Foot_{i}", (lx, -0.05 * S, 0), 0.06 * S, mat_sec)
            foot.scale = (1.0, 1.8, 0.35)
    elif c["leg"] == "strong":
        for i, side in enumerate([-1, 1]):
            lx = side * bw * 0.35
            sp(f"Thigh_{i}", (lx, 0.02 * S, body_z - bh * 0.35), 0.1 * S * mood["limb_thick"], mat_body).scale = (1.0, 0.9, 1.3)
            shin = cy(f"Shin_{i}", (lx, -0.02 * S, leg_h * 0.4), 0.06 * S * mood["limb_thick"], leg_h * 0.8, mat_body)
            add_ss(shin, 1)
            sp(f"Foot_{i}", (lx, -0.04 * S, 0), 0.09 * S, mat_sec).scale = (1.2, 1.5, 0.45)
    elif c["leg"] == "tiny":
        for i, side in enumerate([-1, 1]):
            sp(f"Leg_{i}", (side * bw * 0.25, 0, body_z - bh * 0.35), 0.05 * S, mat_body)
    elif c["leg"] == "waddle":
        for i, side in enumerate([-1, 1]):
            lx = side * bw * 0.3
            leg = cy(f"Leg_{i}", (lx, 0, leg_h * 0.35), 0.05 * S, leg_h * 0.7, mat_sec)
            add_ss(leg, 1)
            foot = sp(f"Foot_{i}", (lx, -0.06 * S, 0), 0.07 * S, mat_sec)
            foot.scale = (1.2, 1.8, 0.4)

    # Wings
    if c["wing"] == "feathered":
        for i, side in enumerate([-1, 1]):
            wx = side * bw * 0.55
            wing = cn(f"Wing_{i}", (wx, 0, body_z + bh * 0.1), 0.15 * S, 0.45 * S, mat_sec)
            wing.rotation_euler = (math.radians(10), 0, math.radians(50 * side)); add_ss(wing, 1)
            cn(f"WTip_{i}", (wx + side * 0.25 * S, 0, body_z + bh * 0.1 + 0.08 * S),
               0.08 * S, 0.25 * S, mat_acc).rotation_euler = (math.radians(5), 0, math.radians(60 * side))
    elif c["wing"] == "bat":
        for i, side in enumerate([-1, 1]):
            wx = side * bw * 0.45; wz = body_z + bh * 0.15
            mem = cn(f"Wing_{i}", (wx + side * 0.15 * S, 0, wz), 0.25 * S, 0.04 * S, mat_sec)
            mem.rotation_euler = (0, math.radians(80), math.radians(25 * side)); mem.scale = (2.0, 0.3, 1.2)
            cy(f"WArm_{i}", (wx, 0, wz + 0.05 * S), 0.02 * S, 0.35 * S, mat_dark).rotation_euler = (0, 0, math.radians(55 * side))
    elif c["wing"] == "flipper":
        for i, side in enumerate([-1, 1]):
            wx = side * bw * 0.48
            flip = sp(f"Flip_{i}", (wx, 0, body_z + bh * 0.1), 0.08 * S, mat_sec)
            flip.scale = (0.4, 0.3, 1.5)
            flip.rotation_euler = (0, 0, math.radians(30 * side))
    elif c["wing"] == "none":
        if animal in ("rabbit", "frog", "raccoon"):
            for i, side in enumerate([-1, 1]):
                ax = side * bw * 0.5; az = body_z + bh * 0.1
                arm = cy(f"Arm_{i}", (ax, -bd * 0.1, az), 0.05 * S * mood["limb_thick"], 0.2 * S, mat_body)
                arm.rotation_euler = (math.radians(10), math.radians(25 * side), 0); add_ss(arm, 1)
                sp(f"Hand_{i}", (ax + side * 0.08 * S, -bd * 0.15, az - 0.1 * S), 0.055 * S, mat_sec)

    # Tail
    if c["tail"] == "fan":
        for j in range(5):
            angle = (j - 2) * 18
            cn(f"TailF_{j}", (math.sin(math.radians(angle)) * 0.1 * S, bd * 0.4, body_z + 0.05 * S),
               0.04 * S, 0.2 * S, mat_acc if j % 2 == 0 else mat_sec).rotation_euler = (math.radians(-25), math.radians(angle * 0.3), 0)
    elif c["tail"] == "fan_s":
        for j in range(3):
            cn(f"TailF_{j}", (0, bd * 0.4, body_z), 0.03 * S, 0.12 * S, mat_sec).rotation_euler = (math.radians(-20), 0, 0)
    elif c["tail"] == "puff":
        sp("Tail", (0, bd * 0.45, body_z - bh * 0.15), 0.1 * S, mat_acc)
    elif c["tail"] == "stub":
        sp("Tail", (0, bd * 0.4, body_z - bh * 0.1), 0.06 * S, mat_sec)
    elif c["tail"] == "striped":
        for j in range(6):
            t = j / 5.0
            sp(f"Tail_{j}", (0, bd * 0.4 + t * 0.35 * S, body_z - t * 0.1 * S),
               (0.07 - t * 0.005) * S, mat_body if j % 2 == 0 else mat_sec)

    return head_z, body_z, bw


# =========================================
# AQUATICS: fish, shark, snake
# =========================================
def build_aquatic(animal):
    configs = {
        "fish":  {"bw": 0.28, "bl": 0.52, "bh": 0.33, "hr": 0.28, "fin": "pectoral", "tail": "fan"},
        "shark": {"bw": 0.30, "bl": 0.65, "bh": 0.30, "hr": 0.30, "fin": "dorsal",   "tail": "shark"},
        "snake": {"bw": 0.18, "bl": 0.14, "bh": 0.18, "hr": 0.24, "fin": "none",     "tail": "coil"},
    }
    c = configs[animal]
    bw, bl, bh = c["bw"] * S, c["bl"] * S, c["bh"] * S
    hr = c["hr"] * S * mood["head_s"]
    base_z = bh * 0.6 + 0.05 * S

    if animal == "snake":
        body_z = base_z + 0.3 * S
        head_z = body_z + 0.35 * S + hr * 0.6
        for j in range(6):
            t = j / 5.0
            sp(f"Coil_{j}", (math.sin(t * math.pi * 2) * 0.12 * S,
                             math.cos(t * math.pi * 2) * 0.08 * S,
                             base_z + t * 0.35 * S),
               (0.12 - t * 0.015) * S * mood["body_round"],
               mat_body if j % 2 == 0 else mat_sec)
        for j in range(4):
            t = j / 3.0
            sp(f"Tail_{j}", (0, 0.1 * S + t * 0.15 * S, base_z - 0.05 * S - t * 0.08 * S),
               (0.1 - t * 0.02) * S, mat_body)
    else:
        body_z = base_z; head_z = body_z + hr * 0.3
        body = sp("Body", (0, 0, body_z), max(bw, bl, bh) * 0.5, mat_body)
        body.scale = (bw / max(bw, bl, bh) * mood["body_round"], bl / max(bw, bl, bh),
                      bh / max(bw, bl, bh) * mood["body_round"])
        belly = sp("Belly", (0, -bl * 0.1, body_z - bh * 0.15), max(bw, bl) * 0.4, mat_belly)
        belly.scale = (0.7, 0.8, 0.5)

    # Head
    hy = -bl * 0.4 if animal != "snake" else 0
    head = sp("Head", (0, hy, head_z), hr, mat_body)

    # Eyes
    eye_s = hr * 0.35 * mood["eye_s"]
    if animal == "snake": eye_s *= 0.85
    eye_z = head_z + hr * 0.1
    ey = hy - hr * 0.55 if animal != "snake" else -hr * 0.55
    ex = hr * 0.4
    make_eye("LE", (-ex, ey, eye_z), eye_s)
    make_eye("RE", (ex, ey, eye_z), eye_s)
    make_brows([(-ex, ey, eye_z, eye_s), (ex, ey, eye_z, eye_s)], eye_s * 0.4, mood["brow"])

    # Mouth
    if animal == "shark":
        m = sp("Mouth", (0, hy - hr * 0.65, head_z - hr * 0.3), hr * 0.25, mat_mouth)
        m.scale = (2.5, 0.5, 0.4)
        for t in range(5):
            cn(f"Tooth_{t}", ((t - 2) * hr * 0.18, hy - hr * 0.72, head_z - hr * 0.22),
               0.02 * S, 0.06 * S, mat_eye_w).rotation_euler = (math.radians(180), 0, 0)
    elif animal == "snake":
        make_mouth((0, -hr * 0.6, head_z - hr * 0.25), hr * 0.2, mood["mouth"])
        cy("Tongue", (0, -hr * 0.85, head_z - hr * 0.27), 0.01 * S, 0.12 * S, mat_mouth).rotation_euler = (math.radians(85), 0, 0)
        # Hood
        for i, side in enumerate([-1, 1]):
            h = sp(f"Hood_{i}", (side * hr * 0.55, 0, head_z - hr * 0.1), hr * 0.25, mat_acc)
            h.scale = (0.5, 0.8, 0.8)
    else:
        make_mouth((0, hy - hr * 0.6, head_z - hr * 0.25), hr * 0.2, mood["mouth"])

    # Fins
    if c["fin"] == "pectoral":
        for i, side in enumerate([-1, 1]):
            fin = cn(f"Fin_{i}", (side * bw * 0.55, 0, body_z), 0.12 * S, 0.04 * S, mat_sec)
            fin.rotation_euler = (0, math.radians(75), math.radians(30 * side)); fin.scale = (1.5, 0.3, 1)
    elif c["fin"] == "dorsal":
        cn("DFin", (0, 0, body_z + bh * 0.5), 0.04 * S, 0.2 * S, mat_acc)
        for i, side in enumerate([-1, 1]):
            fin = cn(f"PFin_{i}", (side * bw * 0.5, -bl * 0.1, body_z - bh * 0.1),
                     0.1 * S, 0.04 * S, mat_sec)
            fin.rotation_euler = (0, math.radians(70), math.radians(35 * side)); fin.scale = (1.3, 0.3, 1)

    # Tail
    if c["tail"] == "fan":
        for i, side in enumerate([-1, 1]):
            cn(f"TLobe_{i}", (0, bl * 0.45, body_z + side * 0.08 * S),
               0.12 * S, 0.04 * S, mat_acc).rotation_euler = (math.radians(90 + 15 * side), 0, 0)
    elif c["tail"] == "shark":
        cn("TTop", (0, bl * 0.5, body_z + 0.12 * S), 0.05 * S, 0.22 * S, mat_body).rotation_euler = (math.radians(-30), 0, 0)
        cn("TBot", (0, bl * 0.5, body_z - 0.05 * S), 0.04 * S, 0.12 * S, mat_body).rotation_euler = (math.radians(25), 0, 0)

    return head_z, body_z, bw


# =========================================
# DISPATCH BUILD
# =========================================
quadrupeds = ["fox", "cat", "dog", "wolf", "bear", "dragon", "turtle", "horse", "capybara", "badger", "deer"]
bipeds = ["bird", "owl", "bat", "rabbit", "frog", "penguin", "raccoon"]
aquatics = ["fish", "shark", "snake"]

if args.animal in quadrupeds:
    head_z, body_z, body_w = build_quadruped(args.animal)
elif args.animal in bipeds:
    head_z, body_z, body_w = build_biped(args.animal)
elif args.animal in aquatics:
    head_z, body_z, body_w = build_aquatic(args.animal)
else:
    print(f"Unknown animal: {args.animal}")
    sys.exit(1)

add_element_markings(head_z, body_z, body_w, args.elements)

# =========================================
# CAMERA
# =========================================
cam_height = (head_z + body_z) * 0.5 + 0.15 * S
cam_dist = 2.4 * S
bpy.ops.object.camera_add(location=(cam_dist * 0.25, -cam_dist * 0.92, cam_height + 0.12 * S))
cam = bpy.context.active_object
cam.name = "Camera"

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
# LIGHTING
# =========================================
bpy.ops.object.light_add(type='SUN', location=(3, -4, 5))
key = bpy.context.active_object
key.data.energy = 4.0
key.rotation_euler = (math.radians(45), math.radians(-20), math.radians(25))

bpy.ops.object.light_add(type='AREA', location=(-2.5, -1.5, 2))
fill = bpy.context.active_object
fill.data.energy = 40; fill.data.size = 3

bpy.ops.object.light_add(type='POINT', location=(0, 2.5, cam_height + 0.5))
rim = bpy.context.active_object
rim.data.energy = 80; rim.data.color = palette["accent"]

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

# Freestyle outlines
scene.render.use_freestyle = True
ls = scene.view_layers[0].freestyle_settings.linesets[0]
ls.select_silhouette = True; ls.select_border = True; ls.select_crease = True
ls.linestyle.thickness = 1.8

# World (dark bg, will be transparent in render)
world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes.get("Background")
if bg:
    bg.inputs["Color"].default_value = (0.02, 0.02, 0.03, 1)
    bg.inputs["Strength"].default_value = 0.2

# Render PNG
os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
scene.render.filepath = os.path.abspath(args.output)
bpy.ops.render.render(write_still=True)
print(f"✓ Rendered PNG: {args.output}")

# Export GLB — convert toon materials to Principled BSDF first
glb_output = os.path.splitext(os.path.abspath(args.output))[0] + '.glb'

for mat in bpy.data.materials:
    if not mat.use_nodes:
        continue
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    emission_node = diffuse_node = None
    for n in nodes:
        if n.type == 'EMISSION': emission_node = n
        elif n.type == 'BSDF_DIFFUSE': diffuse_node = n
    base_color = (0.5, 0.5, 0.5, 1)
    if diffuse_node:
        base_color = tuple(diffuse_node.inputs['Color'].default_value)
    elif emission_node:
        ec = tuple(emission_node.inputs['Color'].default_value)
        base_color = (*ec[:3], 1) if len(ec) == 3 else ec
    nodes.clear()
    output = nodes.new('ShaderNodeOutputMaterial'); output.location = (200, 0)
    bsdf = nodes.new('ShaderNodeBsdfPrincipled'); bsdf.location = (0, 0)
    bsdf.inputs['Base Color'].default_value = base_color
    bsdf.inputs['Roughness'].default_value = 0.8
    bsdf.inputs['Metallic'].default_value = 0.0
    links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

# Export only mesh objects (NO cameras, lights, empties)
bpy.ops.object.select_all(action='DESELECT')
for obj in bpy.data.objects:
    if obj.type == 'MESH':
        obj.select_set(True)
try:
    bpy.ops.export_scene.gltf(filepath=glb_output, use_selection=True, export_format='GLB', export_apply=True)
    print(f"✓ Exported GLB: {glb_output}")
except Exception as e:
    print(f"⚠ GLB export failed: {e}")

print(f"✓ Done: {args.animal} + {'+'.join(args.elements)}, {args.mood}/{args.size}")
