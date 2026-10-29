// Voz in een eigen thread, zodat de pagina (timer, niveaumeter, scrollen)
// blijft reageren terwijl er getranscribeerd wordt.
import { Voz } from "@desert-ant-labs/voz";

let voz = null;

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === "load") {
      voz ??= await Voz.load({
        wasmDir: data.wasmDir,
        cache: data.cache,
        onProgress: (f) => self.postMessage({ id, progress: f }),
      });
      self.postMessage({ id, done: true });
    } else if (type === "transcribe") {
      const r = await voz.transcribe(data.samples, {
        onProgress: (f) => self.postMessage({ id, progress: f }),
      });
      self.postMessage({ id, done: true, result: { words: r.words, duration: r.duration } });
    }
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};
