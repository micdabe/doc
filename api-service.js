/**
 * API SERVICE LAYER (SUPABASE DB + TESSERACT.JS IN LOCALE NEL BROWSER)
 * 100% statico, zero costi per chiamata, zero limiti di quota.
 */

const ApiService = {
  supabase: null,
  config: {},
  _worker: null,

  init() {
    const savedRaw = localStorage.getItem('docscanner_config');
    let saved = {};
    if (savedRaw) {
      try {
        saved = JSON.parse(savedRaw);
      } catch (e) {
        saved = {};
      }
    }

    const fileConfig = window.DOCSCANNER_CONFIG || {};

    this.config = {
      supabaseUrl: (fileConfig.supabaseUrl && fileConfig.supabaseUrl.trim()) || saved.supabaseUrl || '',
      supabaseKey: (fileConfig.supabaseKey && fileConfig.supabaseKey.trim()) || saved.supabaseKey || ''
    };

    if (this.config.supabaseUrl && this.config.supabaseKey && window.supabase) {
      this.supabase = window.supabase.createClient(this.config.supabaseUrl, this.config.supabaseKey);
      return true;
    }
    this.supabase = null;
    return false;
  },

  saveConfig(newConfig) {
    const cleanConfig = {
      supabaseUrl: (newConfig.supabaseUrl || '').trim(),
      supabaseKey: (newConfig.supabaseKey || '').trim()
    };
    localStorage.setItem('docscanner_config', JSON.stringify(cleanConfig));
    return this.init();
  },

  resetToFileConfig() {
    localStorage.removeItem('docscanner_config');
    return this.init();
  },

  async _getTesseractWorker() {
    if (!this._worker && window.Tesseract) {
      this._worker = await window.Tesseract.createWorker('eng');
      await this._worker.setParameters({
        tessedit_char_whitelist: '0123456789.,-€$m³Kgkh/ '
      });
    }
    return this._worker;
  },

  _parseNumericValue(rawText) {
    if (!rawText) return 0;
    const matches = String(rawText).match(/[-+]?\d[\d.,\s]*\d|\d+/g);
    if (!matches || matches.length === 0) return 0;

    const best = matches.reduce((a, b) =>
      a.replace(/\D/g, '').length >= b.replace(/\D/g, '').length ? a : b
    );

    let cleaned = best.replace(/\s+/g, '');
    if (cleaned.includes('.') && cleaned.includes(',')) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else if (/^\d{1,3}(\.\d{3})+$/.test(cleaned)) {
      cleaned = cleaned.replace(/\./g, '');
    } else if (cleaned.includes(',')) {
      if (/^\d{1,3}(,\d{3})+$/.test(cleaned)) {
        cleaned = cleaned.replace(/,/g, '');
      } else {
        cleaned = cleaned.replace(',', '.');
      }
    }

    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
  },

  // =========================================================================
  // 0. GESTIONE PASSWORD SUL DATABASE (Tabella: doc_app_settings)
  // =========================================================================
  async verifyAppPassword(inputPassword) {
    if (!this.supabase) {
      throw new Error('Database Supabase non configurato in config.js.');
    }
    const { data, error } = await this.supabase
      .from('doc_app_settings')
      .select('value')
      .eq('key', 'app_password')
      .single();

    if (error || !data || !data.value) {
      throw new Error('Impossibile verificare la password nella tabella doc_app_settings.');
    }
    return inputPassword === data.value;
  },

  async updateAppPassword(newPassword) {
    if (!newPassword) return false;
    if (!this.supabase) throw new Error('Database Supabase non connesso.');

    const { error } = await this.supabase
      .from('doc_app_settings')
      .upsert({
        key: 'app_password',
        value: newPassword,
        updated_at: new Date().toISOString()
      }, { onConflict: 'key' });
    if (error) throw error;
    return true;
  },

  // =========================================================================
  // 1. GESTIONE TIPOLOGIE (Tabella: doc_content_types)
  // =========================================================================
  async getContentTypes() {
    if (!this.supabase) return [];
    const { data, error } = await this.supabase
      .from('doc_content_types')
      .select('*')
      .eq('is_active', true)
      .order('code', { ascending: true });
    if (error) throw error;
    return data || [];
  },

  async saveContentType(typeObj) {
    if (!this.supabase) throw new Error('Database Supabase non connesso.');

    if (typeObj.id) {
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
  },

  async recordHumanCorrection(typeObj, correctionExample) {
    if (!typeObj || !this.supabase) return;
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
      console.warn('Errore salvataggio coordinate su DB:', err);
    }
  },

  async deleteContentType(id) {
    if (!this.supabase) throw new Error('Database Supabase non connesso.');
    const { error } = await this.supabase
      .from('doc_content_types')
      .update({ is_active: false })
      .eq('id', id);
    if (error) throw error;
    return true;
  },

  // =========================================================================
  // 2. GESTIONE SESSIONI E PAGINE (Tabelle: doc_batches, doc_pages)
  // =========================================================================
  async createBatch(filename, totalPages) {
    if (!this.supabase) throw new Error('Database Supabase non connesso.');
    const { data, error } = await this.supabase
      .from('doc_batches')
      .insert([{ filename, total_pages: totalPages, status: 'calibrating' }])
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async updateBatch(batchId, fields) {
    if (!this.supabase || !batchId) return;
    await this.supabase.from('doc_batches').update(fields).eq('id', batchId);
  },

  async savePagesBulk(batchId, pagesArray) {
    if (!this.supabase || !batchId) return;
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
  },

  async getRecentBatches() {
    if (!this.supabase) return [];
    const { data, error } = await this.supabase
      .from('doc_batches')
      .select('*, doc_content_types(code, name)')
      .order('created_at', { ascending: false })
      .limit(25);
    if (error) throw error;
    return data || [];
  },

  // =========================================================================
  // 3. MOTORE OCR LOCALE IN TESSERACT.JS (ZERO CHIAMATE API / ZERO LIMITI)
  // =========================================================================
  async analyzePageImage(base64DataUrl, pageNumber, availableTypes, priorContext = null, targetBox = null, croppedBase64Url = null, searchWindowMeta = null) {
    const defaultTypeId = (priorContext && priorContext.primaryTypeId) || (availableTypes && availableTypes[0]?.id) || null;
    const refBox = targetBox
      || (priorContext && priorContext.referenceBox)
      || (availableTypes && availableTypes.find(t => t.id === defaultTypeId)?.expected_box)
      || { x: 55, y: 65, w: 25, h: 8 };

    try {
      const worker = await this._getTesseractWorker();
      const imageToRead = croppedBase64Url || base64DataUrl;
      if (!imageToRead) {
        throw new Error('Nessuna immagine disponibile per la lettura OCR.');
      }

      const ret = await worker.recognize(imageToRead);
      const rawText = (ret?.data?.text || '').trim();
      const confScore = typeof ret?.data?.confidence === 'number'
        ? Math.max(0, Math.min(1, ret.data.confidence / 100))
        : 0.75;

      const parsedVal = this._parseNumericValue(rawText);

      // Se l'utente ha spostato/disegnato un riquadro, cerca in una piccola finestra attorno ad esso nelle pagine successive
      let nextBox = { ...refBox };
      if (!targetBox && priorContext?.referenceBox) {
        nextBox = { ...priorContext.referenceBox };
      }

      return {
        detected_type_id: defaultTypeId,
        detected_value: parsedVal,
        raw_text_read: rawText || '(vuoto)',
        bounding_box: nextBox,
        confidence: Number(confScore.toFixed(2)),
        errorMsg: null
      };
    } catch (err) {
      console.error('Errore Tesseract.js:', err);
      return {
        detected_type_id: defaultTypeId,
        detected_value: 0,
        raw_text_read: 'ERRORE OCR',
        bounding_box: { ...refBox },
        confidence: 0,
        errorMsg: err.message || 'Errore durante la lettura OCR locale'
      };
    }
  }
};
