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

## 2026-09-28 — detail pass: face, hands, feet

- The user asked whether the face, hands and feet could be worked more carefully, with more topology.
- Why they were blank: outlines can't carry features that sit inside every outline (sockets, lips, nose sides). Fingers and toes were built from generic proportions and only fenced in by the top view; they stayed slabs and blobs.
- **Second pass.** After the body settles, only the head, hands and feet move; the rest is held. All forces are scaled by 0.4 together.
  - Scaling only pressure made tension win, and the head collapsed after ~300 steps.
  - Switching pressure off on the face let tension draw it in from the sides. Pressure now stops only where a face point is already at or past its target.
- **Face relief** (js/face.js), built from the drawings:
  - Profile front edge minus the rounded head, spread across by the widths of features that cross the centre line (nose base, mouth).
  - Lines drawn at the same height in both views give 3D ridges (brows).
  - Closed shapes in both views give eyes: a low dome with a lid groove round it, capped at 0.4 of the eye's half-height in front of the head (the female eyes bulged otherwise).
  - Eye and mouth loops are pulled onto the drawn shapes.
- **Denser face.** Inside the face loop the cage is split in four. The loop's own ring makes the step between densities: two quads become three with no new vertices (a 5-pole outside, a 3-pole inside). Still all quads and one closed mesh; no poles of 6+ added.
- **Denser faces got crumpled by the body pass.** Steps of ~4 mm outran quads of 2–7 mm. Now the points inside the face loop are carried along (their movement filled in from their neighbours). When the detail pass starts they are laid out on their target: the cage's shrink is undone across, and the eye and mouth areas are moved and scaled onto the drawn eye and mouth. Laying out without that warp left the eye loops ~4 cm off target, and they folded.
- **Fingers and toes** (js/digits.js):
  - Each digit of the mesh is matched to its own top-view shape: nearest first; only small, elongated shapes qualify.
  - Every point of the digit is laid out along the shape: the tube stretches to the drawn length and the tip keeps a round end of the drawn half width. Stretching the whole digit made single-loop toes into cones; sampling the width at the drawn end rounded tips twice.
  - Offsets are measured against the loops either side (the cage tapers).
  - Thickness comes from the front view (fingers) or the side view (toes, resting on the floor).
  - Tension on digits is cut to 0.2 in this pass: on a tube 1–2 cm across it pulled them ~6 mm thin.
  - Bug found: a flood with a size cap let later small pockets of palm overwrite the finger; now the smaller side of a full search is taken.
- Still rough: a thin neck at each finger base (between knuckle and first loop, not laid out); the female big toe creases; the face's density step shows as a ring of 3/5 poles round the face.

## 2026-09-29 — rig toolkit; layers, back view, symmetry

- **Rig** (js/rig.js, js/rigpanel.js; Rig tab).
  - Body points ("slots") are measured on the settled mesh from loops, stations and the drawings: pelvis, spine ×3, neck, head, clavicle, shoulder, elbow, wrist, 4 per finger, hip, knee, ankle, ball, toe tip.
  - Built-in rig with Mixamo-style names (65 joints).
- **Loading other rigs:** JSON, BVH and glTF/GLB skeletons.
  - Joint names are matched to body points by keyword. Tested on Mixamo, Unreal and Rigify names. Twist and metacarpal bones are left unmatched on purpose. A spine of any length spreads over spine1/spine2/chest.
  - Each joint can be matched by hand in the panel.
  - Unmatched joints keep their place along the line between the matched joints above and below them (a BVH twist joint landed halfway, as in its source), or their offset from their parent scaled to the figure.
- **Skin weights:** 1/d⁴ to the nearest bones of the same body part (limbs may also take trunk bones), at most 4. On hands and feet the reach is tighter, so fingers don't drag each other.
- **Bend test:** sliders for elbows, knees, arms down/up, legs forward, bend forward, head turn, finger curl, toes up. Readouts for volume change, squashed quads (area < 30%) and quads turned over (against the rest normal rotated by the quad's main bone); optional stretch colours.
  - All test poses at once: −8.6% volume, 118 squashed, 181 turned over. Elbow alone at 120°: 60 squashed, 12 turned over. Baseline for the joint-topology work.
- **Export:** skinned glTF (.glb), bind pose with unrotated joints.
  - Read back with three.js GLTFLoader: a skinned mesh with 65 bones. Its bend of the left elbow matches the app's own skinning to 0.00 mm.
  - First test compare was wrong: three.js only refreshes bone matrices in skeleton.update().
  - Bug found: switching rigs drew the new rig with the old fit.
- **Drawing layers:** Outline / Features / Notes. The pen draws on the active layer; other layers dim and can't be picked. The pen colour still names feature groups.
- **Back view:** the front panel shown mirrored (as seen from behind), sharing the outline. Strokes are stored in front-view coordinates. Features drawn there are marked for the far surface; the face pass ignores them.
- **Mirror drawing:**
  - A stroke on one side gets a twin; erasing one erases both.
  - Half an outline drawn from the centre line closes itself.
  - "Make symmetric" rebuilds the front view from either half, cutting strokes that cross the line.
  - Twins are saved as pairs in the project SVG.
- The user asked where the cage topology came from: it was written by hand by the agent, in code, and iterated by render and pole counts. It isn't from a reference base mesh or a dataset.

## 2026-09-29 — interface in four steps

- The user found the interface unruly. It is now four steps in the header: Draw → Inflate → Refine → Rig & export. Each has one panel, and "next" and "back" buttons.
  - The panel follows the work: Inflate opens step 2 if the user is still on Draw; the finer pass opens Refine if they are on Inflate. Finished steps get a mark.
- Physics settings, topology counts, heights, calibration, landmarks and the joint list sit in collapsed sections.
- Both toolbars keep only tools. Display toggles, Fill and Landmark moved into View menus.
- Calmer defaults: no mesh loops on the drawing, no cage edges or drawings in 3D. The fit colours only appear once inflation has started (before, they tinted everything blue).
- Feature group cards fold their settings. "Pressure/tension" are relabelled "puff out/flatten".
- Checked in light and dark themes, through the whole flow.

## 2026-09-29 — one-line hands and feet, anatomical loops, split sheet, anatomy coverage

- **Hands and feet** (sub-agent): each hand and each foot in the top view is one continuous outline.
  - Digits are found from the traced top-view mask: notches from dents in the convex hull plus narrow slots; the deepest k−1 are kept.
  - The top view no longer thickens strokes (that sealed the gaps between fingers); it joins only the loose ends of open strokes.
  - 20/20 digits on every preset.
  - Female feet used the male foot, longer than her side view; now 0.9 of it.
  - Dropped: hull dents alone (merged two toes); the first finger loop at the web (pinched neck).
  - Left: toe-web crease; thumb built at 55° against a drawn 38°.
- **Anatomical loops** (sub-agent):
  - A "lens" tool adds a loop round a stretch of an existing loop; ending on an ordinary vertex it gives a 3/5 crease pair, ending on a 5-pole it moves the pole.
  - Shoulder: armpit poles moved onto chest and shoulder blade; deltoid ring leaning in.
  - Hip: joint loop, tilted thigh-top ring, groin and buttock-fold lenses.
  - Elbow, knee and kneecap crease lenses; face jaw, nasolabial, brow, nose and ear insets; finger rings on the knuckles.
  - Head rings renamed: nose → nostrils, brow → forehead.
  - Bend test at N=16: elbow flips 12 → 0; legs-forward flips 0 → 6 (all on the right, where the fitted rig is itself off its mirror by up to 6.5 mm).
  - Chest, shoulder-blade and collarbone loops are traced along existing edges, not new geometry.
  - Dropped: narrowing the joint bands on the inside (squashed the crease); several groin shapes (padded the thigh, because denser patches bulge under pressure).
- **Split front sheet:** front of the body on the page right, back seen from behind on the left, both showing the figure's +x side; shared symmetric outline. Features drawn on the left half go to the back (stored mirrored). Whole Front / Back remain for one-sided features.
- **Partial erase:** the eraser cuts only what is under it; the twin loses the mirrored part.
- **Anatomy:**
  - Every quad gets a region, from part, height against stations, angle round its own axis, and face and digit loops. Every loop gets an anatomical role.
  - Anatomy colouring, with the region name on hover.
  - Coverage checklist of 23 items, and region density against the body average.
  - Before the loops merge: 41%. After: 100% by name, but the torso is still 0.15–0.4× density while the face and hands are 3–25×. The checklist only tests that names exist, not loop quality.
- **Settling:** with the extra loops, the body kept a spread-out shimmer of about 3e-5 H per step above the 2.5e-5 stop line and never stopped. It now also stops when movement has not improved for 150 steps after 600 (cap 2500). Full flow in the test browser: 58 s.
- The agent committed the sub-agents' worktree folders as embedded repositories by mistake, then untracked them and excluded that folder locally.

## 2026-09-29 — bug pass; Refine step made real; stale saved drawings

- **The user saw the old hands and feet in the published app.** The browser restores the last session from local storage, and that session held the old drawing, so new reference drawings never showed.
  - Reference figures now carry a version. A saved copy of an older version is replaced by the current drawing on load, with a notice.
- **"Refine is not working at all".** The pass ran (automatically, after the body), but the step had no button, no progress and no way to see its effect, and the skeleton overlay covered the result.
  - The step now has a Refine button: it inflates first if needed, and can run again.
  - A live status reports the features it used and the digits matched.
  - Before/after toggle, using the body-pass positions kept by the detail pass.
  - Camera shortcuts to the face, hands and feet.
  - The skeleton shows only in the Rig step.
- **Review findings, all fixed and checked:**
  - The knee lenses cut the same quads as the buttock-fold lens when a leg had no spare rings (open edges with rings = 0 and joint rings off). The knee patterns now need a ring of their own. Every setting combination builds closed.
  - Split sheet: the eraser and selection picked strokes from the other half. Front features are now pickable only from the front half, back features only from the back.
  - A feature across the centre line could vanish by float rounding (the 1-year belt line). Visibility now uses the bounding box.
  - A twin already erased with its partner was erased again from a stale list.
  - The plateau stop kept its memory across runs and capped absolute steps. It now resets on every wake and counts from there.
  - Landmarks and guide handles were mirrored in the split sheet. Page and stored coordinates are now separate; a pen stroke keeps the side it started on.
  - With fewer than 3 finger rings, the lead ring (the detail pass's first loop) was dropped.
  - Erased pieces lost their twin links; they are now paired with the mirror piece nearest them.
  - The deltoid ring's lean could cross the next ring; it is now limited by the gaps.
  - The renamed head rings (nostrils, forehead) had no anatomy names.

## Feature strokes carried by mesh edges (conform pass)
- Tried: after Refine, each stroke on the Features layer is projected onto the surface from its view and mapped to a chain of existing mesh edges. A closed stroke maps to the border of the faces inside it. An open stroke maps to the cheapest edge path in a band around it (cost grows with distance from the stroke). Chain vertices are then pulled onto the stroke by arc length while the rest of the body stays soft.
- Symmetry: strokes are planned on one side and the chain is mirrored through the mesh mirror map; planning each side on its own gave zigzag, unmatched chains.
- Measured on the user's traced sketch (male preset, split sheet): 40 of 44 strokes placed; mean gap 9.4 mm → 3.6 mm, worst 23.6 → 17.7 mm.
- Known limit: diagonal strokes across a grid of rings become staircases. Pulling vertices cannot fix this; it needs edges re-routed or faces split along the stroke.
- Tracer: pale coloured pixels now count as colour (chroma 0.14); short spurs are pruned and nearby chain ends joined.
- Anatomy colours: now one flat colour per face with no blending, left and right mirrored.

## Styling switched to Claude look, three themes
- Dropped: the teal accent and IBM Plex type (the agent's own earlier choice, not the user's).
- Now: Claude colours (ivory/slate surfaces, clay accent), a serif brand heading, and a Light / Mid / Dark switch. Mid's grays come from Blender's default theme source file (userdef_default_theme.c): viewport and panels #3d3d3d, editors #303030, widgets #545454, text #e6e6e6.
- The typefaces are free stand-ins (Source Serif 4, system sans, JetBrains Mono); Anthropic's own typefaces are not freely loadable.
- Fixed a phone-width overflow that was already there: the outer grid column sized to its widest child.
