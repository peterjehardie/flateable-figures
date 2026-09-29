// Rig tab: fit a skeleton to the settled figure, swap in another rig, bend-test it, export it.

import { SLOTS, baseRig, computeSlots, fitRig, computeWeights, POSES, poseRotations, deform, poseReport, loadRigFile, rigJSON, toGLB } from './rig.js';
import { saveFile } from './exporter.js';

export function initRigPanel(app, { $, toast, applyShading }) {
  const st = (app.rigState = { rig: baseRig(), fit: null, skin: null, pose: {}, posed: null, report: null });
  const fmt = (v, d = 1) => v.toFixed(d);

  const status = () => {
    const J = st.rig.joints, matched = J.filter((j) => j.slot).length;
    $('rig-status').innerHTML = `<b>${st.rig.name}</b><br>${J.length} joints · ${matched} on body points` + (st.fit ? ' · fitted' : app.sim && app.sim.iter ? ' · not fitted yet' : ' · inflate first, then fit');
  };

  const renderMap = () => {
    const opts = ['<option value="">—</option>', ...SLOTS.map((s) => `<option value="${s}">${s}</option>`)].join('');
    const el = $('rig-map');
    el.innerHTML = st.rig.joints.map((j, i) => `<span class="${j.slot ? '' : 'off'}" title="${j.name}">${j.name}</span><select data-j="${i}" aria-label="Body point for ${j.name}">${opts}</select>`).join('');
    el.querySelectorAll('select').forEach((s) => {
      const j = st.rig.joints[+s.dataset.j];
      s.value = j.slot || '';
      s.onchange = () => { j.slot = s.value || null; fit(); renderMap(); };
    });
  };

  const fit = () => {
    const sim = app.sim;
    if (!sim || !app.model) return false;
    st.fit = null;
    showRest();
    const slots = computeSlots(app.model, sim);
    st.fit = fitRig(st.rig, slots, app.model.measure.H);
    st.skin = computeWeights(sim, st.rig, st.fit);
    app.v3.setSkeleton(st.rig, st.fit);
    status();
    applyPose();
    return true;
  };

  // the mesh at rest (the balloon's own positions)
  const showRest = () => {
    st.posed = null;
    if (app.sim) app.v3.update(app.sim.P, app.sim.N);
    if (st.fit && st.fit.length === st.rig.joints.length) app.v3.setSkeleton(st.rig, st.fit);
  };

  const anyPose = () => Object.values(st.pose).some((v) => v);
  const applyPose = () => {
    const sim = app.sim;
    if (!sim || !st.fit || app.running) return;
    if (!anyPose()) { showRest(); $('pose-report').textContent = ''; if ($('pose-strain').checked) applyShading(); return; }
    const rots = poseRotations(st.rig, st.pose);
    const r = deform(sim, st.rig, st.fit, st.skin, rots, st.posed);
    st.posed = r.pos;
    app.v3.update(r.pos);
    app.v3.setSkeleton(st.rig, r.joints);
    const rep = poseReport(sim.mesh, sim.P, r.pos, st.skin, r.R);
    st.report = rep;
    $('pose-report').innerHTML = `volume ${rep.volume >= 0 ? '+' : ''}${fmt(100 * rep.volume)}% · squashed quads <b>${rep.squashed}</b> · turned over <b>${rep.flipped}</b> of ${rep.quads}`;
    if ($('pose-strain').checked) {
      const cols = new Float32Array(3 * sim.n);
      for (let i = 0; i < sim.n; i++) {
        const s = Math.max(-1, Math.min(1, rep.strain[i] / 0.7));
        cols.set(s < 0 ? [0.8 + 0.6 * s, 0.8 + 0.35 * s, 0.8 + 0.1 * s] : [0.8 + 0.15 * s, 0.8 - 0.55 * s, 0.8 - 0.6 * s], 3 * i);
      }
      app.v3.setColors(cols);
    }
  };

  // sliders
  $('pose-sliders').innerHTML = POSES.map((p) => `<div class="slider"><label for="pose-${p.key}">${p.label}</label><span class="val" id="pose-${p.key}-val">0°</span><input type="range" id="pose-${p.key}" min="0" max="${p.max}" step="1" value="0"></div>`).join('');
  for (const p of POSES) {
    $('pose-' + p.key).oninput = (e) => {
      if (!st.fit && !fit()) { e.target.value = 0; toast('Inflate the figure first'); return; }
      st.pose[p.key] = +e.target.value;
      $(`pose-${p.key}-val`).textContent = e.target.value + '°';
      applyPose();
    };
  }
  const resetPose = () => {
    st.pose = {};
    for (const p of POSES) { $('pose-' + p.key).value = 0; $(`pose-${p.key}-val`).textContent = '0°'; }
    showRest();
    $('pose-report').textContent = '';
    applyShading();
  };
  $('btn-pose-reset').onclick = resetPose;
  $('pose-strain').onchange = () => { if ($('pose-strain').checked) applyPose(); else applyShading(); };
  $('rig-show').onchange = (e) => { const inRig = document.querySelector('.tab[aria-selected="true"]').dataset.tab === 'rig'; app.v3.show.skeleton = e.target.checked && inRig; app.v3.applyVisibility(); };
  $('btn-rig-fit').onclick = () => { if (fit()) toast('Skeleton fitted to the figure'); else toast('Inflate the figure first'); };
  $('btn-rig-base').onclick = () => { st.rig = baseRig(); st.fit = null; renderMap(); fit(); status(); };
  $('btn-rig-load').onclick = () => $('rig-file').click();
  $('rig-file').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const rig = loadRigFile(f.name, new Uint8Array(await f.arrayBuffer()));
      st.rig = rig; st.fit = null;
      renderMap(); fit(); status();
      toast(`${rig.joints.length} joints loaded, ${rig.joints.filter((j) => j.slot).length} matched to body points`);
    } catch (err) { toast('Could not read that rig: ' + err.message); }
  };
  $('btn-glb').onclick = async () => {
    if (!st.fit && !fit()) { toast('Inflate the figure first'); return; }
    const level = +($('exp-level').value || 0);
    try { const r = await saveFile('flateable-figure.glb', new Blob([toGLB(app.sim, level, st.rig, st.fit, st.skin)], { type: 'model/gltf-binary' })); if (r === 'saved') toast('Rigged glTF exported'); }
    catch (err) { toast('Export failed: ' + (err.message || err.code)); }
  };
  $('btn-rig-json').onclick = async () => {
    try { const r = await saveFile('flateable-rig.json', new Blob([rigJSON(st.rig, st.fit)], { type: 'application/json' })); if (r === 'saved') toast('Rig saved as JSON'); }
    catch (err) { toast('Save failed: ' + (err.message || err.code)); }
  };
  renderMap();
  status();

  return {
    // a new mesh: the old fit and pose no longer apply
    onModel() { st.fit = null; st.skin = null; st.posed = null; st.pose = {}; for (const p of POSES) { $('pose-' + p.key).value = 0; $(`pose-${p.key}-val`).textContent = '0°'; } $('pose-report').textContent = ''; app.v3.setSkeleton(null); status(); },
    onSettled() { fit(); },
    onRun() { if (anyPose()) resetPose(); },
    isPosed: () => !!st.posed,
  };
}
