// Orchestration: form → fetch → layout → schedule → drive playhead.

import { parseRepoUrl, GitHubClient } from './github.js';
import {
    layoutCommits, GraphView, Minimap, laneColor, GRAPH_CONSTANTS,
    totalGraphWidth
} from './graph.js';
import {
    INSTRUMENTS, VOICES, MusicPlayer, deriveKey,
    DRUM_KITS, DEFAULT_DRUM_KIT
} from './music.js';
import { installDropZone, pickFileAndParse, LOG_ONELINER } from './import.js';
import { pickLocalRepo, hasDirectoryPicker } from './localRepo.js';
import { sampleCommits } from './sample.js';
import {
    STYLES, findStyle, DEFAULT_STYLE, pickDrumVariant, pickBassVariant,
    branchInstrumentForBranch
} from './styles.js';

// Stable lane → instrument mapping for the currently loaded repo. Keyed by lane number
// but derived by hashing each branch's opening-commit SHA, so different branches that
// happen to share the same lane slot still get different instruments.
function computeLaneInstruments() {
    state.laneInstruments = {};
    if (!state.layout || !state.layout.laneOpenPlayIdx) return;
    const byRow = state.layout.byRow;
    const openIdx = state.layout.laneOpenPlayIdx;
    for (let L = 1; L < openIdx.length; L++) {
        const row = openIdx[L];
        if (row == null || row < 0) continue;
        const commit = byRow[row];
        if (!commit) continue;
        state.laneInstruments[L] = branchInstrumentForBranch(state.styleId, commit.sha);
    }
}
const branchInstrumentFor = (lane) => (state.laneInstruments && state.laneInstruments[lane]) || null;

const state = {
    styleId: DEFAULT_STYLE,
    tempo: 120,
    scaleName: 'minor pentatonic',
    maxCommits: 80,
    commitsPerBar: 1,
    sampleRate: 1,
    accelerate: 0.6,
    drumKit: DEFAULT_DRUM_KIT,
    branchMotifs: true,
    token: '',
    currentCommitIdx: 0,
    isPlaying: false,
    source: null,
    rawCommits: [],
    commits: [],
    branches: [],
    layout: null,
    key: null,
    loadSeq: 0,   // bump per load; stale callbacks compare and drop
    voiceInst: Object.fromEntries(VOICES.map(v => [v.id, v.defaultInst])),
    voiceOctave: Object.fromEntries(VOICES.map(v => [v.id, v.defaultOctave])),
    voiceMuted: Object.fromEntries(VOICES.map(v => [v.id, false]))
};

// ---------- Persistence ----------
function loadPrefs() {
    try {
        const raw = localStorage.getItem('rebass:prefs');
        if (!raw) return;
        const p = JSON.parse(raw);
        if (p.tempo) state.tempo = p.tempo;
        if (p.scaleName) state.scaleName = p.scaleName;
        if (p.maxCommits) state.maxCommits = p.maxCommits;
        if (p.commitsPerBar) state.commitsPerBar = p.commitsPerBar;
        if (p.sampleRate) state.sampleRate = p.sampleRate;
        if (typeof p.accelerate === 'number') state.accelerate = p.accelerate;
        if (typeof p.branchMotifs === 'boolean') state.branchMotifs = p.branchMotifs;
        if (typeof p.drumKit === 'string') {
            // Validate against the current catalog; '' means "off". Anything else stale → reset.
            if (p.drumKit === '' || DRUM_KITS.includes(p.drumKit)) state.drumKit = p.drumKit;
        }
        if (typeof p.token === 'string') state.token = p.token;
        if (p.voiceInst) Object.assign(state.voiceInst, p.voiceInst);
        if (p.voiceOctave) Object.assign(state.voiceOctave, p.voiceOctave);
        if (p.voiceMuted) Object.assign(state.voiceMuted, p.voiceMuted);
    } catch (_) {}
}
function savePrefs() {
    try {
        localStorage.setItem('rebass:prefs', JSON.stringify({
            tempo: state.tempo,
            scaleName: state.scaleName,
            maxCommits: state.maxCommits,
            commitsPerBar: state.commitsPerBar,
            sampleRate: state.sampleRate,
            accelerate: state.accelerate,
            drumKit: state.drumKit,
            branchMotifs: state.branchMotifs,
            token: state.token,
            voiceInst: state.voiceInst,
            voiceOctave: state.voiceOctave,
            voiceMuted: state.voiceMuted
        }));
    } catch (_) {}
}

// ---------- iOS silent-switch workaround ----------
// Web Audio on iOS respects the hardware silent switch unless an <audio>
// element is also playing. A looping silent mp3, started in a user gesture,
// promotes the page to the "playback" audio session.
let silentAudioEl = null;
function ensureSilentAudio() {
    if (!silentAudioEl) {
        silentAudioEl = document.createElement('audio');
        silentAudioEl.src = 'silent.mp3';
        silentAudioEl.loop = true;
        silentAudioEl.preload = 'auto';
        silentAudioEl.playsInline = true;
        silentAudioEl.setAttribute('playsinline', '');
        silentAudioEl.setAttribute('webkit-playsinline', '');
        silentAudioEl.setAttribute('x-webkit-airplay', 'deny');
        silentAudioEl.muted = false;
        silentAudioEl.volume = 1.0;
        silentAudioEl.style.display = 'none';
        document.body.appendChild(silentAudioEl);
    }
    if (silentAudioEl.paused) {
        const p = silentAudioEl.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
    }
}

// ---------- Toast ----------
const toastEl = document.getElementById('toast');
let toastTimer;
function toast(msg, level = 'info', ms = 3500) {
    toastEl.textContent = msg;
    toastEl.className = 'toast toast-' + level;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
}

// ---------- Beat bar ----------
const beatBarEl = document.getElementById('beatBar');
function buildBeatBar() {
    beatBarEl.innerHTML = '';
    for (let i = 0; i < 4; i++) {
        const cell = document.createElement('div');
        cell.className = 'beatCell';
        cell.textContent = i + 1;
        beatBarEl.appendChild(cell);
    }
}
function flashBeat(beatFloat) {
    const idx = Math.max(0, Math.min(3, Math.floor(beatFloat)));
    const cells = beatBarEl.children;
    for (let i = 0; i < cells.length; i++) {
        cells[i].classList.toggle('active', i === idx);
    }
}

// ---------- Voice panel ----------
const voicePanelEl = document.getElementById('voicePanel');
function buildVoicePanel() {
    voicePanelEl.innerHTML = '';
    VOICES.forEach(v => {
        const row = document.createElement('div');
        row.className = 'voiceRow voiceRow-' + v.id;

        const label = document.createElement('div');
        label.className = 'voiceLabel';
        label.textContent = v.label;
        row.appendChild(label);

        const instSel = document.createElement('select');
        instSel.className = 'voiceInst';
        instSel.dataset.voice = v.id;
        INSTRUMENTS.forEach(inst => {
            const opt = document.createElement('option');
            opt.value = inst.id;
            opt.textContent = inst.label;
            instSel.appendChild(opt);
        });
        instSel.value = state.voiceInst[v.id];
        instSel.addEventListener('change', async () => {
            state.voiceInst[v.id] = instSel.value;
            savePrefs();
            if (player) {
                toast(`Loading ${INSTRUMENTS.find(i => i.id === instSel.value).label}…`);
                await player.setInstrument(v.id, instSel.value);
                toast(`${v.label}: ${INSTRUMENTS.find(i => i.id === instSel.value).label}`);
                // Re-schedule from the current playhead so the new instrument actually plays
                // the upcoming notes (pre-scheduled notes were bound to the old Soundfont).
                if (state.isPlaying) player.seek(state.currentCommitIdx);
            }
        });
        row.appendChild(instSel);

        const octSel = document.createElement('select');
        octSel.className = 'voiceOct';
        octSel.dataset.voice = v.id;
        for (let o = 0; o <= 6; o++) {
            const opt = document.createElement('option');
            opt.value = String(o);
            opt.textContent = 'oct ' + o;
            octSel.appendChild(opt);
        }
        octSel.value = String(state.voiceOctave[v.id]);
        octSel.addEventListener('change', () => {
            state.voiceOctave[v.id] = parseInt(octSel.value, 10);
            savePrefs();
        });
        row.appendChild(octSel);

        const muteBtn = document.createElement('button');
        muteBtn.type = 'button';
        muteBtn.className = 'voiceMute';
        muteBtn.setAttribute('aria-label', 'Mute');
        const ICON_ON = svgIcon(`<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>`);
        const ICON_OFF = svgIcon(`<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/>`);
        const setMuteUI = () => {
            muteBtn.innerHTML = state.voiceMuted[v.id] ? ICON_OFF : ICON_ON;
            muteBtn.title = state.voiceMuted[v.id] ? 'Muted — click to unmute' : 'Click to mute';
            muteBtn.classList.toggle('isMuted', state.voiceMuted[v.id]);
            row.classList.toggle('muted', state.voiceMuted[v.id]);
        };
        muteBtn.addEventListener('click', () => {
            state.voiceMuted[v.id] = !state.voiceMuted[v.id];
            savePrefs();
            setMuteUI();
            if (player) player.setVoiceVolume(v.id, state.voiceMuted[v.id] ? 0 : 0.9);
        });
        setMuteUI();
        row.appendChild(muteBtn);

        voicePanelEl.appendChild(row);
    });
}

// ---------- Main-page controls (style, tempo, accel, density, drums) ----------
function wireMainControls() {
    const styleSel = document.getElementById('styleSelect');
    for (const s of STYLES) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.label;
        styleSel.appendChild(opt);
    }
    styleSel.value = state.styleId;
    styleSel.addEventListener('change', () => {
        applyStyle(styleSel.value);
    });

    const tempoEl = document.getElementById('mainTempo');
    const tempoValEl = document.getElementById('mainTempoValue');
    tempoEl.value = String(state.tempo);
    tempoValEl.textContent = state.tempo + ' BPM';
    tempoEl.addEventListener('input', () => {
        state.tempo = parseInt(tempoEl.value, 10);
        tempoValEl.textContent = state.tempo + ' BPM';
        savePrefs();
    });
    tempoEl.addEventListener('change', () => {
        if (state.isPlaying) play({ startFromCommit: state.currentCommitIdx });
    });

    const accelEl = document.getElementById('mainAccel');
    accelEl.value = String(state.accelerate);
    accelEl.addEventListener('change', () => {
        state.accelerate = parseFloat(accelEl.value);
        savePrefs();
        if (state.isPlaying) play({ startFromCommit: state.currentCommitIdx });
    });

    const cpbEl = document.getElementById('mainCpb');
    cpbEl.value = String(state.commitsPerBar);
    cpbEl.addEventListener('change', () => {
        state.commitsPerBar = parseInt(cpbEl.value, 10);
        savePrefs();
        if (state.isPlaying) play({ startFromCommit: state.currentCommitIdx });
    });

    const drumEl = document.getElementById('mainDrumKit');
    drumEl.value = state.drumKit;
    drumEl.addEventListener('change', async () => {
        state.drumKit = drumEl.value;
        savePrefs();
        if (player && state.drumKit) {
            toast(`Loading drums: ${state.drumKit}…`);
            await player.setDrumKit(state.drumKit);
        }
        if (state.isPlaying) play({ startFromCommit: state.currentCommitIdx });
    });
}

function refreshMainControlsFromState() {
    const styleSel = document.getElementById('styleSelect');
    const tempoEl = document.getElementById('mainTempo');
    const tempoValEl = document.getElementById('mainTempoValue');
    const accelEl = document.getElementById('mainAccel');
    const cpbEl = document.getElementById('mainCpb');
    const drumEl = document.getElementById('mainDrumKit');
    if (styleSel) styleSel.value = state.styleId;
    if (tempoEl) tempoEl.value = String(state.tempo);
    if (tempoValEl) tempoValEl.textContent = state.tempo + ' BPM';
    if (accelEl) accelEl.value = String(state.accelerate);
    if (cpbEl) cpbEl.value = String(state.commitsPerBar);
    if (drumEl) drumEl.value = state.drumKit;
    // Also refresh voice-panel selects so the instrument names match the new style.
    document.querySelectorAll('.voiceInst').forEach(sel => {
        const voiceId = sel.dataset.voice;
        if (voiceId && state.voiceInst[voiceId] !== undefined) sel.value = state.voiceInst[voiceId];
    });
    document.querySelectorAll('.voiceOct').forEach(sel => {
        const voiceId = sel.dataset.voice;
        if (voiceId && state.voiceOctave[voiceId] !== undefined) sel.value = String(state.voiceOctave[voiceId]);
    });
}

async function applyStyle(styleId) {
    const s = findStyle(styleId);
    if (!s) return;
    state.styleId = styleId;
    state.tempo = s.tempo;
    state.commitsPerBar = s.commitsPerBar;
    state.accelerate = s.accelerate;
    state.drumKit = s.drumKit;
    Object.assign(state.voiceInst, s.voiceInst);
    Object.assign(state.voiceOctave, s.voiceOctave);
    savePrefs();
    refreshMainControlsFromState();
    computeLaneInstruments();
    if (player) {
        toast(`Loading ${s.label} instruments…`);
        // Explicitly tear down the old branch soundfonts AND the pool cache so the next
        // preload starts from a clean slate. Just replacing references (GC will handle
        // it eventually) can leave enough instances in RAM to OOM on fast style cycles.
        for (const lane of Object.keys(player.branchInstruments)) {
            try { player.branchInstruments[lane].stop(); } catch (_) {}
            delete player.branchInstruments[lane];
        }
        if (player._branchPool) {
            for (const id in player._branchPool) {
                const entry = player._branchPool[id];
                try { entry.sf.stop(); } catch (_) {}
                try { entry.sf.disconnect && entry.sf.disconnect(); } catch (_) {}
            }
            player._branchPool = {};
        }
        // Load voices sequentially to avoid a memory spike (4 Soundfonts parsing their
        // sample buffers in parallel was enough to trip Chrome's OOM watchdog).
        for (const v of VOICES) {
            await player.setInstrument(v.id, state.voiceInst[v.id]);
        }
        if (s.drumKit) await player.setDrumKit(s.drumKit);
        await preloadBranchInstruments();
    }
    if (state.isPlaying) play({ startFromCommit: state.currentCommitIdx });
}

// ---------- Sheets ----------
function wireSheets() {
    const closeAll = () => document.querySelectorAll('.sheet').forEach(s => s.hidden = true);
    const toggle = (id) => {
        const target = document.getElementById(id);
        const willOpen = target.hidden;
        closeAll();
        if (willOpen) target.hidden = false;
    };
    document.getElementById('settingsBtn').addEventListener('click', (e) => { e.stopPropagation(); toggle('settingsSheet'); });
    document.getElementById('aboutBtn').addEventListener('click', (e) => { e.stopPropagation(); toggle('aboutSheet'); });
    document.querySelectorAll('[data-close-sheet]').forEach(b => b.addEventListener('click', closeAll));

    // Close when clicking outside.
    document.addEventListener('click', (e) => {
        const openSheet = document.querySelector('.sheet:not([hidden])');
        if (!openSheet) return;
        if (openSheet.contains(e.target)) return;
        if (e.target.closest('.iconBtn')) return;
        closeAll();
    });

    const scaleSelect = document.getElementById('scaleSelect');
    scaleSelect.value = state.scaleName;
    scaleSelect.addEventListener('change', () => {
        state.scaleName = scaleSelect.value;
        savePrefs();
    });

    const maxCommits = document.getElementById('maxCommits');
    maxCommits.value = String(state.maxCommits);
    maxCommits.addEventListener('change', () => {
        state.maxCommits = Math.max(10, Math.min(50000, parseInt(maxCommits.value, 10) || 80));
        maxCommits.value = String(state.maxCommits);
        savePrefs();
    });

    const sampleRateSel = document.getElementById('sampleRate');
    sampleRateSel.value = String(state.sampleRate);
    sampleRateSel.addEventListener('change', () => {
        state.sampleRate = parseInt(sampleRateSel.value, 10);
        savePrefs();
        if (state.rawCommits.length) {
            applyCommits(state.rawCommits, state.branches, state.source);
        }
    });

    const motifsEl = document.getElementById('branchMotifs');
    if (motifsEl) {
        motifsEl.checked = state.branchMotifs;
        motifsEl.addEventListener('change', () => {
            state.branchMotifs = motifsEl.checked;
            savePrefs();
            if (state.isPlaying) play({ startFromCommit: state.currentCommitIdx });
        });
    }

    const ghToken = document.getElementById('ghToken');
    ghToken.value = state.token;
    ghToken.addEventListener('change', () => {
        state.token = ghToken.value.trim();
        savePrefs();
    });

    document.querySelectorAll('.preset').forEach(btn => {
        btn.addEventListener('click', () => {
            document.getElementById('repoUrl').value = btn.dataset.repo;
            closeAll();
            document.getElementById('repoForm').requestSubmit();
        });
    });

    // Local folder + upload buttons
    const pickFolderBtn = document.getElementById('pickFolderBtn');
    if (!hasDirectoryPicker()) {
        pickFolderBtn.disabled = true;
        pickFolderBtn.title = 'Browser does not support folder pickers. Use the one-liner below.';
    }
    pickFolderBtn.addEventListener('click', async () => {
        closeAll();
        const seq = newLoadSeq();
        const t0 = performance.now();
        try {
            const result = await pickLocalRepo({
                onProgress: (s) => toast(s, 'info', 60000),
                maxCommits: Math.max(state.maxCommits, 200000)
            });
            if (seq !== state.loadSeq) return;
            const secs = (performance.now() - t0) / 1000;
            loadCommits(result.commits, result.branches, {
                kind: 'local',
                label: result.name || 'local repo'
            });
            if (secs > 8) {
                toast(
                    `Parsed ${result.commits.length} commits in ${secs.toFixed(1)}s. ` +
                    `For faster repeat loads, Settings → "Local import one-liner" + drop the file.`,
                    'info', 10000
                );
            }
        } catch (e) {
            if (e && e.name === 'AbortError') return;
            toast(e.message || String(e), 'error', 8000);
        }
    });

    document.getElementById('pickFileBtn').addEventListener('click', async () => {
        closeAll();
        const seq = newLoadSeq();
        try {
            const { commits, filename } = await pickFileAndParse();
            if (seq !== state.loadSeq) return;
            loadCommits(commits, [], { kind: 'file', label: filename });
        } catch (e) {
            if (e && /No file selected/.test(e.message)) return;
            toast(e.message || String(e), 'error', 8000);
        }
    });

    wireMainControls();

    // Click-to-copy for the git-log one-liner.
    const oneLiner = document.getElementById('oneLiner');
    if (oneLiner) {
        oneLiner.textContent = LOG_ONELINER;
        oneLiner.addEventListener('click', () => {
            navigator.clipboard && navigator.clipboard.writeText(LOG_ONELINER)
                .then(() => toast('Copied to clipboard'))
                .catch(() => {});
        });
    }
}

// ---------- Graph / playhead ----------
const graphScroller = document.getElementById('graphScroller');
const graphSpacer = document.getElementById('graphSpacer');
const graphCanvas = document.getElementById('graphCanvas');
const graphTooltip = document.getElementById('graphTooltip');
const graphEmpty = document.getElementById('graphEmpty');
const minimapCanvas = document.getElementById('minimapCanvas');

const graphView = new GraphView({
    canvas: graphCanvas,
    eventSurface: graphScroller,
    tooltip: graphTooltip,
    onCommitClick: (c) => {
        renderNowPlaying(c);
        // Click = seek to that commit in play order. Row 0 is oldest (plays first).
        if (state.layout) seekTo(c.row);
    }
});

const minimap = new Minimap({
    canvas: minimapCanvas,
    onSeek: (playIdx) => seekTo(playIdx),
    onScrub: (scrollX) => { graphScroller.scrollLeft = scrollX; }
});

const playheadEl = document.getElementById('playhead');
let currentCommitWorldX = null;

function updatePlayhead() {
    if (currentCommitWorldX === null) return;
    playheadEl.style.left = (currentCommitWorldX - graphScroller.scrollLeft) + 'px';
}

// Drive scroll + playhead directly off the music engine's onTick. The playhead stays pinned
// near viewport center; the graph scrolls under it frame-perfectly. At graph edges the
// scroll clamps and the playhead slides off-center to stay on the actual current commit.
function setGraphScrollForCommitFloat(commitFloat) {
    currentCommitWorldX = GRAPH_CONSTANTS.LEFT_PAD + commitFloat * GRAPH_CONSTANTS.COL_WIDTH;
    const vwpW = graphScroller.clientWidth;
    const maxScroll = Math.max(0, graphSpacer.offsetWidth - vwpW);
    const ideal = currentCommitWorldX - vwpW / 2;
    graphScroller.scrollLeft = Math.max(0, Math.min(maxScroll, ideal));
    updatePlayhead();
}

function resizeCanvases() {
    const gcRect = graphCanvas.getBoundingClientRect();
    const mmRect = minimapCanvas.getBoundingClientRect();
    const needRetry = gcRect.width <= 0 || gcRect.height <= 0 || mmRect.width <= 0 || mmRect.height <= 0;
    if (gcRect.width > 0 && gcRect.height > 0) graphView.setSize(gcRect.width, gcRect.height);
    if (mmRect.width > 0 && mmRect.height > 0) minimap.setSize(mmRect.width, mmRect.height);
    if (needRetry) requestAnimationFrame(resizeCanvases);
}
const ro = new ResizeObserver(resizeCanvases);
ro.observe(graphScroller);
ro.observe(document.getElementById('graphViewport'));
ro.observe(minimapCanvas);

graphScroller.addEventListener('scroll', () => {
    graphView.setScroll(graphScroller.scrollLeft);
    minimap.setGraphState({
        graphScroll: graphScroller.scrollLeft,
        graphViewportW: graphScroller.clientWidth,
        graphTotalW: graphSpacer.offsetWidth
    });
    updatePlayhead();
});

// Mice with a vertical wheel only — convert delta-Y to horizontal scroll so users without
// a trackpad can still move through the graph. Only when vertical motion dominates, so
// trackpad two-finger pans keep their native behavior.
graphScroller.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && e.deltaX === 0) {
        graphScroller.scrollLeft += e.deltaY;
        e.preventDefault();
    }
}, { passive: false });

// ---------- Now playing ----------
const npMsg = document.getElementById('npMsg');
const npMeta = document.getElementById('npMeta');
function renderNowPlaying(commit) {
    if (!commit) {
        npMsg.textContent = 'Paste a GitHub repo URL above and press Play.';
        npMeta.textContent = '';
        return;
    }
    const firstLine = (commit.message || '').split('\n')[0].slice(0, 120);
    npMsg.textContent = firstLine || '(no commit message)';
    const date = commit.date ? new Date(commit.date).toLocaleDateString() : '';
    const mergeBadge = (commit.parents || []).length >= 2
        ? ' · <span class="mergeBadge">merge</span>'
        : '';
    npMeta.innerHTML =
        `<span class="npSha">${commit.sha.slice(0, 7)}</span> · ` +
        `<span class="npAuthor">${escapeHtml(commit.author)}</span>` +
        (date ? ` · <span class="npDate">${date}</span>` : '') + mergeBadge;
}
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

// ---------- Player wiring ----------
let player = null;
const progressFill = document.getElementById('progressFill');
const progressLabel = document.getElementById('progressLabel');

async function ensurePlayer() {
    if (player) return player;
    player = new MusicPlayer();
    // Don't call resume() here — at init time there's no user gesture yet, and Chrome
    // prints a noisy console warning. resume() happens inside play() which is gesture-driven.
    // Load Soundfonts sequentially to keep memory peaks flat (parallel loading briefly
    // holds multiple copies of decoded sample buffers in memory).
    for (const v of VOICES) {
        await player.setInstrument(v.id, state.voiceInst[v.id]);
    }
    if (state.drumKit) await player.setDrumKit(state.drumKit);
    VOICES.forEach(v => player.setVoiceVolume(v.id, state.voiceMuted[v.id] ? 0 : 0.9));
    player.onBeat = (beat) => flashBeat(beat);
    player.onTick = (commitFloat) => {
        // Smooth scroll + playhead every frame, not just at commit boundaries.
        setGraphScrollForCommitFloat(commitFloat);
    };
    player.onCommit = (commitIdx, sha) => {
        state.currentCommitIdx = commitIdx;
        graphView.flashNode(sha);
        minimap.setPlayhead(commitIdx);
        const commit = state.layout.byRow[commitIdx];
        if (commit) renderNowPlaying(commit);
        const total = state.layout.commits.length;
        progressFill.style.width = `${((commitIdx + 1) / total) * 100}%`;
        progressLabel.textContent = `${commitIdx + 1} / ${total}`;
        syncBranchChips(commitIdx);
    };
    player.onDone = () => { state.isPlaying = false; togglePlayUI(false); };
    return player;
}

function svgIcon(body) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" ' +
        'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        body + '</svg>';
}

function hashString(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h;
}

// ---------- Branch chips (appear/disappear as lanes come in and out of view) ----------
const voicePanelEl_ = () => document.getElementById('voicePanel');

function syncBranchChips(commitIdx) {
    if (!state.layout) return;
    const { laneOpenPlayIdx, laneClosePlayIdx } = state.layout;
    const active = new Set();
    for (let L = 1; L < laneOpenPlayIdx.length; L++) {
        if (laneOpenPlayIdx[L] <= commitIdx && commitIdx <= laneClosePlayIdx[L]) active.add(L);
    }
    const panel = voicePanelEl_();
    // Remove expired chips.
    panel.querySelectorAll('.voiceRow-branch').forEach(el => {
        const lane = parseInt(el.dataset.lane, 10);
        if (!active.has(lane)) el.classList.add('exiting'), setTimeout(() => el.remove(), 250);
    });
    // Add new chips.
    for (const lane of active) {
        if (panel.querySelector(`.voiceRow-branch[data-lane="${lane}"]`)) continue;
        const instrumentId = branchInstrumentFor(lane);
        const instLabel = INSTRUMENTS.find(i => i.id === instrumentId)?.label || instrumentId || '(branch)';
        const chip = document.createElement('div');
        chip.className = 'voiceRow voiceRow-branch appearing';
        chip.dataset.lane = String(lane);
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = laneColor(lane);
        dot.style.boxShadow = `0 0 6px ${laneColor(lane)}`;
        chip.appendChild(dot);
        const label = document.createElement('div');
        label.className = 'voiceLabel';
        label.textContent = 'BRANCH';
        label.style.color = laneColor(lane);
        chip.appendChild(label);
        const inst = document.createElement('div');
        inst.className = 'voiceBranchInst';
        inst.textContent = instLabel;
        chip.appendChild(inst);
        panel.appendChild(chip);
        requestAnimationFrame(() => chip.classList.remove('appearing'));
    }
}

function clearBranchChips() {
    voicePanelEl_().querySelectorAll('.voiceRow-branch').forEach(el => el.remove());
}

function seekTo(playIdx) {
    if (!state.layout) return;
    if (!player || !player._lastScheduleParams) {
        play({ startFromCommit: playIdx });
        return;
    }
    player.seek(playIdx);
    togglePlayUI(true);
}

async function play({ startFromCommit = 0 } = {}) {
    if (!state.layout) return;
    ensureSilentAudio();
    await ensurePlayer();
    await player.resume();
    await preloadBranchInstruments();
    VOICES.forEach(v => player.setVoiceVolume(v.id, state.voiceMuted[v.id] ? 0 : 0.9));
    const style = findStyle(state.styleId);
    const repoSeed = Math.abs(hashString(state.source && state.source.label || 'anon'));
    // Pass full variant arrays to the scheduler; it rotates through them every 8 bars.
    const drumPatterns = (style && style.drumPatterns) || [null];
    const bassPatterns = (style && style.bassPatterns) || [null];
    player.scheduleAll({
        commits: state.layout.commits,
        laneOpenPlayIdx: state.layout.laneOpenPlayIdx,
        laneClosePlayIdx: state.layout.laneClosePlayIdx,
        key: state.key,
        scaleName: state.scaleName,
        tempoBpm: state.tempo,
        accelerate: state.accelerate,
        voiceOctaves: state.voiceOctave,
        voiceMuted: state.voiceMuted,
        drumMuted: !state.drumKit,
        drumPatterns,
        bassPatterns,
        repoSeed,
        branchMotifs: state.branchMotifs,
        commitsPerBar: state.commitsPerBar,
        startFromCommit
    });
    state.isPlaying = true;
    togglePlayUI(true);
}

// Load an instrument for each non-main lane. Re-entrant: only loads new lanes.
// Sequential (not Promise.all) because each Soundfont is a few MB and loading 10 in
// parallel briefly spikes memory enough for Chrome to trip OOM on big repos.
async function preloadBranchInstruments() {
    if (!player || !state.layout) return;
    // Unique pool instruments, not unique lanes — pool sharing means 100 lanes still
    // only need ~7 distinct Soundfonts.
    const lanes = [...new Set(state.layout.commits.map(c => c.lane))].filter(l => l > 0);
    const uniqueInsts = new Set();
    for (const l of lanes) {
        const inst = branchInstrumentFor(l);
        if (!inst) continue;
        if (!uniqueInsts.has(inst)) {
            uniqueInsts.add(inst);
            await player.setBranchInstrument(l, inst);
        } else {
            // Same pool instrument already loaded; associate this lane with it.
            await player.setBranchInstrument(l, inst);
        }
    }
}

function stop() {
    if (player) player.stop();
    state.isPlaying = false;
    togglePlayUI(false);
    clearBranchChips();
}

function togglePlayUI(playing) {
    document.getElementById('playBtn').hidden = playing;
    document.getElementById('stopBtn').hidden = !playing;
}

// ---------- Load flow ----------
// loadSeq lets us discard results from a previously-initiated load if the user starts a new
// load before it completes. Without this, a slow GitHub fetch could overwrite a local load.
function newLoadSeq() {
    state.loadSeq += 1;
    stop(); // cancel any currently-playing audio from the previous source
    return state.loadSeq;
}

async function loadRepo(url) {
    const parsed = parseRepoUrl(url);
    if (!parsed) { toast('Could not parse that URL — try owner/repo or a github.com URL', 'error'); return; }
    const seq = newLoadSeq();
    const gh = new GitHubClient({ token: state.token });
    toast(`Loading ${parsed.owner}/${parsed.repo}…`);
    try {
        const [commits, branches] = await Promise.all([
            gh.getCommits(parsed.owner, parsed.repo, { max: state.maxCommits }),
            gh.getBranches(parsed.owner, parsed.repo, { max: 30 })
        ]);
        if (seq !== state.loadSeq) return; // a newer load started — drop
        if (!commits.length) {
            toast('Repo has no commits (or is not accessible).', 'error', 6000);
            return;
        }
        loadCommits(commits, branches, {
            kind: 'github',
            label: `${parsed.owner}/${parsed.repo}`
        });
    } catch (e) {
        if (seq !== state.loadSeq) return;
        console.error(e);
        toast(e.message || String(e), 'error', 8000);
    }
}

// Shared post-fetch path used by GitHub, local folder, and file drop.
async function loadCommits(rawCommits, branches = [], source = {}) {
    if (!rawCommits || !rawCommits.length) {
        toast('No commits to play.', 'error');
        return;
    }
    // Reflect the source in the URL input so it's clear what's playing.
    const urlInput = document.getElementById('repoUrl');
    if (source.kind === 'local' || source.kind === 'file') {
        urlInput.value = '';
        urlInput.placeholder = `${source.kind === 'local' ? '📁' : '📄'} ${source.label}`;
    } else if (source.kind === 'github') {
        urlInput.value = `https://github.com/${source.label}`;
    }
    state.rawCommits = rawCommits;
    applyCommits(rawCommits, branches, source);

    // Suggest a sensible density for big repos.
    const n = rawCommits.length;
    if (n >= 20000 && state.sampleRate < 10) {
        toast(`${n} commits — consider Settings → Sample rate = 10 or 25 to keep the graph + audio snappy.`, 'info', 8000);
    } else if (n >= 5000 && state.commitsPerBar < 8) {
        toast(`${n} commits — consider main bar → Density = 8 to keep it under ~20 min.`, 'info', 7000);
    } else if (n >= 1000 && state.commitsPerBar < 4) {
        toast(`${n} commits — consider main bar → Density = 4.`, 'info', 6000);
    } else {
        toast(`Loaded ${n} commits. Press Play ▶ when ready.`);
    }
}

// Apply sampling + layout + render from the current raw commits.
// Called on initial load and when user changes Settings → Sample rate.
function applyCommits(rawCommits, branches, source) {
    state.source = source;
    state.branches = branches;

    const sampled = sampleCommits(rawCommits, state.sampleRate);
    state.commits = sampled;

    state.layout = layoutCommits(sampled);
    state.key = deriveKey(source.label || 'unknown/unknown');
    computeLaneInstruments();

    // Spacer only provides horizontal scroll extent; it's not the canvas's parent anymore.
    const totalW = totalGraphWidth(state.layout);
    graphSpacer.style.width = totalW + 'px';
    resizeCanvases();
    graphView.render(state.layout);
    minimap.render(state.layout);
    minimap.setGraphState({
        graphScroll: graphScroller.scrollLeft,
        graphViewportW: graphScroller.clientWidth,
        graphTotalW: totalW
    });

    graphEmpty.hidden = true;

    // Park the playhead on the oldest commit (left edge, play starts here).
    graphScroller.scrollLeft = 0;
    graphView.setScroll(0);
    currentCommitWorldX = GRAPH_CONSTANTS.LEFT_PAD;
    updatePlayhead();

    npMsg.textContent = `${source.label || 'repo'} · key of ${state.key.root} ${state.scaleName}`;
    const parts = [
        `${rawCommits.length} commits`,
        state.sampleRate > 1 ? `sampled to ${sampled.length}` : null,
        `${branches.length} branches`,
        `${state.commitsPerBar}/bar`,
        state.accelerate > 0 ? `accel ×${(1 + state.accelerate).toFixed(1)}` : null
    ].filter(Boolean);
    npMeta.textContent = parts.join(' · ');
}

// ---------- Init ----------
function init() {
    loadPrefs();
    buildBeatBar();
    buildVoicePanel();
    wireSheets();
    renderNowPlaying(null);

    // Kick off Soundfont loading in the background so Play has no warm-up pause.
    // AudioContext can be constructed suspended; Soundfont.load just fetches samples.
    // The actual audio won't start until a user gesture calls resume().
    ensurePlayer().catch(e => console.warn('instrument preload failed', e));

    const form = document.getElementById('repoForm');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const url = document.getElementById('repoUrl').value.trim();
        // If there's a URL that differs from what's loaded, fetch it first.
        if (url) {
            const currentLabel = state.source && state.source.label;
            const m = url.match(/(?:github\.com\/)?([^/\s]+\/[^/\s#?]+)/i);
            const desiredLabel = m ? m[1].replace(/\.git$/, '') : null;
            if (!state.layout || currentLabel !== desiredLabel) {
                await loadRepo(url);
            }
        }
        // Then play whatever is loaded. Local/file paths don't come through here, so those
        // users explicitly press Play after picking the folder/file.
        if (state.layout && !state.isPlaying) await play();
    });

    document.getElementById('stopBtn').addEventListener('click', stop);

    // Drag anywhere on the page to drop a .log or .json file.
    installDropZone({
        onCommits: (commits, filename) => {
            loadCommits(commits, [], { kind: 'file', label: filename });
        },
        onError: (e) => toast(e.message || String(e), 'error', 6000),
        onEnter: () => document.body.classList.add('isDropping'),
        onLeave: () => document.body.classList.remove('isDropping')
    });

    // Browsers require a user gesture to resume the AudioContext. We also start
    // a looping silent <audio> on the same gesture so iOS promotes the page to
    // the "playback" audio session and Web Audio ignores the silent switch.
    const onFirstGesture = () => {
        if (player) player.resume();
        ensureSilentAudio();
        document.body.removeEventListener('click', onFirstGesture);
        document.body.removeEventListener('touchstart', onFirstGesture);
    };
    document.body.addEventListener('click', onFirstGesture);
    document.body.addEventListener('touchstart', onFirstGesture);

    // ?repo=… deep link
    const params = new URLSearchParams(window.location.search);
    const deep = params.get('repo');
    if (deep) {
        document.getElementById('repoUrl').value = deep;
        // Small delay so Tonal and the audio context can come up.
        setTimeout(() => form.requestSubmit(), 300);
    }
}

// Init once Tonal is ready (fall back after a short timeout so we never hang).
function initWhenReady() {
    if (window.Tonal) { init(); return; }
    let initialized = false;
    const go = () => {
        if (initialized) return;
        initialized = true;
        init();
    };
    window.addEventListener('tonalLoaded', go, { once: true });
    setTimeout(go, 4000);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWhenReady);
} else {
    initWhenReady();
}

// Expose key internals on window for devtools debugging.
// (Read-only inspection — don't ship this as part of a public API.)
window.rebass = {
    get state() { return state; },
    get graphView() { return graphView; },
    get minimap() { return minimap; },
    get player() { return player; },
    forceRedraw() { graphView.scheduleDraw(); minimap.scheduleDraw(); },
    diagnose() {
        const el = (id) => document.getElementById(id);
        const r = (x) => x && x.getBoundingClientRect && x.getBoundingClientRect();
        return {
            viewport: r(el('graphViewport')),
            scroller: r(el('graphScroller')),
            canvas:   r(el('graphCanvas')),
            canvasW:  el('graphCanvas').width,
            canvasH:  el('graphCanvas').height,
            scrollX:  graphView.scrollX,
            viewportW: graphView.viewportW,
            viewportH: graphView.viewportH,
            hasLayout: !!graphView.layout,
            commits:  graphView.layout?.commits.length,
            lanes:    graphView.layout?.laneCount
        };
    }
};
