# Flateable (Blender): draw a front and a side outline with Grease Pencil, inflate them into
# a quad base mesh to sculpt on, then draw patch borders on the sculpt and fill them with quads.
# Exploration build; see blender/README.md.

bl_info = {
    'name': 'Flateable',
    'author': 'Flateable Figures (exploration)',
    'version': (0, 1, 0),
    'blender': (4, 3, 0),
    'location': '3D View > Sidebar > Flateable',
    'description': 'Sketch to base mesh by inflation, and patch retopology from strokes drawn on a surface',
    'category': 'Mesh',
}

import math
import time

import bpy
import numpy as np
from mathutils import Quaternion

from . import bl_io as IO
from . import inflate as INF
from . import patches as PT

SKETCH = 'FF Sketch'
PATCH = 'FF Patch Strokes'
VIEW_ROT = {
    'FRONT': Quaternion((math.sqrt(0.5), math.sqrt(0.5), 0.0, 0.0)),
    'SIDE': Quaternion((0.5, 0.5, 0.5, 0.5)),
}


class FFProps(bpy.types.PropertyGroup):
    mirror_sketch: bpy.props.BoolProperty(name='Mirror front', default=True,
                                          description='Mirror the front outline across the centre line (draw one half)')
    detail_mm: bpy.props.FloatProperty(name='Detail (mm)', default=6.0, min=2.0, max=30.0,
                                       description='Grid size for the inflation; smaller is finer and slower')
    round_mm: bpy.props.FloatProperty(name='Edge rounding (mm)', default=20.0, min=0.0, max=100.0,
                                      description='How much the side profile is rounded where it clips the front balloon')
    quad_remesh: bpy.props.BoolProperty(name='Quad remesh', default=True, description='Run QuadriFlow for an all-quad base')
    target_faces: bpy.props.IntProperty(name='Faces', default=9000, min=500, max=200000)
    multires: bpy.props.BoolProperty(name='Add Multires', default=True, description='Add a Multiresolution modifier ready for sculpting')

    target: bpy.props.PointerProperty(name='Surface', type=bpy.types.Object,
                                      poll=lambda self, ob: ob.type == 'MESH',
                                      description='The sculpt the patch strokes are drawn on')
    edge_mm: bpy.props.FloatProperty(name='Edge length (mm)', default=30.0, min=3.0, max=300.0,
                                     description='Target length of retopology edges')
    mirror_patch: bpy.props.BoolProperty(name='Mirror X', default=True,
                                         description='Draw on the +X half; the centre line is added and the result mirrored')
    corner_deg: bpy.props.FloatProperty(name='Corner angle', default=150.0, min=90.0, max=175.0,
                                        description='A border that turns more sharply than this at a crossing makes a patch corner')
    relax: bpy.props.IntProperty(name='Relax', default=30, min=0, max=300)
    last_report: bpy.props.StringProperty(default='')


def props(context):
    return context.scene.ff_props


def view3d_region(context):
    area = context.area if context.area and context.area.type == 'VIEW_3D' else None
    if area is None:
        for a in context.screen.areas if context.screen else []:
            if a.type == 'VIEW_3D':
                area = a
                break
    return area.spaces.active.region_3d if area else None


# ---------------- sketch ----------------

class FF_OT_new_sketch(bpy.types.Operator):
    bl_idname = 'ff.new_sketch'
    bl_label = 'New Sketch'
    bl_description = 'Grease Pencil object with a Front layer (drawn on the XZ plane) and a Side layer (YZ plane)'
    bl_options = {'REGISTER', 'UNDO'}

    def execute(self, context):
        ob = IO.gp_object(SKETCH, ['Front', 'Side'])
        ob.location = (0, 0, 0)
        for name, loc, rot in (('FF Front Camera', (0, -8, 0.95), (math.pi / 2, 0, 0)),
                               ('FF Side Camera', (8, 0, 0.95), (math.pi / 2, 0, math.pi / 2))):
            cam = bpy.data.objects.get(name)
            if cam is None:
                cam = bpy.data.objects.new(name, bpy.data.cameras.new(name))
                context.scene.collection.objects.link(cam)
            cam.data.type = 'ORTHO'
            cam.data.ortho_scale = 2.4
            cam.location, cam.rotation_euler = loc, rot
        IO.activate(ob)
        self.report({'INFO'}, 'Sketch ready: draw the front on layer Front, the side on layer Side')
        return {'FINISHED'}


class FF_OT_draw_view(bpy.types.Operator):
    bl_idname = 'ff.draw_view'
    bl_label = 'Draw'
    bl_description = 'Look straight at the view, pick its layer and lock drawing to its plane'
    bl_options = {'REGISTER'}
    view: bpy.props.EnumProperty(items=[('FRONT', 'Front', ''), ('SIDE', 'Side', '')])

    def execute(self, context):
        ob = bpy.data.objects.get(SKETCH)
        if ob is None:
            bpy.ops.ff.new_sketch()
            ob = bpy.data.objects.get(SKETCH)
        if context.object and context.object.mode != 'OBJECT' and context.object != ob:
            bpy.ops.object.mode_set(mode='OBJECT')
        IO.activate(ob)
        layer = ob.data.layers.get('Front' if self.view == 'FRONT' else 'Side')
        if layer:
            ob.data.layers.active = layer
        ts = context.scene.tool_settings
        ts.gpencil_stroke_placement_view3d = 'ORIGIN'
        ts.gpencil_sculpt.lock_axis = 'AXIS_Y' if self.view == 'FRONT' else 'AXIS_X'
        rv = view3d_region(context)
        if rv:
            rv.view_rotation = VIEW_ROT[self.view]
            rv.view_perspective = 'ORTHO'
        if ob.mode != 'PAINT_GREASE_PENCIL':
            bpy.ops.object.mode_set(mode='PAINT_GREASE_PENCIL')
        return {'FINISHED'}


class FF_OT_inflate(bpy.types.Operator):
    bl_idname = 'ff.inflate'
    bl_label = 'Inflate to Base Mesh'
    bl_description = 'Fill the front and side outlines and inflate them into a closed mesh'
    bl_options = {'REGISTER', 'UNDO'}

    def execute(self, context):
        p = props(context)
        ob = bpy.data.objects.get(SKETCH)
        if ob is None:
            self.report({'ERROR'}, 'No sketch: press New Sketch and draw the front and side')
            return {'CANCELLED'}
        if context.object and context.object.mode != 'OBJECT':
            bpy.ops.object.mode_set(mode='OBJECT')
        front = [(P[:, [0, 2]], c) for P, c in IO.gp_read(ob, 'Front')]
        side = [(P[:, [1, 2]], c) for P, c in IO.gp_read(ob, 'Side')]
        if not front or not side:
            self.report({'ERROR'}, 'Draw at least one stroke on both the Front and the Side layer')
            return {'CANCELLED'}
        t0 = time.time()
        try:
            G, org, h, _ = INF.build_field(front, side, h=p.detail_mm / 1000.0, mirror=p.mirror_sketch,
                                           round_r=max(p.round_mm, 0.5) / 1000.0)
        except ValueError as e:
            self.report({'ERROR'}, str(e).capitalize())
            return {'CANCELLED'}
        V, F = INF.surface_nets(G, org, h)
        if not len(F):
            self.report({'ERROR'}, 'The outlines enclose nothing: close the front and side outlines')
            return {'CANCELLED'}
        base = IO.make_mesh('FF Base', V, F)
        IO.activate(base)
        # voxel remesh for a clean closed surface; thin places can still pinch, so retry coarser
        for k in range(4):
            if k:
                bpy.data.objects.remove(base)
                base = IO.make_mesh('FF Base', V, F)
                IO.activate(base)
            base.data.remesh_voxel_size = h * 1.25 * (1.12 ** k)
            bpy.ops.object.voxel_remesh()
            IO.clean_for_quadriflow(base)
            if IO.mesh_problems(base) == (0, 0):
                break
        t1 = time.time()
        msg = 'inflated in %.1fs' % (t1 - t0)
        if p.quad_remesh:
            # QuadriFlow can drop thin parts (a hand, a whole forearm) when the face count is low:
            # check the result against the voxel mesh and retry with more faces
            keep = base.data.copy()
            ref = np.array([v.co[:] for v in keep.vertices])
            lo, hi = ref.min(0), ref.max(0)
            tf, ok = p.target_faces, False
            for attempt in range(2):
                r = bpy.ops.object.quadriflow_remesh(target_faces=tf, use_mesh_symmetry=False,
                                                     use_preserve_sharp=False, use_preserve_boundary=False,
                                                     smooth_normals=False, mode='FACES', seed=0)
                V2 = np.array([v.co[:] for v in base.data.vertices]) if 'FINISHED' in r else None
                if V2 is not None and len(V2) and np.abs(V2.min(0) - lo).max() < 3 * h and np.abs(V2.max(0) - hi).max() < 3 * h:
                    ok = True
                    break
                old = base.data
                base.data = keep.copy()
                bpy.data.meshes.remove(old)
                tf = int(tf * 1.5)
            bpy.data.meshes.remove(keep)
            msg += (', quads in %.1fs' % (time.time() - t1)) if ok else ', quad remesh lost thin parts: kept the voxel mesh'
        for poly in base.data.polygons:
            poly.use_smooth = True
        if p.multires and base.modifiers.get('Multires') is None:
            base.modifiers.new('Multires', 'MULTIRES')
        p.target = base
        p.last_report = '%s · %d faces' % (msg, len(base.data.polygons))
        self.report({'INFO'}, p.last_report)
        return {'FINISHED'}


# ---------------- patches ----------------

class FF_OT_patch_sketch(bpy.types.Operator):
    bl_idname = 'ff.patch_sketch'
    bl_label = 'Draw Patch Borders'
    bl_description = 'Grease Pencil drawing that sticks to the surface of the sculpt'
    bl_options = {'REGISTER', 'UNDO'}

    def execute(self, context):
        p = props(context)
        if p.target is None and context.object and context.object.type == 'MESH':
            p.target = context.object
        if p.target is None:
            self.report({'ERROR'}, 'Pick the sculpt to draw on (Surface)')
            return {'CANCELLED'}
        if context.object and context.object.mode != 'OBJECT':
            bpy.ops.object.mode_set(mode='OBJECT')
        ob = IO.gp_object(PATCH, ['Patches'], (0.85, 0.15, 0.1, 1.0))
        IO.activate(ob)
        ts = context.scene.tool_settings
        ts.gpencil_stroke_placement_view3d = 'SURFACE'
        ts.gpencil_surface_offset = 0.0
        ts.gpencil_sculpt.lock_axis = 'VIEW'
        bpy.ops.object.mode_set(mode='PAINT_GREASE_PENCIL')
        return {'FINISHED'}


class FF_OT_build_patches(bpy.types.Operator):
    bl_idname = 'ff.build_patches'
    bl_label = 'Build Patches'
    bl_description = 'Turn the patch borders into a quad mesh on the sculpt'
    bl_options = {'REGISTER', 'UNDO'}

    def execute(self, context):
        p = props(context)
        ob = bpy.data.objects.get(PATCH)
        if ob is None or p.target is None:
            self.report({'ERROR'}, 'Draw patch borders on a Surface first')
            return {'CANCELLED'}
        if context.object and context.object.mode != 'OBJECT':
            bpy.ops.object.mode_set(mode='OBJECT')
        strokes = IO.gp_read(ob, 'Patches')
        if not strokes:
            self.report({'ERROR'}, 'No strokes on the Patches layer')
            return {'CANCELLED'}
        t0 = time.time()
        surf = IO.Surface(p.target)
        centre = surf.slice((1e-4, 0, 0), (1, 0, 0)) if p.mirror_patch else None  # off the exact plane: a symmetric mesh has points on it
        res = PT.retopo(strokes, surf.project, target_len=p.edge_mm / 1000.0, mirror=p.mirror_patch,
                        centre=centre, corner_max=p.corner_deg, relax=p.relax)
        surf.bm.free()
        rep = res['report']
        if not len(res['F']):
            p.last_report = rep.get('error', 'no patches could be filled')
            self.report({'ERROR'}, p.last_report)
            return {'CANCELLED'}
        out = IO.make_mesh('FF Retopo', res['V'], res['F'])
        if p.mirror_patch and out.modifiers.get('Mirror') is None:
            md = out.modifiers.new('Mirror', 'MIRROR')
            md.use_clip = True
            md.use_mirror_merge = True
            md.merge_threshold = 0.0005
        irr = rep.get('irregular', {})
        lines = ['%d of %d patches · %d quads · %.1fs' % (rep['filled'], rep['patches'], rep['quads'], time.time() - t0),
                 'poles: ' + (', '.join('%d×%d-edge' % (n, k) for k, n in sorted(irr.items())) or 'none'),
                 'layouts: %d grids, %d stars · corners added %d, dropped %d' % (rep['grid'], rep['star'], rep['added corners'], rep['dropped corners']),
                 'folded quads: %d' % rep.get('folded quads', 0)]
        lines += ['left out: ' + w for w in rep['skipped'][:6]]
        p.last_report = '\n'.join(lines)
        self.report({'INFO'}, lines[0])
        return {'FINISHED'}


# ---------------- panel ----------------

class FF_PT_panel(bpy.types.Panel):
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = 'Flateable'
    bl_label = 'Flateable'

    def draw(self, context):
        p = props(context)
        L = self.layout
        box = L.box()
        box.label(text='1  Sketch', icon='GREASEPENCIL')
        box.operator('ff.new_sketch')
        row = box.row(align=True)
        row.operator('ff.draw_view', text='Draw Front').view = 'FRONT'
        row.operator('ff.draw_view', text='Draw Side').view = 'SIDE'
        box.prop(p, 'mirror_sketch')

        box = L.box()
        box.label(text='2  Base mesh', icon='MESH_MONKEY')
        col = box.column(align=True)
        col.prop(p, 'detail_mm')
        col.prop(p, 'round_mm')
        row = box.row(align=True)
        row.prop(p, 'quad_remesh')
        sub = row.row()
        sub.enabled = p.quad_remesh
        sub.prop(p, 'target_faces')
        box.prop(p, 'multires')
        box.operator('ff.inflate', icon='MOD_REMESH')

        box = L.box()
        box.label(text='3  Patch retopology', icon='MOD_LATTICE')
        box.prop(p, 'target')
        box.operator('ff.patch_sketch', icon='GREASEPENCIL')
        col = box.column(align=True)
        col.prop(p, 'edge_mm')
        col.prop(p, 'corner_deg')
        col.prop(p, 'relax')
        box.prop(p, 'mirror_patch')
        box.operator('ff.build_patches', icon='MESH_GRID')

        if p.last_report:
            box = L.box()
            for line in p.last_report.split('\n'):
                box.label(text=line)


classes = (FFProps, FF_OT_new_sketch, FF_OT_draw_view, FF_OT_inflate, FF_OT_patch_sketch, FF_OT_build_patches, FF_PT_panel)


def register():
    for c in classes:
        bpy.utils.register_class(c)
    bpy.types.Scene.ff_props = bpy.props.PointerProperty(type=FFProps)


def unregister():
    del bpy.types.Scene.ff_props
    for c in reversed(classes):
        bpy.utils.unregister_class(c)
