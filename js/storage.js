const Storage = {
  getConfig() {
    return {
      pat:    localStorage.getItem('rt_pat')    || '',
      owner:  localStorage.getItem('rt_owner')  || 'ssajami',
      repo:   localStorage.getItem('rt_repo')   || 'recipe-tracker',
      claude: localStorage.getItem('rt_claude') || '',
    };
  },

  setConfig(cfg) {
    const map = { pat: 'rt_pat', owner: 'rt_owner', repo: 'rt_repo', claude: 'rt_claude' };
    for (const [k, key] of Object.entries(map)) {
      if (cfg[k] !== undefined) localStorage.setItem(key, cfg[k]);
    }
  },

  _apiUrl(path) {
    const { owner, repo } = this.getConfig();
    return `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  },

  _headers(write = false) {
    const { pat } = this.getConfig();
    const h = { 'Accept': 'application/vnd.github.v3+json' };
    if (pat) h['Authorization'] = `token ${pat}`;
    if (write) h['Content-Type'] = 'application/json';
    return h;
  },

  _b64decode(str) {
    const bin = atob(str.replace(/\s/g, ''));
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  },

  _b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    const bin = Array.from(bytes, b => String.fromCharCode(b)).join('');
    return btoa(bin);
  },

  async loadRecipes() {
    const res = await fetch(this._apiUrl('recipes.json'), { headers: this._headers() });
    if (res.status === 404) return { recipes: [], pantry: [], sha: null };
    if (!res.ok) {
      if (res.status === 401) throw new Error('GitHub auth failed — check your PAT in Settings.');
      throw new Error(`GitHub API error ${res.status}: ${res.statusText}`);
    }
    const file = await res.json();
    const data = JSON.parse(this._b64decode(file.content));
    // Support old format (plain array) and new format ({ recipes, pantry })
    if (Array.isArray(data)) {
      return { recipes: data, pantry: [], sha: file.sha };
    }
    return { recipes: data.recipes || [], pantry: data.pantry || [], notes: data.notes || '', version: data.version || 0, sha: file.sha };
  },

  async saveRecipes(recipes, pantry, notes, version, sha) {
    const { pat } = this.getConfig();
    if (!pat) throw new Error('No GitHub PAT configured — add it in Settings.');

    const body = {
      message: 'Update recipes',
      content: this._b64encode(JSON.stringify({ recipes, pantry, notes, version }, null, 2)),
    };
    if (sha) body.sha = sha;

    const res = await fetch(this._apiUrl('recipes.json'), {
      method: 'PUT',
      headers: this._headers(true),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      if (res.status === 409) throw new Error('Sync conflict — reload the page and try again.');
      if (res.status === 401) throw new Error('GitHub auth failed — check your PAT in Settings.');
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `GitHub API error ${res.status}`);
    }

    const data = await res.json();
    return data.content.sha;
  },
};
