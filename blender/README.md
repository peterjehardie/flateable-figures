Exploration build, not a committed tool. Nothing here is a convention or a rule.

# Flateable for Blender

A Blender add-on (4.3 or newer; tested headless on 5.0.1) with three steps, all in the
3D View sidebar under **Flateable**:

1. **Sketch.** *New Sketch* makes a Grease Pencil object with a **Front** layer and a **Side**
   layer, plus a front and a side orthographic camera. *Draw Front* turns the view to front,
   picks the Front layer and locks drawing to the XZ plane. *Draw Side* does the same for the side
   (YZ plane). With *Mirror front* on, draw only the figure's left half (the +X side), ending
   the outline on the centre line.
2. **Base mesh.** *Inflate to Base Mesh* fills both outlines and inflates them:
   - **Front:** every point of the front shape becomes as thick as the largest ball that fits
     the outline around it, so arms and legs come out round.
   - **Side:** the side outline then sets the front-to-back depth at each height and cuts the
     profile (belly, back, nose, heel).

   The result is voxel remeshed, then QuadriFlow makes an all-quad mesh, and a Multires modifier
   is added so sculpting can start at once. About 10 s for a whole figure at the defaults.
3. **Patch retopology.** *Draw Patch Borders* makes a Grease Pencil drawing whose strokes stick
   to the surface of the sculpt (the **Surface** stroke placement). Draw the loops you want.
   *Build Patches* then does the rest:
   - Each place where strokes cross becomes a corner, and each region enclosed by strokes becomes
     a patch.
   - Edge counts are chosen so neighbouring patches agree, and every patch is filled with quads.
   - The result is the **FF Retopo** object; with *Mirror X* it gets a Mirror modifier, and the
     centre line is added for you.

## Drawing patches that fill

- Every patch needs 3 to 6 corners. A four-sided patch becomes a clean grid. A 3-, 5- or
  6-sided patch gets one pole (a point where 3, 5 or 6 edges meet) in its middle.
- Where a border has too many corners or does not fit, the tool adds a corner on a straight run
  or drops the softest bend. The panel reports how many.
- A stroke must cross or end on another stroke. A loose loop is reported as touching nothing, and
  the patch around it is filled as if it were not there.
- A region with more than 9 corners is left open and reported: draw a line across it.
- *Edge length* sets the density; *Corner angle* sets how sharp a turn must be to count as a
  corner.

## Install

Zip the contents of `flateable_blender/` so that `blender_manifest.toml` is at the zip's root.
Then use Edit > Preferences > Get Extensions > Install from Disk. As a legacy add-on, zip the
folder itself instead.

## Headless test

```
pip install bpy            # Blender as a Python module (Python 3.11)
node blender/tests/dump_figure.mjs male > /tmp/male.json
python blender/tests/pipeline_test.py /tmp/male.json /tmp/out.blend
```

## Method and sources

- **Patch retopology** follows Takayama, Panozzo, Sorkine-Hornung and Sorkine-Hornung,
  "Sketch-Based Generation and Editing of Quad Meshes", SIGGRAPH 2013: strokes on a surface form
  patches, and patches are filled from edge counts.
- **The fill here is simpler than theirs.** It uses a grid, or one centre point with spokes,
  plus added or dropped corners. The complete pattern set with guaranteed success is in
  Takayama, Panozzo and Sorkine-Hornung, "Pattern-Based Quadrangulation for N-Sided Patches",
  SGP 2014. That paper is not implemented here.
- **Inflation** is a union of inscribed balls computed with separable distance transforms
  (Felzenszwalb and Huttenlocher), with the surface extracted by surface nets.
- **The quad base** is Blender's built-in QuadriFlow (Huang et al. 2018).
