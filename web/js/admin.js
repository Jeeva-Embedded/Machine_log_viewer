let TOKEN = '';        // admin password, kept in memory only
let CFG = null;        // the working config object
let CURMID = '1';

const $ = id => document.getElementById(id);

function goBack(){
  if(document.referrer && new URL(document.referrer).origin === location.origin){ history.back(); }
  else { location.href = '/'; }
}

function api(path, opts={}){
  opts.headers = Object.assign({'X-Admin-Token': TOKEN}, opts.headers||{});
  return fetch(path, opts);
}
function toast(msg, ok=true){
  const t = $('toast'); t.textContent = msg; t.className = 'toast ' + (ok?'ok':'err');
  if(msg) setTimeout(()=>{ if(t.textContent===msg){t.textContent='';} }, 4000);
}

/* ── login ── */
async function doLogin(){
  const pw = $('pw').value;
  $('login-err').textContent = '';
  if(!pw){ $('login-err').textContent = 'Enter the password'; return; }
  try{
    const r = await fetch('/api/admin/login', {method:'POST',
      headers:{'Content-Type':'application/json'}, body: JSON.stringify({password: pw})});
    const j = await r.json();
    if(r.ok && j.ok){
      TOKEN = pw;
      $('login').classList.add('hidden');
      $('panel').classList.remove('hidden');
      loadSaved();
    } else {
      $('login-err').textContent = j.error || 'Login failed';
    }
  }catch(e){ $('login-err').textContent = 'Server error'; }
}

/* ── load existing saved config (if any) ── */
async function loadSaved(){
  try{
    const r = await api('/api/admin/config');
    const j = await r.json();
    if(j.config){ CFG = j.config; render(); toast('Loaded saved config'); }
  }catch(e){}
}

/* ── upload + parse ── */
async function doUpload(){
  const f = $('file').files[0];
  if(!f){ $('up-status').textContent = 'Choose an .xlsx file first'; return; }
  $('up-status').textContent = 'Parsing…';
  const fd = new FormData(); fd.append('file', f);
  try{
    const r = await api('/api/admin/upload', {method:'POST', body: fd});
    const j = await r.json();
    if(!r.ok){ $('up-status').textContent = j.error || 'Upload failed'; return; }
    CFG = j.config; render();
    $('up-status').textContent = 'Parsed ✓';
    toast('Parsed — review and Save');
  }catch(e){ $('up-status').textContent = 'Error: '+e; }
}

/* ── render everything ── */
function render(){
  if(!CFG) return;
  // meta
  const m = $('meta'); m.classList.remove('hidden');
  m.innerHTML = `Source: <b>${esc(CFG.source_file||'—')}</b> · Version: <b>${esc(CFG.version||'—')}</b>`
    + ` · Parsed: <b>${esc(CFG.parsed_at||'—')}</b>` + (CFG.saved_at? ` · Saved: <b>${esc(CFG.saved_at)}</b>`:'');
  // warnings
  const w = $('warns');
  if(CFG.warnings && CFG.warnings.length){
    w.classList.remove('hidden');
    w.innerHTML = '<b>Parser notes:</b><ul>' + CFG.warnings.map(x=>`<li>${esc(x)}</li>`).join('') + '</ul>';
  } else { w.classList.add('hidden'); }
  renderFns();
  renderTabs();
  renderMachine();
}
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

/* function ids */
function renderFns(){
  CFG.function_ids = CFG.function_ids || [];
  $('fn-count').textContent = CFG.function_ids.length;
  const b = $('fn-body'); b.innerHTML = '';
  CFG.function_ids.forEach((fn, i)=>{
    const tr = document.createElement('tr');
    tr.appendChild(cellInput(fn,'id','col-hex'));
    tr.appendChild(cellInput(fn,'name'));
    tr.appendChild(cellInput(fn,'machines'));
    tr.appendChild(delCell(()=>{ CFG.function_ids.splice(i,1); renderFns(); }));
    b.appendChild(tr);
  });
}
function addFn(){ CFG=CFG||blankCfg(); CFG.function_ids.push({id:'0x',name:'',machines:''}); renderFns(); }

/* machine tabs */
function renderTabs(){
  const t = $('tabs'); t.innerHTML = '';
  Object.keys(CFG.machines).sort().forEach(mid=>{
    const mc = CFG.machines[mid];
    const btn = document.createElement('button');
    btn.className = 'tab' + (mid===CURMID?' active':'');
    btn.textContent = `M${mid} · ${mc.name||''}`;
    btn.onclick = ()=>{ CURMID = mid; renderTabs(); renderMachine(); };
    t.appendChild(btn);
  });
}

/* machine pane = identifiers + frames */
function renderMachine(){
  const mc = CFG.machines[CURMID];
  const pane = $('machine-pane');
  if(!mc){ pane.innerHTML = '<div class="empty">No data for this machine.</div>'; return; }
  mc.identifiers = mc.identifiers || [];
  mc.frames = mc.frames || [];
  pane.innerHTML = '';

  // identifiers
  const idTitle = document.createElement('div'); idTitle.className='tbl-title';
  idTitle.textContent = 'Identifiers (drive → address)'; pane.appendChild(idTitle);
  const idTbl = mkTable(['Drive Name','Address (hex)','']);
  mc.identifiers.forEach((it,i)=>{
    const tr = document.createElement('tr');
    tr.appendChild(cellInput(it,'name'));
    tr.appendChild(cellInput(it,'addr','col-hex'));
    tr.appendChild(delCell(()=>{ mc.identifiers.splice(i,1); renderMachine(); }));
    idTbl.tBodies[0].appendChild(tr);
  });
  pane.appendChild(idTbl);
  pane.appendChild(addBtn('+ Add identifier', ()=>{ mc.identifiers.push({name:'',addr:'0x'}); renderMachine(); }));

  // frames (with the DB0..DBn data-byte layout — "what data is sent")
  const frTitle = document.createElement('div'); frTitle.className='tbl-title';
  frTitle.style.marginTop = '18px';
  frTitle.textContent = 'Frames (type · function · source → destination · data bytes)';
  pane.appendChild(frTitle);

  // widest data row on this machine decides how many DB columns to show
  let maxDb = 0;
  mc.frames.forEach(fr=>{ fr.data = fr.data || []; if(fr.data.length>maxDb) maxDb = fr.data.length; });
  if(maxDb < 1) maxDb = 1;

  const dbHeaders = []; for(let k=0;k<maxDb;k++) dbHeaders.push('DB'+k);
  const headers = ['Frame Type','FN','CAN ID','Source','Dest','DLC','ACK', ...dbHeaders, ''];
  const frTbl = mkTable(headers);
  frTbl.classList.add('frames-tbl');
  mc.frames.forEach((fr,i)=>{
    fr.data = fr.data || [];
    const tr = document.createElement('tr');
    tr.appendChild(cellInput(fr,'frame'));
    tr.appendChild(cellInput(fr,'fn','col-hex'));
    tr.appendChild(cellInput(fr,'can_id','col-hex'));
    tr.appendChild(cellInput(fr,'src'));
    tr.appendChild(cellInput(fr,'dst'));
    tr.appendChild(cellInput(fr,'dlc','col-hex'));
    tr.appendChild(cellInput(fr,'ack'));
    for(let k=0;k<maxDb;k++) tr.appendChild(dbCell(fr, k));
    tr.appendChild(delCell(()=>{ mc.frames.splice(i,1); renderMachine(); }));
    frTbl.tBodies[0].appendChild(tr);
  });
  const scroller = document.createElement('div'); scroller.className='tbl-scroll';
  scroller.appendChild(frTbl); pane.appendChild(scroller);
  pane.appendChild(addBtn('+ Add frame', ()=>{
    mc.frames.push({frame:'',fn:'0x',can_id:'',src:'',src_addr:'0x',dst:'',dst_addr:'0x',
                    dlc:'',ack:'',data:Array(maxDb).fill('')});
    renderMachine();
  }));
}

/* ── small DOM helpers ── */
function cellInput(obj, key, cls){
  const td = document.createElement('td'); if(cls) td.className = cls;
  const inp = document.createElement('input');
  inp.value = obj[key]==null ? '' : obj[key];
  inp.oninput = ()=>{ obj[key] = inp.value; };
  td.appendChild(inp); return td;
}
function dbCell(fr, k){
  const td = document.createElement('td'); td.className = 'col-db';
  const inp = document.createElement('input');
  inp.value = (fr.data && fr.data[k]!=null) ? fr.data[k] : '';
  inp.placeholder = '–';
  inp.oninput = ()=>{
    fr.data = fr.data || [];
    while(fr.data.length <= k) fr.data.push('');
    fr.data[k] = inp.value;
  };
  td.appendChild(inp); return td;
}
function delCell(fn){
  const td = document.createElement('td');
  const b = document.createElement('button'); b.className='row-del'; b.textContent='×'; b.title='Delete row';
  b.onclick = fn; td.appendChild(b); return td;
}
function mkTable(headers){
  const t = document.createElement('table');
  const thead = document.createElement('thead'); const tr = document.createElement('tr');
  headers.forEach(h=>{ const th=document.createElement('th'); th.textContent=h; tr.appendChild(th); });
  thead.appendChild(tr); t.appendChild(thead); t.appendChild(document.createElement('tbody'));
  return t;
}
function addBtn(label, fn){
  const b = document.createElement('button'); b.className='btn-add'; b.textContent=label; b.onclick=fn; return b;
}
function blankCfg(){ return {function_ids:[], machines:{'1':{name:'DrawFrame',identifiers:[],frames:[]}}}; }

/* ── save / download ── */
async function saveConfig(){
  if(!CFG){ toast('Nothing to save', false); return; }
  try{
    const r = await api('/api/admin/config', {method:'POST',
      headers:{'Content-Type':'application/json'}, body: JSON.stringify({config: CFG})});
    const j = await r.json();
    if(r.ok && j.ok){ CFG.saved_at = j.saved_at; render(); toast('Saved ✓'); }
    else { toast(j.error || 'Save failed', false); }
  }catch(e){ toast('Save error', false); }
}
function downloadJson(){
  if(!CFG){ toast('Nothing to download', false); return; }
  const blob = new Blob([JSON.stringify(CFG, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'can_config.json'; a.click();
  URL.revokeObjectURL(a.href);
}
