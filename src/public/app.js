const state = { items: [], selected: null, template: 'default', eventSource: null, toastTimer: null };
const el = (selector) => document.querySelector(selector);

async function request(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try { message = (await response.json()).error || message; } catch { /* Réponse non JSON. */ }
    throw new Error(message);
  }
  return response;
}

function notify(message, error = false) {
  const toast = el('#toast');
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.classList.add('visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('visible'), 3800);
}

function setBuilding(isBuilding, failed = false) {
  const buildState = el('#build-state');
  buildState.classList.toggle('working', isBuilding);
  buildState.classList.toggle('failed', failed);
  buildState.querySelector('span:last-child').textContent = isBuilding ? 'Génération…' : failed ? 'À corriger' : 'Prêt';
  for (const button of [el('#build-all'), el('#build-current'), el('#welcome-build'), el('#empty-build')]) {
    if (button) button.disabled = isBuilding;
  }
}

function groupedItems() {
  return {
    presentation: state.items.filter((item) => item.type === 'presentation'),
    documentation: state.items.filter((item) => item.type === 'documentation'),
  };
}

function renderTree() {
  const query = el('#filter').value.trim().toLocaleLowerCase('fr');
  const groups = groupedItems();
  const sections = [
    { type: 'presentation', title: 'Présentations', icon: '▣' },
    { type: 'documentation', title: 'Documentation', icon: '▤' },
  ];
  const tree = el('#tree');
  const markup = sections.map((section) => {
    const items = groups[section.type].filter((item) => `${item.title} ${item.relativePath}`.toLocaleLowerCase('fr').includes(query));
    if (!items.length) return '';
    return `<section class="tree-section"><div class="tree-section-title"><span class="tree-glyph" aria-hidden="true">${section.icon}</span>${section.title}</div><ul class="tree-list">${items.map((item) => `
      <li class="tree-item"><button class="tree-button${state.selected?.id === item.id ? ' active' : ''}" data-item="${item.id}" type="button" title="${escapeHtml(item.title)}">
        <span class="tree-folder" aria-hidden="true">▱</span><span class="tree-label">${escapeHtml(item.title)}</span><span class="tree-status${item.built ? ' ready' : ''}" title="${item.built ? 'Généré' : 'À générer'}"></span>
      </button></li>`).join('')}</ul></section>`;
  }).join('');
  tree.innerHTML = markup || `<div class="tree-empty">${state.items.length ? 'Aucun contenu ne correspond à ce filtre.' : 'Aucun contenu valide. Ajoutez un sous-dossier avec un fichier .meta.'}</div>`;
  tree.querySelectorAll('[data-item]').forEach((button) => button.addEventListener('click', () => selectItem(button.dataset.item)));
  el('#item-count').textContent = String(state.items.length);
  const warnings = el('#warnings');
  const items = state.warnings || [];
  warnings.hidden = items.length === 0;
  warnings.innerHTML = items.length ? `<strong>Éléments ignorés</strong><ul>${items.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>` : '';
}

function renderSelected() {
  const welcome = el('#welcome');
  const reader = el('#reader');
  if (!state.selected) {
    welcome.hidden = false;
    reader.hidden = true;
    return;
  }
  welcome.hidden = true;
  reader.hidden = false;
  el('#reader-kind').textContent = state.selected.type === 'presentation' ? 'Présentation' : 'Documentation';
  el('#reader-title').textContent = state.selected.title;
  const frame = el('#viewer');
  const empty = el('#empty-reader');
  reader.classList.toggle('not-built', !state.selected.built);
  empty.hidden = state.selected.built;
  if (state.selected.built) {
    const target = `/sites/${state.selected.id}/index.html?template=${encodeURIComponent(state.template)}`;
    if (frame.getAttribute('src') !== target) frame.src = target;
  } else {
    frame.src = 'about:blank';
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

async function loadLibrary() {
  const response = await request('/api/library');
  const library = await response.json();
  state.items = library.items;
  state.warnings = library.warnings;
  if (state.selected) state.selected = state.items.find((item) => item.id === state.selected.id) || null;
  renderTree();
  renderSelected();
}

async function loadTemplates() {
  const response = await request('/api/templates');
  const templates = await response.json();
  const select = el('#template-select');
  select.innerHTML = templates.map((template) => `<option value="${escapeHtml(template.id)}">${escapeHtml(template.label)}</option>`).join('');
  const stored = localStorage.getItem('lucidoc.template');
  state.template = templates.some((template) => template.id === stored) ? stored : (templates.find((template) => template.id === 'default')?.id || templates[0]?.id || 'default');
  select.value = state.template;
  if (state.selected?.built) renderSelected();
}

function selectItem(id) {
  state.selected = state.items.find((item) => item.id === id) || null;
  renderTree();
  renderSelected();
}

async function startBuild(itemId = null) {
  if (state.eventSource) state.eventSource.close();
  el('#progress-panel').hidden = false;
  el('#progress-message').textContent = 'Analyse des sources…';
  el('#progress-percent').textContent = '0%';
  el('#progress-bar').style.width = '0%';
  setBuilding(true);
  try {
    const endpoint = itemId ? `/api/build/${itemId}` : '/api/build';
    const response = await request(endpoint, { method: 'POST' });
    const { id } = await response.json();
    state.eventSource = new EventSource(`/api/jobs/${id}/events`);
    state.eventSource.onmessage = async ({ data }) => {
      const event = JSON.parse(data);
      if (event.progress !== undefined) {
        const percent = Math.max(0, Math.min(100, Math.round(event.progress * 100)));
        el('#progress-percent').textContent = `${percent}%`;
        el('#progress-bar').style.width = `${percent}%`;
      }
      if (event.message) el('#progress-message').textContent = event.message;
      if (event.type === 'complete') {
        state.eventSource.close();
        state.eventSource = null;
        setBuilding(false);
        await loadLibrary();
        el('#progress-panel').hidden = true;
        notify(itemId ? 'Contenu généré.' : 'Tous les contenus sont générés.');
      } else if (event.type === 'error') {
        state.eventSource.close();
        state.eventSource = null;
        setBuilding(false, true);
        el('#progress-message').textContent = event.message;
        notify(event.message, true);
      } else if (event.type === 'warning') {
        notify(event.message, true);
      }
    };
    state.eventSource.onerror = () => {
      if (!state.eventSource) return;
      state.eventSource.close();
      state.eventSource = null;
      setBuilding(false, true);
      notify('La connexion au suivi de génération a été interrompue.', true);
    };
  } catch (error) {
    setBuilding(false, true);
    el('#progress-message').textContent = error.message;
    notify(error.message, true);
  }
}

async function exportPdf() {
  if (!state.selected) return;
  const button = el('#export-pdf');
  button.disabled = true;
  button.innerHTML = '<span class="spinner small"></span> Création…';
  try {
    const response = await request(`/api/export/${state.selected.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ template: state.template }),
    });
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${state.selected.title.replace(/[^\p{L}\p{N}._-]+/gu, '_')}.pdf`;
    anchor.click();
    URL.revokeObjectURL(url);
    notify('PDF prêt au téléchargement.');
  } catch (error) {
    notify(error.message, true);
  } finally {
    button.disabled = false;
    button.innerHTML = '<span aria-hidden="true">↓</span> Exporter PDF';
  }
}

async function toggleFullscreen() {
  const reader = el('#reader');
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await reader.requestFullscreen();
  } catch {
    const wrapper = el('.viewer-frame');
    if (!document.fullscreenElement) await wrapper.requestFullscreen();
  }
}

el('#build-all').addEventListener('click', () => startBuild());
el('#welcome-build').addEventListener('click', () => startBuild());
el('#build-current').addEventListener('click', () => state.selected && startBuild(state.selected.id));
el('#empty-build').addEventListener('click', () => state.selected && startBuild(state.selected.id));
el('#export-pdf').addEventListener('click', exportPdf);
el('#fullscreen').addEventListener('click', toggleFullscreen);
el('#filter').addEventListener('input', renderTree);
el('#template-select').addEventListener('change', (event) => {
  state.template = event.target.value;
  localStorage.setItem('lucidoc.template', state.template);
  if (state.selected?.built) {
    el('#viewer').contentWindow?.postMessage({ type: 'lucidoc-template', id: state.template }, location.origin);
  }
});
document.addEventListener('fullscreenchange', () => {
  const active = Boolean(document.fullscreenElement);
  el('#fullscreen').innerHTML = active ? '<span aria-hidden="true">⛶</span> Mode intégré' : '<span aria-hidden="true">⛶</span> Plein écran';
  el('#fullscreen').setAttribute('aria-label', active ? 'Revenir au mode intégré' : 'Passer en plein écran');
});

try {
  await Promise.all([loadLibrary(), loadTemplates()]);
} catch (error) {
  el('#tree').innerHTML = `<div class="tree-empty">Impossible de joindre les services : ${escapeHtml(error.message)}</div>`;
}
