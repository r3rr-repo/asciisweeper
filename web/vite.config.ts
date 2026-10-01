import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths, so web/dist can be copied to a domain root OR into any
  // subdirectory (https://host/games/sweeper/) with no rebuild.
  base: "./",
  build: {
    target: "es2022",
    assetsInlineLimit: 0, // keep core.wasm a real file, not a base64 data: URI
    rollupOptions: {
      output: { assetFileNames: "assets/[name]-[hash][extname]" },
    },
  },
  server: { port: 5173 },
});
