// Local-repo import via File System Access API.
// Chromium only (Chrome/Edge/Arc/Brave). Firefox/Safari: drop a `.log` dump instead.
//
// This module skips isomorphic-git entirely for the commit walk and uses our own pack-file
// reader (js/gitpack.js). The framework overhead per `git.log`/`readCommit` call was 40–80ms,
// which turned into minutes on repos with thousands of commits and hundreds of branches.

import { fastWalk } from './gitpack.js';

// --------------------------------------------------------------------------
// Alternate loader: <input type="file" webkitdirectory>
//
// Uses the standard File API (not File System Access), which has a different
// permission model in Chrome. Useful when FSA refuses specific files with
// NotReadableError — the upload path often succeeds where FSA won't.
// --------------------------------------------------------------------------

function makeUploadFsAdapter(fileMap) {
    // fileMap: Map<path (no leading slash), File>. Paths are relative to the .git dir.
    const norm = (p) => String(p).replace(/^\/+/, '');

    async function readFile(path, options) {
        const file = fileMap.get(norm(path));
        if (!file) { const e = new Error(`ENOENT: ${path}`); e.code = 'ENOENT'; throw e; }
        const buf = new Uint8Array(await file.arrayBuffer());
        const enc = options && (options.encoding || options);
        return enc === 'utf8' ? new TextDecoder().decode(buf) : buf;
    }
    async function readdir(path) {
        const prefix = norm(path) + '/';
        const names = new Set();
        for (const key of fileMap.keys()) {
            if (key.startsWith(prefix)) {
                const rest = key.slice(prefix.length);
                const first = rest.split('/')[0];
                if (first) names.add(first);
            }
        }
        if (!names.size && !fileMap.has(norm(path))) {
            const e = new Error(`ENOENT: ${path}`); e.code = 'ENOENT'; throw e;
        }
        return [...names];
    }
    async function stat(path) {
        const key = norm(path);
        if (fileMap.has(key)) return { isFile: () => true, isDirectory: () => false };
        // Check if any file starts with this path as a directory prefix.
        const prefix = key + '/';
        for (const k of fileMap.keys()) {
            if (k.startsWith(prefix)) return { isFile: () => false, isDirectory: () => true };
        }
        const e = new Error(`ENOENT: ${path}`); e.code = 'ENOENT'; throw e;
    }
    async function getFile(path) {
        const file = fileMap.get(norm(path));
        if (!file) { const e = new Error(`ENOENT: ${path}`); e.code = 'ENOENT'; throw e; }
        return file;
    }
    async function getFileHandle(path) {
        const file = await getFile(path);
        return { getFile: async () => file };
    }

    return {
        readFile, readdir, stat, getFile, getFileHandle,
        invalidate: () => {},
        readBlobBytes: async (blob) => new Uint8Array(await blob.arrayBuffer())
    };
}

export async function pickLocalRepoViaUpload({ onProgress = () => {}, maxCommits = 500000 } = {}) {
    onProgress('Waiting for folder…');
    const files = await new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.webkitdirectory = true;
        input.multiple = true;
        input.style.display = 'none';
        document.body.appendChild(input);
        input.addEventListener('change', () => {
            const list = [...(input.files || [])];
            document.body.removeChild(input);
            if (!list.length) reject(new Error('No files selected'));
            else resolve(list);
        });
        input.click();
    });

    // webkitdirectory enumerates the ENTIRE tree — working copy + .git contents. For a
    // repo like M that's 200k+ files, of which we need ~2000 under .git. Filter first so
    // the rest of the pipeline only sees what matters.
    onProgress(`Filtering ${files.length} files…`);
    const gitFiles = files.filter(f => {
        const rel = f.webkitRelativePath || f.name;
        return rel.includes('/.git/') || rel.startsWith('.git/');
    });
    if (!gitFiles.length) {
        throw new Error("No .git directory found. Make sure hidden files are visible in the picker (⌘⇧. on macOS) and pick the folder containing .git.");
    }

    // Build path → File map keyed relative to the .git directory. For files small enough
    // to slurp, clone via arrayBuffer + new File([bytes]) right now. Cloning immediately
    // after pick snapshots the bytes before Chrome's sandbox revokes access (a timing
    // quirk several people have hit). Big files stay as the original File reference and
    // are read per-slice during the walk.
    const CLONE_LIMIT = 50 * 1024 * 1024;
    const fileMap = new Map();
    let repoName = '(local repo)';
    let cloned = 0, cloneFailed = 0;
    onProgress(`Snapshotting ${gitFiles.length} .git files…`);
    for (const f of gitFiles) {
        const rel = f.webkitRelativePath || f.name;
        const parts = rel.split('/');
        const gitIdx = parts.indexOf('.git');
        let gitDirPath;
        if (gitIdx >= 0) {
            if (gitIdx > 0) repoName = parts[0];
            gitDirPath = parts.slice(gitIdx + 1).join('/');
        } else {
            gitDirPath = parts.slice(1).join('/');
        }
        if (!gitDirPath) continue;
        let ref = f;
        if (f.size < CLONE_LIMIT) {
            try {
                const buf = await f.arrayBuffer();
                ref = new File([buf], f.name, { type: f.type });
                cloned++;
            } catch (_) {
                // Clone failed; keep original ref. Stream fallback will try later.
                cloneFailed++;
            }
        }
        fileMap.set(gitDirPath, ref);
    }
    onProgress(`Cloned ${cloned} files (${cloneFailed} failed); ${gitFiles.length - cloned - cloneFailed} streaming`);
    if (!fileMap.has('HEAD')) {
        throw new Error(`Filtered ${gitFiles.length} .git files but no HEAD. Is this a valid git repo?`);
    }

    const fs = makeUploadFsAdapter(fileMap);
    const { commits, refs } = await fastWalk({ fs, gitdir: '', onProgress, maxCommits });
    const branches = Object.keys(refs || {})
        .filter(k => k.startsWith('refs/heads/'))
        .map(k => ({ name: k.slice('refs/heads/'.length), sha: refs[k] }));
    return { commits, branches, name: repoName };
}

export function hasDirectoryPicker() {
    return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

function makeFsAdapter(rootHandle) {
    const dirCache = new Map();
    const fileCache = new Map();
    const readInFlight = new Map();

    const toParts = (path) => String(path).split('/').filter(p => p && p !== '.');

    async function resolveDir(parts) {
        const key = parts.join('/');
        const cached = dirCache.get(key);
        if (cached) return cached;
        let h = rootHandle;
        for (const p of parts) h = await h.getDirectoryHandle(p);
        dirCache.set(key, h);
        return h;
    }

    function enoent(path) {
        const err = new Error(`ENOENT: ${path}`);
        err.code = 'ENOENT';
        return err;
    }

    async function readFileBytes(path) {
        const parts = toParts(path);
        if (!parts.length) throw enoent(path);
        const parent = await resolveDir(parts.slice(0, -1));
        const fh = await parent.getFileHandle(parts[parts.length - 1]);
        const file = await fh.getFile();
        return readBlobBytes(file);
    }

    // Chrome's Blob.arrayBuffer() can throw NotReadableError on specific files (esp.
    // larger ones or files with macOS provenance markers). Different read APIs hit
    // different code paths internally — one usually works even when another refuses.
    // We try them in order from fastest to slowest.
    async function readBlobBytes(blob) {
        const errors = [];
        // 1. Direct arrayBuffer — fastest when it works.
        try { return new Uint8Array(await blob.arrayBuffer()); }
        catch (e) { errors.push('arrayBuffer: ' + (e.message || e.name)); }

        // Strategies 2-4 all accumulate chunks into a single contiguous Uint8Array. For
        // large blobs (hundreds of MB) that concat itself OOMs. Bail out on big blobs —
        // the caller must stream per-object instead.
        const SAFE_CONCAT = 50 * 1024 * 1024;
        if (blob.size > SAFE_CONCAT) {
            const err = new Error(`Blob ${(blob.size / 1048576).toFixed(0)}MB too large for concat read`);
            err.name = 'NotReadableError';
            throw err;
        }

        // 2. ReadableStream — a separate Chrome code path that handles some files
        //    where the atomic read fails. Reads in chunks, no big one-shot allocation.
        try {
            const reader = blob.stream().getReader();
            const chunks = [];
            let total = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                total += value.length;
            }
            const out = new Uint8Array(total);
            let p = 0;
            for (const c of chunks) { out.set(c, p); p += c.length; }
            return out;
        } catch (e) { errors.push('stream: ' + (e.message || e.name)); }

        // 3. Legacy FileReader — predates Blob.arrayBuffer; different internal path.
        try {
            return await new Promise((resolve, reject) => {
                const fr = new FileReader();
                fr.onload = () => resolve(new Uint8Array(fr.result));
                fr.onerror = () => reject(fr.error || new Error('FileReader failed'));
                fr.readAsArrayBuffer(blob);
            });
        } catch (e) { errors.push('FileReader: ' + (e.message || e.name)); }

        // 4. Slice into chunks and arrayBuffer each. Sometimes 256KB slices succeed
        //    where the whole-file read refuses.
        try {
            const CHUNK = 256 * 1024;
            const out = new Uint8Array(blob.size);
            let p = 0;
            for (let off = 0; off < blob.size; off += CHUNK) {
                const end = Math.min(off + CHUNK, blob.size);
                const bytes = new Uint8Array(await blob.slice(off, end).arrayBuffer());
                out.set(bytes, p);
                p += bytes.length;
            }
            return out;
        } catch (e) { errors.push('chunked: ' + (e.message || e.name)); }

        const err = new Error('All read strategies failed: ' + errors.join('; '));
        err.name = 'NotReadableError';
        throw err;
    }

    async function readFile(path, options) {
        try {
            let buf = fileCache.get(path);
            if (!buf) {
                let p = readInFlight.get(path);
                if (!p) {
                    p = readFileBytes(path);
                    readInFlight.set(path, p);
                }
                buf = await p;
                fileCache.set(path, buf);
                readInFlight.delete(path);
            }
            const enc = options && (options.encoding || options);
            if (enc === 'utf8') return new TextDecoder().decode(buf);
            return buf;
        } catch (e) {
            readInFlight.delete(path);
            if (e.name === 'NotFoundError' || e.name === 'TypeMismatchError') throw enoent(path);
            throw e;
        }
    }

    // Resolve a File object for a path without reading its contents.
    async function getFile(path) {
        const parts = toParts(path);
        if (!parts.length) throw enoent(path);
        const parent = await resolveDir(parts.slice(0, -1));
        const fh = await parent.getFileHandle(parts[parts.length - 1]);
        return fh.getFile();
    }

    // Resolve the raw FileHandle for a path. gitpack uses this to re-fetch a fresh File
    // on each slice read — File snapshots go stale as the browser's internal handles
    // expire, which otherwise leaves big repos walkable only up to a few hundred commits.
    async function getFileHandle(path) {
        const parts = toParts(path);
        if (!parts.length) throw enoent(path);
        const parent = await resolveDir(parts.slice(0, -1));
        return parent.getFileHandle(parts[parts.length - 1]);
    }

    async function readdir(path) {
        try {
            const h = await resolveDir(toParts(path));
            const names = [];
            for await (const name of h.keys()) names.push(name);
            return names;
        } catch (e) {
            if (e.name === 'NotFoundError' || e.name === 'TypeMismatchError') throw enoent(path);
            throw e;
        }
    }

    async function stat(path) {
        const parts = toParts(path);
        if (!parts.length) return { isDirectory: () => true, isFile: () => false };
        try {
            const parent = await resolveDir(parts.slice(0, -1));
            const last = parts[parts.length - 1];
            try {
                await parent.getFileHandle(last);
                return { isDirectory: () => false, isFile: () => true };
            } catch (_) {
                await parent.getDirectoryHandle(last);
                return { isDirectory: () => true, isFile: () => false };
            }
        } catch (e) {
            if (e.name === 'NotFoundError' || e.name === 'TypeMismatchError') throw enoent(path);
            throw e;
        }
    }

    // Drop cached handles/contents for a path so the next read re-traverses from root.
    // Used by callers to recover from transient NotReadableError.
    function invalidate(path) {
        fileCache.delete(path);
        readInFlight.delete(path);
        // Clear all ancestor directory caches — any of them could have stale handles.
        const parts = toParts(path);
        for (let i = 0; i <= parts.length; i++) {
            dirCache.delete(parts.slice(0, i).join('/'));
        }
    }

    return {
        readFile, readdir, stat, getFile, getFileHandle, invalidate,
        readBlobBytes,
        _stats: () => ({
            dirCacheSize: dirCache.size,
            fileCacheSize: fileCache.size,
            fileCacheBytes: [...fileCache.values()].reduce((s, b) => s + b.byteLength, 0)
        })
    };
}

/** Ask the user to pick a folder and walk its commit graph. */
export async function pickLocalRepo({ onProgress = () => {}, maxCommits = 500000 } = {}) {
    if (!hasDirectoryPicker()) {
        throw new Error("Your browser doesn't support local folder pickers (Chrome/Edge only). Use the JSON import instead.");
    }
    onProgress('Waiting for folder…');
    const rootHandle = await window.showDirectoryPicker({ mode: 'read' });

    // Either the user picked the working tree (contains .git) or a bare .git folder itself.
    let gitHandle;
    try {
        gitHandle = await rootHandle.getDirectoryHandle('.git');
    } catch (_) {
        try {
            await rootHandle.getDirectoryHandle('objects');
            await rootHandle.getDirectoryHandle('refs');
            gitHandle = rootHandle;
        } catch (_) {
            throw new Error("That folder isn't a git repo (no .git, no objects/+refs/).");
        }
    }

    const fs = makeFsAdapter(gitHandle);
    const { commits, refs } = await fastWalk({
        fs, gitdir: '', onProgress, maxCommits
    });

    // Branch names from refs/heads/*; we drop the 'refs/heads/' prefix for display.
    const branches = Object.keys(refs || {})
        .filter(k => k.startsWith('refs/heads/'))
        .map(k => ({ name: k.slice('refs/heads/'.length), sha: refs[k] }));

    return { commits, branches, name: rootHandle.name };
}
