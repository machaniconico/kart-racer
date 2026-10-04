import { defineConfig } from 'vite';

export default defineConfig({
  base: '/kart-racer/',
  // peerjs is lazy-loaded; pre-bundle it so the first online connect in dev doesn't 504 during optimisation.
  optimizeDeps: { include: ['peerjs'] },
  build: {
    // Keep the geometry/material core and the WebGL renderer independently cached.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('three/build/three.module.js')) return 'three-renderer';
          if (id.includes('three/build/three.core.js')) return 'three-core';
        },
      },
    },
  },
});
