// Direct pack-file reader. Bypasses isomorphic-git for the hot path (listing commits across
// every ref) because isomorphic-git's per-call framework overhead is ~40–80ms per commit —
// fine for a handful of calls, murder for 10K commits.
//
// We only implement the bits we need: pack idx v2, object headers, zlib inflate via pako,
// OFS_DELTA / REF_DELTA, commit parsing, annotated-tag target extraction. Everything else
// (trees, blobs, worktree state) we never touch.
//
// Reference: https://git-scm.com/docs/pack-format

import pako from 'https://esm.sh/pako@2.1.0';

const OBJ_TYPE = {
    1: 'commit',
    2: 'tree',
    3: 'blob',
    4: 'tag',
    6: 'ofs_delta',
    7: 'ref_delta'
};

function bytesToHex(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) {
        s += bytes[i].toString(16).padStart(2, '0');
    }
    return s;
}

function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
}

// -------- Pack index v2 parser --------
// v2 layout:
//   magic:   4 bytes = 0xff 0x74 0x4f 0x63
//   version: 4 bytes = 0x00000002
//   fanout:  256 * 4 bytes
//   sha1s:   N * 20 bytes (sorted)
//   crc32s:  N * 4 bytes
//   offs32:  N * 4 bytes (high bit = index into offs64)
//   offs64:  M * 8 bytes (only if any offs32 has high bit set)
//   pack checksum: 20 bytes
//   idx checksum:  20 bytes
export function parseIdx(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (dv.getUint32(0) !== 0xff744f63 || dv.getUint32(4) !== 2) {
        throw new Error('Pack index is not v2 (unsupported)');
    }
    let p = 8;
    const fanout = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { fanout[i] = dv.getUint32(p); p += 4; }
    const count = fanout[255];

    const sha1s = buf.subarray(p, p + count * 20);
    p += count * 20;
    p += count * 4; // skip crc32s

    const offs32 = new Uint32Array(count);
    for (let i = 0; i < count; i++) { offs32[i] = dv.getUint32(p); p += 4; }

    let offs64 = null;
    const has64 = offs32.some(o => o & 0x80000000);
    if (has64) {
        // Remaining bytes before final 40 are the 64-bit offsets.
        const available = buf.length - p - 40;
        const n64 = Math.floor(available / 8);
        offs64 = new Array(n64);
        for (let i = 0; i < n64; i++) {
            const hi = dv.getUint32(p); p += 4;
            const lo = dv.getUint32(p); p += 4;
            offs64[i] = hi * 0x100000000 + lo;
        }
    }

    const oidToOffset = new Map();
    for (let i = 0; i < count; i++) {
        const hex = bytesToHex(sha1s.subarray(i * 20, (i + 1) * 20));
        let off = offs32[i];
        if (off & 0x80000000) {
            off = offs64[off & 0x7fffffff];
        }
        oidToOffset.set(hex, off);
    }
    return { count, oidToOffset };
}

// -------- zlib inflation --------
// pako 2.x refuses to inflate when the input extends past the zlib stream end with non-zero
// trailing bytes (which is exactly what pack files have — the next object starts right after).
// So we always pass exact [start, end) bounds, precomputed from the sorted idx offsets.
export function inflateRange(pack, start, end) {
    return pako.inflate(pack.subarray(start, end));
}

// -------- Pack object reader --------
// Header varint: first byte: [continue(1)] [type(3)] [size-low(4)]
// Continuation bytes: [continue(1)] [size(7)]
function readObjectHeader(pack, offset) {
    let p = offset;
    let byte = pack[p++];
    const type = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
        byte = pack[p++];
        size |= (byte & 0x7f) << shift;
        shift += 7;
    }
    return { type, size, headerEnd: p };
}

// Negative varint used for OFS_DELTA. This encoding is subtle: each continuation adds 1
// to accumulated value (so there's no ambiguity for multi-byte sequences).
function readOfsDelta(pack, offset) {
    let p = offset;
    let byte = pack[p++];
    let n = byte & 0x7f;
    while (byte & 0x80) {
        n += 1;
        byte = pack[p++];
        n = (n << 7) | (byte & 0x7f);
    }
    return { value: n, end: p };
}

// Pack content access. Three modes, tried in order:
//   1. pack.trimmedBytes (Map<offset, Uint8Array>) — only commit/tag/delta-chain bytes;
//      populated after extractInterestingBytes() dropped the full pack buffer. Most repos.
//   2. pack.bytes (Uint8Array) — full pack in memory, slice on demand. Never hit in the
//      common path unless trimming was skipped.
//   3. pack.getFile() — streaming fallback when whole-file read failed.
export async function readObjectAt(pack, offset, ctx) {
    const cache = ctx.cache;
    const cacheKey = pack.packId + ':' + offset;
    if (cache) {
        const hit = cache.get(cacheKey);
        if (hit) return hit;
    }
    const objEnd = ctx.endOf.get(offset);
    if (objEnd === undefined) throw new Error(`No end bound known for offset ${offset}`);

    let sliceBytes;
    if (pack.trimmedBytes && pack.trimmedBytes.has(offset)) {
        sliceBytes = pack.trimmedBytes.get(offset);
    } else if (pack.bytes) {
        sliceBytes = pack.bytes.subarray(offset, objEnd);
    } else {
        const file = await pack.getFile();
        // Direct slice + arrayBuffer — the diagnostic confirmed this is the cleanest
        // path that doesn't trip Chrome's OOM heuristic via fallback buffers.
        sliceBytes = new Uint8Array(await file.slice(offset, objEnd).arrayBuffer());
    }
    const hdr = readObjectHeader(sliceBytes, 0);
    const typeName = OBJ_TYPE[hdr.type];
    if (!typeName) throw new Error(`Unknown object type ${hdr.type} at offset ${offset}`);

    let result;
    if (typeName === 'ofs_delta') {
        const { value: rel, end: afterOfs } = readOfsDelta(sliceBytes, hdr.headerEnd);
        const baseOffset = offset - rel;
        const base = await readObjectAt(pack, baseOffset, ctx);
        const delta = inflateRange(sliceBytes, afterOfs, sliceBytes.length);
        result = { type: base.type, data: applyDelta(base.data, delta) };
    } else if (typeName === 'ref_delta') {
        const baseOid = bytesToHex(sliceBytes.subarray(hdr.headerEnd, hdr.headerEnd + 20));
        const entry = ctx.oidToPack && ctx.oidToPack.get(baseOid);
        if (!entry) throw new Error(`REF_DELTA base missing: ${baseOid}`);
        const base = await readObjectAt(entry, entry.offset, {
            oidToPack: ctx.oidToPack, cache, endOf: entry.endOf,
            readBlobBytes: ctx.readBlobBytes
        });
        const delta = inflateRange(sliceBytes, hdr.headerEnd + 20, sliceBytes.length);
        result = { type: base.type, data: applyDelta(base.data, delta) };
    } else {
        result = {
            type: typeName,
            data: inflateRange(sliceBytes, hdr.headerEnd, sliceBytes.length)
        };
    }
    if (cache) {
        cache.set(cacheKey, result);
        // Very light cap so decoded delta bases don't accumulate unboundedly.
        if (cache.size > 4000) {
            const victim = cache.keys().next().value;
            cache.delete(victim);
        }
    }
    return result;
}

// Git delta: two varints (src size, dst size), then a stream of copy/insert instructions.
//   copy: cmd & 0x80 set. bits 0-3 select offset bytes (LE), bits 4-6 select size bytes.
//         size=0 is implicit 0x10000.
//   insert: cmd & 0x80 unset. cmd bits 0-6 = length; read that many literal bytes.
export function applyDelta(base, delta) {
    let p = 0;
    function varint() {
        let n = 0, shift = 0, b;
        do {
            b = delta[p++];
            n |= (b & 0x7f) << shift;
            shift += 7;
        } while (b & 0x80);
        return n;
    }
    const srcSize = varint(); void srcSize;
    const dstSize = varint();
    const out = new Uint8Array(dstSize);
    let outPos = 0;

    while (p < delta.length) {
        const cmd = delta[p++];
        if (cmd & 0x80) {
            let copyOff = 0, copyLen = 0;
            if (cmd & 0x01) copyOff |= delta[p++];
            if (cmd & 0x02) copyOff |= delta[p++] << 8;
            if (cmd & 0x04) copyOff |= delta[p++] << 16;
            if (cmd & 0x08) copyOff |= delta[p++] << 24;
            if (cmd & 0x10) copyLen |= delta[p++];
            if (cmd & 0x20) copyLen |= delta[p++] << 8;
            if (cmd & 0x40) copyLen |= delta[p++] << 16;
            if (copyLen === 0) copyLen = 0x10000;
            out.set(base.subarray(copyOff, copyOff + copyLen), outPos);
            outPos += copyLen;
        } else if (cmd > 0) {
            out.set(delta.subarray(p, p + cmd), outPos);
            p += cmd;
            outPos += cmd;
        } else {
            throw new Error('Invalid delta instruction (cmd=0)');
        }
    }
    return out;
}

// -------- Commit + tag object parsing --------
export function parseCommit(data) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(data);
    const nl2 = text.indexOf('\n\n');
    const header = nl2 >= 0 ? text.slice(0, nl2) : text;
    const message = nl2 >= 0 ? text.slice(nl2 + 2) : '';
    const parents = [];
    let tree = null, author = null;
    for (const line of header.split('\n')) {
        if (line.startsWith('tree ')) tree = line.slice(5);
        else if (line.startsWith('parent ')) parents.push(line.slice(7));
        else if (line.startsWith('author ')) author = parsePerson(line.slice(7));
    }
    return { tree, parents, author, message };
}

function parsePerson(s) {
    const m = s.match(/^(.*?) <([^>]*)> (\d+) ([+-]?\d+)$/);
    if (!m) return { name: s, email: '', timestamp: 0, tz: '+0000' };
    return { name: m[1], email: m[2], timestamp: parseInt(m[3], 10), tz: m[4] };
}

// Annotated tag object: "object <oid>\ntype commit\n..."
export function parseTag(data) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(data);
    const m = text.match(/^object ([0-9a-f]{40})/m);
    return m ? { target: m[1] } : null;
}

// -------- Loose objects --------
export async function readLooseObject(fs, gitdir, oid) {
    const path = `${gitdir}/objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
    const buf = await fs.readFile(path);
    const inflator = new pako.Inflate();
    inflator.push(buf);
    if (inflator.err && (!inflator.result || inflator.result.length === 0)) {
        throw new Error(`loose object inflate failed: ${oid}`);
    }
    const data = inflator.result;
    let nul = 0;
    while (nul < data.length && data[nul] !== 0) nul++;
    const header = new TextDecoder().decode(data.subarray(0, nul));
    const type = header.split(' ')[0];
    return { type, data: data.subarray(nul + 1) };
}

// -------- Ref loading --------
// Uses iterator-based directory access (matching the file-read diagnostic) to avoid the
// many parent.getFileHandle(name) re-lookup calls that seem to make Chrome's FSA refuse
// subsequent pack reads on certain repos.
export async function readAllRefs(fs, gitdir) {
    const refs = Object.create(null);
    const decode = (buf) => new TextDecoder().decode(buf);

    // Recursively walk a refs subdir using iterDirectory. Each file's bytes come from
    // the iterator-cached File, no path-based re-lookup.
    async function walkRefs(relDir, prefix) {
        let entries = [];
        try { entries = await fs.iterDirectory(`${gitdir}/${relDir}`); }
        catch (_) { return; }
        for (const e of entries) {
            if (e.kind === 'directory') {
                await walkRefs(`${relDir}/${e.name}`, `${prefix}${e.name}/`);
            } else if (e.kind === 'file') {
                try {
                    const file = await e.getFile();
                    const text = decode(new Uint8Array(await file.arrayBuffer())).trim();
                    if (/^[0-9a-f]{40}$/.test(text)) refs[`${prefix}${e.name}`] = text;
                } catch (_) {}
            }
        }
    }
    await walkRefs('refs/heads', 'refs/heads/');
    await walkRefs('refs/tags', 'refs/tags/');
    await walkRefs('refs/remotes', 'refs/remotes/');

    // packed-refs and HEAD live at the top of gitdir. Iterate the gitdir once, find them.
    try {
        const top = await fs.iterDirectory(gitdir);
        for (const e of top) {
            if (e.kind !== 'file') continue;
            if (e.name === 'packed-refs') {
                try {
                    const file = await e.getFile();
                    const text = decode(new Uint8Array(await file.arrayBuffer()));
                    for (const rawLine of text.split('\n')) {
                        const line = rawLine.trim();
                        if (!line || line.startsWith('#') || line.startsWith('^')) continue;
                        const sp = line.indexOf(' ');
                        if (sp < 0) continue;
                        const oid = line.slice(0, sp);
                        const name = line.slice(sp + 1);
                        if (/^[0-9a-f]{40}$/.test(oid)) refs[name] = oid;
                    }
                } catch (_) {}
            } else if (e.name === 'HEAD') {
                try {
                    const file = await e.getFile();
                    const head = decode(new Uint8Array(await file.arrayBuffer())).trim();
                    if (head.startsWith('ref: ')) {
                        const target = head.slice(5).trim();
                        if (refs[target]) refs['HEAD'] = refs[target];
                    } else if (/^[0-9a-f]{40}$/.test(head)) {
                        refs['HEAD'] = head;
                    }
                } catch (_) {}
            }
        }
    } catch (_) {}

    const tips = [...new Set(Object.values(refs))];
    return { refs, tips };
}

// After loading a full pack buffer, walk the idx offsets and classify each object.
// Anything that's a commit, tag, or delta-chain that ultimately resolves to one of those,
// we copy into a slim Map<offset, Uint8Array>. Everything else (trees, blobs — the bulk of
// a pack) is discarded. For typical source repos this shrinks ~880MB down to a few MB.
//
// Delta-chain logic: OFS_DELTA stores offset_from_current; REF_DELTA stores base oid. We
// follow until we hit a non-delta object and keep if that's commit or tag.
function extractInterestingBytes(packBytes, oidToOffset, endOf) {
    // Pass 1: classify each object's immediate shape.
    // meta[offset] = { type, baseOffset? , baseOid? }
    const meta = new Map();
    for (const offset of oidToOffset.values()) {
        try {
            const hdr = readObjectHeader(packBytes, offset);
            const entry = { type: hdr.type };
            if (hdr.type === 6) { // OFS_DELTA
                const { value: rel } = readOfsDelta(packBytes, hdr.headerEnd);
                entry.baseOffset = offset - rel;
            } else if (hdr.type === 7) { // REF_DELTA
                entry.baseOid = bytesToHex(packBytes.subarray(hdr.headerEnd, hdr.headerEnd + 20));
            }
            meta.set(offset, entry);
        } catch (_) {
            meta.set(offset, { type: -1 });
        }
    }

    // Pass 2: resolve which offsets ultimately produce commits or tags. Memoized.
    const verdict = new Map(); // offset → bool (keep or not)
    function resolves(offset, visited) {
        if (verdict.has(offset)) return verdict.get(offset);
        if (visited.has(offset)) return false; // cycle guard
        visited.add(offset);
        const m = meta.get(offset);
        if (!m) { verdict.set(offset, false); return false; }
        let v;
        if (m.type === 1 || m.type === 4) v = true;       // commit or tag
        else if (m.type === 2 || m.type === 3) v = false; // tree or blob
        else if (m.type === 6) v = resolves(m.baseOffset, visited);
        else if (m.type === 7) {
            const baseOff = oidToOffset.get(m.baseOid);
            v = baseOff !== undefined ? resolves(baseOff, visited) : true; // assume keep if cross-pack
        } else v = false;
        verdict.set(offset, v);
        return v;
    }
    for (const offset of oidToOffset.values()) resolves(offset, new Set());

    // Pass 3: copy just the kept bytes into a fresh Map. slice() produces a copy so the
    // original pack buffer can be freed. We also include all delta ancestors of each kept
    // object (we need them to resolve deltas) — many are already in keep set, but some
    // non-commit bases of commit deltas aren't classified as commits themselves.
    const trimmed = new Map();
    const addWithAncestors = (offset, seen) => {
        if (trimmed.has(offset) || seen.has(offset)) return;
        seen.add(offset);
        const end = endOf.get(offset);
        if (end === undefined) return;
        // slice() copies; subarray would keep the whole buffer alive.
        trimmed.set(offset, packBytes.slice(offset, end));
        const m = meta.get(offset);
        if (!m) return;
        if (m.type === 6) addWithAncestors(m.baseOffset, seen);
        else if (m.type === 7) {
            const baseOff = oidToOffset.get(m.baseOid);
            if (baseOff !== undefined) addWithAncestors(baseOff, seen);
        }
    };
    for (const offset of oidToOffset.values()) {
        if (verdict.get(offset)) addWithAncestors(offset, new Set());
    }
    return trimmed;
}

// -------- Load all pack indexes + pack File handles --------
// Indexes are read into memory (they're small). Pack content is kept as a File reference
// and sliced per-object inside readObjectAt — we never hold a 500MB pack in RAM.
export async function loadPacks(fs, gitdir, onProgress) {
    const packDir = `${gitdir}/objects/pack`;
    // Use iterator-based directory access (.values() under the hood). This pattern
    // succeeds where path-based re-lookup (parent.getFileHandle(name)) fails, per the
    // file-read diagnostic at /diag/. Each iter entry's .getFile() works reliably.
    let dirEntries = [];
    try { dirEntries = await fs.iterDirectory(packDir); }
    catch (_) { return { oidToPack: new Map(), packs: [], failed: [] }; }
    const handlesByName = new Map();
    for (const e of dirEntries) {
        if (e.kind === 'file') handlesByName.set(e.name, e);
    }
    const oidToPack = new Map();
    const packs = [];
    const failed = [];
    let packId = 0;
    for (const [name, idxEntry] of handlesByName) {
        if (!name.endsWith('.idx')) continue;
        const base = name.slice(0, -4);
        const packEntry = handlesByName.get(base + '.pack');
        if (!packEntry) continue;
        const idxPath = `${packDir}/${name}`;
        const packPath = `${packDir}/${base}.pack`;
        try {
            // Use the strong File ref on the entry — kept alive so Chrome doesn't GC it
            // between iteration and read.
            const idxFile = idxEntry.file || await idxEntry.getFile();
            const idxBuf = new Uint8Array(await idxFile.arrayBuffer());
            const fh = packEntry;
            const sizeProbe = await fh.getFile();
            const { oidToOffset } = parseIdx(idxBuf);
            // Free the idx buffer from the adapter cache — we've extracted everything we
            // need into oidToOffset, and the idx bytes (up to a few MB each) would
            // otherwise sit in memory for the life of the walk.
            if (typeof fs.invalidate === 'function') fs.invalidate(idxPath);
            const offsets = [...oidToOffset.values()].sort((a, b) => a - b);
            const endOf = new Map();
            const packEnd = sizeProbe.size - 20;
            for (let i = 0; i < offsets.length; i++) {
                const nextEnd = i + 1 < offsets.length ? offsets[i + 1] : packEnd;
                endOf.set(offsets[i], nextEnd);
            }
            const thisPackId = packId++;
            // Try to read the whole pack into memory *only* if it's small enough that
            // concatenating into a single Uint8Array is safe. A 500MB pack file via
            // arrayBuffer() allocates 500MB contiguously and crashes Chrome's heuristic.
            // For big packs we go straight to per-object streaming.
            const WHOLE_PACK_LIMIT = 80 * 1024 * 1024;
            let trimmedBytes = null;
            const probeFile = packEntry.file || await fh.getFile();
            if (probeFile.size < WHOLE_PACK_LIMIT) {
                try {
                    let packBytes = new Uint8Array(await probeFile.arrayBuffer());
                    const origSize = packBytes.length;
                    trimmedBytes = extractInterestingBytes(packBytes, oidToOffset, endOf);
                    let trimmedSize = 0;
                    for (const b of trimmedBytes.values()) trimmedSize += b.length;
                    packBytes = null; // let the full buffer GC
                    if (onProgress) {
                        onProgress(`Trimmed pack ${base.slice(5, 13)}…: ` +
                            `${(origSize / 1048576).toFixed(1)}MB → ${(trimmedSize / 1048576).toFixed(2)}MB ` +
                            `(${trimmedBytes.size} commit-ish objects)`);
                    }
                } catch (e) {
                    console.warn('whole-pack read failed, falling back to streaming', base, e.message || e);
                }
            } else if (onProgress) {
                onProgress(`Streaming pack ${base.slice(5, 13)}… (${(probeFile.size / 1048576).toFixed(0)}MB, too big to load whole)`);
            }

            let currentFh = fh;
            const getFreshFile = async () => {
                try { return await currentFh.getFile(); }
                catch (e) {
                    if (fs.getFileHandle) {
                        currentFh = await fs.getFileHandle(packPath);
                        return currentFh.getFile();
                    }
                    throw e;
                }
            };
            // Prefer trimmed bytes; fall back to streaming for any object we didn't keep
            // (e.g. a commit that delta-chains to a non-kept base across packs).
            const packRef = trimmedBytes
                ? { trimmedBytes, getFile: getFreshFile, packId: thisPackId, endOf }
                : { getFile: getFreshFile, packId: thisPackId, endOf };
            for (const [oid, off] of oidToOffset) {
                oidToPack.set(oid, { ...packRef, offset: off });
            }
            packs.push(packRef);
        } catch (e) {
            console.warn('pack load failed', name, e.message || e);
            failed.push(name);
            if (onProgress) onProgress(`Skipped pack ${name.slice(5, 13)}… (unreadable); continuing`);
        }
    }
    return { oidToPack, packs, failed };
}

// -------- Fast commit walk --------
// Returns [{ sha, parents, author, email, date, message }, ...] newest-first.
export async function fastWalk({ fs, gitdir, onProgress = () => {}, maxCommits = 500000, yieldEvery = 500 }) {
    // Load packs FIRST. Reading lots of ref files first (~500 on a branchy repo) seems
    // to put Chrome's FSA into a state where subsequent pack reads fail with
    // NotReadableError. The diagnostic at /diag/ confirmed pack reads work in isolation.
    onProgress('Loading pack indexes…');
    const { oidToPack, failed } = await loadPacks(fs, gitdir, onProgress);
    if (failed && failed.length) {
        onProgress(`${failed.length} pack${failed.length === 1 ? '' : 's'} unreadable — history may be incomplete. Use the git-log one-liner for a full walk.`);
    }

    onProgress('Reading refs…');
    const { refs, tips } = await readAllRefs(fs, gitdir);

    const commits = new Map();      // oid → parsed commit
    const dereffed = new Set();     // oids we've attempted, to short-circuit
    const decodeCache = new Map();  // pack offset → decoded object (for delta chain reuse)
    const queue = [...tips];
    const t0 = performance.now();
    let walkedSinceYield = 0;

    const CONCURRENCY = 16;

    const stats = { packReads: 0, packFails: 0, looseReads: 0, looseFails: 0 };

    const resolveOne = async (oid) => {
        const entry = oidToPack.get(oid);
        if (entry) {
            try {
                const r = await readObjectAt(entry, entry.offset, {
                    oidToPack, cache: decodeCache, endOf: entry.endOf,
                    readBlobBytes: fs.readBlobBytes
                });
                stats.packReads++;
                return r;
            } catch (e) {
                stats.packFails++;
                // Fall through to loose object read — the oid might also exist loose.
                if (stats.packFails <= 3) console.warn('pack read fail', oid, e.message);
            }
        }
        try {
            const r = await readLooseObject(fs, gitdir, oid);
            stats.looseReads++;
            return r;
        } catch (_) {
            stats.looseFails++;
            return null;
        }
    };

    while (queue.length && commits.size < maxCommits) {
        // Pull a batch off the queue, dispatch reads in parallel.
        const batch = [];
        while (batch.length < CONCURRENCY && queue.length && commits.size + batch.length < maxCommits) {
            const oid = queue.pop();
            if (commits.has(oid) || dereffed.has(oid)) continue;
            dereffed.add(oid); // reserve so dup oids in queue don't race-dispatch
            batch.push(oid);
        }
        if (!batch.length) continue;

        const results = await Promise.all(batch.map(oid =>
            resolveOne(oid).catch(err => { console.warn('pack read failed', oid, err); return null; })
        ));

        for (let i = 0; i < batch.length; i++) {
            const oid = batch[i];
            const obj = results[i];
            if (!obj) continue;
            if (obj.type === 'tag') {
                const t = parseTag(obj.data);
                if (t && t.target && !commits.has(t.target)) queue.push(t.target);
            } else if (obj.type === 'commit') {
                // Un-reserve — we found a real commit for this oid.
                dereffed.delete(oid);
                const c = parseCommit(obj.data);
                commits.set(oid, { oid, commit: c });
                for (const p of c.parents) if (!commits.has(p) && !dereffed.has(p)) queue.push(p);
            }
        }

        walkedSinceYield += batch.length;
        if (walkedSinceYield >= yieldEvery) {
            walkedSinceYield = 0;
            const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
            onProgress(`${commits.size} commits walked (${elapsed}s)…`);
            await new Promise(r => setTimeout(r, 0));
        }
    }

    const elapsedTotal = ((performance.now() - t0) / 1000).toFixed(1);
    onProgress(`Walked ${commits.size} commits in ${elapsedTotal}s.`);
    console.log(`[gitpack] commits=${commits.size} packReads=${stats.packReads} ` +
                `packFails=${stats.packFails} looseReads=${stats.looseReads} ` +
                `looseFails=${stats.looseFails} dereffed=${dereffed.size}`);

    const out = [];
    for (const { oid, commit } of commits.values()) {
        out.push({
            sha: oid,
            parents: commit.parents,
            author: (commit.author && commit.author.name) || 'unknown',
            email: (commit.author && commit.author.email) || '',
            date: commit.author && commit.author.timestamp
                ? new Date(commit.author.timestamp * 1000).toISOString()
                : null,
            message: commit.message || ''
        });
    }
    out.sort((a, b) => {
        const ta = a.date ? Date.parse(a.date) : 0;
        const tb = b.date ? Date.parse(b.date) : 0;
        return tb - ta;
    });
    return { commits: out, refs };
}

// Exported for tests + debugging.
export const _internal = { bytesToHex, hexToBytes, readObjectHeader, readOfsDelta };
