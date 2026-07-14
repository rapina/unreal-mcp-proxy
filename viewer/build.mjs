// Builds the single-file viewer: bundles TS, inlines JS+CSS into one dist/viewer.html.
import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const result = await build({
  entryPoints: [path.join(root, "src/main.ts")],
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  legalComments: "none"
});
const js = result.outputFiles[0].text;
const css = await readFile(path.join(root, "src/style.css"), "utf8");
const template = await readFile(path.join(root, "src/index.html"), "utf8");
const html = template
  .replace("/*__STYLE__*/", () => css)
  .replace("<script>/*__SCRIPT__*/</script>", () => `<script>\n${js}\n</script>`);
await mkdir(path.join(root, "../dist"), { recursive: true });
await writeFile(path.join(root, "../dist/viewer.html"), html, "utf8");
console.log(`viewer.html: ${(html.length / 1024).toFixed(1)}kb`);
