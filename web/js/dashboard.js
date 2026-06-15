// ── MACHINE DEFINITIONS (from CAN Communication Plan_v9.xlsx) ──
// Per-machine specs live in js/machines/*.js (loaded before this file).
// Debug a single machine in its own file; this engine is generic.
const MACHINE_CONFIG = window.MACHINE_CONFIG || {};
const MACHINE_DEFS   = window.MACHINE_DEFS   || {};

const CANFD_DLC={0:0,1:1,2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:12,10:16,11:20,12:24,13:32,14:48,15:64};
const CURR_GAIN=0.00672,VOLT_GAIN=0.017,MAX_RPM=800,MAX_TEMP=100,MAX_PTS=60;
// FN_MAP kept as DrawFrame default; per-machine maps are in MACHINE_DEFS
const FN_MAP={0x01:'MotorState',0x02:'Error',0x07:'RunSetup',0x09:'RuntimeData',0x0A:'Diagnostics',0x0F:'ACK',0x1E:'AL_Sensor',0x1F:'AL_Setup',0x20:'ACK',0x24:'AL_Settings'};
const ADDR_MAP={0x01:'MB',0x02:'FR',0x03:'BR',0x04:'CREEL',0x0A:'AL'};
const MOTOR_STATE={0:'IDLE',1:'E-STOP',2:'RUNNING',3:'RAMP-DN',4:'CHG-RPM',5:'HOMING',6:'RESUME',7:'RESET',8:'ACK'};
const CSV_HEADER="Timestamp,Millis,Machine,CAN_ID,FunctionID,FunctionName,Source_Addr,Source_Board,Dest_Addr,Dest_Board,DLC_Code,Bytes,Raw_Data,TargetRPM,PresentRPM,PWM,MosfetTemp_C,MotorTemp_C,CurrentADC,CurrentA,VoltageADC,VoltageV,Power_W,Command,ACK,RUT_RampUpTime_s,RDT_RampDownTime_s,Motor_RPM,Draft,Delivery_mMin,AL_Kp,AL_Sliver_N1,AL_Sliver_N,AL_Sliver_Nm1,AL_Target_gm,AL_Counter,AL_ScanningSensor,AL_CoilerSensor,ErrorCode";

// ── STATE ──
let ws=null,activeMachine=1,simTimer=null;
let modalChart=null,modalKey=null,modalType=null,modalInterval=null;
const ALL_MOTOR_KEYS=['FR','BR','CR','M4','M5','M6','M7','M8'];
function makeMD(){return{labels:[],tRPM:[],pRPM:[],curr:[],fet:[],mot:[]};}
function makeMachineState(){
  const cd={AL:{labels:[],scan:[],coil:[]}}, fh={AL:{labels:[],scan:[],coil:[]}};
  ALL_MOTOR_KEYS.forEach(k=>{cd[k]=makeMD();fh[k]=makeMD();});
  ['LL','RL'].forEach(k=>{cd[k]=makeMD();fh[k]=makeMD();});   // lift temp history
  return{frameCount:0,alActive:false,stats:{runtime:0,al:0,cmd:0,err:0},rawLines:[],csvRows:[],
    motorStopTimer:{FR:null,BR:null,CR:null,M4:null,M5:null,M6:null,M7:null,M8:null},
    chartData:cd,fullHistory:fh,
    // snapshot of latest values per machine, so switching machines shows the
    // right data (and switching back restores it) instead of leaking values
    snap:{motors:{}, lifts:{}, states:{}, al:null, setup:{}, logHtml:''}};
}
const machineState={1:makeMachineState(),2:makeMachineState(),3:makeMachineState(),4:makeMachineState()};

// ── RE-RENDER A MACHINE FROM ITS OWN SNAPSHOT (fixes value-leak on switch) ──
function resetArc(p,k){const a=document.getElementById(p+'-'+k+'-arc');if(a){a.setAttribute('stroke-dasharray','0 100.53');a.style.stroke='#22c55e';}setVal(p+'-'+k,'—');}
function renderMachine(mid){
  const mst=machineState[mid], def=MACHINE_DEFS[mid]||MACHINE_DEFS[1];
  // motor cards: restore from snapshot or blank
  ['fr','br','cr','m4','m5','m6','m7','m8'].forEach(p=>{
    const d=mst.snap.motors[p];
    if(d){ paintMotor(p,d); }
    else{
      ['trpm','prpm','pwm','curr','volt','pwr'].forEach(k=>setVal(p+'-'+k,'—'));
      setBar(p+'-rpm-bar',0); setVal(p+'-rpm-pct','0%');
      resetArc(p,'fet'); resetArc(p,'mot');
      const c=document.getElementById('card-'+p); if(c)c.classList.remove('active');
    }
    const st=document.getElementById('state-'+p);
    if(st){ const cmd=mst.snap.states[p];
      if(cmd!==undefined){ st.textContent=MOTOR_STATE[cmd]||'CMD '+cmd; st.className='motor-state-badge '+(cmd===2?'running':cmd===1||cmd===3?'stop':'idle'); }
      else{ st.textContent='IDLE'; st.className='motor-state-badge idle'; } }
  });
  // lift cards: blank then restore
  ['ll','rl'].forEach(p=>{
    ['tpos','ppos','rpm','curr','volt','dir'].forEach(k=>setVal(p+'-'+k,'—'));
    resetArc(p,'fet'); resetArc(p,'mot');
    const c=document.getElementById('card-'+p); if(c)c.classList.remove('active');
  });
  Object.keys(mst.snap.lifts).forEach(src=>updateLiftUI(parseInt(src), mst.snap.lifts[src]));
  // AL panel
  if(mst.snap.al){ setVal('al-scan',mst.snap.al.scan); setVal('al-coil',mst.snap.al.coil); setVal('al-ctr-val',mst.snap.al.ctr); }
  else{ setVal('al-scan','—'); setVal('al-coil','—'); setVal('al-ctr-val','—'); }
  // charts from this machine's stored data
  ALL_MOTOR_KEYS.forEach(k=>{ if(!charts[k])return; const cd=mst.chartData[k];
    charts[k].rpm.data.labels=cd.labels; charts[k].rpm.data.datasets[0].data=cd.tRPM; charts[k].rpm.data.datasets[1].data=cd.pRPM; charts[k].rpm.update('none');
    charts[k].curr.data.labels=cd.labels; charts[k].curr.data.datasets[0].data=cd.curr; charts[k].curr.update('none'); });
  const ald=mst.chartData.AL; charts.AL.data.labels=ald.labels; charts.AL.data.datasets[0].data=ald.scan; charts.AL.data.datasets[1].data=ald.coil; charts.AL.update('none');
  // frame log + KPIs for this machine
  document.getElementById('log-container').innerHTML = mst.snap.logHtml||'';
  updateKPI(mst);
  // export / replay buttons reflect this machine's data
  const hasData = mst.rawLines.length>0;
  document.getElementById('btn-dl-txt').style.display = hasData?'flex':'none';
  document.getElementById('btn-dl-csv').style.display = hasData?'flex':'none';
  document.getElementById('btn-replay').style.display = (mst.loadedFrames&&mst.loadedFrames.length)?'flex':'none';
}

// ── BUILD PER-MOTOR SETUP COLUMNS (Set RPM / Ramp Up / Ramp Down) ──
function renderSetup(mid){
  const def=MACHINE_DEFS[mid]||MACHINE_DEFS[1], mst=machineState[mid];
  const order=['fr','br','cr'].concat(def.extraMotors||[]);
  let html='';
  order.forEach(p=>{
    const nm=(def.motorNames&&def.motorNames[p])||p.toUpperCase();
    const sv=(mst.snap.setup&&mst.snap.setup[p])||{};
    const rpm=sv.rpm!=null?sv.rpm:'—', rut=sv.rut!=null?sv.rut+'s':'—', rdt=sv.rdt!=null?sv.rdt+'s':'—';
    html+=`<div>
      <div class="settings-col-title">${nm}</div>
      <div class="setting-row"><span class="setting-key">Set RPM</span><span class="setting-val" id="su-${p}-rpm">${rpm}</span></div>
      <div class="setting-row"><span class="setting-key">Ramp Up</span><span class="setting-val" id="su-${p}-rut">${rut}</span></div>
      <div class="setting-row"><span class="setting-key">Ramp Down</span><span class="setting-val" id="su-${p}-rdt">${rdt}</span></div>
    </div>`;
  });
  document.getElementById('setup-motors-grid').innerHTML=html;
}

// ── NAVIGATION ──
function openMachine(mid){
  // save the log of the machine we're leaving
  if(machineState[activeMachine]) machineState[activeMachine].snap.logHtml=document.getElementById('log-container').innerHTML;
  activeMachine=mid;
  const cfg=MACHINE_CONFIG[mid];
  const def=MACHINE_DEFS[mid];
  document.getElementById('view-home').style.display='none';
  document.getElementById('view-dash').style.display='block';
  document.getElementById('dash-title').textContent=cfg.name+' Monitor';
  document.getElementById('dash-sub').textContent=cfg.sub;
  document.getElementById('topbar-page').textContent=cfg.name;
  document.getElementById('topbar-machine').textContent='M'+mid;
  document.getElementById('topbar-machine').style.display='inline-flex';
  document.getElementById('btn-back').style.display='inline-flex';
  document.title='Gen4 · '+cfg.name;
  // Motor card titles
  document.querySelector('#card-fr .motor-card-title').innerHTML=`<div class="motor-card-dot"></div>${def.motorNames.fr}`;
  document.querySelector('#card-br .motor-card-title').innerHTML=`<div class="motor-card-dot"></div>${def.motorNames.br}`;
  document.querySelector('#card-cr .motor-card-title').innerHTML=`<div class="motor-card-dot"></div>${def.motorNames.cr}`;
  // Build the per-motor setup columns for this machine
  renderSetup(mid);
  // Show/hide DrawFrame-only sections
  const s=v=>v?'':'none';
  document.getElementById('settings-df-section').style.display=s(def.hasAL);
  const alPanel=document.querySelector('.al-panel');if(alPanel)alPanel.style.display=s(def.hasAL);
  // Topbar AL pill — only for DrawFrame
  document.getElementById('pill-al').style.display=s(def.hasAL);
  // Sidebar links
  document.getElementById('sidebar-al-link').style.display=s(def.hasAL);
  document.getElementById('sidebar-lift-link').style.display=s(def.hasLifts);
  // KPI card — rename for non-AL machines
  document.getElementById('kpi-al-card').style.display=def.hasAL?'':'none';
  document.getElementById('chip-al').style.display=def.hasAL?'':'none';
  // FlyerFrame-specific: lift panel + settings
  document.getElementById('lift-panel').style.display=s(def.hasLifts);
  document.getElementById('settings-flyer-section').style.display=s(def.hasLifts);
  // Extra motor cards (m4-m6)
  const extraMotors=def.extraMotors||[];
  ['m4','m5','m6','m7','m8'].forEach(id=>{
    const show=extraMotors.includes(id);
    const card=document.getElementById('card-'+id);
    if(card)card.style.display=show?'':'none';
    if(show&&def.motorNames[id]){
      document.getElementById('title-'+id).textContent=def.motorNames[id];
    }
  });
  // repaint this machine's own values/charts/log (prevents values leaking between machines)
  renderMachine(mid);
  // Auto-connect when served over the web (server.py / tunnel) so remote viewers
  // see live data immediately without pressing Connect.
  if(location.protocol==='http:'||location.protocol==='https:'){
    setTimeout(()=>{ if(!ws||ws.readyState>1) connectWS(); }, 300);
    loadLogList();
  }
}
function goHome(){
  disconnectWS();
  if(simTimer){clearTimeout(simTimer);simTimer=null;}
  document.getElementById('view-dash').style.display='none';
  document.getElementById('view-home').style.display='block';
  document.getElementById('topbar-machine').style.display='none';
  document.getElementById('btn-back').style.display='none';
  document.getElementById('pill-al').style.display='none';   // AL pill is DrawFrame-only
  document.getElementById('topbar-page').textContent='CAN Monitor';
  document.title='Gen4 Textile CAN Monitor';
}

// ── CHARTS ──
const GRID='rgba(221,227,234,0.8)';
const TC={color:'#5d6b7a',font:{size:9}};
function makeRPMChart(id,c1,c2){
  return new Chart(document.getElementById(id),{type:'line',
    data:{labels:[],datasets:[{label:'Target',data:[],borderColor:c1,borderWidth:1.5,pointRadius:0,tension:0.3},{label:'Present',data:[],borderColor:c2,borderWidth:1.5,pointRadius:0,tension:0.3,borderDash:[4,2]}]},
    options:{animation:false,responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:true,labels:{color:'#5d6b7a',font:{size:8},boxWidth:8,padding:4}}},
      scales:{x:{display:true,ticks:{...TC,maxTicksLimit:4,maxRotation:0},grid:{color:GRID}},
        y:{display:true,min:0,max:MAX_RPM,ticks:{...TC,stepSize:200},grid:{color:GRID},title:{display:true,text:'RPM',color:'#5d6b7a',font:{size:8}}}}}});
}
function makeCurrentChart(id,col){
  return new Chart(document.getElementById(id),{type:'line',
    data:{labels:[],datasets:[{label:'A',data:[],borderColor:col,borderWidth:1.5,pointRadius:0,tension:0.3,fill:true,backgroundColor:col+'18'}]},
    options:{animation:false,responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false}},
      scales:{x:{display:true,ticks:{...TC,maxTicksLimit:4,maxRotation:0},grid:{color:GRID}},
        y:{display:true,min:0,ticks:{color:col,font:{size:8}},grid:{color:GRID},title:{display:true,text:'A',color:'#5d6b7a',font:{size:8}}}}}});
}
function makeALChart(id){
  return new Chart(document.getElementById(id),{type:'line',
    data:{labels:[],datasets:[{label:'Scanning',data:[],borderColor:'#7c3aed',borderWidth:1.5,pointRadius:0,tension:0.3},{label:'Coiler',data:[],borderColor:'#ec4899',borderWidth:1.5,pointRadius:0,tension:0.3}]},
    options:{animation:false,responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:true,labels:{color:'#5d6b7a',font:{size:9},boxWidth:8,padding:4}}},
      scales:{x:{display:true,ticks:{...TC,maxTicksLimit:5,maxRotation:0},grid:{color:GRID}},
        y:{display:true,ticks:{color:'#7c3aed',font:{size:9}},grid:{color:GRID},title:{display:true,text:'ADC',color:'#5d6b7a',font:{size:9}}}}}});
}
const charts={
  FR:{rpm:makeRPMChart('chart-fr-rpm','#2471a3','#7dba3a'),curr:makeCurrentChart('chart-fr-curr','#d97706')},
  BR:{rpm:makeRPMChart('chart-br-rpm','#7c3aed','#2471a3'),curr:makeCurrentChart('chart-br-curr','#7dba3a')},
  CR:{rpm:makeRPMChart('chart-cr-rpm','#c0392b','#d97706'),curr:makeCurrentChart('chart-cr-curr','#7c3aed')},
  M4:{rpm:makeRPMChart('chart-m4-rpm','#00d4ff','#ffd600'),curr:makeCurrentChart('chart-m4-curr','#ff8c00')},
  M5:{rpm:makeRPMChart('chart-m5-rpm','#00ff9d','#a855f7'),curr:makeCurrentChart('chart-m5-curr','#ec4899')},
  M6:{rpm:makeRPMChart('chart-m6-rpm','#7dba3a','#2471a3'),curr:makeCurrentChart('chart-m6-curr','#c0392b')},
  M7:{rpm:makeRPMChart('chart-m7-rpm','#2471a3','#ffd600'),curr:makeCurrentChart('chart-m7-curr','#d97706')},
  M8:{rpm:makeRPMChart('chart-m8-rpm','#a855f7','#00ff9d'),curr:makeCurrentChart('chart-m8-curr','#ec4899')},
  AL:makeALChart('chart-al')
};

function pushChart(mid,key,tRPM,pRPM,curr,fet,mot){
  const mst=machineState[mid],d=mst.chartData[key],h=mst.fullHistory[key];
  const ts=new Date().toLocaleTimeString('en',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
  d.labels.push(ts);d.tRPM.push(tRPM);d.pRPM.push(pRPM);d.curr.push(curr);d.fet.push(fet);d.mot.push(mot);
  if(d.labels.length>MAX_PTS){d.labels.shift();d.tRPM.shift();d.pRPM.shift();d.curr.shift();d.fet.shift();d.mot.shift();}
  h.labels.push(ts);h.tRPM.push(tRPM);h.pRPM.push(pRPM);h.curr.push(curr);h.fet.push(fet);h.mot.push(mot);
  if(mid!==activeMachine||!charts[key])return;   // lifts have history but no card chart
  const cr=charts[key];
  cr.rpm.data.labels=d.labels;cr.rpm.data.datasets[0].data=d.tRPM;cr.rpm.data.datasets[1].data=d.pRPM;cr.rpm.update('none');
  cr.curr.data.labels=d.labels;cr.curr.data.datasets[0].data=d.curr;cr.curr.update('none');
}
function pushALChart(mid,scan,coil){
  const mst=machineState[mid],d=mst.chartData.AL,h=mst.fullHistory.AL;
  const ts=new Date().toLocaleTimeString('en',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
  d.labels.push(ts);d.scan.push(scan);d.coil.push(coil);
  if(d.labels.length>MAX_PTS){d.labels.shift();d.scan.shift();d.coil.shift();}
  h.labels.push(ts);h.scan.push(scan);h.coil.push(coil);
  if(mid!==activeMachine)return;
  const c=charts.AL;c.data.labels=d.labels;c.data.datasets[0].data=d.scan;c.data.datasets[1].data=d.coil;c.update('none');
}

// ── UI ──
function setVal(id,v){const el=document.getElementById(id);if(el)el.textContent=v;}
function setBar(id,p){const el=document.getElementById(id);if(el)el.style.width=Math.min(100,p)+'%';}
function flashSetting(id){const el=document.getElementById(id);if(!el)return;el.classList.add('updated');setTimeout(()=>el.classList.remove('updated'),1500);}

// ── LIFT UI UPDATE ──
function updateLiftUI(src, data){
  // 0x04=LeftLift→ll, 0x05=RightLift→rl
  const p = src===0x04 ? 'll' : src===0x05 ? 'rl' : null;
  if(!p) return;
  // LiftRuntime (0x0C): [0:1]=TPOS(/100m) [2:3]=PPOS(/100m) [4:5]=RPM [6:7]=PWM [8]=FET [9]=MOT [10:11]=Curr [12:13]=Volt [14]=pad [15:16]=GBPos [17:18]=EncPos [19]=UsingPos
  const tpos = ((data[0]<<8)|data[1])/100;
  const ppos = ((data[2]<<8)|data[3])/100;
  const rpm  = (data[4]<<8)|data[5];
  const fet  = data[8], mot = data[9];
  const curr = (data[10]<<8)|data[11];
  const volt = (data[12]<<8)|data[13];
  const dir  = data.length>=20 ? data[19] : (data[14]||0);
  const ca   = (curr*CURR_GAIN).toFixed(3);
  const vv   = (volt*VOLT_GAIN).toFixed(2);
  setVal(p+'-tpos', tpos.toFixed(2));
  setVal(p+'-ppos', ppos.toFixed(2));
  setVal(p+'-rpm',  rpm);
  setVal(p+'-curr', ca);
  setVal(p+'-volt', vv);
  setVal(p+'-dir',  dir===1?'UP':dir===2?'DOWN':'—');
  setTempArc(p+'-fet-arc', p+'-fet', fet);
  setTempArc(p+'-mot-arc', p+'-mot', mot);
  const card = document.getElementById('card-'+p);
  if(card) card.classList.add('active');
}

function setTempArc(arcId,valId,temp){
  const arc=document.getElementById(arcId);
  const val=document.getElementById(valId);
  if(!arc||!val)return;
  const t=Math.max(0,Math.min(100,temp));
  const len=(t/100)*100.53;
  const col=t<40?'#22c55e':t<70?'#f59e0b':'#ef4444';
  arc.setAttribute('stroke-dasharray',`${len} 100.53`);
  arc.style.stroke=col;
  val.textContent=temp;
  val.style.color=col;
}

// paint only the DOM for one motor card (no chart push)
function paintMotor(pfx,d){
  const ca=(d.currADC*CURR_GAIN).toFixed(3),vv=(d.voltADC*VOLT_GAIN).toFixed(2),pw=(parseFloat(ca)*parseFloat(vv)).toFixed(1);
  setVal(pfx+'-trpm',d.tRPM);setVal(pfx+'-prpm',d.pRPM);setVal(pfx+'-pwm',d.pwm);
  setVal(pfx+'-curr',ca);setVal(pfx+'-volt',vv);setVal(pfx+'-pwr',pw);
  const rp=Math.min(100,d.pRPM/MAX_RPM*100);
  setBar(pfx+'-rpm-bar',rp);setVal(pfx+'-rpm-pct',Math.round(rp)+'%');
  setTempArc(pfx+'-fet-arc',pfx+'-fet',d.fet);
  setTempArc(pfx+'-mot-arc',pfx+'-mot',d.mot);
  const card=document.getElementById('card-'+pfx);if(card)card.classList.add('active');
}

function updateMotorUI(mid,pfx,d){
  const mst=machineState[mid],KEY=pfx.toUpperCase();
  mst.snap.motors[pfx]=d;                                   // remember for re-render on machine switch
  pushChart(mid,KEY,d.tRPM,d.pRPM,d.currADC*CURR_GAIN,d.fet,d.mot);  // stores history; paints chart only if active
  if(mst.motorStopTimer[KEY]){clearTimeout(mst.motorStopTimer[KEY]);mst.motorStopTimer[KEY]=null;}
  if(mid===activeMachine) paintMotor(pfx,d);
}

function setMotorState(mid,addr,cmd){
  const def=MACHINE_DEFS[mid]||MACHINE_DEFS[1];
  const pfxLow=def.motorMap[addr];if(!pfxLow)return;
  const pfx=pfxLow.toUpperCase();
  const p=pfxLow,mst=machineState[mid];
  mst.snap.states[p]=cmd;   // remember for re-render
  if(mid===activeMachine){
    const el=document.getElementById('state-'+p);if(!el)return;
    el.textContent=MOTOR_STATE[cmd]||'CMD '+cmd;
    el.className='motor-state-badge '+(cmd===2?'running':cmd===1||cmd===3?'stop':'idle');
  }
  if(cmd===1||cmd===3){
    if(mst.motorStopTimer[pfx])clearTimeout(mst.motorStopTimer[pfx]);
    mst.motorStopTimer[pfx]=setTimeout(()=>{
      if(mid===activeMachine){setVal(p+'-prpm',0);setVal(p+'-trpm',0);setBar(p+'-rpm-bar',0);setVal(p+'-rpm-pct','0%');setVal(p+'-pwr','0');setVal(p+'-curr','0');const c=document.getElementById('card-'+p);if(c)c.classList.remove('active');}
      mst.motorStopTimer[pfx]=null;
    },4000);
  }else if(cmd===0||cmd===7){
    if(mid===activeMachine){setVal(p+'-prpm',0);setVal(p+'-trpm',0);setBar(p+'-rpm-bar',0);setVal(p+'-rpm-pct','0%');const c=document.getElementById('card-'+p);if(c)c.classList.remove('active');}
  }
}

function setPillConn(cls,label){
  const el=document.getElementById('pill-conn');if(!el)return;
  el.className='topbar-status '+cls;
  const dot=document.getElementById('dot-conn');
  el.innerHTML=`<span class="status-dot${cls==='connected'?' pulse':''}"></span> ${label}`;
}
function setALPill(active){
  const el=document.getElementById('pill-al');if(!el)return;
  el.className='topbar-al-pill '+(active?'on':'off');
  el.innerHTML=`<span class="al-dot"></span> AUTO LEVELLER ${active?'ON':'OFF'}`;
}

// ── LOG ──
function addLog(ts,canId,fnName,src,dst,extra){
  const tbody=document.getElementById('log-container');if(!tbody)return;
  const cls={RuntimeData:'lt-runtime',Error:'lt-err',AL_Sensor:'lt-al',MotorState:'lt-cmd',RunSetup:'lt-cmd',AL_Setup:'lt-cmd'}[fnName]||'lt-other';
  const tr=document.createElement('tr');
  tr.innerHTML=`<td><span class="log-type-dot ${cls}"></span>${fnName}</td><td style="color:var(--muted)">${ts}</td><td style="font-family:monospace;color:var(--accent)">${canId}</td><td style="color:var(--muted)">${fnName}</td><td>${ADDR_MAP[src]||src}→${ADDR_MAP[dst]||dst}</td><td>${extra}</td>`;
  tbody.insertBefore(tr,tbody.firstChild);
  if(tbody.rows.length>150)tbody.deleteRow(tbody.rows.length-1);
}

// ── DECODE ──
function decodeFrame(mid,fn,src,dst,data,ts_str,canId){
  const mst=machineState[mid],live=(mid===activeMachine);
  const def=MACHINE_DEFS[mid]||MACHINE_DEFS[1];
  const ts=ts_str.includes(' ')?ts_str.split(' ')[1]:ts_str;
  const fnName=def.fnMap[fn]||`FN_0x${fn.toString(16)}`;
  const cid=canId||'—';

  // ── RUNTIME DATA (FN=0x09) — same 12-byte layout all machines ──
  if(fn===0x09&&data.length>=12){
    mst.stats.runtime++;
    const d={tRPM:(data[0]<<8)|data[1],pRPM:(data[2]<<8)|data[3],pwm:(data[4]<<8)|data[5],fet:data[6],mot:data[7],currADC:(data[8]<<8)|data[9],voltADC:(data[10]<<8)|data[11]};
    const pfx=def.motorMap[src];
    if(pfx)updateMotorUI(mid,pfx,d);
    const ca=(d.currADC*CURR_GAIN).toFixed(2);
    if(live)addLog(ts,cid,fnName,src,dst,`RPM ${d.pRPM}/${d.tRPM} · PWM ${d.pwm} · ${ca}A · ${(d.voltADC*VOLT_GAIN).toFixed(1)}V · FET ${d.fet}°C`);
  }
  // ── MOTOR STATE (FN=0x01) ──
  else if(fn===0x01&&data.length>=1){
    mst.stats.cmd++;setMotorState(mid,dst,data[0]);
    if(live)addLog(ts,cid,fnName,src,dst,MOTOR_STATE[data[0]]||`CMD ${data[0]}`);
  }
  // ── RUN SETUP (FN=0x07) — all machines: 4 bytes [RUT(1), RDT(1), RPM_H, RPM_L] ──
  else if(fn===0x07&&data.length>=4){
    mst.stats.cmd++;
    const rut=data[0],rdt=data[1],rpm=(data[2]<<8)|data[3];
    const k=def.motorMap[dst];
    if(k) mst.snap.setup[k]={rut,rdt,rpm};   // remember for re-render
    if(k&&live){setVal('su-'+k+'-rut',rut+'s');flashSetting('su-'+k+'-rut');setVal('su-'+k+'-rdt',rdt+'s');flashSetting('su-'+k+'-rdt');setVal('su-'+k+'-rpm',rpm);flashSetting('su-'+k+'-rpm');}
    if(live)addLog(ts,cid,fnName,src,dst,`RUT:${rut}s RDT:${rdt}s RPM:${rpm}`);
  }
  // ── AL SETUP (FN=0x1F) — DrawFrame only ──
  else if(fn===0x1F&&data.length>=4&&def.hasAL){
    mst.stats.cmd++;const draft=((data[0]<<8)|data[1])/100,del=(data[2]<<8)|data[3],alFlag=data.length>=5?data[4]:0;
    mst.alActive=!!alFlag;
    if(live){
      setVal('s-draft',draft.toFixed(2));flashSetting('s-draft');setVal('s-delivery',del+' m/min');flashSetting('s-delivery');
      const stEl=document.getElementById('state-al');
      if(alFlag){setALPill(true);if(stEl){stEl.textContent='ACTIVE';stEl.className='al-active-chip active';}}
      else{setALPill(false);if(stEl){stEl.textContent='INACTIVE';stEl.className='al-active-chip';}}
      addLog(ts,cid,fnName,src,dst,`Draft:${draft} Del:${del}m/min AL:${alFlag?'ON':'OFF'}`);
    }
  }
  // ── AL SETTINGS (FN=0x24) — DrawFrame only ──
  else if(fn===0x24&&data.length>=10&&def.hasAL){
    const kp=((data[0]<<8)|data[1])/1000,sn1=(data[2]<<8)|data[3],sn=(data[4]<<8)|data[5],snm1=(data[6]<<8)|data[7],tgt=((data[8]<<8)|data[9])/100;
    if(live){setVal('al-kp',kp.toFixed(3));setVal('al-sn1',sn1);setVal('al-sn',sn);setVal('al-snm1',snm1);setVal('al-tgt',tgt+' g/m');addLog(ts,cid,fnName,src,dst,`Kp:${kp} N:${sn} Tgt:${tgt}g/m`);}
  }
  // ── AL SENSOR (FN=0x1E) — DrawFrame only ──
  else if(fn===0x1E&&data.length>=5&&def.hasAL){
    mst.stats.al++;const scan=(data[1]<<8)|data[2],coil=(data[3]<<8)|data[4];
    mst.snap.al={scan,coil,ctr:data[0]};   // remember for re-render
    if(live){setVal('al-scan',scan);setVal('al-coil',coil);setVal('al-ctr-val',data[0]);}
    pushALChart(mid,scan,coil);
    if(live&&mst.stats.al%10===0)addLog(ts,cid,fnName,src,dst,`Scan:${scan} Coil:${coil}`);
  }
  // ── LIFT RUNTIME (FN=0x0C) — FlyerFrame: 20 bytes ──
  else if(fn===0x0C&&data.length>=14&&def.hasLifts){
    mst.stats.runtime++;
    mst.snap.lifts[src]=data.slice();   // remember for re-render
    const P=src===0x04?'LL':src===0x05?'RL':null;
    if(P) pushChart(mid,P,(data[4]<<8)|data[5],(data[4]<<8)|data[5],((data[10]<<8)|data[11])*CURR_GAIN,data[8],data[9]);
    if(live) updateLiftUI(src, data);
    const tpos=((data[0]<<8)|data[1])/100, ppos=((data[2]<<8)|data[3])/100;
    const rpm=(data[4]<<8)|data[5], ca=((data[10]<<8)|data[11])*CURR_GAIN;
    const lname=def.addrMap[src]||`0x${src.toString(16)}`;
    if(live)addLog(ts,cid,'LiftRuntime',src,dst,`${lname} TPOS:${tpos.toFixed(2)}m PPOS:${ppos.toFixed(2)}m RPM:${rpm} ${ca.toFixed(2)}A FET:${data[8]}°C`);
  }
  // ── LIFT RUN SETUP (FN=0x10) — FlyerFrame: StrokeLen(2) StrokeTime(2) Dir(1) LiftRUT(1) LiftRDT(1) LiftCRT(2) ──
  else if(fn===0x10&&data.length>=7&&def.hasLifts){
    mst.stats.cmd++;
    const strokeLen=((data[0]<<8)|data[1])/100, strokeTime=(data[2]<<8)|data[3];
    const dir=data[4]===1?'UP':data[4]===2?'DOWN':'?';
    const rut=data[5], rdt=data[6];
    if(live){
      setVal('ff-stroke-len',strokeLen.toFixed(2)+' m'); flashSetting('ff-stroke-len');
      setVal('ff-stroke-time',strokeTime+' ms');         flashSetting('ff-stroke-time');
      setVal('ff-lift-dir',dir);
      setVal('ff-lift-rut',rut+'s'); flashSetting('ff-lift-rut');
      setVal('ff-lift-rdt',rdt+'s'); flashSetting('ff-lift-rdt');
      addLog(ts,cid,'LiftRunSetup',src,dst,`StrokeLen:${strokeLen.toFixed(2)}m Time:${strokeTime}ms Dir:${dir} RUT:${rut}s RDT:${rdt}s`);
    }
  }
  // ── CHANGE TARGET (FN=0x0D) — FlyerFrame: TargetRPM(2) TransitionTime(2) ──
  else if(fn===0x0D&&data.length>=4&&def.hasLifts){
    mst.stats.cmd++;
    const target=(data[0]<<8)|data[1], tt=(data[2]<<8)|data[3];
    const dname=def.addrMap[dst]||`0x${dst.toString(16)}`;
    if(live&&dst===0x03){ // Bobbin
      setVal('ff-bobbin-target',target+' RPM'); flashSetting('ff-bobbin-target');
      setVal('ff-bobbin-tt',tt+' ms');
    }
    if(live)addLog(ts,cid,'ChangeTarget',src,dst,`${dname} Target:${target} RPM TT:${tt}ms`);
  }
  // ── EXTENDED CYLINDER DATA (FN=0x0B) — BlowCard Cylinder & Beater: 32 bytes ──
  // [0:1]=ActRPM [2:3]=TargetRPM [4:5]=BusVoltage [6:7]=Id [8:9]=Iq [10:11]=PeakPhaseCurr
  // [12:13]=PeakPhaseVolt [14]=FETTemp [15]=MOTTemp [16:17]=PrevFault [18:19]=CurrFault [20:21]=Power [22]=MotorState
  else if(fn===0x0B&&data.length>=14){
    mst.stats.runtime++;
    const d={tRPM:(data[2]<<8)|data[3],pRPM:(data[0]<<8)|data[1],pwm:0,
             fet:data[14]||0,mot:data[15]||0,currADC:(data[10]<<8)|data[11],voltADC:(data[4]<<8)|data[5]};
    const pfx=def.motorMap[src];
    if(pfx)updateMotorUI(mid,pfx,d);
    const ca=(d.currADC*CURR_GAIN).toFixed(2);
    if(live)addLog(ts,cid,'CylExtData',src,dst,`RPM:${d.pRPM}/${d.tRPM} ${ca}A FET:${d.fet}°C`);
  }
  // ── BACK ROLLER SETTINGS (FN=0x1C) — FlyerFrame: 2×16 bytes, data[0]=segment ──
  else if(fn===0x1C&&data.length>=15&&def.hasLifts){
    mst.stats.cmd++;
    const seg=data[0];
    let detail='';
    if(seg===0){
      const spd=(data[1]<<8)|data[2];
      const td=((data[3]<<8)|data[4])/100;
      const tpi=((data[5]<<8)|data[6])/100;
      const layers=(data[7]<<8)|data[8];
      const ch=(data[9]<<8)|data[10];
      const rw=((data[11]<<8)|data[12])/100;
      const dbd=((data[13]<<8)|data[14])/100;
      detail=`Seg0 Speed:${spd} TDraft:${td.toFixed(2)} TPI:${tpi.toFixed(2)} Layers:${layers} ContentH:${ch} RovingW:${rw.toFixed(2)} ΔBobDia:${dbd.toFixed(2)}`;
    } else if(seg===1){
      const bbd=(data[1]<<8)|data[2];
      const rtf=((data[3]<<8)|data[4])/100;
      const rut=(data[5]<<8)|data[6];
      const rdt=(data[7]<<8)|data[8];
      const clt=(data[9]<<8)|data[10];
      const caf=((data[11]<<8)|data[12])/100;
      detail=`Seg1 BareBobDia:${bbd} RTF:${rtf.toFixed(2)} RUT:${rut} RDT:${rdt} LayerChgT:${clt} ConeAng:${caf.toFixed(2)}`;
    }
    if(live)addLog(ts,cid,'BackRollerSettings',src,dst,detail);
  }
  // ── ERROR — 2 bytes (DrawFrame) or 3 bytes (BlowCard/Flyer) ──
  else if(fn===0x02&&data.length>=2){
    mst.stats.err++;
    const errStr=def.errorBytes>=3&&data.length>=3
      ?`EH:0x${data[0].toString(16).toUpperCase()} EMB:0x${data[1].toString(16).toUpperCase()} EL:0x${data[2].toString(16).toUpperCase()}`
      :`0x${((data[0]<<8)|data[1]).toString(16).toUpperCase()}`;
    if(live)addLog(ts,cid,fnName,src,dst,`ERR: ${errStr}`);
  }

  mst.frameCount++;
  if(live)updateKPI(mst);
}

function updateKPI(mst){
  setVal('frame-count',mst.frameCount);
  setVal('kpi-frames',mst.frameCount);
  setVal('kpi-rt',mst.stats.runtime);
  setVal('kpi-al',mst.stats.al);
  setVal('kpi-err',mst.stats.err);
  setVal('stat-rt',mst.stats.runtime);
  setVal('stat-al',mst.stats.al);
  setVal('stat-err',mst.stats.err);
  document.getElementById('chip-rt').textContent='RT: '+mst.stats.runtime;
  document.getElementById('chip-al').textContent='AL: '+mst.stats.al;
  document.getElementById('chip-err').textContent='ERR: '+mst.stats.err;
}

// ── CSV ──
function buildCsvRow(mid,fn,src,sn,dst,dn,dlc,nb,raw_hex,data,ts){
  const MS={1:'EmergencyStop',2:'Start',3:'RampDownStop',4:'ChangeRPM',5:'Homing',6:'Resume',7:'Reset',8:'AckPresence'};
  const _ms=(ts||'').includes('.')?(ts||'').split('.')[1]:'';   // milliseconds in its own column
  ts=(ts||'').split('.')[0];   // Timestamp without ms so Excel shows full date+time
  let r={Timestamp:ts,Millis:_ms,Machine:'M'+mid,CAN_ID:'',FunctionID:`0x${fn.toString(16).toUpperCase().padStart(2,'0')}`,FunctionName:FN_MAP[fn]||`FN_0x${fn.toString(16)}`,Source_Addr:`0x${src.toString(16).toUpperCase().padStart(2,'0')}`,Source_Board:sn,Dest_Addr:`0x${dst.toString(16).toUpperCase().padStart(2,'0')}`,Dest_Board:dn,DLC_Code:dlc,Bytes:nb,Raw_Data:raw_hex,TargetRPM:'',PresentRPM:'',PWM:'',MosfetTemp_C:'',MotorTemp_C:'',CurrentADC:'',CurrentA:'',VoltageADC:'',VoltageV:'',Power_W:'',Command:'',ACK:'',RUT_RampUpTime_s:'',RDT_RampDownTime_s:'',Motor_RPM:'',Draft:'',Delivery_mMin:'',AL_Kp:'',AL_Sliver_N1:'',AL_Sliver_N:'',AL_Sliver_Nm1:'',AL_Target_gm:'',AL_Counter:'',AL_ScanningSensor:'',AL_CoilerSensor:'',ErrorCode:''};
  if(fn===0x09&&data.length>=12){const c=(data[8]<<8)|data[9],v=(data[10]<<8)|data[11],ca=c*CURR_GAIN,vv=v*VOLT_GAIN;Object.assign(r,{TargetRPM:(data[0]<<8)|data[1],PresentRPM:(data[2]<<8)|data[3],PWM:(data[4]<<8)|data[5],MosfetTemp_C:data[6],MotorTemp_C:data[7],CurrentADC:c,CurrentA:ca.toFixed(4),VoltageADC:v,VoltageV:vv.toFixed(3),Power_W:(ca*vv).toFixed(3)});}
  else if(fn===0x07&&data.length>=4)Object.assign(r,{RUT_RampUpTime_s:data[0],RDT_RampDownTime_s:data[1],Motor_RPM:(data[2]<<8)|data[3]});
  else if(fn===0x1F&&data.length>=4)Object.assign(r,{Draft:(((data[0]<<8)|data[1])/100).toFixed(2),Delivery_mMin:(data[2]<<8)|data[3]});
  else if(fn===0x24&&data.length>=10)Object.assign(r,{AL_Kp:(((data[0]<<8)|data[1])/1000).toFixed(4),AL_Sliver_N1:(data[2]<<8)|data[3],AL_Sliver_N:(data[4]<<8)|data[5],AL_Sliver_Nm1:(data[6]<<8)|data[7],AL_Target_gm:(((data[8]<<8)|data[9])/100).toFixed(2)});
  else if(fn===0x1E&&data.length>=5)Object.assign(r,{AL_Counter:data[0],AL_ScanningSensor:(data[1]<<8)|data[2],AL_CoilerSensor:(data[3]<<8)|data[4]});
  else if(fn===0x01&&data.length>=1)r.Command=MS[data[0]]||`0x${data[0].toString(16)}`;
  else if((fn===0x0F||fn===0x20)&&data.length>=1)r.ACK=data[0]===1?'OK':`0x${data[0].toString(16)}`;
  else if(fn===0x02&&data.length>=2)r.ErrorCode=`0x${((data[0]<<8)|data[1]).toString(16).toUpperCase().padStart(4,'0')}`;
  const K=["Timestamp","Millis","Machine","CAN_ID","FunctionID","FunctionName","Source_Addr","Source_Board","Dest_Addr","Dest_Board","DLC_Code","Bytes","Raw_Data","TargetRPM","PresentRPM","PWM","MosfetTemp_C","MotorTemp_C","CurrentADC","CurrentA","VoltageADC","VoltageV","Power_W","Command","ACK","RUT_RampUpTime_s","RDT_RampDownTime_s","Motor_RPM","Draft","Delivery_mMin","AL_Kp","AL_Sliver_N1","AL_Sliver_N","AL_Sliver_Nm1","AL_Target_gm","AL_Counter","AL_ScanningSensor","AL_CoilerSensor","ErrorCode"];
  return K.map(k=>String(r[k]||'')).join(',');
}

// ── WEBSOCKET ──
function wsURL(){
  // Served over http(s) (server.py / cloud tunnel): use SAME origin -> /ws
  if(location.protocol==='http:'||location.protocol==='https:'){
    const proto=location.protocol==='https:'?'wss:':'ws:';
    return `${proto}//${location.host}/ws`;
  }
  // Opened as a local file:// — fall back to the host/port inputs
  const host=document.getElementById('inp-host').value;
  const port=parseInt(document.getElementById('inp-port').value);
  return `ws://${host}:${port}/ws`;
}
function connectWS(){
  setPillConn('warn','Connecting...');
  try{
    ws=new WebSocket(wsURL());
    ws.onopen=()=>{
      setPillConn('connected','Connected');
      document.getElementById('btn-connect').style.display='none';
      document.getElementById('btn-disconnect').style.display='block';
      setFileNote(false);
    };
    ws.onmessage=(e)=>{
      try{
        const msg=JSON.parse(e.data);
        const mid=msg.machine||activeMachine;
        if(msg.event==='offline')return;
        if(mid!==activeMachine)return;
        const mst=machineState[mid];
        const sn=msg.src_name||ADDR_MAP[msg.src]||`0x${msg.src.toString(16).padStart(2,'0')}`;
        const dn=msg.dst_name||ADDR_MAP[msg.dst]||`0x${msg.dst.toString(16).padStart(2,'0')}`;
        mst.rawLines.push(`${msg.ts} | ${msg.can_id} | FN:0x${msg.fn.toString(16).toUpperCase().padStart(2,'0')} SRC:0x${msg.src.toString(16).toUpperCase().padStart(2,'0')} DST:0x${msg.dst.toString(16).toUpperCase().padStart(2,'0')} | DLC_code:${msg.dlc_code} Bytes:${msg.num_bytes} | ${msg.raw_hex}`);
        mst.csvRows.push(buildCsvRow(mid,msg.fn,msg.src,sn,msg.dst,dn,msg.dlc_code,msg.num_bytes,msg.raw_hex,msg.data,msg.ts));
        if(mst.rawLines.length===1){document.getElementById('btn-dl-txt').style.display='flex';document.getElementById('btn-dl-csv').style.display='flex';}
        decodeFrame(mid,msg.fn,msg.src,msg.dst,msg.data,msg.ts,msg.can_id);
      }catch(err){console.warn('WS:',err);}
    };
    ws.onerror=()=>{setPillConn('disconnected','Proxy not running');showToast('WebSocket proxy not running. Run: python ws_proxy.py','err');};
    ws.onclose=()=>{setPillConn('disconnected','Disconnected');document.getElementById('btn-connect').style.display='block';document.getElementById('btn-disconnect').style.display='none';};
  }catch(e){setPillConn('disconnected','Error');}
}
function disconnectWS(){if(ws)ws.close();document.getElementById('btn-connect').style.display='block';document.getElementById('btn-disconnect').style.display='none';}

// ── FILE LOAD ──
function setFileNote(show,text){
  const n=document.getElementById('file-note');
  if(show){n.classList.add('show');document.getElementById('file-note-text').textContent=text||'';}
  else n.classList.remove('show');
}

function loadFile(event){
  const file=event.target.files[0];if(!file)return;
  event.target.value='';
  if(simTimer){clearTimeout(simTimer);simTimer=null;}
  clearAll();
  const mid=activeMachine;
  setFileNote(true,'Loading: '+file.name+' …');
  const reader=new FileReader();
  reader.onload=(e)=>{
    const lines=e.target.result.split(/\r?\n/);
    const RE_NEW=/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\s*\|\s*(0x[0-9A-Fa-f]+)\s*\|\s*FN:(0x[0-9A-Fa-f]+)\s+SRC:(0x[0-9A-Fa-f]+)\s+DST:(0x[0-9A-Fa-f]+)\s*\|\s*DLC_code:(\d+)\s+Bytes:(\d+)\s*\|\s*([0-9A-Fa-f ]*)/;
    const RE_OLD=/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\s*\|\s*(0x[0-9A-Fa-f]{8})\s*\|\s*(\d+)\s*\|\s*([0-9A-Fa-f ]+)/;
    const frames=[];
    for(const line of lines){
      const ln=line.trim();if(!ln||ln.startsWith('#')||ln.startsWith('-'))continue;
      let m=ln.match(RE_NEW);
      if(m){const fn=parseInt(m[3],16),src=parseInt(m[4],16),dst=parseInt(m[5],16);const data=m[8].trim().split(/\s+/).filter(x=>/^[0-9A-Fa-f]{1,2}$/.test(x)).map(x=>parseInt(x,16));frames.push({ts:m[1],can_id:m[2],fn,src,dst,dlc:parseInt(m[6]),nb:parseInt(m[7]),raw_hex:m[8].trim(),data});continue;}
      m=ln.match(RE_OLD);
      if(m){const rawId=parseInt(m[2],16);const b0=rawId&0xFF,b1=(rawId>>8)&0xFF,b2=(rawId>>16)&0xFF,b3=(rawId>>24)&0xFF;const canId=(b0<<24)|(b1<<16)|(b2<<8)|b3;const fn=(canId>>16)&0xFF,dst=(canId>>8)&0xFF,src=canId&0xFF;const dlc=parseInt(m[3]),nb=CANFD_DLC[dlc]||dlc;const data=m[4].trim().split(/\s+/).filter(x=>/^[0-9A-Fa-f]{1,2}$/.test(x)).slice(0,nb).map(x=>parseInt(x,16));frames.push({ts:m[1],can_id:`0x${canId.toString(16).toUpperCase().padStart(8,'0')}`,fn,src,dst,dlc,nb,raw_hex:m[4].trim(),data});}
    }
    if(frames.length===0){setFileNote(true,'No valid frames found in '+file.name);showToast('No frames found — check file format','err');return;}
    // remember the parsed frames so this machine's log can be replayed
    machineState[mid].loadedFrames=frames;
    machineState[mid].loadedName=file.name;
    playLoaded(mid, frames, file.name);
  };
  reader.readAsText(file);
}

// decode a set of parsed frames into a machine (used by load + replay)
function playLoaded(mid, frames, name){
  const mst=machineState[mid];
  for(const f of frames){
    const sn=ADDR_MAP[f.src]||`0x${f.src.toString(16).padStart(2,'0')}`,dn=ADDR_MAP[f.dst]||`0x${f.dst.toString(16).padStart(2,'0')}`;
    mst.rawLines.push(`${f.ts} | ${f.can_id} | FN:0x${f.fn.toString(16).toUpperCase().padStart(2,'0')} SRC:0x${f.src.toString(16).toUpperCase().padStart(2,'0')} DST:0x${f.dst.toString(16).toUpperCase().padStart(2,'0')} | DLC_code:${f.dlc} Bytes:${f.nb} | ${f.raw_hex}`);
    mst.csvRows.push(buildCsvRow(mid,f.fn,f.src,sn,f.dst,dn,f.dlc,f.nb,f.raw_hex,f.data,f.ts));
  }
  document.getElementById('btn-dl-txt').style.display='flex';
  document.getElementById('btn-dl-csv').style.display='flex';
  document.getElementById('btn-replay').style.display='flex';
  let idx=0;
  function chunk(){
    if(mid!==activeMachine){return;}  // user switched away mid-replay
    const end=Math.min(idx+200,frames.length);
    for(;idx<end;idx++){const f=frames[idx];decodeFrame(mid,f.fn,f.src,f.dst,f.data,f.ts,f.can_id);}
    const pct=Math.round(idx/frames.length*100);
    setFileNote(true,`${name} — ${frames.length} frames — ${pct}%`);
    if(idx<frames.length){simTimer=setTimeout(chunk,0);}
    else{setFileNote(true,`${name} — ${frames.length} frames decoded`);showToast(`Loaded ${frames.length} frames from ${name}`);}
  }
  chunk();
}

function replayLoaded(){
  const mst=machineState[activeMachine];
  if(!mst.loadedFrames||!mst.loadedFrames.length){showToast('No log loaded on this machine to replay','err');return;}
  const frames=mst.loadedFrames, name=mst.loadedName||'log';
  if(simTimer){clearTimeout(simTimer);simTimer=null;}
  clearAll();                                          // clearAll wipes the machine state...
  machineState[activeMachine].loadedFrames=frames;     // ...so re-attach the frames
  machineState[activeMachine].loadedName=name;
  playLoaded(activeMachine, frames, name);
}

// ── DOWNLOADS ──
function downloadTxt(){const mst=machineState[activeMachine],ts=new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([mst.rawLines.join('\n')],{type:'text/plain'}));a.download=`CAN_M${activeMachine}_raw_${ts}.txt`;a.click();}
function downloadCsv(){const mst=machineState[activeMachine],ts=new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([CSV_HEADER+'\n'+mst.csvRows.join('\n')],{type:'text/csv'}));a.download=`CAN_M${activeMachine}_decoded_${ts}.csv`;a.click();}

// ── LOG ARCHIVE (saved files on the laptop, fetched via the relay) ──
function fmtSize(b){ if(b>=1048576) return (b/1048576).toFixed(1)+' MB'; if(b>=1024) return (b/1024).toFixed(0)+' KB'; return b+' B'; }

async function loadLogList(){
  const box=document.getElementById('log-archive');
  // Only works when served by the relay (http/https), not file://
  if(location.protocol==='file:'){ box.innerHTML='<div class="la-empty">Open via the website to see saved logs.</div>'; return; }
  box.innerHTML='<div class="la-empty">Loading…</div>';
  try{
    const r=await fetch('/api/logs',{cache:'no-store'});
    const j=await r.json();
    if(!j.agent){ box.innerHTML='<div class="la-empty">Laptop agent offline — start START_AGENT.bat.</div>'; return; }
    const files=j.files||[];
    if(files.length===0){ box.innerHTML='<div class="la-empty">No logs saved yet.</div>'; return; }
    // group: machine -> date -> {raw, csv}
    const g={};
    for(const f of files){
      g[f.machine]=g[f.machine]||{name:f.machine_name,dates:{}};
      g[f.machine].dates[f.date]=g[f.machine].dates[f.date]||{};
      g[f.machine].dates[f.date][f.kind]=f;
    }
    let html='';
    Object.keys(g).sort().forEach(mid=>{
      html+=`<div class="la-machine">${g[mid].name}</div>`;
      const dates=Object.keys(g[mid].dates).sort().reverse();
      for(const d of dates){
        const e=g[mid].dates[d];
        let links='';
        if(e.raw)     links+=`<a class="la-dl raw" href="/api/log?name=${encodeURIComponent(e.raw.name)}" title="${fmtSize(e.raw.size)}">RAW</a>`;
        if(e.decoded) links+=`<a class="la-dl csv" href="/api/log?name=${encodeURIComponent(e.decoded.name)}" title="${fmtSize(e.decoded.size)}">CSV</a>`;
        html+=`<div class="la-row"><span class="la-date">${d}</span>${links}</div>`;
      }
    });
    box.innerHTML=html;
  }catch(err){
    box.innerHTML='<div class="la-empty">Could not load archive.</div>';
  }
}
// refresh archive every 30s while viewing
setInterval(()=>{ if(document.getElementById('view-dash').style.display==='block') loadLogList(); }, 30000);

// ── LOG FILES TAB (full view) ──
function fmtSession(s){ // "20260606-093000" -> "2026-06-06  09:30:00"
  const m=/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(s);
  return m?`${m[1]}-${m[2]}-${m[3]}  ${m[4]}:${m[5]}:${m[6]}`:s;
}
function openLogsView(){ document.getElementById('logs-modal').classList.add('open'); loadDriveFolder(); loadLogsTable(); }
function closeLogsView(){ document.getElementById('logs-modal').classList.remove('open'); }

// ── Google Drive folder editor ──
const DRIVE_FOLDER_DEFAULT='1b4HZMG3F55Lw7wKslH93ZgvmoF0YYXxA';
function extractFolderId(s){
  s=(s||'').trim();
  const m=s.match(/folders\/([A-Za-z0-9_-]+)/);
  if(m) return m[1];
  if(/^[A-Za-z0-9_-]{10,}$/.test(s)) return s;   // raw id
  return '';
}
function updateDriveFolderLink(id){
  const a=document.getElementById('drive-folder-link');
  if(id){ a.href='https://drive.google.com/drive/folders/'+id; a.style.display='inline-flex'; }
  else a.style.display='none';
}
function loadDriveFolder(){
  const id=localStorage.getItem('driveFolderId')||DRIVE_FOLDER_DEFAULT;
  document.getElementById('drive-folder-input').value=id;
  updateDriveFolderLink(id);
}
function saveDriveFolder(){
  const id=extractFolderId(document.getElementById('drive-folder-input').value);
  if(!id){ showToast('Enter a valid Drive folder link or ID','err'); return; }
  localStorage.setItem('driveFolderId', id);
  document.getElementById('drive-folder-input').value=id;
  updateDriveFolderLink(id);
  if(ws && ws.readyState===1){ ws.send(JSON.stringify({type:'set_drive_folder', folder_id:id})); showToast('Drive folder updated — logs will upload here'); }
  else { showToast('Saved. Click Connect Live to apply it on the agent.'); }
}
async function loadLogsTable(){
  const box=document.getElementById('logs-table-wrap');
  if(location.protocol==='file:'){ box.innerHTML='<div class="la-empty" style="padding:20px;color:var(--muted);">Open via the website (not file://) to see saved logs.</div>'; return; }
  box.innerHTML='<div class="la-empty" style="padding:20px;color:var(--muted);">Loading…</div>';
  try{
    const j=await (await fetch('/api/logs',{cache:'no-store'})).json();
    if(!j.agent){ box.innerHTML='<div class="la-empty" style="padding:20px;color:var(--muted);">Laptop agent offline — start START_AGENT.bat.</div>'; return; }
    const files=j.files||[];
    if(files.length===0){ box.innerHTML='<div class="la-empty" style="padding:20px;color:var(--muted);">No logs saved yet. Logs appear once the machine sends data.</div>'; return; }
    // group: machine -> session -> {raw, decoded}
    const g={};
    for(const f of files){
      g[f.machine]=g[f.machine]||{name:f.machine_name,sess:{}};
      g[f.machine].sess[f.date]=g[f.machine].sess[f.date]||{};
      g[f.machine].sess[f.date][f.kind]=f;
    }
    let html='<table class="logs-table"><thead><tr><th>Machine</th><th>Session (connect time)</th><th>Files</th></tr></thead><tbody>';
    Object.keys(g).sort().forEach(mid=>{
      const dates=Object.keys(g[mid].sess).sort().reverse();
      dates.forEach((d,i)=>{
        const e=g[mid].sess[d];
        let links='';
        if(e.raw)     links+=`<a class="logs-dl raw" href="/api/log?name=${encodeURIComponent(e.raw.name)}">⬇ RAW (${fmtSize(e.raw.size)})</a>`;
        if(e.decoded) links+=`<a class="logs-dl csv" href="/api/log?name=${encodeURIComponent(e.decoded.name)}">⬇ CSV (${fmtSize(e.decoded.size)})</a>`;
        html+=`<tr><td class="logs-mname">${i===0?g[mid].name:''}</td><td>${fmtSession(d)}</td><td>${links||'—'}</td></tr>`;
      });
    });
    html+='</tbody></table>';
    box.innerHTML=html;
  }catch(err){ box.innerHTML='<div class="la-empty" style="padding:20px;color:var(--danger);">Could not load: '+err+'</div>'; }
}

// ── CLEAR ──
function clearAll(){
  if(simTimer){clearTimeout(simTimer);simTimer=null;}
  machineState[activeMachine]=makeMachineState();
  document.getElementById('log-container').innerHTML='';
  setFileNote(false);
  ['btn-dl-txt','btn-dl-csv','btn-replay'].forEach(id=>{const b=document.getElementById(id);if(b)b.style.display='none';});
  updateKPI(machineState[activeMachine]);
  ['fr','br','cr','m4','m5','m6','m7','m8'].forEach(p=>{
    ['trpm','prpm','pwm','curr','volt','pwr'].forEach(k=>setVal(p+'-'+k,'—'));
    ['fet','mot'].forEach(k=>{setVal(p+'-'+k,'—');const a=document.getElementById(p+'-'+k+'-arc');if(a){a.setAttribute('stroke-dasharray','0 100.53');a.style.stroke='#22c55e';}});
    setBar(p+'-rpm-bar',0);setVal(p+'-rpm-pct','0%');
    const c=document.getElementById('card-'+p);if(c)c.classList.remove('active');
    const st=document.getElementById('state-'+p);if(st){st.textContent='IDLE';st.className='motor-state-badge idle';}
  });
  setVal('al-scan','—');setVal('al-coil','—');setVal('al-ctr-val','—');
  renderSetup(activeMachine);   // rebuild empty per-motor setup columns
  setALPill(false);const stEl=document.getElementById('state-al');if(stEl){stEl.textContent='INACTIVE';stEl.className='al-active-chip';}
  ALL_MOTOR_KEYS.forEach(k=>{if(!charts[k])return;charts[k].rpm.data.labels=[];charts[k].rpm.data.datasets.forEach(d=>d.data=[]);charts[k].rpm.update('none');charts[k].curr.data.labels=[];charts[k].curr.data.datasets.forEach(d=>d.data=[]);charts[k].curr.update('none');});
  charts.AL.data.labels=[];charts.AL.data.datasets.forEach(d=>d.data=[]);charts.AL.update('none');
  closeModal();
}

// ── TOAST ──
function showToast(msg,type){
  const w=document.getElementById('toast-wrap');
  const t=document.createElement('div');
  t.className='toast';
  t.style.borderLeftColor=type==='err'?'var(--danger)':'var(--primary)';
  t.innerHTML=`<span>${msg}</span><button onclick="this.parentElement.remove()" style="background:none;border:none;color:var(--muted);font-size:16px;cursor:pointer;">×</button>`;
  w.appendChild(t);setTimeout(()=>t.remove(),4000);
}

// ── MODAL ──
function motorLabel(key){
  if(key==='AL')return 'Auto Leveller';
  if(key==='LL')return 'Left Lift';
  if(key==='RL')return 'Right Lift';
  const def=MACHINE_DEFS[activeMachine]||MACHINE_DEFS[1];
  return (def.motorNames&&def.motorNames[key.toLowerCase()])||key;
}
function syncModal(){
  if(!modalChart)return;
  const h=(modalKey==='AL')?machineState[activeMachine].fullHistory.AL:machineState[activeMachine].fullHistory[modalKey];
  if(modalType==='rpm'){modalChart.data.labels=h.labels;modalChart.data.datasets[0].data=h.tRPM;modalChart.data.datasets[1].data=h.pRPM;}
  else if(modalType==='curr'){modalChart.data.labels=h.labels;modalChart.data.datasets[0].data=h.curr;}
  else if(modalType==='temp'){modalChart.data.labels=h.labels;modalChart.data.datasets[0].data=h.fet;modalChart.data.datasets[1].data=h.mot;}
  else{modalChart.data.labels=h.labels;modalChart.data.datasets[0].data=h.scan;modalChart.data.datasets[1].data=h.coil;}
  modalChart.update('none');
}
function openModal(key,type){
  const modal=document.getElementById('chart-modal');
  modal.classList.add('open');
  if(modalChart){modalChart.destroy();modalChart=null;}
  if(modalInterval){clearInterval(modalInterval);modalInterval=null;}
  modalKey=key;modalType=type;
  const h=(key==='AL')?machineState[activeMachine].fullHistory.AL:machineState[activeMachine].fullHistory[key];
  const name=motorLabel(key);
  const G='rgba(221,227,234,0.8)';
  const zC={zoom:{wheel:{enabled:true},pinch:{enabled:true},mode:'xy'},pan:{enabled:true,mode:'xy'}};
  let title,datasets,yCfg;
  if(type==='rpm'){
    const cols=({FR:['#2471a3','#7dba3a'],BR:['#7c3aed','#2471a3'],CR:['#c0392b','#d97706']}[key])||['#2471a3','#7dba3a'];
    title=`${name} — Target vs Present RPM (${h.labels.length} pts)`;
    datasets=[{label:'Target RPM',data:h.tRPM,borderColor:cols[0],borderWidth:2,pointRadius:0,tension:0.3},{label:'Present RPM',data:h.pRPM,borderColor:cols[1],borderWidth:2,pointRadius:0,tension:0.3,borderDash:[5,3]}];
    yCfg={min:0,max:MAX_RPM,ticks:{color:cols[0],stepSize:100},title:{display:true,text:'RPM',color:'#5d6b7a'}};
  }else if(type==='curr'){
    const col=({FR:'#d97706',BR:'#7dba3a',CR:'#7c3aed'}[key])||'#d97706';
    title=`${name} — Current A (${h.labels.length} pts)`;
    datasets=[{label:'Current A',data:h.curr,borderColor:col,borderWidth:2,pointRadius:0,tension:0.3,fill:true,backgroundColor:col+'18'}];
    yCfg={min:0,ticks:{color:col},title:{display:true,text:'Amps',color:'#5d6b7a'}};
  }else if(type==='temp'){
    title=`${name} — Temperature (${h.labels.length} pts)`;
    datasets=[{label:'MOSFET °C',data:h.fet,borderColor:'#f59e0b',borderWidth:2,pointRadius:0,tension:0.3},{label:'Motor °C',data:h.mot,borderColor:'#ef4444',borderWidth:2,pointRadius:0,tension:0.3}];
    yCfg={min:0,max:MAX_TEMP,ticks:{color:'#ef4444',stepSize:10},title:{display:true,text:'°C',color:'#5d6b7a'}};
  }else{
    title=`${name} Sensor (${h.labels.length} pts)`;
    datasets=[{label:'Scanning',data:h.scan,borderColor:'#7c3aed',borderWidth:2,pointRadius:0,tension:0.3},{label:'Coiler',data:h.coil,borderColor:'#ec4899',borderWidth:2,pointRadius:0,tension:0.3}];
    yCfg={ticks:{color:'#7c3aed'},title:{display:true,text:'ADC',color:'#5d6b7a'}};
  }
  document.getElementById('modal-title').textContent=title;
  modalChart=new Chart(document.getElementById('modal-canvas'),{type:'line',data:{labels:h.labels,datasets},
    options:{responsive:true,maintainAspectRatio:false,animation:false,
      plugins:{legend:{display:true,labels:{color:'#1a2733',font:{size:12}}},zoom:zC},
      scales:{x:{ticks:{color:'#5d6b7a',font:{size:11}},grid:{color:G},title:{display:true,text:'Time',color:'#5d6b7a'}},y:{grid:{color:G},...yCfg}}}});
  modalInterval=setInterval(()=>{
    const hh=(modalKey==='AL')?machineState[activeMachine].fullHistory.AL:machineState[activeMachine].fullHistory[modalKey];
    document.getElementById('modal-title').textContent=title.replace(/\(\d+ pts\)/,`(${hh.labels.length} pts)`);
    syncModal();
  },2000);
  modal.onclick=(e)=>{if(e.target===modal)closeModal();};
}
function closeModal(){
  document.getElementById('chart-modal').classList.remove('open');
  if(modalInterval){clearInterval(modalInterval);modalInterval=null;}
  if(modalChart){modalChart.destroy();modalChart=null;}
  modalKey=null;modalType=null;
}
function resetModalZoom(){if(modalChart)modalChart.resetZoom();}

// Clicking a motor's temperature gauges opens the temperature chart
document.querySelectorAll('#view-dash .motor-card .temp-pair').forEach(tp=>{
  const card=tp.closest('.motor-card'); if(!card)return;
  const id=card.id.replace('card-','');       // fr,br,cr,m4..m8,ll,rl
  if(id==='ll'||id==='rl')return;             // lifts have no temp history chart
  tp.style.cursor='pointer';
  tp.title='Click to view temperature chart';
  tp.addEventListener('click',()=>openModal(id.toUpperCase(),'temp'));
});
