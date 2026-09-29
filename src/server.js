import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { buildItem } from './renderer.js';
import { scanLibrary } from './library.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const contentRoot = path.resolve(process.env.CONTENT_ROOT || '/content');
const dataRoot = path.resolve(process.env.DATA_ROOT || '/data');
const siteRoot = path.join(dataRoot, 'sites');
const templateRoot = path.resolve(process.env.TEMPLATE_ROOT || '/templates');
const defaultTemplateRoot = path.resolve(process.env.DEFAULT_TEMPLATE_ROOT || '/app/default-templates');
const pdfUrl = (process.env.PDF_URL || 'http://pdf:3000').replace(/\/$/, '');
const port = Number(process.env.PORT || 8080);
const revealRoot = path.resolve(here, '../node_modules/reveal.js');
const revealThemes = new Set(['black', 'white', 'league', 'beige', 'sky', 'night', 'serif', 'simple', 'solarized', 'blood', 'moon', 'dracula', 'consulting', 'white-contrast']);
const jobs = new Map();
let buildQueue = Promise.resolve();
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

async function ensureTemplates() {
  await fs.mkdir(templateRoot, { recursive: true });
  const entries = await fs.readdir(defaultTemplateRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9_-]*$/.test(entry.name)) continue;
    const destination = path.join(templateRoot, entry.name);
    try {
      await fs.access(destination);
    } catch {
      await fs.cp(path.join(defaultTemplateRoot, entry.name), destination, { recursive: true, errorOnExist: true });
    }
  }
}

async function readTemplate(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(id)) return null;
  try {
    const directory = path.resolve(templateRoot, id);
    if (!directory.startsWith(`${templateRoot}${path.sep}`)) return null;
    const raw = JSON.parse(await fs.readFile(path.join(directory, 'template.json'), 'utf8'));
    if (raw.id !== id || typeof raw.label !== 'string' || !raw.label.trim()) return null;
    const presentationTheme = revealThemes.has(raw.presentationTheme) ? raw.presentationTheme : 'black';
    const cssPath = path.join(directory, 'theme.css');
    await fs.access(cssPath);
    return { id, label: raw.label, presentationTheme, directory };
  } catch {
    return null;
  }
}

async function listTemplates() {
  const entries = await fs.readdir(templateRoot, { withFileTypes: true });
  const templates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const template = await readTemplate(entry.name);
    if (template) templates.push({ id: template.id, label: template.label, presentationTheme: template.presentationTheme });
  }
  templates.sort((a, b) => a.label.localeCompare(b.label, 'fr'));
  return templates;
}

function emitJob(job, type, payload = {}) {
  const event = { type, at: new Date().toISOString(), ...payload };
  job.events.push(event);
  job.emitter.emit('event', event);
}

async function startBuild(itemId = null) {
  const job = { id: crypto.randomUUID(), events: [], emitter: new EventEmitter(), status: 'running' };
  jobs.set(job.id, job);
  emitJob(job, 'started', { progress: 0, message: 'Analyse du dossier source' });
  buildQueue = buildQueue.then(async () => {
    try {
      const { items, warnings } = await scanLibrary(contentRoot);
      for (const warning of warnings) emitJob(job, 'warning', { message: warning });
      const selected = itemId ? items.filter((item) => item.id === itemId) : items;
      if (itemId && selected.length === 0) throw new Error('Sous-dossier introuvable ou invalide');
      if (selected.length === 0) throw new Error('Aucun sous-dossier avec un fichier .meta valide');
      for (let index = 0; index < selected.length; index += 1) {
        const item = selected[index];
        emitJob(job, 'progress', { progress: index / selected.length, message: `Génération de ${item.title}` });
        await buildItem({
          item,
          contentRoot,
          dataRoot,
          onProgress: ({ progress, message }) => emitJob(job, 'progress', {
            progress: (index + progress) / selected.length,
            current: item.title,
            message,
          }),
        });
      }
      job.status = 'complete';
      emitJob(job, 'complete', { progress: 1, message: 'Tous les contenus sélectionnés sont prêts' });
    } catch (error) {
      job.status = 'failed';
      emitJob(job, 'error', { message: error.message || 'Échec de génération' });
    }
    if (jobs.size > 40) {
      const oldest = jobs.keys().next().value;
      if (oldest !== job.id) jobs.delete(oldest);
    }
  });
  return job;
}

app.get('/health', (_request, response) => response.json({ ok: true }));

app.get('/api/library', async (_request, response) => {
  const result = await scanLibrary(contentRoot);
  const items = await Promise.all(result.items.map(async (item) => {
    let built = false;
    let builtAt = null;
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(siteRoot, item.id, '.lucidoc.json'), 'utf8'));
      built = true;
      builtAt = manifest.builtAt || null;
    } catch {
      try {
        await fs.access(path.join(siteRoot, item.id, 'index.html'));
        built = true;
      } catch { /* Pas encore généré. */ }
    }
    return { ...item, built, builtAt };
  }));
  response.json({ items, warnings: result.warnings });
});

app.get('/api/templates', async (_request, response) => response.json(await listTemplates()));
app.get('/api/templates/:id', async (request, response) => {
  const template = await readTemplate(request.params.id);
  if (!template) return response.status(404).json({ error: 'Template inconnu' });
  response.json({ id: template.id, label: template.label, presentationTheme: template.presentationTheme });
});
app.get('/api/templates/:id/theme.css', async (request, response) => {
  const template = await readTemplate(request.params.id);
  if (!template) return response.status(404).type('text').send('Template inconnu');
  response.type('text/css').set('cache-control', 'no-store');
  response.send(await fs.readFile(path.join(template.directory, 'theme.css')));
});

app.post('/api/build', async (_request, response) => {
  const job = await startBuild();
  response.status(202).json({ id: job.id });
});
app.post('/api/build/:id', async (request, response) => {
  if (!/^[a-f0-9]{16}$/.test(request.params.id)) return response.status(400).json({ error: 'Identifiant invalide' });
  const job = await startBuild(request.params.id);
  response.status(202).json({ id: job.id });
});
app.get('/api/jobs/:id/events', (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) return response.status(404).end();
  response.status(200).set({
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  response.flushHeaders();
  const send = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
  for (const event of job.events) send(event);
  const listener = (event) => send(event);
  job.emitter.on('event', listener);
  const heartbeat = setInterval(() => response.write(': ping\n\n'), 15000);
  request.on('close', () => {
    clearInterval(heartbeat);
    job.emitter.off('event', listener);
  });
});

app.post('/api/export/:id', async (request, response) => {
  const { items } = await scanLibrary(contentRoot);
  const item = items.find((candidate) => candidate.id === request.params.id);
  if (!item || !/^[a-f0-9]{16}$/.test(request.params.id)) return response.status(404).json({ error: 'Contenu introuvable' });
  try {
    await fs.access(path.join(siteRoot, item.id, 'index.html'));
  } catch {
    return response.status(409).json({ error: 'Générez ce contenu avant de créer son PDF' });
  }
  const template = await readTemplate(request.body?.template || 'default');
  if (!template) return response.status(400).json({ error: 'Template inconnu' });
  try {
    const upstream = await fetch(`${pdfUrl}/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: item.id, type: item.type, template: template.id, title: item.title }),
      signal: AbortSignal.timeout(Number(process.env.PDF_TIMEOUT_MS || 100000)),
    });
    if (!upstream.ok) {
      const detail = await upstream.json().catch(() => ({}));
      return response.status(502).json({ error: detail.error || 'Échec du service PDF' });
    }
    const filename = `${item.title.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 80) || item.id}.pdf`;
    response.type('application/pdf').set('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    response.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    response.status(502).json({ error: `Service PDF indisponible: ${error.message}` });
  }
});

const themeScript = `<script>
(()=>{
  const key='lucidoc.template';
  const safeId=/^[a-z0-9][a-z0-9_-]{0,47}$/;
  async function applyTemplate(id){
    if(!safeId.test(id||'')) id='default';
    try {
      const result=await fetch('/api/templates/'+encodeURIComponent(id),{cache:'no-store'});
      const template=result.ok?await result.json():{id:'default',presentationTheme:'black'};
      let css=document.querySelector('[data-lucidoc-custom-theme]');
      if(!css){css=document.createElement('link');css.rel='stylesheet';css.dataset.lucidocCustomTheme='';document.head.append(css)}
      css.href='/api/templates/'+encodeURIComponent(template.id)+'/theme.css';
      const reveal=document.querySelector('[data-lucidoc-reveal-theme]');
      if(reveal) reveal.href='/vendor/reveal/dist/theme/'+encodeURIComponent(template.presentationTheme)+'.css';
    } catch { /* Le style intégré du site reste utilisable. */ }
  }
  const query=new URLSearchParams(location.search).get('template');
  const selected=query||localStorage.getItem(key)||'default';
  if(query) localStorage.setItem(key,query);
  applyTemplate(selected);
  addEventListener('storage',event=>{if(event.key===key)applyTemplate(event.newValue||'default')});
  addEventListener('message',event=>{if(event.origin===location.origin&&event.data?.type==='lucidoc-template')applyTemplate(event.data.id)});
  window.__LUCI_READY__=window.__LUCI_READY__||false;
  document.addEventListener('DOMContentLoaded',()=>{if(!document.querySelector('.reveal'))window.__LUCI_READY__=true});
})();
</script>`;

app.use('/sites', async (request, response, next) => {
  if (!request.path.toLowerCase().endsWith('.html')) return next();
  try {
    const parts = request.path.split('/').filter(Boolean);
    if (parts.length < 2 || !/^[a-f0-9]{16}$/.test(parts[0])) return next();
    const root = path.resolve(siteRoot, parts[0]);
    const filename = path.resolve(root, ...parts.slice(1));
    if (!filename.startsWith(`${root}${path.sep}`)) return response.sendStatus(404);
    let html = await fs.readFile(filename, 'utf8');
    if (html.includes('</head>')) html = html.replace('</head>', `${themeScript}</head>`);
    response.type('html')
      .set('cache-control', 'no-store')
      .set('content-security-policy', "default-src 'self' data: blob:; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; frame-src 'self' data:; object-src 'none'; base-uri 'self'")
      .send(html);
  } catch (error) {
    if (error.code === 'ENOENT') return next();
    next(error);
  }
});

app.use('/sites', express.static(siteRoot, { fallthrough: true, index: 'index.html' }));
app.use('/vendor/reveal', express.static(revealRoot, { fallthrough: false, maxAge: '1d' }));
app.use(express.static(path.join(here, 'public'), { extensions: ['html'] }));

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: 'Erreur interne du service' });
});

await ensureTemplates();
const server = app.listen(port, '0.0.0.0', () => {
  console.log('LuCiDoc disponible sur le port ' + port);
  void startBuild();
});
async function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
