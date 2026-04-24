// Local-repo import via File System Access API.
// Chromium only (Chrome/Edge/Arc/Brave). Firefox/Safari: drop a `.log` dump instead.
//
// This module skips isomorphic-git entirely for the commit walk and uses our own pack-file
// reader (js/gitpack.js). The framework overhead per `git.log`/`readCommit` call was 40–80ms,
// which turned into minutes on repos with thousands of commits and hundreds of branches.

import { fastWalk } from './gitpack.js';

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
        return new Uint8Array(await file.arrayBuffer());
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

    // Resolve a File object for a path without reading its contents. gitpack uses this to
    // hold references to large pack files (hundreds of MB) and slice them on demand rather
    // than loading the whole thing into RAM.
    async function getFile(path) {
        const parts = toParts(path);
        if (!parts.length) throw enoent(path);
        const parent = await resolveDir(parts.slice(0, -1));
        const fh = await parent.getFileHandle(parts[parts.length - 1]);
        return fh.getFile();
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

    return {
        readFile, readdir, stat, getFile,
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
