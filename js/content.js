// ローカルで編集している方へ。
// コードを編集する前に、一度最新のファイルを取得してください。

(function () {
  let config = {
    deepLKey: null,
    useTrans: true,
    mode: true,
    mainLang: 'original',
    subLang: 'en'
  };

  const NO_LYRICS_SENTINEL = '__NO_LYRICS__';

  let currentKey = null;
  let lyricsData = [];
  let hasTimestamp = false;
  let dynamicLines = null;
  let lyricsCandidates = null;
  let selectedCandidateId = null;
  let lastActiveIndex = -1;
  let lastTimeForChars = -1;
  let lyricRafId = null;

  const ui = {
    bg: null, wrapper: null,
    title: null, artist: null, artwork: null,
    lyrics: null, input: null, settings: null,
    btnArea: null, uploadMenu: null, deleteDialog: null,
    settingsBtn: null,
    lyricsBtn: null,
    fallbackToast: null
  };

  let hideTimer = null;
  let uploadMenuGlobalSetup = false;
  let deleteDialogGlobalSetup = false;
  let settingsOutsideClickSetup = false;
  let fallbackToastTimer = null;

  const handleInteraction = () => {
    if (!ui.btnArea) return;
    ui.btnArea.classList.remove('inactive');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!ui.settings?.classList.contains('active') && !ui.btnArea.matches(':hover')) {
        ui.btnArea.classList.add('inactive');
      }
    }, 3000);
  };

  const storage = {
    _api: chrome?.storage?.local,
    get: (k) => new Promise(r => {
      if (!storage._api) return r(null);
      storage._api.get([k], res => r(res[k] || null));
    }),
    set: (k, v) => { if (storage._api) storage._api.set({ [k]: v }); },
    remove: (k) => { if (storage._api) storage._api.remove(k); },
    clear: () => confirm('全データを削除しますか？') && storage._api?.clear(() => location.reload())
  };

  const resolveDeepLTargetLang = (lang) => {
    switch ((lang || '').toLowerCase()) {
      case 'en':
      case 'en-us':
      case 'en-gb':
        return 'EN';
      case 'ja':
        return 'JA';
      case 'ko':
        return 'KO';
      case 'fr':
        return 'FR';
      case 'de':
        return 'DE';
      case 'es':
        return 'ES';
      case 'zh':
      case 'zh-cn':
      case 'zh-tw':
        return 'ZH';
      default:
        return 'JA';
    }
  };

  const parseLRCInternal = (lrc) => {
    if (!lrc) return { lines: [], hasTs: false };

    const tagTest = /\[\d{2}:\d{2}\.\d{2,3}\]/;
    if (!tagTest.test(lrc)) {
      const lines = lrc
        .split(/\r?\n/)
        .map(line => {
          const text = line.replace(/^\s+|\s+$/g, '');
          return { time: null, text };
        });
      return { lines, hasTs: false };
    }

    const tagExp = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/g;
    const result = [];
    let match;
    let lastTime = null;
    let lastIndex = 0;

    while ((match = tagExp.exec(lrc)) !== null) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      const fracStr = match[3];
      const frac = parseInt(fracStr, 10) / (fracStr.length === 2 ? 100 : 1000);
      const time = min * 60 + sec + frac;

      if (lastTime !== null) {
        const rawText = lrc.slice(lastIndex, match.index);
        const cleaned = rawText.replace(/\r?\n/g, ' ');
        const text = cleaned.trim();
        result.push({ time: lastTime, text });
      }

      lastTime = time;
      lastIndex = tagExp.lastIndex;
    }

    if (lastTime !== null && lastIndex < lrc.length) {
      const rawText = lrc.slice(lastIndex);
      const cleaned = rawText.replace(/\r?\n/g, ' ');
      const text = cleaned.trim();
      result.push({ time: lastTime, text });
    }

    result.sort((a, b) => (a.time || 0) - (b.time || 0));
    return { lines: result, hasTs: true };
  };

  const parseBaseLRC = (lrc) => {
    const { lines, hasTs } = parseLRCInternal(lrc);
    hasTimestamp = hasTs;
    return lines;
  };

  const parseLRCNoFlag = (lrc) => {
    return parseLRCInternal(lrc).lines;
  };

  const normalizeStr = (s) => (s || '').replace(/\s+/g, '').trim();

  const isMixedLang = (s) => {
    if (!s) return false;
    const hasLatin = /[A-Za-z]/.test(s);
    const hasCJK = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF]/.test(s);
    const hasHangul = /[\uAC00-\uD7AF]/.test(s);
    let kinds = 0;
    if (hasLatin) kinds++;
    if (hasCJK) kinds++;
    if (hasHangul) kinds++;
    return kinds >= 2;
  };

  const detectCharScript = (ch) => {
    if (!ch) return 'OTHER';
    if (/[A-Za-z]/.test(ch)) return 'LATIN';
    if (/[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF]/.test(ch)) return 'CJK';
    if (/[\uAC00-\uD7AF]/.test(ch)) return 'HANGUL';
    return 'OTHER';
  };

  const segmentByScript = (s) => {
    const result = [];
    if (!s) return result;
    let currentScript = null;
    let buf = '';
    for (const ch of s) {
      const script = detectCharScript(ch);
      if (currentScript === null) {
        currentScript = script;
        buf = ch;
      } else if (script === currentScript) {
        buf += ch;
      } else {
        result.push({ script: currentScript, text: buf });
        currentScript = script;
        buf = ch;
      }
    }
    if (buf) {
      result.push({ script: currentScript, text: buf });
    }
    return result;
  };

  const shouldTranslateSegment = (script, langCode) => {
    const lang = (langCode || '').toLowerCase();
    if (script === 'OTHER') return false;

    switch (lang) {
      case 'ja':
        return script === 'LATIN' || script === 'HANGUL';
      case 'en':
        return script === 'CJK' || script === 'HANGUL';
      case 'ko':
        return script === 'LATIN' || script === 'CJK';
      default:
        return script !== 'LATIN';
    }
  };

  const translateMixedSegments = async (lines, indexes, langCode, targetLang) => {
    try {
      const segmentsToTranslate = [];
      const perLineSegments = {};

      indexes.forEach(idx => {
        const line = lines[idx];
        const text = (line && line.text) || '';
        const segs = segmentByScript(text);
        const segMeta = [];

        segs.forEach(seg => {
          if (shouldTranslateSegment(seg.script, langCode)) {
            const translateIndex = segmentsToTranslate.length;
            segmentsToTranslate.push(seg.text);
            segMeta.push({ original: seg.text, translateIndex });
          } else {
            segMeta.push({ original: seg.text, translateIndex: null });
          }
        });

        perLineSegments[idx] = segMeta;
      });

      if (!segmentsToTranslate.length) return null;

      const res = await new Promise(resolve => {
        chrome.runtime.sendMessage(
          {
            type: 'TRANSLATE',
            payload: { text: segmentsToTranslate, apiKey: config.deepLKey, targetLang }
          },
          resolve
        );
      });

      if (!res?.success || !Array.isArray(res.translations) || res.translations.length !== segmentsToTranslate.length) {
        return null;
      }

      const segTranslations = res.translations.map(t => t.text || '');
      const result = {};

      Object.keys(perLineSegments).forEach(key => {
        const lineIdx = Number(key);
        const segMeta = perLineSegments[lineIdx];
        let rebuilt = '';
        segMeta.forEach(seg => {
          if (seg.translateIndex == null) {
            rebuilt += seg.original;
          } else {
            rebuilt += segTranslations[seg.translateIndex] ?? seg.original;
          }
        });
        result[lineIdx] = rebuilt;
      });

      return result;
    } catch (e) {
      console.error('DeepL mixed-line fallback failed', e);
      return null;
    }
  };

  const dedupePrimarySecondary = (lines) => {
    if (!Array.isArray(lines)) return lines;
    lines.forEach(l => {
      if (!l.translation) return;
      const src = normalizeStr(l.text);
      const trn = normalizeStr(l.translation);
      if (src === trn && !isMixedLang(l.text)) {
        delete l.translation;
      }
    });
    return lines;
  };

  const translateTo = async (lines, langCode) => {
    if (!config.deepLKey || !lines.length) return null;
    const targetLang = resolveDeepLTargetLang(langCode);
    try {
      const baseTexts = lines.map(l => l.text || '');
      const res = await new Promise(resolve => {
        chrome.runtime.sendMessage(
          {
            type: 'TRANSLATE',
            payload: { text: baseTexts, apiKey: config.deepLKey, targetLang }
          },
          resolve
        );
      });

      if (!res?.success || !Array.isArray(res.translations) || res.translations.length !== lines.length) {
        return null;
      }

      let translated = res.translations.map(t => t.text || '');

      const fallbackIndexes = [];
      for (let i = 0; i < lines.length; i++) {
        const src = baseTexts[i];
        const trn = translated[i];
        if (!src) continue;
        if (normalizeStr(src) === normalizeStr(trn) && isMixedLang(src)) {
          fallbackIndexes.push(i);
        }
      }

      if (fallbackIndexes.length) {
        const mixedFallback = await translateMixedSegments(lines, fallbackIndexes, langCode, targetLang);
        if (mixedFallback) {
          fallbackIndexes.forEach(i => {
            if (mixedFallback[i]) translated[i] = mixedFallback[i];
          });
        }
      }

      return translated;
    } catch (e) {
      console.error('DeepL failed', e);
    }
    return null;
  };

  const getMetadata = () => {
    if (navigator.mediaSession?.metadata) {
      const { title, artist, artwork } = navigator.mediaSession.metadata;
      return {
        title,
        artist,
        src: artwork.length ? artwork[artwork.length - 1].src : null
      };
    }
    const t = document.querySelector('yt-formatted-string.title.style-scope.ytmusic-player-bar');
    const a = document.querySelector('.byline.style-scope.ytmusic-player-bar');
    return (t && a)
      ? { title: t.textContent, artist: a.textContent.split('•')[0].trim(), src: null }
      : null;
  };

  const getCurrentVideoUrl = () => {
    try {
      const url = new URL(location.href);
      const vid = url.searchParams.get('v');
      return vid ? `https://youtu.be/${vid}` : location.href;
    } catch (e) {
      console.warn('Failed to get current video url', e);
      return '';
    }
  };

  const getCurrentVideoId = () => {
    try {
      const url = new URL(location.href);
      return url.searchParams.get('v');
    } catch (e) {
      console.warn('Failed to get current video id', e);
      return null;
    }
  };

  const createEl = (tag, id, cls, html) => {
    const el = document.createElement(tag);
    if (id) el.id = id;
    if (cls) el.className = cls;
    if (html !== undefined && html !== null) el.innerHTML = html;
    return el;
  };

  function showFallbackToast(message) {
    let toast = ui.fallbackToast || document.getElementById('ytm-fallback-toast');
    if (!toast) {
      toast = createEl('div', 'ytm-fallback-toast', '', '');
      document.body.appendChild(toast);
      ui.fallbackToast = toast;
    } else {
      ui.fallbackToast = toast;
    }

    toast.textContent = message;
    toast.classList.add('visible');

    if (fallbackToastTimer) clearTimeout(fallbackToastTimer);
    fallbackToastTimer = setTimeout(() => {
      toast.classList.remove('visible');
    }, 5000);
  }

  function setupAutoHideEvents() {
    if (document.body.dataset.autohideSetup) return;
    ['mousemove', 'click', 'keydown'].forEach(ev => document.addEventListener(ev, handleInteraction));
    document.body.dataset.autohideSetup = 'true';
    handleInteraction();
  }

  async function applyTranslations(baseLines, youtubeUrl) {
    if (!config.useTrans || !Array.isArray(baseLines) || !baseLines.length) return baseLines;

    const mainLangStored = await storage.get('ytm_main_lang');
    const subLangStored = await storage.get('ytm_sub_lang');
    if (mainLangStored) config.mainLang = mainLangStored;
    if (subLangStored !== null && subLangStored !== undefined) config.subLang = subLangStored;

    const mainLang = config.mainLang || 'original';
    const subLang = config.subLang || '';

    const langsToFetch = [];
    if (mainLang && mainLang !== 'original') langsToFetch.push(mainLang);
    if (subLang && subLang !== 'original' && subLang !== mainLang && subLang) langsToFetch.push(subLang);
    if (!langsToFetch.length) return baseLines;

    let lrcMap = {};
    try {
      const res = await new Promise(resolve => {
        chrome.runtime.sendMessage({
          type: 'GET_TRANSLATION',
          payload: { youtube_url: youtubeUrl, langs: langsToFetch }
        }, resolve);
      });
      if (res?.success && res.lrcMap) lrcMap = res.lrcMap;
    } catch (e) {
      console.warn('GET_TRANSLATION failed', e);
    }

    const transLinesByLang = {};
    const needDeepL = [];

    langsToFetch.forEach(lang => {
      const lrc = (lrcMap && lrcMap[lang]) || '';
      if (lrc) {
        const parsed = parseLRCNoFlag(lrc);
        transLinesByLang[lang] = parsed;
      } else {
        needDeepL.push(lang);
      }
    });

    if (needDeepL.length && config.deepLKey) {
      for (const lang of needDeepL) {
        const translatedTexts = await translateTo(baseLines, lang);
        if (translatedTexts && translatedTexts.length === baseLines.length) {
          const lines = baseLines.map((l, i) => ({
            time: l.time,
            text: translatedTexts[i]
          }));
          transLinesByLang[lang] = lines;

          const plain = translatedTexts.join('\n');
          if (plain.trim()) {
            chrome.runtime.sendMessage({
              type: 'REGISTER_TRANSLATION',
              payload: { youtube_url: youtubeUrl, lang, lyrics: plain }
            }, (res) => {
              console.log('[CS] REGISTER_TRANSLATION', lang, res);
            });
          }
        }
      }
    }

    const alignedMap = buildAlignedTranslations(baseLines, transLinesByLang);
    const final = baseLines.map(l => ({ ...l }));

    const getLangTextAt = (langCode, index, baseText) => {
      if (!langCode || langCode === 'original') return baseText;
      const arr = alignedMap[langCode];
      if (!arr) return baseText;

      const v = arr[index];
      return (v === null || v === undefined) ? baseText : v;
    };

    for (let i = 0; i < final.length; i++) {
      const baseText = final[i].text;
      let primary = getLangTextAt(mainLang, i, baseText);
      let secondary = null;

      if (subLang && subLang !== mainLang) {
        secondary = getLangTextAt(subLang, i, baseText);
      } else if (!subLang && mainLang !== 'original') {
        if (normalizeStr(primary) !== normalizeStr(baseText)) {
          secondary = baseText;
        }
      }

      if (secondary && normalizeStr(primary) === normalizeStr(secondary)) {
        if (!isMixedLang(baseText)) secondary = null;
      }

      final[i].text = primary;
      if (secondary) final[i].translation = secondary;
      else delete final[i].translation;
    }

    dedupePrimarySecondary(final);
    return final;
  }

  const buildAlignedTranslations = (baseLines, transLinesByLang) => {
    const alignedMap = {};
    const TOL = 0.15;

    Object.keys(transLinesByLang).forEach(lang => {
      const arr = transLinesByLang[lang];
      const res = new Array(baseLines.length).fill(null);

      if (!Array.isArray(arr) || !arr.length) {
        alignedMap[lang] = res;
        return;
      }

      let j = 0;
      for (let i = 0; i < baseLines.length; i++) {
        const baseLine = baseLines[i] || {};
        const tBase = baseLine.time;
        const baseTextRaw = (baseLine.text ?? '');

        if (baseTextRaw.trim() === '') {
          res[i] = '';
          continue;
        }

        if (typeof tBase !== 'number') {
          const cand = arr[i];
          if (cand && typeof cand.text === 'string') {
            const raw = cand.text;
            const trimmed = raw.trim();
            res[i] = trimmed === '' ? '' : trimmed;
          }
          continue;
        }

        while (
          j < arr.length &&
          typeof arr[j].time === 'number' &&
          arr[j].time < tBase - TOL
        ) {
          j++;
        }

        if (
          j < arr.length &&
          typeof arr[j].time === 'number' &&
          Math.abs(arr[j].time - tBase) <= TOL
        ) {
          const raw = (arr[j].text ?? '');
          const trimmed = raw.trim();
          res[i] = trimmed === '' ? '' : trimmed;
        } else {
          res[i] = null;
        }
      }

      alignedMap[lang] = res;
    });

    return alignedMap;
  };

  async function applyLyricsText(rawLyrics) {
    const keyAtStart = currentKey;

    if (!rawLyrics || typeof rawLyrics !== 'string' || !rawLyrics.trim()) {
      if (keyAtStart !== currentKey) return;
      lyricsData = [];
      hasTimestamp = false;
      renderLyrics([]);
      return;
    }

    let parsed = parseBaseLRC(rawLyrics);
    const videoUrl = getCurrentVideoUrl();
    let finalLines = parsed;

    if (config.useTrans) {
      finalLines = await applyTranslations(parsed, videoUrl);
    }

    if (keyAtStart !== currentKey) return;

    lyricsData = finalLines;
    renderLyrics(finalLines);
  }

  async function selectCandidateById(candId) {
    if (!Array.isArray(lyricsCandidates) || !lyricsCandidates.length) return;
    const cand = lyricsCandidates.find((c, idx) => (c.id || String(idx)) === candId);
    if (!cand || typeof cand.lyrics !== 'string' || !cand.lyrics.trim()) return;

    selectedCandidateId = candId;
    dynamicLines = null;

    if (currentKey) {
      storage.set(currentKey, {
        lyrics: cand.lyrics,
        dynamicLines: null,
        noLyrics: false,
        candidateId: cand.id || null
      });
    }

    await applyLyricsText(cand.lyrics);

    const youtube_url = getCurrentVideoUrl();
    const video_id = getCurrentVideoId();
    const candidate_id = cand.id || candId;

    try {
      chrome.runtime.sendMessage(
        {
          type: 'SELECT_LYRICS_CANDIDATE',
          payload: { youtube_url, video_id, candidate_id }
        },
        (res) => {
          console.log('[CS] SELECT_LYRICS_CANDIDATE result:', res);
        }
      );
    } catch (e) {
      console.warn('[CS] SELECT_LYRICS_CANDIDATE failed to send', e);
    }

    const reloadKey = currentKey;
    setTimeout(() => {
      const metaNow = getMetadata();
      if (!metaNow) return;

      const keyNow = `${metaNow.title}///${metaNow.artist}`;
      if (keyNow !== reloadKey) return;

      storage.remove(reloadKey);
      loadLyrics(metaNow);
    }, 10000);
  }

  function refreshCandidateMenu() {
    if (!ui.uploadMenu) {
      if (ui.lyricsBtn) ui.lyricsBtn.classList.remove('ytm-lyrics-has-candidates');
      return;
    }
    const section = ui.uploadMenu.querySelector('.ytm-upload-menu-candidates');
    const list = section ? section.querySelector('.ytm-upload-menu-candidate-list') : null;
    if (!section || !list) return;

    list.innerHTML = '';

    if (!Array.isArray(lyricsCandidates) || lyricsCandidates.length <= 1) {
      section.style.display = 'none';
      if (ui.lyricsBtn) ui.lyricsBtn.classList.remove('ytm-lyrics-has-candidates');
      return;
    }

    section.style.display = 'block';

    lyricsCandidates.forEach((cand, idx) => {
      const id = cand.id || String(idx);
      const btn = document.createElement('button');
      btn.className = 'ytm-upload-menu-item ytm-upload-menu-item-candidate';
      btn.dataset.action = 'candidate';
      btn.dataset.candidateId = id;

      let labelText = '';
      if (cand.artist && cand.title) {
        labelText = `${cand.artist} - ${cand.title}`;
      } else if (cand.artist || cand.title) {
        labelText = `${cand.artist || ''}${cand.artist && cand.title ? ' - ' : ''}${cand.title || ''}`;
      } else if (cand.path) {
        labelText = cand.path;
      } else {
        labelText = `候補${idx + 1}`;
      }
      if (cand.source) labelText += ` [${cand.source}]`;
      if (cand.has_synced) labelText += ' ⏱';

      btn.textContent = labelText;
      list.appendChild(btn);
    });

    if (ui.lyricsBtn) {
      ui.lyricsBtn.classList.remove('ytm-lyrics-has-candidates');
      void ui.lyricsBtn.offsetWidth;
      ui.lyricsBtn.classList.add('ytm-lyrics-has-candidates');
    }
  }

  function setupUploadMenu(uploadBtn) {
    if (!ui.btnArea || ui.uploadMenu) return;
    ui.btnArea.style.position = 'relative';

    const menu = createEl('div', 'ytm-upload-menu', 'ytm-upload-menu');
    menu.innerHTML = `
            <div class="ytm-upload-menu-title">Lyrics</div>
            <button class="ytm-upload-menu-item" data-action="local">
                <span class="ytm-upload-menu-item-icon">💾</span>
                <span>ローカル歌詞読み込み / ReadLyrics</span>
            </button>
            <button class="ytm-upload-menu-item" data-action="add-sync">
                <span class="ytm-upload-menu-item-icon">✨</span>
                <span>歌詞同期を追加 / AddTiming</span>
            </button>
            <div class="ytm-upload-menu-separator"></div>
            <button class="ytm-upload-menu-item" data-action="fix">
                <span class="ytm-upload-menu-item-icon">✏️</span>
                <span>歌詞の間違いを修正 / FixLyrics</span>
            </button>
            <div class="ytm-upload-menu-candidates" style="display:none;">
                <div class="ytm-upload-menu-subtitle">別の歌詞を選択</div>
                <div class="ytm-upload-menu-candidate-list"></div>
            </div>
        `;
    ui.btnArea.appendChild(menu);
    ui.uploadMenu = menu;

    const toggleMenu = (show) => {
      if (!ui.uploadMenu) return;
      const cl = ui.uploadMenu.classList;
      if (show === undefined) cl.toggle('visible');
      else if (show) cl.add('visible');
      else cl.remove('visible');
    };

    uploadBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleMenu();
    });

    ui.uploadMenu.addEventListener('click', (ev) => {
      const target = ev.target.closest('.ytm-upload-menu-item');
      if (!target) return;
      const action = target.dataset.action;
      const candId = target.dataset.candidateId || null;
      toggleMenu(false);

      if (action === 'local') {
        ui.input?.click();
      } else if (action === 'add-sync') {
        const videoUrl = getCurrentVideoUrl();
        const base = 'https://lrchub.coreone.work';
        const lrchubUrl = videoUrl
          ? `${base}/manual?video_url=${encodeURIComponent(videoUrl)}`
          : base;
        window.open(lrchubUrl, '_blank');
      } else if (action === 'fix') {
        const vid = getCurrentVideoId();
        if (!vid) {
          alert('動画IDが取得できませんでした。YouTube Music の再生画面で実行してください。');
          return;
        }
        const githubUrl = `https://github.com/LRCHub/${vid}/edit/main/README.md`;
        window.open(githubUrl, '_blank');
      } else if (action === 'candidate' && candId) {
        selectCandidateById(candId);
      }
    });

    if (!uploadMenuGlobalSetup) {
      uploadMenuGlobalSetup = true;
      document.addEventListener('click', (ev) => {
        if (!ui.uploadMenu) return;
        if (!ui.uploadMenu.classList.contains('visible')) return;
        if (ui.uploadMenu.contains(ev.target) || uploadBtn.contains(ev.target)) return;
        ui.uploadMenu.classList.remove('visible');
      }, true);
    }

    refreshCandidateMenu();
  }

  function setupDeleteDialog(trashBtn) {
    if (!ui.btnArea || ui.deleteDialog) return;
    ui.btnArea.style.position = 'relative';

    const dialog = createEl('div', 'ytm-delete-dialog', 'ytm-confirm-dialog', `
            <div class="ytm-confirm-title">歌詞を削除</div>
            <div class="ytm-confirm-message">
                この曲の保存済み歌詞を削除しますか？<br>
                <span style="font-size:11px;opacity:0.7;">ローカルキャッシュのみ削除されます。</span>
            </div>
            <div class="ytm-confirm-buttons">
                <button class="ytm-confirm-btn cancel">キャンセル</button>
                <button class="ytm-confirm-btn danger">削除</button>
            </div>
        `);
    ui.btnArea.appendChild(dialog);
    ui.deleteDialog = dialog;

    const toggleDialog = (show) => {
      if (!ui.deleteDialog) return;
      const cl = ui.deleteDialog.classList;
      if (show === undefined) cl.toggle('visible');
      else if (show) cl.add('visible');
      else cl.remove('visible');
    };

    trashBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleDialog();
    });

    const cancelBtn = dialog.querySelector('.ytm-confirm-btn.cancel');
    const dangerBtn = dialog.querySelector('.ytm-confirm-btn.danger');

    if (cancelBtn) {
      cancelBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        toggleDialog(false);
      });
    }

    if (dangerBtn) {
      dangerBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (currentKey) {
          storage.remove(currentKey);
          lyricsData = [];
          dynamicLines = null;
          lyricsCandidates = null;
          selectedCandidateId = null;
          renderLyrics([]);
          refreshCandidateMenu();
        }
        toggleDialog(false);
      });
    }

    if (!deleteDialogGlobalSetup) {
      deleteDialogGlobalSetup = true;
      document.addEventListener('click', (ev) => {
        if (!ui.deleteDialog) return;
        if (!ui.deleteDialog.classList.contains('visible')) return;
        if (ui.deleteDialog.contains(ev.target) || trashBtn.contains(ev.target)) return;
        ui.deleteDialog.classList.remove('visible');
      }, true);
    }
  }

  function setupLangPills(groupId, currentValue, onChange) {
    const group = document.getElementById(groupId);
    if (!group) return;
    const pills = Array.from(group.querySelectorAll('.ytm-lang-pill'));
    const apply = () => {
      pills.forEach(p => {
        p.classList.toggle('active', p.dataset.value === currentValue);
      });
    };
    apply();
    pills.forEach(p => {
      p.onclick = (e) => {
        e.stopPropagation();
        currentValue = p.dataset.value;
        apply();
        onChange(currentValue);
      };
    });
  }

  function initSettings() {
    if (ui.settings) return;
    ui.settings = createEl('div', 'ytm-settings-panel', '', `
            <button id="ytm-settings-close-btn"
                style="
                    position:absolute;
                    right:12px;
                    top:10px;
                    width:24px;
                    height:24px;
                    border-radius:999px;
                    border:none;
                    background:rgba(255,255,255,0.08);
                    color:#fff;
                    font-size:16px;
                    line-height:1;
                    cursor:pointer;
                ">×</button>
            <h3>Settings</h3>
            <div class="setting-item">
                <label class="toggle-label">
                    <span>Use Translation</span>
                    <input type="checkbox" id="trans-toggle">
                </label>
            </div>
            <div class="setting-item ytm-lang-section">
                <div class="ytm-lang-label">Main language（大きく表示）</div>
                <div class="ytm-lang-group" id="main-lang-group">
                    <button class="ytm-lang-pill" data-value="original">Original</button>
                    <button class="ytm-lang-pill" data-value="ja">日本語</button>
                    <button class="ytm-lang-pill" data-value="en">English</button>
                    <button class="ytm-lang-pill" data-value="ko">한국어</button>
                </div>
            </div>
            <div class="setting-item ytm-lang-section">
                <div class="ytm-lang-label">Sub language（小さく表示）</div>
                <div class="ytm-lang-group" id="sub-lang-group">
                    <button class="ytm-lang-pill" data-value="">なし</button>
                    <button class="ytm-lang-pill" data-value="ja">日本語</button>
                    <button class="ytm-lang-pill" data-value="en">English</button>
                    <button class="ytm-lang-pill" data-value="ko">한국어</button>
                </div>
            </div>
            <div class="setting-item" style="margin-top:15px;">
                <input type="password" id="deepl-key-input" placeholder="DeepL API Key">
            </div>
            <div style="display:flex; gap:10px; margin-top:20px;">
                <button id="save-settings-btn" style="flex:1;">Save</button>
                <button id="clear-all-btn" style="background:#ff3b30; color:white;">Reset</button>
            </div>
        `);
    document.body.appendChild(ui.settings);

    (async () => {
      if (!config.deepLKey) config.deepLKey = await storage.get('ytm_deepl_key');
      const cachedTrans = await storage.get('ytm_trans_enabled');
      if (cachedTrans !== null && cachedTrans !== undefined) config.useTrans = cachedTrans;
      const mainLangStored = await storage.get('ytm_main_lang');
      const subLangStored = await storage.get('ytm_sub_lang');
      if (mainLangStored) config.mainLang = mainLangStored;
      if (subLangStored !== null && subLangStored !== undefined) config.subLang = subLangStored;

      document.getElementById('deepl-key-input').value = config.deepLKey || '';
      document.getElementById('trans-toggle').checked = config.useTrans;

      setupLangPills('main-lang-group', config.mainLang, v => { config.mainLang = v; });
      setupLangPills('sub-lang-group', config.subLang, v => { config.subLang = v; });
    })();

    document.getElementById('save-settings-btn').onclick = () => {
      config.deepLKey = document.getElementById('deepl-key-input').value.trim();
      config.useTrans = document.getElementById('trans-toggle').checked;
      storage.set('ytm_deepl_key', config.deepLKey);
      storage.set('ytm_trans_enabled', config.useTrans);
      storage.set('ytm_main_lang', config.mainLang);
      storage.set('ytm_sub_lang', config.subLang);
      alert('Saved');
      ui.settings.classList.remove('active');
      currentKey = null;
    };
    document.getElementById('clear-all-btn').onclick = storage.clear;

    const closeBtn = document.getElementById('ytm-settings-close-btn');
    if (closeBtn) {
      closeBtn.onclick = (ev) => {
        ev.stopPropagation();
        ui.settings.classList.remove('active');
      };
    }

    if (!settingsOutsideClickSetup) {
      settingsOutsideClickSetup = true;
      document.addEventListener('click', (ev) => {
        if (!ui.settings) return;
        if (!ui.settings.classList.contains('active')) return;
        if (ui.settings.contains(ev.target)) return;
        if (ui.settingsBtn && ui.settingsBtn.contains(ev.target)) return;
        ui.settings.classList.remove('active');
      }, true);
    }
  }

  function initLayout() {
    if (document.getElementById('ytm-custom-wrapper')) {
      ui.wrapper = document.getElementById('ytm-custom-wrapper');
      ui.bg = document.getElementById('ytm-custom-bg');
      ui.lyrics = document.getElementById('my-lyrics-container');
      ui.title = document.getElementById('ytm-custom-title');
      ui.artist = document.getElementById('ytm-custom-artist');
      ui.artwork = document.getElementById('ytm-artwork-container');
      ui.btnArea = document.getElementById('ytm-btn-area');
      setupAutoHideEvents();
      return;
    }

    ui.bg = createEl('div', 'ytm-custom-bg');
    document.body.appendChild(ui.bg);

    ui.wrapper = createEl('div', 'ytm-custom-wrapper');
    const leftCol = createEl('div', 'ytm-custom-left-col');

    ui.artwork = createEl('div', 'ytm-artwork-container');
    const info = createEl('div', 'ytm-custom-info-area');
    ui.title = createEl('div', 'ytm-custom-title');
    ui.artist = createEl('div', 'ytm-custom-artist');

    ui.btnArea = createEl('div', 'ytm-btn-area');
    const btns = [];

    const lyricsBtnConfig = { txt: 'Lyrics', cls: 'lyrics-btn', click: () => { } };
    const trashBtnConfig = { txt: '🗑️', cls: 'icon-btn', click: () => { } };
    const settingsBtnConfig = {
      txt: '⚙️',
      cls: 'icon-btn',
      click: () => { initSettings(); ui.settings.classList.toggle('active'); }
    };

    btns.push(lyricsBtnConfig, trashBtnConfig, settingsBtnConfig);

    btns.forEach(b => {
      const btn = createEl('button', '', `ytm-glass-btn ${b.cls || ''}`, b.txt);
      btn.onclick = b.click;
      ui.btnArea.appendChild(btn);

      if (b === lyricsBtnConfig) {
        ui.lyricsBtn = btn;
        setupUploadMenu(btn);
      }
      if (b === trashBtnConfig) setupDeleteDialog(btn);
      if (b === settingsBtnConfig) ui.settingsBtn = btn;
    });

    ui.input = createEl('input');
    ui.input.type = 'file';
    ui.input.accept = '.lrc,.txt';
    ui.input.style.display = 'none';
    ui.input.onchange = handleUpload;
    document.body.appendChild(ui.input);

    info.append(ui.title, ui.artist, ui.btnArea);
    leftCol.append(ui.artwork, info);

    ui.lyrics = createEl('div', 'my-lyrics-container');
    ui.wrapper.append(leftCol, ui.lyrics);
    document.body.appendChild(ui.wrapper);

    setupAutoHideEvents();
  }

  async function loadLyrics(meta) {
    if (!config.deepLKey) config.deepLKey = await storage.get('ytm_deepl_key');
    const cachedTrans = await storage.get('ytm_trans_enabled');
    if (cachedTrans !== null && cachedTrans !== undefined) config.useTrans = cachedTrans;
    const mainLangStored = await storage.get('ytm_main_lang');
    const subLangStored = await storage.get('ytm_sub_lang');
    if (mainLangStored) config.mainLang = mainLangStored;
    if (subLangStored !== null && subLangStored !== undefined) config.subLang = subLangStored;

    const thisKey = `${meta.title}///${meta.artist}`;
    if (thisKey !== currentKey) return;

    let cached = await storage.get(thisKey);
    dynamicLines = null;
    lyricsCandidates = null;
    selectedCandidateId = null;
    let data = null;
    let noLyricsCached = false;

    if (cached !== null && cached !== undefined) {
      if (cached === NO_LYRICS_SENTINEL) {
        noLyricsCached = true;
      } else if (typeof cached === 'string') {
        data = cached;
      } else if (typeof cached === 'object') {
        if (typeof cached.lyrics === 'string') {
          data = cached.lyrics;
        }
        if (Array.isArray(cached.dynamicLines)) {
          dynamicLines = cached.dynamicLines;
        }
        if (cached.noLyrics) {
          noLyricsCached = true;
        }
      }
    }

    if (!data && noLyricsCached) {
      if (thisKey !== currentKey) return;
      renderLyrics([]);
      refreshCandidateMenu();
      return;
    }

    if (!data && !noLyricsCached) {
      let gotLyrics = false;

      try {
        const track = meta.title.replace(/\s*[\(-\[].*?[\)-]].*/, '');
        const artist = meta.artist;
        const youtube_url = getCurrentVideoUrl();
        const video_id = getCurrentVideoId();

        const res = await new Promise(resolve => {
          chrome.runtime.sendMessage(
            { type: 'GET_LYRICS', payload: { track, artist, youtube_url, video_id } },
            resolve
          );
        });

        console.log('[CS] GET_LYRICS response:', res);

        if (res && res.fallbackSource === 'github') {
          showFallbackToast('LRCHub が 30 秒以内に応答しなかったため、GitHub から歌詞を取得しました');
        }

        if (Array.isArray(res?.candidates) && res.candidates.length) {
          lyricsCandidates = res.candidates;
        } else {
          lyricsCandidates = null;
        }
        refreshCandidateMenu();

        if (res?.success && typeof res.lyrics === 'string' && res.lyrics.trim()) {
          data = res.lyrics;
          gotLyrics = true;

          if (Array.isArray(res.dynamicLines) && res.dynamicLines.length) {
            dynamicLines = res.dynamicLines;
          }

          if (Array.isArray(lyricsCandidates) && lyricsCandidates.length) {
            const trimmedBase = data.trim();
            const matched = lyricsCandidates.find((c, idx) =>
              typeof c.lyrics === 'string' && c.lyrics.trim() === trimmedBase
            );
            if (matched) {
              const idx = lyricsCandidates.indexOf(matched);
              selectedCandidateId = matched.id || String(idx);
            }
          }

          if (thisKey === currentKey) {
            if (dynamicLines) {
              storage.set(thisKey, {
                lyrics: data,
                dynamicLines,
                noLyrics: false
              });
            } else {
              storage.set(thisKey, data);
            }
          }
        } else {
          console.warn('Lyrics API returned no lyrics or success=false');
        }
      } catch (e) {
        console.warn('Lyrics API fetch failed', e);
      }

      if (!gotLyrics && thisKey === currentKey) {
        storage.set(thisKey, NO_LYRICS_SENTINEL);
        noLyricsCached = true;
      }
    }

    if (thisKey !== currentKey) return;

    if (!data) {
      renderLyrics([]);
      refreshCandidateMenu();
      return;
    }

    await applyLyricsText(data);
  }

  function renderLyrics(data) {
    if (!ui.lyrics) return;
    ui.lyrics.innerHTML = '';
    ui.lyrics.scrollTop = 0;

    const hasData = Array.isArray(data) && data.length > 0;
    document.body.classList.toggle('ytm-no-lyrics', !hasData);
    document.body.classList.toggle('ytm-has-timestamp', hasTimestamp);
    document.body.classList.toggle('ytm-no-timestamp', !hasTimestamp);

    data.forEach((line, index) => {
      const row = createEl('div', '', 'lyric-line');
      const mainSpan = createEl('span', '', 'lyric-main');

      const dyn = dynamicLines && dynamicLines[index];
      if (dyn && Array.isArray(dyn.chars) && dyn.chars.length) {
        dyn.chars.forEach((ch, ci) => {
          const chSpan = createEl('span', '', 'lyric-char');
          chSpan.textContent = ch.c;
          chSpan.dataset.charIndex = String(ci);
          if (typeof ch.t === 'number') {
            chSpan.dataset.time = String(ch.t / 1000);
          }
          chSpan.classList.add('char-pending');
          mainSpan.appendChild(chSpan);
        });
      } else {
        mainSpan.textContent = line.text;
      }

      row.appendChild(mainSpan);

      if (line.translation) {
        const subSpan = createEl('span', '', 'lyric-translation', line.translation);
        row.appendChild(subSpan);
        row.classList.add('has-translation');
      }

      row.onclick = () => {
        if (!hasTimestamp || line.time == null) return;
        const v = document.querySelector('video');
        if (v) v.currentTime = line.time;
      };
      ui.lyrics.appendChild(row);
    });
  }

  const handleUpload = (e) => {
    const file = e.target.files[0];
    if (!file || !currentKey) return;
    const r = new FileReader();
    r.onload = (ev) => {
      storage.set(currentKey, ev.target.result);
      currentKey = null;
    };
    r.readAsText(file);
    e.target.value = '';
  };

  function startLyricRafLoop() {
    if (lyricRafId !== null) return;

    const loop = () => {
      const v = document.querySelector('video');
      if (!v || v.readyState === 0) {
        lyricRafId = requestAnimationFrame(loop);
        return;
      }

      if (
        document.body.classList.contains('ytm-custom-layout') &&
        lyricsData.length &&
        hasTimestamp &&
        !v.paused &&
        !v.ended
      ) {
        const t = v.currentTime;
        if (t !== lastTimeForChars) {
          lastTimeForChars = t;
          updateLyricHighlight(t);
        }
      }

      lyricRafId = requestAnimationFrame(loop);
    };

    lyricRafId = requestAnimationFrame(loop);
  }

  function updateLyricHighlight(currentTime) {
    if (!document.body.classList.contains('ytm-custom-layout') || !lyricsData.length) return;
    if (!hasTimestamp) return;

    const t = currentTime;
    let idx = lyricsData.findIndex(l => l.time > t) - 1;
    if (idx < 0) idx = lyricsData[lyricsData.length - 1].time <= t ? lyricsData.length - 1 : -1;

    const current = lyricsData[idx];
    const next = lyricsData[idx + 1];
    const isInterlude = current && next && (next.time - current.time > 10) && (t - current.time > 6);

    const rows = document.querySelectorAll('.lyric-line');

    rows.forEach((r, i) => {
      if (i === idx && !isInterlude) {
        const firstActivate = (i !== lastActiveIndex);

        if (!r.classList.contains('active')) {
          r.classList.add('active');
        }
        if (r.classList.contains('has-translation')) {
          r.classList.add('show-translation');
        }

        if (firstActivate) {
          r.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        if (dynamicLines && dynamicLines[i] && Array.isArray(dynamicLines[i].chars)) {
          const charSpans = r.querySelectorAll('.lyric-char');
          charSpans.forEach(sp => {
            const tt = parseFloat(sp.dataset.time || '0');
            if (!Number.isFinite(tt)) return;

            if (tt <= t) {
              if (!sp.classList.contains('char-active')) {
                sp.classList.add('char-active');
                sp.classList.remove('char-pending');
              }
            } else {
              if (!sp.classList.contains('char-pending')) {
                sp.classList.remove('char-active');
                sp.classList.add('char-pending');
              }
            }
          });
        }
      } else {
        r.classList.remove('active');
        r.classList.remove('show-translation');

        if (dynamicLines && dynamicLines[i]) {
          const charSpans = r.querySelectorAll('.lyric-char');
          charSpans.forEach(sp => {
            if (!sp.classList.contains('char-pending')) {
              sp.classList.remove('char-active');
              sp.classList.add('char-pending');
            }
          });
        }
      }
    });

    lastActiveIndex = isInterlude ? -1 : idx;
  }

  const tick = async () => {
    if (!document.getElementById('my-mode-toggle')) {
      const rc = document.querySelector('.right-controls-buttons');
      if (rc) {
        const btn = createEl('button', 'my-mode-toggle', '', 'IMMERSION');
        btn.onclick = () => {
          config.mode = !config.mode;
          document.body.classList.toggle('ytm-custom-layout', config.mode);
        };
        rc.prepend(btn);
      }
    }

    const layout = document.querySelector('ytmusic-app-layout');
    const isPlayerOpen = layout?.hasAttribute('player-page-open');

    if (!config.mode || !isPlayerOpen) {
      document.body.classList.remove('ytm-custom-layout');
      return;
    }

    document.body.classList.add('ytm-custom-layout');
    initLayout();

    (function patchSliders() {
      const sliders = document.querySelectorAll('ytmusic-player-bar .middle-controls tp-yt-paper-slider');
      sliders.forEach(s => {
        try {
          s.style.boxSizing = 'border-box';
          s.style.paddingLeft = '20px';
          s.style.paddingRight = '20px';
          s.style.minWidth = '0';
        } catch (e) {
        }
      });
    })();

    const meta = getMetadata();
    if (!meta) return;

    const key = `${meta.title}///${meta.artist}`;
    if (currentKey !== key) {
      currentKey = key;
      lyricsData = [];
      dynamicLines = null;
      lyricsCandidates = null;
      selectedCandidateId = null;
      updateMetaUI(meta);
      refreshCandidateMenu();
      if (ui.lyrics) ui.lyrics.scrollTop = 0;
      loadLyrics(meta);
    }
  };

  function updateMetaUI(meta) {
    ui.title.innerText = meta.title;
    ui.artist.innerText = meta.artist;
    if (meta.src) {
      ui.artwork.innerHTML = `<img src="${meta.src}" crossorigin="anonymous">`;
      ui.bg.style.backgroundImage = `url(${meta.src})`;
    }
    ui.lyrics.innerHTML = '<div class="lyric-loading" style="opacity:0.5; padding:20px;">Loading...</div>';
  }

  console.log('YTM Immersion loaded.');
  setInterval(tick, 1000);
  startLyricRafLoop();
})();
