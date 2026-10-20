import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// relative base so the build works at https://<user>.github.io/<repo>/
export default defineConfig( {
  plugins: [ react() ],
  base: "./",
} );