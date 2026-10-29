// Bouwt de statische site in docs/ (geschikt voor GitHub Pages of een andere
// statische host). De modellen zelf komen bij eerste gebruik van Hugging Face
// en worden daarna in de browser bewaard.
import { build } from "esbuild";
import { cp, mkdir, rm, copyFile, readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

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

// Service worker met de lijst van alle bestanden en een versie die verandert
// zodra een bestand verandert.
const files = (await readdir(out, { recursive: true, withFileTypes: true }))
  .filter((d) => d.isFile() && !d.name.startsWith(".") && !d.name.endsWith(".LEGAL.txt"))
  .map((d) => path.relative(out, path.join(d.parentPath, d.name)).split(path.sep).join("/"))
  .sort();
const hash = createHash("sha256");
for (const f of files) hash.update(f).update(await readFile(`${out}/${f}`));
const sw = (await readFile("src/sw.js", "utf8"))
  .replace("__VERSION__", hash.digest("hex").slice(0, 12))
  .replace("__FILES__", JSON.stringify(["./", ...files]));
await writeFile(`${out}/sw.js`, sw);
