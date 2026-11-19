/**
 * API SERVICE LAYER (100% REALE — NESSUNA SIMULAZIONE)
 * Legge esclusivamente da window.DOCSCANNER_CONFIG (config.js) con priorità assoluta.
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
        delete saved.ocrMode;
        delete saved.geminiKey;
        delete saved.appPassword;
      } catch (e) {
        saved = {};
      }
    }

    const fileConfig = window.DOCSCANNER_CONFIG || {};

    this.config = {
      supabaseUrl: (fileConfig.supabaseUrl && fileConfig.supabaseUrl.trim()) || saved.supabaseUrl || '',
      supabaseKey: (fileConfig.supabaseKey && fileConfig.supabaseKey.trim()) || saved.supabaseKey || '',
      edgeFunctionName: (fileConfig.edgeFunctionName && fileConfig.edgeFunctionName.trim()) || saved.edgeFunctionName || 'analyze-doc'
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
      supabaseKey: (newConfig.supabaseKey || '').trim(),
      edgeFunctionName: (newConfig.edgeFunctionName || 'analyze-doc').trim()
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
      console.warn('Errore salvataggio memoria apprendimento su DB:', err);
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

  async analyzePageImage(base64DataUrl, pageNumber, availableTypes, priorContext = null, targetBox = null, croppedBase64Url = null, searchWindowMeta = null) {
    if (!this.supabase) {
      throw new Error('Client Supabase non inizializzato. Verifica config.js.');
    }

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
        throw new Error(error.message || `Errore invocazione Edge Function '${fnName}'`);
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
      console.error('Errore reale Edge Function OCR:', err);
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