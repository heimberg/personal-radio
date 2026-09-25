import { defineConfig } from 'vite';

// Relative assets work on subpaths as well as on a dedicated hostname.
export default defineConfig({ base: './', build: { sourcemap: false } });
