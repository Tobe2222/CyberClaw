#!/usr/bin/env python3
"""
Render a Pokémon-style companion creature directly in Blender.
Run with: blender --background --python render_companion.py -- --name Voltix --element cyber --output /tmp/voltix.png

All arguments after -- are passed to the script.
"""
import bpy
import sys
import math
import os

# Parse args after --
argv = sys.argv
if "--" in argv:
    argv = argv[argv.index("--") + 1:]
else:
    argv = []

import argparse
parser = argparse.ArgumentParser()
parser.add_argument("--name", default="Companion")
parser.add_argument("--element", default="cyber")
parser.add_argument("--body", default="round")
parser.add_argument("--output", default="/tmp/companion.png")
parser.add_argument("--size", type=int, default=256)
args = parser.parse_args(argv)

PALETTES = {
    "cyber":    {"primary": (0, 0.83, 1, 1), "secondary": (0, 0.53, 0.67, 1), "accent": (1, 0.42, 0.21, 1)},
    "fire":     {"primary": (1, 0.42, 0.21, 1), "secondary": (0.8, 0.27, 0, 1), "accent": (1, 0.67, 0, 1)},
    "electric": {"primary": (1, 0.87, 0, 1), "secondary": (0.8, 0.67, 0, 1), "accent": (1, 0.42, 0.21, 1)},
    "nature":   {"primary": (0.29, 0.87, 0.5, 1), "secondary": (0.13, 0.67, 0.27, 1), "accent": (0.53, 1, 0.53, 1)},
    "shadow":   {"primary": (0.6, 0.4, 1, 1), "secondary": (0.4, 0.2, 0.8, 1), "accent": (1, 0.4, 1, 1)},
    "ice":      {"primary": (0.53, 0.87, 1, 1), "secondary": (0.27, 0.6, 0.8, 1), "accent": (1, 1, 1, 1)},
    "steel":    {"primary": (0.67, 0.73, 0.8, 1), "secondary": (0.47, 0.53, 0.6, 1), "accent": (1, 0.42, 0.21, 1)},
    "toxic":    {"primary": (0.4, 1, 0.4, 1), "secondary": (0.2, 0.8, 0.2, 1), "accent": (1, 1, 0, 1)},
}

palette = PALETTES.get(args.element, PALETTES["cyber"])

def clear_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete()
    for mat in bpy.data.materials:
        bpy.data.materials.remove(mat)

def make_material(name, color, metallic=0.2, roughness=0.5, emission=0):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = color
        bsdf.inputs["Metallic"].default_value = metallic
        bsdf.inputs["Roughness"].default_value = roughness
        if emission > 0:
            bsdf.inputs["Emission Color"].default_value = color
            bsdf.inputs["Emission Strength"].default_value = emission
    return mat

def add_obj(mesh_func, name, location, scale=(1,1,1), material=None):
    mesh_func(location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = scale
    if material:
        obj.data.materials.append(material)
    return obj

print(f"Generating: {args.name} ({args.element}/{args.body})")

# Clear
clear_scene()

# Materials
mat_body = make_material("Body", palette["primary"], metallic=0.15, roughness=0.45)
mat_secondary = make_material("Secondary", palette["secondary"], metallic=0.1, roughness=0.55)
mat_accent = make_material("Accent", palette["accent"], metallic=0.3, roughness=0.3, emission=0.3)
mat_eye_white = make_material("EyeWhite", (1, 1, 1, 1), metallic=0, roughness=0.2)
mat_pupil = make_material("Pupil", (0.02, 0.02, 0.02, 1), metallic=0, roughness=0.1)

# === Body ===
body_configs = {
    "round":   (bpy.ops.mesh.primitive_uv_sphere_add, (1.0, 1.0, 0.85)),
    "angular": (bpy.ops.mesh.primitive_cube_add, (0.75, 0.75, 0.85)),
    "slim":    (bpy.ops.mesh.primitive_cylinder_add, (0.55, 0.55, 1.1)),
    "bulky":   (bpy.ops.mesh.primitive_uv_sphere_add, (1.2, 1.05, 0.95)),
}
body_func, body_scale = body_configs.get(args.body, body_configs["round"])
body = add_obj(body_func, "Body", (0, 0, 0.8), body_scale, mat_body)

# Smooth body
bpy.ops.object.shade_smooth()
mod = body.modifiers.new("Subsurf", 'SUBSURF')
mod.levels = 2
mod.render_levels = 2

# === Head ===
head = add_obj(bpy.ops.mesh.primitive_uv_sphere_add, "Head", (0, 0, 1.8), (0.7, 0.7, 0.65), mat_body)
bpy.ops.object.shade_smooth()
mod = head.modifiers.new("Subsurf", 'SUBSURF')
mod.levels = 2

# === Eyes ===
for i, x in enumerate([-0.22, 0.22]):
    eye = add_obj(bpy.ops.mesh.primitive_uv_sphere_add, f"Eye_{i}", (x, -0.5, 1.9), (0.14, 0.12, 0.13), mat_eye_white)
    bpy.ops.object.shade_smooth()
    pupil = add_obj(bpy.ops.mesh.primitive_uv_sphere_add, f"Pupil_{i}", (x, -0.58, 1.9), (0.07, 0.06, 0.07), mat_pupil)
    bpy.ops.object.shade_smooth()

# === Mouth (subtle) ===
mouth = add_obj(bpy.ops.mesh.primitive_uv_sphere_add, "Mouth", (0, -0.52, 1.72), (0.12, 0.06, 0.04), mat_accent)
bpy.ops.object.shade_smooth()

# === Ears / Horns ===
if args.element in ["electric", "fire", "toxic"]:
    for i, x in enumerate([-0.35, 0.35]):
        ear = add_obj(bpy.ops.mesh.primitive_cone_add, f"Ear_{i}", (x, 0, 2.35), (0.18, 0.18, 0.35), mat_accent)
        ear.rotation_euler = (0, math.radians(12 * (-1 if x < 0 else 1)), 0)
        bpy.ops.object.shade_smooth()
elif args.element in ["shadow", "steel", "ice"]:
    for i, x in enumerate([-0.3, 0.3]):
        horn = add_obj(bpy.ops.mesh.primitive_cone_add, f"Horn_{i}", (x, 0, 2.4), (0.1, 0.1, 0.45), mat_accent)
        horn.rotation_euler = (0, math.radians(15 * (-1 if x < 0 else 1)), 0)
        bpy.ops.object.shade_smooth()
else:
    for i, x in enumerate([-0.4, 0.4]):
        ear = add_obj(bpy.ops.mesh.primitive_uv_sphere_add, f"Ear_{i}", (x, 0, 2.2), (0.18, 0.15, 0.18), mat_body)
        bpy.ops.object.shade_smooth()

# === Tail ===
if args.element in ["fire", "electric"]:
    tail = add_obj(bpy.ops.mesh.primitive_cone_add, "Tail", (0, 0.9, 0.9), (0.15, 0.15, 0.5), mat_accent)
    tail.rotation_euler = (math.radians(-45), 0, 0)
else:
    tail = add_obj(bpy.ops.mesh.primitive_uv_sphere_add, "Tail", (0, 0.85, 0.7), (0.2, 0.35, 0.2), mat_secondary)
bpy.ops.object.shade_smooth()

# === Feet ===
for i, (x, y) in enumerate([(-0.35, -0.15), (0.35, -0.15), (-0.35, 0.15), (0.35, 0.15)]):
    foot = add_obj(bpy.ops.mesh.primitive_uv_sphere_add, f"Foot_{i}", (x, y, -0.1), (0.18, 0.22, 0.12), mat_secondary)
    bpy.ops.object.shade_smooth()

# === Arms (small) ===
for i, x in enumerate([-0.75, 0.75]):
    arm = add_obj(bpy.ops.mesh.primitive_uv_sphere_add, f"Arm_{i}", (x, 0, 0.9), (0.15, 0.12, 0.2), mat_body)
    bpy.ops.object.shade_smooth()

# === Camera ===
# Camera — front view, slightly above, looking at face
bpy.ops.object.camera_add(location=(0, -4.0, 2.0))
cam = bpy.context.active_object
cam.name = "Camera"
# Track to the head
constraint = cam.constraints.new('TRACK_TO')
constraint.target = bpy.data.objects["Head"]
constraint.track_axis = 'TRACK_NEGATIVE_Z'
constraint.up_axis = 'UP_Y'
bpy.context.scene.camera = cam
cam.data.lens = 65

# === Lighting ===
# Key light
bpy.ops.object.light_add(type='SUN', location=(4, -3, 6))
sun = bpy.context.active_object
sun.name = "KeyLight"
sun.data.energy = 3.5

# Fill light (softer)
bpy.ops.object.light_add(type='AREA', location=(-3, -2, 3))
fill = bpy.context.active_object
fill.name = "FillLight"
fill.data.energy = 80
fill.data.size = 3

# Rim/accent light (colored)
bpy.ops.object.light_add(type='POINT', location=(0, 3.5, 2.5))
rim = bpy.context.active_object
rim.name = "RimLight"
rim.data.energy = 120
rim.data.color = palette["primary"][:3]

# === Render Settings ===
scene = bpy.context.scene
try:
    scene.render.engine = 'BLENDER_EEVEE_NEXT'
except:
    scene.render.engine = 'BLENDER_EEVEE'
scene.render.resolution_x = args.size
scene.render.resolution_y = args.size
scene.render.film_transparent = True
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'

# EEVEE settings
scene.eevee.taa_render_samples = 64

# World background (dark, subtle)
world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes.get("Background")
if bg:
    bg.inputs["Color"].default_value = (0.01, 0.01, 0.02, 1)
    bg.inputs["Strength"].default_value = 0.5

# === Render ===
scene.render.filepath = args.output
bpy.ops.render.render(write_still=True)
print(f"✓ Rendered: {args.output}")
