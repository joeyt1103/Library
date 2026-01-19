// scripts/build_enriched.js
// Node 18+
// Reads books.json and writes enriched_books.json

import fs from "node:fs/promises";

const GOOGLE_BOOKS_API_KEY = process.env.GOOGLE_BOOKS_API_KEY || "";
const INPUT = "books.json";
const OUTPUT = "enriched_books.json";

function norm(s) { return (s ?? "").toString().trim(); }
function cleanIsbn(isbn) { return norm(isbn).replace(/[^0-9Xx]/g, "").toUpperCase(); }

function stripHtml(html) {
  return String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function bestGenreFromCategories(categories = []) {
  if (!Array.isArray(categories) || categories.length === 0) return "Unknown";
  const c = String(categories[0]).trim();
  return c || "Unknown";
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) return null;
  return await r.json();
}

async function googleByIsbn(isbn) {
  if (!GOOGLE_BOOKS_API_KEY) return null;
  const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}&key=${encodeURIComponent(GOOGLE_BOOKS_API_KEY)}`;
  const data = await fetchJson(url);
  const item = data?.items?.[0]?.volumeInfo;
  if (!item) return null;

  const coverUrl = item.imageLinks?.thumbnail || item.imageLinks?.smallThumbnail || "";
  return {
    coverUrl: coverUrl ? coverUrl.replace("http://", "https://") : "",
    description: item.description ? stripHtml(item.description) : "",
    genre: bestGenreFromCategories(item.categories || []),
  };
}

async function googleSearch(title, author) {
  if (!GOOGLE_BOOKS_API_KEY) return null;
  let q = "";
  if (title) q += `intitle:${title}`;
  if (author) q += (q ? "+" : "") + `inauthor:${author}`;
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=1&key=${encodeURIComponent(GOOGLE_BOOKS_API_KEY)}`;
  const data = await fetchJson(url);
  const item = data?.items?.[0]?.volumeInfo;
  if (!item) return null;

  const coverUrl = item.imageLinks?.thumbnail || item.imageLinks?.smallThumbnail || "";
  return {
    coverUrl: coverUrl ? coverUrl.replace("http://", "https://") : "",
    description: item.description ? stripHtml(item.description) : "",
    genre: bestGenreFromCategories(item.categories || []),
  };
}

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

  // try work for description
  if (!description && Array.isArray(edition.works) && edition.works[0]?.key) {
    const work = await fetchJson(`https://openlibrary.org${edition.works[0].key}.json`);
    if (work) {
      if (typeof work.description === "string") description = work.description;
      if (typeof work.description === "object" && work.description?.value) description = work.description.value;
    }
  }

  return {
    coverUrl,
    description: description ? stripHtml(description) : "",
    genre: "Unknown",
  };
}

async function enrichOne(book) {
  const title = norm(book.title || book.Title);
  const author = norm(book.author || book.Author || book.Auther);
  const isbn = cleanIsbn(book.isbn || book.ISBN || "");

  // Best order for coverage:
  // 1) Google by ISBN
  // 2) OpenLibrary by ISBN
  // 3) Google search by title/author
  let out = { coverUrl: "", description: "", genre: "Unknown" };

  if (isbn) {
    out = (await googleByIsbn(isbn)) || out;
    if (!out.coverUrl || !out.description) {
      const ol = await openLibraryByIsbn(isbn);
      if (ol) {
        out.coverUrl = out.coverUrl || ol.coverUrl || "";
        out.description = out.description || ol.description || "";
      }
    }
  }

  if ((!out.coverUrl || !out.description || out.genre === "Unknown") && (title || author)) {
    const gs = await googleSearch(title, author);
    if (gs) {
      out.coverUrl = out.coverUrl || gs.coverUrl || "";
      out.description = out.description || gs.description || "";
      if (out.genre === "Unknown") out.genre = gs.genre || "Unknown";
    }
  }

  return {
    title,
    author,
    isbn,
    coverUrl: out.coverUrl,
    description: out.description,
    genre: out.genre || "Unknown",
  };
}

async function main() {
  const raw = JSON.parse(await fs.readFile(INPUT, "utf-8"));
  const books = raw.map((r) => ({
    title: r.title ?? r.Title ?? "",
    author: r.author ?? r.Author ?? r.Auther ?? "",
    isbn: r.isbn ?? r.ISBN ?? "",
  }));

  const enriched = [];
  for (let i = 0; i < books.length; i++) {
    const e = await enrichOne(books[i]);
    enriched.push({ _id: i, ...e });

    if (i % 20 === 0) {
      console.log(`Enriched ${i + 1}/${books.length}`);
    }

    // small delay to be polite to APIs
    await new Promise((r) => setTimeout(r, 50));
  }

  await fs.writeFile(OUTPUT, JSON.stringify(enriched, null, 2), "utf-8");
  console.log(`Wrote ${OUTPUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
