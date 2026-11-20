/**
 * HANDWRITING OCR ENGINE v13 — ADATTIVO 100% CLIENT-SIDE
 * -------------------------------------------------------------------------
 * Combina 3 livelli di riconoscimento e apprendimento in tempo reale nel browser:
 * 1. Pre-processing custom su Canvas (grayscale, contrast stretching, auto-crop inchiostro).
 * 2. Memoria Visiva (Template Matching con tolleranza di traslazione): riconosce tracciati
 *    identici o molto simili a quelli già corretti/confermati dall'operatore.
 * 3. Rete Neurale TrOCR (Xenova/trocr-small-handwritten) + Mappa Adattiva di Correzione
 *    (impara gli errori ricorrenti di TrOCR sulla calligrafia specifica dello scrivente).
 */

window.HandwritingOCR = {
  _pipeline: null,
  _loadingPromise: null,
  isReady: false,

  // Memoria adattiva della sessione corrente (si arricchisce a ogni correzione o conferma)
  memory: {
    visualTemplates: [],     // [{ value, rawText, fp: Float32Array(64*32), w: 64, h: 32 }]
    exactRawMap: {},         // { "raw_string_normalizzata": numericValue }
    charSubstitutions: {},   // { "cifra_letta_errata": { "cifra_reale": count } }
    confirmedLengths: []     // Lunghezze in cifre dei valori confermati (es. [5, 5, 5])
  },

  resetSessionMemory() {
    this.memory = {
      visualTemplates: [],
      exactRawMap: {},
      charSubstitutions: {},
      confirmedLengths: []
    };
  },

  async init(onStatusCallback = null) {
    if (this._pipeline) return this._pipeline;
    if (this._loadingPromise) return this._loadingPromise;

    this._loadingPromise = (async () => {
      if (onStatusCallback) onStatusCallback('Caricamento motore neurale AI nel browser (solo 1ª volta)...');

      const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2');
      env.allowLocalModels = false;
      env.useBrowserCache = true;

      this._pipeline = await pipeline('image-to-text', 'Xenova/trocr-small-handwritten', {
        progress_callback: (prog) => {
          if (onStatusCallback && prog && prog.status === 'progress' && prog.total) {
            const pct = Math.round((prog.loaded / prog.total) * 100);
            onStatusCallback(`Download modello scrittura a mano (${prog.file}): ${pct}%`);
          }
        }
      });

      this.isReady = true;
      if (onStatusCallback) onStatusCallback('Modello AI scrittura a mano pronto!');
      return this._pipeline;
    })();

    return this._loadingPromise;
  },

  /**
   * Pre-processing su Canvas:
   * - Ritaglia l'area selezionata con margine
   * - Normalizza contrasto e sfondo carta
   * - Restituisce { dataUrl, fingerprint } così possiamo sia passarlo a TrOCR sia confrontarlo visivamente
   */
  preprocessCrop(srcCanvas, box, paddingPct = 4, previewCanvasId = null) {
    if (!srcCanvas || !box || srcCanvas.width === 0) return null;

    const x = Math.max(0, box.x - paddingPct);
    const y = Math.max(0, box.y - paddingPct);
    const right = Math.min(100, box.x + box.w + paddingPct);
    const bottom = Math.min(100, box.y + box.h + paddingPct);

    const sx = Math.floor((x / 100) * srcCanvas.width);
    const sy = Math.floor((y / 100) * srcCanvas.height);
    const sw = Math.max(24, Math.floor(((right - x) / 100) * srcCanvas.width));
    const sh = Math.max(20, Math.floor(((bottom - y) / 100) * srcCanvas.height));

    const workCanvas = document.createElement('canvas');
    workCanvas.width = sw;
    workCanvas.height = sh;
    const ctx = workCanvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, sw, sh);
    ctx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, sw, sh);

    const imgData = ctx.getImageData(0, 0, sw, sh);
    const data = imgData.data;

    let minLum = 255;
    let maxLum = 0;
    const lums = new Uint8Array(sw * sh);

    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const lum = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      lums[p] = lum;
      if (lum < minLum) minLum = lum;
      if (lum > maxLum) maxLum = lum;
    }

    const range = Math.max(1, maxLum - minLum);
    let inkMinX = sw, inkMinY = sh, inkMaxX = 0, inkMaxY = 0;
    let inkPixels = 0;

    for (let py = 0; py < sh; py++) {
      for (let px = 0; px < sw; px++) {
        const p = py * sw + px;
        const i = p * 4;
        let norm = ((lums[p] - minLum) / range) * 255;
        if (norm > 195) {
          norm = 255;
        } else if (norm < 145) {
          norm = Math.max(0, norm * 0.72);
          if (px < inkMinX) inkMinX = px;
          if (py < inkMinY) inkMinY = py;
          if (px > inkMaxX) inkMaxX = px;
          if (py > inkMaxY) inkMaxY = py;
          inkPixels++;
        }
        const val = Math.round(norm);
        data[i] = val;
        data[i + 1] = val;
        data[i + 2] = val;
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);

    // Estrae l'impronta visiva normalizzata 64x32 centrata sull'inchiostro effettivo
    const fp = this._extractInkFingerprint(workCanvas, inkPixels > 15 ? {
      x: inkMinX, y: inkMinY, w: Math.max(1, inkMaxX - inkMinX + 1), h: Math.max(1, inkMaxY - inkMinY + 1)
    } : { x: 0, y: 0, w: sw, h: sh });

    // Bordo bianco pulito del 12% per TrOCR
    const padX = Math.max(12, Math.round(sw * 0.12));
    const padY = Math.max(10, Math.round(sh * 0.12));
    const finalCanvas = previewCanvasId ? document.getElementById(previewCanvasId) : document.createElement('canvas');
    if (!finalCanvas) {
      return { dataUrl: workCanvas.toDataURL('image/png'), fingerprint: fp };
    }

    finalCanvas.width = sw + padX * 2;
    finalCanvas.height = sh + padY * 2;
    const fCtx = finalCanvas.getContext('2d');
    fCtx.fillStyle = '#ffffff';
    fCtx.fillRect(0, 0, finalCanvas.width, finalCanvas.height);
    fCtx.drawImage(workCanvas, padX, padY);

    return {
      dataUrl: finalCanvas.toDataURL('image/png'),
      fingerprint: fp
    };
  },

  /**
   * Crea un vettore normalizzato 64x32 dell'intensità dell'inchiostro (0 = bianco, 1 = nero)
   * centrato sul bounding box dell'inchiostro, per confrontare tracciati anche se spostati sul foglio.
   */
  _extractInkFingerprint(workCanvas, inkRect) {
    const W = 64;
    const H = 32;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    // Mantiene proporzioni centrando l'inchiostro nel riquadro 64x32 con piccolo margine
    const scale = Math.min((W - 4) / inkRect.w, (H - 4) / inkRect.h);
    const dw = Math.max(1, Math.round(inkRect.w * scale));
    const dh = Math.max(1, Math.round(inkRect.h * scale));
    const dx = Math.floor((W - dw) / 2);
    const dy = Math.floor((H - dh) / 2);

    ctx.drawImage(workCanvas, inkRect.x, inkRect.y, inkRect.w, inkRect.h, dx, dy, dw, dh);

    const imgData = ctx.getImageData(0, 0, W, H).data;
    const vec = new Float32Array(W * H);
    for (let i = 0, p = 0; i < imgData.length; i += 4, p++) {
      // 1.0 = inchiostro scuro, 0.0 = sfondo bianco
      vec[p] = (255 - imgData[i]) / 255.0;
    }
    return vec;
  },

  /**
   * Calcola la similarità visiva (Cosine Similarity con tolleranza di traslazione ±2px)
   * tra due impronte 64x32. Restituisce un valore tra 0 e 1.
   */
  _compareFingerprints(fpA, fpB) {
    const W = 64;
    const H = 32;
    let bestSim = 0;

    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        let dot = 0, normA = 0, normB = 0;
        for (let y = 0; y < H; y++) {
          const yB = y + dy;
          if (yB < 0 || yB >= H) continue;
          const rowA = y * W;
          const rowB = yB * W;
          for (let x = 0; x < W; x++) {
            const xB = x + dx;
            if (xB < 0 || xB >= W) continue;
            const a = fpA[rowA + x];
            const b = fpB[rowB + xB];
            dot += a * b;
            normA += a * a;
            normB += b * b;
          }
        }
        if (normA > 0.5 && normB > 0.5) {
          const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
          if (sim > bestSim) bestSim = sim;
        }
      }
    }
    return bestSim;
  },

  /**
   * APPRENDIMENTO REALE: Chiamato ogni volta che l'operatore corregge o conferma un valore!
   * Aggiorna:
   * 1. Memoria visiva dei tracciati (template matching)
   * 2. Mappa esatta raw_text -> valore confermato
   * 3. Matrice di confusione per singola cifra
   */
  learnFromCorrection({ fingerprint, rawTextRead, confirmedValue }) {
    if (confirmedValue === undefined || confirmedValue === null || isNaN(confirmedValue)) return;

    const cleanRaw = String(rawTextRead || '').trim();
    const confirmedStr = String(confirmedValue);

    // 1. Salva impronta visiva del tracciato confermato (max 40 template in memoria di sessione)
    if (fingerprint) {
      this.memory.visualTemplates.push({
        value: Number(confirmedValue),
        rawText: cleanRaw,
        fp: fingerprint
      });
      if (this.memory.visualTemplates.length > 40) {
        this.memory.visualTemplates.shift();
      }
    }

    // 2. Registra lunghezza in cifre
    const digitsOnlyConfirmed = confirmedStr.replace(/[^0-9]/g, '');
    if (digitsOnlyConfirmed.length > 0) {
      this.memory.confirmedLengths.push(digitsOnlyConfirmed.length);
    }

    // 3. Mappa esatta stringa grezza -> valore corretto (se TrOCR sbaglia sempre allo stesso modo)
    if (cleanRaw && cleanRaw !== '(nessun testo)' && cleanRaw !== 'ERRORE OCR') {
      const key = cleanRaw.toLowerCase().replace(/\s+/g, '');
      this.memory.exactRawMap[key] = Number(confirmedValue);

      // 4. Apprendimento confusione carattere-per-carattere (se stessa lunghezza)
      const rawDigits = this._normalizeHandwrittenChars(cleanRaw).replace(/[^0-9]/g, '');
      if (rawDigits.length === digitsOnlyConfirmed.length && rawDigits.length >= 2) {
        for (let i = 0; i < rawDigits.length; i++) {
          const rChar = rawDigits[i];
          const cChar = digitsOnlyConfirmed[i];
          if (rChar !== cChar) {
            if (!this.memory.charSubstitutions[rChar]) {
              this.memory.charSubstitutions[rChar] = {};
            }
            this.memory.charSubstitutions[rChar][cChar] = (this.memory.charSubstitutions[rChar][cChar] || 0) + 1;
          }
        }
      }
    }
  },

  _normalizeHandwrittenChars(rawText) {
    return String(rawText || '')
      .replace(/[oO°]/g, '0')
      .replace(/[lI|!]/g, '1')
      .replace(/[zZ]/g, '2')
      .replace(/[sS]/g, '5')
      .replace(/[bB]/g, '8')
      .replace(/g/g, '9');
  },

  _applyLearnedCharSubstitutions(numStr) {
    // Applica una sostituzione di cifra solo se è stata osservata almeno 2 volte nella stessa sessione
    let out = '';
    for (const ch of numStr) {
      const subs = this.memory.charSubstitutions[ch];
      if (subs) {
        const bestTarget = Object.entries(subs).sort((a, b) => b[1] - a[1])[0];
        if (bestTarget && bestTarget[1] >= 2) {
          out += bestTarget[0];
          continue;
        }
      }
      out += ch;
    }
    return out;
  },

  parseHandwrittenNumber(rawText) {
    if (!rawText) return 0;

    // 1. Controlla se questa esatta lettura grezza di TrOCR è già stata corretta dall'operatore
    const exactKey = String(rawText).trim().toLowerCase().replace(/\s+/g, '');
    if (this.memory.exactRawMap[exactKey] !== undefined) {
      return this.memory.exactRawMap[exactKey];
    }

    let normalized = this._normalizeHandwrittenChars(rawText);
    const matches = normalized.match(/[-+]?\d[\d.,\s]*\d|\d+/g);
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

    // Applica eventuali regole di sostituzione cifre apprese dalle correzioni ripetute
    cleaned = this._applyLearnedCharSubstitutions(cleaned);

    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
  },

  /**
   * Riconoscimento ibrido adattivo:
   * 1) Verifica prima la Memoria Visiva dei tracciati già validati dall'operatore.
   *    Se il tracciato è molto simile (similarità >= 0.80), restituisce subito il valore appreso!
   * 2) Altrimenti esegue TrOCR e applica la Mappa Adattiva di Correzione.
   */
  async recognize(preprocessedObj, onStatusCallback = null) {
    const imageDataUrl = typeof preprocessedObj === 'string' ? preprocessedObj : preprocessedObj?.dataUrl;
    const fingerprint = typeof preprocessedObj === 'object' ? preprocessedObj?.fingerprint : null;

    // STEP 1: Confronto rapido con la Memoria Visiva dei tracciati già corretti/confermati
    if (fingerprint && this.memory.visualTemplates.length > 0) {
      let bestMatch = null;
      let bestScore = 0;

      for (const tpl of this.memory.visualTemplates) {
        const sim = this._compareFingerprints(fingerprint, tpl.fp);
        if (sim > bestScore) {
          bestScore = sim;
          bestMatch = tpl;
        }
      }

      // Se il tracciato è molto simile o identico a uno già validato (soglia 0.80)
      if (bestMatch && bestScore >= 0.80) {
        return {
          raw_text_read: `${bestMatch.value} [Appreso da tracciato simile ${Math.round(bestScore * 100)}%]`,
          detected_value: bestMatch.value,
          confidence: Number(Math.min(0.99, bestScore + 0.08).toFixed(2)),
          matchedByMemory: true
        };
      }
    }

    // STEP 2: Esecuzione rete neurale TrOCR + Mappa Adattiva di Correzione
    const pipe = await this.init(onStatusCallback);
    const out = await pipe(imageDataUrl);
    const rawText = (Array.isArray(out) && out[0]?.generated_text) ? out[0].generated_text.trim() : '';

    const exactKey = rawText.toLowerCase().replace(/\s+/g, '');
    const usedExactCorrection = this.memory.exactRawMap[exactKey] !== undefined;
    const value = this.parseHandwrittenNumber(rawText);

    let confidence = 0.0;
    if (usedExactCorrection) {
      confidence = 0.94;
    } else if (value !== 0) {
      const digitRatio = (rawText.replace(/[^0-9.,]/g, '').length) / Math.max(1, rawText.replace(/\s/g, '').length);
      confidence = Math.min(0.95, Math.max(0.65, Number((0.65 + digitRatio * 0.28).toFixed(2))));
    } else if (rawText.length > 0) {
      confidence = 0.40;
    }

    return {
      raw_text_read: usedExactCorrection ? `${rawText} → corretto in ${value}` : (rawText || '(nessun testo)'),
      detected_value: value,
      confidence,
      matchedByMemory: usedExactCorrection
    };
  }
};
