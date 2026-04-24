// Keep every Nth commit and all merges, so a 100K-commit repo stays musically interesting.
//
// commits: array newest-first (as returned by the fetchers).
// rate: 1 = keep everything, 2 = keep every other, etc.
// Always kept: first/last commit, and any commit with >= 2 parents (merges).

export function sampleCommits(commits, rate = 1, { keepMerges = true } = {}) {
    const n = commits.length;
    if (!n || rate <= 1) return commits.slice();

    const keep = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
        if (i % rate === 0) keep[i] = true;
        else if (keepMerges && (commits[i].parents || []).length >= 2) keep[i] = true;
    }
    // Always keep the newest (i=0) and oldest (i=n-1) so the endpoints of the graph are anchored.
    keep[0] = true;
    keep[n - 1] = true;

    // Rewire parents: if a commit's parent was dropped, follow the parent chain until we
    // hit a kept commit. This keeps the graph topology intact after sampling.
    const survivors = [];
    for (let i = 0; i < n; i++) if (keep[i]) survivors.push(commits[i]);

    const byShaKept = new Set(survivors.map(c => c.sha));
    const byShaOriginal = new Map(commits.map(c => [c.sha, c]));

    const rewrite = (sha, visited) => {
        if (byShaKept.has(sha)) return sha;
        if (visited.has(sha)) return null; // cycle-safe
        visited.add(sha);
        const c = byShaOriginal.get(sha);
        if (!c || !c.parents || !c.parents.length) return null;
        for (const p of c.parents) {
            const r = rewrite(p, visited);
            if (r) return r;
        }
        return null;
    };

    return survivors.map(c => {
        const newParents = [];
        for (const p of (c.parents || [])) {
            const mapped = rewrite(p, new Set());
            if (mapped && !newParents.includes(mapped)) newParents.push(mapped);
        }
        return { ...c, parents: newParents };
    });
}
