// Musical style presets. Picking one sets tempo, commits-per-bar, acceleration, drum kit,
// drum pattern, and the four melodic voices in one click. After applying, any control can
// be tweaked individually — the dropdown just records what you last selected.
//
// Drum patterns are 16 steps per bar (sixteenth-note resolution), with velocity values
// 0..127 per role (0 = silent). Roles map to whatever the DrumMachine kit exposes —
// kick/snare/hat/open/clap/ride. Missing role names fall back silently.
//
// Each style has multiple variants; we pick one per repo from a SHA-derived hash so the
// same repo always sounds like itself, but different repos get flavor variation.

// Patterns: 16-step arrays of velocities (0–127). 0 = no hit.
// Steps 0/4/8/12 are downbeats 1/2/3/4. Steps 2/6/10/14 are the "&" eighth-note.
const PATTERNS = {
    // Four-on-the-floor, offbeat hats, open hat on the last "&" — classic techno.
    hardTechno: [
        {
            kick:  [110,0,0,0, 110,0,0,0, 110,0,0,0, 110,0,0,0],
            snare: [0,0,0,0,   0,0,0,0,   0,0,0,0,   0,0,0,0  ],
            hat:   [0,0,60,0,  0,0,60,0,  0,0,60,0,  0,0,60,0 ],
            open:  [0,0,0,0,   0,0,0,0,   0,0,0,0,   0,0,80,0 ]
        },
        { // With 2-and-4 clap accents and an extra kick on the "&" of 3.
            kick:  [110,0,0,0, 110,0,0,0, 110,0,90,0, 110,0,0,0],
            snare: [0,0,0,0,   0,0,0,0,   0,0,0,0,   0,0,0,0  ],
            clap:  [0,0,0,0,   85,0,0,0,  0,0,0,0,   85,0,0,0 ],
            hat:   [0,0,65,0,  0,0,65,0,  0,0,65,0,  0,0,65,0 ],
            open:  [0,0,0,0,   0,0,0,0,   0,0,0,0,   0,0,85,0 ]
        }
    ],

    // EDM: four-on-floor + snare/clap on 2&4 + consistent 8th-note hats.
    edm: [
        {
            kick:  [115,0,0,0, 115,0,0,0, 115,0,0,0, 115,0,0,0],
            snare: [0,0,0,0,   95,0,0,0,  0,0,0,0,   95,0,0,0 ],
            clap:  [0,0,0,0,   85,0,0,0,  0,0,0,0,   85,0,0,0 ],
            hat:   [0,60,0,60, 0,60,0,60, 0,60,0,60, 0,60,0,60]
        },
        { // With a "tail kick" before beat-1 fills and an open-hat lift.
            kick:  [115,0,0,0, 115,0,0,0, 115,0,0,0, 115,0,0,90],
            snare: [0,0,0,0,   95,0,0,0,  0,0,0,0,   95,0,0,0 ],
            clap:  [0,0,0,0,   90,0,0,0,  0,0,0,0,   90,0,0,0 ],
            hat:   [0,60,0,60, 0,60,0,60, 0,60,0,60, 0,60,0,0 ],
            open:  [0,0,0,0,   0,0,0,0,   0,0,0,0,   0,0,0,85 ]
        }
    ],

    // Jungle / DnB — amen-break-inspired syncopation. No four-on-floor; kick scattered, snare
    // on 2 and 4 plus breakbeat ghost on the "&" before 4. Fast 16th-note hats.
    jungle: [
        {
            kick:  [105,0,0,0, 0,0,95,0,  0,0,0,0,   0,0,90,0 ],
            snare: [0,0,0,0,   100,0,0,0, 0,0,0,80,  100,0,0,0],
            hat:   [55,55,55,55, 55,55,55,55, 55,55,55,55, 55,55,55,55]
        },
        { // Busier kick + snare rolls.
            kick:  [105,0,0,0, 0,0,90,0,  0,0,85,0,  0,0,90,0 ],
            snare: [0,0,0,0,   100,0,0,0, 0,0,75,70, 95,0,0,60],
            hat:   [55,55,55,55, 55,55,55,55, 55,55,55,55, 55,55,55,55]
        }
    ],

    // Jazz — light kick on 1 and 3 (in feathery dynamics), snare on 2 and 4, ride pattern.
    // We approximate "swung 8ths" by shifting the offbeat hats slightly stronger on the &.
    jazz: [
        {
            kick:  [70,0,0,0,  0,0,0,0,   65,0,0,0,  0,0,0,0  ],
            snare: [0,0,0,0,   50,0,0,0,  0,0,0,0,   55,0,0,0 ],
            ride:  [70,0,55,0, 65,0,55,0, 70,0,55,0, 65,0,55,0],
            hat:   [70,0,55,0, 65,0,55,0, 70,0,55,0, 65,0,55,0]
        }
    ],

    // Rock — kick 1&3, snare 2&4, straight 8th-note hats.
    rock: [
        {
            kick:  [105,0,0,0, 0,0,0,0,   105,0,0,0, 0,0,0,0  ],
            snare: [0,0,0,0,   100,0,0,0, 0,0,0,0,   100,0,0,0],
            hat:   [70,0,70,0, 70,0,70,0, 70,0,70,0, 70,0,70,0]
        },
        { // With an 8th-note ghost kick before the snare on beat 4 (rock "gallop").
            kick:  [105,0,0,0, 0,0,0,0,   105,0,0,0, 0,0,80,0 ],
            snare: [0,0,0,0,   100,0,0,0, 0,0,0,0,   100,0,0,0],
            hat:   [70,0,70,0, 70,0,70,0, 70,0,70,0, 70,0,70,0]
        }
    ],

    // Ambient — no drums.
    ambient: [ {} ]
};

// Bass patterns — arrays of { step, degree, velocity, durBeats } events. step = 0..15
// (sixteenth-note resolution), degree is a scale-degree (0=root, 2=third, 4=fifth, 7=octave,
// −3=minor seventh below), durBeats is duration in quarter-notes. Each style has multiple
// variants, picked stably by repo hash.
const BASS = {
    hardTechno: [
        [
            {step:0,degree:0,vel:95,dur:0.6}, {step:2,degree:0,vel:80,dur:0.5},
            {step:4,degree:0,vel:95,dur:0.6}, {step:6,degree:0,vel:80,dur:0.5},
            {step:8,degree:0,vel:95,dur:0.6}, {step:10,degree:0,vel:80,dur:0.5},
            {step:12,degree:0,vel:95,dur:0.6}, {step:14,degree:0,vel:80,dur:0.5}
        ],
        [
            {step:0,degree:0,vel:95,dur:0.5}, {step:2,degree:4,vel:80,dur:0.5},
            {step:4,degree:7,vel:85,dur:0.5}, {step:6,degree:4,vel:80,dur:0.5},
            {step:8,degree:0,vel:95,dur:0.5}, {step:10,degree:4,vel:80,dur:0.5},
            {step:12,degree:7,vel:85,dur:0.5}, {step:14,degree:4,vel:80,dur:0.5}
        ]
    ],
    edm: [
        [
            {step:0,degree:0,vel:92,dur:1}, {step:4,degree:2,vel:82,dur:1},
            {step:8,degree:4,vel:85,dur:1}, {step:12,degree:2,vel:80,dur:1}
        ],
        [
            {step:0,degree:0,vel:95,dur:1.5}, {step:6,degree:0,vel:90,dur:0.5},
            {step:8,degree:4,vel:85,dur:1}, {step:14,degree:0,vel:75,dur:0.4}
        ]
    ],
    jungle: [
        [
            {step:0,degree:0,vel:105,dur:1.8}, {step:10,degree:0,vel:85,dur:0.6}
        ],
        [
            {step:0,degree:0,vel:105,dur:1}, {step:6,degree:4,vel:75,dur:0.4},
            {step:8,degree:0,vel:95,dur:1.5}
        ]
    ],
    jazz: [
        [
            {step:0,degree:0,vel:85,dur:0.95}, {step:4,degree:2,vel:78,dur:0.95},
            {step:8,degree:4,vel:80,dur:0.95}, {step:12,degree:2,vel:78,dur:0.95}
        ],
        [
            {step:0,degree:0,vel:85,dur:0.95}, {step:4,degree:2,vel:78,dur:0.95},
            {step:8,degree:4,vel:80,dur:0.95}, {step:12,degree:5,vel:82,dur:0.95}
        ],
        [
            {step:0,degree:4,vel:85,dur:0.95}, {step:4,degree:2,vel:78,dur:0.95},
            {step:8,degree:0,vel:82,dur:0.95}, {step:12,degree:-3,vel:78,dur:0.95}
        ]
    ],
    rock: [
        [
            {step:0,degree:0,vel:100,dur:0.5}, {step:2,degree:0,vel:85,dur:0.5},
            {step:4,degree:0,vel:95,dur:0.5}, {step:6,degree:0,vel:85,dur:0.5},
            {step:8,degree:0,vel:100,dur:0.5}, {step:10,degree:4,vel:90,dur:0.5},
            {step:12,degree:0,vel:95,dur:0.5}, {step:14,degree:0,vel:85,dur:0.5}
        ],
        [
            {step:0,degree:0,vel:100,dur:1}, {step:4,degree:0,vel:90,dur:1},
            {step:8,degree:4,vel:95,dur:1}, {step:12,degree:0,vel:90,dur:1}
        ]
    ],
    ambient: [
        [{step:0,degree:0,vel:70,dur:4}]
    ]
};

export const STYLES = [
    {
        id: 'hard-techno',
        label: 'Hard Techno',
        tempo: 140,
        commitsPerBar: 4,
        accelerate: 0.3,
        drumKit: 'TR-808',
        drumPatterns: PATTERNS.hardTechno,
        bassPatterns: BASS.hardTechno,
        voiceInst: {
            bass: 'synth_bass_1',
            lead: 'lead_2_sawtooth',
            pad:  'pad_6_metallic',
            bell: 'fx_3_crystal'
        },
        voiceOctave: { bass: 2, lead: 4, pad: 3, bell: 5 },
        branchPool: [
            'lead_1_square', 'lead_3_calliope', 'lead_7_fifths', 'lead_8_bass__lead',
            'fx_5_brightness', 'pad_3_polysynth', 'fx_7_echoes'
        ]
    },
    {
        id: 'edm',
        label: 'EDM',
        tempo: 128,
        commitsPerBar: 2,
        accelerate: 0.5,
        drumKit: 'TR-808',
        drumPatterns: PATTERNS.edm,
        bassPatterns: BASS.edm,
        voiceInst: {
            bass: 'synth_bass_2',
            lead: 'lead_5_charang',
            pad:  'pad_1_new_age',
            bell: 'celesta'
        },
        voiceOctave: { bass: 2, lead: 4, pad: 3, bell: 5 },
        branchPool: [
            'celesta', 'music_box', 'lead_3_calliope', 'fx_3_crystal',
            'lead_5_charang', 'vibraphone', 'pad_2_warm'
        ]
    },
    {
        id: 'jungle',
        label: 'Jungle',
        tempo: 168,
        commitsPerBar: 4,
        accelerate: 0.2,
        drumKit: 'LM-2',   // LM-2 has punchier breakbeat samples than TR-808
        drumPatterns: PATTERNS.jungle,
        bassPatterns: BASS.jungle,
        voiceInst: {
            bass: 'synth_bass_2',
            lead: 'lead_1_square',
            pad:  'pad_4_choir',
            bell: 'steel_drums'
        },
        voiceOctave: { bass: 2, lead: 4, pad: 3, bell: 5 },
        branchPool: [
            // Dub/DnB flavors — steel drums stabs, synth pads, dubby lead stabs
            'steel_drums', 'pad_4_choir', 'pad_2_warm', 'lead_8_bass__lead',
            'fx_2_soundtrack', 'lead_1_square', 'sitar'
        ]
    },
    {
        id: 'jazz',
        label: 'Jazz',
        tempo: 112,
        commitsPerBar: 1,
        accelerate: 0.1,
        drumKit: 'MFB-512',
        drumPatterns: PATTERNS.jazz,
        bassPatterns: BASS.jazz,
        voiceInst: {
            bass: 'acoustic_bass',
            lead: 'electric_piano_1',
            pad:  'vibraphone',
            bell: 'orchestral_harp'
        },
        voiceOctave: { bass: 2, lead: 4, pad: 4, bell: 5 },
        branchPool: [
            'trumpet', 'alto_sax', 'flute', 'pizzicato_strings',
            'orchestral_harp', 'vibraphone', 'electric_piano_1'
        ]
    },
    {
        id: 'rock',
        label: 'Rock',
        tempo: 116,
        commitsPerBar: 1,
        accelerate: 0.2,
        drumKit: 'Casio-RZ1',
        drumPatterns: PATTERNS.rock,
        bassPatterns: BASS.rock,
        voiceInst: {
            bass: 'electric_bass_finger',
            lead: 'distortion_guitar',
            pad:  'string_ensemble_1',
            bell: 'tubular_bells'
        },
        voiceOctave: { bass: 2, lead: 4, pad: 3, bell: 5 },
        branchPool: [
            'electric_guitar_clean', 'distortion_guitar', 'drawbar_organ',
            'electric_piano_1', 'tubular_bells', 'string_ensemble_1'
        ]
    },
    {
        id: 'ambient',
        label: 'Ambient',
        tempo: 72,
        commitsPerBar: 1,
        accelerate: 0.0,
        drumKit: '', // silence
        drumPatterns: PATTERNS.ambient,
        bassPatterns: BASS.ambient,
        voiceInst: {
            bass: 'fretless_bass',
            lead: 'kalimba',
            pad:  'pad_8_sweep',
            bell: 'music_box'
        },
        voiceOctave: { bass: 3, lead: 4, pad: 4, bell: 5 },
        branchPool: [
            'pad_1_new_age', 'pad_5_bowed', 'pad_7_halo', 'fx_1_rain',
            'fx_2_soundtrack', 'fx_7_echoes', 'kalimba', 'music_box'
        ]
    }
];

// Branch instrument for a given lane (>=1) within the current style. Rotates through
// the style's pool so consecutive branches are sonically distinct.
export function branchInstrumentForLaneInStyle(styleId, lane) {
    if (lane <= 0) return null;
    const style = findStyle(styleId);
    const pool = (style && style.branchPool) || null;
    if (!pool || !pool.length) return null;
    return pool[(lane - 1) % pool.length];
}

// Pick which drum variant to use for a given repo. Stable per repo (same repo → same variant).
export function pickDrumVariant(style, repoHashInt) {
    const list = (style && style.drumPatterns) || [{}];
    if (!list.length) return {};
    return list[repoHashInt % list.length] || list[0];
}

export function pickBassVariant(style, repoHashInt) {
    const list = (style && style.bassPatterns) || [[]];
    if (!list.length) return [];
    return list[repoHashInt % list.length] || list[0];
}

export const DEFAULT_STYLE = 'edm';

export function findStyle(id) {
    return STYLES.find(s => s.id === id);
}
