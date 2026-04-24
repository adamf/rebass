// Music engine.
//
// Fixed voices (always playing, bar-aligned): bass / lead / pad / bell
// Drum voice: kick / snare / hats, fixed techno pattern.
// Branch voices: one extra instrument per non-main lane; starts when the lane opens,
//   stops when the lane closes. Adds sonic variety to branchy histories.
//
// Tempo acceleration: per-commit slot durations are ramped from base BPM to base * (1 + accel)
// by the last commit, giving the track a build-to-the-present feel.

import { Soundfont, DrumMachine } from 'https://cdn.jsdelivr.net/npm/smplr@0.20.0/dist/index.mjs';

export const INSTRUMENTS = [
    // Synth-leaning first (techno defaults).
    { id: 'synth_bass_1', label: 'Synth Bass 1' },
    { id: 'synth_bass_2', label: 'Synth Bass 2' },
    { id: 'lead_1_square', label: 'Square Lead' },
    { id: 'lead_2_sawtooth', label: 'Saw Lead' },
    { id: 'lead_3_calliope', label: 'Calliope Lead' },
    { id: 'lead_5_charang', label: 'Charang Lead' },
    { id: 'lead_7_fifths', label: 'Fifths Lead' },
    { id: 'lead_8_bass__lead', label: 'Bass + Lead' },
    { id: 'pad_1_new_age', label: 'New Age Pad' },
    { id: 'pad_2_warm', label: 'Warm Pad' },
    { id: 'pad_3_polysynth', label: 'Polysynth Pad' },
    { id: 'pad_4_choir', label: 'Choir Pad' },
    { id: 'pad_5_bowed', label: 'Bowed Pad' },
    { id: 'pad_6_metallic', label: 'Metallic Pad' },
    { id: 'pad_7_halo', label: 'Halo Pad' },
    { id: 'pad_8_sweep', label: 'Sweep Pad' },
    { id: 'fx_1_rain', label: 'FX: Rain' },
    { id: 'fx_2_soundtrack', label: 'FX: Soundtrack' },
    { id: 'fx_3_crystal', label: 'FX: Crystal' },
    { id: 'fx_5_brightness', label: 'FX: Brightness' },
    { id: 'fx_7_echoes', label: 'FX: Echoes' },
    // Acoustic / classical
    { id: 'acoustic_grand_piano', label: 'Grand Piano' },
    { id: 'electric_piano_1', label: 'Electric Piano' },
    { id: 'celesta', label: 'Celesta' },
    { id: 'music_box', label: 'Music Box' },
    { id: 'vibraphone', label: 'Vibraphone' },
    { id: 'marimba', label: 'Marimba' },
    { id: 'xylophone', label: 'Xylophone' },
    { id: 'tubular_bells', label: 'Tubular Bells' },
    { id: 'kalimba', label: 'Kalimba' },
    { id: 'church_organ', label: 'Church Organ' },
    { id: 'drawbar_organ', label: 'Drawbar Organ' },
    { id: 'acoustic_bass', label: 'Acoustic Bass' },
    { id: 'electric_bass_finger', label: 'Electric Bass (Finger)' },
    { id: 'fretless_bass', label: 'Fretless Bass' },
    { id: 'electric_guitar_clean', label: 'Electric Guitar' },
    { id: 'distortion_guitar', label: 'Distortion Guitar' },
    { id: 'violin', label: 'Violin' },
    { id: 'cello', label: 'Cello' },
    { id: 'pizzicato_strings', label: 'Pizzicato Strings' },
    { id: 'orchestral_harp', label: 'Harp' },
    { id: 'string_ensemble_1', label: 'Strings' },
    { id: 'choir_aahs', label: 'Choir' },
    { id: 'flute', label: 'Flute' },
    { id: 'pan_flute', label: 'Pan Flute' },
    { id: 'alto_sax', label: 'Alto Sax' },
    { id: 'trumpet', label: 'Trumpet' },
    { id: 'sitar', label: 'Sitar' },
    { id: 'steel_drums', label: 'Steel Drums' },
    { id: 'timpani', label: 'Timpani' }
];

// Techno defaults: synth bass + square lead + halo pad + crystal bell.
export const VOICES = [
    { id: 'bass', label: 'Bass', defaultInst: 'synth_bass_1',  defaultOctave: 2 },
    { id: 'lead', label: 'Lead', defaultInst: 'lead_2_sawtooth', defaultOctave: 4 },
    { id: 'pad',  label: 'Pad',  defaultInst: 'pad_7_halo',    defaultOctave: 3 },
    { id: 'bell', label: 'Bell', defaultInst: 'fx_3_crystal',  defaultOctave: 5 }
];

// Instruments for branch voices. Each non-main lane picks one by index (rotating).
const BRANCH_POOL = [
    'marimba',
    'pizzicato_strings',
    'kalimba',
    'vibraphone',
    'steel_drums',
    'ocarina',
    'orchestral_harp',
    'banjo'
];

// Drum kits smplr 0.20's DrumMachine actually ships. Note: no TR-909 (despite the techno dream).
export const DRUM_KITS = ['TR-808', 'Roland CR-8000', 'LM-2', 'MFB-512', 'Casio-RZ1'];
export const DEFAULT_DRUM_KIT = 'TR-808';

const getTonal = () => window.Tonal || null;

export function deriveKey(repoFullName) {
    let h = 2166136261;
    for (let i = 0; i < repoFullName.length; i++) {
        h ^= repoFullName.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    const roots = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
    const root = roots[Math.abs(h) % roots.length];
    return { root };
}

// Cap how many octaves a scale-degree index can climb. Without this, scale-degrees beyond
// the scale length wrap into the octaves above — which is fine on a 7-note scale but
// pentatonic (5 notes) makes everything jump 40% faster, causing painful high pitches.
const MAX_OCT_SHIFT = 1;

export function noteAt(root, scaleName, degreeIdx, octave) {
    const T = getTonal();
    if (T) {
        const s = T.Scale.get(`${root} ${scaleName}`);
        const intervals = s && s.intervals;
        if (intervals && intervals.length) {
            const n = intervals.length;
            const rawShift = Math.floor(degreeIdx / n);
            const octShift = Math.max(0, Math.min(MAX_OCT_SHIFT, rawShift));
            const adjustedDegree = degreeIdx - (rawShift - octShift) * n;
            const wrapped = ((adjustedDegree % n) + n) % n;
            const base = root + (octave + octShift);
            const pitch = T.Note.transpose(base, intervals[wrapped]);
            const simplified = T.Note.simplify ? T.Note.simplify(pitch) : pitch;
            return simplified || pitch || base;
        }
    }
    const pent = ['A', 'C', 'D', 'E', 'G'];
    const n = pent.length;
    const rawShift = Math.floor(degreeIdx / n);
    const octShift = Math.max(0, Math.min(MAX_OCT_SHIFT, rawShift));
    const wrapped = ((degreeIdx % n) + n) % n;
    return pent[wrapped] + (octave + octShift);
}

function hashByte(sha, start) { return parseInt(sha.slice(start, start + 2), 16) || 0; }

export function commitToMusic(commit) {
    const sha = commit.sha || '0000000000';
    const a = hashByte(sha, 0);
    const b = hashByte(sha, 2);
    const c = hashByte(sha, 4);
    const d = hashByte(sha, 6);
    const msgLen = (commit.message || '').length;
    const isMerge = (commit.parents || []).length >= 2;
    return {
        sha,
        isMerge,
        degree: a % 7,
        thirdStep: (a % 7) + 2,
        fifthStep: (a % 7) + 4,
        leadWobble: (b % 5) - 2,
        leadVelocity: 55 + (c % 50),
        padVelocity: 40 + (b % 30),
        accent: msgLen > 120 || isMerge,
        density: Math.min(4, 1 + Math.floor(msgLen / 60)),
        panHint: (d / 255 - 0.5) * 0.4
    };
}

export class MusicPlayer {
    constructor() {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC();

        this.master = this.ctx.createGain();
        this.master.gain.value = 0.65;
        this.compressor = this.ctx.createDynamicsCompressor();
        this.compressor.threshold.value = -18;
        this.compressor.knee.value = 12;
        this.compressor.ratio.value = 4;
        this.compressor.attack.value = 0.005;
        this.compressor.release.value = 0.25;
        this.master.connect(this.compressor);
        this.compressor.connect(this.ctx.destination);

        this.voiceInstruments = {};     // voice id → Soundfont
        this.voiceChains = {};          // voice id → { gain, panner }
        this.branchInstruments = {};    // lane number (>=1) → Soundfont
        this.branchChains = {};         // lane number → { gain, panner }
        this.drum = null;               // DrumMachine instance
        this.drumChain = null;          // { gain, panner }
        this.drumSampleNames = null;    // { kick, snare, hat } → resolved sample names

        this.onBeat = null;
        this.onBar  = null;
        this.onCommit = null;
        this.onTick = null;  // (commitFloat, elapsedT) — fires every RAF for smooth playhead
        this.onDone = null;

        this.rafId = null;
        this.startCtxTime = 0;
        this.commitTimes = [];          // absolute start time of commit i relative to startCtxTime
        this.commitDurations = [];
        this.totalDuration = 0;
        this.orderedShas = [];
        this._lastBar = -1;
        this._lastCommit = -1;
    }

    async resume() {
        if (this.ctx.state === 'suspended') {
            try { await this.ctx.resume(); } catch (_) {}
        }
    }

    _getOrCreateChain(registry, id) {
        let chain = registry[id];
        if (chain) return chain;
        const gain = this.ctx.createGain();
        gain.gain.value = 0.9;
        let panner = null;
        if (this.ctx.createStereoPanner) {
            panner = this.ctx.createStereoPanner();
            gain.connect(panner);
            panner.connect(this.master);
        } else {
            gain.connect(this.master);
        }
        chain = { gain, panner };
        registry[id] = chain;
        return chain;
    }

    async setInstrument(voiceId, instrumentId) {
        const chain = this._getOrCreateChain(this.voiceChains, voiceId);
        // LRU cache per voice — at most 2 Soundfonts kept (current + previous). This keeps
        // A↔B flipping fast while bounding memory so 6-way style cycling doesn't OOM.
        if (!this._voiceCache) this._voiceCache = {};
        if (!this._voiceCache[voiceId]) this._voiceCache[voiceId] = [];
        const list = this._voiceCache[voiceId];
        let entry = list.find(e => e.id === instrumentId);
        if (!entry) {
            const sf = new Soundfont(this.ctx, { instrument: instrumentId, destination: chain.gain });
            try { await sf.load; } catch (e) { console.error('Instrument load failed', instrumentId, e); }
            entry = { id: instrumentId, sf };
            list.push(entry);
            while (list.length > 2) {
                const evicted = list.shift();
                try { evicted.sf.stop(); } catch (_) {}
                try { evicted.sf.disconnect && evicted.sf.disconnect(); } catch (_) {}
            }
        } else {
            // Move to most-recent slot.
            const i = list.indexOf(entry);
            if (i < list.length - 1) { list.splice(i, 1); list.push(entry); }
        }
        const old = this.voiceInstruments[voiceId];
        if (old && old !== entry.sf && typeof old.stop === 'function') { try { old.stop(); } catch (_) {} }
        this.voiceInstruments[voiceId] = entry.sf;
        return entry.sf;
    }

    async setBranchInstrument(lane, instrumentId) {
        // Load one Soundfont per pool instrument, not per lane. A 100-lane repo with an
        // 8-instrument pool loads 8 Soundfonts instead of 100, which is the difference
        // between a snappy Play button and a multi-second pause.
        if (!this._branchPool) this._branchPool = {};
        let pool = this._branchPool[instrumentId];
        if (!pool) {
            const chain = this._getOrCreateChain(this.branchChains, 'pool:' + instrumentId);
            const sf = new Soundfont(this.ctx, { instrument: instrumentId, destination: chain.gain });
            try { await sf.load; } catch (e) { console.error('Branch instrument load failed', instrumentId, e); }
            pool = { sf, chain };
            this._branchPool[instrumentId] = pool;
        }
        // Point this lane at the pooled Soundfont + its chain. Scheduler still keys pan
        // by lane (via branchChains[lane]), and lanes sharing a pool instrument share
        // the panner — last-set pan wins for the brief per-note overlap.
        this.branchInstruments[lane] = pool.sf;
        this.branchChains[lane] = pool.chain;
        return pool.sf;
    }

    async setDrumKit(kitName) {
        if (!this.drumChain) this.drumChain = this._getOrCreateChain({ _: null }, 'drums');
        let drums;
        try {
            drums = new DrumMachine(this.ctx, { instrument: kitName, destination: this.drumChain.gain });
        } catch (e) {
            console.error('DrumMachine constructor failed', kitName, e);
            throw e;
        }
        try { await drums.load; } catch (e) { console.error('DrumMachine load failed', kitName, e); }
        const old = this.drum;
        if (old && old !== drums && typeof old.stop === 'function') { try { old.stop(); } catch (_) {} }
        this.drum = drums;
        this.drumSampleNames = resolveDrumSampleNames(drums.sampleNames || []);
    }

    setPan(voiceId, pan) {
        const chain = this.voiceChains[voiceId];
        if (!chain || !chain.panner) return;
        const v = Math.max(-1, Math.min(1, pan));
        try { chain.panner.pan.setTargetAtTime(v, this.ctx.currentTime, 0.05); }
        catch (_) { chain.panner.pan.value = v; }
    }

    setVoiceVolume(voiceId, vol) {
        const chain = this.voiceChains[voiceId];
        if (!chain) return;
        const v = Math.max(0, Math.min(1, vol));
        try { chain.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); }
        catch (_) { chain.gain.gain.value = v; }
    }

    _schedulePan(registry, id, pan, time) {
        const chain = registry[id];
        if (!chain || !chain.panner) return;
        try { chain.panner.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), time); }
        catch (_) { chain.panner.pan.value = pan; }
    }

    /**
     * Schedule an entire timeline.
     *
     * params:
     *   commits         — layout commits (have row + lane fields)
     *   laneOpenPlayIdx, laneClosePlayIdx  — lane activity windows from layout
     *   key, scaleName
     *   tempoBpm        — base BPM at the start
     *   accelerate      — 0 (off) .. positive; final-commit speed multiplier. e.g. 0.6 = 60% faster by the end.
     *   commitsPerBar   — 1/2/4/8; packs commits into bars
     *   voiceOctaves, voiceMuted
     *   drumMuted       — if false, schedules the drum pattern
     *   startFromCommit — seek offset (play-order index)
     */
    scheduleAll(params) {
        const {
            commits,
            laneOpenPlayIdx = [],
            laneClosePlayIdx = [],
            key, scaleName, tempoBpm,
            accelerate = 0,
            voiceOctaves, voiceMuted,
            drumMuted = false,
            drumPattern = null,
            bassPattern = null,
            branchMotifs = true,
            commitsPerBar = 1,
            startFromCommit = 0
        } = params;
        this._lastScheduleParams = params;
        this.stop();
        this._reconnectChains();

        const cpb = Math.max(1, Math.min(16, commitsPerBar | 0));
        const baseBeatDur = 60 / tempoBpm;
        const baseBarDur = 4 * baseBeatDur;
        const baseCommitDur = baseBarDur / cpb;

        const fullOrder = commits.slice().sort((a, b) => a.row - b.row); // oldest first
        this.orderedShas = fullOrder.map(c => c.sha);
        this.totalCommits = fullOrder.length;
        this.startFromCommit = Math.max(0, Math.min(fullOrder.length - 1, startFromCommit | 0));

        // Precompute per-commit duration with linear acceleration.
        const N = fullOrder.length;
        const accel = Math.max(0, accelerate);
        const commitDur = new Array(N);
        for (let i = 0; i < N; i++) {
            const progress = N > 1 ? i / (N - 1) : 0;
            const speed = 1 + accel * progress;
            commitDur[i] = baseCommitDur / speed;
        }
        // Cumulative start times, offset so startFromCommit is at t=0.
        const startTimes = new Array(N);
        let cursor = 0;
        for (let i = 0; i < N; i++) {
            if (i < this.startFromCommit) { startTimes[i] = 0; continue; }
            startTimes[i] = cursor;
            cursor += commitDur[i];
        }
        this.commitTimes = startTimes;
        this.commitDurations = commitDur;
        this.totalDuration = cursor;

        const now = this.ctx.currentTime + 0.2;
        this.startCtxTime = now;
        this._lastBar = -1;
        this._lastCommit = this.startFromCommit - 1;

        const bass = this.voiceInstruments.bass;
        const lead = this.voiceInstruments.lead;
        const pad  = this.voiceInstruments.pad;
        const bell = this.voiceInstruments.bell;

        const oct = {
            bass: voiceOctaves.bass ?? 2,
            lead: voiceOctaves.lead ?? 4,
            pad:  voiceOctaves.pad  ?? 3,
            bell: voiceOctaves.bell ?? 5
        };
        const mute = voiceMuted || {};
        const laneCount = laneOpenPlayIdx.length || fullOrder.reduce((m, c) => Math.max(m, c.lane + 1), 0);
        const maxLane = Math.max(0, laneCount - 1);

        // Stash everything the rolling scheduler needs.
        this._scheduleCtx = {
            now, fullOrder, startTimes, commitDur, cpb, key, scaleName,
            oct, mute, maxLane, drumPattern, drumMuted, bassPattern, branchMotifs,
            laneOpenPlayIdx, laneClosePlayIdx,
            N
        };
        this._nextBarStart = this.startFromCommit;
        this._startLookahead();
        this._startRaf();
    }

    // -------- Rolling scheduler --------
    //
    // Pre-scheduling the whole timeline creates tens of thousands of AudioBufferSourceNodes
    // for long repos (and millions for 16th-note drums on 8K-commit histories), which OOMs
    // the page. Instead, schedule bars only as they come within a lookahead window. Memory
    // stays bounded by the window, not by timeline length.
    _startLookahead() {
        const LOOKAHEAD_SEC = 1.5;
        const INTERVAL_MS = 100;
        if (this._lookaheadTimer) clearInterval(this._lookaheadTimer);
        const tick = () => {
            const ctx = this._scheduleCtx;
            if (!ctx) return;
            const t = this.ctx.currentTime - this.startCtxTime;
            while (this._nextBarStart < ctx.N) {
                const barStartT = ctx.startTimes[this._nextBarStart];
                if (barStartT > t + LOOKAHEAD_SEC) break;
                this._scheduleOneBar(this._nextBarStart);
                this._nextBarStart += ctx.cpb;
            }
            if (this._nextBarStart >= ctx.N) {
                clearInterval(this._lookaheadTimer);
                this._lookaheadTimer = null;
            }
        };
        tick(); // prime the initial window
        this._lookaheadTimer = setInterval(tick, INTERVAL_MS);
    }

    _scheduleOneBar(barStart) {
        const ctx = this._scheduleCtx;
        if (!ctx) return;
        const {
            now, fullOrder, startTimes, commitDur, cpb, key, scaleName, oct, mute,
            maxLane, drumPattern, drumMuted, bassPattern, branchMotifs,
            laneOpenPlayIdx, laneClosePlayIdx, N
        } = ctx;
        const barEnd = Math.min(N, barStart + cpb);
        const m0 = commitToMusic(fullOrder[barStart]);
        const tBarStart = now + startTimes[barStart];
        const tBarEnd = now + (barEnd < N ? startTimes[barEnd] : startTimes[N - 1] + commitDur[N - 1]);
        const barDur = tBarEnd - tBarStart;
        const beatDur = barDur / 4;

        const bass = this.voiceInstruments.bass;
        const lead = this.voiceInstruments.lead;
        const pad  = this.voiceInstruments.pad;
        const bell = this.voiceInstruments.bell;

        if (pad && !mute.pad) {
            const chord = [
                noteAt(key.root, scaleName, m0.degree,    oct.pad),
                noteAt(key.root, scaleName, m0.thirdStep, oct.pad),
                noteAt(key.root, scaleName, m0.fifthStep, oct.pad + (m0.isMerge ? 1 : 0))
            ];
            for (const n of chord) {
                try { pad.start({ note: n, time: tBarStart, duration: barDur * 0.95, velocity: m0.padVelocity }); }
                catch (_) {}
            }
        }
        if (bass && !mute.bass) {
            // Drive bass from the style's pattern. Each event is {step (0..15), degree,
            // velocity, durBeats}. step*stepDur = offset within the bar, where stepDur is
            // a sixteenth note. Bar chord changes with each commit's SHA (m0.degree shifts
            // the root around); subtract m0.degree from each event's degree to keep the
            // pattern shape stable while following the chord.
            const stepDur = beatDur / 4;
            const pattern = bassPattern || [
                { step: 0, degree: 0, vel: 90, dur: 1.8 },
                { step: 8, degree: 4, vel: 78, dur: 1.6 }
            ];
            for (const ev of pattern) {
                try {
                    bass.start({
                        note: noteAt(key.root, scaleName, ev.degree + m0.degree, oct.bass),
                        time: tBarStart + ev.step * stepDur,
                        duration: Math.max(0.08, (ev.dur || 1) * beatDur * 0.95),
                        velocity: ev.vel || 80
                    });
                } catch (_) {}
            }
        }

        if (this.drum && !drumMuted && this.drumSampleNames && drumPattern) {
            const names = this.drumSampleNames;
            const d = this.drum;
            const stepDur = beatDur / 4;
            for (const role of ['kick', 'snare', 'hat', 'open', 'clap', 'ride']) {
                const steps = drumPattern[role];
                const sample = names[role];
                if (!steps || !sample) continue;
                for (let s = 0; s < steps.length && s < 16; s++) {
                    const v = steps[s];
                    if (!v) continue;
                    try { d.start({ note: sample, time: tBarStart + s * stepDur, velocity: v }); }
                    catch (_) {}
                }
            }
        }

        // Per-commit voices for the commits inside this bar
        for (let i = barStart; i < barEnd; i++) {
            const commit = fullOrder[i];
            const m = commitToMusic(commit);
            const t0 = now + startTimes[i];
            const dur = commitDur[i];

            if (lead && !mute.lead) {
                const lanePan = maxLane > 0 ? ((commit.lane / maxLane) - 0.5) * 1.3 : 0;
                const pan = Math.max(-0.9, Math.min(0.9, lanePan + m.panHint));
                this._schedulePan(this.voiceChains, 'lead', pan, t0);
                const notesInCommit = cpb >= 4 ? 1 : Math.min(m.density, Math.max(1, Math.floor(4 / cpb)));
                // All notes within a single commit stay in the same octave — previously the
                // 3rd/4th notes jumped up an octave, which made bursts of dense commits feel
                // like a perpetual ascending climb. Variety now comes from degree, not octave.
                const degrees = [m.degree, m.thirdStep + m.leadWobble, m.fifthStep, m.degree - 2];
                for (let k = 0; k < notesInCommit; k++) {
                    const slotOffset = k * (dur / notesInCommit);
                    const deg = degrees[k % degrees.length];
                    try {
                        lead.start({
                            note: noteAt(key.root, scaleName, deg, oct.lead),
                            time: t0 + slotOffset,
                            duration: Math.max(0.08, (dur / notesInCommit) * 0.9),
                            velocity: Math.max(30, m.leadVelocity - k * 6)
                        });
                    } catch (_) {}
                }
            }

            if (bell && !mute.bell && m.accent) {
                try {
                    bell.start({
                        note: noteAt(key.root, scaleName, m.fifthStep, oct.bell),
                        time: t0, duration: Math.max(0.4, dur * 3), velocity: 95
                    });
                    if (m.isMerge) {
                        // Was oct.bell + 1 — already piercing at bell octaves; keep same octave.
                        bell.start({
                            note: noteAt(key.root, scaleName, m.degree, oct.bell),
                            time: t0 + dur * 0.3,
                            duration: Math.max(0.3, dur * 2.5),
                            velocity: 85
                        });
                    }
                } catch (_) {}
            }

            if (commit.lane > 0 && !mute.branch) {
                const bsf = this.branchInstruments[commit.lane];
                if (bsf) {
                    const lanePan = maxLane > 0 ? ((commit.lane / maxLane) - 0.5) * 1.3 : 0;
                    this._schedulePan(this.branchChains, commit.lane,
                        Math.max(-0.9, Math.min(0.9, lanePan)), t0);
                    try {
                        bsf.start({
                            note: noteAt(key.root, scaleName, m.thirdStep, oct.lead),
                            time: t0,
                            duration: Math.max(0.1, dur * 1.4),
                            velocity: 70
                        });
                        if (laneOpenPlayIdx[commit.lane] === i && branchMotifs) {
                            // 3-note motif from the opening commit's SHA. Contour shape
                            // chosen from the SHA so some branches ascend, some descend,
                            // some peak, some valley — avoids the "always climbing" feel
                            // when lots of branches open in a row.
                            const sha = commit.sha || '';
                            const b0 = parseInt(sha.slice(14, 16), 16) || 0;
                            const b1 = parseInt(sha.slice(16, 18), 16) || 0;
                            const b2 = parseInt(sha.slice(18, 20), 16) || 0;
                            const b3 = parseInt(sha.slice(20, 22), 16) || 0;
                            const CONTOURS = [
                                [b1 % 3,       (b2 % 3) + 1, (b3 % 3) + 2],  // ascending
                                [(b1 % 3) + 2, (b2 % 3) + 1,  b3 % 3      ],  // descending
                                [ b1 % 3,      (b2 % 3) + 2,  b3 % 3      ],  // peak
                                [(b1 % 3) + 1,  b2 % 3,      (b3 % 3) + 1]   // valley
                            ];
                            const motif = CONTOURS[b0 % CONTOURS.length];
                            for (let k = 0; k < 3; k++) {
                                bsf.start({
                                    note: noteAt(key.root, scaleName, motif[k], oct.lead),
                                    time: t0 + k * (dur * 0.3),
                                    duration: Math.max(0.15, dur * 0.28),
                                    velocity: 95 - k * 6
                                });
                            }
                        }
                        if (laneClosePlayIdx[commit.lane] === i) {
                            bsf.start({
                                note: noteAt(key.root, scaleName, m.degree, oct.lead - 1),
                                time: t0 + dur * 0.4,
                                duration: Math.max(0.3, dur * 1.8),
                                velocity: 70
                            });
                        }
                    } catch (_) {}
                }
            }
        }
    }

    _findCommitIdx(t) {
        // Binary search over commitTimes.
        const times = this.commitTimes;
        const offset = this.startFromCommit;
        let lo = offset, hi = times.length - 1;
        if (lo > hi || t <= 0) return offset;
        while (lo < hi) {
            const mid = (lo + hi + 1) >>> 1;
            if (times[mid] <= t + (this.startFromCommit === 0 ? 0 : times[offset])) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    _startRaf() {
        const step = () => {
            const t = this.ctx.currentTime - this.startCtxTime;
            if (t < 0) {
                this.rafId = requestAnimationFrame(step);
                return;
            }
            const commitIdx = this._findCommitIdx(t);
            const cpb = Math.max(1, Math.min(16, (this._lastScheduleParams?.commitsPerBar | 0) || 1));

            // Bar index (relative to startFromCommit): 0-based.
            const relFromStart = commitIdx - (this.startFromCommit || 0);
            const barIdx = Math.floor(relFromStart / cpb);

            // Compute beat-in-bar from the commit's slot.
            const barStartCommit = this.startFromCommit + barIdx * cpb;
            const barEndCommit = Math.min(this.totalCommits, barStartCommit + cpb);
            const tBarStart = this.commitTimes[barStartCommit] || 0;
            const tBarEnd = barEndCommit < this.totalCommits
                ? this.commitTimes[barEndCommit]
                : (this.commitTimes[this.totalCommits - 1] + this.commitDurations[this.totalCommits - 1]);
            const barDur = Math.max(0.001, tBarEnd - tBarStart);
            const beatInBar = Math.max(0, Math.min(4, ((t - tBarStart) / barDur) * 4));

            // Fractional commit position — used by UI for smooth playhead + scroll.
            let commitFloat = commitIdx;
            if (commitIdx + 1 < this.totalCommits) {
                const slotStart = this.commitTimes[commitIdx];
                const slotEnd = this.commitTimes[commitIdx + 1];
                commitFloat = commitIdx + Math.max(0, Math.min(1, (t - slotStart) / Math.max(0.001, slotEnd - slotStart)));
            }
            if (this.onTick) this.onTick(commitFloat, t);

            if (this.onBeat) this.onBeat(beatInBar, barIdx);
            if (barIdx !== this._lastBar) {
                this._lastBar = barIdx;
                if (this.onBar && barStartCommit < this.orderedShas.length) {
                    this.onBar(barIdx, this.orderedShas[barStartCommit]);
                }
            }
            if (commitIdx !== this._lastCommit) {
                this._lastCommit = commitIdx;
                if (this.onCommit && commitIdx < this.orderedShas.length) {
                    this.onCommit(commitIdx, this.orderedShas[commitIdx]);
                }
            }
            if (t >= this.totalDuration) {
                this.rafId = null;
                if (this.onDone) this.onDone();
                return;
            }
            this.rafId = requestAnimationFrame(step);
        };
        if (this.rafId) cancelAnimationFrame(this.rafId);
        this.rafId = requestAnimationFrame(step);
    }

    /** Re-schedule from a specific commit (play-order index). */
    seek(commitIdx) {
        if (!this._lastScheduleParams) return;
        const next = { ...this._lastScheduleParams, startFromCommit: commitIdx };
        this.scheduleAll(next);
    }

    stop() {
        if (this.rafId) cancelAnimationFrame(this.rafId);
        this.rafId = null;
        if (this._lookaheadTimer) clearInterval(this._lookaheadTimer);
        this._lookaheadTimer = null;
        this._scheduleCtx = null;
        // smplr's stop() doesn't cancel notes that are scheduled to start in the future.
        // Our rolling scheduler keeps ~1.5s of scheduled audio; disconnecting the chain
        // immediately silences whatever is already queued to the destination.
        for (const id of Object.keys(this.voiceInstruments)) {
            const sf = this.voiceInstruments[id];
            if (sf && typeof sf.stop === 'function') { try { sf.stop(); } catch (_) {} }
        }
        for (const lane of Object.keys(this.branchInstruments)) {
            const sf = this.branchInstruments[lane];
            if (sf && typeof sf.stop === 'function') { try { sf.stop(); } catch (_) {} }
        }
        if (this.drum && typeof this.drum.stop === 'function') {
            try { this.drum.stop(); } catch (_) {}
        }
        this._disconnectChains();
    }

    _disconnectChains() {
        for (const chain of Object.values(this.voiceChains)) {
            try { chain.gain.disconnect(); } catch (_) {}
            if (chain.panner) try { chain.panner.disconnect(); } catch (_) {}
        }
        for (const chain of Object.values(this.branchChains)) {
            try { chain.gain.disconnect(); } catch (_) {}
            if (chain.panner) try { chain.panner.disconnect(); } catch (_) {}
        }
        if (this.drumChain) {
            try { this.drumChain.gain.disconnect(); } catch (_) {}
            if (this.drumChain.panner) try { this.drumChain.panner.disconnect(); } catch (_) {}
        }
    }

    _reconnectChains() {
        const reconn = (chain) => {
            if (!chain) return;
            try { chain.gain.disconnect(); } catch (_) {}
            if (chain.panner) {
                try { chain.panner.disconnect(); } catch (_) {}
                chain.gain.connect(chain.panner);
                chain.panner.connect(this.master);
            } else {
                chain.gain.connect(this.master);
            }
        };
        for (const chain of Object.values(this.voiceChains)) reconn(chain);
        for (const chain of Object.values(this.branchChains)) reconn(chain);
        if (this.drumChain) reconn(this.drumChain);
    }
}

export function branchInstrumentForLane(lane) {
    if (lane <= 0) return null;
    return BRANCH_POOL[(lane - 1) % BRANCH_POOL.length];
}

// Different DrumMachine kits name their samples differently:
//   TR-808:        "kick/bd5000", "snare/sd5050", "hihat-close/ch", …
//   LM-2:          "kick", "kick-alt", "snare-m", "snare-h", …
//   MFB-512 etc.:  "kick", "snare", "hihat-closed", "hihat-open"
// We try a prioritized list of regexes and take the first match in each category.
function resolveDrumSampleNames(sampleNames) {
    const names = sampleNames.map(String);
    const first = (regexes) => {
        for (const rx of regexes) {
            const hit = names.find(n => rx.test(n));
            if (hit) return hit;
        }
        return null;
    };
    return {
        kick: first([
            /^kick\/bd50\d{2}$/,     // TR-808 middle-velocity kick
            /^kick\/bd\d{4}$/,        // any TR-808 kick
            /^kick$/,                 // LM-2, MFB-512, Casio-RZ1, CR-8000
            /^kick-/                  // LM-2 variants (kick-alt)
        ]),
        snare: first([
            /^snare\/sd50\d{2}$/,
            /^snare\/sd\d{4}$/,
            /^snare$/,
            /^snare-m$/,
            /^snare-/
        ]),
        hat: first([
            /^hihat-close\/ch$/,
            /^hihat-close\/.+/,
            /^hihat-closed$/,
            /^hihat\//,
            /^hihat$/,
            /^hi-hat-closed$/
        ]),
        open: first([
            /^hihat-open\/oh50$/,
            /^hihat-open\/oh\d{2}$/,
            /^hihat-open$/,
            /^hi-hat-open$/
        ]),
        clap: first([
            /^clap\/cp$/,
            /^clap$/
        ]),
        ride: first([
            /^ride/,
            /^cymbal\//,
            /^cym/
        ])
    };
}
