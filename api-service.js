/**
 * API SERVICE LAYER (Database & Motore AI/OCR)
 * Quando porterai l'app sull'infrastruttura interna Tecnimont,
 * ti basterà modificare i metodi di questo oggetto senza toccare app.js.
 */

const DEFAULT_CONFIG = {
  supabaseUrl: '', // Puoi incollarlo qui o inserirlo dal pannello Impostazioni dell'app
  supabaseKey: '', // Puoi incollarlo qui o inserirlo dal pannello Impostazioni dell'app
  ocrMode: 'simulation', // 'simulation' | 'gemini'
  geminiKey: '',
  appPassword: 'admin2026'
};

const ApiService = {
  supabase: null,
  config: { ...DEFAULT_CONFIG },

  init() {
    const saved = localStorage.getItem('docscanner_config');
    if (saved) {
      this.config = { ...DEFAULT_CONFIG, ...JSON.parse(saved) };
    }
    if (this.config.supabaseUrl && this.config.supabaseKey && window.supabase) {
      this.supabase = window.supabase.createClient(this.config.supabaseUrl, this.config.supabaseKey);
      return true;
    }
    return false;
  },

  saveConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    localStorage.setItem('docscanner_config', JSON.stringify(this.config));
    return this.init();
  },

  // =========================================================================
  // 1. GESTIONE TIPOLOGIE DI CONTENUTO (Tabella: doc_content_types)
  // =========================================================================
  async getContentTypes() {
    if (this.supabase) {
      const { data, error } = await this.supabase
        .from('doc_content_types')
        .select('*')
        .eq('is_active', true)
        .order('code', { ascending: true });
      if (!error && data) return data;
      console.warn('Fallback locale per getContentTypes:', error);
    }
    // Fallback locale se Supabase non è ancora configurato
    const local = localStorage.getItem('docscanner_fallback_types');
    if (local) return JSON.parse(local);
    const seed = [
      { id: 'type-1', code: 'CERT-MAT', name: 'Certificato Collaudo Materiali', target_field_label: 'Quantità Collaudata', unit: 'pz', ai_hints: 'Casella in basso a destra Totale Pezzi', expected_box: { x: 65, y: 72, w: 20, h: 7 } },
      { id: 'type-2', code: 'BOLLA-CARICO', name: 'Bolla Consegna Calcestruzzo / Inerti', target_field_label: 'Volume Scaricato', unit: 'm³', ai_hints: 'Voce Metri Cubi sezione Scarico Cantiere', expected_box: { x: 58, y: 60, w: 22, h: 7 } },
      { id: 'type-3', code: 'RAPP-ORE', name: 'Rapportino Giornaliero Manodopera', target_field_label: 'Totale Ore Squadra', unit: 'h', ai_hints: 'Somma ore in fondo alla tabella presenze', expected_box: { x: 70, y: 80, w: 18, h: 6 } }
    ];
    localStorage.setItem('docscanner_fallback_types', JSON.stringify(seed));
    return seed;
  },

  async saveContentType(typeObj) {
    if (this.supabase) {
      if (typeObj.id) {
        const { data, error } = await this.supabase
          .from('doc_content_types')
          .update({
            code: typeObj.code,
            name: typeObj.name,
            target_field_label: typeObj.target_field_label,
            unit: typeObj.unit,
            ai_hints: typeObj.ai_hints,
            expected_box: typeObj.expected_box || null,
            updated_at: new Date().toISOString()
          })
          .eq('id', typeObj.id)
          .select()
          .single();
        if (error) throw error;
        return data;
      } else {
        const { data, error } = await this.supabase
          .from('doc_content_types')
          .insert([{
            code: typeObj.code,
            name: typeObj.name,
            target_field_label: typeObj.target_field_label,
            unit: typeObj.unit,
            ai_hints: typeObj.ai_hints
          }])
          .select()
          .single();
        if (error) throw error;
        return data;
      }
    }
    // Fallback locale
    const list = await this.getContentTypes();
    if (typeObj.id) {
      const idx = list.findIndex(t => t.id === typeObj.id);
      if (idx >= 0) list[idx] = { ...list[idx], ...typeObj };
    } else {
      typeObj.id = 'local-' + Date.now();
      list.push(typeObj);
    }
    localStorage.setItem('docscanner_fallback_types', JSON.stringify(list));
    return typeObj;
  },

  async deleteContentType(id) {
    if (this.supabase) {
      const { error } = await this.supabase
        .from('doc_content_types')
        .update({ is_active: false })
        .eq('id', id);
      if (error) throw error;
      return true;
    }
    const list = (await this.getContentTypes()).filter(t => t.id !== id);
    localStorage.setItem('docscanner_fallback_types', JSON.stringify(list));
    return true;
  },

  // =========================================================================
  // 2. GESTIONE SESSIONI E PAGINE (Tabelle: doc_batches, doc_pages)
  // =========================================================================
  async createBatch(filename, totalPages) {
    if (this.supabase) {
      const { data, error } = await this.supabase
        .from('doc_batches')
        .insert([{ filename, total_pages: totalPages, status: 'calibrating' }])
        .select()
        .single();
      if (!error && data) return data;
    }
    return { id: 'batch-' + Date.now(), filename, total_pages: totalPages, status: 'calibrating', created_at: new Date().toISOString() };
  },

  async updateBatch(batchId, fields) {
    if (this.supabase && !String(batchId).startsWith('batch-')) {
      await this.supabase.from('doc_batches').update(fields).eq('id', batchId);
    }
  },

  async savePagesBulk(batchId, pagesArray) {
    if (this.supabase && !String(batchId).startsWith('batch-')) {
      const payload = pagesArray.map(p => ({
        batch_id: batchId,
        page_number: p.page_number,
        detected_type_id: p.detected_type_id,
        detected_value: p.detected_value,
        bounding_box: p.bounding_box,
        confidence: p.confidence,
        is_verified: p.is_verified,
        notes: p.notes || ''
      }));
      await this.supabase.from('doc_pages').upsert(payload, { onConflict: 'batch_id,page_number' });
    }
  },

  async getRecentBatches() {
    if (this.supabase) {
      const { data, error } = await this.supabase
        .from('doc_batches')
        .select('*, doc_content_types(code, name)')
        .order('created_at', { ascending: false })
        .limit(25);
      if (!error && data) return data;
    }
    return [];
  },

  // =========================================================================
  // 3. MOTORE DI RICONOSCIMENTO MODULI SCRITTI A MANO (Vision AI / Simulazione)
  // =========================================================================
  async analyzePageImage(base64DataUrl, pageNumber, availableTypes, priorContext = null) {
    // Se configurata la chiave Gemini e modalità 'gemini', chiama il modello Vision reale
    if (this.config.ocrMode === 'gemini' && this.config.geminiKey) {
      try {
        return await this._callGeminiVision(base64DataUrl, pageNumber, availableTypes, priorContext);
      } catch (err) {
        console.error('Errore chiamata Gemini Vision, passo a simulazione:', err);
      }
    }

    // Modalità Simulazione Intelligente (per test immediato del flusso)
    await new Promise(res => setTimeout(res, 350)); // Simula latenza rete

    // Se abbiamo un priorContext (dalla Pagina 1 confermata dall'utente), 90% di probabilità che sia la stessa tipologia
    let chosenType = availableTypes[0];
    if (priorContext && priorContext.primaryTypeId) {
      const found = availableTypes.find(t => t.id === priorContext.primaryTypeId);
      if (found) chosenType = found;
    }

    const defaultBox = (priorContext && priorContext.referenceBox)
      ? { ...priorContext.referenceBox }
      : (chosenType?.expected_box || { x: 62, y: 72, w: 22, h: 7 });

    // Genera un valore numerico realistico e una confidenza (qualche pagina con confidenza < 0.85 per far testare il filtro di revisione)
    const randomVal = Number((Math.random() * 85 + 15).toFixed(2));
    const isLowConf = pageNumber > 1 && pageNumber % 4 === 0;
    const confidence = isLowConf ? 0.76 : Number((0.91 + Math.random() * 0.08).toFixed(2));

    return {
      detected_type_id: chosenType ? chosenType.id : null,
      detected_value: randomVal,
      bounding_box: defaultBox,
      confidence: confidence
    };
  },

  async _callGeminiVision(base64DataUrl, pageNumber, availableTypes, priorContext) {
    const base64Clean = base64DataUrl.split(',')[1];
    const typesDescription = availableTypes.map(t => ({
      id: t.id,
      code: t.code,
      name: t.name,
      target_field_label: t.target_field_label,
      hints: t.ai_hints
    }));

    const priorHint = priorContext?.primaryTypeId
      ? `NOTA PROBABILISTICA: La prima pagina di questo documento è stata confermata come tipologia ID "${priorContext.primaryTypeId}" e il valore numerico si trovava circa alle coordinate percentuali ${JSON.stringify(priorContext.referenceBox)}. È molto probabile che questa pagina (Pag. ${pageNumber}) appartenga alla stessa tipologia.`
      : '';

    const promptText = `
Analizza l'immagine di questo certificato/modulo compilato a mano.
1. Determina a quale tipologia appartiene scegliendo tra queste:
${JSON.stringify(typesDescription)}
${priorHint}
2. Individua il valore numerico scritto a mano relativo al campo richiesto per quella tipologia.
3. Restituisci SOLO un JSON valido con questo formato esatto (coordinate in percentuale 0-100 rispetto a larghezza e altezza pagina):
{
  "detected_type_id": "uuid-della-tipologia",
  "detected_value": 123.45,
  "bounding_box": {"x": 60, "y": 70, "w": 20, "h": 7},
  "confidence": 0.95
}`;

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.config.geminiKey}`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: promptText },
            { inline_data: { mime_type: 'image/jpeg', data: base64Clean } }
          ]
        }],
        generationConfig: { response_mime_type: 'application/json' }
      })
    });

    const json = await response.json();
    const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const parsed = JSON.parse(rawText);

    return {
      detected_type_id: parsed.detected_type_id || availableTypes[0]?.id,
      detected_value: Number(parsed.detected_value) || 0,
      bounding_box: parsed.bounding_box || { x: 60, y: 70, w: 20, h: 7 },
      confidence: Number(parsed.confidence) || 0.90
    };
  }
};