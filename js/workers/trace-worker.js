/**
 * LowRider Forge — bitmap trace worker.
 *
 * Was a copy-paste of bitmap-tracer.js. Now it just imports that module so
 * the algorithm only exists in one place — any fix lands in both contexts.
 */
self.onmessage = function (ev) {
  try {
    // Import lazily so a worker spawn doesn't pay the cost until a job
    // arrives. The tracer attaches to self.Forge.BitmapTracer.
    if (!self.Forge || !self.Forge.BitmapTracer) {
      self.importScripts('../bitmap-tracer.js');
    }
    var p = ev.data || {};
    var width = p.width | 0, height = p.height | 0;
    var rgba = new Uint8ClampedArray(p.rgba);
    // Re-pack into an ImageData-shaped object the tracer accepts.
    var img = { width: width, height: height, data: rgba };
    var opts = {
      threshold: p.threshold, minAreaPx: p.minAreaPx,
      mmPerPixel: p.mmPerPixel, simplifyMm: p.simplifyMm
    };
    var geometry = self.Forge.BitmapTracer.traceImageData(img, opts);
    if (geometry && geometry.trace) geometry.trace.worker = true;
    self.postMessage({ ok: true, geometry: geometry });
  } catch (e) {
    self.postMessage({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
