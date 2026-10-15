import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

// pdf.js loads these at runtime: wasm decoders (JBIG2 / JPEG 2000 scans),
// CMaps for CJK fonts, standard fonts and ICC profiles. Served under /pdfjs/
// in dev and copied into the build.
const PDFJS_DIRS = ['wasm', 'cmaps', 'standard_fonts', 'iccs'];
const pdfjsRoot = path.resolve('node_modules/pdfjs-dist');

function pdfjsAssets(): Plugin {
  return {
    name: 'pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '');
        const file = path.join(pdfjsRoot, rel);
        if (!PDFJS_DIRS.includes(rel.split('/')[0]) || !file.startsWith(pdfjsRoot + path.sep)) return next();
        fs.readFile(file, (err, buf) => {
          if (err) return next();
          if (file.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
          res.end(buf);
        });
      });
    },
    generateBundle() {
      for (const dir of PDFJS_DIRS)
        for (const name of fs.readdirSync(path.join(pdfjsRoot, dir)))
          this.emitFile({
            type: 'asset',
            fileName: `pdfjs/${dir}/${name}`,
            source: fs.readFileSync(path.join(pdfjsRoot, dir, name)),
          });
    },
  };
}

export default defineConfig({
  plugins: [react(), pdfjsAssets()],
  base: './',
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', target: 'esnext' },
});
