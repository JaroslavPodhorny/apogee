// Render directly into the game's WebGL buffer, then copy it before the browser
// clears it. Preview and export use the same lens, pose and signature layout.
const $ = (id) => document.getElementById(id);
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const LONG_EDGE = 2560;

export function photoMode(renderer, builder, flight, getMode, quiet) {
  const dialog = $('photo'), frame = $('photo-frame'), workspace = $('photo-workspace');
  const preview = $('photo-image'), ratio = $('photo-ratio'), lens = $('photo-lens'), ev = $('photo-ev');
  const status = $('photo-status'), save = $('photo-save');
  const pointers = new Map();
  const share = $('photo-share');
  let lastFile;
  let source, shot, dirty, session = 0, busy = false, pixelRatio;
  function reset() {
    shot = {
      orbit: { ...source.cam }, camera: source.camera.clone(), x: 0, y: 0, gain: 1,
      aim(camera) { camera.rotateY(this.x); camera.rotateX(this.y); }
    };
    lens.value = source.camera.fov;
    ev.value = 0;
    status.textContent = '';
    update();
  }
  function update() {
    shot.camera.fov = Number(lens.value);
    shot.gain = 2 ** Number(ev.value);
    $('lens-value').value = lens.value + '°';
    $('ev-value').value = Number(ev.value).toFixed(1) + ' EV';
    $('photo-grid').hidden = !$('photo-thirds').checked;
    const aspect = Number(ratio.value);
    const w = Math.min(workspace.clientWidth, workspace.clientHeight * aspect);
    frame.style.width = w + 'px';
    frame.style.height = w / aspect + 'px';
    dirty = true;
  }
  const observer = new ResizeObserver(() => { if (dialog.open) update(); });
  observer.observe(workspace);
  function open() {
    if (dialog.open || getMode() === 'title') return;
    source = getMode() === 'flight' ? flight : builder;
    if (source === builder && (builder.held || builder.drag)) {
      builder.flash('Finish placing the part or press Esc before taking a photo.');
      return;
    }
    source.drag = null;
    flight.keys.clear();
    pixelRatio = renderer.getPixelRatio();
    quiet();
    dialog.showModal();
    reset();
    frame.focus();
  }
  function close() {
    if (!dialog.open) return;
    session++;
    dialog.close();
    pointers.clear();
    lastFile = null; share.hidden = true;
    busy = false;
    save.disabled = false;
    renderer.setDrawingBufferSize(innerWidth, innerHeight, pixelRatio);
    if (flight.taa) flight.taa.valid = false;
  }
  function draw(target, longEdge) {
    const aspect = Number(ratio.value);
    const w = Math.max(1, Math.round(longEdge * Math.min(1, aspect)));
    const h = Math.max(1, Math.round(longEdge / Math.max(1, aspect)));
    if (renderer.getPixelRatio() !== 1 || renderer.domElement.width !== w || renderer.domElement.height !== h) {
      renderer.setDrawingBufferSize(w, h, 1);
    }
    if (source === flight) {
      flight.resizePipeline(w, h, 1);
      if (flight.taa) flight.taa.valid = false;
      flight.renderFlight(0, w, h, shot);
    } else {
      const visible = builder.hoverGroup.visible;
      builder.hoverGroup.visible = false;
      try { builder.render(w, h, shot); } finally { builder.hoverGroup.visible = visible; }
    }
    target.width = w; target.height = h;
    const ctx = target.getContext('2d', { alpha: false });
    ctx.drawImage(renderer.domElement, 0, 0);
    if ($('photo-sign').checked) {
      const unit = Math.min(w, h);
      ctx.font = '500 ' + unit * 0.032 + 'px "Barlow Condensed", sans-serif';
      ctx.textAlign = 'right';
      ctx.shadowBlur = unit * 0.008;
      ctx.shadowColor = '#000';
      ctx.fillStyle = '#f3f1ec';
      ctx.fillText('A P O G E E', w - unit * 0.035, h - unit * 0.035);
    }
  }
  function render() {
    if (!dirty) return;
    dirty = false;
    try {
      const size = Math.max(frame.clientWidth, frame.clientHeight) * Math.min(devicePixelRatio, 1.5);
      draw(preview, Math.min(1600, size));
    } catch (err) { console.error(err); status.textContent = 'Preview unavailable. Try resetting the view.'; }
  }
  async function capture() {
    if (busy) return;
    const id = session;
    busy = true; save.disabled = true; status.textContent = 'Preparing PNG…';
    try {
      const image = document.createElement('canvas');
      draw(image, LONG_EDGE);
      const blob = await new Promise((resolve) => image.toBlob(resolve, 'image/png'));
      if (id !== session) return;
      if (!blob) throw new Error('PNG encoding failed');
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      const craft = (source === flight ? flight.world.active?.name : builder.design.name) || 'Rocket';
      const name = craft.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 60);
      link.download = 'Apogee-' + name + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png';
      link.click();
      lastFile = new File([blob], link.download, { type: 'image/png' });
      share.hidden = !navigator.canShare?.({ files: [lastFile] });
      setTimeout(() => URL.revokeObjectURL(link.href), 60000);
      status.textContent = 'PNG ready · ' + image.width + ' × ' + image.height;
    } catch (err) {
      console.error(err);
      status.textContent = 'Couldn’t save this photo. Try again.';
    } finally { if (id === session) { busy = false; save.disabled = false; } }
  }
  function move(dx, dy, pan) {
    if (pan) {
      const radians = shot.camera.fov * Math.PI / 180 / Math.max(1, frame.clientHeight);
      shot.x = clamp(shot.x + dx * radians, -1, 1);
      shot.y = clamp(shot.y + dy * radians, -1, 1);
    } else {
      shot.orbit.az -= dx * 0.006;
      shot.orbit.el = clamp(shot.orbit.el + dy * 0.005, -1.48, 1.48);
    }
    dirty = true;
  }
  function dolly(factor) {
    const inFlight = source === flight;
    shot.orbit.dist = clamp(shot.orbit.dist * factor, inFlight ? 4 : 2.5, inFlight ? 160000 : 400);
    dirty = true;
  }
  frame.onpointerdown = (e) => {
    if (pointers.size >= 2) return;
    frame.focus(); frame.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey });
  };
  frame.onpointermove = (e) => {
    const point = pointers.get(e.pointerId);
    if (!point) return;
    const dx = e.clientX - point.x, dy = e.clientY - point.y;
    if (pointers.size === 2) {
      const other = [...pointers.values()].find(p => p !== point);
      const before = Math.hypot(point.x - other.x, point.y - other.y);
      const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
      if (before > 4 && after > 4) dolly(before / after);
      move(dx / 2, dy / 2, true);
    } else move(dx, dy, point.pan);
    point.x = e.clientX; point.y = e.clientY;
  };
  frame.onlostpointercapture = (e) => pointers.delete(e.pointerId);
  frame.oncontextmenu = (e) => e.preventDefault();
  frame.addEventListener('wheel', (e) => {
    e.preventDefault();
    dolly(Math.exp(clamp(e.deltaY * (e.deltaMode ? 16 : 1), -500, 500) * 0.0015));
  }, { passive: false });
  frame.onkeydown = (e) => {
    const delta = { ArrowLeft: [-8, 0], ArrowRight: [8, 0], ArrowUp: [0, -8], ArrowDown: [0, 8] }[e.key];
    if (delta) { e.preventDefault(); move(...delta, e.shiftKey); }
    if (e.key === 'Enter' && !e.repeat) capture();
  };
  // The hangar also listens on window while dragging parts.
  for (const type of ['keydown', 'keyup', 'pointermove', 'pointerup', 'pointercancel']) {
    dialog.addEventListener(type, (e) => e.stopPropagation());
  }
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'F8' || getMode() === 'title' || document.querySelector('#gfx:not([hidden])')) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (!e.repeat) { if (dialog.open) close(); else open(); }
  }, true);
  dialog.oncancel = (e) => { e.preventDefault(); close(); };
  dialog.oninput = update;
  $('photo-close').onclick = close;
  $('photo-reset').onclick = reset;
  save.onclick = capture;
  share.onclick = async () => {
    try { await navigator.share({ files: [lastFile], title: 'Apogee' }); }
    catch (err) { if (err.name !== 'AbortError') status.textContent = 'Sharing unavailable. Your downloaded PNG is ready to use.'; }
  };
  document.querySelectorAll('.photo-open').forEach(b => { b.onclick = open; });
  return { get active() { return dialog.open; }, render, close };
}
