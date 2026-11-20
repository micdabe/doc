/**
 * HANDWRITING OCR ENGINE v15 — LINE REMOVAL + RICERCA SPAZIALE + MATCH VISIVO PURO JS
 * -------------------------------------------------------------------------
 * Correzioni strutturali rispetto alla v14:
 * 1. Rimozione automatica delle linee stampate (bordi casella e righe orizzontali)
 *    che prima sporcavano il ritaglio facendo leggere "11" o "0" a TrOCR.
 * 2. Ricerca spaziale adattiva (±7% X/Y attorno al riquadro calibrato): se la scansione
 *    di pagina 7/8/9 è spostata, il motore cerca l'inchiostro/tracciato nella finestra
 *    allargata e SPOSTA effettivamente il bounding_box sulla posizione reale del numero.
 * 3. Dilatazione 2D implementata in JS puro (funziona identicamente su Chrome, Edge, Safari, Firefox)
 *    per confrontare i tracciati a penna con tolleranza reale.
 */

window.HandwritingOCR = {
  _pipeline: null,
  _loadingPromise: null,
  isReady: false,

  memory: {
    visualTemplates: [],     // [{ value, rawText, fp: Float32Array(32*16), aspect }]
    exactRawMap: {},         // { "raw_string": numericValue }
    charSubstitutions: {},
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
      if (onStatusCallback) onStatusCallback('Caricamento modello AI scrittura a mano (solo 1ª volta)...');

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
      if (onStatusCallback) onStatusCallback('Modello AI pronto!');
      return this._pipeline;
    })();

    return this._loadingPromise;
  },

  /**
   * Converte un ritaglio di srcCanvas in una matrice di inchiostro (0..1)
   * rimuovendo le linee stampate lunghe (bordi tabella orizzontali/verticali).
   */
  _extractCleanInkMatrix(srcCanvas, sx, sy, sw, sh) {
    const c = document.createElement('canvas');
    c.width = sw;
    c.height = sh;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, sw, sh);
    ctx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, sw, sh);

    const imgData = ctx.getImageData(0, 0, sw, sh);
    const data = imgData.data;

    const lums = new Uint8Array(sw * sh);
    let minLum = 255;
    let maxLum = 0;

    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const lum = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      lums[p] = lum;
      if (lum < minLum) minLum = lum;
      if (lum > maxLum) maxLum = lum;
    }

    const range = Math.max(25, maxLum - minLum);
    // Matrice normalizzata di inchiostro: 0 = bianco, 1 = nero pieno
    const ink = new Float32Array(sw * sh);

    for (let p = 0; p < lums.length; p++) {
      const norm = ((lums[p] - minLum) / range) * 255;
      if (norm > 210) {
        ink[p] = 0;
      } else {
        ink[p] = Math.min(1, (215 - norm) / 160);
      }
    }

    // RIMOZIONE LINEE ORIZZONTALI STAMPATE (es. riga di compilazione o bordo superiore/inferiore casella)
    // Se una riga ha > 62% di pixel scuri continui o sparsi, è una linea del modulo -> la cancelliamo
    for (let y = 0; y < sh; y++) {
      let darkCount = 0;
      const rowOff = y * sw;
      for (let x = 0; x < sw; x++) {
        if (ink[rowOff + x] > 0.25) darkCount++;
      }
      if (darkCount > sw * 0.62) {
        for (let x = 0; x < sw; x++) {
          // Cancella la linea ma preserva leggermente l'intersezione se sopra e sotto c'è un tratto verticale
          const above = y > 1 ? ink[(y - 2) * sw + x] : 0;
          const below = y < sh - 2 ? ink[(y + 2) * sw + x] : 0;
          ink[rowOff + x] = (above > 0.35 && below > 0.35) ? Math.min(above, below) : 0;
        }
      }
    }

    // RIMOZIONE LINEE VERTICALI STAMPATE (bordi sinistro/destro della casella)
    for (let x = 0; x < sw; x++) {
      let darkCount = 0;
      for (let y = 0; y < sh; y++) {
        if (ink[y * sw + x] > 0.25) darkCount++;
      }
      if (darkCount > sh * 0.72) {
        for (let y = 0; y < sh; y++) {
          const left = x > 1 ? ink[y * sw + (x - 2)] : 0;
          const right = x < sw - 2 ? ink[y * sw + (x + 2)] : 0;
          ink[y * sw + x] = (left > 0.35 && right > 0.35) ? Math.min(left, right) : 0;
        }
      }
    }

    return { ink, sw, sh };
  },

  /**
   * Calcola l'impronta visiva 32x16 con dilatazione/sfocatura in JS puro (100% deterministica).
   */
  _buildDilatedFingerprintFromInk(ink, sw, sh, rect) {
    const W = 32;
    const H = 16;
    const rawGrid = new Float32Array(W * H);

    const rw = Math.max(1, rect.w);
    const rh = Math.max(1, rect.h);

    // Mappa l'inchiostro nel rettangolo dentro una griglia 32x16 preservando le proporzioni
    const scale = Math.min((W - 2) / rw, (H - 2) / rh);
    const dw = Math.max(1, Math.round(rw * scale));
    const dh = Math.max(1, Math.round(rh * scale));
    const ox = Math.floor((W - dw) / 2);
    const oy = Math.floor((H - dh) / 2);

    for (let y = 0; y < dh; y++) {
      const sy0 = rect.y + Math.floor((y / dh) * rh);
      const sy1 = Math.min(rect.y + rh, rect.y + Math.max(Math.floor((y / dh) * rh) + 1, Math.floor(((y + 1) / dh) * rh)));
      for (let x = 0; x < dw; x++) {
        const sx0 = rect.x + Math.floor((x / dw) * rw);
        const sx1 = Math.min(rect.x + rw, rect.x + Math.max(Math.floor((x / dw) * rw) + 1, Math.floor(((x + 1) / dw) * rw)));

        // Usa il massimo (max-pooling) così i tratti sottili a penna NON spariscono mai nel downscaling!
        let maxVal = 0;
        for (let py = sy0; py < sy1; py++) {
          const rowOff = py * sw;
          for (let px = sx0; px < sx1; px++) {
            const v = ink[rowOff + px];
            if (v > maxVal) maxVal = v;
          }
        }
        rawGrid[(oy + y) * W + (ox + x)] = maxVal;
      }
    }

    // Dilatazione morbida 3x3 (Gaussian-like blur in JS puro) per tollerare variazioni naturali della mano
    const blurred = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let sum = 0;
        let wSum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            const weight = (dx === 0 && dy === 0) ? 4 : ((dx === 0 || dy === 0) ? 2 : 1);
            sum += rawGrid[ny * W + nx] * weight;
            wSum += weight;
          }
        }
        blurred[y * W + x] = sum / wSum;
      }
    }

    return blurred;
  },

  /**
   * Trova il bounding box effettivo dell'inchiostro dentro una matrice pulita dalle linee.
   */
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
    const inkRatio = count / Math.max(1, sw * sh);
    if (count < 10 || maxX <= minX || maxY <= minY) {
      return {
        rect: { x: marginX, y: marginY, w: Math.max(1, sw - marginX * 2), h: Math.max(1, sh - marginY * 2) },
        inkCount: count,
        inkRatio
      };
    }
    return {
      rect: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
      inkCount: count,
      inkRatio
    };
  },

  /**
   * Renderizza la matrice pulita su un canvas con bordo bianco generoso (ideale per TrOCR e anteprima).
   */
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
    outData.fill(255); // Tutto bianco opaco

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

  /**
   * Pre-processing diretto su un box ESATTO scelto manualmente dall'utente (es. Pagina 1 o drag manuale).
   */
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
    const fp = this._buildDilatedFingerprintFromInk(ink, sw, sh, bounds.rect);
    const dataUrl = this._renderCleanInkToDataUrl(ink, sw, sh, bounds.rect, previewCanvasId);

    return {
      dataUrl,
      fingerprint: fp,
      inkRatio: bounds.inkRatio,
      inkCount: bounds.inkCount,
      aspect: bounds.rect.w / Math.max(1, bounds.rect.h),
      refinedBox: { ...box }
    };
  },

  /**
   * RICERCA SPAZIALE ATTIVA per le pagine successive (2..N):
   * Cerca il numero in una finestra allargata (±7% X e ±7% Y attorno al box calibrato)
   * spostando una finestra delle dimensioni del box calibrato fino a trovare:
   * - la massima corrispondenza visiva con i tracciati appresi, OPPURE
   * - il blocco di inchiostro più consistente vicino al centro atteso.
   * Restituisce anche `refinedBox` aggiornato alle coordinate reali su questa pagina!
   */
  locateAndPreprocessInSearchWindow(srcCanvas, refBox, searchMarginPct = 7, previewCanvasId = null) {
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

    // Dimensioni in pixel del box calibrato
    const boxW = Math.max(20, Math.round((refBox.w / 100) * srcCanvas.width));
    const boxH = Math.max(16, Math.round((refBox.h / 100) * srcCanvas.height));
    const expectedLocalX = Math.round(((refBox.x - winX) / 100) * srcCanvas.width);
    const expectedLocalY = Math.round(((refBox.y - winY) / 100) * srcCanvas.height);

    // Scansiona posizioni candidate nella finestra allargata (passo grossolano 12% delle dimensioni del box)
    const stepX = Math.max(6, Math.round(boxW * 0.14));
    const stepY = Math.max(5, Math.round(boxH * 0.18));
    const maxLocalX = Math.max(0, sw - boxW);
    const maxLocalY = Math.max(0, sh - boxH);

    let bestCandidate = null;
    let bestCombinedScore = -1;

    const hasTemplates = this.memory.visualTemplates.length > 0;

    for (let ly = 0; ly <= maxLocalY; ly += stepY) {
      for (let lx = 0; lx <= maxLocalX; lx += stepX) {
        // Conta rapidamente l'inchiostro in questa finestra candidata
        let cCount = 0;
        let minX = boxW, minY = boxH, maxX = 0, maxY = 0;
        for (let py = 0; py < boxH; py += 2) {
          const rowOff = (ly + py) * sw + lx;
          for (let px = 0; px < boxW; px += 2) {
            if (ink[rowOff + px] > 0.28) {
              cCount++;
              if (px < minX) minX = px;
              if (py < minY) minY = py;
              if (px > maxX) maxX = px;
              if (py > maxY) maxY = py;
            }
          }
        }
        if (cCount < 4) continue; // Finestra vuota

        const subRect = {
          x: lx + minX,
          y: ly + minY,
          w: Math.max(4, maxX - minX + 2),
          h: Math.max(4, maxY - minY + 2)
        };

        // Distanza normalizzata dalla posizione attesa (preferisce candidati vicini a refBox a parità di punteggio)
        const distPenalty = (
          Math.abs(lx - expectedLocalX) / Math.max(1, sw) +
          Math.abs(ly - expectedLocalY) / Math.max(1, sh)
        ) * 0.18;

        let score = 0;
        let fp = null;
        if (hasTemplates) {
          fp = this._buildDilatedFingerprintFromInk(ink, sw, sh, subRect);
          const match = this._findBestVisualMatch(fp);
          score = match.score - distPenalty;
        } else {
          // Senza template, preferisce il blocco d'inchiostro ben centrato vicino a refBox
          const density = Math.min(1, cCount / Math.max(1, (boxW * boxH) / 20));
          score = density - distPenalty;
        }

        if (score > bestCombinedScore) {
          bestCombinedScore = score;
          bestCandidate = { lx, ly, subRect, fp, cCount };
        }
      }
    }

    // Se non ha trovato nessun candidato con inchiostro, usa comunque la posizione attesa
    let finalRect;
    let refinedBox = { ...refBox };

    if (bestCandidate) {
      finalRect = bestCandidate.subRect;
      refinedBox = {
        x: Math.max(0, Math.min(95, Number(((sx + bestCandidate.lx) / srcCanvas.width * 100).toFixed(1)))),
        y: Math.max(0, Math.min(95, Number(((sy + bestCandidate.ly) / srcCanvas.height * 100).toFixed(1)))),
        w: refBox.w,
        h: refBox.h
      };
    } else {
      const bounds = this._findInkBounds(ink, sw, sh, 2, 2);
      finalRect = bounds.rect;
    }

    const fp = bestCandidate?.fp || this._buildDilatedFingerprintFromInk(ink, sw, sh, finalRect);
    const dataUrl = this._renderCleanInkToDataUrl(ink, sw, sh, finalRect, previewCanvasId);
    const inkCount = bestCandidate ? bestCandidate.cCount * 4 : 0;

    return {
      dataUrl,
      fingerprint: fp,
      inkRatio: inkCount / Math.max(1, boxW * boxH),
      inkCount,
      aspect: finalRect.w / Math.max(1, finalRect.h),
      refinedBox
    };
  },

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
        if (normA > 0.1 && normB > 0.1) {
          const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
          if (sim > bestSim) bestSim = sim;
        }
      }
    }
    return bestSim;
  },

  _findBestVisualMatch(fingerprint) {
    if (!fingerprint || this.memory.visualTemplates.length === 0) {
      return { value: null, score: 0 };
    }

    let bestVal = null;
    let bestScore = 0;
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

    // Centroide medio per ogni valore con 2+ esempi
    for (const [valStr, fps] of Object.entries(byValue)) {
      if (fps.length < 2) continue;
      const centroid = new Float32Array(32 * 16);
      for (const fp of fps) {
        for (let i = 0; i < centroid.length; i++) centroid[i] += fp[i];
      }
      for (let i = 0; i < centroid.length; i++) centroid[i] /= fps.length;

      const simCentroid = this._compareFingerprints(fingerprint, centroid);
      if (simCentroid > bestScore) {
        bestScore = simCentroid;
        bestVal = Number(valStr);
      }
    }

    return { value: bestVal, score: bestScore };
  },

  learnFromCorrection({ fingerprint, rawTextRead, confirmedValue }) {
    if (confirmedValue === undefined || confirmedValue === null || isNaN(confirmedValue)) return;

    const cleanRaw = String(rawTextRead || '').split('|')[0].split('[')[0].trim();
    const confirmedStr = String(confirmedValue);

    if (fingerprint) {
      this.memory.visualTemplates.push({
        value: Number(confirmedValue),
        rawText: cleanRaw,
        fp: fingerprint
      });
      if (this.memory.visualTemplates.length > 80) {
        this.memory.visualTemplates.shift();
      }
    }

    const digitsOnlyConfirmed = confirmedStr.replace(/[^0-9]/g, '');
    if (digitsOnlyConfirmed.length > 0) {
      this.memory.confirmedLengths.push(digitsOnlyConfirmed.length);
    }

    if (cleanRaw && !cleanRaw.startsWith('(') && cleanRaw !== 'ERRORE OCR') {
      const key = cleanRaw.toLowerCase().replace(/\s+/g, '');
      if (key.length > 0) {
        this.memory.exactRawMap[key] = Number(confirmedValue);
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

    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
  },

  async recognize(preprocessedObj, onStatusCallback = null) {
    const imageDataUrl = typeof preprocessedObj === 'string' ? preprocessedObj : preprocessedObj?.dataUrl;
    const fingerprint = typeof preprocessedObj === 'object' ? preprocessedObj?.fingerprint : null;
    const inkCount = typeof preprocessedObj === 'object' ? (preprocessedObj?.inkCount || 0) : 50;
    const refinedBox = typeof preprocessedObj === 'object' ? preprocessedObj?.refinedBox : null;

    // 1. Confronto con la Memoria Visiva (ora con line-removal + dilatazione JS pura)
    const visualMatch = this._findBestVisualMatch(fingerprint);

    if (visualMatch.value !== null && visualMatch.score >= 0.62) {
      return {
        raw_text_read: `${visualMatch.value} [Memoria Visiva ${Math.round(visualMatch.score * 100)}%]`,
        detected_value: visualMatch.value,
        confidence: Number(Math.min(0.99, visualMatch.score + 0.18).toFixed(2)),
        bounding_box: refinedBox,
        matchedByMemory: true
      };
    }

    // 2. Esecuzione TrOCR sull'immagine pulita dalle linee stampate
    const pipe = await this.init(onStatusCallback);
    const out = await pipe(imageDataUrl);
    const rawText = (Array.isArray(out) && out[0]?.generated_text) ? out[0].generated_text.trim() : '';

    const exactKey = rawText.toLowerCase().replace(/\s+/g, '');
    const usedExactCorrection = this.memory.exactRawMap[exactKey] !== undefined;
    let value = this.parseHandwrittenNumber(rawText);

    // 3. Controllo di coerenza: se abbiamo già esempi visivi (sim >= 0.48) E TrOCR ha restituito
    //    0 oppure un numero palesemente troncato (es. "1" o "11" quando la lunghezza attesa è >= 4 cifre)
    const avgConfirmedLen = this.memory.confirmedLengths.length > 0
      ? this.memory.confirmedLengths.reduce((a, b) => a + b, 0) / this.memory.confirmedLengths.length
      : 0;
    const valDigitsLen = String(value).replace(/[^0-9]/g, '').length;
    const looksTruncated = avgConfirmedLen >= 4 && valDigitsLen <= 2;

    if ((value === 0 || looksTruncated) && inkCount >= 12 && visualMatch.value !== null && visualMatch.score >= 0.48) {
      return {
        raw_text_read: `${visualMatch.value} [Recupero Visivo ${Math.round(visualMatch.score * 100)}% | TrOCR="${rawText}"]`,
        detected_value: visualMatch.value,
        confidence: Number(Math.min(0.90, visualMatch.score + 0.15).toFixed(2)),
        bounding_box: refinedBox,
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

    const simNote = visualMatch.value !== null
      ? ` | Sim visiva: ${Math.round(visualMatch.score * 100)}% (cand: ${visualMatch.value})`
      : '';
    return {
      raw_text_read: usedExactCorrection
        ? `${rawText} → corretto in ${value}`
        : `${rawText || '(vuoto)'}${simNote}`,
      detected_value: value,
      confidence,
      bounding_box: refinedBox,
      matchedByMemory: usedExactCorrection
    };
  }
};
