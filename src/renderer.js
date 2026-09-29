import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Asciidoctor from 'asciidoctor';
import { sourcePath } from './library.js';

const asciidoctor = Asciidoctor();
const MARKUP_EXTENSIONS = new Set(['.md', '.markdown', '.adoc', '.asciidoc']);
const KROKI_TYPES = new Set([
  'actdiag', 'blockdiag', 'bpmn', 'bytefield', 'ditaa', 'erd', 'excalidraw',
  'graphviz', 'mermaid', 'nomnoml', 'nwdiag', 'packetdiag', 'plantuml', 'rackdiag',
  'seqdiag', 'structurizr', 'svgbob', 'umlet', 'vega', 'vegalite', 'wavedrom', 'wireviz',
]);

const quoteYaml = (value) => JSON.stringify(String(value));

async function copySourceTree(from, to, relative = '') {
  await fs.mkdir(to, { recursive: true });
  const entries = await fs.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.meta' || entry.name.startsWith('.')) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    const stats = await fs.lstat(source);
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) await copySourceTree(source, target, path.join(relative, entry.name));
    else if (stats.isFile()) await fs.copyFile(source, target);
  }
}

async function requestKroki(type, source) {
  const endpoint = `${(process.env.KROKI_URL || 'http://kroki:8000').replace(/\/$/, '')}/${type}/svg`;
  let lastError;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'text/plain; charset=utf-8', accept: 'image/svg+xml' },
        body: source,
        signal: AbortSignal.timeout(45000),
      });
      if (!response.ok) throw new Error(`Kroki ${type}: HTTP ${response.status} ${await response.text()}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (/HTTP 4\d\d/.test(error.message) || attempt === 12) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(5000, attempt * 1000)));
    }
  }
  throw lastError;
}

async function writeDiagram(outputDirectory, type, source, diagramIndex) {
  const digest = Buffer.from(`${type}\0${source}`).toString('base64url').slice(0, 24);
  const relative = path.posix.join('_diagrams', `${diagramIndex}-${digest}.svg`);
  const destination = path.join(outputDirectory, relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, await requestKroki(type, source));
  return relative;
}

async function transformMarkdown(markdown, outputDirectory, pageRelative = '') {
  const lines = markdown.split(/\r?\n/);
  const result = [];
  let diagramIndex = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const opening = lines[index].match(/^\s*(`{3,}|~{3,})\s*([\w+-]+)(?:\s+.*)?$/);
    if (!opening) {
      result.push(lines[index]);
      continue;
    }
    const fence = opening[1];
    const language = opening[2].toLowerCase();
    const type = language === 'dot' ? 'graphviz' : language;
    let closing = index + 1;
    while (closing < lines.length && !new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`).test(lines[closing])) closing += 1;
    if (!KROKI_TYPES.has(type) || closing >= lines.length) {
      result.push(lines[index]);
      continue;
    }
    const source = lines.slice(index + 1, closing).join('\n');
    const image = await writeDiagram(outputDirectory, type, source, diagramIndex++);
    const relativeImage = path.posix.relative(path.posix.dirname(pageRelative || '.'), image);
    result.push(`<img class="lucidoc-diagram" src="${relativeImage}" alt="Diagramme ${type}" />`);
    index = closing;
  }
  return result.join('\n');
}

async function transformAsciiDocDiagrams(asciidoc, outputDirectory, pageRelative = '') {
  const pattern = /(^|\n)\[(plantuml|mermaid|graphviz|dot|erd|ditaa|seqdiag|blockdiag|nwdiag|packetdiag|rackdiag|actdiag|vega|vegalite|wavedrom|bytefield|nomnoml|structurizr|svgbob|umlet|wireviz)\]\s*\r?\n-{4,}\r?\n([\s\S]*?)\r?\n-{4,}(?=\r?\n|$)/gi;
  let index = 0;
  let output = '';
  let cursor = 0;
  for (const match of asciidoc.matchAll(pattern)) {
    const start = match.index + match[1].length;
    output += asciidoc.slice(cursor, start);
    let type = match[2].toLowerCase();
    if (type === 'dot') type = 'graphviz';
    const image = await writeDiagram(outputDirectory, type, match[3], index++);
    const relativeImage = path.posix.relative(path.posix.dirname(pageRelative || '.'), image);
    output += `image::${relativeImage}[Diagramme ${type},width=100%]`;
    cursor = match.index + match[0].length;
  }
  return output + asciidoc.slice(cursor);
}

function markdownPageFromAsciiDoc(html, relativeFile) {
  const title = path.basename(relativeFile, path.extname(relativeFile)).replaceAll('-', ' ').replaceAll('_', ' ');
  return `# ${title}\n\n<div class="lucidoc-asciidoc">\n${html}\n</div>\n`;
}

function mkdocsConfig(title) {
  return `site_name: ${quoteYaml(title)}\n` +
    `docs_dir: docs\nsite_dir: site\nuse_directory_urls: false\n` +
    `theme:\n  name: material\n  font: false\n  features:\n    - navigation.sections\n    - navigation.tracking\n    - content.code.copy\n` +
    `plugins:\n  - search\n` +
    `markdown_extensions:\n  - toc:\n      permalink: true\n  - admonition\n  - pymdownx.details\n  - pymdownx.superfences\n` +
    `extra_css:\n  - assets/lucidoc-base.css\n`;
}

function runMkDocs(configPath, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('/opt/venv/bin/mkdocs', ['build', '--strict', '--config-file', configPath], {
      cwd,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(`MkDocs a échoué (code ${code})\n${output}`)));
  });
}

async function buildPresentation({ item, sourceRoot, stage, report }) {
  const site = path.join(stage, 'site');
  await copySourceTree(sourceRoot, site);
  const entryAbsolute = sourcePath(process.env.CONTENT_ROOT || '/content', item, item.entry);
  const entryText = await fs.readFile(entryAbsolute, 'utf8');
  const entryExtension = path.extname(item.entry).toLowerCase();
  let slidesMarkup;
  if (entryExtension === '.md' || entryExtension === '.markdown') {
    const entryOutput = path.join(site, item.entry);
    await fs.mkdir(path.dirname(entryOutput), { recursive: true });
    await fs.writeFile(entryOutput, await transformMarkdown(entryText, site, item.entry));
    slidesMarkup = `<section data-markdown="${escapeHtml(item.entry)}" data-separator="^\\r?\\n---\\r?\\n$"></section>`;
  } else {
    const prepared = await transformAsciiDocDiagrams(entryText, site, item.entry);
    const parts = prepared.split(/(?=^==\s)/m).map((part) => part.trim()).filter(Boolean);
    slidesMarkup = parts.map((part) => {
      const html = asciidoctor.convert(part, {
        safe: 'safe',
        standalone: false,
        base_dir: path.dirname(entryAbsolute),
        attributes: { 'allow-uri-read': false },
      });
      const assetPrefix = path.posix.dirname(item.entry);
      const withLocalAssets = assetPrefix === '.' ? html : html.replace(/\b(src|href)="(?![a-z][a-z0-9+.-]*:|\/|#)([^"]+)"/gi, (_all, attribute, url) => `${attribute}="${assetPrefix}/${url}"`);
      return `<section>${withLocalAssets}</section>`;
    }).join('\n');
  }

  await fs.writeFile(path.join(site, '.lucidoc.json'), JSON.stringify({ type: 'presentation', title: item.title }));
  await fs.writeFile(path.join(site, 'index.html'), `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(item.title)}</title>
<link rel="stylesheet" href="/vendor/reveal/dist/reset.css">
<link rel="stylesheet" href="/vendor/reveal/dist/reveal.css">
<link rel="stylesheet" href="/vendor/reveal/dist/theme/black.css" data-lucidoc-reveal-theme>
<link rel="stylesheet" href="/vendor/reveal/dist/print/pdf.css" media="print">
<link rel="stylesheet" href="/api/templates/default/theme.css" data-lucidoc-custom-theme>
<style>.lucidoc-diagram{max-height:58vh;max-width:100%;background:#fff;padding:.4em;border-radius:.3em}.reveal .slides section{text-align:left}.reveal .slides section:has(> h1),.reveal .slides section:has(> h2:first-child){text-align:center}</style>
</head><body><div class="reveal"><div class="slides">${slidesMarkup}</div></div>
<script src="/vendor/reveal/dist/reveal.js"></script><script src="/vendor/reveal/plugin/markdown/markdown.js"></script>
<script>window.__LUCI_READY__=false;Reveal.on('ready',()=>{window.__LUCI_READY__=true});Reveal.initialize({hash:true,slideNumber:true,controls:true,progress:true,center:true,pdfSeparateFragments:false,plugins:[RevealMarkdown]});</script>
</body></html>`);
  report(0.9, 'Deck Reveal.js prêt');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

async function buildDocumentation({ item, sourceRoot, stage, report }) {
  const work = path.join(stage, 'mkdocs');
  const docs = path.join(work, 'docs');
  const output = path.join(stage, 'site');
  await copySourceTree(sourceRoot, docs);
  await fs.mkdir(path.join(docs, 'assets'), { recursive: true });
  await fs.writeFile(path.join(docs, 'assets', 'lucidoc-base.css'), `
html{scroll-behavior:smooth}body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.lucidoc-diagram{display:block;max-width:100%;max-height:70vh;margin:1rem auto;background:#fff;padding:.5rem;border:1px solid #d8dee9;border-radius:.4rem}
.lucidoc-asciidoc{line-height:1.65}.lucidoc-asciidoc pre{overflow:auto;padding:1rem;background:#f2f4f8;border-radius:.4rem}
.lucidoc-asciidoc table{border-collapse:collapse}.lucidoc-asciidoc th,.lucidoc-asciidoc td{border:1px solid #cbd5e1;padding:.45rem .7rem}
`);
  const sourceFiles = [];
  async function collect(directory, relative = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.meta' || entry.name.startsWith('.')) continue;
      const next = path.join(relative, entry.name);
      const absolute = path.join(directory, entry.name);
      const stats = await fs.lstat(absolute);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) await collect(absolute, next);
      else if (stats.isFile() && MARKUP_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) sourceFiles.push(next);
    }
  }
  await collect(sourceRoot);
  sourceFiles.sort((a, b) => a.localeCompare(b, 'fr'));

  for (let index = 0; index < sourceFiles.length; index += 1) {
    const relative = sourceFiles[index];
    const extension = path.extname(relative).toLowerCase();
    const source = await fs.readFile(sourcePath(process.env.CONTENT_ROOT || '/content', item, relative), 'utf8');
    const destinationRelative = relative.slice(0, -extension.length) + '.md';
    const destination = path.join(docs, destinationRelative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    let content;
    if (extension === '.adoc' || extension === '.asciidoc') {
      const transformed = await transformAsciiDocDiagrams(source, docs, relative);
      const html = asciidoctor.convert(transformed, {
        safe: 'safe', standalone: false,
        base_dir: path.dirname(sourcePath(process.env.CONTENT_ROOT || '/content', item, relative)),
        attributes: { 'allow-uri-read': false },
      });
      content = markdownPageFromAsciiDoc(html, relative);
    } else {
      content = await transformMarkdown(source, docs, relative);
    }
    await fs.writeFile(destination, content);
    report(0.2 + 0.48 * ((index + 1) / Math.max(sourceFiles.length, 1)), `Préparation des pages (${index + 1}/${sourceFiles.length})`);
  }

  const hasIndex = sourceFiles.some((file) => ['index.md', 'index.markdown'].includes(file.toLowerCase()));
  if (!hasIndex) {
    await fs.writeFile(path.join(docs, 'index.md'), `# ${item.title}\n\nDocumentation disponible dans l’arborescence.\n`);
  }
  await fs.writeFile(path.join(work, 'mkdocs.yml'), mkdocsConfig(item.title));
  report(0.74, 'Construction du site MkDocs Material');
  await runMkDocs(path.join(work, 'mkdocs.yml'), work);
  await fs.mkdir(output, { recursive: true });
  await fs.cp(path.join(work, 'site'), output, { recursive: true });
  await fs.writeFile(path.join(output, '.lucidoc.json'), JSON.stringify({ type: 'documentation', title: item.title }));
}

export async function buildItem({ item, contentRoot, dataRoot, onProgress = () => {} }) {
  const siteDirectory = path.join(dataRoot, 'sites', item.id);
  const stage = path.join(dataRoot, 'work', item.id);
  const sourceRoot = path.resolve(contentRoot, item.relativePath);
  await fs.rm(stage, { recursive: true, force: true });
  await fs.rm(siteDirectory, { recursive: true, force: true });
  await fs.mkdir(stage, { recursive: true });
  const report = (progress, message) => onProgress({ progress, message });
  report(0.08, `Lecture de ${item.title}`);
  if (item.type === 'presentation') {
    await buildPresentation({ item, sourceRoot, stage, report });
    await fs.cp(path.join(stage, 'site'), siteDirectory, { recursive: true });
  } else {
    await buildDocumentation({ item, sourceRoot, stage, report });
    await fs.cp(path.join(stage, 'site'), siteDirectory, { recursive: true });
  }
  const builtAt = new Date().toISOString();
  const manifestPath = path.join(siteDirectory, '.lucidoc.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, builtAt }));
  await fs.rm(stage, { recursive: true, force: true });
  report(1, 'Génération terminée');
  return { id: item.id, builtAt };
}
