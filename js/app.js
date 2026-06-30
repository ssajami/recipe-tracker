// ── State ──────────────────────────────────────────────────────────────────
const state = {
  recipes: [],
  sha: null,
  view: 'list',
  detailId: null,
  editId: null,         // null = new recipe
  search: '',
  tagFilter: null,
  cookChecked: { ingredients: new Set(), instructions: new Set() },
  importTab: 'text',
  importImageData: null,
  importPreview: null,  // [{recipe, include: true}, ...]
  syncStatus: 'idle',   // 'idle' | 'loading' | 'saving' | 'error'
  viewHistory: [],
};

// Edit-specific mutable state (avoids full re-render on each keystroke)
let editIngredients = [];
let editInstructions = [];
let editTags = [];
let editRating = null;

// ── Helpers ────────────────────────────────────────────────────────────────
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function nl2br(str) { return esc(str).replace(/\n/g, '<br>'); }

function stars(n, large = false) {
  if (!n) return `<span class="no-rating">Not rated</span>`;
  const cls = large ? 'stars-lg' : 'stars';
  return `<span class="${cls}">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</span>`;
}

function tagHtml(t) { return `<span class="tag">${esc(t)}</span>`; }

function uuid() { return crypto.randomUUID(); }

function getAllTags() {
  const set = new Set();
  state.recipes.forEach(r => (r.tags || []).forEach(t => set.add(t)));
  return [...set].sort();
}

function filterRecipes() {
  let list = state.recipes;
  if (state.tagFilter) list = list.filter(r => (r.tags || []).includes(state.tagFilter));
  if (!state.search.trim()) return list;
  const q = state.search.toLowerCase();
  return list.filter(r =>
    [r.title, r.servings, r.prepNotes, r.afterPrepNotes,
     ...(r.ingredients || []), ...(r.instructions || []), ...(r.tags || [])]
      .some(f => f && String(f).toLowerCase().includes(q))
  );
}

// ── Toast & Loading ────────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg, type = 'info', ms = 3000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = type === 'success' ? 'toast-success' : type === 'error' ? 'toast-error' : '';
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

function setLoading(show, msg = 'Loading…') {
  const el = document.getElementById('loading-overlay');
  document.getElementById('loading-text').textContent = msg;
  el.classList.toggle('hidden', !show);
}

// ── Header ─────────────────────────────────────────────────────────────────
function updateHeader(title, showBack, rightHtml = '') {
  document.getElementById('header-title').textContent = title;
  const back = document.getElementById('btn-back');
  back.classList.toggle('hidden', !showBack);
  document.getElementById('header-right').innerHTML = rightHtml;
  updateSyncDot();
}

function updateSyncDot() {
  const dot = document.getElementById('sync-dot');
  if (!dot) return;
  dot.className = 'sync-dot' + (state.syncStatus === 'saving' ? ' syncing' : state.syncStatus === 'error' ? ' error' : '');
  dot.title = state.syncStatus === 'saving' ? 'Saving…' : state.syncStatus === 'error' ? 'Sync error' : 'Synced';
}

// ── Navigation ─────────────────────────────────────────────────────────────
const App = {
  goBack() {
    const prev = state.viewHistory.pop();
    if (prev) {
      state.view = prev.view;
      state.detailId = prev.detailId;
      state.editId = prev.editId;
      render();
    } else {
      this.showList();
    }
  },

  showList() {
    state.viewHistory = [];
    state.view = 'list';
    render();
  },

  showDetail(id) {
    state.viewHistory.push({ view: state.view, detailId: state.detailId, editId: state.editId });
    state.detailId = id;
    state.cookChecked = { ingredients: new Set(), instructions: new Set() };
    state.view = 'detail';
    render();
  },

  showEdit(id) {
    state.viewHistory.push({ view: state.view, detailId: state.detailId, editId: state.editId });
    state.editId = id || null;
    const recipe = id ? state.recipes.find(r => r.id === id) : null;
    editIngredients = recipe ? [...(recipe.ingredients || [''])] : [''];
    editInstructions = recipe ? [...(recipe.instructions || [''])] : [''];
    editTags = recipe ? [...(recipe.tags || [])] : [];
    editRating = recipe ? (recipe.rating || null) : null;
    state.view = 'edit';
    render();
  },

  showAdd() { this.showEdit(null); },

  showImport() {
    state.viewHistory.push({ view: state.view, detailId: state.detailId, editId: state.editId });
    state.importTab = 'text';
    state.importImageData = null;
    state.importPreview = null;
    state.view = 'import';
    render();
  },

  showSettings() {
    const cfg = Storage.getConfig();
    document.getElementById('setting-pat').value   = cfg.pat;
    document.getElementById('setting-claude').value = cfg.claude;
    document.getElementById('setting-owner').value  = cfg.owner;
    document.getElementById('setting-repo').value   = cfg.repo;
    document.getElementById('modal-settings').classList.remove('hidden');
  },

  hideSettings() {
    document.getElementById('modal-settings').classList.add('hidden');
  },

  saveSettings() {
    Storage.setConfig({
      pat:    document.getElementById('setting-pat').value.trim(),
      claude: document.getElementById('setting-claude').value.trim(),
      owner:  document.getElementById('setting-owner').value.trim() || 'ssajami',
      repo:   document.getElementById('setting-repo').value.trim() || 'recipe-tracker',
    });
    this.hideSettings();
    toast('Settings saved', 'success');
  },

  // ── Confirm Dialog ───────────────────────────────────────────────────────
  hideConfirm() { document.getElementById('modal-confirm').classList.add('hidden'); },

  _confirm(msg, onOk) {
    document.getElementById('confirm-msg').textContent = msg;
    const btn = document.getElementById('confirm-ok');
    btn.onclick = () => { this.hideConfirm(); onOk(); };
    document.getElementById('modal-confirm').classList.remove('hidden');
  },

  // ── Sync ─────────────────────────────────────────────────────────────────
  async _syncSave() {
    state.syncStatus = 'saving';
    updateSyncDot();
    try {
      const latest = await Storage.loadRecipes();
      state.sha = await Storage.saveRecipes(state.recipes, latest.sha);
      state.syncStatus = 'idle';
      toast('Saved', 'success');
    } catch (err) {
      state.syncStatus = 'error';
      toast(err.message, 'error', 5000);
      throw err;
    } finally {
      updateSyncDot();
    }
  },

  // ── Recipe CRUD ───────────────────────────────────────────────────────────
  async saveEdit() {
    const title = document.getElementById('edit-title')?.value.trim();
    if (!title) { toast('Title is required', 'error'); return; }

    const existing = state.editId ? state.recipes.find(r => r.id === state.editId) : null;
    const recipe = {
      id:             existing?.id || uuid(),
      title,
      servings:       document.getElementById('edit-servings')?.value.trim() || '',
      ingredients:    editIngredients.filter(s => s.trim()),
      instructions:   editInstructions.filter(s => s.trim()),
      prepNotes:      document.getElementById('edit-prep-notes')?.value.trim() || '',
      afterPrepNotes: document.getElementById('edit-after-notes')?.value.trim() || '',
      rating:         editRating,
      tags:           editTags,
      createdAt:      existing?.createdAt || new Date().toISOString(),
      updatedAt:      new Date().toISOString(),
    };

    if (existing) {
      state.recipes = state.recipes.map(r => r.id === recipe.id ? recipe : r);
    } else {
      state.recipes = [recipe, ...state.recipes];
    }

    try {
      setLoading(true, 'Saving…');
      await this._syncSave();
      state.detailId = recipe.id;
      state.viewHistory = [];
      state.view = 'detail';
      render();
    } catch (_) { /* toast already shown */ } finally { setLoading(false); }
  },

  confirmDelete(id) {
    this._confirm('Delete this recipe? This cannot be undone.', () => this._deleteRecipe(id));
  },

  async _deleteRecipe(id) {
    state.recipes = state.recipes.filter(r => r.id !== id);
    try {
      setLoading(true, 'Deleting…');
      await this._syncSave();
    } catch (_) { /* toast shown */ } finally { setLoading(false); }
    this.showList();
  },

  // ── Edit Form Actions ─────────────────────────────────────────────────────
  setRating(n) {
    editRating = (editRating === n) ? null : n;
    document.getElementById('star-input').innerHTML = renderStarInput();
  },

  addIngredient() {
    editIngredients.push('');
    reRenderIngredients();
    const inputs = document.querySelectorAll('#ingredients-list input');
    inputs[inputs.length - 1]?.focus();
  },
  removeIngredient(i) {
    editIngredients.splice(i, 1);
    if (editIngredients.length === 0) editIngredients.push('');
    reRenderIngredients();
  },
  updateIngredient(i, v) { editIngredients[i] = v; },
  handleIngredientKey(e, i) {
    if (e.key === 'Enter') { e.preventDefault(); this.addIngredient(); }
    if (e.key === 'Backspace' && editIngredients[i] === '' && editIngredients.length > 1) {
      e.preventDefault(); this.removeIngredient(i);
      const inputs = document.querySelectorAll('#ingredients-list input');
      inputs[Math.max(0, i - 1)]?.focus();
    }
  },

  addInstruction() {
    editInstructions.push('');
    reRenderInstructions();
    const tas = document.querySelectorAll('#instructions-list textarea');
    tas[tas.length - 1]?.focus();
  },
  removeInstruction(i) {
    editInstructions.splice(i, 1);
    if (editInstructions.length === 0) editInstructions.push('');
    reRenderInstructions();
  },
  updateInstruction(i, v) { editInstructions[i] = v; },

  addTag(tag) {
    const t = tag.trim().toLowerCase();
    if (t && !editTags.includes(t)) {
      editTags.push(t);
      reRenderTags();
    }
  },
  removeTag(i) { editTags.splice(i, 1); reRenderTags(); },
  handleTagKey(e) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const val = e.target.value.replace(/,/g, '').trim();
      if (val) { this.addTag(val); e.target.value = ''; }
    }
  },

  // ── Detail Checklist ──────────────────────────────────────────────────────
  toggleIngredient(i) {
    const s = state.cookChecked.ingredients;
    s.has(i) ? s.delete(i) : s.add(i);
    const items = document.querySelectorAll('#ingredient-list .checklist-item');
    items[i]?.classList.toggle('checked', s.has(i));
  },
  toggleInstruction(i) {
    const s = state.cookChecked.instructions;
    s.has(i) ? s.delete(i) : s.add(i);
    const items = document.querySelectorAll('#instruction-list .checklist-item');
    items[i]?.classList.toggle('checked', s.has(i));
  },
  clearCookingChecks() {
    state.cookChecked = { ingredients: new Set(), instructions: new Set() };
    document.querySelectorAll('.checklist-item.checked').forEach(el => el.classList.remove('checked'));
  },

  // ── Search & Filter ───────────────────────────────────────────────────────
  onSearch(q) {
    state.search = q;
    document.getElementById('recipe-grid').innerHTML = renderGrid();
  },
  setTagFilter(tag) {
    state.tagFilter = tag;
    render();
  },

  // ── Import: Tab ───────────────────────────────────────────────────────────
  setImportTab(tab) {
    state.importTab = tab;
    state.importImageData = null;
    state.importPreview = null;
    render();
  },

  // ── Import: Text ──────────────────────────────────────────────────────────
  async handleTextImport() {
    const text = document.getElementById('import-text-area')?.value.trim();
    if (!text) { toast('Paste some recipe text first', 'error'); return; }
    setLoading(true, 'Parsing recipes with AI…');
    try {
      const recipes = await AI.parseTextRecipes(text);
      state.importPreview = recipes.map(r => ({ recipe: r, include: true }));
      render();
    } catch (err) {
      toast(err.message, 'error', 6000);
    } finally { setLoading(false); }
  },

  // ── Import: Image ─────────────────────────────────────────────────────────
  handleImageFile(input) {
    const file = input?.files?.[0];
    if (file) this._loadImageFile(file);
  },
  handleImageDrop(e) {
    e.preventDefault();
    document.getElementById('drop-zone')?.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file && file.type.startsWith('image/')) this._loadImageFile(file);
  },
  handleDragOver(e) {
    e.preventDefault();
    document.getElementById('drop-zone')?.classList.add('drag-over');
  },
  _loadImageFile(file) {
    const reader = new FileReader();
    reader.onload = ev => {
      const dataUrl = ev.target.result;
      const base64 = dataUrl.split(',')[1];
      state.importImageData = { base64, mediaType: file.type };
      const preview = document.getElementById('img-preview-area');
      if (preview) {
        preview.innerHTML = `<img src="${dataUrl}" class="image-preview" alt="Recipe screenshot">`;
      }
      const btn = document.getElementById('extract-btn');
      if (btn) btn.disabled = false;
    };
    reader.readAsDataURL(file);
  },
  async handleImageImport() {
    if (!state.importImageData) { toast('Upload an image first', 'error'); return; }
    setLoading(true, 'Extracting recipe with AI…');
    try {
      const recipe = await AI.parseImageRecipe(state.importImageData.base64, state.importImageData.mediaType);
      state.importPreview = [{ recipe, include: true }];
      render();
    } catch (err) {
      toast(err.message, 'error', 6000);
    } finally { setLoading(false); }
  },

  // ── Import: Preview actions ───────────────────────────────────────────────
  toggleImportItem(i) {
    state.importPreview[i].include = !state.importPreview[i].include;
    const btn = document.querySelector(`[data-preview-toggle="${i}"]`);
    if (btn) {
      const item = state.importPreview[i];
      btn.textContent = item.include ? 'Exclude' : 'Include';
      btn.className = item.include ? 'btn-text' : 'btn-text btn-text--muted';
      btn.closest('.import-preview-card').style.opacity = item.include ? '1' : '0.4';
    }
  },

  async confirmImport() {
    const toAdd = state.importPreview.filter(p => p.include).map(p => p.recipe);
    if (!toAdd.length) { toast('No recipes selected', 'error'); return; }
    state.recipes = [...toAdd, ...state.recipes];
    setLoading(true, 'Saving…');
    try {
      await this._syncSave();
      state.importPreview = null;
      state.viewHistory = [];
      state.view = 'list';
      render();
      toast(`${toAdd.length} recipe${toAdd.length > 1 ? 's' : ''} imported!`, 'success');
    } catch (_) { } finally { setLoading(false); }
  },
};

// ── Partial re-renders (avoid full render during edits) ─────────────────────
function reRenderIngredients() {
  document.getElementById('ingredients-list').innerHTML = renderIngredientsList();
}
function reRenderInstructions() {
  document.getElementById('instructions-list').innerHTML = renderInstructionsList();
}
function reRenderTags() {
  document.getElementById('tag-chips').innerHTML = renderTagChips();
}

// ── Render Functions ────────────────────────────────────────────────────────
function render() {
  switch (state.view) {
    case 'list':   renderList();   break;
    case 'detail': renderDetail(); break;
    case 'edit':   renderEdit();   break;
    case 'import': renderImport(); break;
  }
}

function renderList() {
  updateHeader('My Recipes', false, `
    <span id="sync-dot" class="sync-dot" title="Synced"></span>
    <button class="icon-btn" title="Import" onclick="App.showImport()">&#8675;</button>
    <button class="icon-btn" title="Settings" onclick="App.showSettings()">&#9881;</button>
  `);

  const allTags = getAllTags();
  const filtered = filterRecipes();

  document.getElementById('app-main').innerHTML = `
    <div class="search-container">
      <input type="search" class="search-input" placeholder="Search recipes, ingredients, tags…"
             value="${esc(state.search)}" oninput="App.onSearch(this.value)" autocomplete="off">
    </div>
    ${allTags.length ? `
      <div class="tag-filters">
        <button class="tag-pill${!state.tagFilter ? ' active' : ''}" onclick="App.setTagFilter(null)">All</button>
        ${allTags.map(t => `
          <button class="tag-pill${state.tagFilter === t ? ' active' : ''}"
                  onclick="App.setTagFilter('${esc(t)}')">${esc(t)}</button>
        `).join('')}
      </div>` : ''}
    <div id="recipe-grid">${renderGrid()}</div>
    <button class="fab" onclick="App.showAdd()" title="Add recipe">+</button>
  `;

  updateSyncDot();
}

function renderGrid() {
  const filtered = filterRecipes();
  if (!filtered.length) {
    return `<div class="empty-state">
      <div class="empty-icon">🍳</div>
      ${state.recipes.length === 0
        ? `<p>No recipes yet</p><p style="color:var(--text-muted);margin-top:6px;">Add your first recipe</p>
           <button class="btn-primary" style="margin-top:16px" onclick="App.showAdd()">Add Recipe</button>`
        : `<p>No recipes match your search</p>`}
    </div>`;
  }
  return `<div class="recipe-grid">${filtered.map(renderCard).join('')}</div>`;
}

function renderCard(r) {
  const tagHtmls = (r.tags || []).slice(0, 3).map(tagHtml).join('');
  const extra = (r.tags || []).length > 3 ? `<span class="tag-more">+${r.tags.length - 3}</span>` : '';
  return `
    <div class="recipe-card" onclick="App.showDetail('${r.id}')">
      <div class="recipe-card-title">${esc(r.title)}</div>
      <div class="recipe-card-meta">
        ${r.servings ? `<span>🍽 ${esc(r.servings)}</span>` : ''}
        ${r.rating ? stars(r.rating) : ''}
      </div>
      ${(r.tags || []).length ? `<div class="recipe-card-tags">${tagHtmls}${extra}</div>` : ''}
    </div>`;
}

function renderDetail() {
  const r = state.recipes.find(x => x.id === state.detailId);
  if (!r) { App.showList(); return; }

  updateHeader(r.title, true, `
    <button class="btn-text" onclick="App.showEdit('${r.id}')">Edit</button>
  `);

  document.getElementById('app-main').innerHTML = `
    <div class="detail-view">
      <div class="detail-hero">
        <h1>${esc(r.title)}</h1>
        <div class="detail-meta">
          ${r.servings ? `<span>🍽 ${esc(r.servings)}</span>` : ''}
          ${stars(r.rating, true)}
        </div>
        ${(r.tags || []).length ? `<div class="detail-tags">${r.tags.map(tagHtml).join('')}</div>` : ''}
      </div>

      ${r.prepNotes ? `
        <div class="detail-section">
          <h2>Preparation Notes</h2>
          <p class="notes-text">${nl2br(r.prepNotes)}</p>
        </div>` : ''}

      <div class="detail-section">
        <h2>Ingredients <span class="section-hint">(tap to check off)</span></h2>
        <ul class="cooking-checklist" id="ingredient-list">
          ${(r.ingredients || []).map((ing, i) => `
            <li class="checklist-item${state.cookChecked.ingredients.has(i) ? ' checked' : ''}"
                onclick="App.toggleIngredient(${i})">
              <div class="check-box"></div>
              <span class="check-text">${esc(ing)}</span>
            </li>`).join('')}
        </ul>
      </div>

      <div class="detail-section">
        <h2>Instructions <span class="section-hint">(tap to check off)</span></h2>
        <ol class="cooking-checklist" id="instruction-list">
          ${(r.instructions || []).map((step, i) => `
            <li class="checklist-item${state.cookChecked.instructions.has(i) ? ' checked' : ''}"
                onclick="App.toggleInstruction(${i})">
              <div class="check-box"></div>
              <span class="check-text">${esc(step)}</span>
            </li>`).join('')}
        </ol>
      </div>

      ${r.afterPrepNotes ? `
        <div class="detail-section after-notes">
          <h2>Notes After Making</h2>
          <p class="notes-text">${nl2br(r.afterPrepNotes)}</p>
        </div>` : ''}

      <div class="detail-actions">
        <button class="reset-checks-btn" onclick="App.clearCookingChecks()">Reset checks</button>
        <button class="btn-danger" onclick="App.confirmDelete('${r.id}')">Delete recipe</button>
      </div>
    </div>
  `;
}

// ── Edit / Add ──────────────────────────────────────────────────────────────
function renderEdit() {
  const isNew = !state.editId;
  const r = isNew ? null : state.recipes.find(x => x.id === state.editId);

  updateHeader(isNew ? 'New Recipe' : 'Edit Recipe', true, `
    <button class="btn-primary" style="padding:8px 16px" onclick="App.saveEdit()">Save</button>
  `);

  document.getElementById('app-main').innerHTML = `
    <div class="edit-view">
      <div class="form-group">
        <label>Title *</label>
        <input type="text" id="edit-title" value="${esc(r?.title || '')}" placeholder="Recipe name…" autocomplete="off">
      </div>
      <div class="form-group">
        <label>Servings</label>
        <input type="text" id="edit-servings" value="${esc(r?.servings || '')}" placeholder="e.g. 4 servings">
      </div>
      <div class="form-group">
        <label>Rating</label>
        <div id="star-input">${renderStarInput()}</div>
      </div>
      <div class="form-group">
        <label>Tags</label>
        <div id="tag-chips">${renderTagChips()}</div>
        <input type="text" class="tag-text-input" placeholder="Type tag, press Enter…"
               onkeydown="App.handleTagKey(event)" autocomplete="off">
      </div>
      <div class="form-group">
        <label>Ingredients</label>
        <div id="ingredients-list" class="editable-list">${renderIngredientsList()}</div>
        <button type="button" class="btn-add-item" onclick="App.addIngredient()">+ Add ingredient</button>
      </div>
      <div class="form-group">
        <label>Instructions</label>
        <div id="instructions-list" class="editable-list">${renderInstructionsList()}</div>
        <button type="button" class="btn-add-item" onclick="App.addInstruction()">+ Add step</button>
      </div>
      <div class="form-group">
        <label>Preparation Notes</label>
        <textarea id="edit-prep-notes" placeholder="Tips before you start…">${esc(r?.prepNotes || '')}</textarea>
      </div>
      <div class="form-group">
        <label>After Preparation Notes</label>
        <textarea id="edit-after-notes" placeholder="What to do differently next time…">${esc(r?.afterPrepNotes || '')}</textarea>
      </div>
      <div class="form-actions">
        <button class="btn-primary" onclick="App.saveEdit()">Save Recipe</button>
        <button class="btn-secondary" onclick="App.goBack()">Cancel</button>
      </div>
    </div>
  `;
}

function renderStarInput() {
  const btns = [1,2,3,4,5].map(n => `
    <button type="button" class="star-btn${(editRating || 0) >= n ? ' active' : ''}"
            onclick="App.setRating(${n})" title="${n} star${n > 1 ? 's' : ''}">★</button>
  `).join('');
  const clear = editRating
    ? `<button type="button" class="clear-rating" onclick="App.setRating(null)">Clear</button>` : '';
  return `<div class="star-rating-input">${btns}${clear}</div>`;
}

function renderTagChips() {
  return editTags.map((t, i) => `
    <span class="tag removable">${esc(t)}
      <button type="button" onclick="App.removeTag(${i})">×</button>
    </span>`).join('');
}

function renderIngredientsList() {
  return editIngredients.map((ing, i) => `
    <div class="editable-item">
      <input type="text" value="${esc(ing)}" placeholder="Ingredient…"
             oninput="App.updateIngredient(${i}, this.value)"
             onkeydown="App.handleIngredientKey(event, ${i})">
      <button type="button" class="btn-remove" onclick="App.removeIngredient(${i})">×</button>
    </div>`).join('');
}

function renderInstructionsList() {
  return editInstructions.map((step, i) => `
    <div class="editable-item">
      <span class="step-num">${i + 1}</span>
      <textarea placeholder="Step ${i + 1}…"
                oninput="App.updateInstruction(${i}, this.value)">${esc(step)}</textarea>
      <button type="button" class="btn-remove" onclick="App.removeInstruction(${i})">×</button>
    </div>`).join('');
}

// ── Import ──────────────────────────────────────────────────────────────────
function renderImport() {
  updateHeader('Import Recipe', true);

  if (state.importPreview) {
    renderImportPreview();
    return;
  }

  document.getElementById('app-main').innerHTML = `
    <div class="import-view">
      <div class="import-tabs">
        <button class="import-tab${state.importTab === 'text' ? ' active' : ''}"
                onclick="App.setImportTab('text')">📋 Paste Text</button>
        <button class="import-tab${state.importTab === 'image' ? ' active' : ''}"
                onclick="App.setImportTab('image')">📷 Screenshot</button>
      </div>
      ${state.importTab === 'text' ? renderTextImport() : renderImageImport()}
    </div>
  `;
}

function renderTextImport() {
  return `
    <div class="import-panel">
      <p class="help-text">Paste one or more recipes in any format. The AI will identify and separate each recipe automatically.</p>
      <textarea id="import-text-area" placeholder="Paste recipe text here…" rows="14"></textarea>
      <button class="btn-primary" onclick="App.handleTextImport()">Parse with AI</button>
    </div>`;
}

function renderImageImport() {
  return `
    <div class="import-panel">
      <p class="help-text">Upload or paste a screenshot of a recipe. The AI will extract the title, ingredients, instructions, and notes.</p>
      <div class="drop-zone" id="drop-zone"
           onclick="document.getElementById('img-file-input').click()"
           ondragover="App.handleDragOver(event)"
           ondrop="App.handleImageDrop(event)">
        <span class="drop-icon">📷</span>
        <p>Click to upload, drag &amp; drop, or paste (Ctrl+V)</p>
        <p style="color:var(--text-muted);font-size:0.8rem;margin-top:4px">PNG, JPG, WEBP supported</p>
      </div>
      <input type="file" id="img-file-input" accept="image/*" style="display:none"
             onchange="App.handleImageFile(this)">
      <div id="img-preview-area"></div>
      <button class="btn-primary" id="extract-btn"
              ${state.importImageData ? '' : 'disabled'}
              onclick="App.handleImageImport()">Extract with AI</button>
    </div>`;
}

function renderImportPreview() {
  const items = state.importPreview;
  const previewList = items.map((p, i) => `
    <div class="import-preview-card" style="opacity:${p.include ? 1 : 0.4}">
      <div class="import-preview-info">
        <div class="import-preview-title">${esc(p.recipe.title)}</div>
        <div class="import-preview-meta">
          ${(p.recipe.ingredients || []).length} ingredients ·
          ${(p.recipe.instructions || []).length} steps
          ${p.recipe.servings ? ` · ${esc(p.recipe.servings)}` : ''}
        </div>
        ${(p.recipe.tags || []).length ? `<div style="margin-top:6px">${p.recipe.tags.map(tagHtml).join('')}</div>` : ''}
      </div>
      <div class="import-preview-actions">
        <button data-preview-toggle="${i}"
                class="btn-text${p.include ? '' : ' btn-text--muted'}"
                onclick="App.toggleImportItem(${i})">${p.include ? 'Exclude' : 'Include'}</button>
      </div>
    </div>
  `).join('');

  document.getElementById('app-main').innerHTML = `
    <div class="import-view">
      <p class="help-text" style="margin-bottom:12px">
        Found <strong>${items.length} recipe${items.length > 1 ? 's' : ''}</strong>. Review and confirm what to import.
      </p>
      <div class="import-preview-list">${previewList}</div>
      <div style="display:flex;gap:10px;margin-top:8px">
        <button class="btn-primary" onclick="App.confirmImport()">Save to My Recipes</button>
        <button class="btn-secondary" onclick="App.setImportTab(state.importTab)">Back</button>
      </div>
    </div>
  `;
}

// ── Init ────────────────────────────────────────────────────────────────────
async function init() {
  // Support clipboard paste for images on the import screen
  document.addEventListener('paste', e => {
    if (state.view !== 'import' || state.importTab !== 'image') return;
    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        App._loadImageFile(item.getAsFile());
        break;
      }
    }
  });

  // Close modals on backdrop click
  document.getElementById('modal-settings').addEventListener('click', e => {
    if (e.target.id === 'modal-settings') App.hideSettings();
  });
  document.getElementById('modal-confirm').addEventListener('click', e => {
    if (e.target.id === 'modal-confirm') App.hideConfirm();
  });

  setLoading(true, 'Loading recipes…');
  try {
    const { recipes, sha } = await Storage.loadRecipes();
    state.recipes = recipes;
    state.sha = sha;
  } catch (err) {
    toast(err.message, 'error', 6000);
  } finally {
    setLoading(false);
  }

  render();

  // Prompt settings on first launch if PAT is missing
  const { pat } = Storage.getConfig();
  if (!pat) {
    setTimeout(() => {
      toast('Set your GitHub PAT in Settings to save changes ⚙', 'info', 5000);
    }, 800);
  }
}

init();
