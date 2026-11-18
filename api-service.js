/**
 * API SERVICE LAYER (Database, Password su DB & Supabase Edge Function AI/OCR)
 * Legge i parametri esclusivamente da window.DOCSCANNER_CONFIG (definito in config.js).
 */

const ApiService = {
  supabase: null,
  config: {},

  init() {
    this.config = { ...(window.DOCSCANNER_CONFIG || {}) };

    const savedRaw = localStorage.getItem('docscanner_config');
    if (savedRaw) {
      try {
        const saved = JSON.parse(savedRaw);
        Object.keys(saved).forEach(k => {
          if (saved[k] !== undefined && saved[k] !== '' && k !== 'appPassword') {
            this.config[k] = saved[k];
          }
        });
      } catch (e) {
        console.warn('Errore parsing localStorage config:', e);
      }
    }

    if (this.config.supabaseUrl && this.config.supabaseKey && window.supabase) {
      this.supabase = window.supabase.createClient(this.config.supabaseUrl, this.config.supabaseKey);
      return true;
    }
    this.supabase = null;
    return false;
  },

  saveConfig(newConfig) {
    const { appPassword, ...connConfig } = newConfig;
    this.config = { ...this.config, ...connConfig };
    localStorage.setItem('docscanner_config', JSON.stringify(this.config));
    return this.init();
  },

  resetToFileConfig() {
    localStorage.removeItem('docscanner_config');
    return this.init();
  },

  // =========================================================================
  // 0. GESTIONE PASSWORD SUL DATABASE (Tabella: doc_app_settings)
  // =========================================================================
  async verifyAppPassword(inputPassword) {
    if (this.supabase) {
      try {
        const { data, error } = await this.supabase
          .from('doc_app_settings')
          .select('value')
          .eq('key', 'app_password')
          .single();

        if (!error && data && data.value) {
          return inputPassword === data.value;
        }
      } catch (err) {
        console.warn('Errore lettura password da Supabase:', err);
      }
    }
    const localPass = localStorage.getItem('docscanner_fallback_pass') || 'admin2026';
    return inputPassword === localPass;
  },

  async updateAppPassword(newPassword) {
    if (!newPassword) return false;
    if (this.supabase) {
      const { error } = await this.supabase
        .from('doc_app_settings')
        .upsert({
          key: 'app_password',
          value: newPassword,
          updated_at: new Date().toISOString()
        }, { onConflict: 'key' });
      if (error) throw error;
      return true;
    }
    localStorage.setItem('docscanner_fallback_pass', newPassword);
    return true;
  },

  // =========================================================================
  // 1. GESTIONE TIPOLOGIE E APPRENDIMENTO CONTINUO (Tabella: doc_content_types)
  // =========================================================================
  async getContentTypes() {
    if (this.supabase) {
      const { data, error } = await this.supabase
        .from('doc_content_types')
        .select('*')
        .eq('is_active', true)
        .order('code', { ascending: true });
      if (!error && data) return data;
    }
    const local = localStorage.getItem('docscanner_fallback_types');
    if (local) return JSON.parse(local);
    const seed = [
      { id: 'type-1', code: 'CERT-MAT', name: 'Certificato Collaudo Materiali', target_field_label: 'Quantità Collaudata', unit: 'pz', ai_hints: 'Casella in basso a destra Totale Pezzi', expected_box: { x: 65, y: 72, w: 20, h: 7 }, learned_examples: [] },
      { id: 'type-2', code: 'BOLLA-CARICO', name: 'Bolla Consegna Calcestruzzo / Inerti', target_field_label: 'Volume Scaricato', unit: 'm³', ai_hints: 'Voce Metri Cubi sezione Scarico Cantiere', expected_box: { x: 58, y: 60, w: 22, h: 7 }, learned_examples: [] },
      { id: 'type-3', code: 'RAPP-ORE', name: 'Rapportino Giornaliero Manodopera', target_field_label: 'Totale Ore Squadra', unit: 'h', ai_hints: 'Somma ore in fondo alla tabella presenze', expected_box: { x: 70, y: 80, w: 18, h: 6 }, learned_examples: [] }
    ];
    localStorage.setItem('docscanner_fallback_types', JSON.stringify(seed));
    return seed;
  },

  async saveContentType(typeObj) {
    if (this.supabase) {
      if (typeObj.id && !String(typeObj.id).startsWith('local-') && !String(typeObj.id).startsWith('type-')) {
        const updatePayload = {
          code: typeObj.code,
          name: typeObj.name,
          target_field_label: typeObj.target_field_label,
          unit: typeObj.unit,
          ai_hints: typeObj.ai_hints,
          expected_box: typeObj.expected_box || null,
          updated_at: new Date().toISOString()
        };
        if (typeObj.learned_examples !== undefined) {
          updatePayload.learned_examples = typeObj.learned_examples;
        }
        const { data, error } = await this.supabase
          .from('doc_content_types')
          .update(updatePayload)
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
            ai_hints: typeObj.ai_hints,
            learned_examples: typeObj.learned_examples || []
          }])
          .select()
          .single();
        if (error) throw error;
        return data;
      }
    }
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

  async recordHumanCorrection(typeObj, correctionExample) {
    if (!typeObj) return;
    const history = Array.isArray(typeObj.learned_examples) ? [...typeObj.learned_examples] : [];
    history.push({
      confirmed_value: correctionExample.confirmed_value,
      ai_initial_value: correctionExample.ai_initial_value,
      box: correctionExample.box,
      note: correctionExample.note || '',
      timestamp: new Date().toISOString()
    });
    typeObj.learned_examples = history.slice(-15);
    typeObj.expected_box = { ...correctionExample.box };

    try {
      await this.saveContentType(typeObj);
    } catch (err) {
      console.warn('Impossibile salvare la memoria di apprendimento su DB:', err);
    }
  },

  async deleteContentType(id) {
    if (this.supabase && !String(id).startsWith('local-') && !String(id).startsWith('type-')) {
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
        bounding_box: { ...(p.bounding_box || {}), rotation: p.rotation || 0 },
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
  // 3. MOTORE DI RICONOSCIMENTO ADATTIVO (Edge Function + Ritaglio Mirato)
  // =========================================================================
  async analyzePageImage(base64DataUrl, pageNumber, availableTypes, priorContext = null, targetBox = null, croppedBase64Url = null, searchWindowMeta = null) {
    if ((this.config.ocrMode === 'edge_gemini' || this.config.ocrMode === 'gemini') && this.supabase) {
      // Non nascondiamo più gli errori: restituiamo eventuale errorMsg così l'utente vede subito cosa non va nella Edge Function!
      return await this._callSupabaseEdgeVision(base64DataUrl, pageNumber, availableTypes, priorContext, targetBox, croppedBase64Url, searchWindowMeta);
    }

    // Modalità Simulazione esplicita
    await new Promise(res => setTimeout(res, 250));
    let chosenType = availableTypes[0];
    if (priorContext && priorContext.primaryTypeId) {
      const found = availableTypes.find(t => t.id === priorContext.primaryTypeId);
      if (found) chosenType = found;
    }

    const activeBox = targetBox
      ? { ...targetBox }
      : ((priorContext && priorContext.referenceBox)
        ? { ...priorContext.referenceBox }
        : (chosenType?.expected_box || { x: 62, y: 72, w: 22, h: 7 }));

    const randomVal = Number((Math.random() * 85 + 15).toFixed(2));
    return {
      detected_type_id: chosenType ? chosenType.id : null,
      detected_value: randomVal,
      raw_text_read: String(randomVal),
      bounding_box: activeBox,
      confidence: 0.90,
      errorMsg: null
    };
  },

  async _callSupabaseEdgeVision(base64DataUrl, pageNumber, availableTypes, priorContext, targetBox, croppedBase64Url, searchWindowMeta) {
    const base64Clean = base64DataUrl.split(',')[1];
    const croppedBase64Clean = croppedBase64Url ? croppedBase64Url.split(',')[1] : null;
    const fnName = this.config.edgeFunctionName || 'analyze-doc';

    try {
      const { data, error } = await this.supabase.functions.invoke(fnName, {
        body: {
          base64Clean,
          croppedBase64Clean,
          searchWindowMeta,
          pageNumber,
          availableTypes,
          priorContext,
          targetBox
        }
      });

      if (error) {
        throw new Error(error.message || 'Errore invocazione Edge Function');
      }
      if (data?.error) {
        throw new Error(data.error);
      }

      return {
        detected_type_id: data.detected_type_id || priorContext?.primaryTypeId || availableTypes[0]?.id,
        detected_value: Number(data.detected_value) || 0,
        raw_text_read: data.raw_text_read || '',
        bounding_box: targetBox || data.bounding_box || priorContext?.referenceBox || { x: 60, y: 70, w: 20, h: 7 },
        confidence: Number(data.confidence) || 0.90,
        errorMsg: null
      };
    } catch (err) {
      console.error('Errore Edge Function Vision:', err);
      const fallbackBox = targetBox || priorContext?.referenceBox || availableTypes[0]?.expected_box || { x: 60, y: 70, w: 20, h: 7 };
      return {
        detected_type_id: priorContext?.primaryTypeId || availableTypes[0]?.id,
        detected_value: 0,
        raw_text_read: 'ERRORE OCR',
        bounding_box: fallbackBox,
        confidence: 0,
        errorMsg: err.message || 'Errore sconosciuto nella Edge Function'
      };
    }
  }
};