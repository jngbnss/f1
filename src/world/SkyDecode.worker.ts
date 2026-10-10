/// <reference lib="webworker" />
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';

/**
 * Decodes a sky EXR off the main thread (DWAA decoding takes ~0.5 s, a visible
 * hitch at the start of a race). Gets a URL, answers with the pixels (moved, not
 * copied) and the texture settings; see loadSkyExr in Environment.ts.
 */
self.onmessage = async (e: MessageEvent<{ url: string }>) => {
  try {
    const res = await fetch(e.data.url);
    if (!res.ok) throw new Error(`${res.status} ${e.data.url}`);
    const out = new EXRLoader().parse(await res.arrayBuffer());
    const data = out.data as Uint16Array | Float32Array;
    self.postMessage({ ok: true, width: out.width, height: out.height, data, format: out.format, type: out.type, colorSpace: out.colorSpace }, [data.buffer]);
  } catch (err) {
    self.postMessage({ ok: false, error: String(err) });
  }
};
