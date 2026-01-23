// app.js (BROWSER ONLY)
// Loads enriched_books.json and renders the site.
// NO imports. NO process.env. NO node:.

const DATA_URL = "enriched_books.json";

const els = {
  search: document.getElementById("search"),
  results: document.getElementById("results"),
  status: document.getElementById("status"),
  genreFilter: document.getElementById("genreFilter"),
};

// Loading overlay
const loading = {
  overlay: document.getElementById("loadingOverlay"),
  text: document.getElementById("loadingText"),
};
function setLoading(on, msg = "") {
  if (loading.overlay) loading.overlay.style.display = on ? "flex" : "none";
  if (loading.text && msg) loading.text.textContent = msg;
  if (els.status && msg) els.status.textContent = msg;
}

// Modal elements
const modal = {
  backdrop: document.getElementById("modalBackdrop"),
  closeBtn: document.getElementById("modalClose"),
  coverWrap: document.getElementById("modalCoverWrap"),
  title: document.getElementById("modalTitle"),
  author: document.getElementById("modalAuthor"),
  isbn: document.getElementById("modalIsbn"),
  genre: document.getElementById("modalGenre"),
  desc: document.getElementById("modalDesc"),
};

let ENRICHED = [];
let INDEX_BY_ID = new Map();

// helpers
function norm(s) {
  return (s ?? "").toString().trim();
}
function cleanIsbn(isbn) {
  return norm(isbn).replace(/[^0-9Xx]/g, "").toUpperCase();
}
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// modal
function openModal(book) {
  modal.title.textContent = book.title || "Untitled";
  modal.author.textContent = `Author: ${book.author || "Unknown author"}`;
  modal.isbn.textContent = `ISBN: ${book.isbn || "—"}`;
  modal.genre.textContent = `Genre: ${book.genre || "Unknown"}`;
  modal.desc.textContent = book.description || "No description found.";

  if (book.coverUrl) {
    modal.coverWrap.innerHTML = `<img src="${escapeHtml(book.coverUrl)}">`;
  } else {
    modal.coverWrap.innerHTML = `<div class="cover placeholder">No cover</div>`;
  }

  modal.backdrop.classList.remove("hidden");
}
function closeModal() {
  modal.backdrop.classList.add("hidden");
}
modal.closeBtn?.addEventListener("click", closeModal);
modal.backdrop?.addEventListener("click", (e) => {
  if (e.target === modal.backdrop) closeModal();
});

// load JSON
async function loadBooks() {
  setLoading(true, "Downloading library…");
  const res = await fetch(DATA_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load enriched_books.json");

  setLoading(true, "Parsing data…");
  const data = await res.json();

  const books = data.map((row, idx) => ({
    _id: row._id ?? idx,
    title: row.title ?? "",
    author: row.author ?? "",
    isbn: cleanIsbn(row.isbn ?? ""),
    coverUrl: row.coverUrl ?? "",
    description: row.description ?? "",
    genre: row.genre ?? "Unknown",
  }));

  INDEX_BY_ID = new Map(books.map(b => [Number(b._id), b]));
  return books;
}

function buildGenreFilter(books) {
  const genres = [...new Set(books.map(b => b.genre))].sort();
  els.genreFilter.innerHTML =
    `<option value="">All Genres</option>` +
    genres.map(g => `<option value="${g}">${g}</option>`).join("");
}

function matchesSearch(b, q) {
  q = q.toLowerCase();
  return (
    b.title.toLowerCase().includes(q) ||
    b.author.toLowerCase().includes(q) ||
    b.isbn.includes(q)
  );
}

function render() {
  const q = norm(els.search.value);
  const g = els.genreFilter.value;

  const filtered = ENRICHED.filter(b => {
    return matchesSearch(b, q) && (!g || b.genre === g);
  });

  els.status.textContent = `${filtered.length} book(s)`;

  els.results.innerHTML = filtered.map(b => `
    <div class="card clickable" data-id="${b._id}">
      ${b.coverUrl
        ? `<img class="cover" src="${escapeHtml(b.coverUrl)}">`
        : `<div class="cover placeholder">No cover</div>`}
      <div class="meta">
        <div class="title">${escapeHtml(b.title)}</div>
        <div class="author">${escapeHtml(b.author)}</div>
        <div class="isbn">ISBN: ${b.isbn || "—"}</div>
        <div class="genre">Genre: ${b.genre}</div>
      </div>
    </div>
  `).join("");

  document.querySelectorAll(".card").forEach(card => {
    const id = Number(card.dataset.id);
    card.onclick = () => openModal(INDEX_BY_ID.get(id));
  });
}

// init
async function main() {
  ENRICHED = await loadBooks();
  buildGenreFilter(ENRICHED);

  els.search.oninput = render;
  els.genreFilter.onchange = render;

  render();
  setLoading(false);
}

main().catch(err => {
  console.error(err);
  setLoading(true, "Error loading library");
});
