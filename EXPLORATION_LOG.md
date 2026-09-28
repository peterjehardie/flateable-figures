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

## 2026-09-28 — waist, hands, feet, face topology, inflate on click

- **Waist, second look.** Close-up renders showed three things:
  - A crease at the waist loop, because the male outline was drawn as a sharp pinch. Redrawn as a gentle taper.
  - Faint horizontal ripples. Tried: fairing (Laplacian of the Laplacian) at 0.12, which destabilised the waist into a thin neck (dropped, kept at 0.03); a blurred, finer hull raster (no effect on the ripples, kept for smoothness).
  - The real bug, a 4 cm dent at the front centre of the lower belly. The previous "ellipse curvature" change gave flat fronts a large radius, so weak pressure there, and the crotch chain pulled that column inward. Fixed by only ever tightening the radius (never above the ring mean). Fill 100/100%.
- **Hands.** Palm with two widening stages (wrist 8m → palm 12m → knuckles 18m) built from 1-to-3 units: a 3-edge and a 5-edge pole each, never touching. The knuckle end is a 7m × 2m grid: finger, web, finger, web, finger, web, finger in the palm-side row, with the back row roofing the knuckles. The thumb leaves an m × m block on the palm side. No 6-edge poles.
  - First attempt put fingers side by side (6-edge poles at every web).
  - Units placed side by side also made 6-edge poles.
  - The right hand needed mirrored unit placement, plus the knuckle-grid offset split between both corners (exact only for even m, i.e. 16 round).
- **Feet.** The foot leaves an a × a block on the front of the lower leg (like the arms from the torso), runs forward, and widens twice to a 6m × 2m toe grid: big toe, gap, four toes. Toes 2–5 share webs (6-edge poles, accepted). Which side is "inner" is now fixed by construction; it used to be measured, which flipped toe order on some figures.
- **Face.** Head rings at Loomis face heights. Insets give a loop round the face, two round each eye and two round the mouth. Eyes need 16 round; at 8 they touch at the nose bridge (6-edge poles), so they are skipped there. Default is now 16 round at subdivision level 1 (about the same density as 8 round at level 2).
- **Balloon on small parts.** Fingers burst: pressure used the mean edge, which on long thin tubes is set by the far-apart loops. Now uses min(mean, 2 × shortest). Fingers and toes also sit a few mm apart, so hands and feet get a slow, gentle fit. The foot and toe loops had depth anchors that fought the hull once the foot settled shorter; removed there.
- **Inflation** now only runs from the Inflate button and stops when it settles.
- **Open question from the user:** SVG sheet versus drawing directly in locked orthographic views of the 3D scene.

## 2026-09-28 — rounded profile by default

- The user saw boxy cross-sections. Cause: the balloon was only held by the two drawings, so pressure filled the corners of the box they allow (front width × side depth), which is the visual hull. Silhouette fill read 100% because corners don't show in either view.
- Added the rounded profile as a constraint: per height (trunk, each leg) and per point along the arms, a table of that box; each vertex is kept inside the superellipse that fits it (exponent 2.2 by default; 2 = ellipse; the far end of the slider switches it off). It touches the outlines at their extremes, so the silhouettes still fill (99/99%). Hands and feet are left to the top view. Cross-section plots at chest, waist, hip, thigh and calf confirm boxes before, rounded profiles now.

## 2026-09-28 — head and waist "shrinking" on Inflate

- Traced widths per step. The waist filled its box in ~60 steps, then contracted to ~92% over a few hundred (tension, still doing the rounding, won once the first push was spent). The head inflated ~10× slower than the body (finer quads from the face loops, and pressure scaled with quad size), so it looked like it shrank while the body ballooned.
- Now: the rounded-profile constraint does the rounding. Pressure is a steady push that fades out as each vertex reaches its profile ("inflate until it matches"). Tension is plain smoothing (default 0.5).
  - A constant push crumpled the face loops and toes: big quads outran the tiny loops next to them.
  - Fixed by smoothing the pressure field over neighbours (4 passes), so neighbours move together.
- Result: head and waist reach 99% of their box within 15–30 steps and hold. Fill 99/98%. Settling is judged on the body only (toe tips on the floor shimmer harmlessly).

## 2026-09-28 — regression: neck gone, face band, side profile

- The user reported that after "even inflation" the neck was gone and the side profile was broken.
- Measured old vs new, settled, slice by slice against the drawings. Both end up at the same outer extents. The difference was that the new push actually reaches the target; the old one stalled short of it.
  - **Neck.** The reference front outline flared into the shoulders ~4 cm below the chin. The old balloon never filled that saddle, which left a neck by accident. Once the mesh matched the drawing, the neck disappeared. Fixed in the drawing: longer neck and a lower, sloped trapezius (male and female; the ages remap from the male).
  - **Face band.** Each height's rounded cross-section was sized from the side outline at that height, nose included. Rows at nose height got a deeper target, and the whole row of the face was pushed forward (a band across the cheeks, a "mask" look). The head's depth for the profile now has narrow bumps (nose, brow, lips) removed: a morphological opening over a quarter of the head's height. The side outline itself still holds the mesh.
- Autosave key bumped so browsers stop restoring the old drawing and settings.
- Checked male, female, 10 and 3 years: neck visible front and side, no face band.
