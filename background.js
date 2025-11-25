chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    // DeepL 翻訳
    if (req.type === 'TRANSLATE') {
        const { text, apiKey } = req.payload;
        const endpoint = apiKey.endsWith(':fx') 
            ? 'https://api-free.deepl.com/v2/translate' 
            : 'https://api.deepl.com/v2/translate';

        fetch(endpoint, {
            method: 'POST',
            headers: {
                'Authorization': `DeepL-Auth-Key ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ text, target_lang: 'JA' })
        })
        .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
        .then(data => sendResponse({ success: true, translations: data.translations }))
        .catch(err => {
            console.error("DeepL API Error:", err);
            sendResponse({ success: false, error: err.toString() });
        });

        return true; // 非同期レスポンス
    }

    // 歌詞API (LRCHub)
    if (req.type === 'GET_LYRICS') {
        const { track, artist } = req.payload;

        console.log('[BG] GET_LYRICS', track, artist);

        fetch('https://lrchub.coreone.work/api/lyrics', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ track, artist })
        })
        .then(r => r.text())   // いったん text で受ける
        .then(text => {
            let lyrics = '';
            try {
                const json = JSON.parse(text);
                console.log('[BG] Lyrics API JSON:', json);

                // ユーザーが貼ってくれた形式:
                // { response: { synced_lyrics: "...", plain_lyrics: "" ... }, status: 200, ... }
                const res = json.response || json;

                const synced  = typeof res.synced_lyrics === 'string' ? res.synced_lyrics.trim() : '';
                const plain   = typeof res.plain_lyrics  === 'string' ? res.plain_lyrics.trim()  : '';

                if (synced) {
                    // 時間付き歌詞
                    lyrics = synced;
                } else if (plain) {
                    // タイムタグなし歌詞
                    lyrics = plain;
                } else {
                    // どちらも無ければ生テキストを使う（保険）
                    lyrics = text.trim();
                }
            } catch (e) {
                console.warn('[BG] Lyrics API response is not JSON, using raw text');
                lyrics = text.trim();
            }

            console.log('[BG] Extracted lyrics preview:', lyrics.slice(0, 100));
            sendResponse({ success: !!lyrics, lyrics });
        })
        .catch(err => {
            console.error("Lyrics API Error:", err);
            sendResponse({ success: false, error: err.toString() });
        });

        return true; // 非同期レスポンス
    }

    // それ以外の type のときは何もしない
});
