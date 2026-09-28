_Non-binding exploration log. Records what was tried and why it was dropped. Not read by the agent unless asked._

## 2026-09-28 — first build (balloon inside the visual hull)

- **Tracing PNG sketches.** Thinned skeleton lines broke at every diagonal step (the steps read as three-way junctions, and the tiny connector pieces were dropped). Fixed by removing staircase corner pixels and joining chains whose ends meet one-to-one. Anti-aliased black lines have grey cores in places; ink blobs are now classed black when about a quarter of their pixels are dark.
- **Height-line detection.** "Long and flat" alone caught arm outlines too. Now a height line also needs at least one end touching nothing.
- **Centre-line detection.** "Long thin vertical" caught the leg outlines. Now only coloured strokes near the middle of the front view count.
- **Hull gaps.** The sketch's crotch is closed only by coloured lines, so coloured strokes now count as walls for the hull too (interior strokes cannot change what the outside flood reaches). The default gap tolerance was raised from 0.6% to 1.2% of figure height. The side view still has one real opening under the chin.
- **Arm cross-section.** A search over closed strokes failed because the traced shoulder circle is eight open fragments. It became a paint-bucket region search. On this sketch the only enclosed area there is a U shape under the inner ellipse. Applying the section as a full 2D constraint flattened the arms into ribbons; it now sets arm depth only, as a profile, with rows narrower than half an ellipse falling back to the ellipse. The front view sets arm thickness.
- **Balloon force model.**
  - v1: explicit curvature times pressure step. Unstable on fine meshes: vertices buzzed and never settled.
  - v2: umbrella smoothing along the normal plus pressure scaled by e²/(2r). Stable, settles in about 1,200 steps, 91% front and 89% side fill. Kept.
  - v3: a true mean-curvature tension with constant pressure (Laplace's law). It collapsed to 15% fill. This is soap-bubble behaviour: with constant pressure and constant tension, anything smaller than its target radius shrinks further. A rubber-like tension that rises with stretch (v2) is what makes inflation stable. Dropped.
- **Open question from the user:** the mesh should be one single quad mesh starting from the front outline, not pieces. The current mesh is one closed piece, but it starts from a station-built cage placed inside the outline, not from a quad meshing of the outline itself.

## 2026-09-28 — idealized sample replaces the user's sketch

- The user's sketch was loose; treating it as exact input gave ~9.6-head proportions, an open shoulder box read as the arm section, and a chin gap. Replaced by a generated vector figure (`samples/make_ideal.py`, 8 heads, T-pose, left-facing side, closed arm section at the shoulder). The user's PNGs were removed from the app.
- Closed SVG curves whose start equals their end collapsed to two points in the line simplifier. Fixed.
- The centre line counted as a hull wall and sealed the gap between the legs (crotch detected at knee height). Removed from the hull.
- The 1.2% gap closing, tuned for the rough sketch, sealed the thigh gap on clean vector art. Gap default is now per source: 0.3% for vector, 1.2% for traced images.
- Loop pull onto the belt line was on in the sample and pinched the hips. Now off by default.
- Remaining: the hips just above the crotch are under-filled in the front view (the bottom trunk ring has to host both leg openings).

## 2026-09-28 — Loomis-based figure generator, top view, waist fix

- **Waist/hip under-fill, diagnosed.** Every vertex of a ring shared one reference radius, the ring's mean radius. A wide, shallow section (pelvis about 18 × 10 cm) needs a curve of about 5.5 cm at its sides to touch the front outline, so the balloon rounded off short of it. The same flaw hit every flat section (chest sides, knees, hands). Fixed by giving each vertex the curvature radius of the ring's ellipse at its angle, so the default profile is the ellipse inscribed in the front-width × side-depth box. Fill on the adult went from 93/96% to 99/99%.
- **Remaining junction weakness.** On the 1-year-old (short, wide pelvis) a band above the crotch stays about 5% under-filled: the single bottom trunk ring has to open onto both legs. The first leg ring now scales with leg length rather than a fixed 4% of height, which helped a little.
- **Reference figures.** The hand-edited SVG sample was replaced by `js/figure.js`: adult male and female authored in head units after Loomis; children at 15, 10, 5, 3 and 1 year derived from the male by remapping landmark heights and narrowing the body. Each preset has T-pose front, left-facing side, and a top view of hands and feet.
- **Top view.** It shares the front view's scale and x axis. Its depth origin is aligned automatically by matching the feet to the foot seen in the side view. It holds only hand and foot vertices, in (x, z). Hand depth comes from it instead of the arm cross-section. The hand is still a mitten tube, so the thumb in the plan outline is not reached.
