"""Generate samples/ideal-8-heads.svg: an idealized 8-head figure, T-pose front view
and left-facing side view, as clean vector outlines with roles already assigned.

Units: 1 head = 200, figure height = 1600, y down (SVG). Front view centre x = 900,
side view depth axis x = 2250 (front of body toward smaller x).
Edit the point lists and rerun: python3 samples/make_ideal.py
"""
import json, math, os

HEAD = 200
FX, SX = 900, 2250

def smooth_path(pts, closed=True):
    """Catmull-Rom through points -> cubic Bezier path. A point (x, y, 'c') is a corner."""
    P = [(p[0], p[1]) for p in pts]
    corner = [len(p) > 2 for p in pts]
    n = len(P)
    def at(i):
        return P[i % n] if closed else P[max(0, min(n - 1, i))]
    d = [f"M{P[0][0]:.1f} {P[0][1]:.1f}"]
    segs = n if closed else n - 1
    for i in range(segs):
        p0, p1, p2, p3 = at(i - 1), at(i), at(i + 1), at(i + 2)
        c1 = p1 if corner[i % n] else (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = p2 if corner[(i + 1) % n] else (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        d.append(f"C{c1[0]:.1f} {c1[1]:.1f} {c2[0]:.1f} {c2[1]:.1f} {p2[0]:.1f} {p2[1]:.1f}")
    return " ".join(d) + (" Z" if closed else "")

# ---- front view: right half (viewer's right = figure's left), top of head to crotch ----
# (half-width from centre, height from top of head)
front_half = [
    (0, 0), (46, 8), (66, 45), (71, 100), (64, 150), (48, 188), (30, 208),       # head, jaw
    (29, 232), (33, 256),                                                          # neck
    (72, 270), (128, 284), (168, 296),                                             # trapezius, shoulder
    (205, 291), (270, 294), (340, 302), (440, 306),                                # upper arm (top)
    (540, 303), (645, 310), (690, 307), (760, 309), (806, 318, 'c'),               # forearm, hand, fingertips
    (808, 333, 'c'), (765, 342), (700, 348), (650, 342),                           # hand underside
    (545, 350), (440, 351), (340, 356), (262, 366), (206, 382, 'c'),               # arm underside to armpit
    (172, 420), (166, 480), (148, 550), (132, 610),                                # chest side, ribs, waist
    (140, 670), (156, 730), (164, 790),                                            # hip
    (158, 870), (146, 960), (130, 1060), (114, 1150),                              # thigh (outer) to knee
    (120, 1240), (116, 1320), (98, 1430), (82, 1530),                              # calf to ankle
    (92, 1570), (98, 1596, 'c'), (26, 1600, 'c'), (28, 1560),                      # foot seen from the front
    (38, 1530), (40, 1430), (46, 1310), (38, 1225), (36, 1150),                    # inner calf to knee
    (30, 1060), (22, 960), (12, 860), (0, 812, 'c'),                               # inner thigh to crotch
]
def mirror(pts):
    out = []
    for p in reversed(pts[1:-1]):
        out.append((-p[0], p[1]) + tuple(p[2:]))
    return out
full = front_half + mirror(front_half)
front_outline = [(FX + p[0], p[1]) + tuple(p[2:]) for p in full]

# ---- side view, facing left: z forward (toward smaller x), height from top ----
front_edge = [
    (8, 0), (62, 22), (84, 62), (90, 102), (84, 118), (104, 138, 'c'), (88, 150), (90, 168),   # forehead, brow, nose
    (84, 190), (78, 204), (48, 214), (36, 236), (40, 262),                                    # mouth, chin, neck
    (72, 300), (98, 360), (100, 410), (90, 470), (82, 540), (80, 610),                        # chest, ribs, belly
    (88, 680), (82, 740), (70, 800),                                                           # lower belly, groin
    (74, 860), (70, 980), (60, 1100), (58, 1160), (56, 1250), (44, 1400), (36, 1520),          # thigh, knee, shin
    (54, 1556), (110, 1582), (150, 1592, 'c'), (150, 1600, 'c'),                               # instep, toes
]
back_edge = [
    (-48, 1600, 'c'), (-54, 1582), (-40, 1530), (-46, 1440), (-72, 1320), (-82, 1250),         # heel, achilles, calf
    (-64, 1160), (-72, 1060), (-82, 950), (-88, 870),                                          # back of knee, hamstring
    (-104, 800), (-100, 720), (-76, 660), (-64, 600),                                          # buttock, lower back
    (-78, 520), (-90, 430), (-88, 350), (-68, 290), (-44, 244),                                # back, shoulder blade, neck
    (-70, 205), (-92, 150), (-92, 95), (-70, 40), (-36, 10),                                   # skull
]
side_outline = [(SX - p[0], p[1]) + tuple(p[2:]) for p in front_edge + back_edge]

# arm seen end-on at the shoulder (T-pose): its cross-section
arm_cy, arm_cz, arm_rz, arm_ry = 328, -4, 48, 40
arm_section = [(SX - (arm_cz + arm_rz * math.cos(t)), arm_cy + arm_ry * math.sin(t)) for t in [i * math.pi / 8 for i in range(16)]]

def ellipse(cx, cy, rx, ry, n=16):
    return [(cx + rx * math.cos(i * 2 * math.pi / n), cy + ry * math.sin(i * 2 * math.pi / n)) for i in range(n)]

paths = []
def add(pts, role, view, color='#1b1f27', closed=True, group=None, part=None):
    paths.append(dict(d=smooth_path(pts, closed), role=role, view=view, color=color, group=group, part=part))

add(front_outline, 'line', 'front')
add(side_outline, 'line', 'side')
add(arm_section, 'section', 'side', color='#0e7d89', part='arm')
# centre line
paths.append(dict(d=f"M{FX} 20 L{FX} 1590", role='axis', view='front', color='#d9822b'))
# a few feature marks, to show tags (coloured strokes become tag groups)
for sx in (1, -1):
    add(ellipse(FX + sx * 76, 1150, 20, 28), 'feature', 'front', '#d9463b', group='kneecaps')
add([(FX - 120, 430), (FX - 60, 448), (FX - 8, 440)], 'feature', 'front', '#2f9fd0', closed=False, group='pectoral line')
add([(FX + 8, 440), (FX + 60, 448), (FX + 120, 430)], 'feature', 'front', '#2f9fd0', closed=False, group='pectoral line')
add([(FX - 150, 700), (FX - 70, 745), (FX, 760), (FX + 70, 745), (FX + 150, 700)], 'feature', 'front', '#5a52c9', closed=False, group='belt line')
add(ellipse(SX - 60, 1150, 14, 26), 'feature', 'side', '#d9463b', group='kneecaps')

# height guides across both views, in head units
guides = []
for k, label in [(0, 'top'), (1, 'chin'), (2, 'nipples'), (3, 'navel'), (4, 'crotch'), (6, 'knee'), (8, 'floor')]:
    y = k * HEAD
    guides.append(f'<path d="M60 {y} L2470 {y}" fill="none" stroke="#9aa1ab" stroke-width="1.5" stroke-dasharray="10 8" data-role="guide" data-view="both"/>')

meta = {
    "version": 1, "splitX": 1880, "gapFrac": 0.003, "heightM": 1.8, "canon": 8, "stationsAuto": True,
    "groups": {
        "kneecaps": {"color": "#d9463b", "pressure": 1, "tension": 1, "loop": False, "visible": True},
        "pectoral line": {"color": "#2f9fd0", "pressure": 1, "tension": 1, "loop": False, "visible": True},
        "belt line": {"color": "#5a52c9", "pressure": 1, "tension": 1, "loop": False, "visible": True},
    },
    "views": {"front": {"top": 0, "floor": 1600, "axis": FX, "manual": {}},
              "side": {"top": 0, "floor": 1600, "axis": SX, "facing": "left", "manual": {"facing": True}}},
    "landmarks": [], "paint": [],
}

out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="40 -40 2460 1680" width="2460" height="1680">',
       f'<metadata id="ff-project">{json.dumps(meta)}</metadata>',
       '<title>Idealized 8-head figure: T-pose front, left-facing side</title>']
out += guides
for p in paths:
    attrs = [f'd="{p["d"]}"', 'fill="none"', f'stroke="{p["color"]}"', 'stroke-width="2.5"', 'stroke-linejoin="round"', 'stroke-linecap="round"',
             f'data-role="{p["role"]}"', f'data-view="{p["view"]}"']
    if p.get('group'): attrs.append(f'data-group="{p["group"]}"')
    if p.get('part'): attrs.append(f'data-part="{p["part"]}"')
    out.append('<path ' + ' '.join(attrs) + '/>')
out.append('</svg>')
here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, 'ideal-8-heads.svg'), 'w') as f:
    f.write('\n'.join(out) + '\n')
print('wrote ideal-8-heads.svg')
