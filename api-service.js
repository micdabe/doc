/**
 * API SERVICE LAYER (SUPABASE DB + HANDWRITING OCR ADATTIVO CLIENT-SIDE)
 */

const ApiService = {
  supabase: null,
  config: {},

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

  async analyzePageImage(valPreprocessedObj, typePreprocessedObj, pageNumber, availableTypes, priorContext = null, targetValBox = null, targetTypeBox = null, onStatusCallback = null) {
    const refValBox = targetValBox
      || (priorContext && priorContext.referenceBox)
      || { x: 48, y: 55, w: 12, h: 6 };
    const refTypeBox = targetTypeBox
      || (priorContext && priorContext.referenceTypeBox)
      || { x: 15, y: 50, w: 45, h: 8 };

    try {
      if (!window.HandwritingOCR) {
        throw new Error('Modulo handwriting-ocr-engine.js non caricato.');
      }

      // 1. Classificazione Tipologia dal RIQUADRO BLU (Corsivo con TrOCR — ZERO FALLBACK)
      let detectedTypeId = null;
      let typeMatchNote = '';
      let handwrittenTypeText = '';
      const errors = [];

      if (typePreprocessedObj && typePreprocessedObj.dataUrl && availableTypes && availableTypes.length > 0) {
        const cls = await window.HandwritingOCR.classifyHandwrittenTypeCrop(
          typePreprocessedObj.dataUrl,
          availableTypes,
          onStatusCallback
        );
        handwrittenTypeText = cls.rawText || '(vuoto)';
        if (cls.typeId) {
          detectedTypeId = cls.typeId;
          typeMatchNote = `Tipo riconosciuto: "${cls.matchedPhrase}" (score ${cls.score})`;
        } else {
          errors.push(`Tipologia NON riconosciuta dal corsivo (letto: "${handwrittenTypeText}"). Assegnazione manuale richiesta.`);
        }
      } else {
        errors.push('Riquadro blu della Tipologia non definito.');
      }

      // 2. Valore numerico (Passo 1: ZERO FALLBACK -> sempre null + errore)
      const res = await window.HandwritingOCR.recognizeNumber(valPreprocessedObj);
      if (res.detected_value === null) {
        errors.push(res.valueError || 'Valore numerico NON riconosciuto (inserimento manuale richiesto).');
      }

      return {
        detected_type_id: detectedTypeId,
        detected_value: res.detected_value,
        raw_text_read: typeMatchNote ? `${res.raw_text_read} | ${typeMatchNote}` : res.raw_text_read,
        pageText: handwrittenTypeText,
        bounding_box: { ...refValBox },
        type_box: { ...refTypeBox },
        confidence: res.confidence,
        matchedByMemory: false,
        errorMsg: errors.length > 0 ? errors.join(' ') : null
      };
    } catch (err) {
      console.error(`Errore OCR Pagina ${pageNumber}:`, err);
      return {
        detected_type_id: null,
        detected_value: null,
        raw_text_read: 'ERRORE OCR',
        pageText: '',
        bounding_box: { ...refValBox },
        type_box: { ...refTypeBox },
        confidence: 0,
        matchedByMemory: false,
        errorMsg: err.message || 'Errore durante il riconoscimento locale'
      };
    }
  }
};
