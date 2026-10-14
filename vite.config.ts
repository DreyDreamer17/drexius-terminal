import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig({
  // `useRecommendedBuildConfig` would force *every* asset inline, turning the
  // self-hosted fonts into ~100 KB of incompressible base64 inside index.html.
  // The equivalent settings are applied below, minus that one.
  plugins: [react(), tailwindcss(), viteSingleFile({ useRecommendedBuildConfig: false })],
  base: "./",
  build: {
    cssCodeSplit: false,
    chunkSizeWarningLimit: 100_000_000,
    assetsDir: "",
    // Inline everything into index.html except font binaries, which are emitted
    // next to it (unicode-range subsets only download when actually needed).
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/i.test(file) ? false : true),
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  optimizeDeps: {
    entries: ["index.html"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    headers: {
      "Cache-Control": "no-store",
    },
    watch: {
      ignored: ["**/opencode/**", "**/src-tauri/**"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
