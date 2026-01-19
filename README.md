# Book Search Website (CSV -> JSON -> Static Site)

## What this is
A client-only website that:
- loads `books.json` (generated from your CSV)
- lets people search/filter books
- fetches covers + descriptions from Open Library (when available)
- caches lookups in the browser (localStorage) to stay fast

## Run locally
Because browsers block `fetch()` from local files, run a tiny local server:

### Option A: Python
1. Open a terminal in this folder
2. Run:
   - `python3 -m http.server 8000`
3. Visit:
   - http://localhost:8000

### Option B: Node
- `npx serve`

## Deploy free
### GitHub Pages
1. Create a GitHub repo
2. Upload these files
3. Repo Settings -> Pages -> Deploy from branch -> `/ (root)`
4. Your site will be live at a `github.io` URL

## Notes
- Open Library doesn't have metadata for every book, so some covers/descriptions will be missing.
- If your CSV has reliable ISBNs, results will be much better.
