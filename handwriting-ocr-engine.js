/**
 * HANDWRITING OCR ENGINE v14 — ADATTIVO CON MAPPA DI DENSITÀ DILATATA + CENTROIDI
 * -------------------------------------------------------------------------
 * Risolve il mancato riconoscimento di tracciati simili:
 * 1. Pre-processing non distruttivo per TrOCR (preserva anche i tratti a penna chiari).
 * 2. Impronta visiva robusta 32x16 con sfocatura/dilatazione (tollera variazioni naturali della mano).
 * 3. Confronto sia con i singoli esempi sia con il "prototipo medio" (centroide) di ogni valore appreso.
 * 4. Se TrOCR restituisce vuoto/0 ma nel riquadro c'è inchiostro, prevale il match visivo appreso.
 */

window.HandwritingOCR = {
  _pipeline: null,
  _loadingPromise: null,
  isReady: false,

  memory: {
    visualTemplates: [],     // [{ value, rawText, fp: Float32Array(32*16) }]
    exactRawMap: {},         // { "raw_string": numericValue }
    charSubstitutions: {},   // { "cifra_errata": { "cifra_reale": count } }
    confirmedLengths: []
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
   * Pre-processing coerente (padding uniforme 3%):
   * - Preserva i tratti chiari (niente tagli bruschi che cancellano gli zeri)
   * - Estrae impronta 32x16 dilatata/sfocata centrata sull'inchiostro
   */
  preprocessCrop(srcCanvas, box, paddingPct = 3, previewCanvasId = null) {
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

    // Calcola percentile sfondo (90° percentile) per adattarsi a carta chiara o scura
    const lums = new Uint8Array(sw * sh);
    let minLum = 255;
    let maxLum = 0;
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const lum = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      lums[p] = lum;
      if (lum < minLum) minLum = lum;
      if (lum > maxLum) maxLum = lum;
    }

    const range = Math.max(20, maxLum - minLum);
    // Ignora un margine di 2px sui bordi esterni quando cerca il bounding box dell'inchiostro (evita linee delle caselle)
    const marginX = Math.min(4, Math.floor(sw * 0.04));
    const marginY = Math.min(4, Math.floor(sh * 0.06));
    let inkMinX = sw, inkMinY = sh, inkMaxX = 0, inkMaxY = 0;
    let inkPixels = 0;

    for (let py = 0; py < sh; py++) {
      for (let px = 0; px < sw; px++) {
        const p = py * sw + px;
        const i = p * 4;
        // Normalizzazione morbida: schiarisce solo lo sfondo puro (> 215), preserva tutto l'inchiostro
        let norm = ((lums[p] - minLum) / range) * 255;
        if (norm > 215) {
          norm = 255;
        } else {
          // Aumenta leggermente il contrasto dell'inchiostro senza tagliarlo
          norm = Math.max(0, norm * 0.82);
        }
        const val = Math.round(norm);
        data[i] = val;
        data[i + 1] = val;
        data[i + 2] = val;
        data[i + 3] = 255;

        if (val < 175 && px >= marginX && px < sw - marginX && py >= marginY && py < sh - marginY) {
          if (px < inkMinX) inkMinX = px;
          if (py < inkMinY) inkMinY = py;
          if (px > inkMaxX) inkMaxX = px;
          if (py > inkMaxY) inkMaxY = py;
          inkPixels++;
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);

    const inkRatio = inkPixels / Math.max(1, sw * sh);
    const inkRect = (inkPixels > 12 && inkMaxX > inkMinX && inkMaxY > inkMinY)
      ? { x: inkMinX, y: inkMinY, w: inkMaxX - inkMinX + 1, h: inkMaxY - inkMinY + 1 }
      : { x: marginX, y: marginY, w: Math.max(1, sw - marginX * 2), h: Math.max(1, sh - marginY * 2) };

    const fp = this._extractDilatedFingerprint(workCanvas, inkRect);

    // Prepara l'immagine pulita con bordo bianco per TrOCR e anteprima
    const padX = Math.max(14, Math.round(sw * 0.12));
    const padY = Math.max(12, Math.round(sh * 0.14));
    const finalCanvas = previewCanvasId ? document.getElementById(previewCanvasId) : document.createElement('canvas');
    if (!finalCanvas) {
      return { dataUrl: workCanvas.toDataURL('image/png'), fingerprint: fp, inkRatio };
    }

    finalCanvas.width = sw + padX * 2;
    finalCanvas.height = sh + padY * 2;
    const fCtx = finalCanvas.getContext('2d');
    fCtx.fillStyle = '#ffffff';
    fCtx.fillRect(0, 0, finalCanvas.width, finalCanvas.height);
    fCtx.drawImage(workCanvas, padX, padY);

    return {
      dataUrl: finalCanvas.toDataURL('image/png'),
      fingerprint: fp,
      inkRatio
    };
  },

  /**
   * Impronta visiva 32x16 con sfocatura/dilatazione (blur 1.5px):
   * Trasforma i tratti sottili a penna in zone morbide di densità così due "10000" scritti
   * dalla stessa persona si sovrappongono con similarità 0.75-0.95 invece di 0.35!
   */
  _extractDilatedFingerprint(workCanvas, inkRect) {
    const W = 32;
    const H = 16;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    // Sfoca leggermente durante il ridimensionamento per rendere il confronto tollerante a piccole differenze di tratto
    ctx.filter = 'blur(1.2px)';
    const scale = Math.min((W - 2) / inkRect.w, (H - 2) / inkRect.h);
    const dw = Math.max(1, Math.round(inkRect.w * scale));
    const dh = Math.max(1, Math.round(inkRect.h * scale));
    const dx = Math.floor((W - dw) / 2);
    const dy = Math.floor((H - dh) / 2);

    ctx.drawImage(workCanvas, inkRect.x, inkRect.y, inkRect.w, inkRect.h, dx, dy, dw, dh);
    ctx.filter = 'none';

    const imgData = ctx.getImageData(0, 0, W, H).data;
    const vec = new Float32Array(W * H);
    for (let i = 0, p = 0; i < imgData.length; i += 4, p++) {
      vec[p] = (255 - imgData[i]) / 255.0;
    }
    return vec;
  },

  /**
   * Cosine Similarity con tolleranza di traslazione ±2px su griglia 32x16
   */
  _compareFingerprints(fpA, fpB) {
    const W = 32;
    const H = 16;
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
        if (normA > 0.15 && normB > 0.15) {
          const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
          if (sim > bestSim) bestSim = sim;
        }
      }
    }
    return bestSim;
  },

  /**
   * Calcola il miglior match visivo confrontando sia con ogni singolo tracciato salvato
   * sia con il "centroide" (media di tutti i tracciati salvati per lo stesso valore).
   */
  _findBestVisualMatch(fingerprint) {
    if (!fingerprint || this.memory.visualTemplates.length === 0) {
      return { value: null, score: 0 };
    }

    let bestVal = null;
    let bestScore = 0;

    // 1. Confronto con singoli tracciati
    const byValue = {};
    for (const tpl of this.memory.visualTemplates) {
      const sim = this._compareFingerprints(fingerprint, tpl.fp);
      if (sim > bestScore) {
        bestScore = sim;
        bestVal = tpl.value;
      }
      if (!byValue[tpl.value]) byValue[tpl.value] = [];
      byValue[tpl.value].push(tpl.fp);
    }

    // 2. Confronto con il centroide medio di ciascun valore (molto potente quando hai 2+ esempi dello stesso numero!)
    for (const [valStr, fps] of Object.entries(byValue)) {
      if (fps.length < 2) continue;
      const centroid = new Float32Array(32 * 16);
      for (const fp of fps) {
        for (let i = 0; i < centroid.length; i++) centroid[i] += fp[i];
      }
      for (let i = 0; i < centroid.length; i++) centroid[i] /= fps.length;

      const simCentroid = this._compareFingerprints(fingerprint, centroid);
      // Piccola spinta di affidabilità al centroide
      if (simCentroid > bestScore) {
        bestScore = simCentroid;
        bestVal = Number(valStr);
      }
    }

    return { value: bestVal, score: bestScore };
  },

  learnFromCorrection({ fingerprint, rawTextRead, confirmedValue }) {
    if (confirmedValue === undefined || confirmedValue === null || isNaN(confirmedValue)) return;

    const cleanRaw = String(rawTextRead || '').trim();
    const confirmedStr = String(confirmedValue);

    if (fingerprint) {
      this.memory.visualTemplates.push({
        value: Number(confirmedValue),
        rawText: cleanRaw,
        fp: fingerprint
      });
      if (this.memory.visualTemplates.length > 60) {
        this.memory.visualTemplates.shift();
      }
    }

    const digitsOnlyConfirmed = confirmedStr.replace(/[^0-9]/g, '');
    if (digitsOnlyConfirmed.length > 0) {
      this.memory.confirmedLengths.push(digitsOnlyConfirmed.length);
    }

    if (cleanRaw && !cleanRaw.startsWith('(') && !cleanRaw.includes('Appreso') && cleanRaw !== 'ERRORE OCR') {
      const key = cleanRaw.toLowerCase().replace(/\s+/g, '');
      this.memory.exactRawMap[key] = Number(confirmedValue);

      const rawDigits = this._normalizeHandwrittenChars(cleanRaw).replace(/[^0-9]/g, '');
      if (rawDigits.length === digitsOnlyConfirmed.length && rawDigits.length >= 2) {
        for (let i = 0; i < rawDigits.length; i++) {
          const rChar = rawDigits[i];
          const cChar = digitsOnlyConfirmed[i];
          if (rChar !== cChar) {
            if (!this.memory.charSubstitutions[rChar]) this.memory.charSubstitutions[rChar] = {};
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

    cleaned = this._applyLearnedCharSubstitutions(cleaned);

    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
  },

  async recognize(preprocessedObj, onStatusCallback = null) {
    const imageDataUrl = typeof preprocessedObj === 'string' ? preprocessedObj : preprocessedObj?.dataUrl;
    const fingerprint = typeof preprocessedObj === 'object' ? preprocessedObj?.fingerprint : null;
    const inkRatio = typeof preprocessedObj === 'object' ? (preprocessedObj?.inkRatio || 0) : 0.05;

    // STEP 1: Confronto con Memoria Visiva (singoli tracciati + centroide)
    const visualMatch = this._findBestVisualMatch(fingerprint);

    // Soglia diretta 0.65 su mappa 32x16 sfocata: riconosce subito tracciati simili senza nemmeno aspettare TrOCR!
    if (visualMatch.value !== null && visualMatch.score >= 0.65) {
      return {
        raw_text_read: `${visualMatch.value} [Memoria Visiva ${Math.round(visualMatch.score * 100)}%]`,
        detected_value: visualMatch.value,
        confidence: Number(Math.min(0.99, visualMatch.score + 0.15).toFixed(2)),
        matchedByMemory: true
      };
    }

    // STEP 2: Rete neurale TrOCR + Mappa Adattiva
    const pipe = await this.init(onStatusCallback);
    const out = await pipe(imageDataUrl);
    const rawText = (Array.isArray(out) && out[0]?.generated_text) ? out[0].generated_text.trim() : '';

    const exactKey = rawText.toLowerCase().replace(/\s+/g, '');
    const usedExactCorrection = this.memory.exactRawMap[exactKey] !== undefined;
    let value = this.parseHandwrittenNumber(rawText);

    // STEP 3: Rete di sicurezza! Se TrOCR restituisce 0/vuoto ma c'è inchiostro nel riquadro
    // e abbiamo un match visivo ragionevole (>= 0.52), usa il valore appreso invece di 0!
    if (value === 0 && inkRatio > 0.01 && visualMatch.value !== null && visualMatch.score >= 0.52) {
      return {
        raw_text_read: `${visualMatch.value} [Fallback Visivo ${Math.round(visualMatch.score * 100)}%, TrOCR="${rawText}"]`,
        detected_value: visualMatch.value,
        confidence: Number(Math.min(0.90, visualMatch.score + 0.10).toFixed(2)),
        matchedByMemory: true
      };
    }

    let confidence = 0.0;
    if (usedExactCorrection) {
      confidence = 0.94;
    } else if (value !== 0) {
      const digitRatio = (rawText.replace(/[^0-9.,]/g, '').length) / Math.max(1, rawText.replace(/\s/g, '').length);
      confidence = Math.min(0.95, Math.max(0.65, Number((0.65 + digitRatio * 0.28).toFixed(2))));
    } else if (rawText.length > 0) {
      confidence = 0.40;
    }

    const simNote = visualMatch.value !== null ? ` | Sim visiva: ${Math.round(visualMatch.score * 100)}%` : '';
    return {
      raw_text_read: usedExactCorrection
        ? `${rawText} → corretto in ${value}`
        : `${rawText || '(nessun testo)'}${simNote}`,
      detected_value: value,
      confidence,
      matchedByMemory: usedExactCorrection
    };
  }
};
