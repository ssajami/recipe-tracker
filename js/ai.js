const AI = {
  async _call(messages, maxTokens = 4096, system = null) {
    const { claude } = Storage.getConfig();
    if (!claude) throw new Error('No Claude API key configured — add it in Settings.');

    const body = { model: 'claude-opus-4-8', max_tokens: maxTokens, messages };
    if (system) body.system = system;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claude,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Claude API error ${res.status}`);
    }
    const data = await res.json();
    return data.content[0].text;
  },

  _parseJson(text) {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = match ? match[1].trim() : text.trim();
    return JSON.parse(raw);
  },

  _newRecipeSkeleton() {
    return {
      id: crypto.randomUUID(),
      afterPrepNotes: '',
      rating: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  },

  async parseTextRecipes(text) {
    const prompt = `Parse ALL recipes in the text below and return a JSON array. Each element must have exactly these fields:
{
  "title": string,
  "servings": string,
  "ingredients": [string, ...],
  "instructions": [string, ...],
  "prepNotes": string,
  "tags": [string, ...],
  "source": string
}
Infer tags from the recipe type (e.g. "vegetarian", "dessert", "quick", "Italian"). Extract source/attribution if mentioned.
Return ONLY valid JSON — no markdown, no explanation.

---
${text}`;

    const raw = await this._call([{ role: 'user', content: prompt }], 8192);
    const parsed = this._parseJson(raw);
    return parsed.map(r => ({ ...this._newRecipeSkeleton(), ...r }));
  },

  async parseImageRecipe(base64Data, mediaType) {
    const messages = [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
        {
          type: 'text',
          text: `Extract the recipe from this image and return a JSON object with exactly these fields:
{
  "title": string,
  "servings": string,
  "ingredients": [string, ...],
  "instructions": [string, ...],
  "prepNotes": string,
  "tags": [string, ...],
  "source": string
}
Infer tags from the recipe type. Extract source/attribution if visible. Return ONLY valid JSON — no markdown, no explanation.`,
        },
      ],
    }];

    const raw = await this._call(messages, 4096);
    return { ...this._newRecipeSkeleton(), ...this._parseJson(raw) };
  },

  async chat(messages, system) {
    return await this._call(messages, 1024, system);
  },
};
