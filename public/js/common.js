firebase.initializeApp(firebaseConfig);
const db = firebase.database();
const stateRef = db.ref('queue');

const DEFAULTS = {
  settings: {
    title: 'Queue Up', subtitle: '請排队取號',
    note: 'Please keep your ticket and watch for the display announcement. 請保留籌號並留意大屏幕廣播。',
    counters: [
      { id: 1, name: 'Counter 1', nameZh: '一號櫃位' },
      { id: 2, name: 'Counter 2', nameZh: '二號櫃位' }
    ],
    tts: { languages: ['en','yue','zh'], rate: 1, volume: 1, repeat: 1 }
  },
  session: { prefix: 'A', next: 1 }, tickets: {}, lastCall: null
};

let STATE = null; const listeners = [];
stateRef.on('value', s => { STATE = s.val() || JSON.parse(JSON.stringify(DEFAULTS)); listeners.forEach(f => f(STATE)); });
stateRef.once('value').then(s => { if (!s.exists()) stateRef.set(DEFAULTS); });

function onState(f){ listeners.push(f); if (STATE) f(STATE); }
function nowLabel(){
  const d=new Date(), p=n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function ticketsArr(){ return Object.entries(STATE.tickets||{}).map(([key,t])=>({key,...t})); }
function waiting(){ return ticketsArr().filter(t=>t.status==='waiting').sort((a,b)=>a.no-b.no); }
function currentOf(id){
  return ticketsArr()
    .filter(t=>t.status==='called' && String(t.counter)===String(id))
    .sort((a,b)=>(b.calledAt||0)-(a.calledAt||0))[0];
}
function counterById(id){ return (STATE.settings.counters||[]).find(c=>String(c.id)===String(id))||{id:id,name:'Counter '+id,nameZh:'櫃位 '+id}; }
function toast(m,ms=2500){ const t=document.getElementById('toast'); if(!t)return; t.textContent=m; t.classList.add('show'); clearTimeout(t._h); t._h=setTimeout(()=>t.classList.remove('show'),ms); }

/* 原子遞增序号：保證並發操作時 seq 唯一 */
async function nextSeq(path){
  let v;
  await stateRef.child(path).transaction(c => { v = (c||0)+1; return v; });
  return v;
}

/* 取號 */
async function takeTicket(){
  let no; const pre = STATE.session.prefix;
  await stateRef.child('session/next').transaction(c => { no = c||1; return no+1; });
  const t = { no, label: pre+String(no).padStart(3,'0'), time: nowLabel(), status:'waiting', counter:null };
  await stateRef.child('tickets').push(t);
  await stateRef.child('lastCall').set(null);
  return t;
}

/* ================= 修改重點：叫下一位（自動完成當前號碼） ================= */
async function callNext(id){
  const updates = {};
  
  // 1. 自動完成當前正在服務的號碼 (例如 A008 -> done)
  const cur = currentOf(id);
  if (cur) {
    updates['tickets/' + cur.key + '/status'] = 'done';
  }

  // 2. 檢查有沒有人排隊
  const w = waiting()[0]; 
  if (!w) {
    // 如果沒有人排隊，但剛才完成了當前號碼，依然更新資料庫
    if (Object.keys(updates).length > 0) {
      await stateRef.update(updates);
    }
    return null;
  }

  // 3. 呼叫下一位
  const seq = await nextSeq('callSeq');
  updates['tickets/' + w.key + '/status'] = 'called';
  updates['tickets/' + w.key + '/counter'] = Number(id);
  updates['tickets/' + w.key + '/calledAt'] = Date.now();
  updates['lastCall'] = { ticket:{label:w.label,no:w.no}, counter:Number(id), at:Date.now(), seq };

  await stateRef.update(updates);
  return w;
}
/* ======================================================================= */

/* 重新呼叫 */
async function recall(id){
  const t = currentOf(id); if (!t) return;
  const seq = await nextSeq('callSeq');
  await stateRef.update({
    ['tickets/'+t.key+'/calledAt']: Date.now(),
    lastCall: { ticket:{label:t.label,no:t.no}, counter:Number(id), at:Date.now(), seq }
  });
}

/* 指定號碼呼叫 */
async function callNumber(id, raw){
  const num = Number(String(raw).toUpperCase().replace(/^[A-Z]+/,''));
  const t = ticketsArr().find(t=>t.no===num && t.status!=='done'); if (!t) return null;
  
  // 指定號碼呼叫時，同樣自動完成當前號碼
  const updates = {};
  const cur = currentOf(id);
  if (cur) {
    updates['tickets/' + cur.key + '/status'] = 'done';
  }

  const seq = await nextSeq('callSeq');
  updates['tickets/' + t.key + '/status'] = 'called';
  updates['tickets/' + t.key + '/counter'] = Number(id);
  updates['tickets/' + t.key + '/calledAt'] = Date.now();
  updates['lastCall'] = { ticket:{label:t.label,no:t.no}, counter:Number(id), at:Date.now(), seq };
  
  await stateRef.update(updates);
  return t;
}

/* 完成 */
async function completeTicket(key){ await stateRef.child('tickets/'+key+'/status').set('done'); }
async function complete(id){ const t = currentOf(id); if (t) await completeTicket(t.key); }

/* 撤回：只限自己櫃位；籌號返回等候隊列 */
async function undoCall(id){
  const t = currentOf(id); if (!t) return null;
  const seq = await nextSeq('undoSeq');
  await stateRef.update({
    ['tickets/'+t.key+'/status']: 'waiting',
    ['tickets/'+t.key+'/counter']: null,
    ['tickets/'+t.key+'/calledAt']: null,
    lastUndo: { label: t.label, counter: Number(id), at: Date.now(), seq }
  });
  return t;
}

/* 停止播報：只限自己櫃位 */
async function stopCall(id){
  const seq = await nextSeq('stopSeq');
  await stateRef.child('lastStop').set({ counter: Number(id), at: Date.now(), seq });
}

/* 全部停止（admin 專用） */
async function stopAll(){
  const seq = await nextSeq('stopSeq');
  await stateRef.child('lastStop').set({ counter: '*', at: Date.now(), seq });
}

/* 時段管理 */
async function setPrefix(p){
  const ups = {};
  ticketsArr().forEach(t => { if (t.status==='waiting') ups['tickets/'+t.key+'/status'] = 'expired'; });
  ups['session'] = { prefix: p, next: 1 }; ups['lastCall'] = null;
  await stateRef.update(ups);
}
async function advance(){
  const c = STATE.session.prefix;
  await setPrefix(c.length===1 ? String.fromCharCode(c.charCodeAt(0)+1) : c+'A');
}
async function saveSettings(s){ await stateRef.child('settings').set(s); }

/* 清除所有籌號數據 */
async function clearTickets(){
  await stateRef.update({
    tickets: null,
    lastCall: null,
    lastUndo: null,
    lastStop: null,
    nowPlaying: null,
    'session/next': 1
  });
}

/* 櫃位暫停/恢復服務 */
async function pauseCounter(id){ await stateRef.child('counters/' + id + '/paused').set(true); }
async function resumeCounter(id){ await stateRef.child('counters/' + id + '/paused').set(false); }
function isCounterPaused(id){ return !!(STATE && STATE.counters && STATE.counters[id] && STATE.counters[id].paused); }
