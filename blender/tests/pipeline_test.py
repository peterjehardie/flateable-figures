# Headless end-to-end run of the add-on: sketch -> inflate -> patch strokes -> patches.
#
#   node blender/tests/dump_figure.mjs male > /tmp/male.json
#   python blender/tests/pipeline_test.py /tmp/male.json out.blend      (needs `pip install bpy`)
#
# The reference figure's outlines stand in for drawing: the front outline's right half goes on
# the Front layer (mirror on), the side outline on the Side layer. Patch strokes are plane cuts
# of the base mesh (rings, a side line, front and back lines), standing in for strokes drawn on
# the surface. Prints the reports the panel would show.

import os
import sys
import json
import time

import numpy as np
import bpy

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import flateable_blender as FB  # noqa: E402


def cut(surf, co, no, keep=None):
    out = []
    for P, closed in surf.slice(co, no):
        k = np.array([keep(p) for p in P]) if keep else np.ones(len(P), bool)
        if k.all():
            out.append((P, closed))
            continue
        if closed and k.any():
            i0 = np.flatnonzero(~k)[0]
            P, k = np.roll(P, -i0, 0), np.roll(k, -i0)
        cur = []
        for p, kk in zip(P, k):
            if kk:
                cur.append(p)
            elif cur:
                if len(cur) > 3:
                    out.append((np.array(cur), False))
                cur = []
        if len(cur) > 3:
            out.append((np.array(cur), False))
    return out


def grid_strokes(surf, s=1.0):
    X, Y, Z = (1, 0, 0), (0, 1, 0), (0, 0, 1)
    st = []
    ya = float(np.mean([p[1] for P, c in surf.slice((0.5 * s, 0, 0), X) for p in P if p[2] > 1.2 * s]))
    za = float(np.mean([p[2] for P, c in surf.slice((0.5 * s, 0, 0), X) for p in P if p[2] > 1.2 * s]))
    yh = float(np.mean([p[1] for P, c in surf.slice((0, 0, 1.68 * s), Z) for p in P]))
    st += cut(surf, (0, 0, 0), Y, lambda p: p[0] < 0.26 * s and p[2] < 1.6 * s)
    st += cut(surf, (0, yh, 0), Y, lambda p: p[2] > 1.54 * s)
    st += cut(surf, (0, ya, 0), Y, lambda p: p[0] > 0.2 * s)
    st += cut(surf, (0.09 * s, 0, 0), X, lambda p: p[2] < 1.52 * s or abs(p[0]) < 0.25 * s)
    for z in (1.72, 1.58, 1.25, 1.08, 0.93, 0.80, 0.72, 0.52, 0.40, 0.22, 0.08):
        st += cut(surf, (0, 0, z * s), Z, lambda p, z=z: abs(p[0]) < 0.3 * s and (z != 0.80 or p[0] > 0.004))
    for x in (0.3, 0.45, 0.6, 0.75):
        st += cut(surf, (x * s, 0, 0), X, lambda p: p[2] > 1.25 * s)
    st += cut(surf, (0, 0, za), Z, lambda p: p[0] > 0.26 * s)
    return st


def main(fig_json, out):
    FB.register()
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    d = json.load(open(fig_json))
    bpy.ops.ff.new_sketch()
    sk = bpy.data.objects['FF Sketch']
    half = []
    for p in d['front']:
        P = np.array(p['pts'])
        k = P[:, 0] >= -0.002
        half.append((np.c_[P[k, 0], np.zeros(k.sum()), P[k, 1]], False))
    FB.IO.gp_write(sk, 'Front', half)
    FB.IO.gp_write(sk, 'Side', [(np.c_[np.zeros(len(p['pts'])), np.array(p['pts'])], p['closed']) for p in d['side']])
    P = bpy.context.scene.ff_props
    t = time.time()
    print('inflate', bpy.ops.ff.inflate(), '%.1fs' % (time.time() - t), '|', P.last_report)
    base = bpy.data.objects['FF Base']
    surf = FB.IO.Surface(base)
    s = max(v.co.z for v in base.data.vertices) / 1.83
    gp = FB.IO.gp_object('FF Patch Strokes', ['Patches'], (0.85, 0.15, 0.1, 1.0))
    FB.IO.gp_write(gp, 'Patches', grid_strokes(surf, s))
    t = time.time()
    print('build_patches', bpy.ops.ff.build_patches(), '%.1fs' % (time.time() - t))
    print(P.last_report)
    if out:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(out))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
