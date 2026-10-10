// Onglet Historique : activité multi-outils, projets, modèles et coûts.
// Données : GET /api/history?days=30|90|365 (voir collector-history.js).

const TOOLS = [
  { key: 'claude', label: 'Claude Code' },
  { key: 'opencode', label: 'OpenCode' },
  { key: 'vibe', label: 'Mistral Vibe' },
];
const TOOL_LABEL = Object.fromEntries(TOOLS.map(t => [t.key, t.label]));
const WEEKDAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const REFRESH_MS = 60_000;

let root = null;
let rangeDays = 90;
let data = null;
let loadedAt = 0;
let loading = null;
const tips = []; // contenu HTML des infobulles, indexé par data-tip

function esc(s){
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtH(min){
  if (!min) return '0 h';
  return min < 60 ? `${min} min` : `${(min/60).toFixed(min < 600 ? 1 : 0).replace('.', ',')} h`;
}
function fmtCost(v){
  if (!v) return '0 $';
  return v >= 100 ? `${Math.round(v).toLocaleString('fr-FR')} $` : `${v.toFixed(2).replace('.', ',')} $`;
}
function fmtNum(n){
  if (n >= 1e9) return `${(n/1e9).toFixed(1)}G`;
  if (n >= 1e6) return `${(n/1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n/1e3).toFixed(1)}k`;
  return String(n);
}
function fmtDate(iso){
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m-1, d).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
}
function fmtAgo(ts){
  if (!ts) return '—';
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days <= 0) return "aujourd'hui";
  if (days === 1) return 'hier';
  return days < 60 ? `il y a ${days} j` : new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: '2-digit' });
}
function tip(html){
  tips.push(html);
  return `data-tip="${tips.length - 1}"`;
}

/** Seuils de la rampe séquentielle : quantiles des valeurs non nulles (4 seuils → 5 niveaux). */
function levelsFor(values){
  const v = values.filter(x => x > 0).sort((a, b) => a - b);
  if (!v.length) return () => 0;
  const q = [0.2, 0.4, 0.6, 0.8].map(p => v[Math.min(v.length - 1, Math.floor(p * v.length))]);
  return x => x <= 0 ? 0 : 1 + q.filter(t => x > t).length;
}

function toolBreakdown(m){
  return TOOLS.filter(t => m[t.key]).map(t =>
    `<div class="tip-row"><span class="swatch s-${t.key}"></span>${t.label}<b>${fmtH(m[t.key])}</b></div>`).join('');
}

// ---------------------------------------------------------------------------

function kpisHtml(){
  const t = data.totals;
  const byTool = TOOLS.filter(x => t.activeMinByTool[x.key]).map(x => `${x.label.split(' ')[0]} ${fmtH(t.activeMinByTool[x.key])}`).join(' · ');
  const tile = (label, value, sub, extra = '') => `<div class="kpi" ${extra}><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-sub">${sub}</div></div>`;
  return `<section class="kpis hist-kpis">
    ${tile('Temps actif', fmtH(t.activeMin), byTool || '—')}
    ${tile('Jours actifs', `${t.activeDays} / ${data.rangeDays}`, `moyenne ${fmtH(Math.round(t.activeMin / Math.max(1, t.activeDays)))} par jour actif`)}
    ${tile('Sessions', t.sessions, 'tous outils, hors arrière-plan')}
    ${tile('Prompts Claude', t.prompts.toLocaleString('fr-FR'), 'saisis dans Claude Code')}
    ${tile('Claude · équiv. API', fmtCost(t.apiCost), 'consommation au tarif API Anthropic', tip('Ce qu\'aurait coûté la consommation Claude Code facturée à l\'API (entrée, sortie, lecture et écriture du cache). Ce n\'est pas ce que tu paies avec un abonnement.'))}
    ${tile('OpenCode + Vibe', fmtCost(t.realCost), 'coût annoncé par les outils')}
  </section>`;
}

function calendarHtml(){
  const days = data.days;
  const level = levelsFor(days.map(d => d.minutes.all));
  // Colonnes = semaines commençant le lundi ; cases vides avant le premier jour
  const first = new Date(data.rangeStart);
  const offset = (first.getDay() + 6) % 7;
  const cells = [];
  for (let i = 0; i < offset; i++) cells.push('<div class="cal-cell pad"></div>');
  const monthLabels = [];
  days.forEach((d, i) => {
    const col = Math.floor((i + offset) / 7);
    const [, m, day] = d.date.split('-').map(Number);
    if (day === 1 || i === 0) monthLabels.push({ col, label: MONTHS[m - 1] });
    const lv = level(d.minutes.all);
    const body = d.minutes.all
      ? `<div class="tip-head">${fmtDate(d.date)} · ${fmtH(d.minutes.all)}</div>${toolBreakdown(d.minutes)}`
      : `<div class="tip-head">${fmtDate(d.date)}</div><div class="tip-muted">aucune activité</div>`;
    const extra = [d.prompts && `${d.prompts} prompts`, d.sessions && `${d.sessions} sessions`, d.apiCost >= 0.01 && `Claude ${fmtCost(d.apiCost)} équiv. API`].filter(Boolean).join(' · ');
    cells.push(`<div class="cal-cell l${lv}" ${tip(body + (extra ? `<div class="tip-muted">${extra}</div>` : ''))}></div>`);
  });
  const weeks = Math.ceil((days.length + offset) / 7);
  const months = monthLabels.filter((m, i, a) => i === 0 || m.col - a[i-1].col >= 3)
    .map(m => `<span style="grid-column:${m.col + 1}">${m.label}</span>`).join('');
  // Peu de semaines : cases plus grandes pour occuper la carte
  const cell = weeks <= 6 ? 26 : weeks <= 14 ? 20 : weeks <= 27 ? 16 : 13;
  return `<div class="viz-card cal-card" style="--cell:${cell}px">
    <div class="viz-head"><h3>Activité quotidienne</h3><span class="viz-sub">temps actif tous outils, par créneaux de 15 min</span></div>
    <div class="cal-scroll"><div class="cal">
      <div class="cal-months" style="grid-template-columns:repeat(${weeks}, var(--cell))">${months}</div>
      <div class="cal-days">${WEEKDAYS.map((w, i) => `<span>${i % 2 === 0 ? w : ''}</span>`).join('')}</div>
      <div class="cal-grid" style="grid-template-columns:repeat(${weeks}, var(--cell))">${cells.join('')}</div>
    </div></div>
    <div class="ramp-legend"><span>moins</span>${[0,1,2,3,4,5].map(l => `<i class="cal-cell l${l}"></i>`).join('')}<span>plus</span></div>
  </div>`;
}

/** Barres empilées par outil : par jour jusqu'à 90 jours, par semaine au-delà. */
function stackedHtml(){
  const weekly = data.rangeDays > 90;
  const buckets = [];
  data.days.forEach((d, i) => {
    const idx = weekly ? Math.floor(i / 7) : i;
    const b = buckets[idx] ||= { date: d.date, claude: 0, opencode: 0, vibe: 0 };
    for (const t of TOOLS) b[t.key] += d.minutes[t.key];
  });
  const max = Math.max(1, ...buckets.map(b => b.claude + b.opencode + b.vibe));
  const bars = buckets.map(b => {
    const total = b.claude + b.opencode + b.vibe;
    const segs = TOOLS.filter(t => b[t.key]).map(t =>
      `<div class="seg s-${t.key}" style="height:${(b[t.key] / max * 100).toFixed(2)}%"></div>`).join('');
    const head = weekly ? `Semaine du ${fmtDate(b.date)}` : fmtDate(b.date);
    return `<div class="bar" ${tip(`<div class="tip-head">${head} · ${fmtH(total)}</div>${toolBreakdown(b) || '<div class="tip-muted">aucune activité</div>'}`)}>${segs}</div>`;
  }).join('');
  const legend = TOOLS.map(t => `<span class="legend-item"><span class="swatch s-${t.key}"></span>${t.label}</span>`).join('');
  return `<div class="viz-card">
    <div class="viz-head"><h3>Temps actif par outil</h3><span class="viz-sub">${weekly ? 'par semaine' : 'par jour'}</span><div class="legend">${legend}</div></div>
    <div class="stack-chart">
      <div class="y-axis"><span>${fmtH(max)}</span><span>0</span></div>
      <div class="bars">${bars}</div>
    </div>
  </div>`;
}

function punchHtml(){
  const level = levelsFor(data.punch.flat());
  const rows = data.punch.map((hours, d) => `<span class="punch-day">${WEEKDAYS[d]}</span>` + hours.map((min, h) =>
    `<div class="cal-cell l${level(min)}" ${tip(`<div class="tip-head">${WEEKDAYS[d]} ${h}h–${h + 1}h</div><div>${fmtH(min)} cumulés sur la période</div>`)}></div>`).join('')).join('');
  const hours = Array.from({ length: 24 }, (_, h) => `<span>${h % 3 === 0 ? h + 'h' : ''}</span>`).join('');
  return `<div class="viz-card">
    <div class="viz-head"><h3>Quand tu travailles</h3><span class="viz-sub">temps actif cumulé par jour de semaine et heure</span></div>
    <div class="punch"><span></span>${hours}${rows}</div>
  </div>`;
}

/** Nom affiché : le dossier parent départage deux projets de même nom. */
function displayNames(projects){
  const count = {};
  for (const p of projects) count[p.name] = (count[p.name] || 0) + 1;
  return p => {
    if (count[p.name] < 2 || p.background) return p.name;
    const parts = p.cwd.split('/').filter(Boolean);
    return `${p.name} (${parts.slice(-2, -1)[0] || '/'})`;
  };
}

function projectsHtml(){
  const list = data.projects.slice(0, 20);
  const nameOf = displayNames(data.projects);
  const max = Math.max(1, ...list.map(p => p.activeMin));
  const rows = list.map(p => {
    const segs = TOOLS.filter(t => p.minutesByTool[t.key]).map(t =>
      `<div class="seg s-${t.key}" style="width:${(p.minutesByTool[t.key] / max * 100).toFixed(2)}%"></div>`).join('');
    const wmax = Math.max(1, ...p.weekly);
    const spark = p.weekly.map(m => `<i style="height:${m ? Math.max(8, m / wmax * 100) : 0}%"></i>`).join('');
    const sessions = TOOLS.filter(t => p.sessions[t.key]).map(t => `<span class="swatch s-${t.key}"></span>${p.sessions[t.key]}`).join(' ') || '—';
    return `<tr>
      <td class="proj-name" title="${esc(p.cwd)}">${esc(nameOf(p))}${p.background ? ' <span class="pill">arrière-plan</span>' : ''}</td>
      <td class="num">${fmtH(p.activeMin)}</td>
      <td class="bar-cell" ${tip(`<div class="tip-head">${esc(p.name)} · ${fmtH(p.activeMin)}</div>${toolBreakdown(p.minutesByTool)}`)}><div class="hbar">${segs}</div></td>
      <td class="spark-cell" ${tip(`<div class="tip-head">${esc(p.name)}</div><div>activité par semaine sur la période</div>`)}><div class="wspark">${spark}</div></td>
      <td class="sessions">${sessions}</td>
      <td class="num">${p.prompts || '—'}</td>
      <td class="num">${p.apiCost >= 0.01 ? fmtCost(p.apiCost) : '—'}</td>
      <td class="num">${p.realCost >= 0.01 ? fmtCost(p.realCost) : '—'}</td>
      <td class="muted">${fmtAgo(p.lastActivity)}</td>
    </tr>`;
  }).join('');
  return `<div class="viz-card">
    <div class="viz-head"><h3>Projets</h3><span class="viz-sub">${data.projects.length > 20 ? `20 premiers sur ${data.projects.length}, ` : ''}par temps actif</span></div>
    <div class="table-scroll"><table class="hist-table">
      <thead><tr><th>Projet</th><th class="num">Actif</th><th>Répartition</th><th>Semaines</th><th>Sessions</th><th class="num">Prompts</th><th class="num">Claude équiv. API</th><th class="num">Coût annoncé</th><th>Dernière activité</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

function modelsHtml(){
  const list = data.models.filter(m => m.cost >= 0.01 || m.tokens[1] > 0);
  const max = Math.max(0.01, ...list.map(m => m.cost));
  const rows = list.map(m => `<tr>
      <td><span class="swatch s-${m.tool}"></span>${TOOL_LABEL[m.tool]}</td>
      <td class="mono">${esc(m.model)}</td>
      <td class="num">${m.tool === 'claude' ? `${m.responses.toLocaleString('fr-FR')} rép.` : `${m.sessions} sess.`}</td>
      <td class="num" ${tip(`<div class="tip-head">${esc(m.model)}</div><div class="tip-row">entrée<b>${fmtNum(m.tokens[0])}</b></div><div class="tip-row">sortie<b>${fmtNum(m.tokens[1])}</b></div><div class="tip-row">lecture cache<b>${fmtNum(m.tokens[2])}</b></div><div class="tip-row">écriture cache<b>${fmtNum(m.tokens[3] + m.tokens[4])}</b></div>`)}>${fmtNum(m.tokens[1])}</td>
      <td class="bar-cell"><div class="hbar"><div class="seg s-${m.tool}" style="width:${(m.cost / max * 100).toFixed(2)}%"></div></div></td>
      <td class="num">${fmtCost(m.cost)}</td>
      <td class="muted">${m.costKind === 'api' ? 'équiv. API' : 'annoncé'}</td>
    </tr>`).join('');
  return `<div class="viz-card">
    <div class="viz-head"><h3>Modèles</h3><span class="viz-sub">tokens de sortie et coût sur la période</span></div>
    <div class="table-scroll"><table class="hist-table">
      <thead><tr><th>Outil</th><th>Modèle</th><th class="num">Volume</th><th class="num">Sortie</th><th>Coût</th><th class="num"></th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

function render(){
  tips.length = 0;
  const unavailable = Object.entries(data.sources).filter(([, v]) => v !== true).map(([k, v]) => `${TOOL_LABEL[k]} indisponible${typeof v === 'string' ? ` (${esc(v)})` : ''}`);
  root.querySelector('.hist-body').innerHTML = `
    ${kpisHtml()}
    <p class="hist-note">Claude Code supprime ses transcripts au-delà de <code>cleanupPeriodDays</code> (30 jours par défaut) : au-delà, seuls les prompts restent connus, via <code>history.jsonl</code>.${unavailable.length ? ` ${unavailable.join(' · ')}.` : ''}</p>
    <div class="viz-row cal-row ${data.rangeDays > 180 ? 'stacked' : ''}">${calendarHtml()}${stackedHtml()}</div>
    <div class="viz-row">${punchHtml()}${modelsHtml()}</div>
    ${projectsHtml()}`;
  root.querySelector('.hist-meta').textContent =
    `${data.index.transcripts} transcripts indexés · calculé en ${data.buildMs} ms · ${new Date(data.generatedAt).toLocaleTimeString('fr-FR')}`;
}

async function load(force){
  if (loading) return loading;
  if (!force && data && data.rangeDays === rangeDays && Date.now() - loadedAt < REFRESH_MS) return;
  const meta = root.querySelector('.hist-meta');
  if (!data || data.rangeDays !== rangeDays) meta.textContent = 'Indexation de l\'historique… (quelques secondes la première fois)';
  loading = fetch(`/api/history?days=${rangeDays}`)
    .then(r => r.json())
    .then(d => {
      if (d.error) throw new Error(d.error);
      data = d; loadedAt = Date.now();
      render();
    })
    .catch(e => { meta.textContent = `erreur : ${e.message}`; })
    .finally(() => { loading = null; });
  return loading;
}

// Infobulle unique, positionnée près du pointeur
function bindTooltip(){
  const el = document.createElement('div');
  el.className = 'viz-tip';
  el.setAttribute('role', 'tooltip');
  document.body.appendChild(el);
  root.addEventListener('mouseover', e => {
    const t = e.target.closest('[data-tip]');
    if (!t || !root.contains(t)) { el.style.display = 'none'; return; }
    el.innerHTML = tips[Number(t.dataset.tip)] || '';
    el.style.display = 'block';
  });
  root.addEventListener('mousemove', e => {
    if (el.style.display !== 'block') return;
    const pad = 14, w = el.offsetWidth, h = el.offsetHeight;
    const x = e.clientX + pad + w > window.innerWidth ? e.clientX - pad - w : e.clientX + pad;
    const y = e.clientY + pad + h > window.innerHeight ? e.clientY - pad - h : e.clientY + pad;
    el.style.left = `${Math.max(4, x)}px`;
    el.style.top = `${Math.max(4, y)}px`;
  });
  root.addEventListener('mouseleave', () => { el.style.display = 'none'; });
}

export function initHistory(el){
  root = el;
  root.innerHTML = `
    <div class="hist-toolbar">
      <div class="seg-ctrl" role="group" aria-label="Période">
        ${[[30, '30 j'], [90, '90 j'], [365, '1 an']].map(([d, l]) => `<button data-days="${d}" class="${d === rangeDays ? 'active' : ''}">${l}</button>`).join('')}
      </div>
      <span class="hist-meta">—</span>
    </div>
    <div class="hist-body"></div>`;
  root.querySelector('.seg-ctrl').addEventListener('click', e => {
    const b = e.target.closest('button[data-days]');
    if (!b) return;
    rangeDays = Number(b.dataset.days);
    root.querySelectorAll('.seg-ctrl button').forEach(x => x.classList.toggle('active', x === b));
    load(true);
  });
  bindTooltip();
}

export function refreshHistory(force = false){
  return load(force);
}
