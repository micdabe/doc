/**
 * HANDWRITING OCR ENGINE v18 — PASSO 1 (TrOCR BASE SUL RIQUADRO BLU CORSIVO, ZERO FALLBACK)
 * -------------------------------------------------------------------------
 * Regole ferree:
 * 1. Riquadro BLU (Tipologia in corsivo): usa Microsoft TrOCR (Xenova/trocr-base-handwritten)
 *    per leggere la riga manoscritta in inglese/corsivo (es. "Drinking water 100 Gln for HDD")
 *    e la confronta con le tipologie configurate nel Backoffice.
 *    Se non trova corrispondenza chiara, restituisce typeId: null (ZERO fallback).
 * 2. Riquadro ROSSO (Valore numerico): nel Passo 1 non inventa mai nulla e non mette 0;
 *    restituisce detected_value: null con errore esplicito finché non si passa al Passo 2.
 * 3. Nessuno spostamento automatico dei riquadri.
 */

window.HandwritingOCR = {
  _trocrPipe: null,
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
    if (this.isReady && this._trocrPipe) return this._trocrPipe;
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      if (onStatusCallback) onStatusCallback('Caricamento modello TrOCR-base corsivo (solo 1ª volta)...');

      const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2');
      env.allowLocalModels = false;
      env.useBrowserCache = true;

      this._trocrPipe = await pipeline('image-to-text', 'Xenova/trocr-base-handwritten', {
        progress_callback: (prog) => {
          if (onStatusCallback && prog && prog.status === 'progress' && prog.total) {
            const pct = Math.round((prog.loaded / prog.total) * 100);
            onStatusCallback(`Download TrOCR corsivo (${prog.file}): ${pct}%`);
          }
        }
      });

      this.isReady = true;
      if (onStatusCallback) onStatusCallback('TrOCR corsivo pronto!');
      return this._trocrPipe;
    })();

    return this._initPromise;
  },

  // Distanza di Levenshtein per tollerare al massimo 1 lettera imprecisa su parole lunghe (>= 6 lettere)
  _levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > 2) return 99;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      }
    }
    return dp[m][n];
  },

  // ===========================================================================
  // MOTORE 1: LETTURA CORSIVO (RIQUADRO BLU) CON TrOCR + MATCH RIGOROSO TIPOLOGIA
  // ===========================================================================
  async classifyHandwrittenTypeCrop(typeCropDataUrl, availableTypes, onStatusCallback = null) {
    if (!typeCropDataUrl || !availableTypes || availableTypes.length === 0) {
      return { typeId: null, matchedPhrase: '', score: 0, rawText: '' };
    }

    const pipe = await this.init(onStatusCallback);
    const out = await pipe(typeCropDataUrl);
    const rawText = (Array.isArray(out) && out[0]?.generated_text) ? out[0].generated_text.trim() : '';
    const normText = rawText.toLowerCase().replace(/[^a-z0-9àèéìòù\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const textWords = normText.split(' ').filter(w => w.length >= 3);

    if (!normText) {
      return { typeId: null, matchedPhrase: '', score: 0, rawText: '(vuoto)' };
    }

    let bestTypeId = null;
    let bestScore = 0;
    let bestPhrase = '';

    for (const t of availableTypes) {
      let score = 0;
      let matched = [];

      // 1. Frase esatta dal nome tipologia (es. "drinking water")
      const nameClean = (t.name || '').toLowerCase().replace(/[^a-z0-9àèéìòù\s]/g, ' ').replace(/\s+/g, ' ').trim();
      if (nameClean.length >= 4 && normText.includes(nameClean)) {
        score += 12;
        matched.push(nameClean);
      }

      // 2. Frasi esatte separate da virgola/punto e virgola negli hints
      const hintPhrases = (t.ai_hints || '')
        .toLowerCase()
        .split(/[,;\n]+/)
        .map(s => s.replace(/[^a-z0-9àèéìòù\s]/g, ' ').replace(/\s+/g, ' ').trim())
        .filter(s => s.length >= 3);

      for (const phrase of hintPhrases) {
        if (normText.includes(phrase)) {
          score += 10;
          if (!matched.includes(phrase)) matched.push(phrase);
        }
      }

      // 3. Singole parole chiave (>= 4 lettere) da nome, codice e hints
      const rawKeywords = `${t.name || ''} ${t.code || ''} ${t.ai_hints || ''}`
        .toLowerCase()
        .replace(/[^a-z0-9àèéìòù\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 4);

      const uniqueKeywords = [...new Set(rawKeywords)];
      for (const kw of uniqueKeywords) {
        if (normText.includes(kw)) {
          score += 3;
          if (!matched.includes(kw)) matched.push(kw);
        } else if (kw.length >= 6) {
          // Tollera al massimo 1 carattere impreciso di TrOCR su parole lunghe (es. "drinking" -> "drinkin")
          const fuzzyHit = textWords.find(tw => this._levenshtein(tw, kw) <= 1);
          if (fuzzyHit) {
            score += 2;
            if (!matched.includes(`${kw}~${fuzzyHit}`)) matched.push(`${kw}~${fuzzyHit}`);
          }
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestTypeId = t.id;
        bestPhrase = matched.slice(0, 3).join(', ');
      }
    }

    // ZERO FALLBACK: richiede almeno score >= 4 (frase esatta o almeno 2 parole chiave)
    return {
      typeId: bestScore >= 4 ? bestTypeId : null,
      matchedPhrase: bestPhrase,
      score: bestScore,
      rawText
    };
  },

  // ===========================================================================
  // PRE-PROCESSING PULITO DEL RIQUADRO (CON BORDO BIANCO IDEALE PER TrOCR)
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
      ink[p] = norm > 210 ? 0 : Math.min(1, (215 - norm) / 160);
    }

    return { ink, sw, sh };
  },

  _renderCleanInkToDataUrl(ink, sw, sh, previewCanvasId = null) {
    const padX = Math.max(12, Math.round(sw * 0.08));
    const padY = Math.max(10, Math.round(sh * 0.12));
    const outW = sw + padX * 2;
    const outH = sh + padY * 2;

    const canvas = previewCanvasId ? document.getElementById(previewCanvasId) : document.createElement('canvas');
    if (!canvas) return null;

    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    const outImg = ctx.createImageData(outW, outH);
    const outData = outImg.data;
    outData.fill(255);

    for (let y = 0; y < sh; y++) {
      const srcRow = y * sw;
      const dstRow = (padY + y) * outW;
      for (let x = 0; x < sw; x++) {
        const gray = Math.max(0, Math.min(255, Math.round(255 - ink[srcRow + x] * 255)));
        const idx = (dstRow + padX + x) * 4;
        outData[idx] = gray;
        outData[idx + 1] = gray;
        outData[idx + 2] = gray;
        outData[idx + 3] = 255;
      }
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
    // Passo 2: qui integreremo la lettura rigorosa delle cifre 0-9 una volta validato il Passo 1.
  },

  // ===========================================================================
  // MOTORE 2 (PASSO 1): ZERO INVENZIONI -> RESTITUISCE SEMPRE NULL + ERRORE
  // ===========================================================================
  async recognizeNumber(preprocessedObj) {
    return {
      raw_text_read: 'Valore non riconosciuto (inserimento manuale richiesto)',
      detected_value: null,
      confidence: 0,
      bounding_box: preprocessedObj?.refinedBox || null,
      matchedByMemory: false,
      valueError: 'Valore numerico non leggibile (Passo 2): inseriscilo manualmente.'
    };
  }
};
