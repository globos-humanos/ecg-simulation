// 1. Data Structures

const NOTE_MAPPING = {
    // High Octave (Q Row)
    'q': 'C5', 'w': 'D5', 'e': 'E5', 'r': 'F5', 't': 'G5', 'y': 'A5', 'u': 'B5',
    // Middle Octave (A Row)
    'a': 'C4', 's': 'D4', 'd': 'E4', 'f': 'F4', 'g': 'G4', 'h': 'A4', 'j': 'B4',
    // Low Octave (Z Row)
    'z': 'C3', 'x': 'D3', 'c': 'E3', 'v': 'F3', 'b': 'G3', 'n': 'A3', 'm': 'B3'
};

const ROWS = {
    high: ['q', 'w', 'e', 'r', 't', 'y', 'u'],
    middle: ['a', 's', 'd', 'f', 'g', 'h', 'j'],
    low: ['z', 'x', 'c', 'v', 'b', 'n', 'm']
};

const SONGS = {
    "Twinkle Twinkle": ["C4","C4","G4","G4","A4","A4","G4"],
    "Happy Birthday": ["G4","G4","A4","G4","C5","B4"]
};

// Create reverse mapping for Song Mode (Note -> Key)
// Note: This assumes unique mapping for simplest case, or finds the first key for a note.
// Given strict requirements, we can just iterate to find.
function getKeyForNote(note) {
    return Object.keys(NOTE_MAPPING).find(key => NOTE_MAPPING[key] === note);
}

// 2. State Management

let isSongMode = false;
let currentSong = []; // Array of notes
let currentNoteIndex = 0;

// 3. Audio Logic

const audioCache = {};

function playNote(note) {
    if (!note) return;

    if (!audioCache[note]) {
        audioCache[note] = new Audio(`sounds/${note}.mp3`);
    }

    const audio = audioCache[note];
    audio.currentTime = 0;
    // Handle potential errors (missing files) silently as requested
    audio.play().catch(e => {
        console.warn(`Could not play sound for note: ${note}`, e);
    });
}

// 4. Initialization & Rendering

const songSelect = document.getElementById('song-select');
const songDisplay = document.getElementById('song-display');
const modeToggle = document.getElementById('mode-toggle');

function init() {
    renderKeyboard();
    populateSongDropdown();
    setupEventListeners();
}

function renderKeyboard() {
    const rowIds = ['row-high', 'row-middle', 'row-low'];
    const rowKeys = [ROWS.high, ROWS.middle, ROWS.low];

    rowIds.forEach((id, index) => {
        const rowEl = document.getElementById(id);
        const keys = rowKeys[index];

        keys.forEach(keyChar => {
            const note = NOTE_MAPPING[keyChar];
            const keyEl = document.createElement('div');
            keyEl.className = 'key';
            keyEl.dataset.key = keyChar;
            keyEl.innerHTML = `
                <div class="letter">${keyChar.toUpperCase()}</div>
                <div class="note">${note}</div>
            `;
            rowEl.appendChild(keyEl);
        });
    });
}

function populateSongDropdown() {
    for (const songName in SONGS) {
        const option = document.createElement('option');
        option.value = songName;
        option.textContent = songName;
        songSelect.appendChild(option);
    }
}

// 5. Game Loop / Logic

function startSong(songName) {
    currentSong = SONGS[songName];
    currentNoteIndex = 0;
    renderSongDisplay();
    songDisplay.classList.remove('hidden');

    // Highlight first note
    updateSongDisplayHighlight();
}

function renderSongDisplay() {
    songDisplay.innerHTML = '';
    currentSong.forEach((note, index) => {
        const keyChar = getKeyForNote(note);
        const span = document.createElement('span');
        span.className = 'song-note';
        span.textContent = keyChar ? keyChar.toUpperCase() : '?';
        span.dataset.index = index;
        songDisplay.appendChild(span);
    });
}

function updateSongDisplayHighlight() {
    const notes = songDisplay.querySelectorAll('.song-note');
    notes.forEach((noteEl, index) => {
        noteEl.classList.remove('current', 'completed');
        if (index < currentNoteIndex) {
            noteEl.classList.add('completed');
        } else if (index === currentNoteIndex) {
            noteEl.classList.add('current');
        }
    });
}

function handleInput(keyChar) {
    const keyEl = document.querySelector(`.key[data-key="${keyChar}"]`);
    if (!keyEl) return;

    const note = NOTE_MAPPING[keyChar];

    if (isSongMode) {
        if (!currentSong.length) return; // No song selected

        const expectedNote = currentSong[currentNoteIndex];
        const expectedKey = getKeyForNote(expectedNote);

        if (keyChar === expectedKey) {
            // Correct
            playNote(note);

            // Visual feedback: Green on key
            keyEl.classList.add('correct');

            // Advance song
            currentNoteIndex++;
            updateSongDisplayHighlight();

            // Check completion
            if (currentNoteIndex >= currentSong.length) {
                setTimeout(() => {
                    alert('Song completed 🎉');
                    resetToFreePlay();
                }, 100);
            }
        } else {
            // Wrong
            // Visual feedback: Red on key
            keyEl.classList.add('wrong');
        }
    } else {
        // Free Play
        playNote(note);
        keyEl.classList.add('active');
    }
}

function resetToFreePlay() {
    isSongMode = false;
    modeToggle.checked = false;
    songSelect.disabled = true;
    songSelect.value = "";
    songDisplay.classList.add('hidden');
    currentSong = [];
    currentNoteIndex = 0;

    // Clear any persistent styles
    document.querySelectorAll('.key').forEach(k => {
        k.classList.remove('active', 'correct', 'wrong');
    });
}

// 6. Event Listeners

function setupEventListeners() {
    // Keyboard Input
    document.addEventListener('keydown', (e) => {
        if (e.repeat) return; // Prevent hold-down spam if desired, though requirements say "reset audio currentTime"
        const keyChar = e.key.toLowerCase();
        if (NOTE_MAPPING[keyChar]) {
            handleInput(keyChar);
        }
    });

    document.addEventListener('keyup', (e) => {
        const keyChar = e.key.toLowerCase();
        const keyEl = document.querySelector(`.key[data-key="${keyChar}"]`);
        if (keyEl) {
            keyEl.classList.remove('active', 'correct', 'wrong');
        }
    });

    // Toggle Mode
    modeToggle.addEventListener('change', (e) => {
        isSongMode = e.target.checked;
        songSelect.disabled = !isSongMode;

        if (isSongMode) {
            // Wait for selection
            songDisplay.classList.remove('hidden');
            songDisplay.innerHTML = 'Select a song...';
        } else {
            resetToFreePlay();
        }
    });

    // Select Song
    songSelect.addEventListener('change', (e) => {
        if (isSongMode && e.target.value) {
            startSong(e.target.value);
        }
    });
}

// Start
init();