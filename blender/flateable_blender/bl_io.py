# Blender glue: Grease Pencil strokes in and out, surface projection, mesh building.

import bpy
import bmesh
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree


# ---------------- Grease Pencil ----------------

def gp_material(name='FF Ink', rgba=(0.08, 0.08, 0.08, 1.0)):
    m = bpy.data.materials.get(name)
    if m is None:
        m = bpy.data.materials.new(name)
        bpy.data.materials.create_gpencil_data(m)
    m.grease_pencil.color = rgba
    return m


def gp_object(name, layers, rgba=(0.08, 0.08, 0.08, 1.0)):
    ob = bpy.data.objects.get(name)
    if ob is None or ob.type != 'GREASEPENCIL':
        gp = bpy.data.grease_pencils.new(name)
        ob = bpy.data.objects.new(name, gp)
        bpy.context.scene.collection.objects.link(ob)
        gp.materials.append(gp_material(name + ' ink', rgba))
    gp = ob.data
    for ln in layers:
        if gp.layers.get(ln) is None:
            L = gp.layers.new(ln)
            L.frames.new(bpy.context.scene.frame_current)
    return ob


def gp_layer_drawing(ob, layer):
    L = ob.data.layers.get(layer)
    if L is None:
        return None
    fr = L.current_frame() or (L.frames[0] if len(L.frames) else L.frames.new(bpy.context.scene.frame_current))
    return fr.drawing


def gp_read(ob, layer):
    """World-space strokes of a layer: list of (Nx3 array, cyclic)."""
    d = gp_layer_drawing(ob, layer)
    if d is None:
        return []
    M = np.array(ob.matrix_world)
    out = []
    for s in d.strokes:
        P = np.array([tuple(p.position) for p in s.points], float)
        if len(P) < 2:
            continue
        P = P @ M[:3, :3].T + M[:3, 3]
        out.append((P, bool(s.cyclic)))
    return out


def gp_write(ob, layer, strokes, radius=0.004):
    """Append strokes (list of (Nx3 world, cyclic)) to a layer."""
    d = gp_layer_drawing(ob, layer)
    if d is None:
        L = ob.data.layers.new(layer)
        d = L.frames.new(bpy.context.scene.frame_current).drawing
    Minv = np.array(ob.matrix_world.inverted())
    first = len(d.strokes)
    d.add_strokes([len(P) for P, _ in strokes])
    for k, (P, cyc) in enumerate(strokes):
        s = d.strokes[first + k]
        s.cyclic = bool(cyc)
        Q = np.asarray(P, float) @ Minv[:3, :3].T + Minv[:3, 3]
        for p, q in zip(s.points, Q):
            p.position = tuple(q)
            p.radius = radius
    return d


# ---------------- surface ----------------

class Surface:
    def __init__(self, ob):
        dg = bpy.context.evaluated_depsgraph_get()
        ev = ob.evaluated_get(dg)
        me = ev.to_mesh()
        M = ob.matrix_world
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.transform(M)
        bmesh.ops.triangulate(bm, faces=bm.faces)
        self.bm = bm
        self.tree = BVHTree.FromBMesh(bm)
        ev.to_mesh_clear()

    def project(self, P):
        P = np.asarray(P, float)
        Q = np.empty_like(P)
        N = np.empty_like(P)
        for i, p in enumerate(P):
            loc, nrm, _, _ = self.tree.find_nearest(Vector(p))
            if loc is None:
                Q[i], N[i] = p, (0, 0, 1)
            else:
                Q[i], N[i] = loc, nrm
        return Q, N

    def slice(self, co, no):
        """Polylines where a plane cuts the surface: list of (Nx3, closed)."""
        bm = self.bm.copy()
        res = bmesh.ops.bisect_plane(bm, geom=list(bm.verts) + list(bm.edges) + list(bm.faces),
                                     plane_co=Vector(co), plane_no=Vector(no), dist=1e-7)
        cut = [e for e in res['geom_cut'] if isinstance(e, bmesh.types.BMEdge)]
        bm.verts.index_update()
        adj = {}
        for e in cut:
            a, b = e.verts[0].index, e.verts[1].index
            adj.setdefault(a, []).append(b)
            adj.setdefault(b, []).append(a)
        bm.verts.ensure_lookup_table()
        pos = {i: tuple(bm.verts[i].co) for i in adj}
        seen, out = set(), []
        for s in adj:
            if s in seen:
                continue
            comp, st = set(), [s]
            while st:
                v = st.pop()
                if v in comp:
                    continue
                comp.add(v)
                st.extend(adj[v])
            ends = [v for v in comp if len(adj[v]) == 1]
            start = ends[0] if ends else s
            chain, prev, cur = [start], None, start
            seen.add(start)
            while True:
                nx = [w for w in adj[cur] if w != prev and w not in seen]
                if not nx:
                    break
                prev, cur = cur, nx[0]
                seen.add(cur)
                chain.append(cur)
            seen |= comp
            closed = not ends and len(chain) > 2 and start in adj[cur]
            out.append((np.array([pos[v] for v in chain]), closed))
        bm.free()
        return out


# ---------------- meshes ----------------

def make_mesh(name, V, F, link=True):
    V = np.asarray(V, np.float32)
    F = np.asarray(F, np.int32)
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(V))
    me.vertices.foreach_set('co', V.ravel())
    if len(F):
        me.loops.add(F.size)
        me.loops.foreach_set('vertex_index', F.ravel())
        me.polygons.add(len(F))
        me.polygons.foreach_set('loop_start', np.arange(0, F.size, 4, dtype=np.int32))
        me.polygons.foreach_set('loop_total', np.full(len(F), 4, np.int32))
    me.update(calc_edges=True)
    me.validate()
    ob = bpy.data.objects.get(name)
    if ob is not None and ob.type == 'MESH':
        old = ob.data
        ob.data = me
        if old.users == 0:
            bpy.data.meshes.remove(old)
    else:
        ob = bpy.data.objects.new(name, me)
        if link:
            bpy.context.scene.collection.objects.link(ob)
    return ob


def mesh_problems(ob):
    """Counts of what QuadriFlow refuses: edges with 3+ faces, open edges, near-zero edges."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bad = sum(1 for e in bm.edges if len(e.link_faces) != 2)
    short = sum(1 for e in bm.edges if (e.verts[0].co - e.verts[1].co).length < 1.8e-4)
    bm.free()
    return bad, short


def clean_for_quadriflow(ob, dist=1.8e-4):
    """QuadriFlow rejects edges shorter than 0.1 mm on every axis; merge just those."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=dist)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=dist)
    bm.to_mesh(ob.data)
    bm.free()


def activate(ob):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
