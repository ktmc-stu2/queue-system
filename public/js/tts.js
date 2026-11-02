/* 音檔優先 → 檔案缺失時改用 Google TTS → Chrome 語音後備
   Audio files first → Google TTS when missing → Chrome speech fallback */
const AUDIO_EXT = '.mp3';
let currentAudio = null, currentResolve = null, announceToken = 0;
const wait = ms => new Promise(r => setTimeout(r, ms));

const TTS_LANG = { en:'en-US', yue:'zh-HK', zh:'zh-CN' };
const G_LANG = { 'en-US':'en', 'zh-HK':'zh-HK', 'zh-CN':'zh-CN' };
const TTS_DIG = {
  en:['zero','one','two','three','four','five','six','seven','eight','nine'],
  yue:['零','一','二','三','四','五','六','七','八','九'],
  zh:['零','一','二','三','四','五','六','七','八','九']
};
const TTS_WORDS = {
  en:{ Ticket:'Ticket', counter:'please go to counter' },
  yue:{ ticket:'籌號', goto:'請往', suffix:'號櫃位' },
  zh:{ ticket:'筹号', goto:'请到', suffix:'号柜台' }
};

function ttsInfoFor(path){
  const i = path.indexOf('/');
  if (i < 0) return null;
  const lang = path.slice(0, i), key = path.slice(i + 1);
  if (/^[0-9]$/.test(key)) return { text: TTS_DIG[lang][+key], lang: TTS_LANG[lang] };
  if (/^[A-Z]$/.test(key)) return { text: key, lang: 'en-US' };
  const w = TTS_WORDS[lang] && TTS_WORDS[lang][key];
  return w ? { text: w, lang: TTS_LANG[lang] } : null;
}

/* ===== Google Translate TTS（直接串流音檔，無需 CORS）
   Google Translate TTS (direct audio streaming, no CORS required) ===== */
function googleSpeak(text, langCode) {
  return new Promise(res => {
    const my = announceToken;
    if (announceToken !== my) return res(false);
    const tl = G_LANG[langCode] || 'en';
    const clients = ['gtx', 'tw-ob'];
    let i = 0;
    const attempt = () => {
      if (announceToken !== my) return res(false);
      if (i >= clients.length) return res(false);
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=${clients[i++]}&tl=${tl}&q=${encodeURIComponent(text)}`;
      const a = new Audio(url);
      currentAudio = a;
      currentResolve = () => res(true);
      a.onended = () => { currentAudio = null; currentResolve = null; console.log('[TTS] Google:', tl, text); res(true); };
      a.onerror = () => { currentAudio = null; currentResolve = null; attempt(); };
      a.play().catch(() => attempt());
    };
    attempt();
  });
}

/* ===== Chrome 語音後備 Chrome speech fallback ===== */
const VOICE_PREF = ['Google','HiuGaai','Xiaoxiao','Aria','Online (Natural)','Neural','Natural'];
function browserSpeak(text, langCode) {
  return new Promise(res => {
    const my = announceToken;
    if (announceToken !== my) return res();
    if (!('speechSynthesis' in window)) return res();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = langCode; u.rate = 0.95; u.volume = 1;
    const vs = speechSynthesis.getVoices();
    const lang2 = langCode.slice(0,2).toLowerCase();
    let v = null;
    for (const p of VOICE_PREF){ if (!v) v = vs.find(x => x.name.includes(p) && x.lang.toLowerCase().startsWith(lang2)); }
    for (const p of VOICE_PREF){ if (!v) v = vs.find(x => x.name.includes(p)); }
    if (!v) v = vs.find(x => x.lang.toLowerCase().replace('-','_') === langCode.toLowerCase().replace('-','_'));
    if (!v) v = vs.find(x => x.lang.toLowerCase().startsWith(lang2));
    if (v) u.voice = v;
    console.warn('[TTS] Chrome 後備 fallback：', (v && v.name) || 'default', text);
    u.onend = () => res(); u.onerror = () => res();
    speechSynthesis.speak(u);
  });
}

async function speakText(text, langCode){
  const my = announceToken;
  if (!text || !text.trim()) return;
  const ok = await googleSpeak(text, langCode);
  if (!ok && announceToken === my) await browserSpeak(text, langCode);
}

/* ===== 播放片段：有音檔則播放音檔；檔案缺失時改用 TTS
   Play clip: play the audio file if present; fall back to TTS when missing ===== */
function playClip(path){
  const my = announceToken;
  return new Promise(res => {
    const tries = ['audio/' + path + AUDIO_EXT, '../audio/' + path + AUDIO_EXT];
    let i = 0;
    const attempt = () => {
      if (announceToken !== my) return res();
      if (i < tries.length){
        const a = new Audio(tries[i++]);
        currentAudio = a; currentResolve = res;
        a.onended = () => { currentAudio=null; currentResolve=null; res(); };
        a.onerror = () => { currentAudio=null; currentResolve=null; attempt(); };
        a.play().catch(() => attempt());
      } else {
        const info = ttsInfoFor(path);
        if (!info) return res();
        speakText(info.text, info.lang).then(res);
      }
    };
    attempt();
  });
}
function stopAudio(){
  announceToken++;
  if (currentAudio) currentAudio.pause();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  const r = currentResolve; currentAudio=null; currentResolve=null;
  if (r) r();
}
function chime(){ return playClip('chime'); }

function counterNum(counter){
  let raw = '1';
  if (counter && counter.name){ const n = String(counter.name).replace(/\D/g,''); if (n) raw = n; }
  return raw;
}

/* ===== 預設廣播序列 Default announcement sequence ===== */
function buildPhrase(lang, numLabel, counter){
  const letters = numLabel.replace(/[0-9]/g,'').split('');
  const digits  = numLabel.replace(/[A-Z]/g,'').split('');
  const cid = counterNum(counter).split('');
  if (lang === 'en'){
    return ['en/Ticket', ...letters.map(l=>'en/'+l), ...digits.map(d=>'en/'+d),
            'en/counter', ...cid.map(d=>'en/'+d)];
  }
  if (lang === 'yue'){
    return ['yue/ticket', ...letters.map(l=>'yue/'+l), ...digits.map(d=>'yue/'+d),
            'yue/goto', ...cid.map(d=>'yue/'+d), 'yue/suffix'];
  }
  return ['zh/ticket', ...letters.map(l=>'zh/'+l), ...digits.map(d=>'zh/'+d),
          'zh/goto', ...cid.map(d=>'zh/'+d), 'zh/suffix'];
}

/* ===== 播放隊列 Playback queue ===== */
async function announce(languages, opts, cancel){
  if (cancel) stopAudio();
  const my = announceToken;
  const reps = (opts && opts.repeat) ? opts.repeat : 1;
  for (const lang of languages){
    const seq = opts.phrases && opts.phrases[lang];
    if (!seq) continue;
    for (let i=0; i<reps; i++){
      if (announceToken !== my) return;
      await chime();
      if (announceToken !== my) return;
      await wait(300);
      for (const p of seq){
        if (announceToken !== my) return;
        await playClip(p);
        await wait(150);
      }
      await wait(400);
    }
  }
}
