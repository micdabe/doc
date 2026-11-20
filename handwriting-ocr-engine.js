/**
 * HANDWRITING OCR ENGINE v16 — DOPPIO MOTORE 100% CLIENT-SIDE
 * -------------------------------------------------------------------------
 * 1. MOTORE TESTO STAMPATO (Full-Page): legge il testo inglese/italiano stampato
 *    sul modulo (es. "drinking water") tramite Tesseract.js per assegnare
 *    AUTOMATICAMENTE la Tipologia di Contenuto corretta.
 * 2. MOTORE NUMERI SCRITTI A MANO (Solo Cifre 0-9):
 *    - Rimuove le linee stampate della casella.
 *    - Segmenta il numero nelle singole cifre (es. 1-0-0-0-0).
 *    - Impara la calligrafia CIFRA PER CIFRA dalle tue correzioni (mai copia cieca
 *      dell'intero numero e mai parole inventate tipo "Columbus").
 *    - Fallback numerico rigoroso (whitelist 0123456789.,) per cifre mai viste prima.
 */

window.HandwritingOCR = {
  _textWorker: null,
  _numWorker: null,
  _initPromise: null,
  isReady: false,

  // Memoria adattiva CIFRA PER CIFRA (0..9)
  memory: {
    digitTemplates: {}, // { '0': [Float32Array(16*20), ...], '1': [...], ... }
    confirmedExamplesCount: 0
  },

  resetSessionMemory() {
    this.memory = {
      digitTemplates: {},
      confirmedExamplesCount: 0
    };
  },

  async init(onStatusCallback = null) {
    if (this.isReady && this._textWorker && this._numWorker) return true;
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      if (!window.Tesseract) {
        throw new Error('Libreria Tesseract.js non caricata in index.html.');
      }
      if (onStatusCallback) onStatusCallback('Avvio doppio motore OCR locale...');

      // Worker 1: Testo stampato completo (inglese/italiano) per classificare la Tipologia
      this._textWorker = await window.Tesseract.createWorker('eng');

      // Worker 2: Solo cifre numeriche (whitelist rigorosa: impossibile inventare parole)
      this._numWorker = await window.Tesseract.createWorker('eng');
      await this._numWorker.setParameters({
        tessedit_char_whitelist: '0123456789.,',
        tessedit_pageseg_mode: '7' // Single text line
      });

      this.isReady = true;
      if (onStatusCallback) onStatusCallback('Doppio motore OCR pronto!');
      return true;
    })();

    return this._initPromise;
  },

  // ===========================================================================
  // MOTORE 1: CLASSIFICAZIONE AUTOMATICA TIPOLOGIA DAL TESTO STAMPATO DELLA PAGINA
  // ===========================================================================
  async classifyPageType(fullCanvas, availableTypes, onStatusCallback = null) {
    if (!fullCanvas || !availableTypes || availableTypes.length === 0) {
      return { typeId: null, matchedPhrase: '', score: 0, pageText: '' };
    }

    await this.init(onStatusCallback);

    // Riduce la pagina intera a max 1000px in scala di grigi per una lettura rapida (~0.6s)
    const maxDim = 1000;
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

    const ret = await this._textWorker.recognize(tmp.toDataURL('image/jpeg', 0.80));
    const pageText = (ret?.data?.text || '').toLowerCase().replace(/\s+/g, ' ').trim();

    let bestTypeId = null;
    let bestScore = 0;
    let bestPhrase = '';

    for (const t of availableTypes) {
      let score = 0;
      let matched = [];

      // 1. Frasi esatte dal nome tipologia (es. "drinking water") -> punteggio altissimo (+12)
      const nameClean = (t.name || '').toLowerCase().trim();
      if (nameClean.length >= 4 && pageText.includes(nameClean)) {
        score += 12;
        matched.push(nameClean);
      }

      // 2. Frasi separate da virgola/punto e virgola negli hints (es. "drinking water, acqua potabile")
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

      // 3. Singole parole chiave significative (> 3 caratteri) da nome, codice, etichetta e hints
      const rawWords = `${t.name || ''} ${t.code || ''} ${t.target_field_label || ''} ${t.ai_hints || ''}`
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
        bestPhrase = matched.slice(0, 2).join(', ');
      }
    }

    return {
      typeId: bestScore >= 2 ? bestTypeId : null,
      matchedPhrase: bestPhrase,
      score: bestScore,
      pageText
    };
  },

  // ===========================================================================
  // MOTORE 2: PULIZIA LINEE + SEGMENTAZIONE CIFRA-PER-CIFRA (0-9)
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

    // Rimuove linee orizzontali stampate (> 60% della larghezza)
    for (let y = 0; y < sh; y++) {
      let darkCount = 0;
      const rowOff = y * sw;
      for (let x = 0; x < sw; x++) if (ink[rowOff + x] > 0.25) darkCount++;
      if (darkCount > sw * 0.60) {
        for (let x = 0; x < sw; x++) {
          const above = y > 1 ? ink[(y - 2) * sw + x] : 0;
          const below = y < sh - 2 ? ink[(y + 2) * sw + x] : 0;
          ink[rowOff + x] = (above > 0.35 && below > 0.35) ? Math.min(above, below) : 0;
        }
      }
    }

    // Rimuove linee verticali stampate (> 70% dell'altezza)
    for (let x = 0; x < sw; x++) {
      let darkCount = 0;
      for (let y = 0; y < sh; y++) if (ink[y * sw + x] > 0.25) darkCount++;
      if (darkCount > sh * 0.70) {
        for (let y = 0; y < sh; y++) {
          const left = x > 1 ? ink[y * sw + (x - 2)] : 0;
          const right = x < sw - 2 ? ink[y * sw + (x + 2)] : 0;
          ink[y * sw + x] = (left > 0.35 && right > 0.35) ? Math.min(left, right) : 0;
        }
      }
    }

    return { ink, sw, sh };
  },

  _findInkBounds(ink, sw, sh, marginX = 2, marginY = 2) {
    let minX = sw, minY = sh, maxX = 0, maxY = 0, count = 0;
    for (let y = marginY; y < sh - marginY; y++) {
      const rowOff = y * sw;
      for (let x = marginX; x < sw - marginX; x++) {
        if (ink[rowOff + x] > 0.28) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
          count++;
        }
      }
    }
    if (count < 10 || maxX <= minX || maxY <= minY) {
      return { rect: { x: marginX, y: marginY, w: Math.max(1, sw - marginX * 2), h: Math.max(1, sh - marginY * 2) }, inkCount: count };
    }
    return { rect: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, inkCount: count };
  },

  /**
   * Segmenta il rettangolo dell'inchiostro in singole cifre tramite proiezione verticale
   * e genera per ciascuna cifra un vettore normalizzato 16x20 dilatato.
   */
  _segmentDigits(ink, sw, sh, rect) {
    // Proiezione verticale delle colonne con inchiostro
    const colInk = new Float32Array(rect.w);
    for (let x = 0; x < rect.w; x++) {
      let sum = 0;
      for (let y = 0; y < rect.h; y++) {
        const v = ink[(rect.y + y) * sw + (rect.x + x)];
        if (v > 0.25) sum += v;
      }
      colInk[x] = sum;
    }

    // Trova intervalli orizzontali contigui (segmenti di cifre)
    const rawSegments = [];
    let inSeg = false, startX = 0;
    for (let x = 0; x < rect.w; x++) {
      if (colInk[x] > 0.35 && !inSeg) {
        inSeg = true;
        startX = x;
      } else if (colInk[x] <= 0.35 && inSeg) {
        inSeg = false;
        if (x - startX >= 2) rawSegments.push({ x0: startX, x1: x - 1 });
      }
    }
    if (inSeg && rect.w - startX >= 2) {
      rawSegments.push({ x0: startX, x1: rect.w - 1 });
    }

    // Costruisce i bounding box delle singole cifre e divide eventuali cifre unite (es. "00" toccate)
    const digitBlobs = [];
    for (const seg of rawSegments) {
      const segW = seg.x1 - seg.x0 + 1;
      // Trova top/bottom verticali del segmento
      let minY = rect.h, maxY = 0, pxCount = 0;
      for (let y = 0; y < rect.h; y++) {
        const rowOff = (rect.y + y) * sw;
        for (let x = seg.x0; x <= seg.x1; x++) {
          if (ink[rowOff + rect.x + x] > 0.25) {
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            pxCount++;
          }
        }
      }
      if (pxCount < 6 || maxY <= minY) continue;
      const segH = maxY - minY + 1;
      // Ignora piccoli puntini di rumore/separatori molto bassi rispetto all'altezza del numero
      if (segH < rect.h * 0.35) continue;

      // Se il blocco è molto largo rispetto all'altezza (cifre attaccate), lo divide in N parti
      const ratio = segW / Math.max(1, segH);
      const splits = ratio > 1.35 ? Math.min(5, Math.round(ratio / 0.72)) : 1;
      const partW = segW / splits;

      for (let s = 0; s < splits; s++) {
        const subX = rect.x + seg.x0 + Math.floor(s * partW);
        const subW = Math.max(2, Math.round(partW));
        const subRect = { x: subX, y: rect.y + minY, w: subW, h: segH };
        const fp = this._buildDigitVector(ink, sw, sh, subRect);
        digitBlobs.push({ rect: subRect, fp });
      }
    }

    return digitBlobs;
  },

  /**
   * Converte una singola cifra in un vettore 16x20 con max-pooling + blur 3x3
   */
  _buildDigitVector(ink, sw, sh, rect) {
    const W = 16, H = 20;
    const grid = new Float32Array(W * H);
    const scale = Math.min((W - 2) / Math.max(1, rect.w), (H - 2) / Math.max(1, rect.h));
    const dw = Math.max(1, Math.round(rect.w * scale));
    const dh = Math.max(1, Math.round(rect.h * scale));
    const ox = Math.floor((W - dw) / 2);
    const oy = Math.floor((H - dh) / 2);

    for (let y = 0; y < dh; y++) {
      const sy0 = rect.y + Math.floor((y / dh) * rect.h);
      const sy1 = Math.min(rect.y + rect.h, rect.y + Math.max(Math.floor((y / dh) * rect.h) + 1, Math.floor(((y + 1) / dh) * rect.h)));
      for (let x = 0; x < dw; x++) {
        const sx0 = rect.x + Math.floor((x / dw) * rect.w);
        const sx1 = Math.min(rect.x + rect.w, rect.x + Math.max(Math.floor((x / dw) * rect.w) + 1, Math.floor(((x + 1) / dw) * rect.w)));
        let maxV = 0;
        for (let py = sy0; py < sy1; py++) {
          const rowOff = py * sw;
          for (let px = sx0; px < sx1; px++) {
            const v = ink[rowOff + px];
            if (v > maxV) maxV = v;
          }
        }
        grid[(oy + y) * W + (ox + x)] = maxV;
      }
    }

    // Blur 3x3 deterministico
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let sum = 0, wSum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            const wt = (dx === 0 && dy === 0) ? 4 : ((dx === 0 || dy === 0) ? 2 : 1);
            sum += grid[ny * W + nx] * wt;
            wSum += wt;
          }
        }
        out[y * W + x] = sum / wSum;
      }
    }
    return out;
  },

  _compareDigitVectors(vA, vB) {
    const W = 16, H = 20;
    let bestSim = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        let dot = 0, nA = 0, nB = 0;
        for (let y = 0; y < H; y++) {
          const yB = y + dy;
          if (yB < 0 || yB >= H) continue;
          const rA = y * W, rB = yB * W;
          for (let x = 0; x < W; x++) {
            const xB = x + dx;
            if (xB < 0 || xB >= W) continue;
            const a = vA[rA + x], b = vB[rB + xB];
            dot += a * b;
            nA += a * a;
            nB += b * b;
          }
        }
        if (nA > 0.05 && nB > 0.05) {
          const sim = dot / (Math.sqrt(nA) * Math.sqrt(nB));
          if (sim > bestSim) bestSim = sim;
        }
      }
    }
    return bestSim;
  },

  _classifySingleDigitFromMemory(fp) {
    let bestDigit = null;
    let bestScore = 0;

    for (const [digit, templates] of Object.entries(this.memory.digitTemplates)) {
      if (!templates || templates.length === 0) continue;
      for (const tpl of templates) {
        const sim = this._compareDigitVectors(fp, tpl);
        if (sim > bestScore) {
          bestScore = sim;
          bestDigit = digit;
        }
      }
      // Centroide della cifra
      if (templates.length >= 2) {
        const cent = new Float32Array(16 * 20);
        for (const tpl of templates) for (let i = 0; i < cent.length; i++) cent[i] += tpl[i];
        for (let i = 0; i < cent.length; i++) cent[i] /= templates.length;
        const simC = this._compareDigitVectors(fp, cent);
        if (simC > bestScore) {
          bestScore = simC;
          bestDigit = digit;
        }
      }
    }
    return { digit: bestDigit, score: bestScore };
  },

  /**
   * APPRENDIMENTO CIFRA-PER-CIFRA:
   * Se l'utente conferma es. "10000" e il ritaglio ha 5 segmenti, il motore salva
   * 1 prototipo per la cifra '1' e 4 prototipi per la cifra '0'.
   */
  learnFromCorrection({ digitBlobs, confirmedValue }) {
    if (confirmedValue === undefined || confirmedValue === null || isNaN(confirmedValue)) return;
    if (!Array.isArray(digitBlobs) || digitBlobs.length === 0) return;

    const digitsStr = String(confirmedValue).replace(/[^0-9]/g, '');
    if (digitsStr.length === digitBlobs.length && digitsStr.length > 0) {
      for (let i = 0; i < digitsStr.length; i++) {
        const d = digitsStr[i];
        if (!this.memory.digitTemplates[d]) this.memory.digitTemplates[d] = [];
        this.memory.digitTemplates[d].push(digitBlobs[i].fp);
        if (this.memory.digitTemplates[d].length > 25) {
          this.memory.digitTemplates[d].shift();
        }
      }
      this.memory.confirmedExamplesCount++;
    }
  },

  _renderCleanInkToDataUrl(ink, sw, sh, rect, previewCanvasId = null) {
    const padX = Math.max(18, Math.round(rect.w * 0.18));
    const padY = Math.max(14, Math.round(rect.h * 0.22));
    const outW = rect.w + padX * 2;
    const outH = rect.h + padY * 2;

    const canvas = previewCanvasId ? document.getElementById(previewCanvasId) : document.createElement('canvas');
    if (!canvas) return null;

    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    const outImg = ctx.createImageData(outW, outH);
    const outData = outImg.data;
    outData.fill(255);

    for (let y = 0; y < rect.h; y++) {
      const srcRow = (rect.y + y) * sw;
      const dstRow = (padY + y) * outW;
      for (let x = 0; x < rect.w; x++) {
        const v = ink[srcRow + rect.x + x];
        const gray = Math.max(0, Math.min(255, Math.round(255 - v * 255)));
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

  preprocessCrop(srcCanvas, box, paddingPct = 2, previewCanvasId = null) {
    if (!srcCanvas || !box || srcCanvas.width === 0) return null;

    const x = Math.max(0, box.x - paddingPct);
    const y = Math.max(0, box.y - paddingPct);
    const right = Math.min(100, box.x + box.w + paddingPct);
    const bottom = Math.min(100, box.y + box.h + paddingPct);

    const sx = Math.floor((x / 100) * srcCanvas.width);
    const sy = Math.floor((y / 100) * srcCanvas.height);
    const sw = Math.max(24, Math.floor(((right - x) / 100) * srcCanvas.width));
    const sh = Math.max(20, Math.floor(((bottom - y) / 100) * srcCanvas.height));

    const { ink } = this._extractCleanInkMatrix(srcCanvas, sx, sy, sw, sh);
    const bounds = this._findInkBounds(ink, sw, sh, 2, 2);
    const digitBlobs = this._segmentDigits(ink, sw, sh, bounds.rect);
    const dataUrl = this._renderCleanInkToDataUrl(ink, sw, sh, bounds.rect, previewCanvasId);

    return {
      dataUrl,
      digitBlobs,
      inkCount: bounds.inkCount,
      refinedBox: { ...box }
    };
  },

  locateAndPreprocessInSearchWindow(srcCanvas, refBox, searchMarginPct = 6, previewCanvasId = null) {
    if (!srcCanvas || !refBox || srcCanvas.width === 0) return null;

    const winX = Math.max(0, refBox.x - searchMarginPct);
    const winY = Math.max(0, refBox.y - searchMarginPct);
    const winR = Math.min(100, refBox.x + refBox.w + searchMarginPct);
    const winB = Math.min(100, refBox.y + refBox.h + searchMarginPct);

    const sx = Math.floor((winX / 100) * srcCanvas.width);
    const sy = Math.floor((winY / 100) * srcCanvas.height);
    const sw = Math.max(30, Math.floor(((winR - winX) / 100) * srcCanvas.width));
    const sh = Math.max(24, Math.floor(((winB - winY) / 100) * srcCanvas.height));

    const { ink } = this._extractCleanInkMatrix(srcCanvas, sx, sy, sw, sh);
    const boxW = Math.max(20, Math.round((refBox.w / 100) * srcCanvas.width));
    const boxH = Math.max(16, Math.round((refBox.h / 100) * srcCanvas.height));
    const expX = Math.round(((refBox.x - winX) / 100) * srcCanvas.width);
    const expY = Math.round(((refBox.y - winY) / 100) * srcCanvas.height);

    const stepX = Math.max(6, Math.round(boxW * 0.15));
    const stepY = Math.max(5, Math.round(boxH * 0.20));
    let best = null, bestScore = -1;

    for (let ly = 0; ly <= Math.max(0, sh - boxH); ly += stepY) {
      for (let lx = 0; lx <= Math.max(0, sw - boxW); lx += stepX) {
        let count = 0;
        for (let py = 0; py < boxH; py += 2) {
          const rowOff = (ly + py) * sw + lx;
          for (let px = 0; px < boxW; px += 2) {
            if (ink[rowOff + px] > 0.28) count++;
          }
        }
        if (count < 5) continue;
        const distPen = (Math.abs(lx - expX) / Math.max(1, sw) + Math.abs(ly - expY) / Math.max(1, sh)) * 0.45;
        const score = Math.min(1, count / Math.max(1, (boxW * boxH) / 22)) - distPen;
        if (score > bestScore) {
          bestScore = score;
          best = { lx, ly };
        }
      }
    }

    let refinedBox = { ...refBox };
    if (best) {
      refinedBox = {
        x: Math.max(0, Math.min(95, Number(((sx + best.lx) / srcCanvas.width * 100).toFixed(1)))),
        y: Math.max(0, Math.min(95, Number(((sy + best.ly) / srcCanvas.height * 100).toFixed(1)))),
        w: refBox.w,
        h: refBox.h
      };
    }

    return this.preprocessCrop(srcCanvas, refinedBox, 2, previewCanvasId);
  },

  parseStrictNumber(rawText) {
    if (!rawText) return 0;
    const matches = String(rawText).match(/\d[\d.,\s]*\d|\d+/g);
    if (!matches || matches.length === 0) return 0;
    const best = matches.reduce((a, b) => a.replace(/\D/g, '').length >= b.replace(/\D/g, '').length ? a : b);
    let cleaned = best.replace(/\s+/g, '');
    if (cleaned.includes('.') && cleaned.includes(',')) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else if (/^\d{1,3}(\.\d{3})+$/.test(cleaned)) {
      cleaned = cleaned.replace(/\./g, '');
    } else if (cleaned.includes(',')) {
      cleaned = /^\d{1,3}(,\d{3})+$/.test(cleaned) ? cleaned.replace(/,/g, '') : cleaned.replace(',', '.');
    }
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
  },

  async recognizeNumber(preprocessedObj, onStatusCallback = null) {
    const digitBlobs = preprocessedObj?.digitBlobs || [];
    const imageDataUrl = preprocessedObj?.dataUrl;
    const refinedBox = preprocessedObj?.refinedBox || null;

    // STEP 1: Se abbiamo già cifre apprese in memoria, prova la lettura CIFRA-PER-CIFRA
    const hasLearnedDigits = Object.keys(this.memory.digitTemplates).length > 0;
    if (hasLearnedDigits && digitBlobs.length > 0) {
      let builtStr = '';
      let scoreSum = 0;
      let allHighConf = true;

      for (const blob of digitBlobs) {
        const m = this._classifySingleDigitFromMemory(blob.fp);
        if (m.digit !== null && m.score >= 0.72) {
          builtStr += m.digit;
          scoreSum += m.score;
        } else {
          allHighConf = false;
          break;
        }
      }

      if (allHighConf && builtStr.length > 0) {
        const avgConf = scoreSum / digitBlobs.length;
        const val = parseFloat(builtStr);
        return {
          raw_text_read: `${builtStr} [Cifre apprese: ${digitBlobs.length} cifre, ${Math.round(avgConf * 100)}%]`,
          detected_value: isNaN(val) ? 0 : val,
          confidence: Number(Math.min(0.98, avgConf).toFixed(2)),
          bounding_box: refinedBox,
          matchedByMemory: true
        };
      }
    }

    // STEP 2: Fallback numerico puro (Tesseract whitelist 0123456789., — ZERO parole inventate!)
    await this.init(onStatusCallback);
    const ret = await this._numWorker.recognize(imageDataUrl);
    const rawText = (ret?.data?.text || '').trim();
    const conf = typeof ret?.data?.confidence === 'number' ? Math.max(0, Math.min(1, ret.data.confidence / 100)) : 0;
    const val = this.parseStrictNumber(rawText);

    return {
      raw_text_read: `${rawText || '(vuoto)'} [${digitBlobs.length} cifre rilevate]`,
      detected_value: val,
      confidence: Number(conf.toFixed(2)),
      bounding_box: refinedBox,
      matchedByMemory: false
    };
  }
};
