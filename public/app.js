const grid = document.getElementById('grid');
const gridOc = document.getElementById('grid-opencode');
const gridVibe = document.getElementById('grid-vibe');
const empty = document.getElementById('empty');
const emptyText = document.getElementById('emptyText');
const emptySub = document.getElementById('emptySub');
const aliveBadge = document.getElementById('aliveBadge');
const generatedAt = document.getElementById('generatedAt');
// Claude KPIs
const kpiAlive = document.getElementById('kpiAlive');
const kpiAliveSub = document.getElementById('kpiAliveSub');
const kpiBusy = document.getElementById('kpiBusy');
const kpiBusySub = document.getElementById('kpiBusySub');
const kpiProjects = document.getElementById('kpiProjects');
const kpiProjectsSub = document.getElementById('kpiProjectsSub');
const kpiTokens = document.getElementById('kpiTokens');
const kpiTokensSub = document.getElementById('kpiTokensSub');
// OpenCode KPIs
const kpiOcCount = document.getElementById('kpiOcCount');
const kpiOcCountSub = document.getElementById('kpiOcCountSub');
const kpiOcLive = document.getElementById('kpiOcLive');
const kpiOcLiveSub = document.getElementById('kpiOcLiveSub');
const kpiOcCost = document.getElementById('kpiOcCost');
const kpiOcCostSub = document.getElementById('kpiOcCostSub');
const kpiOcTokens = document.getElementById('kpiOcTokens');
const kpiOcTokensSub = document.getElementById('kpiOcTokensSub');
// Vibe KPIs
const kpiVibeCount = document.getElementById('kpiVibeCount');
const kpiVibeCountSub = document.getElementById('kpiVibeCountSub');
const kpiVibeLive = document.getElementById('kpiVibeLive');
const kpiVibeLiveSub = document.getElementById('kpiVibeLiveSub');
const kpiVibeCost = document.getElementById('kpiVibeCost');
const kpiVibeCostSub = document.getElementById('kpiVibeCostSub');
const kpiVibeTokens = document.getElementById('kpiVibeTokens');
const kpiVibeTokensSub = document.getElementById('kpiVibeTokensSub');
const kpisClaude = document.getElementById('kpis-claude');
const kpisOc = document.getElementById('kpis-opencode');
const kpisVibe = document.getElementById('kpis-vibe');
const tabClaudeCount = document.getElementById('tabClaudeCount');
const tabOcCount = document.getElementById('tabOpencodeCount');
const tabVibeCount = document.getElementById('tabVibeCount');

const recentCount = document.getElementById('recentCount');
const filterInput = document.getElementById('filterInput');
const hint = document.getElementById('hint');
const refreshSelect = document.getElementById('refreshSelect');
const refreshBtn = document.getElementById('refreshBtn');
const hideObserver = document.getElementById('hideObserver');
const hideObserverLabel = document.getElementById('hideObserverLabel');
const opencodeLimit = document.getElementById('opencodeLimit');

let lastClaude = null;
let lastOc = null;
let lastVibe = null;
let activeTab = 'claude';
let timer = null;

function fmtMs(ms){
  if (ms==null) return '—';
  if (ms < 60000) return Math.round(ms/1000) + 's';
  if (ms < 3600000) return Math.round(ms/60000) + 'min';
  const h = Math.floor(ms/3600000);
  const m = Math.round((ms%3600000)/60000);
  return h+'h'+(m? ' '+m+'min':'');
}
function fmtNum(n){
  if (n==null) return '—';
  if (n>=1e6) return (n/1e6).toFixed(1)+'M';
  if (n>=1e3) return (n/1e3).toFixed(1)+'k';
  return String(n);
}
function fmtCost(c){
  if (c==null) return '—';
  return '$' + c.toFixed(2);
}
function isObserver(s){
  return (s.cwd||'').includes('.claude-mem/observer-sessions') || s.projectName === 'observer-sessions';
}

// --- Tabs ---
document.querySelectorAll('.tab').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    activeTab = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active', b===btn));
    syncTabVisibility();
    renderActive();
  });
});
function syncTabVisibility(){
  kpisClaude.style.display = activeTab==='claude' ? 'grid' : 'none';
  kpisOc.style.display = activeTab==='opencode' ? 'grid' : 'none';
  kpisVibe.style.display = activeTab==='vibe' ? 'grid' : 'none';
  grid.style.display = activeTab==='claude' ? 'grid' : 'none';
  gridOc.style.display = activeTab==='opencode' ? 'grid' : 'none';
  gridVibe.style.display = activeTab==='vibe' ? 'grid' : 'none';
  hideObserverLabel.style.display = activeTab==='claude' ? '' : 'none';
  opencodeLimit.style.display = (activeTab==='opencode' || activeTab==='vibe') ? '' : 'none';
  if (activeTab==='claude') filterInput.placeholder = 'Filtrer par projet, cwd, modèle, outil…';
  else if (activeTab==='opencode') filterInput.placeholder = 'Filtrer par projet, titre, modèle, agent…';
  else filterInput.placeholder = 'Filtrer par projet, titre, branche…';
}

// --- Claude render (inchangé, KPIs visibles hors observer) ---
function renderClaude(data){
  lastClaude = data;
  const sessions = data.sessions || [];
  const q = (filterInput.value||'').toLowerCase().trim();
  const hideObs = hideObserver.checked;
  let filtered = sessions.filter(s => !(hideObs && isObserver(s)));
  const hiddenCount = sessions.length - filtered.length;
  if (q && activeTab==='claude'){
    filtered = filtered.filter(s =>
      (s.cwd||'').toLowerCase().includes(q) ||
      (s.projectName||'').toLowerCase().includes(q) ||
      (s.model||'').toLowerCase().includes(q) ||
      (s.lastToolName||'').toLowerCase().includes(q) ||
      (s.name||'').toLowerCase().includes(q) ||
      (s.bridgeSessionId && 'remote control'.includes(q)) ||
      String(s.pid).includes(q)
    );
  }
  const visibleAll = sessions.filter(s => !(hideObs && isObserver(s)));
  const badgeExtra = hiddenCount ? ` · ${hiddenCount} observer masquée${hiddenCount!==1?'s':''}` : '';
  const filterExtra = filtered.length!==visibleAll.length ? ` · ${filtered.length} filtrée${filtered.length!==1?'s':''}` : '';
  // On met à jour le badge seulement si onglet Claude actif, sinon on garde mais on update le compteur tab
  if (activeTab==='claude'){
    aliveBadge.textContent = `${visibleAll.length} visible${badgeExtra}${filterExtra} · ${data.aliveCount} totales`;
    generatedAt.textContent = new Date(data.generatedAt).toLocaleTimeString();
    recentCount.textContent = `${data.recentJsonlCount24h} jsonl <24h`;
    hint.textContent = `${filtered.length}/${visibleAll.length} visibles (${sessions.length} totales)`;
  }
  tabClaudeCount.textContent = visibleAll.length;

  kpiAlive.textContent = visibleAll.length;
  kpiAliveSub.textContent = `${filtered.length} affichée${filtered.length!==1?'s':''}${hiddenCount?` · ${hiddenCount} masquée${hiddenCount!==1?'s':''}`:''} · maj ${new Date(data.generatedAt).toLocaleTimeString()}`;
  const busy = visibleAll.filter(s=>s.status==='busy').length;
  const idle = visibleAll.length - busy;
  kpiBusy.textContent = `${busy} busy · ${idle} idle`;
  kpiBusySub.textContent = busy? 'au moins une session en travail':'toutes en attente';
  const projects = new Set(visibleAll.map(s=>s.cwd)).size;
  kpiProjects.textContent = projects;
  kpiProjectsSub.textContent = [...new Set(visibleAll.map(s=>s.projectName))].slice(0,3).join(', ') || '—';
  const totalIn = visibleAll.reduce((a,s)=>a+(s.tokens?.input||0),0);
  const totalOut = visibleAll.reduce((a,s)=>a+(s.tokens?.output||0),0);
  kpiTokens.textContent = `${fmtNum(totalIn)} / ${fmtNum(totalOut)}`;
  const tailWarn = visibleAll.some(s=>s.tokensTailSampled) ? ' · tail 300KB' : '';
  kpiTokensSub.textContent = `input / output${tailWarn}`;

  if (activeTab!=='claude') return; // ne pas toucher la grille si autre onglet
  if (filtered.length===0){
    grid.style.display='none';
    empty.style.display='block';
    emptyText.textContent = sessions.length===0 ? 'Aucune session Claude Code active détectée.' : `Aucun résultat pour « ${q} ».`;
    emptySub.innerHTML = 'Lance <code>claude</code> dans un terminal, la tour s\'actualise automatiquement.';
    return;
  }
  empty.style.display='none';
  grid.style.display='grid';
  grid.innerHTML = filtered.map(s => cardHtmlClaude(s)).join('');
}

// Petits personnages du fil de discussion : un humain (user) et un robot (IA).
const AVATAR_HUMAN = `<svg viewBox="0 0 32 32" aria-hidden="true">
  <circle cx="16" cy="16" r="15" class="av-bg"/>
  <path d="M5.5 27.5c1.8-5 5.6-7.5 10.5-7.5s8.7 2.5 10.5 7.5A15 15 0 0 1 5.5 27.5z" class="av-body"/>
  <circle cx="16" cy="13" r="6.2" class="av-skin"/>
  <path d="M9.6 12.4c.2-4 3-6.4 6.4-6.4s6.3 2.3 6.4 6.3c-1.6-.2-3.9-1.3-5-3-1.6 1.9-4.6 3-7.8 3.1z" class="av-hair"/>
  <circle cx="13.7" cy="13.6" r=".9" class="av-ink"/><circle cx="18.3" cy="13.6" r=".9" class="av-ink"/>
  <path d="M13.9 16.3c1.2 1 3 1 4.2 0" class="av-smile"/>
</svg>`;
const AVATAR_AI = `<svg viewBox="0 0 32 32" aria-hidden="true">
  <circle cx="16" cy="16" r="15" class="av-bg"/>
  <line x1="16" y1="4.5" x2="16" y2="8" class="av-antenna"/><circle cx="16" cy="4.3" r="1.6" class="av-led"/>
  <rect x="7.5" y="8" width="17" height="13" rx="4" class="av-head"/>
  <rect x="5.4" y="12.5" width="2.1" height="4.5" rx="1" class="av-head"/><rect x="24.5" y="12.5" width="2.1" height="4.5" rx="1" class="av-head"/>
  <rect x="10" y="11" width="12" height="7" rx="2.5" class="av-visor"/>
  <circle cx="13.4" cy="14.5" r="1.5" class="av-eye"/><circle cx="18.6" cy="14.5" r="1.5" class="av-eye"/>
  <path d="M9.5 29.5c.8-3.9 3.3-6 6.5-6s5.7 2.1 6.5 6" class="av-head"/>
</svg>`;

function bubbleHtml(role, text){
  const human = role==='human';
  return `
    <div class="msg ${human?'msg-human':'msg-ai'}">
      <div class="avatar" title="${human?'Humain':'IA'}">${human?AVATAR_HUMAN:AVATAR_AI}</div>
      <div class="bubble"><span class="who">${human?'Humain':'IA'}</span><span class="bubble-text">${esc(text)}</span></div>
    </div>`;
}

function chatHtml(humanText, aiText, busy){
  if (!humanText && !aiText) return `<div class="preview empty">pas encore de messages texte (outils/thinking uniquement)</div>`;
  return `<div class="chat ${busy?'thinking':''}">
    ${humanText ? bubbleHtml('human', humanText) : ''}
    ${aiText ? bubbleHtml('ai', aiText) : ''}
  </div>`;
}

function cardHtmlClaude(s){
  const busy = s.status==='busy';
  const age = fmtMs(s.ageMs);
  const idle = fmtMs(s.idleMs);
  const tokens = s.tokens ? `${fmtNum(s.tokens.input)} in · ${fmtNum(s.tokens.output)} out${s.tokens.cacheRead?` · cache ${fmtNum(s.tokens.cacheRead)}`:''}${s.tokensTailSampled?' · tail':''}` : '—';
  const rss = s.proc?.rssKb ? Math.round(s.proc.rssKb/1024)+' MB' : '—';
  const branch = s.gitBranch ? `<span class="pill">⎇ ${esc(s.gitBranch)}</span>` : '';
  const modelShort = s.model ? s.model.replace('claude-','').slice(0,22) : '—';
  return `
  <div class="card ${busy?'busy':''}">
    <div class="card-head">
      <div class="card-title"><span class="dot"></span> ${esc(s.projectName)} <span class="pill accent">${esc(modelShort)}</span> ${branch}</div>
      <span class="pill ${busy?'busy':''}">${esc(s.status)}</span>
    </div>
    <div class="card-meta">
      ${s.bridgeSessionId ? `<span class="pill remote" title="Remote Control actif — pilotable depuis claude.ai ou l'app mobile&#10;${esc(s.bridgeSessionId)}">📡 remote control</span>` : ''}
      <span class="pill">pid ${s.pid}</span>
      <span class="pill">${esc(s.name)}</span>
      <span class="pill">${esc(s.version||'')}</span>
      <span class="pill">RSS ${rss}</span>
    </div>
    <div class="cwd">${esc(s.cwd||'—')}</div>
    <div class="stats">
      <div class="stat"><div class="stat-label">Âge</div><div class="stat-value">${age}</div></div>
      <div class="stat"><div class="stat-label">Idle depuis</div><div class="stat-value">${idle}</div></div>
      <div class="stat"><div class="stat-label">Msgs</div><div class="stat-value">${s.counts?`${s.counts.user} ⇄ ${s.counts.assistant}`:'—'}</div></div>
      <div class="stat"><div class="stat-label">Tools</div><div class="stat-value">${s.counts? s.counts.toolUse : '—'}${s.lastToolName?` · ${esc(s.lastToolName.slice(0,18))}`:''}</div></div>
    </div>
    <div class="stats">
      <div class="stat" style="flex:2"><div class="stat-label">Tokens ${s.tokensTailSampled?'(tail)':''}</div><div class="stat-value" style="font-size:12px">${esc(tokens)}</div></div>
      <div class="stat"><div class="stat-label">JSONL</div><div class="stat-value" style="font-size:12px">${s.jsonl? Math.round(s.jsonl.size/1024)+' KB':'—'}</div></div>
    </div>
    ${chatHtml(s.lastHumanText, s.lastAssistantText, busy)}
    <div class="card-foot">
      <span>id ${esc(s.sessionId.slice(0,8))} · ${new Date(s.startedAt).toLocaleString()}</span>
      <span>${esc(s.entrypoint||'')} · ${esc(s.kind||'')}</span>
    </div>
  </div>`;
}

// --- OpenCode render : même cards, données DB ---
function renderOc(data){
  lastOc = data;
  const sessions = data.sessions || [];
  const q = (filterInput.value||'').toLowerCase().trim();
  let filtered = sessions;
  if (q && activeTab==='opencode'){
    filtered = sessions.filter(s =>
      (s.directory||'').toLowerCase().includes(q) ||
      (s.title||'').toLowerCase().includes(q) ||
      (s.projectName||'').toLowerCase().includes(q) ||
      (s.model?.id||'').toLowerCase().includes(q) ||
      (s.agent||'').toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q)
    );
  }
  tabOcCount.textContent = sessions.length;
  if (activeTab==='opencode'){
    aliveBadge.textContent = `${filtered.length} visible` + (q ? ` · filtre « ${q} »` : '') + ` · ${data.totalCount} totales`;
    generatedAt.textContent = new Date(data.generatedAt).toLocaleTimeString();
    recentCount.textContent = `${data.totalCount} sessions au total`;
    hint.textContent = `${filtered.length}/${sessions.length} affichées`;
  }
  // KPIs OC (toujours MAJ)
  kpiOcCount.textContent = data.returnedCount;
  kpiOcCountSub.textContent = `${data.totalCount} totales · limite ${opencodeLimit.value}`;
  const busy = sessions.filter(s=>s.status==='busy').length;
  const archived = sessions.filter(s=>s.isArchived).length;
  kpiOcLive.textContent = `${busy} busy · ${archived} arch.`;
  kpiOcLiveSub.textContent = `${sessions.length - busy - archived} idle récentes`;
  kpiOcCost.textContent = fmtCost(data.totalCost);
  kpiOcCostSub.textContent = `sur ${sessions.length} affichées`;
  kpiOcTokens.textContent = `${fmtNum(data.totalTokens.input)} / ${fmtNum(data.totalTokens.output)}`;
  kpiOcTokensSub.textContent = `input / output`;

  if (activeTab!=='opencode') return;
  if (filtered.length===0){
    gridOc.style.display='none';
    empty.style.display='block';
    emptyText.textContent = sessions.length===0 ? 'Aucune session OpenCode.' : `Aucun résultat pour « ${q} ».`;
    emptySub.innerHTML = 'Source : <code>~/.local/share/opencode/opencode.db</code> via <code>opencode db</code>';
    return;
  }
  empty.style.display='none';
  gridOc.style.display='grid';
  gridOc.innerHTML = filtered.map(s => cardHtmlOc(s)).join('');
}

function cardHtmlOc(s){
  const busy = s.status==='busy';
  const archived = s.isArchived;
  const cls = archived ? '' : (busy ? 'busy' : '');
  const age = fmtMs(s.ageMs);
  const idle = fmtMs(s.idleMs);
  const cost = fmtCost(s.cost);
  const tokens = `${fmtNum(s.tokens.input)} in · ${fmtNum(s.tokens.output)} out${s.tokens.reasoning?` · reasoning ${fmtNum(s.tokens.reasoning)}`:''}${s.tokens.cacheRead?` · cache ${fmtNum(s.tokens.cacheRead)}`:''}`;
  const modelShort = s.model ? s.model.id.replace('muse-','').slice(0,22) : '—';
  const statusPill = archived ? 'archived' : (s.isLive ? `busy · pid ${s.livePid}` : s.status);
  return `
  <div class="card ${cls}">
    <div class="card-head">
      <div class="card-title"><span class="dot"></span> ${esc(s.projectName)} <span class="pill accent">${esc(modelShort)}</span> ${s.agent?`<span class="pill">${esc(s.agent)}</span>`:''}</div>
      <span class="pill ${busy?'busy':''}">${esc(statusPill)}</span>
    </div>
    <div class="card-meta">
      <span class="pill">${esc(s.shortId)}</span>
      <span class="pill">${esc(s.version||'')}</span>
      <span class="pill">${cost}</span>
    </div>
    <div class="cwd" title="${esc(s.directory)}">${esc(s.directory||'—')}</div>
    <div class="preview"><strong>${esc(s.title||'Sans titre')}</strong></div>
    <div class="stats">
      <div class="stat"><div class="stat-label">Âge</div><div class="stat-value">${age}</div></div>
      <div class="stat"><div class="stat-label">Maj il y a</div><div class="stat-value">${idle}</div></div>
      <div class="stat"><div class="stat-label">Coût</div><div class="stat-value">${cost}</div></div>
      <div class="stat"><div class="stat-label">Agent</div><div class="stat-value" style="font-size:12px">${esc(s.agent||'—')}</div></div>
    </div>
    <div class="stats">
      <div class="stat" style="flex:2"><div class="stat-label">Tokens</div><div class="stat-value" style="font-size:11px">${esc(tokens)}</div></div>
      <div class="stat"><div class="stat-label">Créée</div><div class="stat-value" style="font-size:11px">${new Date(s.timeCreated).toLocaleDateString()}</div></div>
    </div>
    <div class="card-foot">
      <span>id ${esc(s.shortId)} · ${new Date(s.timeUpdated).toLocaleString()}</span>
      <span>${esc(s.worktree||'')}</span>
    </div>
  </div>`;
}

// --- Vibe render : même cards ---
function renderVibe(data){
  lastVibe = data;
  const sessions = data.sessions || [];
  const q = (filterInput.value||'').toLowerCase().trim();
  let filtered = sessions;
  if (q && activeTab==='vibe'){
    filtered = sessions.filter(s =>
      (s.directory||'').toLowerCase().includes(q) ||
      (s.title||'').toLowerCase().includes(q) ||
      (s.projectName||'').toLowerCase().includes(q) ||
      (s.gitBranch||'').toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q)
    );
  }
  tabVibeCount.textContent = sessions.length;
  if (activeTab==='vibe'){
    aliveBadge.textContent = `${filtered.length} visible` + (q ? ` · filtre « ${q} »` : '') + ` · ${data.totalCount} totales`;
    generatedAt.textContent = new Date(data.generatedAt).toLocaleTimeString();
    recentCount.textContent = `modèle actif: ${data.activeModel}`;
    hint.textContent = `${filtered.length}/${sessions.length} affichées`;
  }
  kpiVibeCount.textContent = data.returnedCount;
  kpiVibeCountSub.textContent = `${data.totalCount} totales · limite ${opencodeLimit.value}`;
  const busy = sessions.filter(s=>s.status==='busy').length;
  kpiVibeLive.textContent = `${busy} busy`;
  kpiVibeLiveSub.textContent = busy? 'au moins une session en travail' : 'aucune active';
  kpiVibeCost.textContent = fmtCost(data.totalCost);
  kpiVibeCostSub.textContent = `sur ${sessions.length} affichées`;
  kpiVibeTokens.textContent = `${fmtNum(data.totalTokens.input)} / ${fmtNum(data.totalTokens.output)}`;
  kpiVibeTokensSub.textContent = `input / output`;

  if (activeTab!=='vibe') return;
  if (filtered.length===0){
    gridVibe.style.display='none';
    empty.style.display='block';
    emptyText.textContent = sessions.length===0 ? 'Aucune session Vibe.' : `Aucun résultat pour « ${q} ».`;
    emptySub.innerHTML = 'Source : <code>~/.vibe/logs/session/**/meta.json</code>';
    return;
  }
  empty.style.display='none';
  gridVibe.style.display='grid';
  gridVibe.innerHTML = filtered.map(s => cardHtmlVibe(s)).join('');
}
function cardHtmlVibe(s){
  const busy = s.status==='busy';
  const cls = busy ? 'busy' : '';
  const age = fmtMs(s.ageMs);
  const idle = fmtMs(s.idleMs);
  const cost = fmtCost(s.cost);
  const tokens = `${fmtNum(s.tokens.input)} in · ${fmtNum(s.tokens.output)} out${s.tokens.total?` · total ${fmtNum(s.tokens.total)}`:''}`;
  const branch = s.gitBranch ? `<span class="pill">⎇ ${esc(s.gitBranch)}</span>` : '';
  const statusPill = s.isLive ? `busy · pid ${s.livePid}` : s.status;
  return `
  <div class="card ${cls}">
    <div class="card-head">
      <div class="card-title"><span class="dot"></span> ${esc(s.projectName)} <span class="pill accent">${esc(s.modelShort)}</span> ${branch}</div>
      <span class="pill ${busy?'busy':''}">${esc(statusPill)}</span>
    </div>
    <div class="card-meta">
      <span class="pill">${esc(s.shortId)}</span>
      <span class="pill">${s.steps} steps</span>
      <span class="pill">${s.totalMessages} msgs</span>
      <span class="pill">${cost}</span>
    </div>
    <div class="cwd" title="${esc(s.directory)}">${esc(s.directory||'—')}</div>
    <div class="preview"><strong>${esc(s.title||'Sans titre')}</strong></div>
    <div class="stats">
      <div class="stat"><div class="stat-label">Âge</div><div class="stat-value">${age}</div></div>
      <div class="stat"><div class="stat-label">Fin il y a</div><div class="stat-value">${idle}</div></div>
      <div class="stat"><div class="stat-label">Outils</div><div class="stat-value">${s.toolCalls.succeeded}/${s.toolCalls.agreed}</div></div>
      <div class="stat"><div class="stat-label">t/s</div><div class="stat-value" style="font-size:12px">${s.tokensPerSecond? s.tokensPerSecond.toFixed(1):'—'}</div></div>
    </div>
    <div class="stats">
      <div class="stat" style="flex:2"><div class="stat-label">Tokens</div><div class="stat-value" style="font-size:11px">${esc(tokens)}</div></div>
      <div class="stat"><div class="stat-label">Début</div><div class="stat-value" style="font-size:11px">${s.startTime? new Date(s.startTime).toLocaleDateString(): '—'}</div></div>
    </div>
    <div class="card-foot">
      <span>id ${esc(s.shortId)} · ${s.endTime? new Date(s.endTime).toLocaleString(): (s.startTime? new Date(s.startTime).toLocaleString():'—')}</span>
      <span>${esc(s.gitBranch||'')}</span>
    </div>
  </div>`;
}

function esc(s){
  if (s==null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderActive(){
  if (activeTab==='claude' && lastClaude) renderClaude(lastClaude);
  if (activeTab==='opencode' && lastOc) renderOc(lastOc);
  if (activeTab==='vibe' && lastVibe) renderVibe(lastVibe);
  if (activeTab==='claude' && !lastClaude) { gridOc.style.display='none'; gridVibe.style.display='none'; empty.style.display='none'; }
  if (activeTab==='opencode' && !lastOc) { grid.style.display='none'; gridVibe.style.display='none'; }
  if (activeTab==='vibe' && !lastVibe) { grid.style.display='none'; gridOc.style.display='none'; }
}

async function fetchAndRender(){
  try{
    refreshBtn.textContent = '…';
    if (activeTab==='claude'){
      const r = await fetch('/api/sessions');
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      renderClaude(data);
      fetch('/api/opencode-sessions?limit='+opencodeLimit.value).then(x=>x.json()).then(d=>{ if(!d.error) renderOc(d); }).catch(()=>{});
      fetch('/api/vibe-sessions?limit='+opencodeLimit.value).then(x=>x.json()).then(d=>{ if(!d.error) renderVibe(d); }).catch(()=>{});
    } else if (activeTab==='opencode'){
      const r = await fetch('/api/opencode-sessions?limit='+opencodeLimit.value);
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      renderOc(data);
      fetch('/api/sessions').then(x=>x.json()).then(d=>{ if(!d.error) renderClaude(d); }).catch(()=>{});
      fetch('/api/vibe-sessions?limit='+opencodeLimit.value).then(x=>x.json()).then(d=>{ if(!d.error) renderVibe(d); }).catch(()=>{});
    } else {
      const r = await fetch('/api/vibe-sessions?limit='+opencodeLimit.value);
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      renderVibe(data);
      fetch('/api/sessions').then(x=>x.json()).then(d=>{ if(!d.error) renderClaude(d); }).catch(()=>{});
      fetch('/api/opencode-sessions?limit='+opencodeLimit.value).then(x=>x.json()).then(d=>{ if(!d.error) renderOc(d); }).catch(()=>{});
    }
  }catch(e){
    hint.textContent = 'erreur: '+e.message;
  }finally{
    refreshBtn.textContent = '↻ Refresh';
  }
}

function schedule(){
  if (timer) clearInterval(timer);
  const ms = parseInt(refreshSelect.value,10);
  if (ms>0) timer = setInterval(fetchAndRender, ms);
}

refreshBtn.addEventListener('click', fetchAndRender);
filterInput.addEventListener('input', ()=> renderActive());
hideObserver.addEventListener('change', ()=> lastClaude && renderClaude(lastClaude));
opencodeLimit.addEventListener('change', ()=> fetchAndRender());
refreshSelect.addEventListener('change', schedule);

fetchAndRender();
schedule();
