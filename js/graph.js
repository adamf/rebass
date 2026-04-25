// Git graph layout + horizontal canvas renderer + minimap.
// Time axis = X (oldest on the left, newest on the right). Lanes stacked vertically.
// Canvas is used throughout so we can handle 10K+ commits without DOM trouble.

const COL_WIDTH = 20;       // horizontal step per commit (time axis)
const MAX_LANE_HEIGHT = 24; // preferred vertical step per lane
const MIN_LANE_HEIGHT = 4;  // floor so nodes don't overlap too much on branchy repos
const LEFT_PAD = 24;
const RIGHT_PAD = 24;
const TOP_PAD = 14;
const BOTTOM_PAD = 14;
const NODE_RADIUS = 5;

const LANE_COLORS = [
    '#8ab4ff', '#ff8ac3', '#9dff8a', '#ffc07a',
    '#c890ff', '#7affd9', '#ffe07a', '#ff7a8a',
    '#7affa0', '#b0a0ff', '#ffaf7a', '#7acfff'
];

export function laneColor(i) {
    return LANE_COLORS[((i % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length];
}

export const GRAPH_CONSTANTS = {
    COL_WIDTH, MAX_LANE_HEIGHT, MIN_LANE_HEIGHT, LEFT_PAD, RIGHT_PAD, TOP_PAD, NODE_RADIUS
};

function nodeX(row) { return LEFT_PAD + row * COL_WIDTH; }

/**
 * Given commits newest-first, assign each commit a swim-lane and a row number.
 * Row 0 is the newest commit (rightmost visually); row N-1 is the oldest (leftmost).
 * We then compute min/max row per lane so the music engine can kick in / kill branch voices.
 */
export function layoutCommits(commitsNewestFirst) {
    const laid = commitsNewestFirst.map(c => ({ ...c }));
    const byIndex = Object.create(null);
    laid.forEach((c, i) => { byIndex[c.sha] = i; });

    const activeLanes = [];

    for (let i = 0; i < laid.length; i++) {
        const c = laid[i];
        let laneIdx = activeLanes.indexOf(c.sha);
        if (laneIdx === -1) {
            laneIdx = activeLanes.indexOf(null);
            if (laneIdx === -1) { laneIdx = activeLanes.length; activeLanes.push(null); }
        }
        c.lane = laneIdx;

        for (let j = 0; j < activeLanes.length; j++) {
            if (j !== laneIdx && activeLanes[j] === c.sha) {
                activeLanes[j] = null;
            }
        }

        const parents = c.parents || [];
        activeLanes[laneIdx] = parents[0] || null;

        for (let p = 1; p < parents.length; p++) {
            let newLane = activeLanes.indexOf(null);
            if (newLane === -1) { newLane = activeLanes.length; activeLanes.push(null); }
            activeLanes[newLane] = parents[p];
        }
    }

    const laneCount = laid.reduce((m, c) => Math.max(m, c.lane + 1), 0);

    // Flip rows so oldest ends up at row 0 (left side of graph, first to play).
    const maxRow = laid.length - 1;
    laid.forEach((c, i) => { c.row = maxRow - i; });

    const byRow = new Array(laid.length);
    for (const c of laid) byRow[c.row] = c;

    const edges = [];
    for (const c of laid) {
        for (const pSha of (c.parents || [])) {
            const pIdx = byIndex[pSha];
            if (pIdx === undefined) continue;
            edges.push({ from: c, to: laid[pIdx] });
        }
    }
    // Sort by earliest row they touch, so culling during draw can short-circuit.
    edges.sort((a, b) => Math.min(a.from.row, a.to.row) - Math.min(b.from.row, b.to.row));

    // Lane open/close windows in play order (row ascending = chronological).
    // Lane L is "alive" from the oldest commit on L (smallest row) to the newest (largest row).
    // We expose these as play-order indices (0 = oldest, N-1 = newest).
    const laneOpenPlayIdx = new Array(laneCount).fill(-1);
    const laneClosePlayIdx = new Array(laneCount).fill(-1);
    for (const c of laid) {
        const L = c.lane;
        const playIdx = c.row; // row = play-order index (oldest first)
        if (laneOpenPlayIdx[L] === -1 || playIdx < laneOpenPlayIdx[L]) laneOpenPlayIdx[L] = playIdx;
        if (laneClosePlayIdx[L] === -1 || playIdx > laneClosePlayIdx[L]) laneClosePlayIdx[L] = playIdx;
    }

    return {
        commits: laid,
        edges,
        laneCount,
        byRow,
        laneOpenPlayIdx,
        laneClosePlayIdx
    };
}

export function totalGraphWidth(layout) {
    return LEFT_PAD + RIGHT_PAD + layout.commits.length * COL_WIDTH;
}

// ------------------------ Main canvas graph view ------------------------

export class GraphView {
    constructor({ canvas, eventSurface, tooltip, onCommitClick, onHover }) {
        this.canvas = canvas;
        this.eventSurface = eventSurface || canvas;
        this.tooltip = tooltip || null;
        this.ctx = canvas.getContext('2d');
        this.onCommitClick = onCommitClick || (() => {});
        this.onHover = onHover || (() => {});
        this.dpr = Math.min(2, window.devicePixelRatio || 1);
        this.layout = null;
        this.scrollX = 0;
        this.viewportW = 0;
        this.viewportH = 0;
        this.flashingShas = new Map();
        this.highlightSha = null;
        this._rafId = null;

        // Listeners attach to the scroll surface (canvas has pointer-events: none so native
        // scroll works). Coordinates are still computed relative to the canvas rect.
        this.eventSurface.addEventListener('click', (e) => this._onClick(e));
        this.eventSurface.addEventListener('mousemove', (e) => this._onMove(e));
        this.eventSurface.addEventListener('mouseleave', () => this._hideTooltip());
    }

    render(layout) {
        this.layout = layout;
        this.scheduleDraw();
    }

    setSize(w, h) {
        if (w <= 0 || h <= 0) return;
        this.viewportW = w;
        this.viewportH = h;
        // Only the backing store — element is sized by CSS.
        this.canvas.width = Math.max(1, Math.floor(w * this.dpr));
        this.canvas.height = Math.max(1, Math.floor(h * this.dpr));
        this.scheduleDraw();
    }

    setScroll(x) {
        this.scrollX = Math.max(0, x);
        this.scheduleDraw();
    }

    flashNode(sha) {
        this.flashingShas.set(sha, performance.now() + 450);
        this.scheduleDraw();
    }

    setHighlight(sha) { this.highlightSha = sha || null; this.scheduleDraw(); }

    scheduleDraw() {
        if (this._rafId) return;
        this._rafId = requestAnimationFrame(() => { this._rafId = null; this.draw(); });
    }

    // Compute a lane height that fits all lanes into the viewport. If the repo has 87
    // lanes and the viewport is 300px, each lane gets ~3.4px; we clamp to MIN_LANE_HEIGHT
    // so nodes still draw.
    _laneHeight() {
        if (!this.layout) return MAX_LANE_HEIGHT;
        const usable = Math.max(1, this.viewportH - TOP_PAD - BOTTOM_PAD);
        const fit = usable / Math.max(1, this.layout.laneCount);
        return Math.max(MIN_LANE_HEIGHT, Math.min(MAX_LANE_HEIGHT, fit));
    }

    _nodeY(lane) { return TOP_PAD + lane * this._laneHeight(); }
    _nodeRadius(laneHeight) { return Math.max(1.2, Math.min(NODE_RADIUS, laneHeight * 0.4)); }

    draw() {
        const ctx = this.ctx;
        const { dpr, viewportW, viewportH } = this;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, viewportW, viewportH);

        // Diagnostic frame: if draw() is running, you can see this faint border.
        ctx.strokeStyle = 'rgba(138,180,255,0.15)';
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, 0.5, viewportW - 1, viewportH - 1);

        if (!this.layout) {
            ctx.fillStyle = 'rgba(160, 170, 190, 0.6)';
            ctx.font = '14px system-ui, -apple-system, sans-serif';
            ctx.fillText('(waiting for a repo)', 18, 28);
            return;
        }

        const laneH = this._laneHeight();
        const nodeR = this._nodeRadius(laneH);
        const nY = (lane) => TOP_PAD + lane * laneH;

        const colsInView = Math.ceil(viewportW / COL_WIDTH) + 4;
        const firstVisibleRow = Math.max(0, Math.floor((this.scrollX - LEFT_PAD) / COL_WIDTH) - 2);
        const lastVisibleRow = Math.min(this.layout.commits.length - 1, firstVisibleRow + colsInView);
        const translateX = -this.scrollX;

        // Thin horizontal guide lines per lane.
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 1;
        for (let l = 0; l < this.layout.laneCount; l++) {
            const y = nY(l);
            if (y > viewportH) break;
            ctx.beginPath();
            ctx.moveTo(0, y + 0.5);
            ctx.lineTo(viewportW, y + 0.5);
            ctx.stroke();
        }

        ctx.lineWidth = Math.max(1, nodeR * 0.4);

        // Edges.
        for (const e of this.layout.edges) {
            const rMin = Math.min(e.from.row, e.to.row);
            const rMax = Math.max(e.from.row, e.to.row);
            if (rMax < firstVisibleRow || rMin > lastVisibleRow) continue;

            const x1 = nodeX(e.from.row) + translateX;
            const y1 = nY(e.from.lane);
            const x2 = nodeX(e.to.row) + translateX;
            const y2 = nY(e.to.lane);
            // Color edges by the deeper (branch) lane so the arc matches its branch's nodes.
            // Same-lane edges trivially match either endpoint.
            const branchLane = Math.max(e.from.lane, e.to.lane);
            ctx.strokeStyle = laneColor(branchLane);
            ctx.globalAlpha = 0.75;
            ctx.beginPath();
            if (y1 === y2) {
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
            } else {
                const kneeX1 = x1 + (x2 - x1) * 0.55;
                const kneeX2 = x2 - (x2 - x1) * 0.55;
                ctx.moveTo(x1, y1);
                ctx.bezierCurveTo(kneeX1, y1, kneeX2, y2, x2, y2);
            }
            ctx.stroke();
        }
        ctx.globalAlpha = 1;

        // Nodes.
        const now = performance.now();
        for (let r = firstVisibleRow; r <= lastVisibleRow; r++) {
            const c = this.layout.byRow[r];
            if (!c) continue;
            const cx = nodeX(c.row) + translateX;
            const cy = nY(c.lane);
            const color = laneColor(c.lane);
            const isMerge = (c.parents || []).length >= 2;
            const flashEnd = this.flashingShas.get(c.sha);
            let scale = 1;
            if (flashEnd && flashEnd > now) {
                const t = 1 - (flashEnd - now) / 450;
                scale = 1 + Math.sin(t * Math.PI) * 1.2;
            } else if (flashEnd) {
                this.flashingShas.delete(c.sha);
            }
            const r0 = (isMerge ? nodeR + 1 : nodeR) * scale;

            if (flashEnd && flashEnd > now) {
                ctx.shadowColor = color;
                ctx.shadowBlur = 14;
            } else if (isMerge) {
                ctx.shadowColor = color;
                ctx.shadowBlur = 6;
            } else {
                ctx.shadowBlur = 0;
            }

            ctx.fillStyle = '#0b0e14';
            ctx.beginPath();
            ctx.arc(cx, cy, r0 + 2, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(cx, cy, r0, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.shadowBlur = 0;

        if (this.flashingShas.size > 0) this.scheduleDraw();
    }

    _nodeAt(clientX, clientY) {
        if (!this.layout) return null;
        const rect = this.canvas.getBoundingClientRect();
        const localX = clientX - rect.left;
        const localY = clientY - rect.top;
        const worldX = localX + this.scrollX;
        const row = Math.round((worldX - LEFT_PAD) / COL_WIDTH);
        if (row < 0 || row >= this.layout.commits.length) return null;
        const c = this.layout.byRow[row];
        if (!c) return null;
        const laneH = this._laneHeight();
        const nodeR = this._nodeRadius(laneH);
        const cx = nodeX(c.row);
        const cy = TOP_PAD + c.lane * laneH;
        const dx = worldX - cx;
        const dy = localY - cy;
        const hit = Math.max(nodeR + 4, 7);
        if (dx * dx + dy * dy <= hit * hit) return c;
        return null;
    }

    _onClick(e) {
        const c = this._nodeAt(e.clientX, e.clientY);
        if (c) this.onCommitClick(c);
    }
    _onMove(e) {
        if (!this.tooltip) return;
        const c = this._nodeAt(e.clientX, e.clientY);
        if (c) {
            this._showTooltip(c, e.clientX, e.clientY);
            this.canvas.style.cursor = 'pointer';
            this.onHover(c);
        } else {
            this._hideTooltip();
            this.canvas.style.cursor = 'default';
        }
    }
    _showTooltip(commit, x, y) {
        const el = this.tooltip;
        const firstLine = (commit.message || '').split('\n')[0].slice(0, 80);
        el.innerHTML =
            `<div class="ttSha">${commit.sha.slice(0, 7)}</div>` +
            `<div class="ttAuthor">${escapeHtml(commit.author || '')}</div>` +
            `<div class="ttMsg">${escapeHtml(firstLine)}</div>`;
        el.hidden = false;
        const rect = this.canvas.getBoundingClientRect();
        const localX = x - rect.left;
        const localY = y - rect.top;
        const ttW = 260;
        const left = localX + 14 + ttW > rect.width ? localX - ttW - 10 : localX + 14;
        const top = localY + 14 + 90 > rect.height ? localY - 90 - 10 : localY + 14;
        el.style.left = Math.max(6, left) + 'px';
        el.style.top  = Math.max(6, top)  + 'px';
    }
    _hideTooltip() { if (this.tooltip) this.tooltip.hidden = true; }
}

// ------------------------ Horizontal minimap ------------------------

export class Minimap {
    constructor({ canvas, onSeek, onScrub }) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.dpr = Math.min(2, window.devicePixelRatio || 1);
        this.onSeek = onSeek || (() => {});
        this.onScrub = onScrub || (() => {});
        this.layout = null;
        this.viewportW = 0;
        this.viewportH = 0;
        this.graphScroll = 0;
        this.graphViewportW = 0;
        this.graphTotalW = 0;
        this.playheadPlayIdx = -1;
        this._rafId = null;
        this._dragging = null;
        this._dragAnchor = 0;

        canvas.addEventListener('mousedown', (e) => this._onDown(e));
        window.addEventListener('mousemove', (e) => this._onMove(e));
        window.addEventListener('mouseup', () => this._onUp());
    }

    render(layout) { this.layout = layout; this.scheduleDraw(); }

    setSize(w, h) {
        if (w <= 0 || h <= 0) return;
        this.viewportW = w;
        this.viewportH = h;
        // Only the backing store — the element is sized by CSS (left/right/bottom/height).
        this.canvas.width = Math.max(1, Math.floor(w * this.dpr));
        this.canvas.height = Math.max(1, Math.floor(h * this.dpr));
        this.scheduleDraw();
    }

    setGraphState({ graphScroll, graphViewportW, graphTotalW }) {
        this.graphScroll = graphScroll;
        this.graphViewportW = graphViewportW;
        this.graphTotalW = graphTotalW;
        this.scheduleDraw();
    }

    setPlayhead(playIdx) {
        this.playheadPlayIdx = playIdx;
        this.scheduleDraw();
    }

    scheduleDraw() {
        if (this._rafId) return;
        this._rafId = requestAnimationFrame(() => { this._rafId = null; this.draw(); });
    }

    draw() {
        if (!this.layout) return;
        const ctx = this.ctx;
        const { dpr, viewportW, viewportH } = this;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, viewportW, viewportH);

        const commits = this.layout.commits;
        const N = commits.length;
        if (!N) return;

        const xOf = (row) => (row / Math.max(1, N - 1)) * (viewportW - 2) + 1;
        const yOf = (lane) => 2 + lane * Math.max(2, (viewportH - 4) / Math.max(1, this.layout.laneCount));
        const laneH = Math.max(2, (viewportH - 4) / Math.max(1, this.layout.laneCount));

        ctx.fillStyle = 'rgba(255,255,255,0.02)';
        ctx.fillRect(0, 0, viewportW, viewportH);

        const laneMid = Math.max(1, laneH / 2);

        // Lane spans: a horizontal line per lane from its oldest to newest commit.
        // Cross-lane edges are intentionally skipped — at this density they overwhelm
        // the minimap with diagonal noise.
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.7;
        for (let l = 0; l < this.layout.laneCount; l++) {
            const openIdx = this.layout.laneOpenPlayIdx[l];
            const closeIdx = this.layout.laneClosePlayIdx[l];
            if (openIdx < 0 || closeIdx < 0) continue;
            const x1 = xOf(openIdx);
            const x2 = xOf(closeIdx);
            const y = Math.floor(yOf(l) + laneMid);
            ctx.strokeStyle = laneColor(l);
            ctx.beginPath();
            ctx.moveTo(x1, y);
            ctx.lineTo(x2, y);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;

        for (const c of commits) {
            ctx.fillStyle = laneColor(c.lane);
            const x = xOf(c.row);
            const y = yOf(c.lane);
            ctx.fillRect(Math.floor(x), Math.floor(y), 2, Math.max(1, Math.floor(laneH) - 1));
        }

        if (this.graphTotalW > 0 && this.graphViewportW > 0) {
            const frameLeft = (this.graphScroll / this.graphTotalW) * viewportW;
            const frameW = (this.graphViewportW / this.graphTotalW) * viewportW;
            ctx.fillStyle = 'rgba(138,180,255,0.14)';
            ctx.fillRect(frameLeft, 0, frameW, viewportH);
            ctx.strokeStyle = 'rgba(138,180,255,0.8)';
            ctx.lineWidth = 1;
            ctx.strokeRect(frameLeft + 0.5, 0.5, frameW - 1, viewportH - 1);
        }

        if (this.playheadPlayIdx >= 0 && this.playheadPlayIdx < N) {
            // Play order: oldest first (idx 0) = row 0 = left. So the play idx is the row.
            const row = this.playheadPlayIdx;
            const x = xOf(row);
            ctx.fillStyle = '#ff8ac3';
            ctx.fillRect(Math.floor(x), 0, 2, viewportH);
            ctx.fillStyle = '#ff8ac3';
            ctx.beginPath();
            ctx.arc(x, viewportH / 2, 3, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    _localX(e) {
        const rect = this.canvas.getBoundingClientRect();
        return Math.max(0, Math.min(this.viewportW, e.clientX - rect.left));
    }

    _commitIdxFromX(x) {
        const N = this.layout.commits.length;
        const row = Math.round((x / Math.max(1, this.viewportW - 2)) * (N - 1));
        return Math.max(0, Math.min(N - 1, row));
    }

    _scrollFromX(x) {
        return Math.max(0, (x / this.viewportW) * this.graphTotalW - this.graphViewportW / 2);
    }

    _onDown(e) {
        if (!this.layout) return;
        const x = this._localX(e);
        if (this.graphTotalW > 0) {
            const frameLeft = (this.graphScroll / this.graphTotalW) * this.viewportW;
            const frameW = (this.graphViewportW / this.graphTotalW) * this.viewportW;
            if (x >= frameLeft && x <= frameLeft + frameW) {
                this._dragging = 'frame';
                this._dragAnchor = x - frameLeft;
                e.preventDefault();
                return;
            }
        }
        this._dragging = 'seek';
        this.onSeek(this._commitIdxFromX(x));
        e.preventDefault();
    }
    _onMove(e) {
        if (!this._dragging) return;
        const x = this._localX(e);
        if (this._dragging === 'frame') {
            const newScroll = (x - this._dragAnchor) / this.viewportW * this.graphTotalW;
            this.onScrub(Math.max(0, newScroll));
        } else if (this._dragging === 'seek') {
            this.onSeek(this._commitIdxFromX(x));
        }
    }
    _onUp() { this._dragging = null; }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}
