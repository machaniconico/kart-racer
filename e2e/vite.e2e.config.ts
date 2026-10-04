import { defineConfig, mergeConfig } from 'vite';
import appConfig from '../vite.config';

export default mergeConfig(appConfig, defineConfig({
  server: {
    host: '127.0.0.1',
    port: 4174,
    strictPort: true,
    hmr: false,
    watch: null,
  },
}));
