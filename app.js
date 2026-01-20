// build_enriched.js
// Node 20+ (GitHub Actions uses Node 20)
// Reads books.json and writes enriched_books.json
// Enrich order (best coverage):
//   1) Google Books by ISBN
//   2) Open Library by ISBN
//   3) Google Books by Title + Author
//   4) Open Library search by Title + Author
//
// Also removes DVDs if your source still contains them (by title/callNumbers/format).

import fs from "node:fs/promises";

const GOOGLE_BOOKS_API_KEY = process.env.GOOGLE_BOOKS_API_KEY || "";

// If this file lives in repo root, INPUT/OUTPUT are correct.
// If it lives in /scripts, these still work as long as workflow runs from repo root.
const INPUT = "books.json";
const OUTPUT = "enriched_books.json";

// Tune these if you want faster/slower enrichment
const CONCURRENCY = 6;          // parallel requests (safe-ish)
const MIN_DELAY_MS = 60;        // polite delay between tasks
const MAX_RETRIES = 4;          // retry 429/5xx
const RETRY_BASE_MS = 600;      // backoff base

// ---------------- helpers ----------------
function norm(s) {
  return (s ?? "").toString().trim();
}

function cleanIsbn(isbn) {
  return norm(isbn).replace(/[^0-9Xx]/g, "").toUpperCase();
}

function stripHtml(html) {
  // good enough for API descriptions
  return String(html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function bestGenreFromCategories(categories = []) {
  if (!Array.isArray(categories) || categories.length === 0) return "Unknown";
  const c = String(categories[0] || "").trim();
  return c || "Unknown";
}

function bestGenreFromSubjects(subjects = []) {
  const s = subjects.map((x) => String(x).toLowerCase());

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
    if (keywords.some((k) => s.some((v) => v.includes(k)))) return genre;
  }
  return "Unknown";
}

function isDvdRecord(rawRow) {
  const title = String(rawRow.title ?? rawRow.Title ?? "").toLowerCase();
  const format = String(rawRow.format ?? rawRow.Format ?? rawRow.type ?? rawRow.Type ?? rawRow.media ?? rawRow.Media ?? "").toLowerCase();

  // Your original data sometimes has callNumbers arrays
  const callNums = Array.isArray(rawRow.callNumbers) ? rawRow.callNumbers.join(" ").toLowerCase() : "";

  return title.includes("dvd") || format.includes("dvd") || callNums.includes("dvd");
}

// ---------------- fetch with retries ----------------
async function fetchJson(url) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "github-actions-books-enricher",
      },
    });

    if (res.ok) {
      try {
        return await res.json();
      } catch {
        return null;
      }
    }

    // retry on rate limits and transient errors
    const retryable = res.status === 429 || (res.status >= 500 && res.status <= 599);
    if (!retryable || attempt === MAX_RETRIES) return null;

    const wait = RETRY_BASE_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
    await sleep(wait);
  }
  return null;
}

// ---------------- Google Books ----------------
async function googleByIsbn(isbn) {
  if (!GOOGLE_BOOKS_API_KEY) return null;

  const url =
    `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}` +
    `&maxResults=1&key=${encodeURIComponent(GOOGLE_BOOKS_API_KEY)}`;

  const data = await fetchJson(url);
  const info = data?.items?.[0]?.volumeInfo;
  if (!info) return null;

  const coverUrl = info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail || "";
  return {
    coverUrl: coverUrl ? coverUrl.replace("http://", "https://") : "",
    description: info.description ? stripHtml(info.description) : "",
    genre: bestGenreFromCategories(info.categories || []),
    source: "GB",
  };
}

async function googleSearch(title, author) {
  if (!GOOGLE_BOOKS_API_KEY) return null;

  let q = "";
  if (title) q += `intitle:${title}`;
  if (author) q += (q ? "+" : "") + `inauthor:${author}`;

  const url =
    `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}` +
    `&maxResults=1&key=${encodeURIComponent(GOOGLE_BOOKS_API_KEY)}`;

  const data = await fetchJson(url);
  const info = data?.items?.[0]?.volumeInfo;
  if (!info) return null;

  const coverUrl = info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail || "";
  return {
    coverUrl: coverUrl ? coverUrl.replace("http://", "https://") : "",
    description: info.description ? stripHtml(info.description) : "",
    genre: bestGenreFromCategories(info.categories || []),
    source: "GB",
  };
}

// ---------------- Open Library ----------------
async function openLibraryByIsbn(isbn) {
  const edition = await fetchJson(`https://openlibrary.org/isbn/${encodeURIComponent(isbn)}.json`);
  if (!edition) return null;

  let coverUrl = "";
  if (Array.isArray(edition.covers) && edition.covers.length) {
    coverUrl = `https://covers.openlibrary.org/b/id/${edition.covers[0]}-L.jpg`;
  } else {
    coverUrl = `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(isbn)}-L.jpg`;
  }

  let description = "";
  if (typeof edition.description === "string") description = edition.description;
  if (typeof edition.description === "object" && edition.description?.value) description = edition.description.value;

  let subjects = Array.isArray(edition.subjects) ? edition.subjects : [];

  // Try work for description/subjects
  if (( !description || subjects.length === 0 ) && Array.isArray(edition.works) && edition.works[0]?.key) {
    const work = await fetchJson(`https://openlibrary.org${edition.works[0].key}.json`);
    if (work) {
      if (!description) {
        if (typeof work.description === "string") description = work.description;
        if (typeof work.description === "object" && work.description?.value) description = work.description.value;
      }
      if (Array.isArray(work.subjects) && work.subjects.length) {
        subjects = subjects.concat(work.subjects);
      }
    }
  }

  return {
    coverUrl,
    description: description ? stripHtml(description) : "",
    genre: bestGenreFromSubjects(subjects),
    source: "OL",
  };
}

async function openLibrarySearch(title, author) {
  const parts = [];
  if (title) parts.push(`title=${encodeURIComponent(title)}`);
  if (author) parts.push(`author=${encodeURIComponent(author)}`);
  const url = `https://openlibrary.org/search.json?${parts.join("&")}&limit=1`;

  const data = await fetchJson(url);
  const doc = data?.docs?.[0];
  if (!doc) return null;

  let coverUrl = "";
  if (doc.cover_i) coverUrl = `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`;

  const subjects = Array.isArray(doc.subject) ? doc.subject : [];
  const genre = bestGenreFromSubjects(subjects);

  // OL search rarely provides description; keep it blank
  return { coverUrl, description: "", genre, source: "OL" };
}

// ---------------- enrichment logic (author-aware) ----------------
async function enrichOne(book) {
  const title = norm(book.title || "");
  const author = norm(book.author || "");
  const isbn = cleanIsbn(book.isbn || "");

  let out = { coverUrl: "", description: "", genre: "Unknown", source: "" };

  // 1) Google Books by ISBN
  if (isbn) {
    const gb = await googleByIsbn(isbn);
    if (gb) out = { ...out, ...gb };
  }

  // 2) Open Library by ISBN
  if (isbn && (!out.coverUrl || !out.description || out.genre === "Unknown")) {
    const ol = await openLibraryByIsbn(isbn);
    if (ol) {
      out.coverUrl ||= ol.coverUrl;
      out.description ||= ol.description;
      if (out.genre === "Unknown") out.genre = ol.genre || "Unknown";
      out.source ||= ol.source;
    }
  }

  // 3) Google Books by Title + Author (scan author explicitly)
  if ((title || author) && (!out.coverUrl || !out.description || out.genre === "Unknown")) {
    const gb = await googleSearch(title, author);
    if (gb) {
      out.coverUrl ||= gb.coverUrl;
      out.description ||= gb.description;
      if (out.genre === "Unknown") out.genre = gb.genre || "Unknown";
      out.source ||= gb.source;
    }
  }

  // 4) Open Library search by Title + Author
  if ((title || author) && (!out.coverUrl || out.genre === "Unknown")) {
    const ols = await openLibrarySearch(title, author);
    if (ols) {
      out.coverUrl ||= ols.coverUrl;
      if (out.genre === "Unknown") out.genre = ols.genre || "Unknown";
      out.source ||= ols.source;
    }
  }

  return {
    title,
    author,
    isbn,
    coverUrl: out.coverUrl || "",
    description: out.description || "",
    genre: out.genre || "Unknown",
    source: out.source || "",
  };
}

// ---------------- concurrency runner ----------------
async function runPool(items, worker, concurrency) {
  let i = 0;
  const results = new Array(items.length);

  async function next() {
    const idx = i++;
    if (idx >= items.length) return;

    results[idx] = await worker(items[idx], idx);

    // small delay to be polite
    if (MIN_DELAY_MS) await sleep(MIN_DELAY_MS);

    await next();
  }

  const starters = [];
  for (let k = 0; k < Math.min(concurrency, items.length); k++) starters.push(next());
  await Promise.all(starters);
  return results;
}

// ---------------- main ----------------
async function main() {
  const raw = JSON.parse(await fs.readFile(INPUT, "utf-8"));

  // Build a clean list and drop DVDs (if any)
  const books = raw
    .filter((r) => !isDvdRecord(r))
    .map((r) => ({
      title: r.title ?? r.Title ?? "",
      author: r.author ?? r.Author ?? r.Auther ?? "",
      isbn: r.isbn ?? r.ISBN ?? "",
    }))
    .filter((b) => b.title || b.author || b.isbn);

  console.log(`Input: ${raw.length} items`);
  console.log(`After DVD filter: ${books.length} items`);

  let done = 0;
  const enriched = await runPool(
    books,
    async (b, idx) => {
      const e = await enrichOne(b);
      done++;
      if (done % 50 === 0 || done === books.length) {
        console.log(`Enriched ${done}/${books.length}`);
      }
      return { _id: idx, ...e };
    },
    CONCURRENCY
  );

  await fs.writeFile(OUTPUT, JSON.stringify(enriched, null, 2), "utf-8");
  console.log(`Wrote ${OUTPUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
