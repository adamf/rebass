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

// Pack content is accessed via File.slice() on-demand. `pack` is a { file, packId } object;
// we slice out exactly [offset, end) per request. Memory use stays bounded — we never hold
// multi-hundred-MB pack buffers in RAM.
export async function readObjectAt(pack, offset, ctx) {
    const cache = ctx.cache;
    const cacheKey = pack.packId + ':' + offset;
    if (cache) {
        const hit = cache.get(cacheKey);
        if (hit) return hit;
    }
    const objEnd = ctx.endOf.get(offset);
    if (objEnd === undefined) throw new Error(`No end bound known for offset ${offset}`);

    // Grab only the bytes for this one object (typically <1KB for commits).
    const sliceBytes = new Uint8Array(
        await pack.file.slice(offset, objEnd).arrayBuffer()
    );
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
            oidToPack: ctx.oidToPack, cache, endOf: entry.endOf
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
// Returns { refs: { name → oid }, tips: oid[] }. Handles packed-refs + loose refs + HEAD.
export async function readAllRefs(fs, gitdir) {
    const refs = Object.create(null);

    // packed-refs file: mix of "<oid> <ref>" and peeled "^<oid>" lines. Ignore peeled; tag
    // refs pointing at tag objects are handled later by dereferencing the tag.
    try {
        const text = await fs.readFile(`${gitdir}/packed-refs`, 'utf8');
        for (const rawLine of text.split('\n')) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#') || line.startsWith('^')) continue;
            const sp = line.indexOf(' ');
            if (sp < 0) continue;
            const oid = line.slice(0, sp);
            const ref = line.slice(sp + 1);
            if (/^[0-9a-f]{40}$/.test(oid)) refs[ref] = oid;
        }
    } catch (_) {}

    // Loose refs under refs/heads and refs/tags (plus refs/remotes if we want those too).
    async function walk(subdir, prefix) {
        let entries;
        try { entries = await fs.readdir(`${gitdir}/${subdir}`); }
        catch (_) { return; }
        for (const name of entries) {
            const full = `${subdir}/${name}`;
            let st;
            try { st = await fs.stat(`${gitdir}/${full}`); } catch (_) { continue; }
            if (st.isDirectory()) {
                await walk(full, prefix + name + '/');
            } else {
                try {
                    const oid = (await fs.readFile(`${gitdir}/${full}`, 'utf8')).trim();
                    if (/^[0-9a-f]{40}$/.test(oid)) refs[prefix + name] = oid;
                } catch (_) {}
            }
        }
    }
    await walk('refs/heads', 'refs/heads/');
    await walk('refs/tags', 'refs/tags/');
    await walk('refs/remotes', 'refs/remotes/');

    // HEAD (possibly a symref)
    try {
        const head = (await fs.readFile(`${gitdir}/HEAD`, 'utf8')).trim();
        if (head.startsWith('ref: ')) {
            const target = head.slice(5).trim();
            if (refs[target]) refs['HEAD'] = refs[target];
        } else if (/^[0-9a-f]{40}$/.test(head)) {
            refs['HEAD'] = head;
        }
    } catch (_) {}

    const tips = [...new Set(Object.values(refs))];
    return { refs, tips };
}

// -------- Load all pack indexes + pack File handles --------
// Indexes are read into memory (they're small). Pack content is kept as a File reference
// and sliced per-object inside readObjectAt — we never hold a 500MB pack in RAM.
export async function loadPacks(fs, gitdir) {
    const packDir = `${gitdir}/objects/pack`;
    let entries = [];
    try { entries = await fs.readdir(packDir); } catch (_) { return { oidToPack: new Map(), packs: [] }; }
    const oidToPack = new Map();
    const packs = [];
    let packId = 0;
    for (const name of entries) {
        if (!name.endsWith('.idx')) continue;
        const base = name.slice(0, -4);
        const idxPath = `${packDir}/${name}`;
        const packPath = `${packDir}/${base}.pack`;
        try {
            const [idxBuf, packFile] = await Promise.all([
                fs.readFile(idxPath),
                fs.getFile(packPath)
            ]);
            const { oidToOffset } = parseIdx(idxBuf);
            const offsets = [...oidToOffset.values()].sort((a, b) => a - b);
            const endOf = new Map();
            const packEnd = packFile.size - 20;
            for (let i = 0; i < offsets.length; i++) {
                const nextEnd = i + 1 < offsets.length ? offsets[i + 1] : packEnd;
                endOf.set(offsets[i], nextEnd);
            }
            const thisPackId = packId++;
            const packRef = { file: packFile, packId: thisPackId, endOf };
            for (const [oid, off] of oidToOffset) {
                oidToPack.set(oid, { file: packFile, offset: off, endOf, packId: thisPackId });
            }
            packs.push(packRef);
        } catch (e) {
            console.warn('pack load failed', name, e);
        }
    }
    return { oidToPack, packs };
}

// -------- Fast commit walk --------
// Returns [{ sha, parents, author, email, date, message }, ...] newest-first.
export async function fastWalk({ fs, gitdir, onProgress = () => {}, maxCommits = 500000, yieldEvery = 500 }) {
    onProgress('Reading refs…');
    const { refs, tips } = await readAllRefs(fs, gitdir);

    onProgress('Loading pack indexes…');
    const { oidToPack } = await loadPacks(fs, gitdir);

    const commits = new Map();      // oid → parsed commit
    const dereffed = new Set();     // oids we've attempted, to short-circuit
    const decodeCache = new Map();  // pack offset → decoded object (for delta chain reuse)
    const queue = [...tips];
    const t0 = performance.now();
    let walkedSinceYield = 0;

    const CONCURRENCY = 16;

    const resolveOne = async (oid) => {
        const entry = oidToPack.get(oid);
        if (entry) {
            return readObjectAt(entry, entry.offset, {
                oidToPack, cache: decodeCache, endOf: entry.endOf
            });
        }
        try { return await readLooseObject(fs, gitdir, oid); }
        catch (_) { return null; }
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
