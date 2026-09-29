import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const SOURCE_EXTENSIONS = new Set(['.md', '.markdown', '.adoc', '.asciidoc']);

export function itemId(relativePath) {
  return crypto.createHash('sha256').update(relativePath).digest('hex').slice(0, 16);
}

function parseMeta(contents, directoryName) {
  const values = new Map();
  for (const [index, raw] of contents.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([a-z][a-z0-9_-]*)\s*=\s*(.*?)\s*$/i);
    if (!match) throw new Error(`ligne ${index + 1}: format attendu cle=valeur`);
    const key = match[1].toLowerCase();
    if (!['type', 'title', 'entry'].includes(key)) throw new Error(`clé inconnue « ${key} »`);
    if (values.has(key)) throw new Error(`clé dupliquée « ${key} »`);
    values.set(key, match[2]);
  }

  const type = values.get('type');
  if (!['presentation', 'documentation'].includes(type)) {
    throw new Error('type obligatoire: presentation ou documentation');
  }
  const title = values.get('title') || directoryName;
  if (!title || title.length > 160) throw new Error('title doit contenir entre 1 et 160 caractères');
  const entry = values.get('entry') || '';
  if (type === 'presentation' && !entry) throw new Error('entry obligatoire pour une présentation');
  if (entry && (path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..'))) {
    throw new Error('entry doit rester dans le sous-dossier');
  }
  if (type === 'documentation' && entry) throw new Error('entry ne s’applique pas à la documentation');
  return { type, title, entry };
}

async function walkSource(directory, relative = '') {
  const result = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  for (const entry of entries) {
    if (entry.name === '.meta' || entry.name.startsWith('.')) continue;
    const absolute = path.join(directory, entry.name);
    const childRelative = path.join(relative, entry.name);
    const stats = await fs.lstat(absolute);
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) result.push(...await walkSource(absolute, childRelative));
    else if (stats.isFile()) result.push(childRelative);
  }
  return result;
}

export async function scanLibrary(contentRoot) {
  const items = [];
  const warnings = [];
  let entries;
  try {
    entries = await fs.readdir(contentRoot, { withFileTypes: true });
  } catch (error) {
    return { items, warnings: [`Dossier source inaccessible: ${error.message}`] };
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const directory = path.join(contentRoot, entry.name);
    const metaPath = path.join(directory, '.meta');
    try {
      const stats = await fs.lstat(directory);
      if (stats.isSymbolicLink()) continue;
      const metaStats = await fs.lstat(metaPath);
      if (!metaStats.isFile() || metaStats.isSymbolicLink()) throw new Error('.meta doit être un fichier régulier');
      const meta = parseMeta(await fs.readFile(metaPath, 'utf8'), entry.name);
      const files = await walkSource(directory);
      const markup = files.filter((file) => SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()));
      if (meta.type === 'presentation') {
        const extension = path.extname(meta.entry).toLowerCase();
        if (!SOURCE_EXTENSIONS.has(extension)) throw new Error('entry doit être un fichier Markdown ou AsciiDoc');
        if (!files.includes(meta.entry)) throw new Error(`fichier entry introuvable: ${meta.entry}`);
      } else if (!markup.length) {
        throw new Error('aucun fichier .md, .markdown, .adoc ou .asciidoc trouvé');
      }
      const relativePath = entry.name;
      items.push({ id: itemId(relativePath), relativePath, ...meta, files, documentCount: markup.length });
    } catch (error) {
      warnings.push(`${entry.name}: ${error.message}`);
    }
  }
  return { items, warnings };
}

export function sourcePath(contentRoot, item, relativeFile = '') {
  const root = path.resolve(contentRoot, item.relativePath);
  const target = path.resolve(root, relativeFile);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('chemin source hors du sous-dossier');
  }
  return target;
}
