// File import: accepts JSON arrays, or a tab-delimited `git log` dump, as produced by:
//   git log --all --format='%H%x09%P%x09%aN%x09%aI%x09%s' > rebass.log
//
// The delimited format is preferred for big repos — one commit per line, all branches included.

export const LOG_ONELINER =
    "git log --all --format='%H%x09%P%x09%aN%x09%aI%x09%s' > rebass.log";

export function parseRebassInput(text, { filename = '' } = {}) {
    const trimmed = (text || '').trim();
    if (!trimmed) return [];

    const looksJson =
        trimmed.startsWith('[') ||
        trimmed.startsWith('{') ||
        /\.json$/i.test(filename);

    if (looksJson) {
        return parseJson(trimmed);
    }
    return parseDelimited(trimmed);
}

function parseJson(text) {
    let data;
    try { data = JSON.parse(text); }
    catch (e) { throw new Error('Not valid JSON: ' + e.message); }

    if (!Array.isArray(data)) {
        if (data && Array.isArray(data.commits)) data = data.commits;
        else throw new Error('Expected a JSON array of commits or { commits: [...] }');
    }
    return data.map((c, i) => normalizeCommit(c, i));
}

function normalizeCommit(c, i) {
    if (!c || typeof c !== 'object') throw new Error(`Entry ${i} is not an object`);
    const sha = c.sha || c.hash || c.oid || c.id;
    if (!sha) throw new Error(`Entry ${i} missing sha`);
    let parents = c.parents ?? c.parent ?? [];
    if (typeof parents === 'string') parents = parents.split(/\s+/).filter(Boolean);
    if (!Array.isArray(parents)) parents = [];
    return {
        sha: String(sha),
        parents: parents.map(String),
        author: String(c.author || c.authorName || 'unknown'),
        email: c.email || c.authorEmail || '',
        date: c.date || c.authorDate || null,
        message: String(c.message || c.subject || '')
    };
}

function parseDelimited(text) {
    const lines = text.split(/\r?\n/).filter(l => l.length);
    if (!lines.length) return [];
    // Auto-detect separator. Preferred: tab. Fallback: 0x01 (so EnPassant-style inputs also work).
    const sep = lines[0].includes('\t') ? '\t' : '\x01';
    return lines.map((line, i) => {
        const parts = line.split(sep);
        if (parts.length < 5) {
            throw new Error(`Line ${i + 1} has fewer than 5 fields — expected: SHA${sep === '\t' ? '<tab>' : '\\x01'}PARENTS${sep === '\t' ? '<tab>' : '\\x01'}AUTHOR${sep === '\t' ? '<tab>' : '\\x01'}DATE${sep === '\t' ? '<tab>' : '\\x01'}SUBJECT`);
        }
        const [sha, parents, author, date, ...rest] = parts;
        return {
            sha,
            parents: parents ? parents.split(/\s+/).filter(Boolean) : [],
            author,
            date,
            message: rest.join(sep)
        };
    });
}

// Drop-anywhere + paste handler. Calls onCommits(commits, filename) on success.
export function installDropZone({ onCommits, onError, onEnter, onLeave }) {
    let depth = 0;
    const over = (e) => {
        if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const enter = (e) => {
        if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
        depth++;
        if (depth === 1 && onEnter) onEnter();
    };
    const leave = () => {
        depth = Math.max(0, depth - 1);
        if (depth === 0 && onLeave) onLeave();
    };
    const drop = async (e) => {
        if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
        e.preventDefault();
        depth = 0;
        if (onLeave) onLeave();
        const file = e.dataTransfer.files[0];
        try {
            const text = await file.text();
            const commits = parseRebassInput(text, { filename: file.name });
            if (!commits.length) throw new Error('File had 0 commits');
            onCommits(commits, file.name);
        } catch (err) {
            if (onError) onError(err);
        }
    };
    document.addEventListener('dragover', over);
    document.addEventListener('dragenter', enter);
    document.addEventListener('dragleave', leave);
    document.addEventListener('drop', drop);
    return () => {
        document.removeEventListener('dragover', over);
        document.removeEventListener('dragenter', enter);
        document.removeEventListener('dragleave', leave);
        document.removeEventListener('drop', drop);
    };
}

// File picker from a button click. Returns the commits or throws.
export async function pickFileAndParse() {
    return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,.log,.txt,text/plain,application/json';
        input.addEventListener('change', async () => {
            const file = input.files && input.files[0];
            if (!file) { reject(new Error('No file selected')); return; }
            try {
                const text = await file.text();
                const commits = parseRebassInput(text, { filename: file.name });
                if (!commits.length) throw new Error('File had 0 commits');
                resolve({ commits, filename: file.name });
            } catch (e) { reject(e); }
        });
        input.click();
    });
}
