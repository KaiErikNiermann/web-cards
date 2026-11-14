import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// `vite build --mode single` inlines every script, stylesheet, font and image into one
// dist/index.html, which can be opened from disk or published as a single-page artifact.
// `base: "./"` keeps asset URLs relative, so the build works under a GitHub Pages project path.
export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: mode === "single" ? [tailwindcss(), viteSingleFile()] : [tailwindcss()],
  // The single-file build is the card table alone; the normal build adds the /debug pages.
  build:
    mode === "single"
      ? { assetsInlineLimit: Number.MAX_SAFE_INTEGER }
      : { rolldownOptions: { input: { main: "index.html", debug: "debug/index.html", parity: "debug/parity.html" } } },
}));
