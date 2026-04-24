// GitHub REST client. Fetches commits and branches; caches per-session; accepts an optional PAT.

const API = 'https://api.github.com';

export function parseRepoUrl(input) {
    if (!input) return null;
    const trimmed = input.trim().replace(/\.git$/, '');
    const m = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s#?]+)/i);
    if (!m) {
        // Also accept "owner/repo" shorthand
        const s = trimmed.match(/^([^\/\s]+)\/([^\/\s#?]+)$/);
        if (s) return { owner: s[1], repo: s[2] };
        return null;
    }
    return { owner: m[1], repo: m[2] };
}

export class GitHubClient {
    constructor({ token = null, cache = true } = {}) {
        this.token = token;
        this.cache = cache;
    }

    _headers() {
        const h = {
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        };
        if (this.token) h['Authorization'] = 'Bearer ' + this.token;
        return h;
    }

    _cacheGet(key) {
        if (!this.cache) return null;
        try {
            const raw = sessionStorage.getItem(key);
            return raw ? JSON.parse(raw) : null;
        } catch (_) { return null; }
    }

    _cacheSet(key, val) {
        if (!this.cache) return;
        try { sessionStorage.setItem(key, JSON.stringify(val)); } catch (_) {}
    }

    async _getJSON(url) {
        const res = await fetch(url, { headers: this._headers() });
        if (res.status === 403 || res.status === 429) {
            const remaining = res.headers.get('X-RateLimit-Remaining');
            const reset = res.headers.get('X-RateLimit-Reset');
            if (remaining === '0') {
                const waitMin = reset
                    ? Math.max(1, Math.ceil((parseInt(reset, 10) * 1000 - Date.now()) / 60000))
                    : '?';
                throw new Error(`GitHub rate limit reached. Try again in ~${waitMin}m, or add a token in Settings.`);
            }
        }
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`GitHub API ${res.status}: ${text.slice(0, 200)}`);
        }
        return res.json();
    }

    async getRepo(owner, repo) {
        const key = `rebass:repo:${owner}/${repo}`;
        const hit = this._cacheGet(key);
        if (hit) return hit;
        const data = await this._getJSON(`${API}/repos/${owner}/${repo}`);
        this._cacheSet(key, data);
        return data;
    }

    async getCommits(owner, repo, opts = {}) {
        const { max = 100, branch = null, onProgress = null } = opts;
        const key = `rebass:commits:${owner}/${repo}:${branch || 'default'}:${max}`;
        const hit = this._cacheGet(key);
        if (hit) return hit;

        // Prefer GraphQL when we have a token and a deep fetch: ~80 calls for 8K commits
        // at the same rate-limit cost as the REST equivalent of 80 calls for 8K commits,
        // but with far fewer points charged against the 5000/hr limit.
        if (this.token && max > 100) {
            try {
                const out = await this._getCommitsGraphQL(owner, repo, { max, branch, onProgress });
                this._cacheSet(key, out);
                return out;
            } catch (e) {
                console.warn('GraphQL failed, falling back to REST:', e.message);
            }
        }
        const out = await this._getCommitsREST(owner, repo, { max, branch, onProgress });
        this._cacheSet(key, out);
        return out;
    }

    async _getCommitsREST(owner, repo, { max, branch, onProgress }) {
        const perPage = Math.min(100, max);
        const commits = [];
        let page = 1;
        while (commits.length < max) {
            const sha = branch ? `&sha=${encodeURIComponent(branch)}` : '';
            const url = `${API}/repos/${owner}/${repo}/commits?per_page=${perPage}&page=${page}${sha}`;
            const batch = await this._getJSON(url);
            if (!batch.length) break;
            commits.push(...batch);
            if (onProgress) onProgress(`REST: ${commits.length} commits`);
            if (batch.length < perPage) break;
            page++;
        }
        return commits.slice(0, max).map(c => ({
            sha: c.sha,
            message: (c.commit && c.commit.message) || '',
            author: (c.commit && c.commit.author && c.commit.author.name) || 'unknown',
            authorLogin: (c.author && c.author.login) || null,
            email: (c.commit && c.commit.author && c.commit.author.email) || '',
            date: (c.commit && c.commit.author && c.commit.author.date) || null,
            parents: (c.parents || []).map(p => p.sha)
        }));
    }

    async _getCommitsGraphQL(owner, repo, { max, branch, onProgress }) {
        const refName = branch ? `refs/heads/${branch}` : null;
        const query = `
            query($owner:String!, $repo:String!, $cursor:String ${refName ? ', $ref:String!' : ''}) {
              repository(owner:$owner, name:$repo) {
                ${refName ? 'ref(qualifiedName:$ref)' : 'defaultBranchRef'} {
                  target {
                    ... on Commit {
                      history(first: 100, after: $cursor) {
                        pageInfo { endCursor hasNextPage }
                        nodes {
                          oid
                          message
                          author { name email date user { login } }
                          parents(first: 8) { nodes { oid } }
                        }
                      }
                    }
                  }
                }
              }
            }
        `;
        const commits = [];
        let cursor = null;
        while (commits.length < max) {
            const body = { query, variables: { owner, repo, cursor, ...(refName ? { ref: refName } : {}) } };
            const res = await fetch(`${API}/graphql`, {
                method: 'POST',
                headers: { ...this._headers(), 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!res.ok) throw new Error(`GraphQL ${res.status}`);
            const data = await res.json();
            if (data.errors) throw new Error('GraphQL: ' + data.errors[0].message);
            const refObj = refName
                ? data.data.repository.ref
                : data.data.repository.defaultBranchRef;
            if (!refObj || !refObj.target) throw new Error('Repo has no default branch / ref');
            const hist = refObj.target.history;
            for (const n of hist.nodes) {
                commits.push({
                    sha: n.oid,
                    message: n.message || '',
                    author: (n.author && n.author.name) || 'unknown',
                    authorLogin: n.author && n.author.user ? n.author.user.login : null,
                    email: (n.author && n.author.email) || '',
                    date: (n.author && n.author.date) || null,
                    parents: (n.parents && n.parents.nodes || []).map(p => p.oid)
                });
                if (commits.length >= max) break;
            }
            if (onProgress) onProgress(`GraphQL: ${commits.length} commits`);
            if (!hist.pageInfo.hasNextPage || commits.length >= max) break;
            cursor = hist.pageInfo.endCursor;
        }
        return commits.slice(0, max);
    }

    async getBranches(owner, repo, { max = 30 } = {}) {
        const key = `rebass:branches:${owner}/${repo}:${max}`;
        const hit = this._cacheGet(key);
        if (hit) return hit;
        try {
            const branches = await this._getJSON(
                `${API}/repos/${owner}/${repo}/branches?per_page=${Math.min(100, max)}`
            );
            const out = branches.map(b => ({ name: b.name, sha: b.commit && b.commit.sha }));
            this._cacheSet(key, out);
            return out;
        } catch (_) {
            return [];
        }
    }
}
