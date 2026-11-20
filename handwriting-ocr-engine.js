/**
 * HANDWRITING OCR ENGINE v17 — PASSO 1 (ZERO FALLBACK, ZERO SPOSTAMENTI AUTOMATICI)
 * -------------------------------------------------------------------------
 * Regole ferree:
 * 1. Classificazione Tipologia (Testo Stampato): legge l'intera pagina con Tesseract.js.
 *    Se non trova corrispondenza con nessuna tipologia del Backoffice, restituisce typeId: null.
 *    Nessun fallback alla prima tipologia in lista.
 * 2. Lettura Valore Numerico: NESSUN fallback casuale e NESSUNO zero inventato.
 *    Se non c'è una lettura certa, restituisce detected_value: null ed errore esplicito.
 * 3. Posizione Riquadro: NESSUNO spostamento automatico del rettangolo calibrato.
 */

window.HandwritingOCR = {
  _textWorker: null,
  _initPromise: null,
  isReady: false,

  memory: {
    digitTemplates: {},
    confirmedExamplesCount: 0
  },

  resetSessionMemory() {
    this.memory = {
      digitTemplates: {},
      confirmedExamplesCount: 0
    };
  },

  async init(onStatusCallback = null) {
    if (this.isReady && this._textWorker) return true;
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      if (!window.Tesseract) {
        throw new Error('Libreria Tesseract.js non caricata in index.html.');
      }
      if (onStatusCallback) onStatusCallback('Avvio motore lettura testo stampato...');
      this._textWorker = await window.Tesseract.createWorker('eng');
      this.isReady = true;
      if (onStatusCallback) onStatusCallback('Motore pronto!');
      return true;
    })();

    return this._initPromise;
  },

  // ===========================================================================
  // MOTORE 1: CLASSIFICAZIONE AUTOMATICA TIPOLOGIA DAL TESTO STAMPATO
  // ===========================================================================
  async classifyPageType(fullCanvas, availableTypes, onStatusCallback = null) {
    if (!fullCanvas || !availableTypes || availableTypes.length === 0) {
      return { typeId: null, matchedPhrase: '', score: 0, pageText: '' };
    }

    await this.init(onStatusCallback);

    const maxDim = 1200;
    const scale = Math.max(fullCanvas.width, fullCanvas.height) > maxDim
      ? maxDim / Math.max(fullCanvas.width, fullCanvas.height)
      : 1;
    const tmp = document.createElement('canvas');
    tmp.width = Math.round(fullCanvas.width * scale);
    tmp.height = Math.round(fullCanvas.height * scale);
    const ctx = tmp.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, tmp.width, tmp.height);
    ctx.drawImage(fullCanvas, 0, 0, tmp.width, tmp.height);

    const ret = await this._textWorker.recognize(tmp.toDataURL('image/jpeg', 0.85));
    const pageText = (ret?.data?.text || '').toLowerCase().replace(/\s+/g, ' ').trim();

    let bestTypeId = null;
    let bestScore = 0;
    let bestPhrase = '';

    for (const t of availableTypes) {
      let score = 0;
      let matched = [];

      // 1. Frase esatta dal nome tipologia (es. "drinking water")
      const nameClean = (t.name || '').toLowerCase().trim();
      if (nameClean.length >= 4 && pageText.includes(nameClean)) {
        score += 12;
        matched.push(nameClean);
      }

      // 2. Frasi separate da virgola/punto e virgola negli hints (es. "drinking water, potable water")
      const hintPhrases = (t.ai_hints || '')
        .toLowerCase()
        .split(/[,;\n]+/)
        .map(s => s.trim())
        .filter(s => s.length >= 3);

      for (const phrase of hintPhrases) {
        if (pageText.includes(phrase)) {
          score += 10;
          matched.push(phrase);
        }
      }

      // 3. Parole chiave significative (>= 4 caratteri) da nome, codice e hints
      const rawWords = `${t.name || ''} ${t.code || ''} ${t.ai_hints || ''}`
        .toLowerCase()
        .replace(/[^a-z0-9àèéìòù\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 4);

      const uniqueWords = [...new Set(rawWords)];
      for (const w of uniqueWords) {
        if (pageText.includes(w)) {
          score += 2;
          if (!matched.includes(w)) matched.push(w);
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestTypeId = t.id;
        bestPhrase = matched.slice(0, 3).join(', ');
      }
    }

    // Nessun fallback: se score < 4 (almeno una frase esatta o 2 parole chiave), restituisce NULL!
    return {
      typeId: bestScore >= 4 ? bestTypeId : null,
      matchedPhrase: bestPhrase,
      score: bestScore,
      pageText
    };
  },

  // ===========================================================================
  // PRE-PROCESSING PULITO DEL RIQUADRO (SENZA SPOSTAMENTI AUTOMATICI)
  // ===========================================================================
  _extractCleanInkMatrix(srcCanvas, sx, sy, sw, sh) {
    const c = document.createElement('canvas');
    c.width = sw;
    c.height = sh;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, sw, sh);
    ctx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, sw, sh);

    const data = ctx.getImageData(0, 0, sw, sh).data;
    const lums = new Uint8Array(sw * sh);
    let minLum = 255, maxLum = 0;

    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const lum = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      lums[p] = lum;
      if (lum < minLum) minLum = lum;
      if (lum > maxLum) maxLum = lum;
    }

    const range = Math.max(25, maxLum - minLum);
    const ink = new Float32Array(sw * sh);
    for (let p = 0; p < lums.length; p++) {
      const norm = ((lums[p] - minLum) / range) * 255;
      ink[p] = norm > 205 ? 0 : Math.min(1, (210 - norm) / 155);
    }

    return { ink, sw, sh };
  },

  _renderCleanInkToDataUrl(ink, sw, sh, previewCanvasId = null) {
    const canvas = previewCanvasId ? document.getElementById(previewCanvasId) : document.createElement('canvas');
    if (!canvas) return null;

    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d');
    const outImg = ctx.createImageData(sw, sh);
    const outData = outImg.data;
    outData.fill(255);

    for (let p = 0; p < ink.length; p++) {
      const gray = Math.max(0, Math.min(255, Math.round(255 - ink[p] * 255)));
      const idx = p * 4;
      outData[idx] = gray;
      outData[idx + 1] = gray;
      outData[idx + 2] = gray;
      outData[idx + 3] = 255;
    }
    ctx.putImageData(outImg, 0, 0);
    return canvas.toDataURL('image/png');
  },

  preprocessCrop(srcCanvas, box, paddingPct = 1, previewCanvasId = null) {
    if (!srcCanvas || !box || srcCanvas.width === 0) return null;

    const x = Math.max(0, box.x - paddingPct);
    const y = Math.max(0, box.y - paddingPct);
    const right = Math.min(100, box.x + box.w + paddingPct);
    const bottom = Math.min(100, box.y + box.h + paddingPct);

    const sx = Math.floor((x / 100) * srcCanvas.width);
    const sy = Math.floor((y / 100) * srcCanvas.height);
    const sw = Math.max(20, Math.floor(((right - x) / 100) * srcCanvas.width));
    const sh = Math.max(16, Math.floor(((bottom - y) / 100) * srcCanvas.height));

    const { ink } = this._extractCleanInkMatrix(srcCanvas, sx, sy, sw, sh);
    const dataUrl = this._renderCleanInkToDataUrl(ink, sw, sh, previewCanvasId);

    return {
      dataUrl,
      digitBlobs: [],
      refinedBox: { ...box }
    };
  },

  learnFromCorrection() {
    // Passo 2: qui implementeremo il riconoscimento dedicato alle cifre 0-9 una volta validato il Passo 1.
  },

  // ===========================================================================
  // MOTORE 2 (PASSO 1): NESSUN VALORE INVENTATO -> RESTITUISCE SEMPRE NULL + ERRORE
  // ===========================================================================
  async recognizeNumber(preprocessedObj) {
    return {
      raw_text_read: 'Valore non riconosciuto (inserimento manuale richiesto)',
      detected_value: null,
      confidence: 0,
      bounding_box: preprocessedObj?.refinedBox || null,
      matchedByMemory: false,
      valueError: 'Valore numerico non leggibile in modo affidabile: inseriscilo manualmente.'
    };
  }
};
