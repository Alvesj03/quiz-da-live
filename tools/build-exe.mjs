// Gera o programa Quiz-da-Live.exe (Node "single executable") a partir deste projeto.
// Roda na nuvem do GitHub (veja .github/workflows/compilar-exe.yml). Também funciona no seu computador:
//   npm install && npm install --no-save esbuild@0.25.10 postject@1.0.0-alpha.6 && node tools/build-exe.mjs
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const OUT = 'build';
const EXE = path.join(OUT, process.platform === 'win32' ? 'Quiz-da-Live.exe' : 'Quiz-da-Live');
const skipLib = process.argv.includes('--sem-tiktok'); // só para testes sem a biblioteca instalada

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 1) Junta o servidor e a biblioteca do TikTok num arquivo só.
await build({
  entryPoints: ['server.mjs'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(OUT, 'server.cjs'),
  define: { 'import.meta.url': '__IMPORT_META_URL__' },
  banner: { js: "const __IMPORT_META_URL__ = require('url').pathToFileURL(__filename).href;" },
  external: ['bufferutil', 'utf-8-validate', ...(skipLib ? ['tiktok-live-connector'] : [])],
  logLevel: 'info'
});

// 2) Embute a pasta public dentro do programa.
const assets = {};
for (const f of fs.readdirSync('public')) assets[`public/${f}`] = path.join('public', f);
const cfg = path.join(OUT, 'sea-config.json');
fs.writeFileSync(cfg, JSON.stringify({
  main: path.join(OUT, 'server.cjs'),
  output: path.join(OUT, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  assets
}, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', cfg], { stdio: 'inherit' });

// 3) Copia o Node, injeta o jogo e pronto.
fs.copyFileSync(process.execPath, EXE);
execFileSync(process.execPath, [
  path.join('node_modules', 'postject', 'dist', 'cli.js'),
  EXE, 'NODE_SEA_BLOB', path.join(OUT, 'sea-prep.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
], { stdio: 'inherit' });

console.log(`\nPronto: ${EXE}`);
