chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.type === 'TRANSLATE') {
    const { text, apiKey, targetLang } = req.payload;
    const endpoint = apiKey.endsWith(':fx')
      ? 'https://api-free.deepl.com/v2/translate'
      : 'https://api.deepl.com/v2/translate';

    const body = {
      text,
      target_lang: targetLang || 'JA'
    };

    fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })
      .then(r => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then(data => sendResponse({ success: true, translations: data.translations }))
      .catch(err => {
        console.error('DeepL API Error:', err);
        sendResponse({ success: false, error: err.toString() });
      });

    return true;
  }

  const normalizeArtist = (s) =>
    (s || '').toLowerCase().replace(/\s+/g, '').trim();

  const pickBestLrcLibHit = (items, artist) => {
    if (!Array.isArray(items) || !items.length) return null;
    const target = normalizeArtist(artist);
    const getArtistName = (it) =>
      it.artistName || it.artist || it.artist_name || '';

    let hit = null;

    if (target) {
      hit = items.find(it => {
        const a = normalizeArtist(getArtistName(it));
        return a && a === target && (it.syncedLyrics || it.synced_lyrics);
      });
      if (hit) return hit;

      hit = items.find(it => {
        const a = normalizeArtist(getArtistName(it));
        return a && a === target && (it.plainLyrics || it.plain_lyrics);
      });
      if (hit) return hit;

      hit = items.find(it => {
        const a = normalizeArtist(getArtistName(it));
        return a && (a.includes(target) || target.includes(a)) && (it.syncedLyrics || it.synced_lyrics);
      });
      if (hit) return hit;

      hit = items.find(it => {
        const a = normalizeArtist(getArtistName(it));
        return a && (a.includes(target) || target.includes(a)) && (it.plainLyrics || it.plain_lyrics);
      });
      if (hit) return hit;
    }

    hit = items.find(it => it.syncedLyrics || it.synced_lyrics);
    if (hit) return hit;

    hit = items.find(it => it.plainLyrics || it.plain_lyrics);
    if (hit) return hit;

    return items[0];
  };

  const fetchFromLrcLib = (track, artist) => {
    if (!track) return Promise.resolve('');
    const url = `https://lrclib.net/api/search?track_name=${encodeURIComponent(track)}`;
    console.log('[BG] LrcLib search URL:', url);

    return fetch(url)
      .then(r => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then(list => {
        console.log(
          '[BG] LrcLib search result count:',
          Array.isArray(list) ? list.length : 'N/A'
        );
        const items = Array.isArray(list) ? list : [];
        const hit = pickBestLrcLibHit(items, artist);
        if (!hit) return '';

        const synced =
          hit.syncedLyrics ||
          hit.synced_lyrics ||
          '';
        const plain =
          hit.plainLyrics ||
          hit.plain_lyrics ||
          hit.plain_lyrics_text ||
          '';

        const lyrics = (synced || plain || '').trim();
        console.log('[BG] LrcLib chosen track:', {
          trackName: hit.trackName || hit.track || '',
          artistName: hit.artistName || hit.artist || ''
        });
        return lyrics;
      })
      .catch(err => {
        console.error('[BG] LrcLib error:', err);
        return '';
      });
  };

  const formatLrcTime = (seconds) => {
    const total = Math.max(0, seconds);
    const min = Math.floor(total / 60);
    const sec = Math.floor(total - min * 60);
    const cs = Math.floor((total - min * 60 - sec) * 100);
    const mm = String(min).padStart(2, '0');
    const ss = String(sec).padStart(2, '0');
    const cc = String(cs).padStart(2, '0');
    return `${mm}:${ss}.${cc}`;
  };

  // ★ ここで config / requests も拾う
  const fetchCandidatesFromUrl = (url) => {
    if (!url) {
      return Promise.resolve({
        candidates: [],
        hasSelectCandidates: false,
        config: null,
        requests: []
      });
    }

    try {
      const base = 'https://lrchub.coreone.work';
      const u = new URL(url, base);
      u.protocol = 'https:';
      if (!u.searchParams.has('include_lyrics')) {
        u.searchParams.set('include_lyrics', '1');
      }
      url = u.toString();
    } catch (e) {
      console.warn('[BG] invalid candidates url:', url, e);
    }

    console.log('[BG] fetchCandidatesFromUrl:', url);

    return fetch(url)
      .then(async (r) => {
        // ★ ステータスに関わらず JSON を読みに行く
        let json;
        try {
          json = await r.json();
        } catch (e) {
          throw new Error(r.statusText || 'Invalid JSON');
        }

        const res = json.response || json;

        const list = Array.isArray(res.candidates) ? res.candidates : [];
        const config = res.config || null;
        const requests = Array.isArray(res.requests) ? res.requests : [];

        console.log(
          '[BG] candidates result:',
          'status=', r.status,
          'code=', res.code,
          'candidates=', list.length,
          'requests=', requests.length
        );

        // SELECT_NOT_FOUND のときは candidates も requests も空、config だけ生きている想定
        const hasSelectCandidates = list.length > 1;

        return {
          candidates: list,
          hasSelectCandidates,
          config,
          requests
        };
      })
      .catch(err => {
        console.error('[BG] candidates error:', err);
        return { candidates: [], hasSelectCandidates: false, config: null, requests: [] };
      });
  };

  const buildCandidatesUrl = (res, payloadVideoId) => {
    const base = 'https://lrchub.coreone.work';
    const raw = res.candidates_api_url || '';

    try {
      if (raw) {
        const u = new URL(raw, base);
        u.protocol = 'https:';
        if (!u.searchParams.has('include_lyrics')) {
          u.searchParams.set('include_lyrics', '1');
        }
        return u.toString();
      }
    } catch (e) {
      console.warn('[BG] buildCandidatesUrl from api url failed:', e);
    }

    const vid = res.video_id || payloadVideoId;
    if (!vid) return null;
    const u = new URL('/api/lyrics_candidates', base);
    u.searchParams.set('video_id', vid);
    u.searchParams.set('include_lyrics', '1');
    return u.toString();
  };

  // ★ 修正版 fetchFromLrchub
  const fetchFromLrchub = (track, artist, youtube_url, video_id) => {
    return fetch('https://lrchub.coreone.work/api/lyrics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ track, artist, youtube_url, video_id })
    })
      .then(r => r.text())
      .then(text => {
        let lyrics = '';
        let dynamicLines = null;
        let hasSelectCandidates = false;
        let candidates = [];
        let config = null;
        let requests = [];

        try {
          const json = JSON.parse(text);
          console.log('[BG] Lyrics API JSON:', json);
          const res = json.response || json;

          hasSelectCandidates = !!res.has_select_candidates;
          config = res.config || null;
          requests = Array.isArray(res.requests) ? res.requests : [];

          if (
            res.dynamic_lyrics &&
            Array.isArray(res.dynamic_lyrics.lines) &&
            res.dynamic_lyrics.lines.length
          ) {
            dynamicLines = res.dynamic_lyrics.lines;

            const lrcLines = dynamicLines
              .map(line => {
                let ms = null;
                if (typeof line.startTimeMs === 'number') {
                  ms = line.startTimeMs;
                } else if (typeof line.startTimeMs === 'string') {
                  const n = Number(line.startTimeMs);
                  if (!Number.isNaN(n)) ms = n;
                }
                if (ms == null) return null;

                let text = '';
                if (typeof line.text === 'string' && line.text.length) {
                  text = line.text;
                } else if (Array.isArray(line.chars)) {
                  text = line.chars
                    .map(c => c.c || c.text || c.caption || '')
                    .join('');
                }

                text = (text || '').trim();
                const timeTag = `[${formatLrcTime(ms / 1000)}]`;
                return text ? `${timeTag} ${text}` : timeTag;
              })
              .filter(Boolean);

            lyrics = lrcLines.join('\n');
          } else {
            const synced =
              typeof res.synced_lyrics === 'string'
                ? res.synced_lyrics.trim()
                : '';
            const plain =
              typeof res.plain_lyrics === 'string'
                ? res.plain_lyrics.trim()
                : '';
            if (synced) lyrics = synced;
            else if (plain) lyrics = plain;
          }

          const url = buildCandidatesUrl(res, video_id);
          if (url) {
            return fetchCandidatesFromUrl(url).then(cRes => {
              // candidate 一覧
              candidates = cRes.candidates;

              // どちらかが true なら candidates UI を出す
              hasSelectCandidates = !!(
                hasSelectCandidates || cRes.hasSelectCandidates
              );

              // config は candidates API 側があれば優先
              if (cRes.config) {
                config = cRes.config;
              }

              // ★重要★ requests は candidates API から「非空で来たときだけ」上書き
              // SELECT_NOT_FOUND などで [] のときは lyrics API 側の requests をそのまま使う
              if (Array.isArray(cRes.requests) && cRes.requests.length) {
                requests = cRes.requests;
              }

              return {
                lyrics,
                dynamicLines,
                hasSelectCandidates,
                candidates,
                config,
                requests
              };
            });
          }
        } catch (e) {
          console.warn('[BG] Lyrics API response parse failed', e);
        }

        // candidates API を叩かなかった / 失敗した場合はこちら
        return { lyrics, dynamicLines, hasSelectCandidates, candidates, config, requests };
      });
  };

  const fetchFromGithub = (video_id) => {
    if (!video_id) return Promise.resolve('');
    const url = `https://raw.githubusercontent.com/LRCHub/${video_id}/main/README.md`;
    console.log('[BG] GitHub fallback URL:', url);
    return fetch(url)
      .then(r => (r.ok ? r.text() : ''))
      .then(text => (text || '').trim())
      .catch(err => {
        console.error('[BG] GitHub fallback error:', err);
        return '';
      });
  };

  const extractVideoIdFromUrl = (youtube_url) => {
    if (!youtube_url) return null;
    try {
      const u = new URL(youtube_url);
      if (u.hostname === 'youtu.be') {
        const id = u.pathname.replace('/', '');
        return id || null;
      }
      const v = u.searchParams.get('v');
      return v || null;
    } catch (e) {
      return null;
    }
  };

  const withTimeout = (promise, ms, label) => {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(label || 'timeout')), ms);
      })
    ]);
  };

  if (req.type === 'GET_LYRICS') {
    const { track, artist, youtube_url, video_id } = req.payload || {};

    console.log('[BG] GET_LYRICS', { track, artist, youtube_url, video_id });

    (async () => {
      const timeoutMs = 90000; //フォールバックに移動するタイムアウトのやつ
      let githubFallback = false;

      try {
        let lrchubRes = null;
        try {
          lrchubRes = await withTimeout(
            fetchFromLrchub(track, artist, youtube_url, video_id),
            timeoutMs,
            'lrchub_timeout'
          );
        } catch (e) {
          console.error('[BG] LRCHub error or timeout:', e);
        }

        if (lrchubRes && lrchubRes.lyrics && lrchubRes.lyrics.trim()) {
          console.log(
            '[BG] Using LRCHub lyrics (dynamic_lyrics:',
            !!lrchubRes.dynamicLines,
            'candidates:',
            (lrchubRes.candidates || []).length,
            ')'
          );
          sendResponse({
            success: true,
            lyrics: lrchubRes.lyrics,
            dynamicLines: lrchubRes.dynamicLines || null,
            hasSelectCandidates: lrchubRes.hasSelectCandidates || false,
            candidates: lrchubRes.candidates || [],
            config: lrchubRes.config || null,
            requests: lrchubRes.requests || [],
            githubFallback: false
          });
          return;
        }

        let lrclibLyrics = '';
        try {
          lrclibLyrics = await withTimeout(
            fetchFromLrcLib(track, artist),
            timeoutMs,
            'lrclib_timeout'
          );
        } catch (e) {
          console.error('[BG] LrcLib error or timeout:', e);
        }

        if (lrclibLyrics && lrclibLyrics.trim()) {
          console.log('[BG] Using LrcLib lyrics fallback');
          sendResponse({
            success: true,
            lyrics: lrclibLyrics,
            dynamicLines: null,
            hasSelectCandidates: false,
            candidates: [],
            config: null,
            requests: [],
            githubFallback: false
          });
          return;
        }

        const vidForGit = video_id || extractVideoIdFromUrl(youtube_url);
        let gitLyrics = '';
        if (vidForGit) {
          gitLyrics = await fetchFromGithub(vidForGit);
        }

        if (gitLyrics && gitLyrics.trim()) {
          githubFallback = true;
          console.log('[BG] Using GitHub fallback lyrics');
          sendResponse({
            success: true,
            lyrics: gitLyrics,
            dynamicLines: null,
            hasSelectCandidates: false,
            candidates: [],
            config: null,
            requests: [],
            githubFallback
          });
          return;
        }

        console.log('[BG] No lyrics from any source');
        sendResponse({
          success: false,
          lyrics: '',
          dynamicLines: null,
          hasSelectCandidates: false,
          candidates: [],
          config: null,
          requests: [],
          githubFallback: false
        });
      } catch (err) {
        console.error('Lyrics API Error:', err);
        sendResponse({ success: false, error: err.toString(), githubFallback: false });
      }
    })();

    return true;
  }

  if (req.type === 'SELECT_LYRICS_CANDIDATE') {
    const {
      youtube_url,
      video_id,
      candidate_id,
      request,
      action,
      lock
    } = req.payload || {};

    const body = {};
    if (youtube_url) body.youtube_url = youtube_url;
    else if (video_id) body.video_id = video_id;
    if (candidate_id) body.candidate_id = candidate_id;
    const reqKey = request || action;
    if (reqKey) body.request = reqKey;
    if (typeof lock !== 'undefined') {
      body.lock = String(lock);
    }

    if (!body.youtube_url && !body.video_id) {
      sendResponse({ success: false, error: 'missing video_id or youtube_url' });
      return;
    }
    if (!body.candidate_id && !body.request) {
      sendResponse({ success: false, error: 'missing candidate_id or request' });
      return;
    }

    console.log('[BG] SELECT_LYRICS_CANDIDATE', body);

    fetch('https://lrchub.coreone.work/api/lyrics_select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(r => r.text())
      .then(text => {
        try {
          const json = JSON.parse(text);
          console.log('[BG] lyrics_select JSON:', json);
          sendResponse({ success: !!json.ok, raw: json });
        } catch (e) {
          console.warn('[BG] lyrics_select non-JSON response');
          sendResponse({ success: false, error: 'Invalid JSON', raw: text });
        }
      })
      .catch(err => {
        console.error('SELECT_LYRICS_CANDIDATE Error:', err);
        sendResponse({ success: false, error: err.toString() });
      });

    return true;
  }

  if (req.type === 'GET_TRANSLATION') {
    const { youtube_url, video_id, lang, langs } = req.payload;

    try {
      const url = new URL('https://lrchub.coreone.work/api/translation');
      if (youtube_url) {
        url.searchParams.set('youtube_url', youtube_url);
      } else if (video_id) {
        url.searchParams.set('video_id', video_id);
      }

      const reqLangs = Array.isArray(langs) && langs.length
        ? langs
        : (lang ? [lang] : []);

      reqLangs.forEach(l => url.searchParams.append('lang', l));

      console.log('[BG] GET_TRANSLATION', url.toString());

      fetch(url.toString(), { method: 'GET' })
        .then(r => r.text())
        .then(text => {
          let lrcMap = {};
          let missing = [];
          try {
            const json = JSON.parse(text);
            console.log('[BG] Translation API JSON:', json);
            const translations = json.translations || {};
            lrcMap = {};
            reqLangs.forEach(l => {
              lrcMap[l] = translations[l] || '';
            });
            missing = json.missing_langs || [];
          } catch (e) {
            console.warn('[BG] Translation API response is not JSON');
            lrcMap = {};
          }
          Object.keys(lrcMap || {}).forEach(k => {
            console.log(
              `[BG] Translation[${k}] preview:`,
              (lrcMap[k] || '').slice(0, 100)
            );
          });
          sendResponse({ success: true, lrcMap, missing });
        })
        .catch(err => {
          console.error('Translation API Error:', err);
          sendResponse({ success: false, error: err.toString() });
        });
    } catch (e) {
      console.error('GET_TRANSLATION build URL error:', e);
      sendResponse({ success: false, error: e.toString() });
    }

    return true;
  }

  if (req.type === 'REGISTER_TRANSLATION') {
    const { youtube_url, video_id, lang, lyrics } = req.payload;

    console.log('[BG] REGISTER_TRANSLATION', { youtube_url, video_id, lang });

    const body = { lang, lyrics };
    if (youtube_url) body.youtube_url = youtube_url;
    else if (video_id) body.video_id = video_id;

    fetch('https://lrchub.coreone.work/api/translation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(r => r.text())
      .then(text => {
        try {
          const json = JSON.parse(text);
          console.log('[BG] REGISTER_TRANSLATION JSON:', json);
          sendResponse({ success: !!json.ok, raw: json });
        } catch (e) {
          console.warn('REGISTER_TRANSLATION non-JSON response');
          sendResponse({ success: false, error: 'Invalid JSON', raw: text });
        }
      })
      .catch(err => {
        console.error('REGISTER_TRANSLATION Error:', err);
        sendResponse({ success: false, error: err.toString() });
      });

    return true;
  }

  if (req.type === 'SHARE_REGISTER') {
    const { youtube_url, video_id, phrase, text, lang, time_ms, time_sec } = req.payload || {};
    console.log('[BG] SHARE_REGISTER', { youtube_url, video_id, lang, time_ms, time_sec });

    const body = {};
    if (youtube_url) body.youtube_url = youtube_url;
    else if (video_id) body.video_id = video_id;
    if (phrase || text) body.phrase = phrase || text;
    if (lang) body.lang = lang;

    if (typeof time_ms === 'number') body.time_ms = time_ms;
    else if (typeof time_sec === 'number') body.time_sec = time_sec;

    if (!body.youtube_url && !body.video_id) {
      sendResponse({ success: false, error: 'missing video_id or youtube_url' });
      return;
    }
    if (!body.phrase) {
      sendResponse({ success: false, error: 'missing phrase' });
      return;
    }

    fetch('https://lrchub.coreone.work/api/share/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(r => r.text())
      .then(text => {
        try {
          const json = JSON.parse(text);
          console.log('[BG] SHARE_REGISTER JSON:', json);
          sendResponse({ success: !!json.ok, data: json });
        } catch (e) {
          console.warn('[BG] SHARE_REGISTER non-JSON response');
          sendResponse({ success: false, error: 'Invalid JSON', raw: text });
        }
      })
      .catch(err => {
        console.error('SHARE_REGISTER Error:', err);
        sendResponse({ success: false, error: err.toString() });
      });

    return true;
  }
});
