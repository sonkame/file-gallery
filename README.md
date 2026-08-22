# File Gallery

A local-first place to keep images organized in folders. Each image carries a
title and an optional link. Folders nest to any depth. Everything is
rearranged by dragging. One backup file restores the whole thing.

## Running it

Open `index.html` directly from disk — no build step, no server, no network.

Or serve it, which is only needed if you want it reachable from another device:

```bash
python3 -m http.server 8901 --directory "$(dirname "$0")"
```

## Using it

| | |
|---|---|
| Add images | **＋ Add images**, or drag files in from the desktop |
| New folder | **＋ New folder** — folders always sort above loose images |
| Move anything | Drag it. Onto a folder files it inside; between cards reorders |
| Get out of a deep folder | Drag onto any breadcrumb, including **Home** |
| Open | Click a folder to enter it; click an image to follow its link |
| Rename / delete | The `⋮` menu on each card |

Folders can be dropped into other folders, to any depth. A folder cannot be
dropped onto an image, and cannot be dropped inside itself — those targets
simply show no drop indicator.

## Backup

Everything lives in this browser's IndexedDB. Clearing site data, switching
machines or losing the disk wipes it. The **Backup** button is the only thing
that survives that.

Export picks a format from the raw size of your images:

- **≤ 100 MB** — a single `gallery-backup-YYYY-MM-DD.json`, images embedded
- **> 100 MB** — a `gallery-backup-YYYY-MM-DD.zip` holding `data.json` plus
  `images/<id>.png`

Both restore the gallery completely and identically. The zip is a plain,
uncompressed archive, so any file manager can open it and get your pictures
back even without this site.

Restoring replaces everything currently in the browser. There is no undo on
delete — the backup file is the safety net. A dot appears on the Backup
button when something has changed since your last saved file.

## Code layout

`index.html` is self-contained — every style and script is inlined, so the
whole app is readable and shareable as one file, the same way
[CryptoFolio](https://github.com/sonkame/crypto-portfolio) is.

The `js/*.js` files and `styles.css` alongside it are the same source split
back out into modules. They exist only so `tests.html` can import the pure
logic (`tree.js`, `zip.js`, `images.js`, `backup.js`) in isolation — they
aren't loaded by `index.html` and don't need to be kept publicly in sync
beyond that. If you change the app, edit `index.html`; mirror the change into
the matching `js/*.js` file only if it affects something `tests.html` covers.

## Tests

Open `tests.html`. It runs in the browser against the split-out `js/` files,
with no framework and no build. It deliberately does not load `js/db.js`, so
running it cannot touch a real gallery.

Tick **Include slow tests** to also build a 66,000-entry archive, which
forces the ZIP64 records the writer emits past the 16-bit entry limit. That
one takes a while.

## Design

See [docs/superpowers/specs/2026-08-21-file-gallery-organizer-design.md](docs/superpowers/specs/2026-08-21-file-gallery-organizer-design.md).
