# File Gallery Organizer — Design

**Date:** 2026-08-21
**Status:** Approved, ready for implementation planning

## Purpose

A local-first website for keeping images organized in folders. Each stored image
carries a title and an optional link. Folders nest to any depth. Everything is
rearranged by dragging. The entire contents export to a single backup file that
restores the site completely on any machine.

This is a standalone site, separate from CryptoFolio. It borrows CryptoFolio's
dark theme and its backup-and-restore concept, but shares no code and no storage.

## Non-Goals

- No accounts, no server, no sync. Data lives in one browser; the backup file is
  what moves between machines.
- No image editing, cropping, or filters.
- No tagging or cross-folder search. Folders are the only organizing tool.
- No daily auto-backup. See "Rejected: auto-backup" below.

## Storage

IndexedDB, database `file-gallery`, version 1. Three object stores:

| Store | Key | Value | Purpose |
|---|---|---|---|
| `nodes` | `id` | `{id, type, parentId, title, url, order, createdAt, updatedAt}` | The tree. Small records. |
| `thumbs` | `id` | `{id, blob}` | Downscaled preview, max edge 400px. |
| `blobs` | `id` | `{id, blob, name, mime}` | Full-resolution original. |

`type` is `'folder'` or `'item'`. Folders have no `url`, no thumb, no blob.
`parentId` is `null` for top-level nodes.

Indexes: `nodes` has an index on `parentId` for listing a folder's children.

### Why three stores

IndexedDB reads whole records. If thumbnails or originals lived on the `nodes`
record, drawing a folder grid would deserialize every byte of image data in it.
Splitting them means rendering reads `nodes` (kilobytes) plus only the `thumbs`
actually on screen. Full-resolution blobs are read only when exporting a backup
or opening an image at full size.

This is the difference between a gallery that stays responsive at 5,000 images
and one that stalls at 200.

### Object URL lifecycle

Thumbnails render via `URL.createObjectURL`. Every URL created for a view is
tracked and revoked when that view is torn down. Failing to revoke leaks the
blob's memory for the lifetime of the tab, which at hundreds of MB is fatal.

## Ordering

Every node has an integer `order` scoped to its `parentId`. Siblings sort by:

```
(type === 'folder' ? 0 : 1, order)
```

The type term is what pins folders above loose images. It applies at every level
with no special-casing, and it cannot drift out of sync the way a manually
maintained "folders first" position would.

A reorder renumbers the affected sibling list sequentially and writes it in one
transaction. At realistic folder sizes this is cheaper and far simpler to reason
about than fractional ordering.

## Drag and drop

Drop targets are computed per drag, from the type of node being dragged:

| Dragging | Onto a folder | Between siblings | Onto an item |
|---|---|---|---|
| Item | move inside | reorder | rejected |
| Folder | move inside | reorder | rejected |

Rejected targets render no drop indicator. The rule is communicated by the
absence of affordance, not by an error after the drop.

### Cycle guard

Before allowing a folder to drop into another folder, walk the target's ancestor
chain. If the dragged folder appears in it, reject. Without this check, dropping
a folder into its own descendant detaches that subtree from the root — the nodes
still exist but become permanently unreachable.

A node dropped onto itself is also rejected.

### Breadcrumbs as drop targets

The breadcrumb trail (`Home › Design › UI › Dark`) accepts drops. Dragging a node
onto a crumb moves it to that level, which is how you get something out of a deep
folder without navigating back up.

## Adding images

Images enter through a file picker or by dragging files from the desktop onto the
page. Multi-select is supported; each selected file becomes one item.

On add, for each file:
1. Store the original in `blobs`.
2. Generate a thumbnail (max edge 400px, drawn to canvas, encoded as JPEG at
   ~0.8 quality) and store it in `thumbs`.
3. Create the `nodes` record with `title` defaulting to the filename minus its
   extension, and `url` empty.

Title and link are editable afterward through an edit modal.

## Backup and restore

### Format selection

Export first sums `blob.size` across all stored originals. That raw total, not
the encoded size, picks the format:

- **≤ 100 MB** → `gallery-backup-YYYY-MM-DD.json`, images embedded as base64
- **> 100 MB** → `gallery-backup-YYYY-MM-DD.zip`

Measuring raw bytes matters because base64 inflates by roughly a third. Deciding
on encoded size would let a 100 MB image set leave as a 133 MB JSON file.

### Payload

Both formats carry an identical logical payload:

```json
{
  "format": "filegallery.backup",
  "version": 1,
  "savedAt": "2026-08-21T17:30:00.000Z",
  "nodes": [ /* every node record, full tree, order preserved */ ]
}
```

In the JSON format, a sibling `images` key holds an object mapping node id to a
data URL. In the zip format that key is absent from `data.json`, and the images
live as real files at `images/<id>.<ext>`.

Originals are backed up; thumbnails are not. Thumbnails are derived data and are
regenerated on restore, which keeps the backup smaller and prevents a restored
site from carrying stale previews.

Because the tree payload is byte-identical between formats, both restore paths
converge on the same code after unpacking. This is what makes the two formats
genuinely interchangeable rather than two parallel implementations that drift.

### The zip writer

Hand-rolled, store-only (compression method 0), no third-party library — the site
must work offline from disk. Store-only is not a shortcut: PNG and JPEG are
already compressed, so deflate would cost CPU for roughly one percent of size.

Required pieces: local file headers, a central directory, the end-of-central-
directory record, and CRC-32 per entry.

The archive is assembled as a `Blob` from an array of parts rather than
concatenated into one buffer, so the browser can spill to disk instead of holding
the whole archive in memory.

**ZIP64:** archives past 4 GB, or with entries past 4 GB, need the ZIP64
extension records. This will be implemented, with the field layouts verified
against the current APPNOTE specification rather than written from memory.

### Restore

1. User picks a file.
2. Sniff the first four bytes. `PK\x03\x04` means zip; otherwise parse as JSON.
3. Validate `format` and `version`. Reject anything else with a clear message.
4. Confirm with the user, naming the backup's `savedAt` date and stating plainly
   that the current contents will be replaced.
5. Clear all three stores, write the restored data, re-render from the root.

Restoring is destructive and irreversible, so the confirmation states what is
being replaced rather than asking a generic "are you sure".

### Rejected: auto-backup

CryptoFolio downloads a dated backup once a day when data has changed. That is
reasonable for a few KB of holdings and hostile at 300 MB of images.

Instead: the Backup button carries a nudge dot when data exists that has not been
written to disk since it last changed. The user presses it themselves.

## Opening and deleting

Clicking a folder navigates into it. Clicking an item opens its `url` in a new
tab; an item with no `url` opens the full-resolution image instead. Each card
carries a `⋮` menu with Edit and Delete, matching CryptoFolio's gallery cards.

Deleting a folder deletes everything inside it, recursively, including nested
folders. The confirmation states the actual count — "Delete 'Design' and the 34
items inside it?" — because a generic prompt gives no way to notice you are about
to destroy far more than you meant to. Deletion removes the matching `thumbs` and
`blobs` records in the same transaction, so no orphaned image data accumulates.

There is no undo. The backup file is the safety net, which is why the nudge dot
matters.

## Views

- **Grid** — folders first, then items. Breadcrumb bar above. Buttons for
  "New folder" and "Add images".
- **Edit modal** — thumbnail preview, title field, link field, save. Mirrors
  CryptoFolio's Edit Site modal.
- **Backup modal** — export button, restore file picker, last-backup timestamp.

Empty states name the next action rather than merely reporting emptiness.

## File layout

```
index.html      markup and view shells
styles.css      dark theme
js/tree.js      ordering, move validation, cycle guard
js/zip.js       store-only zip write and read
js/images.js    thumbnail generation, blob/data-URL conversion
js/db.js        IndexedDB open, migrations, CRUD
js/backup.js    export, format selection, import, validation
js/dnd.js       drag and drop wiring
js/ui.js        rendering, modals, object URL lifecycle
tests.html      in-browser test runner
```

`images.js` was not in the original plan. Thumbnail generation turned out to
be needed by both the add path and the restore path — restore regenerates
thumbnails rather than reading them from the backup — so leaving it inside
`ui.js` would have made `backup.js` depend on the rendering layer.

Classic `<script src>` tags, not ES modules. ES modules are blocked by CORS over
`file://`, and this site must work when `index.html` is opened directly from
disk. No build step.

## Testing

`tests.html` loads the same `js/` files and asserts against them in the browser.
No framework, no build. Coverage targets the logic that is pure and separable:

- **Ordering** — folders sort above items; renumbering after a reorder produces a
  dense sequence; ordering is scoped per parent.
- **Cycle guard** — a folder cannot move into its own descendant, at depth; a node
  cannot move into itself; legal moves are still permitted.
- **Zip writer** — a written archive parses back to the same entries, with CRC-32
  matching, including an entry large enough to exercise ZIP64.
- **Backup round-trip** — export a fixture tree, re-import it, diff the result.
  Run against both formats, asserting they produce identical trees.
- **Recursive delete** — deleting a folder removes its whole subtree and leaves
  no orphaned `thumbs` or `blobs` records behind.

The round-trip test is the one that actually guards the promise this site makes.
It should be written first.

## Implementation constraint

Per the workspace rule in `CLAUDE.md`: before writing code, search for current
official documentation on IndexedDB, the File and Blob APIs, and the ZIP APPNOTE
specification. Implement only what current documentation confirms.
