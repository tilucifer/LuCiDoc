import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import puppeteer from 'puppeteer-core';

const app = express();
const port = Number(process.env.PORT || 3000);
const appUrl = new URL(process.env.APP_URL || 'http://aggregator:8080');
const exportRoot = path.resolve(process.env.EXPORT_ROOT || '/exports');
const timeoutMs = Number(process.env.PDF_TIMEOUT_MS || 90000);
let browserPromise;

app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

function browser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
  }
  return browserPromise;
}

app.get('/health', (_request, response) => response.json({ ok: true }));

app.post('/render', async (request, response) => {
  const { id, type, template, title } = request.body || {};
  if (!/^[a-f0-9]{16}$/.test(id || '') || !['presentation', 'documentation'].includes(type)) {
    return response.status(400).json({ error: 'Demande PDF invalide' });
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(template || '')) {
    return response.status(400).json({ error: 'Template invalide' });
  }

  let page;
  try {
    await fs.mkdir(exportRoot, { recursive: true });
    const filename = `${id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.pdf`;
    const destination = path.join(exportRoot, filename);
    page = await (await browser()).newPage();
    page.setDefaultNavigationTimeout(timeoutMs);
    page.setDefaultTimeout(timeoutMs);
    await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
    await page.setRequestInterception(true);
    page.on('request', (outgoing) => {
      try {
        const target = new URL(outgoing.url());
        if (target.origin === appUrl.origin || ['data:', 'blob:'].includes(target.protocol)) outgoing.continue();
        else outgoing.abort('blockedbyclient');
      } catch {
        outgoing.abort('blockedbyclient');
      }
    });

    const target = new URL(`/sites/${id}/index.html`, appUrl);
    target.searchParams.set('template', template);
    if (type === 'presentation') target.searchParams.set('print-pdf', '');
    const navigation = await page.goto(target.href, { waitUntil: 'networkidle0', timeout: timeoutMs });
    if (!navigation?.ok) throw new Error(`Le lecteur a répondu avec le statut ${navigation?.status() ?? 'inconnu'}`);
    await page.waitForFunction(() => window.__LUCI_READY__ === true, { timeout: timeoutMs });
    await page.evaluate(async () => {
      if (document.fonts?.ready) await document.fonts.ready;
      await Promise.all(Array.from(document.images, (image) => image.decode?.().catch(() => undefined)));
      if (window.Reveal?.layout) window.Reveal.layout();
    });
    await page.emulateMediaType('print');

    await page.pdf({
      path: destination,
      format: 'A4',
      landscape: type === 'presentation',
      printBackground: true,
      preferCSSPageSize: type === 'presentation',
      margin: type === 'presentation'
        ? { top: '0', right: '0', bottom: '0', left: '0' }
        : { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' },
      tagged: true,
      timeout: timeoutMs,
    });
    response.type('application/pdf');
    response.set('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${String(title || id).slice(0, 80)}.pdf`)}`);
    response.send(await fs.readFile(destination));
  } catch (error) {
    console.error(`PDF ${id}: ${error.message}`);
    response.status(500).json({ error: `La génération PDF a échoué: ${error.message}` });
  } finally {
    await page?.close().catch(() => {});
  }
});

const server = app.listen(port, '0.0.0.0', () => console.log(`Service PDF sur le port ${port}`));
async function shutdown() {
  server.close();
  try { await (await browserPromise)?.close(); } catch { /* Le processus s’arrête. */ }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
