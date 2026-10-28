// Bouwt de statische site in docs/ (geschikt voor GitHub Pages of een andere
// statische host). De modellen zelf komen bij eerste gebruik van Hugging Face
// en worden daarna in de browser bewaard.
import { build } from "esbuild";
import { cp, mkdir, rm, copyFile, readdir } from "node:fs/promises";

const out = "docs";
await rm(out, { recursive: true, force: true });
await mkdir(`${out}/assets`, { recursive: true });

await build({
  entryPoints: ["src/app.js", "src/voz-worker.js"],
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  conditions: ["browser"],
  target: ["safari17", "chrome120"],
  outdir: `${out}/assets`,
  minify: true,
  legalComments: "linked",
  logLevel: "info",
});

// De rekenkernen worden via new URL("…wasm", import.meta.url) geladen, dus ze
// moeten naast de gebundelde scripts staan.
await copyFile("node_modules/@desert-ant-labs/voz/dist/VozWeb.wasm", `${out}/assets/VozWeb.wasm`);
await copyFile("node_modules/@desert-ant-labs/who/dist/WhoWeb.wasm", `${out}/assets/WhoWeb.wasm`);

// Runtimes van ONNX Runtime (Voz) en LiteRT.js (Who), zelf gehost en dus
// vastgepind op de geïnstalleerde versie.
await mkdir(`${out}/ort`, { recursive: true });
for (const f of await readdir("node_modules/onnxruntime-web/dist")) {
  if (f.startsWith("ort-wasm-simd-threaded.asyncify.")) {
    await copyFile(`node_modules/onnxruntime-web/dist/${f}`, `${out}/ort/${f}`);
  }
}
await cp("node_modules/@litertjs/core/wasm", `${out}/litert`, { recursive: true });

await copyFile("src/index.html", `${out}/index.html`);
await copyFile("src/manifest.webmanifest", `${out}/manifest.webmanifest`);
await copyFile("src/icon.svg", `${out}/icon.svg`);
// GitHub Pages: geen Jekyll-verwerking.
await copyFile("src/.nojekyll", `${out}/.nojekyll`);
