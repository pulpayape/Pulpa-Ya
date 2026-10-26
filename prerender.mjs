// prerender.mjs — Genera la versión final de la web con tus textos y productos reales YA escritos en el HTML,
// para que Google los lea sin depender de JavaScript. Lo ejecuta GitHub Actions automáticamente.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const PORT = 4173;
const SKIP = new Set(['node_modules', 'dist', '.git', '.github', 'prerender.mjs', 'package.json', 'package-lock.json', 'README.md']);

// 1) Copiar los archivos del sitio a dist/
await fs.rm(DIST, { recursive: true, force: true });
await fs.mkdir(DIST, { recursive: true });
for (const name of await fs.readdir(ROOT)) {
  if (SKIP.has(name)) continue;
  await fs.cp(path.join(ROOT, name), path.join(DIST, name), { recursive: true });
}

// 2) Traer la configuración más reciente desde tu Apps Script (si falla, se usa config.json del repositorio)
const appJs = await fs.readFile(path.join(ROOT, 'app.js'), 'utf8');
const m = appJs.match(/const API_URL\s*=\s*'([^']+)'/);
let cfgText = await fs.readFile(path.join(ROOT, 'config.json'), 'utf8');
if (m && /^https:\/\/script\.google\.com\//.test(m[1])) {
  try {
    const r = await fetch(m[1] + (m[1].includes('?') ? '&' : '?') + 'api=config', { redirect: 'follow' });
    const o = JSON.parse(await r.text());
    if (o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length) {
      cfgText = JSON.stringify(o);
      console.log('Configuración leída desde Apps Script.');
    } else {
      console.log('Apps Script devolvió la configuración vacía: se usa config.json del repositorio.');
    }
  } catch (e) {
    console.log('No se pudo leer Apps Script (' + e.message + '): se usa config.json del repositorio.');
  }
} else {
  console.log('API_URL no está configurada en app.js: se usa config.json del repositorio.');
}
await fs.writeFile(path.join(DIST, 'config.json'), cfgText);

// 2b) Servidor local solo para esta construcción
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
                '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const server = http.createServer(async (req, res) => {
  let p = path.normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[\/\\])+/, '');
  if (p.endsWith('/') || p.endsWith('\\')) p += 'index.html';
  try {
    const body = await fs.readFile(path.join(DIST, p));
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('no encontrado'); }
});
await new Promise(r => server.listen(PORT, r));

// 3) Abrir la página como lo haría un visitante y esperar a que cargue tu configuración
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route('**/*', route => route.request().url().includes('script.google.com') ? route.abort() : route.continue());
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForFunction(() => !document.documentElement.classList.contains('cargando'), null, { timeout: 30000 });
  await page.waitForTimeout(1500);

  // 4) Limpiar lo que no debe quedar en el HTML público
  await page.evaluate(() => {
    const holder = document.getElementById('admin-dom-holder');
    if (holder) holder.remove();
    document.documentElement.classList.remove('cargando');
  });

  const title = (await page.locator('#hero-title').innerText()).trim();
  const productos = await page.evaluate(() => (document.getElementById('productos') || { innerText: '' }).innerText.length);
  if (!title) throw new Error('La portada salió vacía: no se publica esta versión.');
  const html = '<!DOCTYPE html>\n' + await page.evaluate(() => document.documentElement.outerHTML);
  if (html.includes('admin-modal')) throw new Error('El panel admin quedó en el HTML: no se publica esta versión.');
  await fs.writeFile(path.join(DIST, 'index.html'), html);
  console.log(`OK · Título de portada: "${title}" · texto de productos: ${productos} caracteres · HTML: ${Math.round(html.length / 1024)} KB`);
} finally {
  await browser.close();
  server.close();
}

// 5) Actualizar la fecha del sitemap
try {
  const sm = await fs.readFile(path.join(DIST, 'sitemap.xml'), 'utf8');
  const hoy = new Date().toISOString().slice(0, 10);
  await fs.writeFile(path.join(DIST, 'sitemap.xml'), sm.replace(/<lastmod>.*?<\/lastmod>/g, `<lastmod>${hoy}</lastmod>`));
} catch {}
