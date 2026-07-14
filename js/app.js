// ── State ──────────────────────────────────────────────────────────────────
const state = {
  recipes: [],
  sha: null,
  view: 'list',
  detailId: null,
  editId: null,         // null = new recipe
  search: '',
  tagFilter: new Set(),
  ratingFilter: null,
  cookChecked: { ingredients: new Set(), instructions: new Set() },
  qtyMultiplier: 1,
  importTab: 'text',
  importImages: [],       // [{base64, mediaType, dataUrl}, ...]
  importUrl: '',
  importPreview: null,  // [{recipe, include: true}, ...]
  syncStatus: 'idle',   // 'idle' | 'loading' | 'saving' | 'error'
  viewHistory: [],
  pantry: new Set(),
  shoppingContext: 'single',
  shoppingSelected: new Set(),
  shopPickerOpen: true,
  shopHaveOpen: false,
  chatMessages: [],
  chatOpen: false,
  chatLoading: false,
  notes: '',
  notesOpen: false,
};

// Edit-specific mutable state (avoids full re-render on each keystroke)
let editIngredients = [];
let editIngredientLinks = []; // parallel array: recipeId or null per ingredient
let editInstructions = [];
let editTags = [];
let editRating = null;
let editPinned = false;

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

// ── Ingredient object helpers ────────────────────────────────────────────────
function migrateIngredient(s) {
  if (s && typeof s === 'object') return s;
  const raw = (s || '').trim();
  // Strip leading number (integer, decimal, fraction, mixed fraction)
  const numRe = /^(\d+\s+\d+\/\d+|\d+\/\d+|\d+\.?\d*)/;
  const nm = raw.match(numRe);
  if (!nm) return { qty: '', name: raw };
  let rest = raw.slice(nm[0].length).trim();
  const unitRe = /^(cups?|tbsps?|tablespoons?|tsps?|teaspoons?|g\b|grams?|kg\b|ml\b|l\b|lbs?\b|oz\b|ounces?|pounds?|pinch(?:es)?|dash(?:es)?|cloves?|slices?|pieces?|cans?|jars?|stalks?|sprigs?|heads?|bunches?|scoops?|handfuls?|quarts?|pints?)\b/i;
  const um = rest.match(unitRe);
  const qty = um ? `${nm[0]} ${um[0]}` : nm[0];
  if (um) rest = rest.slice(um[0].length).trim();
  return { qty, name: rest || raw };
}

function ingDisplay(ing) {
  if (!ing) return '';
  if (typeof ing === 'string') return ing;
  return [ing.qty, ing.name].filter(Boolean).join(' ');
}

function normalizeIngredient(ing) {
  if (ing && typeof ing === 'object') return ing.name.toLowerCase().trim();
  return (ing || '')
    .replace(/^[\d¼½¾⅓⅔⅛⅜⅝⅞⅙⅚\s\/\.,-]+/, '')
    .replace(/^(cups?|tbsps?|tsps?|tablespoons?|teaspoons?|grams?|g\b|kg\b|ml\b|l\b|lbs?|oz\b|ounces?|pounds?|pinch(es)?|dash(es)?|handful|bunch(es)?|cloves?|slices?|pieces?|cans?|jars?|stalks?|sprigs?|heads?|quarts?|pints?)\s+/i, '')
    .toLowerCase()
    .trim();
}

function getAllTags() {
  const set = new Set();
  state.recipes.forEach(r => (r.tags || []).forEach(t => set.add(t)));
  return [...set].sort();
}

function filterRecipes() {
  let list = [...state.recipes];
  if (state.tagFilter.size) list = list.filter(r => [...state.tagFilter].every(t => (r.tags || []).includes(t)));
  if (state.ratingFilter) list = list.filter(r => (r.rating || 0) >= state.ratingFilter);
  if (state.search.trim()) {
    const q = state.search.toLowerCase();
    list = list.filter(r =>
      [r.title, r.servings, r.prepNotes, r.afterPrepNotes,
       ...(r.ingredients || []).map(ingDisplay), ...(r.instructions || []), ...(r.tags || [])]
        .some(f => f && String(f).toLowerCase().includes(q))
    );
  }
  list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  return list;
}

// ── Toast & Loading ────────────────────────────────────────────────────────
let toastTimer = null;
let _pantryTimer = null;
let _notesTimer = null;
let _dragState = null; // { type, fromIndex, touchEl, touchClone }
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
    const recipe = state.recipes.find(x => x.id === id);
    state.qtyMultiplier = /creami/i.test(recipe?.servings || '') ? 0.5 : /delux/i.test(recipe?.servings || '') ? 1/3 : 1;
    state.chatMessages = [];
    state.chatOpen = false;
    state.chatLoading = false;
    state.view = 'detail';
    render();
  },

  showEdit(id) {
    state.viewHistory.push({ view: state.view, detailId: state.detailId, editId: state.editId });
    state.editId = id || null;
    const recipe = id ? state.recipes.find(r => r.id === id) : null;
    editIngredients = recipe ? recipe.ingredients.map(migrateIngredient) : [{ qty: '', name: '' }];
    editIngredientLinks = recipe ? [...(recipe.ingredientLinks || [])] : [];
    editInstructions = recipe ? [...(recipe.instructions || [''])] : [''];
    editTags = recipe ? [...(recipe.tags || [])] : [];
    editRating = recipe ? (recipe.rating || null) : null;
    editPinned = recipe ? (recipe.pinned || false) : false;
    state.chatMessages = [];
    state.chatOpen = false;
    state.view = 'edit';
    render();
  },

  showAdd() { this.showEdit(null); },

  showImport() {
    state.viewHistory.push({ view: state.view, detailId: state.detailId, editId: state.editId });
    state.importTab = 'text';
    state.importImages = [];
    state.importUrl = '';
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

  backupRecipes() {
    const data = { recipes: state.recipes, pantry: [...state.pantry], notes: state.notes };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `recipes-backup-${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
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
      state.sha = await Storage.saveRecipes(state.recipes, [...state.pantry], state.notes, latest.sha);
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
      source:         document.getElementById('edit-source')?.value.trim() || '',
      ingredients:    editIngredients.filter(ing => ing.name.trim()),
      ingredientLinks: (() => {
        const kept = editIngredients
          .map((ing, i) => ing.name.trim() ? editIngredientLinks[i] || null : null)
          .filter((_, i) => editIngredients[i].name.trim());
        return kept.some(Boolean) ? kept : undefined;
      })(),
      instructions:   editInstructions.filter(s => s.trim()),
      prepNotes:      document.getElementById('edit-prep-notes')?.value.trim() || '',
      afterPrepNotes: document.getElementById('edit-after-notes')?.value.trim() || '',
      rating:         editRating,
      tags:           editTags,
      pinned:         editPinned,
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
      state.viewHistory = [];
      state.view = 'list';
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
  toggleEditPin() {
    editPinned = !editPinned;
    const btn = document.getElementById('edit-pin-btn');
    if (btn) { btn.classList.toggle('active', editPinned); btn.title = editPinned ? 'Unpin' : 'Pin to top'; }
  },

  setRating(n) {
    editRating = (editRating === n) ? null : n;
    document.getElementById('star-input').innerHTML = renderStarInput();
  },

  addIngredient() {
    editIngredients.push({ qty: '', name: '' });
    editIngredientLinks.push(null);
    reRenderIngredients();
    const inputs = document.querySelectorAll('#ingredients-list .ing-qty-input');
    inputs[inputs.length - 1]?.focus();
  },
  removeIngredient(i) {
    editIngredients.splice(i, 1);
    editIngredientLinks.splice(i, 1);
    if (editIngredients.length === 0) { editIngredients.push({ qty: '', name: '' }); editIngredientLinks.push(null); }
    reRenderIngredients();
  },
  updateIngredient(i, field, v) { editIngredients[i] = { ...editIngredients[i], [field]: v }; },

  onIngNameInput(i, value) {
    this.updateIngredient(i, 'name', value);
    const sug = document.getElementById(`ing-sug-${i}`);
    if (!sug) return;
    const q = value.trim().toLowerCase();
    if (q.length < 3) { sug.classList.add('hidden'); return; }
    const names = new Map();
    for (const r of state.recipes) {
      for (const ing of (r.ingredients || [])) {
        const n = (typeof ing === 'object' ? ing.name : normalizeIngredient(ing)).trim();
        if (!n) continue;
        const nl = n.toLowerCase();
        if (nl.includes(q) && nl !== q) names.set(nl, n);
      }
    }
    const items = [...names.values()]
      .sort((a, b) => {
        const al = a.toLowerCase(), bl = b.toLowerCase();
        return (bl.startsWith(q) ? 1 : 0) - (al.startsWith(q) ? 1 : 0) || al.localeCompare(bl);
      })
      .slice(0, 8);
    if (!items.length) { sug.classList.add('hidden'); return; }
    sug.innerHTML = items.map(n =>
      `<div class="ing-sug-item" onmousedown="App.applyIngSuggestion(${i},'${n.replace(/'/g, "\\'")}')">
        ${esc(n)}
      </div>`
    ).join('');
    sug.classList.remove('hidden');
  },
  applyIngSuggestion(i, name) {
    editIngredients[i] = { ...editIngredients[i], name };
    reRenderIngredients();
    document.querySelectorAll('.ing-name-input')[i]?.focus();
  },
  hideIngSuggestions(i) {
    document.getElementById(`ing-sug-${i}`)?.classList.add('hidden');
  },

  setIngredientLink(i, recipeId) {
    editIngredientLinks[i] = recipeId || null;
    reRenderIngredients();
  },

  // ── Drag-to-reorder ───────────────────────────────────────────────────────
  dragStart(e, index, type) {
    _dragState = { type, fromIndex: index };
    e.dataTransfer.effectAllowed = 'move';
    e.currentTarget.closest('.editable-item').classList.add('dragging');
  },
  dragOver(e, index, type) {
    if (!_dragState || _dragState.type !== type) return;
    e.preventDefault();
    document.querySelectorAll('.editable-item.drag-over').forEach(el => el.classList.remove('drag-over'));
    e.currentTarget.closest('.editable-item').classList.add('drag-over');
  },
  dragDrop(e, index, type) {
    if (!_dragState || _dragState.type !== type) return;
    e.preventDefault();
    const arr = type === 'ing' ? editIngredients : editInstructions;
    const [item] = arr.splice(_dragState.fromIndex, 1);
    arr.splice(index, 0, item);
    if (type === 'ing') {
      const [link] = editIngredientLinks.splice(_dragState.fromIndex, 1);
      editIngredientLinks.splice(index, 0, link);
    }
    _dragState = null;
    type === 'ing' ? reRenderIngredients() : reRenderInstructions();
  },
  dragEnd(e) {
    document.querySelectorAll('.editable-item.dragging, .editable-item.drag-over')
      .forEach(el => el.classList.remove('dragging', 'drag-over'));
    _dragState = null;
  },

  // Touch drag support
  touchDragStart(e, index, type) {
    const handle = e.currentTarget;
    const item = handle.closest('.editable-item');
    const rect = item.getBoundingClientRect();
    const clone = item.cloneNode(true);
    clone.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;opacity:0.85;pointer-events:none;z-index:9999;background:var(--surface);box-shadow:0 4px 16px rgba(0,0,0,0.2);border-radius:8px;`;
    document.body.appendChild(clone);
    item.classList.add('dragging');
    _dragState = { type, fromIndex: index, touchEl: item, touchClone: clone, startY: e.touches[0].clientY };
    e.preventDefault();
  },
  touchDragMove(e) {
    if (!_dragState?.touchClone) return;
    e.preventDefault();
    const touch = e.touches[0];
    const dy = touch.clientY - _dragState.startY;
    const origRect = _dragState.touchEl.getBoundingClientRect();
    _dragState.touchClone.style.top = (origRect.top + dy) + 'px';
    // Highlight target row
    document.querySelectorAll('.editable-item.drag-over').forEach(el => el.classList.remove('drag-over'));
    const el = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('.editable-item');
    if (el && el !== _dragState.touchEl) el.classList.add('drag-over');
  },
  touchDragEnd(e) {
    if (!_dragState) return;
    const touch = e.changedTouches[0];
    const targetItem = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('.editable-item');
    _dragState.touchClone?.remove();
    document.querySelectorAll('.editable-item.dragging, .editable-item.drag-over')
      .forEach(el => el.classList.remove('dragging', 'drag-over'));
    if (targetItem) {
      const list = _dragState.type === 'ing' ? '#ingredients-list' : '#instructions-list';
      const items = [...document.querySelectorAll(`${list} .editable-item`)];
      const toIndex = items.indexOf(targetItem);
      if (toIndex !== -1 && toIndex !== _dragState.fromIndex) {
        const arr = _dragState.type === 'ing' ? editIngredients : editInstructions;
        const [item] = arr.splice(_dragState.fromIndex, 1);
        arr.splice(toIndex, 0, item);
        if (_dragState.type === 'ing') {
          const [link] = editIngredientLinks.splice(_dragState.fromIndex, 1);
          editIngredientLinks.splice(toIndex, 0, link);
        }
        _dragState.type === 'ing' ? reRenderIngredients() : reRenderInstructions();
      }
    }
    _dragState = null;
  },

  handleIngredientKey(e, i) {
    if (e.key === 'Enter') { e.preventDefault(); this.addIngredient(); }
    const ing = editIngredients[i];
    if (e.key === 'Backspace' && !ing.qty && !ing.name && editIngredients.length > 1) {
      e.preventDefault(); this.removeIngredient(i);
      const inputs = document.querySelectorAll('#ingredients-list .ing-name-input');
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

  addTagFromInput() {
    const input = document.getElementById('tag-text-input');
    const val = input?.value?.replace(/,/g, '').trim();
    if (val) { this.addTag(val); input.value = ''; this.updateTagSuggestions(''); }
  },
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
      if (val) { this.addTag(val); e.target.value = ''; this.updateTagSuggestions(''); }
    } else if (e.key === 'Escape') {
      this.updateTagSuggestions('');
    } else {
      setTimeout(() => this.updateTagSuggestions(e.target.value), 0);
    }
  },

  updateServingSuggestions(query) {
    const box = document.getElementById('serving-suggestions');
    if (!box) return;
    const q = query.trim().toLowerCase();
    const all = [...new Set(state.recipes.map(r => r.servings).filter(Boolean))];
    const matches = all.filter(s => !q || s.toLowerCase().includes(q));
    if (!matches.length) { box.classList.add('hidden'); return; }
    box.innerHTML = matches.map(s =>
      `<button type="button" class="tag-suggestion" onclick="document.getElementById('edit-servings').value='${esc(s)}';App.updateServingSuggestions('')">${esc(s)}</button>`
    ).join('');
    box.classList.remove('hidden');
  },

  updateTagSuggestions(query) {
    const box = document.getElementById('tag-suggestions');
    if (!box) return;
    const q = query.trim().toLowerCase();
    const existing = getAllTags().filter(t => !editTags.includes(t) && (!q || t.includes(q)));
    if (!existing.length) { box.classList.add('hidden'); return; }
    box.innerHTML = existing.map(t =>
      `<button type="button" class="tag-suggestion" onclick="App.addTag('${esc(t)}');document.getElementById('tag-text-input').value='';App.updateTagSuggestions('')">${esc(t)}</button>`
    ).join('');
    box.classList.remove('hidden');
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

  toggleChat() {
    state.chatOpen = !state.chatOpen;
    document.getElementById('chat-panel')?.classList.toggle('open', state.chatOpen);
    if (state.chatOpen) document.getElementById('chat-input')?.focus();
  },
  copyChat() {
    if (!state.chatMessages.length) return;
    const text = state.chatMessages
      .map(m => `${m.role === 'user' ? 'You' : 'Assistant'}: ${m.content}`)
      .join('\n\n');
    navigator.clipboard.writeText(text).then(() => toast('Chat copied', 'success', 1500));
  },

  async sendChatMessage() {
    const input = document.getElementById('chat-input');
    const text = input?.value.trim();
    if (!text || state.chatLoading) return;

    const r = state.recipes.find(x => x.id === (state.detailId || state.editId));
    state.chatMessages.push({ role: 'user', content: text });
    input.value = '';
    state.chatLoading = true;
    reRenderChat();

    const system = `You are a helpful cooking assistant. The user is viewing this recipe:

Title: ${r.title}
Servings: ${r.servings || 'not specified'}
Ingredients:
${(r.ingredients || []).map(i => `- ${ingDisplay(i)}`).join('\n')}

Instructions:
${(r.instructions || []).map((s, i) => `${i + 1}. ${s}`).join('\n')}
${r.prepNotes ? `\nPreparation notes: ${r.prepNotes}` : ''}

Answer questions about substitutions, techniques, or anything related to this recipe. Be concise and practical.`;

    try {
      const reply = await AI.chat(state.chatMessages, system);
      state.chatMessages.push({ role: 'assistant', content: reply });
    } catch (err) {
      state.chatMessages.push({ role: 'assistant', content: `Sorry, I couldn't respond: ${err.message}` });
    } finally {
      state.chatLoading = false;
      reRenderChat();
    }
  },

  handleChatKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.sendChatMessage(); }
  },

  showShoppingList(id) {
    state.viewHistory.push({ view: state.view, detailId: state.detailId, editId: state.editId });
    state.detailId = id;
    state.shoppingContext = 'single';
    state.view = 'shopping';
    render();
  },

  showGlobalShoppingList() {
    state.viewHistory.push({ view: state.view, detailId: state.detailId, editId: state.editId });
    state.shoppingContext = 'multi';
    state.shoppingSelected = new Set(state.recipes.map(r => r.id));
    state.view = 'shopping';
    render();
  },

  toggleShoppingRecipe(id) {
    if (state.shoppingSelected.has(id)) state.shoppingSelected.delete(id);
    else state.shoppingSelected.add(id);
    document.getElementById('shopping-content').innerHTML = renderShoppingContent();
  },

  deselectAllRecipes() {
    state.shoppingSelected.clear();
    renderShoppingList();
  },

  onShopPickerToggle(isOpen) { state.shopPickerOpen = isOpen; },
  onShopHaveToggle(isOpen)   { state.shopHaveOpen   = isOpen; },

  toggleNotes() {
    state.notesOpen = !state.notesOpen;
    renderList();
    if (state.notesOpen) setTimeout(() => document.getElementById('notes-textarea')?.focus(), 50);
  },

  onNotesInput(value) {
    state.notes = value;
    clearTimeout(_notesTimer);
    _notesTimer = setTimeout(() => this._syncSave().catch(() => {}), 2000);
  },

  selectPinnedRecipes() {
    state.shoppingSelected = new Set(state.recipes.filter(r => r.pinned).map(r => r.id));
    renderShoppingList();
  },

  togglePantry(key) {
    if (state.pantry.has(key)) state.pantry.delete(key);
    else state.pantry.add(key);
    const el = document.getElementById('shopping-content');
    if (el) el.innerHTML = renderShoppingContent();
    clearTimeout(_pantryTimer);
    _pantryTimer = setTimeout(() => this._syncSave().catch(() => {}), 1500);
  },

  async copyShoppingList() {
    const lines = [];
    const recipes = state.shoppingContext === 'single'
      ? state.recipes.filter(r => r.id === state.detailId)
      : state.recipes.filter(r => state.shoppingSelected.has(r.id));

    if (state.shoppingContext === 'multi') {
      const missing = combinedMissingItems(recipes);
      missing.forEach(item => lines.push(`• ${item.display}`));
    } else {
      const r = recipes[0];
      if (r) {
        (r.ingredients || [])
          .filter(ing => !state.pantry.has(normalizeIngredient(ing)))
          .forEach(ing => lines.push(`• ${ingDisplay(ing)}`));
      }
    }

    if (!lines.length) { toast('Nothing missing!', 'success'); return; }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast('Shopping list copied!', 'success');
    } catch {
      toast('Could not copy — try selecting manually', 'error');
    }
  },

  async togglePin(id, event) {
    event.stopPropagation();
    const recipe = state.recipes.find(r => r.id === id);
    if (!recipe) return;
    recipe.pinned = !recipe.pinned;
    recipe.updatedAt = new Date().toISOString();
    document.getElementById('recipe-grid').innerHTML = renderGrid();
    try {
      await this._syncSave();
    } catch (_) {
      recipe.pinned = !recipe.pinned;
      document.getElementById('recipe-grid').innerHTML = renderGrid();
    }
  },

  setQuantityMultiplier(m) {
    state.qtyMultiplier = m;
    const r = state.recipes.find(x => x.id === state.detailId);
    if (!r) return;
    document.getElementById('ingredient-list').innerHTML = renderIngredientChecklist(r.ingredients || [], r);
    document.querySelectorAll('.qty-btn').forEach(btn => {
      btn.classList.toggle('active', Math.abs(Number(btn.dataset.m) - m) < 0.001);
    });
  },

  // ── Search & Filter ───────────────────────────────────────────────────────
  onSearch(q) {
    state.search = q;
    state.tagFilter.clear();
    document.getElementById('recipe-grid').innerHTML = renderGrid();
    this.updateSearchSuggestions(q);
  },

  updateSearchSuggestions(q) {
    const el = document.getElementById('search-suggestions');
    if (!el) return;
    if (!q.trim()) { el.classList.add('hidden'); return; }
    const lower = q.toLowerCase();
    const items = [];

    // Tags
    getAllTags().filter(t => t.toLowerCase().includes(lower)).slice(0, 4)
      .forEach(t => items.push({ type: 'tag', value: t }));

    // Recipe titles
    state.recipes.filter(r => r.title.toLowerCase().includes(lower)).slice(0, 3)
      .forEach(r => items.push({ type: 'recipe', value: r.title }));

    // Ingredient names (normalized, deduplicated)
    const seenIng = new Set();
    outer: for (const r of state.recipes) {
      for (const ing of (r.ingredients || [])) {
        const name = normalizeIngredient(ing);
        if (name && name.includes(lower) && !seenIng.has(name)) {
          seenIng.add(name);
          items.push({ type: 'ingredient', value: name });
          if (items.filter(i => i.type === 'ingredient').length >= 3) break outer;
        }
      }
    }

    if (!items.length) { el.classList.add('hidden'); return; }
    el._activeIdx = -1;
    el.innerHTML = items.map((item, i) =>
      `<div class="suggestion-item" data-idx="${i}"
            onmousedown="event.preventDefault()"
            onclick="App.applySuggestion('${esc(item.value)}')">
        <span class="suggestion-type">${item.type}</span>
        <span>${esc(item.value)}</span>
      </div>`
    ).join('');
    el.classList.remove('hidden');
  },

  applySuggestion(value) {
    state.search = value;
    state.tagFilter.clear();
    const el = document.getElementById('search-suggestions');
    if (el) el.classList.add('hidden');
    const input = document.querySelector('.search-input');
    if (input) input.value = value;
    document.getElementById('recipe-grid').innerHTML = renderGrid();
  },

  hideSearchSuggestions() {
    const el = document.getElementById('search-suggestions');
    if (el) el.classList.add('hidden');
  },

  onSearchKey(event) {
    const el = document.getElementById('search-suggestions');
    if (!el || el.classList.contains('hidden')) return;
    const items = el.querySelectorAll('.suggestion-item');
    if (!items.length) return;
    let idx = el._activeIdx ?? -1;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      idx = (idx + 1) % items.length;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      idx = (idx - 1 + items.length) % items.length;
    } else if (event.key === 'Enter' && idx >= 0) {
      event.preventDefault();
      items[idx].click();
      return;
    } else if (event.key === 'Escape') {
      el.classList.add('hidden');
      return;
    } else {
      return;
    }
    items.forEach((item, i) => item.classList.toggle('active', i === idx));
    el._activeIdx = idx;
  },

  setTagFilter(tag) {
    if (state.tagFilter.has(tag)) state.tagFilter.delete(tag);
    else state.tagFilter.add(tag);
    document.getElementById('recipe-grid').innerHTML = renderGrid();
    document.querySelectorAll('.tag-filter-btn').forEach(btn => {
      btn.classList.toggle('active', state.tagFilter.has(btn.dataset.tag));
    });
  },

  setRatingFilter(n) {
    state.ratingFilter = state.ratingFilter === n ? null : n;
    document.getElementById('recipe-grid').innerHTML = renderGrid();
    // Update active state on buttons
    document.querySelectorAll('.rating-filter-btn').forEach(btn => {
      btn.classList.toggle('active', Number(btn.dataset.rating) === state.ratingFilter);
    });
  },

  // ── Import: Tab ───────────────────────────────────────────────────────────
  setImportTab(tab) {
    state.importTab = tab;
    state.importImages = [];
    state.importUrl = '';
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
    [...(input?.files || [])].filter(f => f.type.startsWith('image/')).forEach(f => this._loadImageFile(f));
  },
  handleImageDrop(e) {
    e.preventDefault();
    document.getElementById('drop-zone')?.classList.remove('drag-over');
    [...(e.dataTransfer?.files || [])].filter(f => f.type.startsWith('image/')).forEach(f => this._loadImageFile(f));
  },
  handleDragOver(e) {
    e.preventDefault();
    document.getElementById('drop-zone')?.classList.add('drag-over');
  },
  _loadImageFile(file) {
    const reader = new FileReader();
    reader.onload = ev => {
      const dataUrl = ev.target.result;
      state.importImages.push({ base64: dataUrl.split(',')[1], mediaType: file.type, dataUrl });
      const preview = document.getElementById('img-preview-area');
      if (preview) preview.innerHTML = renderImagePreviews();
      const btn = document.getElementById('extract-btn');
      if (btn) { btn.disabled = false; btn.textContent = `Extract with AI${state.importImages.length > 1 ? ` (${state.importImages.length})` : ''}`; }
    };
    reader.readAsDataURL(file);
  },
  removeImage(i) {
    state.importImages.splice(i, 1);
    const preview = document.getElementById('img-preview-area');
    if (preview) preview.innerHTML = renderImagePreviews();
    const btn = document.getElementById('extract-btn');
    if (btn) { btn.disabled = !state.importImages.length; btn.textContent = `Extract with AI${state.importImages.length > 1 ? ` (${state.importImages.length})` : ''}`; }
  },
  async handleImageImport() {
    if (!state.importImages.length) { toast('Upload at least one image first', 'error'); return; }
    setLoading(true, `Extracting ${state.importImages.length > 1 ? state.importImages.length + ' recipes' : 'recipe'} with AI…`);
    try {
      const recipes = await Promise.all(
        state.importImages.map(img => AI.parseImageRecipe(img.base64, img.mediaType))
      );
      state.importPreview = recipes.map(recipe => ({ recipe, include: true }));
      render();
    } catch (err) {
      toast(err.message, 'error', 6000);
    } finally { setLoading(false); }
  },

  // ── Import: URL ───────────────────────────────────────────────────────────
  async handleUrlImport() {
    const url = state.importUrl.trim();
    if (!url) { toast('Enter a URL first', 'error'); return; }
    setLoading(true, 'Fetching page…');
    try {
      const html = await _fetchViaProxy(url);

      // Try JSON-LD structured data first (no AI needed)
      let recipes = _tryJsonLdRecipes(html, url);

      // Fall back to Claude text extraction
      if (!recipes.length) {
        setLoading(true, 'Extracting recipe with AI…');
        const doc = new DOMParser().parseFromString(html, 'text/html');
        doc.querySelectorAll('script,style,nav,header,footer,aside,iframe,noscript').forEach(el => el.remove());
        const text = (doc.body?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 14000);
        recipes = await AI.parseTextRecipes(text + `\n\nSource URL: ${url}`);
      }

      state.importPreview = recipes.map(recipe => ({ recipe, include: true }));
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
    const toAdd = state.importPreview.filter(p => p.include).map(p => {
      const recipe = { ...p.recipe };
      if (state.recipes.some(r => r.title === recipe.title)) recipe.title += ' - Copy';
      recipe.ingredients = (recipe.ingredients || []).map(migrateIngredient);
      return recipe;
    });
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
function reRenderChat() {
  const el = document.getElementById('chat-messages');
  if (!el) return;
  if (!state.chatMessages.length) {
    el.innerHTML = '<p class="chat-empty">Ask about substitutions, techniques, or anything about this recipe.</p>';
  } else {
    el.innerHTML = state.chatMessages.map(m => `
      <div class="chat-msg chat-msg--${m.role}">
        <div class="chat-bubble">${esc(m.content).replace(/\n/g, '<br>')}</div>
      </div>`).join('') +
      (state.chatLoading ? '<div class="chat-msg chat-msg--assistant"><div class="chat-bubble chat-typing"><span></span><span></span><span></span></div></div>' : '');
  }
  el.scrollTop = el.scrollHeight;
}

function reRenderIngredients() {
  document.getElementById('ingredients-list').innerHTML = renderIngredientsList();
}
function reRenderInstructions() {
  document.getElementById('instructions-list').innerHTML = renderInstructionsList();
}
function reRenderTags() {
  document.getElementById('tag-chips').innerHTML = renderTagChips();
  App.updateTagSuggestions(document.getElementById('tag-text-input')?.value || '');
}

// ── Quantity Scaling ────────────────────────────────────────────────────────
function formatQty(n) {
  if (n <= 0) return '0';
  const whole = Math.floor(n);
  const rem = n - whole;
  const fracs = [
    [1/8,'⅛'],[1/6,'⅙'],[1/5,'1/5'],[1/4,'¼'],[1/3,'⅓'],
    [3/8,'⅜'],[2/5,'2/5'],[1/2,'½'],[3/5,'3/5'],[5/8,'⅝'],
    [2/3,'⅔'],[3/4,'¾'],[4/5,'4/5'],[5/6,'⅚'],[7/8,'⅞'],
  ];
  if (rem < 0.04) return String(whole || '0');
  for (const [val, sym] of fracs) {
    if (Math.abs(rem - val) < 0.04) return whole > 0 ? `${whole} ${sym}` : sym;
  }
  return n.toFixed(2).replace(/\.?0+$/, '');
}

function parseLeadingNumber(raw) {
  const s = raw.trim();
  if (s.includes(' ')) {
    const [w, f] = s.split(/\s+/);
    const [fn, fd] = f.split('/');
    return parseInt(w) + parseInt(fn) / parseInt(fd);
  }
  if (s.includes('/')) {
    const [fn, fd] = s.split('/');
    return parseInt(fn) / parseInt(fd);
  }
  return parseFloat(s);
}

const _numPat = '\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d*\\.?\\d+';

const _UFRACS = {
  '½':1/2,'¼':1/4,'¾':3/4,'⅓':1/3,'⅔':2/3,
  '⅛':1/8,'⅜':3/8,'⅝':5/8,'⅞':7/8,
  '⅙':1/6,'⅚':5/6,'⅕':1/5,'⅖':2/5,'⅗':3/5,'⅘':4/5,
};
const _UFRAC_CLASS = '[½¼¾⅓⅔⅛⅜⅝⅞⅙⅚⅕⅖⅗⅘]';

function _parseUniLeading(text) {
  // Returns { val, len } or null — handles "¼", "1 ¼", "2½"
  let m;
  // whole + space + unicode: "1 ¼"
  m = text.match(new RegExp(`^(\\d+)\\s+(${_UFRAC_CLASS})`));
  if (m) return { val: parseInt(m[1]) + _UFRACS[m[2]], len: m[0].length };
  // whole + unicode no space: "2½"
  m = text.match(new RegExp(`^(\\d+)(${_UFRAC_CLASS})`));
  if (m) return { val: parseInt(m[1]) + _UFRACS[m[2]], len: m[0].length };
  // bare unicode: "¼"
  m = text.match(new RegExp(`^(${_UFRAC_CLASS})`));
  if (m) return { val: _UFRACS[m[1]], len: m[0].length };
  return null;
}

const _TSP_RE  = /^(tsps?|teaspoons?)\s*/i;
const _TBSP_RE = /^(tbsps?|tablespoons?)\s*/i;
const _CUP_RE  = /^(cups?)\s*/i;

function _gramsStr(tsp) {
  const g = tsp * 5;
  return g < 1 ? (Math.round(g * 10) / 10) + 'g' : formatQty(g) + 'g';
}

// Cascade: cup → tbsp → tsp → grams, stopping at the first practical unit.
// Returns a formatted string or null if no conversion is needed.
function _smallVolumeConvert(scaledQty, afterQty) {
  let m, rest;

  m = afterQty.match(_CUP_RE);
  if (m && scaledQty < 1/8) {
    rest = afterQty.slice(m[0].length).trimStart();
    const tbsp = scaledQty * 16;
    if (tbsp >= 1) return formatQty(tbsp) + ' tbsp' + (rest ? ' ' + rest : '');
    const tsp = scaledQty * 48;
    if (tsp >= 1/8) return formatQty(tsp) + ' tsp' + (rest ? ' ' + rest : '');
    return _gramsStr(tsp) + (rest ? ' ' + rest : '');
  }

  m = afterQty.match(_TBSP_RE);
  if (m && scaledQty < 1) {
    rest = afterQty.slice(m[0].length).trimStart();
    const tsp = scaledQty * 3;
    if (tsp >= 1/8) return formatQty(tsp) + ' tsp' + (rest ? ' ' + rest : '');
    return _gramsStr(tsp) + (rest ? ' ' + rest : '');
  }

  m = afterQty.match(_TSP_RE);
  if (m && scaledQty < 1/8) {
    rest = afterQty.slice(m[0].length).trimStart();
    return _gramsStr(scaledQty) + (rest ? ' ' + rest : '');
  }

  return null;
}

function scaleIngredient(text, multiplier) {
  if (multiplier === 1) return text;

  const parenUnitRe = /(\d+(?:[.,]\d+)?)\s*(g|kg|ml|l|oz|lbs?|cups?|tbsps?|tsps?)\b/gi;
  const scaleParens = s => s.replace(/\(([^)]+)\)/g, (_, inner) =>
    '(' + inner.replace(parenUnitRe, (_, n, unit) =>
      formatQty(parseFloat(n.replace(',', '.')) * multiplier) + unit
    ) + ')'
  );

  // Range at start: "1-2 tsp", "¼–½ cup", "10–15 g"
  const rangeRe = new RegExp(`^(${_numPat}|${_UFRAC_CLASS})\\s*[-–]\\s*(${_numPat}|${_UFRAC_CLASS})`);
  const rangeMatch = text.match(rangeRe);
  if (rangeMatch) {
    const n1 = _UFRACS[rangeMatch[1]] ?? parseLeadingNumber(rangeMatch[1]);
    const n2 = _UFRACS[rangeMatch[2]] ?? parseLeadingNumber(rangeMatch[2]);
    const scaled = `${formatQty(n1 * multiplier)}–${formatQty(n2 * multiplier)}`;
    return scaleParens(text.replace(rangeRe, scaled));
  }

  // Unicode fraction at start (e.g. "¼ teaspoon", "1 ¼ cups", "2½ tbsp")
  const uni = _parseUniLeading(text);
  if (uni) {
    const scaledQty = uni.val * multiplier;
    const afterQty = text.slice(uni.len).trimStart();
    const conv = _smallVolumeConvert(scaledQty, afterQty);
    if (conv !== null) return scaleParens(conv);
    return scaleParens(formatQty(scaledQty) + text.slice(uni.len));
  }

  // ASCII fraction / decimal / integer
  const leadRe = new RegExp(`^(${_numPat})`);
  const leadMatch = text.match(leadRe);
  if (leadMatch) {
    const scaledQty = parseLeadingNumber(leadMatch[1]) * multiplier;
    const afterQty = text.slice(leadMatch[0].length).trimStart();
    const conv = _smallVolumeConvert(scaledQty, afterQty);
    if (conv !== null) return scaleParens(conv);
    return scaleParens(text.replace(leadRe, formatQty(scaledQty)));
  }

  return scaleParens(text);
}

function renderIngredientChecklist(ingredients, recipe) {
  const links = recipe?.ingredientLinks || [];
  return ingredients.map((ing, i) => {
    const linkedId = links[i];
    const linked = linkedId ? state.recipes.find(r => r.id === linkedId) : null;
    const linkBtn = linked
      ? `<button class="ing-recipe-link" onclick="event.stopPropagation();App.showDetail('${linked.id}')"
                title="Open: ${esc(linked.title)}">↗ ${esc(linked.title)}</button>`
      : '';
    return `
    <li class="checklist-item${state.cookChecked.ingredients.has(i) ? ' checked' : ''}"
        onclick="App.toggleIngredient(${i})">
      <div class="check-box"></div>
      <span class="check-text">${esc(scaleIngredient(ingDisplay(ing), state.qtyMultiplier))}${linkBtn}</span>
    </li>`;
  }).join('');
}

// ── Render Functions ────────────────────────────────────────────────────────
function render() {
  if (state.view !== 'detail' && state.view !== 'edit') cleanupDetailView();
  if (state.view !== 'list') document.getElementById('app-main').classList.remove('list-wide');
  switch (state.view) {
    case 'list':     renderList();         break;
    case 'detail':   renderDetail();       break;
    case 'edit':     renderEdit();         break;
    case 'import':   renderImport();       break;
    case 'shopping': renderShoppingList(); break;
  }
}

function renderList() {
  document.getElementById('app-main').classList.add('list-wide');
  updateHeader('My Recipes', false, `
    <span id="sync-dot" class="sync-dot" title="Synced"></span>
    <button class="icon-btn" title="Notes" onclick="App.toggleNotes()">&#128221;</button>
    <button class="icon-btn" title="Shopping list" onclick="App.showGlobalShoppingList()">&#128722;</button>
    <button class="icon-btn" title="Import" onclick="App.showImport()">&#8675;</button>
    <button class="icon-btn" title="Settings" onclick="App.showSettings()">&#9881;</button>
  `);

  const allTags = getAllTags();
  const filtered = filterRecipes();

  document.getElementById('app-main').innerHTML = `
    <div class="list-layout">
      <div class="list-main">
        <div class="search-container">
          <input type="search" class="search-input" placeholder="Search recipes, ingredients, tags…"
                 value="${esc(state.search)}"
                 oninput="App.onSearch(this.value)"
                 onfocus="App.updateSearchSuggestions(this.value)"
                 onblur="App.hideSearchSuggestions()"
                 onkeydown="App.onSearchKey(event)"
                 autocomplete="off">
          <div id="search-suggestions" class="search-suggestions hidden"></div>
        </div>
        <div class="rating-filter-row">
          ${[5,4].map(n => `
            <button class="rating-filter-btn${state.ratingFilter === n ? ' active' : ''}"
                    data-rating="${n}"
                    onclick="App.setRatingFilter(${n})"
                    title="${n}★ and above">
              ${'★'.repeat(n)}${'☆'.repeat(5-n)}
            </button>`).join('')}
        </div>
        ${allTags.length ? `
        <div class="tag-filter-row">
          ${allTags.map(t => `
            <button class="tag-filter-btn${state.tagFilter.has(t) ? ' active' : ''}"
                    data-tag="${esc(t)}"
                    onclick="App.setTagFilter('${esc(t)}')">
              ${esc(t)}
            </button>`).join('')}
        </div>` : ''}
        <div id="recipe-grid">${renderGrid()}</div>
      </div>

      <aside class="notes-sidebar">
        <div class="notes-sidebar-header">📝 Notes</div>
        <textarea class="notes-sidebar-textarea"
                  placeholder="Shopping reminders, dietary notes, favourite substitutions…"
                  oninput="App.onNotesInput(this.value)">${esc(state.notes)}</textarea>
      </aside>
    </div>

    <button class="fab" onclick="App.showAdd()" title="Add recipe">+</button>

    <div class="notes-panel${state.notesOpen ? ' open' : ''}" id="notes-panel">
      <div class="notes-panel-header">
        <span>📝 General Notes</span>
        <button class="notes-close-btn" onclick="App.toggleNotes()">✕</button>
      </div>
      <textarea class="notes-textarea" id="notes-textarea"
                placeholder="Shopping reminders, dietary notes, favourite substitutions…"
                oninput="App.onNotesInput(this.value)">${esc(state.notes)}</textarea>
    </div>
    ${state.notesOpen ? '<div class="notes-backdrop" onclick="App.toggleNotes()"></div>' : ''}
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
    <div class="recipe-card${r.pinned ? ' pinned' : ''}" onclick="App.showDetail('${r.id}')">
      <div class="card-title-row">
        <div class="recipe-card-title">${esc(r.title)}</div>
        <button class="pin-btn${r.pinned ? ' active' : ''}"
                onclick="App.togglePin('${r.id}', event)"
                title="${r.pinned ? 'Unpin' : 'Pin to top'}">📌</button>
      </div>
      <div class="recipe-card-meta">
        ${r.source ? `<span class="card-source">${esc(r.source)}</span>` : ''}
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

  document.getElementById('app-main').classList.add('detail-wide');

  document.getElementById('app-main').innerHTML = `
    <div class="detail-layout">
      <div class="detail-view">
        <div class="detail-hero">
          <h1>${esc(r.title)}</h1>
          <div class="detail-meta">
            ${r.servings ? `<span>🍽 ${esc(r.servings)}</span>` : ''}
            ${stars(r.rating, true)}
          </div>
          ${(r.tags || []).length ? `<div class="detail-tags">${r.tags.map(tagHtml).join('')}</div>` : ''}
          ${r.source ? `<div class="detail-source">Source: ${esc(r.source)}</div>` : ''}
        </div>

        ${r.afterPrepNotes ? `
          <div class="detail-section after-notes">
            <h2>Notes After Making</h2>
            <p class="notes-text">${nl2br(r.afterPrepNotes)}</p>
          </div>` : ''}

        ${r.prepNotes ? `
          <div class="detail-section">
            <h2>Preparation Notes</h2>
            <p class="notes-text">${nl2br(r.prepNotes)}</p>
          </div>` : ''}

        <div class="detail-section">
          <div class="ingredients-header">
            <h2>Ingredients <span class="section-hint">(tap to check off)</span></h2>
            <div class="qty-toggle">
              ${[['⅓×', 1/3], ['½×', 0.5], ['1×', 1], ['2×', 2]].map(([label, m]) => `
                <button class="qty-btn${Math.abs(state.qtyMultiplier - m) < 0.001 ? ' active' : ''}"
                        data-m="${m}" onclick="App.setQuantityMultiplier(${m})">${label}</button>
              `).join('')}
            </div>
          </div>
          <ul class="cooking-checklist" id="ingredient-list">
            ${renderIngredientChecklist(r.ingredients || [], r)}
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

        <div class="detail-actions">
          <button class="reset-checks-btn" onclick="App.clearCookingChecks()">Reset checks</button>
          <button class="reset-checks-btn" onclick="App.showShoppingList('${r.id}')">🛒 Shopping list</button>
          <button class="btn-danger" onclick="App.confirmDelete('${r.id}')">Delete recipe</button>
        </div>
      </div>

      <aside class="chat-panel${state.chatOpen ? ' open' : ''}" id="chat-panel">
        <div class="chat-header">
          <span>💬 Recipe Assistant</span>
          <button class="icon-btn chat-copy-btn" title="Copy chat" onclick="App.copyChat()">&#128203;</button>
          <button class="chat-close-btn" onclick="App.toggleChat()">✕</button>
        </div>
        <div class="chat-messages" id="chat-messages">
          <p class="chat-empty">Ask about substitutions, techniques, or anything about this recipe.</p>
        </div>
        <div class="chat-input-area">
          <input type="text" id="chat-input" placeholder="e.g. substitute for cream…"
                 onkeydown="App.handleChatKey(event)" autocomplete="off">
          <button class="chat-send-btn" onclick="App.sendChatMessage()">&#9650;</button>
        </div>
      </aside>
    </div>

    <button class="chat-fab" onclick="App.toggleChat()" title="Ask about this recipe">💬</button>
  `;
}

function cleanupDetailView() {
  document.getElementById('app-main').classList.remove('detail-wide');
}

// ── Edit / Add ──────────────────────────────────────────────────────────────
function renderEdit() {
  const isNew = !state.editId;
  const r = isNew ? null : state.recipes.find(x => x.id === state.editId);

  updateHeader(isNew ? 'New Recipe' : 'Edit Recipe', true, `
    ${!isNew ? `<button class="icon-btn" title="Shopping list" onclick="App.showShoppingList('${r.id}')">&#128722;</button>` : ''}
    <button id="edit-pin-btn" class="pin-btn${editPinned ? ' active' : ''}"
            title="${editPinned ? 'Unpin' : 'Pin to top'}"
            onclick="App.toggleEditPin()">📌</button>
    <button class="btn-primary" style="padding:8px 16px" onclick="App.saveEdit()">Save</button>
  `);

  if (!isNew) document.getElementById('app-main').classList.add('detail-wide');

  document.getElementById('app-main').innerHTML = `
    <div class="${isNew ? 'edit-view' : 'detail-layout'}">
    ${!isNew ? '<div class="edit-view">' : ''}
      <div class="form-group">
        <label>Title *</label>
        <input type="text" id="edit-title" value="${esc(r?.title || '')}" placeholder="Recipe name…" autocomplete="off">
      </div>
      <div class="form-group">
        <label>Servings</label>
        <input type="text" id="edit-servings" value="${esc(r?.servings || '')}" placeholder="e.g. 4 servings"
               oninput="App.updateServingSuggestions(this.value)" onfocus="App.updateServingSuggestions(this.value)" autocomplete="off">
        <div id="serving-suggestions" class="tag-suggestions hidden"></div>
      </div>
      <div class="form-group">
        <label>Source</label>
        <input type="text" id="edit-source" value="${esc(r?.source || '')}" placeholder="e.g. Grandma, NYT Cooking, Instagram…" autocomplete="off">
      </div>
      <div class="form-group">
        <label>Rating</label>
        <div id="star-input">${renderStarInput()}</div>
      </div>
      <div class="form-group">
        <label>Tags</label>
        <div id="tag-chips">${renderTagChips()}</div>
        <div class="tag-input-row">
          <input type="text" id="tag-text-input" class="tag-text-input" placeholder="Type a tag…"
                 onkeydown="App.handleTagKey(event)" oninput="App.updateTagSuggestions(this.value)"
                 onfocus="App.updateTagSuggestions(this.value)" autocomplete="off">
          <button type="button" class="btn-add-tag" onclick="App.addTagFromInput()">Add</button>
        </div>
        <div id="tag-suggestions" class="tag-suggestions hidden"></div>
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
    ${!isNew ? '</div>' : '</div>'}

    ${!isNew ? `
    <aside class="chat-panel${state.chatOpen ? ' open' : ''}" id="chat-panel">
      <div class="chat-header">
        <span>💬 Recipe Assistant</span>
        <button class="chat-close-btn" onclick="App.toggleChat()">✕</button>
      </div>
      <div class="chat-messages" id="chat-messages">
        <p class="chat-empty">Ask about substitutions, techniques, or anything about this recipe.</p>
      </div>
      <div class="chat-input-area">
        <input type="text" id="chat-input" placeholder="e.g. substitute for cream…"
               onkeydown="App.handleChatKey(event)" autocomplete="off">
        <button class="chat-send-btn" onclick="App.sendChatMessage()">&#9650;</button>
      </div>
    </aside>

    <button class="chat-fab" onclick="App.toggleChat()" title="Ask about this recipe">💬</button>
    </div>
    ` : ''}
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
  const others = state.recipes.filter(r => r.id !== state.editId).sort((a, b) => a.title.localeCompare(b.title));
  return editIngredients.map((ing, i) => {
    const linkedId = editIngredientLinks[i] || null;
    const selectHtml = `
      <select class="ing-link-select" onchange="App.setIngredientLink(${i}, this.value)"
              title="Link to a recipe">
        <option value="">— link to recipe —</option>
        ${others.map(r => `<option value="${r.id}"${r.id === linkedId ? ' selected' : ''}>${esc(r.title)}</option>`).join('')}
      </select>`;
    return `
    <div class="editable-item" draggable="true"
         ondragstart="App.dragStart(event,${i},'ing')"
         ondragover="App.dragOver(event,${i},'ing')"
         ondrop="App.dragDrop(event,${i},'ing')"
         ondragend="App.dragEnd(event)">
      <span class="drag-handle"
            ontouchstart="App.touchDragStart(event,${i},'ing')"
            ontouchmove="App.touchDragMove(event)"
            ontouchend="App.touchDragEnd(event)">⠿</span>
      <div class="ing-with-link">
        <div class="ing-fields">
          <input class="ing-qty-input" type="text" value="${esc(ing.qty || '')}" placeholder="Qty"
                 oninput="App.updateIngredient(${i},'qty',this.value)">
          <div class="ing-name-wrap">
            <input class="ing-name-input" type="text" value="${esc(ing.name || '')}" placeholder="Ingredient name…"
                   oninput="App.onIngNameInput(${i},this.value)"
                   onkeydown="App.handleIngredientKey(event,${i})"
                   onblur="App.hideIngSuggestions(${i})"
                   autocomplete="off">
            <div class="ing-suggestions hidden" id="ing-sug-${i}"></div>
          </div>
        </div>
        ${selectHtml}
      </div>
      <button type="button" class="btn-remove" onclick="App.removeIngredient(${i})">×</button>
    </div>`;
  }).join('');
}

function renderInstructionsList() {
  return editInstructions.map((step, i) => `
    <div class="editable-item" draggable="true"
         ondragstart="App.dragStart(event,${i},'ins')"
         ondragover="App.dragOver(event,${i},'ins')"
         ondrop="App.dragDrop(event,${i},'ins')"
         ondragend="App.dragEnd(event)">
      <span class="drag-handle"
            ontouchstart="App.touchDragStart(event,${i},'ins')"
            ontouchmove="App.touchDragMove(event)"
            ontouchend="App.touchDragEnd(event)">⠿</span>
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
        <button class="import-tab${state.importTab === 'url' ? ' active' : ''}"
                onclick="App.setImportTab('url')">🔗 URL</button>
      </div>
      ${state.importTab === 'text' ? renderTextImport() : state.importTab === 'url' ? renderUrlImport() : renderImageImport()}
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

async function _fetchViaProxy(url, timeoutMs = 9000) {
  async function attempt(fetchUrl, getHtml) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(fetchUrl, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await getHtml(res);
    } finally { clearTimeout(timer); }
  }

  const enc = encodeURIComponent(url);
  const proxies = [
    () => attempt(
      `https://api.allorigins.win/get?url=${enc}`,
      async r => { const d = await r.json(); if (d.status?.http_code >= 400) throw new Error(`HTTP ${d.status.http_code}`); return d.contents; }
    ),
    () => attempt(`https://corsproxy.io/?${enc}`, r => r.text()),
    () => attempt(`https://api.codetabs.com/v1/proxy?quest=${enc}`, r => r.text()),
  ];

  for (const proxy of proxies) {
    try { return await proxy(); } catch {}
  }
  throw new Error('Could not fetch the page — all proxies failed. Try the "Paste Text" tab instead.');
}

function _tryJsonLdRecipes(html, sourceUrl) {
  const results = [];
  const scriptRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(html)) !== null) {
    try {
      const raw = JSON.parse(m[1]);
      const items = raw['@graph'] ? raw['@graph'] : (Array.isArray(raw) ? raw : [raw]);
      for (const item of items) {
        const types = [].concat(item['@type'] || []);
        if (!types.includes('Recipe')) continue;
        const steps = [].concat(item.recipeInstructions || []).flatMap(s =>
          s['@type'] === 'HowToSection'
            ? (s.itemListElement || []).map(x => x.text || String(x))
            : [s.text || String(s)]
        );
        const servings = [].concat(item.recipeYield || [])[0] || '';
        const tags = [].concat(item.recipeCategory || [], item.recipeCuisine || []);
        results.push({
          id: crypto.randomUUID(),
          title: item.name || 'Untitled Recipe',
          servings: String(servings),
          ingredients: [].concat(item.recipeIngredient || []),
          instructions: steps.filter(Boolean),
          prepNotes: item.description || '',
          afterPrepNotes: '',
          rating: null,
          tags,
          source: sourceUrl,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    } catch {}
  }
  return results;
}

function renderUrlImport() {
  return `
    <div class="import-panel">
      <p class="help-text">Paste a link to a recipe page. The AI will extract the recipe from the page content.</p>
      <input type="url" id="url-input" class="url-input" placeholder="https://example.com/recipe…"
             value="${esc(state.importUrl)}" oninput="state.importUrl=this.value" autocomplete="off" autocapitalize="none">
      <button class="btn-primary" style="margin-top:10px" onclick="App.handleUrlImport()">Import from URL</button>
    </div>`;
}

function renderImagePreviews() {
  if (!state.importImages.length) return '';
  return `<div class="img-preview-grid">${state.importImages.map((img, i) => `
    <div class="img-thumb-wrap">
      <img src="${img.dataUrl}" class="img-thumb" alt="Screenshot ${i + 1}">
      <button class="img-thumb-remove" onclick="App.removeImage(${i})" title="Remove">&#x2715;</button>
    </div>`).join('')}
  </div>`;
}

function renderImageImport() {
  const n = state.importImages.length;
  return `
    <div class="import-panel">
      <p class="help-text">Upload or paste screenshots — one per recipe. Multiple images are processed in parallel.</p>
      <div class="drop-zone" id="drop-zone"
           onclick="document.getElementById('img-file-input').click()"
           ondragover="App.handleDragOver(event)"
           ondrop="App.handleImageDrop(event)">
        <span class="drop-icon">📷</span>
        <p>Click to upload, drag &amp; drop, or paste (Ctrl+V)</p>
        <p style="color:var(--text-muted);font-size:0.8rem;margin-top:4px">PNG, JPG, WEBP &mdash; select multiple files at once</p>
      </div>
      <input type="file" id="img-file-input" accept="image/*" multiple style="display:none"
             onchange="App.handleImageFile(this)">
      <div id="img-preview-area">${renderImagePreviews()}</div>
      <button class="btn-primary" id="extract-btn"
              ${n ? '' : 'disabled'}
              onclick="App.handleImageImport()">Extract with AI${n > 1 ? ` (${n})` : ''}</button>
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

// ── Shopping List helpers ────────────────────────────────────────────────────
function parseQtyAndUnit(ing) {
  let s = (typeof ing === 'object' ? (ing.qty || '') : ing).trim();
  let qty = null;
  const leadRe = /^(\d+\s+\d+\/\d+|\d+\/\d+|\d+\.?\d*)/;
  const lm = s.match(leadRe);
  if (lm) { qty = parseLeadingNumber(lm[1]); s = s.slice(lm[0].length).trim(); }

  const unitRe = /^(cups?|tbsps?|tsps?|tablespoons?|teaspoons?|g|kg|ml|oz|lbs?|ounces?|pounds?|scoops?|pinch(?:es)?|cloves?|slices?|pieces?|heads?|stalks?|sprigs?)\b\s*/i;
  const um = s.match(unitRe);
  let unit = '';
  if (um) {
    unit = um[1].toLowerCase()
      .replace(/tablespoons?/, 'tbsp').replace(/teaspoons?/, 'tsp')
      .replace(/ounces?/, 'oz').replace(/pounds?/, 'lb').replace(/lbs/, 'lb')
      .replace(/s$/, '');
    s = s.slice(um[0].length);
  }
  return { qty, unit };
}

function combinedMissingItems(recipes) {
  const groups = new Map();
  for (const r of recipes) {
    for (const ing of (r.ingredients || [])) {
      if (state.pantry.has(normalizeIngredient(ing))) continue;
      const key = normalizeIngredient(ing);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      const { qty, unit } = parseQtyAndUnit(ing);
      groups.get(key).push({ qty, unit, original: ing, recipeId: r.id, recipeTitle: r.title });
    }
  }

  const result = [];
  for (const [key, entries] of groups) {
    const seen = new Map();
    entries.forEach(e => seen.set(e.recipeId, e.recipeTitle));
    const recipeRefs = [...seen.entries()].map(([id, title]) => ({ id, title }));
    if (entries.length === 1) {
      result.push({ display: entries[0].original, recipes: recipeRefs, key });
      continue;
    }
    const firstUnit = entries[0].unit;
    const allSameUnit = entries.every(e => e.unit === firstUnit);
    const allHaveQty  = entries.every(e => e.qty !== null);
    if (allHaveQty && allSameUnit) {
      const total = entries.reduce((s, e) => s + e.qty, 0);
      const unitStr = firstUnit ? `${firstUnit} ` : '';
      result.push({ display: `${formatQty(total)} ${unitStr}${key}`, recipes: recipeRefs, key, combined: true });
    } else {
      for (const e of entries) result.push({ display: e.original, recipes: [{ id: e.recipeId, title: e.recipeTitle }], key });
    }
  }
  result.sort((a, b) => a.key.localeCompare(b.key));
  return result;
}

// ── Shopping List ───────────────────────────────────────────────────────────
function renderShoppingList() {
  const isMulti = state.shoppingContext === 'multi';
  const title = isMulti ? 'Shopping List' : 'Shopping List';
  updateHeader(title, true, `
    <button class="btn-text" onclick="App.copyShoppingList()">📋 Copy</button>
  `);

  if (isMulti) {
    const nSel = state.shoppingSelected.size;
    document.getElementById('app-main').innerHTML = `
      <div class="shopping-view">
        <details class="shop-collapsible" ${state.shopPickerOpen ? 'open' : ''}
                 ontoggle="App.onShopPickerToggle(this.open)">
          <summary class="shop-section-summary">
            <span>Recipes&nbsp;<span class="shop-section-count">(${nSel} selected)</span></span>
            <div class="shop-picker-actions" onclick="event.stopPropagation()">
              <button class="btn-text-sm" onclick="App.deselectAllRecipes()">Deselect all</button>
              <button class="btn-text-sm" onclick="App.selectPinnedRecipes()">Pinned only</button>
            </div>
          </summary>
          <div class="shopping-recipe-picker">
            ${state.recipes.map(r => `
              <label class="recipe-pick-row">
                <input type="checkbox" ${state.shoppingSelected.has(r.id) ? 'checked' : ''}
                       onchange="App.toggleShoppingRecipe('${r.id}')">
                <span>${r.pinned ? '📌 ' : ''}${esc(r.title)}</span>
              </label>`).join('')}
          </div>
        </details>
        <div id="shopping-content">${renderShoppingContent()}</div>
      </div>`;
  } else {
    document.getElementById('app-main').innerHTML = `
      <div class="shopping-view">
        <div id="shopping-content">${renderShoppingContent()}</div>
      </div>`;
  }
}

function renderShoppingContent() {
  const recipes = state.shoppingContext === 'single'
    ? state.recipes.filter(r => r.id === state.detailId)
    : state.recipes.filter(r => state.shoppingSelected.has(r.id));

  if (!recipes.length) return '<p class="chat-empty">No recipes selected.</p>';

  if (state.shoppingContext === 'multi') {
    const missing = combinedMissingItems(recipes);

    // Deduplicated "have" items across all selected recipes
    const seenHave = new Set();
    const haveItems = [];
    for (const r of recipes) {
      for (const ing of (r.ingredients || [])) {
        const k = normalizeIngredient(ing);
        if (state.pantry.has(k) && !seenHave.has(k)) { seenHave.add(k); haveItems.push(ing); }
      }
    }

    const missingRows = missing.map(item =>
      `<li class="shop-item shop-item--need" onclick="App.togglePantry('${esc(item.key)}')">
        <span class="shop-check">☐</span>
        <div class="shop-text">
          <span>${esc(item.display)}</span>
          <span class="shop-recipe-tag">${item.recipes.map(r =>
            `<button class="shop-recipe-link" onclick="event.stopPropagation();App.showDetail('${r.id}')">${esc(r.title)}</button>`
          ).join(', ')}</span>
        </div>
      </li>`
    ).join('');

    const haveRows = haveItems.map(ing => {
      const k = normalizeIngredient(ing);
      return `<li class="shop-item shop-item--have" onclick="App.togglePantry('${esc(k)}')">
        <span class="shop-check">✓</span>
        <span class="shop-text">${esc(ingDisplay(ing))}</span>
      </li>`;
    }).join('');

    const totalMissing = missing.length;
    const statusLine = totalMissing === 0
      ? '<p class="shopping-all-good">You have everything! 🎉</p>'
      : `<p class="shop-summary">${totalMissing} item${totalMissing > 1 ? 's' : ''} to buy &mdash; tap to mark as available</p>`;

    const haveSection = haveItems.length ? `
      <details class="shop-collapsible shop-have-collapsible" ${state.shopHaveOpen ? 'open' : ''}
               ontoggle="App.onShopHaveToggle(this.open)">
        <summary class="shop-section-summary shop-have-summary">
          Available <span class="shop-section-count">(${haveItems.length})</span>
        </summary>
        <ul class="shop-list">${haveRows}</ul>
      </details>` : '';

    return statusLine + `<ul class="shop-list">${missingRows}</ul>` + haveSection;
  }

  // Single recipe mode
  const r = recipes[0];
  const ings = r.ingredients || [];
  const missing = ings.filter(ing => !state.pantry.has(normalizeIngredient(ing))).sort((a, b) => normalizeIngredient(a).localeCompare(normalizeIngredient(b)));
  const have   = ings.filter(ing =>  state.pantry.has(normalizeIngredient(ing))).sort((a, b) => normalizeIngredient(a).localeCompare(normalizeIngredient(b)));

  const missingRows = missing.map(ing => {
    const k = normalizeIngredient(ing);
    return `<li class="shop-item shop-item--need" onclick="App.togglePantry('${esc(k)}')">
      <span class="shop-check">☐</span>
      <span class="shop-text">${esc(ingDisplay(ing))}</span>
    </li>`;
  }).join('');

  const haveRows = have.map(ing => {
    const k = normalizeIngredient(ing);
    return `<li class="shop-item shop-item--have" onclick="App.togglePantry('${esc(k)}')">
      <span class="shop-check">✓</span>
      <span class="shop-text">${esc(ingDisplay(ing))}</span>
    </li>`;
  }).join('');

  const totalMissing = missing.length;
  const statusLine = totalMissing === 0
    ? '<p class="shopping-all-good">You have everything! 🎉</p>'
    : `<p class="shop-summary">${totalMissing} item${totalMissing > 1 ? 's' : ''} to buy &mdash; tap to mark as available</p>`;

  const haveSection = have.length ? `
    <details class="shop-collapsible shop-have-collapsible" ${state.shopHaveOpen ? 'open' : ''}
             ontoggle="App.onShopHaveToggle(this.open)">
      <summary class="shop-section-summary shop-have-summary">
        Available <span class="shop-section-count">(${have.length})</span>
      </summary>
      <ul class="shop-list">${haveRows}</ul>
    </details>` : '';

  return statusLine + `<ul class="shop-list">${missingRows}</ul>` + haveSection;
}

// ── Init ────────────────────────────────────────────────────────────────────
async function init() {
  // Support clipboard paste for images on the import screen
  document.addEventListener('paste', e => {
    if (state.view !== 'import' || state.importTab !== 'image') return;
    for (const item of (e.clipboardData?.items || [])) {
      if (item.type.startsWith('image/')) App._loadImageFile(item.getAsFile());
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
    const { recipes, pantry, notes, sha } = await Storage.loadRecipes();
    state.recipes = recipes.map(r => ({
      ...r,
      ingredients: (r.ingredients || []).map(migrateIngredient),
    }));
    state.pantry = new Set(pantry);
    state.notes = notes || '';
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
