import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import manifest from './src/manifest'

const rootDir = dirname(fileURLToPath(import.meta.url))

function emitManifest(): Plugin {
  return {
    name: 'emit-manifest-json',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: JSON.stringify(manifest, null, 2),
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), emitManifest()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(rootDir, 'index.html'),
        background: resolve(rootDir, 'src/background/background.ts'),
        content: resolve(rootDir, 'src/content/scraper.ts'),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
})
