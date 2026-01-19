// Library Search (client-only)
// - Loads books.json (generated from CSV)
// - Searches locally
// - Fetches cover + description from Open Library on demand (cached in localStorage)

const els = {
  q: document.getElementById('q'),
  grid: document.getElementById('grid'),
  count: document.getElementById('count'),
  clearBtn: document.getElementById('clearBtn'),
  sectionFilter: document.getElementById('sectionFilter'),
  modal: document.getElementById('modal'),
  closeModal: document.getElementById('closeModal'),
  mTitle: document.getElementById('mTitle'),
  mBy: document.getElementById('mBy'),
  mCover: document.getElementById('mCover'),
  mDesc: document.getElementById('mDesc'),
  mCatalog: document.getElementById('mCatalog'),
  mPills: document.getElementById('mPills'),
};

let books = [];
let filtered = [];
let coverCache = new Map(); // session cache

function norm(s){ return (s||'').toString().toLowerCase().trim(); }

function bookSearchText(b){
  return [
    b.title, b.subtitle, b.series,
    ...(b.authors||[]),
    b.publisher, b.section, b.location,
    b.isbn, b.subjects,
    ...(b.callNumbers||[])
  ].filter(Boolean).join(' • ').toLowerCase();
}

function uniq(arr){ return Array.from(new Set(arr.filter(Boolean))); }

function makeCard(b){
  const card = document.createElement('div');
  card.className = 'card';
  card.tabIndex = 0;

  const img = document.createElement('img');
  img.className = 'cover';
  img.alt = `Cover for ${b.title}`;
  img.loading = 'lazy';
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(placeholderSvg(b.title));

  const body = document.createElement('div');
  body.className = 'cardBody';

  const t = document.createElement('div');
  t.className = 'cardTitle';
  t.textContent = b.title;

  const by = document.createElement('div');
  by.className = 'cardBy';
  by.textContent = (b.authors && b.authors.length) ? b.authors.join(', ') : '';

  const badges = document.createElement('div');
  badges.className = 'badges';
  const badgeVals = uniq([b.section, b.location, b.callNumbers?.[0]]);
  badgeVals.slice(0,3).forEach(x=>{
    const s = document.createElement('span');
    s.className = 'badge';
    s.textContent = x;
    badges.appendChild(s);
  });

  body.appendChild(t);
  body.appendChild(by);
  body.appendChild(badges);

  card.appendChild(img);
  card.appendChild(body);

  // lazy fetch cover
  fetchCoverAndMaybeDesc(b).then(info=>{
    if(info?.coverUrl){
      img.src = info.coverUrl;
    }
  }).catch(()=>{});

  const open = () => openModal(b, img.src);
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e)=>{ if(e.key === 'Enter' || e.key === ' ') open(); });

  return card;
}

function render(){
  els.grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  filtered.slice(0, 250).forEach(b => frag.appendChild(makeCard(b)));
  els.grid.appendChild(frag);

  const total = filtered.length;
  els.count.textContent = total.toLocaleString() + ' result' + (total===1?'':'s') +
    (total>250 ? ' (showing first 250)' : '');
}

function applyFilters(){
  const q = norm(els.q.value);
  const section = els.sectionFilter.value;

  filtered = books.filter(b=>{
    if(section && b.section !== section) return false;
    if(!q) return true;
    return bookSearchText(b).includes(q);
  });

  render();
}

function buildSectionFilter(){
  const sections = uniq(books.map(b=>b.section)).sort((a,b)=>a.localeCompare(b));
  for(const s of sections){
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    els.sectionFilter.appendChild(opt);
  }
}

els.q.addEventListener('input', () => {
  // tiny debounce
  clearTimeout(window.__t);
  window.__t = setTimeout(applyFilters, 60);
});

els.sectionFilter.addEventListener('change', applyFilters);

els.clearBtn.addEventListener('click', () => {
  els.q.value = '';
  els.sectionFilter.value = '';
  applyFilters();
});

els.closeModal.addEventListener('click', () => els.modal.close());
els.modal.addEventListener('click', (e)=> {
  // click outside content closes
  const rect = els.modal.getBoundingClientRect();
  const inDialog = (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom);
  if(!inDialog) els.modal.close();
});

// ---------- Open Library lookup ----------

function storageKeyFor(b){
  if(b.isbn) return `ol:isbn:${b.isbn}`;
  return `ol:q:${norm(b.title)}:${norm(b.authors?.[0]||'')}`;
}

function loadCached(key){
  try{
    const raw = localStorage.getItem(key);
    if(!raw) return null;
    const obj = JSON.parse(raw);
    // expire after 30 days
    if(obj && obj._ts && (Date.now() - obj._ts) > 30*24*3600*1000) return null;
    return obj;
  }catch{ return null; }
}

function saveCached(key, obj){
  try{
    localStorage.setItem(key, JSON.stringify({ ...obj, _ts: Date.now() }));
  }catch{}
}

function placeholderSvg(title){
  const safe = (title||'').slice(0,40);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450">
    <defs>
      <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
        <stop stop-color="#1f2a44" offset="0"/>
        <stop stop-color="#0f1421" offset="1"/>
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <text x="18" y="60" fill="rgba(255,255,255,.88)" font-family="system-ui" font-size="20" font-weight="700">${escapeXml(safe)}</text>
    <text x="18" y="92" fill="rgba(255,255,255,.55)" font-family="system-ui" font-size="13">No cover yet</text>
  </svg>`;
}
function escapeXml(s){ return (s||'').replace(/[<>&'"]/g, c=>({ '<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;' }[c])); }

async function fetchCoverAndMaybeDesc(b){
  const key = storageKeyFor(b);
  if(coverCache.has(key)) return coverCache.get(key);

  const cached = loadCached(key);
  if(cached){
    coverCache.set(key, cached);
    return cached;
  }

  let info = { coverUrl: '', description: '', source: '' };

  if(b.isbn){
    // api/books tends to provide cover + sometimes description
    const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(b.isbn)}&format=json&jscmd=data`;
    const data = await fetch(url).then(r=>r.json()).catch(()=>null);
    const entry = data ? data[`ISBN:${b.isbn}`] : null;
    if(entry){
      info.coverUrl = entry.cover?.medium || entry.cover?.large || entry.cover?.small || '';
      info.description = (typeof entry.description === 'string') ? entry.description : (entry.description?.value || '');
      info.source = 'openlibrary(api/books)';
      // if no description, try works
      const workKey = entry.works?.[0]?.key;
      if(!info.description && workKey){
        const w = await fetch(`https://openlibrary.org${workKey}.json`).then(r=>r.json()).catch(()=>null);
        info.description = (typeof w?.description === 'string') ? w.description : (w?.description?.value || '');
        info.source = 'openlibrary(works)';
      }
      // If still no cover, use cover service
      if(!info.coverUrl){
        info.coverUrl = `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(b.isbn)}-M.jpg`;
      }
    } else {
      // cover service fallback
      info.coverUrl = `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(b.isbn)}-M.jpg`;
      info.source = 'openlibrary(covers)';
    }
  }

  if(!b.isbn || (!info.description && !info.coverUrl)){
    // Search endpoint fallback
    const title = encodeURIComponent(b.title || '');
    const author = encodeURIComponent((b.authors && b.authors[0]) ? b.authors[0] : '');
    const url = `https://openlibrary.org/search.json?title=${title}&author=${author}&limit=1`;
    const res = await fetch(url).then(r=>r.json()).catch(()=>null);
    const doc = res?.docs?.[0];
    if(doc){
      if(doc.cover_i){
        info.coverUrl = `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`;
      }
      info.source = 'openlibrary(search)';
      // description via work key
      const workKey = doc.key; // like /works/OL...
      if(workKey){
        const w = await fetch(`https://openlibrary.org${workKey}.json`).then(r=>r.json()).catch(()=>null);
        info.description = (typeof w?.description === 'string') ? w.description : (w?.description?.value || '');
        if(!info.description && w?.subjects?.length){
          info.description = `Subjects: ${w.subjects.slice(0,10).join(', ')}.`;
        }
      }
    }
  }

  // keep it lightweight
  if(info.description && info.description.length > 1200){
    info.description = info.description.slice(0, 1200).trim() + '…';
  }

  coverCache.set(key, info);
  saveCached(key, info);
  return info;
}

// ---------- Modal ----------

async function openModal(b, currentCover){
  els.mTitle.textContent = b.title + (b.subtitle ? `: ${b.subtitle}` : '');
  els.mBy.textContent = (b.authors && b.authors.length) ? `by ${b.authors.join(', ')}` : '';
  els.mCover.src = currentCover || ('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(placeholderSvg(b.title)));
  els.mDesc.textContent = 'Looking up description…';
  els.mCatalog.innerHTML = '';
  els.mPills.innerHTML = '';

  const pills = [];
  if(b.series) pills.push(['Series', b.series]);
  if(b.publisher) pills.push(['Publisher', b.publisher]);
  if(b.edition) pills.push(['Edition', b.edition]);
  if(b.language) pills.push(['Language', b.language]);
  if(b.section) pills.push(['Section', b.section]);
  if(b.location) pills.push(['Location', b.location]);
  if(b.isbn) pills.push(['ISBN', b.isbn]);

  for(const [k,v] of pills.slice(0,8)){
    const p = document.createElement('span');
    p.className = 'pill';
    p.textContent = `${k}: ${v}`;
    els.mPills.appendChild(p);
  }

  const catalogLines = [];
  if(b.callNumbers?.length) catalogLines.push(`<b>Call #</b>: ${escapeHtml(b.callNumbers.join(' • '))}`);
  if(b.subjects) catalogLines.push(`<b>Subjects</b>: ${escapeHtml(b.subjects)}`);
  els.mCatalog.innerHTML = catalogLines.join('<br>') || '<span style="opacity:.8">No extra catalog fields in CSV for this record.</span>';

  els.modal.showModal();

  try{
    const info = await fetchCoverAndMaybeDesc(b);
    if(info.coverUrl) els.mCover.src = info.coverUrl;
    els.mDesc.textContent = info.description || 'No description found from Open Library for this record.';
  }catch{
    els.mDesc.textContent = 'Could not fetch description right now.';
  }
}

function escapeHtml(s){
  return (s||'').toString().replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' }[c]));
}

// ---------- Boot ----------

async function init(){
  const res = await fetch('books.json');
  books = await res.json();

  // optional: sort by title
  books.sort((a,b)=> (a.title||'').localeCompare((b.title||'')));

  buildSectionFilter();
  filtered = books;
  render();
}

init().catch(err=>{
  console.error(err);
  els.count.textContent = 'Failed to load books.json. Are you running a local server?';
});
