// app.js
// Displays only: Title, Author, ISBN, Cover, Description
// Data source: books.json (your repo already has this)
// Enrichment: Open Library first, Google Books fallback (better coverage)
// Genre filter: from Google Books categories (or OL subjects)

const DATA_URL = "books.json";

// ✅ Put your Google Books API key here
const GOOGLE_BOOKS_API_KEY = "PASTE_YOUR_KEY_HERE";

// Cache keys (localStorage)
const CACHE_PREFIX = "book_enrich_v1:";

const els = {
  search: document.getElementById("search"),
  results: document.getElementById("results"),
  status: document.getElementById("status"),
  genreFilter: document.getElementById("genreFilter"),
};

let BOOKS = [];
let ENRICHED = [];

// ---------- helpers ----------
function norm(s) {
  return (s ?? "").toString().trim();
}

function cleanIsbn(isbn) {
  return norm(isbn).replace(/[^0-9Xx]/g, "").toUpperCase();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function cacheGet(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function cacheSet(key, value) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value));
  } catch {}
}

function pickFirstNonEmpty(...vals) {
  for (const v of vals) {
    if (v && String(v).trim()) return v;
  }
  return "";
}

function stripHtml(html) {
  const div = document.createElement("div");
  div.innerHTML = html ?? "";
  return div.textContent || div.innerText || "";
}

function bestGenreFromCategories(categories = []) {
  // categories from Google are usually decent already; we lightly normalize
  if (!Array.isArray(categories) || categories.length === 0) return "Unknown";
  // return first category but shorten if it's long
  const c = String(categories[0]).trim();
  if (!c) return "Unknown";
  return c.length > 40 ? c.slice(0, 40) + "…" : c;
}

function bestGenreFromSubjects(subjects = []) {
  const s = subjects.map(x => String(x).toLowerCase());

  const rules = [
    ["Mystery / Thriller", ["mystery", "detective", "crime", "thriller", "suspense"]],
    ["Science Fiction", ["science fiction", "sci-fi", "space", "dystopia"]],
    ["Fantasy", ["fantasy", "magic", "dragons"]],
    ["Romance", ["romance", "love stories"]],
    ["Biography", ["biography", "autobiography", "memoirs"]],
    ["History", ["history", "historical"]],
    ["Religion", ["christian", "religion", "bible", "catholic"]],
    ["Kids / YA", ["juvenile", "children", "young adult"]],
    ["Self-Help", ["self-help", "personal development"]],
    ["Business", ["business", "economics", "finance"]],
    ["Nonfiction", ["nonfiction", "non-fiction"]],
    ["Fiction", ["fiction", "novel"]],
  ];

  for (const [genre, keywords] of rules) {
    if (keywords.some(k => s.some(v => v.includes(k)))) return genre;
  }
  return "Unknown";
}

// ---------- fetch + parse ----------
async function loadBooks() {
  const res = await fetch(DATA_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${DATA_URL} (${res.status})`);
  const data = await res.json();

  // try to be flexible about column names
  return data.map((row, idx) => {
    const title = pickFirstNonEmpty(row.Title, row.title, row["Book Title"], row["book title"]);
    const author = pickFirstNonEmpty(row.Author, row.author, row.Auther, row.auther);
    const isbnRaw = pickFirstNonEmpty(row.ISBN, row.isbn, row["ISBN-13"], row["ISBN13"], row["isbn13"]);
    const isbn = cleanIsbn(isbnRaw);

    return {
      _id: idx,
      title,
      author,
      isbn,
      coverUrl: "",       // filled by enrichment
      description: "",    // filled by enrichment
      genre: "Unknown",   // filled by enrichment
      source: "",         // OL / GB
    };
  }).filter(b => b.title || b.author || b.isbn);
}

// ---------- Open Library ----------
async function openLibraryByIsbn(isbn) {
  // OL Books API by ISBN
  const url = `https://openlibrary.org/isbn/${encodeURIComponent(isbn)}.json`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const edition = await r.json();

  // cover: use covers array or cover service
  let coverUrl = "";
  if (Array.isArray(edition.covers) && edition.covers.length) {
    coverUrl = `https://covers.openlibrary.org/b/id/${edition.covers[0]}-L.jpg`;
  } else if (isbn) {
    coverUrl = `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(isbn)}-L.jpg`;
  }

  // description: sometimes on edition, sometimes on work
  let description = "";
  if (typeof edition.description === "string") description = edition.description;
  if (typeof edition.description === "object" && edition.description?.value) description = edition.description.value;

  // subjects: sometimes on edition
  const subjects = Array.isArray(edition.subjects) ? edition.subjects : [];

  // If no description, try work
  if (!description && Array.isArray(edition.works) && edition.works[0]?.key) {
    const workKey = edition.works[0].key;
    const wr = await fetch(`https://openlibrary.org${workKey}.json`);
    if (wr.ok) {
      const work = await wr.json();
      if (typeof work.description === "string") description = work.description;
      if (typeof work.description === "object" && work.description?.value) description = work.description.value;
      if (Array.isArray(work.subjects) && work.subjects.length) {
        subjects.push(...work.subjects);
      }
    }
  }

  // If cover URL points to a missing image, OL returns a placeholder but still 200 sometimes.
  // We'll accept it; Google fallback will replace if needed.
  return {
    coverUrl,
    description: description ? stripHtml(description) : "",
    subjects,
  };
}

async function openLibrarySearch(title, author) {
  const q = [];
  if (title) q.push(`title=${encodeURIComponent(title)}`);
  if (author) q.push(`author=${encodeURIComponent(author)}`);
  const url = `https://openlibrary.org/search.json?${q.join("&")}&limit=1`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const data = await r.json();
  const doc = data?.docs?.[0];
  if (!doc) return null;

  let coverUrl = "";
  if (doc.cover_i) coverUrl = `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`;

  // OL search doesn’t reliably give descriptions; use subjects if present
  const subjects = Array.isArray(doc.subject) ? doc.subject : [];
  const isbn = Array.isArray(doc.isbn) && doc.isbn.length ? cleanIsbn(doc.isbn[0]) : "";

  return {
    coverUrl,
    description: "",
    subjects,
    isbn,
  };
}

// ---------- Google Books (fallback) ----------
async function googleBooksByIsbn(isbn) {
  if (!GOOGLE_BOOKS_API_KEY) return null;
  const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}&key=${encodeURIComponent(GOOGLE_BOOKS_API_KEY)}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const data = await r.json();
  const item = data?.items?.[0];
  if (!item?.volumeInfo) return null;

  const info = item.volumeInfo;
  const coverUrl =
    info.imageLinks?.thumbnail ||
    info.imageLinks?.smallThumbnail ||
    "";

  return {
    coverUrl: coverUrl ? coverUrl.replace("http://", "https://") : "",
    description: info.description ? stripHtml(info.description) : "",
    categories: Array.isArray(info.categories) ? info.categories : [],
  };
}

async function googleBooksSearch(title, author) {
  if (!GOOGLE_BOOKS_API_KEY) return null;
  let q = "";
  if (title) q += `intitle:${title}`;
  if (author) q += (q ? "+" : "") + `inauthor:${author}`;

  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=1&key=${encodeURIComponent(GOOGLE_BOOKS_API_KEY)}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const data = await r.json();
  const item = data?.items?.[0];
  if (!item?.volumeInfo) return null;

  const info = item.volumeInfo;
  const coverUrl =
    info.imageLinks?.thumbnail ||
    info.imageLinks?.smallThumbnail ||
    "";

  return {
    coverUrl: coverUrl ? coverUrl.replace("http://", "https://") : "",
    description: info.description ? stripHtml(info.description) : "",
    categories: Array.isArray(info.categories) ? info.categories : [],
  };
}

// ---------- enrichment pipeline ----------
async function enrichBook(book) {
  const cacheKey = book.isbn ? `isbn:${book.isbn}` : `ta:${book.title}|${book.author}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { ...book, ...cached };

  let coverUrl = "";
  let description = "";
  let genre = "Unknown";
  let source = "";

  // 1) Open Library by ISBN
  if (book.isbn) {
    const ol = await openLibraryByIsbn(book.isbn);
    if (ol) {
      coverUrl = ol.coverUrl || "";
      description = ol.description || "";
      genre = bestGenreFromSubjects(ol.subjects || []);
      source = "OL";
    }
  }

  // 2) Open Library search fallback (title/author)
  if ((!coverUrl || !description) && (book.title || book.author)) {
    const ols = await openLibrarySearch(book.title, book.author);
    if (ols) {
      coverUrl = coverUrl || (ols.coverUrl || "");
      description = description || ""; // OL search usually no description
      if (genre === "Unknown") genre = bestGenreFromSubjects(ols.subjects || []);
      source = source || "OL";
      // If OL search gave us an ISBN and we didn't have one, we could optionally retry OL-by-ISBN,
      // but we keep it simple to avoid lots of requests.
    }
  }

  // 3) Google Books by ISBN (best fallback)
  if ((!coverUrl || !description || genre === "Unknown") && book.isbn) {
    const gb = await googleBooksByIsbn(book.isbn);
    if (gb) {
      coverUrl = coverUrl || gb.coverUrl || "";
      description = description || gb.description || "";
      if (genre === "Unknown") genre = bestGenreFromCategories(gb.categories || []);
      source = "GB";
    }
  }

  // 4) Google Books search fallback
  if ((!coverUrl || !description || genre === "Unknown") && (book.title || book.author)) {
    const gb = await googleBooksSearch(book.title, book.author);
    if (gb) {
      coverUrl = coverUrl || gb.coverUrl || "";
      description = description || gb.description || "";
      if (genre === "Unknown") genre = bestGenreFromCategories(gb.categories || []);
      source = "GB";
    }
  }

  const enriched = { coverUrl, description, genre, source };
  cacheSet(cacheKey, enriched);
  return { ...book, ...enriched };
}

// ---------- render ----------
function buildGenreFilter(books) {
  const genres = Array.from(new Set(books.map(b => b.genre || "Unknown")))
    .map(g => g || "Unknown")
    .sort((a, b) => a.localeCompare(b));

  els.genreFilter.innerHTML =
    `<option value="">All Genres</option>` +
    genres.map(g => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join("");
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function matchesSearch(b, q) {
  if (!q) return true;
  q = q.toLowerCase();
  return (
    (b.title || "").toLowerCase().includes(q) ||
    (b.author || "").toLowerCase().includes(q) ||
    (b.isbn || "").toLowerCase().includes(q)
  );
}

function render() {
  const q = norm(els.search?.value).toLowerCase();
  const g = els.genreFilter?.value || "";

  const filtered = ENRICHED.filter(b => {
    const okSearch = matchesSearch(b, q);
    const okGenre = !g || (b.genre === g);
    return okSearch && okGenre;
  });

  els.status.textContent = `${filtered.length} book(s)`;

  els.results.innerHTML = filtered.map(b => {
    const cover = b.coverUrl
      ? `<img class="cover" src="${escapeHtml(b.coverUrl)}" alt="Cover for ${escapeHtml(b.title)}" loading="lazy">`
      : `<div class="cover placeholder">No cover</div>`;

    const desc = b.description ? escapeHtml(b.description) : "No description found.";

    return `
      <div class="card">
        ${cover}
        <div class="meta">
          <div class="title">${escapeHtml(b.title || "Untitled")}</div>
          <div class="author">${escapeHtml(b.author || "Unknown author")}</div>
          <div class="isbn">ISBN: ${escapeHtml(b.isbn || "—")}</div>
          <div class="genre">Genre: ${escapeHtml(b.genre || "Unknown")}</div>
          <div class="desc">${desc}</div>
        </div>
      </div>
    `;
  }).join("");
}

// ---------- init ----------
async function main() {
  els.status.textContent = "Loading books…";
  BOOKS = await loadBooks();

  // Enrich with gentle throttling so you don’t hammer APIs
  els.status.textContent = `Enriching ${BOOKS.length} books…`;
  ENRICHED = [];

  for (let i = 0; i < BOOKS.length; i++) {
    const b = BOOKS[i];
    const e = await enrichBook(b);
    ENRICHED.push(e);

    if (i % 10 === 0) {
      els.status.textContent = `Enriching… ${i + 1}/${BOOKS.length}`;
      render(); // progressive render feels snappy
    }

    // tiny delay helps avoid rate limits
    await sleep(120);
  }

  buildGenreFilter(ENRICHED);

  // events
  els.search?.addEventListener("input", render);
  els.genreFilter?.addEventListener("change", render);

  els.status.textContent = `Loaded ${ENRICHED.length} books`;
  render();
}

main().catch(err => {
  console.error(err);
  els.status.textContent = "Error loading data. Check console.";
});
