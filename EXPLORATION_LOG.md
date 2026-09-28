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
