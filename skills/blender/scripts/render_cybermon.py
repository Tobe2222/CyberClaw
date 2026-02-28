#!/usr/bin/env python3
"""
Render a Cybermon — Pokémon-style creature based on real animals + element combos.
Run: blender --background --python render_cybermon.py -- --animal fox --elements fire shadow --mood cute --output /tmp/cybermon.png

Animals: fox, cat, dog, bird, fish, snake, turtle, rabbit, dragon, wolf, frog, owl, bat, bear, shark
Elements: fire, water, electric, nature, shadow, ice, steel, toxic, cyber
Moods: cute, fierce, chill, angry, playful
Sizes: small, medium, large
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
    "fire":     {"primary": (0.95, 0.25, 0.05), "secondary": (1.0, 0.6, 0.0), "glow": (1.0, 0.4, 0.0), "emissive": 0.5},
    "water":    {"primary": (0.1, 0.4, 0.9), "secondary": (0.3, 0.7, 1.0), "glow": (0.2, 0.5, 1.0), "emissive": 0.3},
    "electric": {"primary": (1.0, 0.85, 0.0), "secondary": (1.0, 1.0, 0.5), "glow": (1.0, 0.9, 0.2), "emissive": 0.6},
    "nature":   {"primary": (0.2, 0.7, 0.2), "secondary": (0.5, 0.9, 0.3), "glow": (0.3, 0.8, 0.2), "emissive": 0.2},
    "shadow":   {"primary": (0.15, 0.05, 0.2), "secondary": (0.4, 0.1, 0.5), "glow": (0.5, 0.2, 0.8), "emissive": 0.4},
    "ice":      {"primary": (0.6, 0.85, 1.0), "secondary": (0.85, 0.95, 1.0), "glow": (0.5, 0.8, 1.0), "emissive": 0.3},
    "steel":    {"primary": (0.55, 0.58, 0.62), "secondary": (0.75, 0.78, 0.82), "glow": (0.8, 0.85, 0.9), "emissive": 0.1},
    "toxic":    {"primary": (0.3, 0.8, 0.1), "secondary": (0.6, 1.0, 0.2), "glow": (0.4, 1.0, 0.3), "emissive": 0.5},
    "cyber":    {"primary": (0.0, 0.75, 0.9), "secondary": (0.0, 1.0, 1.0), "glow": (0.0, 0.85, 1.0), "emissive": 0.4},
}

# Mix element colors for dual types
def mix_palette(elements):
    palettes = [ELEMENT_COLORS.get(e, ELEMENT_COLORS["cyber"]) for e in elements]
    if len(palettes) == 1:
        return palettes[0]
    p1, p2 = palettes[0], palettes[1]
    return {
        "primary": tuple((a+b)/2 for a,b in zip(p1["primary"], p2["primary"])),
        "secondary": p2["secondary"],  # secondary element accent
        "glow": p2["glow"],
        "emissive": max(p1["emissive"], p2["emissive"]),
    }

palette = mix_palette(args.elements)

# =========================================
# ANIMAL BODY PLANS
# =========================================
ANIMALS = {
    "fox": {
        "body_shape": "quadruped",
        "body_proportions": {"torso": (0.7, 0.45, 0.4), "head": 0.4, "head_y": 0.0},
        "ears": "pointed_tall", "ear_size": 0.3,
        "tail": "fluffy_long",
        "legs": "slim", "leg_count": 4,
        "snout": "medium",
        "eye_size": 0.1, "eye_style": "almond",
    },
    "cat": {
        "body_shape": "quadruped",
        "body_proportions": {"torso": (0.55, 0.38, 0.35), "head": 0.38, "head_y": 0.0},
        "ears": "pointed", "ear_size": 0.22,
        "tail": "long_thin",
        "legs": "slim", "leg_count": 4,
        "snout": "small",
        "eye_size": 0.12, "eye_style": "round_big",
    },
    "dog": {
        "body_shape": "quadruped",
        "body_proportions": {"torso": (0.7, 0.45, 0.42), "head": 0.4, "head_y": 0.0},
        "ears": "floppy", "ear_size": 0.25,
        "tail": "medium_up",
        "legs": "sturdy", "leg_count": 4,
        "snout": "long",
        "eye_size": 0.1, "eye_style": "round",
    },
    "bird": {
        "body_shape": "biped",
        "body_proportions": {"torso": (0.4, 0.35, 0.45), "head": 0.3, "head_y": 0.0},
        "ears": "none", "ear_size": 0,
        "tail": "fan",
        "legs": "thin_bird", "leg_count": 2,
        "snout": "beak",
        "eye_size": 0.09, "eye_style": "round",
        "wings": True,
    },
    "fish": {
        "body_shape": "fish",
        "body_proportions": {"torso": (0.35, 0.7, 0.45), "head": 0.35, "head_y": 0.0},
        "ears": "fins", "ear_size": 0.25,
        "tail": "fin_tail",
        "legs": "none", "leg_count": 0,
        "snout": "none",
        "eye_size": 0.12, "eye_style": "round_big",
    },
    "snake": {
        "body_shape": "serpent",
        "body_proportions": {"torso": (0.25, 0.25, 0.8), "head": 0.28, "head_y": 0.0},
        "ears": "none", "ear_size": 0,
        "tail": "taper",
        "legs": "none", "leg_count": 0,
        "snout": "flat",
        "eye_size": 0.08, "eye_style": "slit",
    },
    "turtle": {
        "body_shape": "quadruped",
        "body_proportions": {"torso": (0.7, 0.6, 0.35), "head": 0.3, "head_y": 0.1},
        "ears": "none", "ear_size": 0,
        "tail": "stubby",
        "legs": "stubby", "leg_count": 4,
        "snout": "small",
        "eye_size": 0.08, "eye_style": "round",
        "shell": True,
    },
    "rabbit": {
        "body_shape": "biped_chubby",
        "body_proportions": {"torso": (0.45, 0.4, 0.4), "head": 0.38, "head_y": 0.0},
        "ears": "long_up", "ear_size": 0.45,
        "tail": "puff",
        "legs": "strong_back", "leg_count": 4,
        "snout": "tiny",
        "eye_size": 0.12, "eye_style": "round_big",
    },
    "dragon": {
        "body_shape": "quadruped",
        "body_proportions": {"torso": (0.8, 0.5, 0.5), "head": 0.42, "head_y": 0.0},
        "ears": "horns", "ear_size": 0.3,
        "tail": "long_thick",
        "legs": "sturdy", "leg_count": 4,
        "snout": "long",
        "eye_size": 0.1, "eye_style": "slit",
        "wings": True,
    },
    "wolf": {
        "body_shape": "quadruped",
        "body_proportions": {"torso": (0.75, 0.45, 0.45), "head": 0.4, "head_y": 0.0},
        "ears": "pointed", "ear_size": 0.22,
        "tail": "fluffy_down",
        "legs": "slim", "leg_count": 4,
        "snout": "long",
        "eye_size": 0.09, "eye_style": "almond",
    },
    "frog": {
        "body_shape": "biped_chubby",
        "body_proportions": {"torso": (0.5, 0.45, 0.3), "head": 0.4, "head_y": 0.05},
        "ears": "none", "ear_size": 0,
        "tail": "none",
        "legs": "strong_back", "leg_count": 4,
        "snout": "wide",
        "eye_size": 0.15, "eye_style": "bulge",
    },
    "owl": {
        "body_shape": "biped",
        "body_proportions": {"torso": (0.4, 0.38, 0.45), "head": 0.4, "head_y": 0.0},
        "ears": "tufts", "ear_size": 0.2,
        "tail": "fan_small",
        "legs": "thin_bird", "leg_count": 2,
        "snout": "beak_small",
        "eye_size": 0.16, "eye_style": "round_big",
        "wings": True,
    },
    "bat": {
        "body_shape": "biped",
        "body_proportions": {"torso": (0.3, 0.3, 0.35), "head": 0.3, "head_y": 0.0},
        "ears": "bat_ears", "ear_size": 0.35,
        "tail": "none",
        "legs": "tiny", "leg_count": 2,
        "snout": "small",
        "eye_size": 0.1, "eye_style": "round",
        "wings": True, "wing_style": "bat",
    },
    "bear": {
        "body_shape": "biped_chubby",
        "body_proportions": {"torso": (0.65, 0.55, 0.55), "head": 0.42, "head_y": 0.0},
        "ears": "round_small", "ear_size": 0.15,
        "tail": "stubby",
        "legs": "sturdy", "leg_count": 4,
        "snout": "medium",
        "eye_size": 0.08, "eye_style": "round",
    },
    "shark": {
        "body_shape": "fish",
        "body_proportions": {"torso": (0.4, 0.8, 0.4), "head": 0.35, "head_y": 0.0},
        "ears": "dorsal_fin", "ear_size": 0.35,
        "tail": "shark_tail",
        "legs": "none", "leg_count": 0,
        "snout": "pointed",
        "eye_size": 0.07, "eye_style": "slit",
    },
}

# Mood affects proportions
MOOD_MODS = {
    "cute":     {"head_scale": 1.3, "eye_scale": 1.4, "body_round": 1.15, "expression": "happy"},
    "fierce":   {"head_scale": 0.95, "eye_scale": 0.8, "body_round": 0.9, "expression": "angry"},
    "chill":    {"head_scale": 1.1, "eye_scale": 1.1, "body_round": 1.1, "expression": "sleepy"},
    "angry":    {"head_scale": 0.9, "eye_scale": 0.75, "body_round": 0.85, "expression": "angry"},
    "playful":  {"head_scale": 1.2, "eye_scale": 1.25, "body_round": 1.05, "expression": "happy"},
}

SIZE_SCALE = {"small": 0.7, "medium": 1.0, "large": 1.4}

animal = ANIMALS.get(args.animal, ANIMALS["fox"])
mood = MOOD_MODS.get(args.mood, MOOD_MODS["cute"])
scale = SIZE_SCALE[args.size]

# =========================================
# BLENDER HELPERS
# =========================================
def clear_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete()
    for c in [bpy.data.materials, bpy.data.meshes, bpy.data.curves]:
        for item in c:
            c.remove(item)

def make_mat(name, color, metallic=0.15, roughness=0.5, emission=0):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (*color, 1)
        bsdf.inputs["Metallic"].default_value = metallic
        bsdf.inputs["Roughness"].default_value = roughness
        if emission > 0:
            bsdf.inputs["Emission Color"].default_value = (*color, 1)
            bsdf.inputs["Emission Strength"].default_value = emission
    return mat

def add_sphere(name, loc, radius, mat=None):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=radius, location=loc, segments=24, ring_count=16)
    obj = bpy.context.active_object
    obj.name = name
    bpy.ops.object.shade_smooth()
    if mat:
        obj.data.materials.append(mat)
    return obj

def add_cube(name, loc, size, mat=None):
    bpy.ops.mesh.primitive_cube_add(size=size, location=loc)
    obj = bpy.context.active_object
    obj.name = name
    mod = obj.modifiers.new("Subsurf", 'SUBSURF')
    mod.levels = 2
    mod.render_levels = 2
    bpy.ops.object.shade_smooth()
    if mat:
        obj.data.materials.append(mat)
    return obj

def add_cone(name, loc, radius, depth, mat=None):
    bpy.ops.mesh.primitive_cone_add(radius1=radius, depth=depth, location=loc, vertices=16)
    obj = bpy.context.active_object
    obj.name = name
    bpy.ops.object.shade_smooth()
    if mat:
        obj.data.materials.append(mat)
    return obj

def add_cylinder(name, loc, radius, depth, mat=None):
    bpy.ops.mesh.primitive_cylinder_add(radius=radius, depth=depth, location=loc, vertices=16)
    obj = bpy.context.active_object
    obj.name = name
    bpy.ops.object.shade_smooth()
    if mat:
        obj.data.materials.append(mat)
    return obj

# =========================================
# BUILD THE CYBERMON
# =========================================
print(f"=== Generating Cybermon: {args.animal} + {'+'.join(args.elements)} ({args.mood}/{args.size}) ===")

clear_scene()

# Materials
mat_primary = make_mat("Primary", palette["primary"], roughness=0.45)
mat_secondary = make_mat("Secondary", palette["secondary"], roughness=0.4)
mat_glow = make_mat("Glow", palette["glow"], emission=palette["emissive"], metallic=0.3, roughness=0.3)
mat_eye_white = make_mat("EyeWhite", (0.95, 0.95, 0.95), roughness=0.2)
mat_pupil = make_mat("Pupil", (0.02, 0.02, 0.02), roughness=0.1)
mat_dark = make_mat("Dark", (0.08, 0.06, 0.06), roughness=0.6)

# Body proportions
tp = animal["body_proportions"]
torso_w, torso_d, torso_h = [x * scale for x in tp["torso"]]
head_r = tp["head"] * scale * mood["head_scale"]
body_round = mood["body_round"]

# Adjust torso roundness
torso_w *= body_round
torso_d *= body_round

body_center_z = torso_h + 0.1 * scale
head_z = body_center_z + torso_h * 0.7 + head_r * 0.6

# === BODY (torso) ===
if animal["body_shape"] == "fish":
    # Elongated oval body
    body = add_sphere("Body", (0, 0, body_center_z), torso_d * 0.5, mat_primary)
    body.scale = (torso_w / torso_d, 1.0, torso_h / (torso_d * 0.5))
elif animal["body_shape"] == "serpent":
    # Coiled / upright snake body
    body = add_cylinder("Body", (0, 0, body_center_z), torso_w * 0.5, torso_h * 2, mat_primary)
    mod = body.modifiers.new("Subsurf", 'SUBSURF')
    mod.levels = 2
    # Add belly segment
    belly = add_sphere("Belly", (0, 0, body_center_z - torso_h * 0.3), torso_w * 0.55, mat_secondary)
else:
    body = add_sphere("Body", (0, 0, body_center_z), max(torso_w, torso_h) * 0.5, mat_primary)
    body.scale = (torso_w / max(torso_w, torso_h), torso_d / max(torso_w, torso_h), torso_h / max(torso_w, torso_h))
    mod = body.modifiers.new("Subsurf", 'SUBSURF')
    mod.levels = 2
    mod.render_levels = 2

# Belly/underside
if animal["body_shape"] not in ("serpent",):
    belly = add_sphere("Belly", (0, -torso_d * 0.15, body_center_z - torso_h * 0.15),
                       max(torso_w, torso_h) * 0.42 * body_round, mat_secondary)
    belly.scale = (0.85, 0.7, 0.75)

# === HEAD ===
head = add_sphere("Head", (0, -torso_d * 0.3 + animal["body_proportions"]["head_y"], head_z), head_r, mat_primary)
mod = head.modifiers.new("Subsurf", 'SUBSURF')
mod.levels = 2

# === SNOUT ===
snout_types = {
    "long":     (0.18, 0.25, 0.12),
    "medium":   (0.14, 0.18, 0.1),
    "small":    (0.1, 0.12, 0.08),
    "tiny":     (0.07, 0.08, 0.06),
    "flat":     (0.15, 0.08, 0.06),
    "wide":     (0.2, 0.12, 0.06),
    "beak":     (0.08, 0.2, 0.06),
    "beak_small": (0.06, 0.15, 0.05),
    "pointed":  (0.12, 0.22, 0.08),
    "none":     None,
}
snout_dims = snout_types.get(animal["snout"])
if snout_dims:
    sw, sd, sh = [x * scale for x in snout_dims]
    snout_y = -torso_d * 0.3 - head_r * 0.7 + animal["body_proportions"]["head_y"]
    if "beak" in animal["snout"]:
        snout = add_cone("Snout", (0, snout_y, head_z - head_r * 0.15), sw, sd, mat_secondary)
        snout.rotation_euler = (math.radians(90), 0, 0)
    else:
        snout = add_sphere("Snout", (0, snout_y, head_z - head_r * 0.2), max(sw, sd, sh), mat_secondary)
        snout.scale = (sw / max(sw, sd, sh), sd / max(sw, sd, sh), sh / max(sw, sd, sh))

# === EYES ===
eye_r = animal["eye_size"] * scale * mood["eye_scale"]
eye_z = head_z + head_r * 0.1
eye_y = -torso_d * 0.3 - head_r * 0.65 + animal["body_proportions"]["head_y"]

if animal["eye_style"] == "bulge":
    # Frog-style bulging eyes on top
    eye_z = head_z + head_r * 0.7
    eye_y = -torso_d * 0.3 - head_r * 0.3

for i, x in enumerate([-head_r * 0.5, head_r * 0.5]):
    eye = add_sphere(f"Eye_{i}", (x, eye_y, eye_z), eye_r, mat_eye_white)
    # Pupil
    pupil_r = eye_r * 0.5
    pupil = add_sphere(f"Pupil_{i}", (x, eye_y - eye_r * 0.4, eye_z), pupil_r, mat_pupil)
    # Iris (colored)
    iris = add_sphere(f"Iris_{i}", (x, eye_y - eye_r * 0.3, eye_z), pupil_r * 1.3, mat_glow)

# === EARS / HORNS / FINS ===
ear_s = animal["ear_size"] * scale
ear_type = animal["ears"]

if ear_type == "pointed_tall":
    for i, x in enumerate([-head_r * 0.55, head_r * 0.55]):
        ear = add_cone(f"Ear_{i}", (x, -torso_d * 0.2, head_z + head_r * 0.7), ear_s * 0.4, ear_s * 1.5, mat_primary)
        ear.rotation_euler = (0, math.radians(10 * (-1 if x < 0 else 1)), 0)
        # Inner ear
        inner = add_cone(f"EarInner_{i}", (x, -torso_d * 0.25, head_z + head_r * 0.7), ear_s * 0.25, ear_s * 1.2, mat_secondary)
        inner.rotation_euler = (0, math.radians(10 * (-1 if x < 0 else 1)), 0)

elif ear_type == "pointed":
    for i, x in enumerate([-head_r * 0.55, head_r * 0.55]):
        ear = add_cone(f"Ear_{i}", (x, -torso_d * 0.15, head_z + head_r * 0.65), ear_s * 0.35, ear_s * 1.0, mat_primary)
        ear.rotation_euler = (0, math.radians(12 * (-1 if x < 0 else 1)), 0)

elif ear_type == "floppy":
    for i, x in enumerate([-head_r * 0.7, head_r * 0.7]):
        ear = add_sphere(f"Ear_{i}", (x, -torso_d * 0.1, head_z + head_r * 0.2), ear_s, mat_primary)
        ear.scale = (0.35, 0.2, 1.0)
        ear.rotation_euler = (0, 0, math.radians(25 * (-1 if x < 0 else 1)))

elif ear_type == "long_up":
    for i, x in enumerate([-head_r * 0.35, head_r * 0.35]):
        ear = add_cylinder(f"Ear_{i}", (x, -torso_d * 0.1, head_z + head_r + ear_s * 0.7),
                          ear_s * 0.2, ear_s * 1.4, mat_primary)
        ear.rotation_euler = (0, math.radians(8 * (-1 if x < 0 else 1)), 0)
        # Inner ear
        inner = add_cylinder(f"EarInner_{i}", (x, -torso_d * 0.13, head_z + head_r + ear_s * 0.7),
                            ear_s * 0.12, ear_s * 1.2, mat_secondary)

elif ear_type == "horns":
    for i, x in enumerate([-head_r * 0.45, head_r * 0.45]):
        horn = add_cone(f"Horn_{i}", (x, -torso_d * 0.05, head_z + head_r * 0.7),
                       ear_s * 0.15, ear_s * 1.5, mat_glow)
        horn.rotation_euler = (math.radians(-15), math.radians(20 * (-1 if x < 0 else 1)), 0)

elif ear_type == "tufts":
    for i, x in enumerate([-head_r * 0.5, head_r * 0.5]):
        tuft = add_cone(f"Tuft_{i}", (x, -torso_d * 0.15, head_z + head_r * 0.75),
                       ear_s * 0.25, ear_s * 0.8, mat_secondary)
        tuft.rotation_euler = (0, math.radians(15 * (-1 if x < 0 else 1)), 0)

elif ear_type == "bat_ears":
    for i, x in enumerate([-head_r * 0.6, head_r * 0.6]):
        ear = add_cone(f"Ear_{i}", (x, -torso_d * 0.1, head_z + head_r * 0.8),
                      ear_s * 0.5, ear_s * 1.2, mat_primary)
        ear.rotation_euler = (0, math.radians(20 * (-1 if x < 0 else 1)), 0)
        inner = add_cone(f"EarInner_{i}", (x, -torso_d * 0.15, head_z + head_r * 0.8),
                        ear_s * 0.3, ear_s * 1.0, mat_secondary)
        inner.rotation_euler = (0, math.radians(20 * (-1 if x < 0 else 1)), 0)

elif ear_type == "round_small":
    for i, x in enumerate([-head_r * 0.6, head_r * 0.6]):
        ear = add_sphere(f"Ear_{i}", (x, -torso_d * 0.1, head_z + head_r * 0.6), ear_s, mat_primary)

elif ear_type == "fins":
    for i, x in enumerate([-torso_w * 0.5, torso_w * 0.5]):
        fin = add_cone(f"Fin_{i}", (x * 1.3, 0, body_center_z + torso_h * 0.2),
                      ear_s * 0.3, ear_s * 0.8, mat_secondary)
        fin.rotation_euler = (0, 0, math.radians(60 * (-1 if x < 0 else 1)))

elif ear_type == "dorsal_fin":
    fin = add_cone("DorsalFin", (0, 0, body_center_z + torso_h * 0.6),
                   ear_s * 0.15, ear_s * 1.0, mat_glow)

# === TAIL ===
tail_type = animal["tail"]
tail_base = (0, torso_d * 0.5, body_center_z)

if tail_type == "fluffy_long":
    for j in range(4):
        t = j / 3.0
        tz = body_center_z - t * 0.15 * scale
        ty = torso_d * 0.5 + t * 0.6 * scale
        r = (0.2 - t * 0.05) * scale
        seg = add_sphere(f"Tail_{j}", (0, ty, tz), r, mat_secondary if j < 2 else mat_glow)

elif tail_type == "long_thin":
    for j in range(5):
        t = j / 4.0
        ty = torso_d * 0.4 + t * 0.55 * scale
        tz = body_center_z + math.sin(t * math.pi) * 0.2 * scale
        r = (0.08 - t * 0.01) * scale
        seg = add_sphere(f"Tail_{j}", (0, ty, tz), r, mat_primary)

elif tail_type == "medium_up":
    tail = add_cone("Tail", (0, torso_d * 0.45, body_center_z + 0.15 * scale),
                    0.1 * scale, 0.35 * scale, mat_primary)
    tail.rotation_euler = (math.radians(-30), 0, 0)

elif tail_type == "fan" or tail_type == "fan_small":
    fan_s = 0.25 if tail_type == "fan" else 0.18
    for j in range(3):
        angle = (j - 1) * 25
        tx = math.sin(math.radians(angle)) * 0.1 * scale
        ty = torso_d * 0.4 + math.cos(math.radians(angle)) * 0.05 * scale
        feather = add_cone(f"TailFeather_{j}",
                          (tx, ty, body_center_z + 0.1 * scale),
                          fan_s * 0.3 * scale, fan_s * scale, mat_secondary)
        feather.rotation_euler = (math.radians(-20), math.radians(angle * 0.5), 0)

elif tail_type == "fin_tail":
    tail = add_cone("Tail", (0, torso_d * 0.6, body_center_z),
                    0.25 * scale, 0.1 * scale, mat_glow)
    tail.rotation_euler = (math.radians(90), 0, 0)
    tail.scale = (1, 0.3, 1.5)

elif tail_type == "shark_tail":
    top = add_cone("TailTop", (0, torso_d * 0.65, body_center_z + 0.15 * scale),
                   0.15 * scale, 0.3 * scale, mat_primary)
    top.rotation_euler = (math.radians(-30), 0, 0)
    bot = add_cone("TailBot", (0, torso_d * 0.65, body_center_z - 0.08 * scale),
                   0.1 * scale, 0.2 * scale, mat_primary)
    bot.rotation_euler = (math.radians(20), 0, 0)

elif tail_type == "taper":
    for j in range(5):
        t = j / 4.0
        ty = torso_d * 0.3 + t * 0.5 * scale
        tz = body_center_z - torso_h * 0.5 - t * 0.3 * scale
        r = (0.12 - t * 0.02) * scale
        seg = add_sphere(f"Tail_{j}", (0, ty, tz), r, mat_primary)

elif tail_type == "puff":
    tail = add_sphere("Tail", (0, torso_d * 0.5, body_center_z), 0.12 * scale, mat_secondary)

elif tail_type == "stubby":
    tail = add_sphere("Tail", (0, torso_d * 0.45, body_center_z - 0.05 * scale), 0.08 * scale, mat_secondary)

elif tail_type == "long_thick":
    for j in range(5):
        t = j / 4.0
        ty = torso_d * 0.45 + t * 0.7 * scale
        tz = body_center_z - t * 0.2 * scale
        r = (0.15 - t * 0.02) * scale
        seg = add_sphere(f"Tail_{j}", (0, ty, tz), r, mat_primary if j < 3 else mat_glow)

elif tail_type == "fluffy_down":
    for j in range(4):
        t = j / 3.0
        ty = torso_d * 0.45 + t * 0.35 * scale
        tz = body_center_z - t * 0.25 * scale
        r = (0.18 - t * 0.03) * scale
        seg = add_sphere(f"Tail_{j}", (0, ty, tz), r, mat_secondary)

# === LEGS ===
if animal["leg_count"] == 4:
    leg_r = 0.08 * scale
    leg_h = 0.2 * scale
    if animal["legs"] == "slim":
        positions = [(-torso_w * 0.35, -torso_d * 0.25, 0.05), (torso_w * 0.35, -torso_d * 0.25, 0.05),
                     (-torso_w * 0.35, torso_d * 0.2, 0.05), (torso_w * 0.35, torso_d * 0.2, 0.05)]
        for j, pos in enumerate(positions):
            leg = add_cylinder(f"Leg_{j}", pos, leg_r, leg_h * 2, mat_secondary)
            foot = add_sphere(f"Foot_{j}", (pos[0], pos[1], -0.05 * scale), leg_r * 1.3, mat_dark)
            foot.scale = (1, 1.3, 0.6)
    elif animal["legs"] == "sturdy":
        positions = [(-torso_w * 0.4, -torso_d * 0.25, 0.05), (torso_w * 0.4, -torso_d * 0.25, 0.05),
                     (-torso_w * 0.4, torso_d * 0.2, 0.05), (torso_w * 0.4, torso_d * 0.2, 0.05)]
        for j, pos in enumerate(positions):
            leg = add_cylinder(f"Leg_{j}", pos, leg_r * 1.5, leg_h * 1.8, mat_secondary)
            foot = add_sphere(f"Foot_{j}", (pos[0], pos[1], -0.05 * scale), leg_r * 1.8, mat_dark)
            foot.scale = (1, 1.2, 0.5)
    elif animal["legs"] == "stubby":
        positions = [(-torso_w * 0.4, -torso_d * 0.3, 0.02), (torso_w * 0.4, -torso_d * 0.3, 0.02),
                     (-torso_w * 0.4, torso_d * 0.25, 0.02), (torso_w * 0.4, torso_d * 0.25, 0.02)]
        for j, pos in enumerate(positions):
            leg = add_sphere(f"Leg_{j}", pos, leg_r * 1.5, mat_secondary)
            leg.scale = (1, 1.2, 0.7)
    elif animal["legs"] == "strong_back":
        # Bigger back legs
        front = [(-torso_w * 0.35, -torso_d * 0.25, 0.05), (torso_w * 0.35, -torso_d * 0.25, 0.05)]
        back = [(-torso_w * 0.4, torso_d * 0.15, 0.02), (torso_w * 0.4, torso_d * 0.15, 0.02)]
        for j, pos in enumerate(front):
            leg = add_cylinder(f"FrontLeg_{j}", pos, leg_r * 0.8, leg_h * 1.5, mat_secondary)
        for j, pos in enumerate(back):
            leg = add_cylinder(f"BackLeg_{j}", pos, leg_r * 1.5, leg_h * 2, mat_secondary)
            foot = add_sphere(f"BackFoot_{j}", (pos[0], pos[1] - 0.05 * scale, -0.05 * scale), leg_r * 1.8, mat_dark)
            foot.scale = (1.2, 1.5, 0.5)

elif animal["leg_count"] == 2:
    if animal["legs"] == "thin_bird":
        for j, x in enumerate([-torso_w * 0.25, torso_w * 0.25]):
            leg = add_cylinder(f"Leg_{j}", (x, 0, body_center_z - torso_h * 0.5 - 0.1 * scale),
                              0.03 * scale, 0.25 * scale, mat_secondary)
            # Bird feet (3 toes)
            foot = add_sphere(f"Foot_{j}", (x, -0.05 * scale, body_center_z - torso_h * 0.5 - 0.25 * scale),
                            0.06 * scale, mat_dark)
            foot.scale = (0.8, 1.5, 0.3)
    elif animal["legs"] == "tiny":
        for j, x in enumerate([-torso_w * 0.2, torso_w * 0.2]):
            leg = add_sphere(f"Leg_{j}", (x, 0, body_center_z - torso_h * 0.4),
                           0.05 * scale, mat_secondary)

# === WINGS (optional) ===
if animal.get("wings"):
    wing_style = animal.get("wing_style", "feathered")
    for i, side in enumerate([-1, 1]):
        x = side * torso_w * 0.65
        if wing_style == "bat":
            # Bat wings — flat triangular
            wing = add_cone(f"Wing_{i}", (x, 0, body_center_z + torso_h * 0.2),
                           0.4 * scale, 0.05 * scale, mat_secondary)
            wing.rotation_euler = (0, math.radians(90 * side), math.radians(20 * side))
            wing.scale = (1.5, 0.3, 1)
        else:
            # Feathered wings
            wing = add_cone(f"Wing_{i}", (x, 0.05 * scale, body_center_z + torso_h * 0.15),
                           0.1 * scale, 0.5 * scale, mat_secondary)
            wing.rotation_euler = (math.radians(15), 0, math.radians(50 * side))
            # Wing tip
            tip = add_cone(f"WingTip_{i}",
                          (x + side * 0.25 * scale, 0.05 * scale, body_center_z + torso_h * 0.3),
                          0.06 * scale, 0.3 * scale, mat_glow)
            tip.rotation_euler = (math.radians(10), 0, math.radians(60 * side))

# === SHELL (turtle) ===
if animal.get("shell"):
    shell = add_sphere("Shell", (0, torso_d * 0.1, body_center_z + torso_h * 0.15),
                       max(torso_w, torso_d) * 0.6, mat_glow)
    shell.scale = (1.1, 0.9, 0.7)

# === ELEMENT ACCENTS ===
# Add glowing markings based on element
el1 = args.elements[0]
if el1 == "fire":
    # Flame crest on head
    flame = add_cone("FlameCrest", (0, -torso_d * 0.15, head_z + head_r * 0.8),
                     0.08 * scale, 0.25 * scale, mat_glow)
elif el1 == "electric":
    # Lightning bolt cheek marks
    for i, x in enumerate([-head_r * 0.65, head_r * 0.65]):
        mark = add_cone(f"BoltMark_{i}", (x, eye_y + 0.02, eye_z - eye_r * 2),
                       0.04 * scale, 0.1 * scale, mat_glow)
        mark.rotation_euler = (math.radians(90), 0, math.radians(30 * (-1 if x < 0 else 1)))
elif el1 == "ice":
    # Crystal on forehead
    crystal = add_cone("IceCrystal", (0, eye_y + 0.03, head_z + head_r * 0.65),
                       0.06 * scale, 0.18 * scale, mat_glow)
elif el1 == "cyber":
    # Circuit lines (small spheres)
    for j in range(3):
        node = add_sphere(f"CircuitNode_{j}",
                         (0.08 * scale * (j - 1), -torso_d * 0.35, body_center_z + torso_h * 0.3),
                         0.025 * scale, mat_glow)
elif el1 == "shadow":
    # Dark aura wisps
    for j in range(3):
        angle = j * 120
        wx = math.sin(math.radians(angle)) * 0.3 * scale
        wy = math.cos(math.radians(angle)) * 0.3 * scale
        wisp = add_sphere(f"Wisp_{j}", (wx, wy, body_center_z + 0.3 * scale),
                         0.06 * scale, mat_glow)
elif el1 == "toxic":
    # Bubbles
    for j in range(4):
        bx = random.uniform(-0.15, 0.15) * scale
        by = random.uniform(-0.15, 0.15) * scale
        bz = body_center_z + random.uniform(0.2, 0.5) * scale
        bubble = add_sphere(f"Bubble_{j}", (bx, by, bz), random.uniform(0.03, 0.06) * scale, mat_glow)

# Second element accents
if len(args.elements) > 1:
    el2 = args.elements[1]
    if el2 == "steel":
        # Metallic armor plate on back
        plate = add_cube("ArmorPlate", (0, torso_d * 0.15, body_center_z + torso_h * 0.3),
                        0.3 * scale, mat_secondary)
        plate.scale = (1.2, 0.6, 0.4)
    elif el2 == "shadow":
        # Shadow mist at base
        mist = add_sphere("ShadowMist", (0, 0, 0.05 * scale), 0.5 * scale, mat_glow)
        mist.scale = (1.5, 1.5, 0.3)

# =========================================
# CAMERA & LIGHTING
# =========================================
# Camera — front 3/4 view
cam_dist = 2.5 * scale
bpy.ops.object.camera_add(location=(cam_dist * 0.5, -cam_dist, body_center_z + torso_h * 0.3))
cam = bpy.context.active_object
cam.name = "Camera"
# Point at body center
constraint = cam.constraints.new('TRACK_TO')
constraint.target = head
constraint.track_axis = 'TRACK_NEGATIVE_Z'
constraint.up_axis = 'UP_Y'
bpy.context.scene.camera = cam
cam.data.lens = 55

# Key light
bpy.ops.object.light_add(type='SUN', location=(4, -3, 6))
key = bpy.context.active_object
key.data.energy = 3.0

# Fill light
bpy.ops.object.light_add(type='AREA', location=(-3, -2, 3))
fill = bpy.context.active_object
fill.data.energy = 60
fill.data.size = 3

# Rim light (element colored)
bpy.ops.object.light_add(type='POINT', location=(0, 3, body_center_z + 1))
rim = bpy.context.active_object
rim.data.energy = 100
rim.data.color = palette["glow"]

# Bottom fill (subtle)
bpy.ops.object.light_add(type='AREA', location=(0, 0, -0.5))
bottom = bpy.context.active_object
bottom.data.energy = 20
bottom.data.size = 2
bottom.rotation_euler = (math.radians(180), 0, 0)

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

# World
world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes.get("Background")
if bg:
    bg.inputs["Color"].default_value = (0.01, 0.01, 0.02, 1)
    bg.inputs["Strength"].default_value = 0.3

# Render
os.makedirs(os.path.dirname(args.output) if os.path.dirname(args.output) else ".", exist_ok=True)
scene.render.filepath = args.output
bpy.ops.render.render(write_still=True)
print(f"✓ Rendered: {args.output} ({args.animal} + {'+'.join(args.elements)}, {args.mood}/{args.size})")
