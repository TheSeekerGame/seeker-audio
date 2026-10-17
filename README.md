# SEEKER — harmonic music studio

A music studio that runs entirely in the browser, where every note is a harmonic of 48 Hz. Press **✦ surprise** for a new song, touch the spiral to play, and share the link: the link carries the whole song, so nothing needs a server.

**Play it at <https://theseekergame.github.io/SeekerAudio/>.**

SEEKER is part of [The Seeker](https://github.com/TheSeekerGame/TheSeeker) and uses the same 48 Hz tuning as the game's music. It has ten synthesized instruments (modal bells, plucked strings, electric piano, additive organ, choir, pads, fourteen kinds of bass, wind, nine drum kits, and grain clouds), tuned resonators and a rhythmic harmonic pitch shifter among its effects, a song generator with eleven styles, and stem export.

## The tuning

Every pitch is `48 Hz × X / 2^N` for whole numbers X and N: a harmonic of 48 Hz or of one of its lower octaves. 9/8, 19/16, 5/4, and 7/4 belong; 4/3 and 6/5 do not.

- **Moods** are palettes of odd harmonics folded into one octave. *Seeker* (1, 9/8, 19/16, 21/16, 3/2, 7/4) is the default; others draw on primes, powers of three, the overtone scale, and more. The palette editor offers every odd harmonic up to 63.
- **The root** moves only by octaves: 48, 96, 192, or 384 Hz.
- **Time follows the same rule.** Tempos are `2880 × X / 2^N` BPM (90 BPM is a beat of 48/32 Hz). Step rates multiply the beat by whole numbers, so triplets belong and dotted values do not. Echo times, LFOs, and the shifter's slice lengths are all harmonic rates.
- **Enforcement.** Pitches are produced only by `js/tuning.js` from palette indices. `cleanComposition` (`js/state.js`) validates anything loaded from a link or storage, and the sequencer folds out-of-range notes by octaves, which keeps them valid. Noise-based sounds (hats, breath, air) are unpitched and therefore free.

## Using it

- **✦ surprise** writes a complete song. The style menu next to it chooses ambient, lo-fi, pulse, cinematic, minimal, chime, techno, house, drum & bass, breakbeat, or breakcore. The club styles sit on harmonic tempos that suit them (house at 118.13 or 123.75 BPM, techno at 129.38 or 135, breakbeat from 129.38 to 140.63, drum & bass at 168.75 or 174.38, breakcore from 180 to 202.5), with matching kits, bass lines, and chords. Breakbeat swings classic two-bar breaks; breakcore chops an amen-like break on a 32nd-note grid with rolls, stutters, and shifter glitches, under slow, wide chords.
- **The spiral** shows every pitch of the palette across six octaves (angle = place in the octave, distance = height). Notes glow as they sound. Press, hold, and slide across the dots to play the selected layer. The computer keyboard plays too: `z`–`/`, `a`–`;`, and `q`–`p` are three octaves.
- **Layers** hold an instrument and a looping pattern. Each has mute, solo, and ✦ (new pattern and sound).
- **Pattern** is a step grid labeled with each row's ratio. Click to add, drag to lengthen, click to remove; Shift-click changes loudness, Alt-click makes a note play only sometimes. *Follow harmony* moves the layer with the harmony strip.
- **Harmony** (top bar) shifts following layers along the palette, bar by bar. Its ✦ chooses a new progression from the most consonant shifts.
- **Sound** picks one of ten instruments: bells, strings, keys, organ, choir, pad, bass, wind, drums, cloud. Knob labels follow the chosen model or kit.
  - **Bass** has fourteen models: analog (resonant ladder filter), sub (an 808 with pitch drop and saturation), acid (a 303 with accents, and slides between tied notes when glide is on), reese, fm, wobble (a filter swept in time with the beat), finger (a plucked string), square (a pulse with slowly moving width), liquid (a soft reese of triangles), scream (a reese driven into a resonant band), grit (noise running into the reese's distortion), hoover (octave-stacked pulses with fast width modulation and a scoop into each note), neuro (FM from a tone on one of the note's harmonics, sine folding, and a comb tuned to the note), and talk (vowel formants that glide on every note). Every model keeps a clean sine sub under its distortion and filters, and keeps the low end mono.
  - **Drums** have nine kits, each voicing the eight rows its own way: soft, tight, lo-fi, metal, club (909-style house), break (an acoustic jungle kit with ride and crash), 808, dnb (a short kick and a cracking snare with a clap on top), and techno (a 909 kick with a distorted rumble tail). The grid's row names follow the kit.
- **Effects** adds up to four inserts per layer: resonator, shifter, filter, drive, chorus, lo-fi, tremolo, pump (ducking locked to the beat), and squash (three-band upward and downward compression that brings grit and fizz forward).
- **Level and sends** holds each layer's volume, pan, space, echo, and **sidechain**: how deeply the drums' kick carves the layer (see below). **Space & mix** sets the shared reverb, echo, swing, and the song's loudness.
- **Evolve** changes one layer slightly every four bars.
- **Undo/redo**, **rec** (records what you hear to a 48 kHz WAV), **share** (copy link, post on X, or the system share sheet), and the menu (save to this browser, new song, export stems, about, keyboard).

### Mix and loudness

The mix balances itself, so drums and bass never end up buried:

- **Automatic balance.** Each layer's own perceived loudness (K-weighted and gated, after ITU BS.1770, so rests do not count) is measured offline in a background worker, and the layer gets the gain that brings it to its role's level: drums and bass up front, melody, arpeggio, and chords behind, drones and textures further back. Club styles push the groove a little further; ambient and cinematic bring their beds forward. The volume knob works from there. The gains depend only on the song, so a shared link and its stems sound the same everywhere, and they are not stored.
- **Drum bus.** A fast compressor lifts each kit's body, a shelf adds a little air, and a soft clipper rounds off the sharpest transients. Punch sets how hard it works; at the default it takes 2–3 dB off the kit's peak-to-loudness ratio, so the drums sound full and loud rather than thin and spiky, and the kick's harmonics reach small speakers. Every row of every kit is calibrated to a loudness relative to its kick.
- **Sidechain.** Ring-mod sidechaining: a layer is multiplied by one minus the kick's own instantaneous level, sample by sample. It is cut exactly where the kick has level and passes where the kick's wave crosses zero, so the two never pile up and nothing pumps. Because the kick is tuned to the palette, the cut's sidebands land on harmonics of 48 Hz too. Drum layers render ten milliseconds ahead of the song and are delayed back into place, so the sidechain also knows every hit before it sounds. A kit's *sidechain gap* opens a short silence just before each kick and snare, the look-ahead ducking of neuro drum & bass. Generated songs carve the bass whenever a kit plays, and in club styles also the chords, drones, and textures.
- **Master.** The output always peaks at -0.3 dBFS. A leveler brings the highest peaks of the last few seconds to that ceiling, and the song's *loudness* pushes them up to 3 dB further, into a gentle soft clipper and a look-ahead limiter. Quiet passages rise slowly; sudden loud ones are pulled down within ten milliseconds. Recordings are normalized so their highest peak sits at -0.3 dBFS, and a stem set is scaled together so its sum peaks there.

### Stems

*Menu → export stems…* renders the song offline, silently and faster than real time, through the same engine as playback. Each layer becomes a 24-bit WAV with its own effects. Every file starts on bar 1 and has the same length, plus four seconds for tails. Space and echo come as two return stems by default, so the stems add up to the song; choose *leave out (dry)* to add your own. The download is one ZIP with a text file giving the exact tempo, length, and tuning. Length defaults to one full cycle (where the harmony and every pattern line up again), or 8, 16, or 32 bars.

## Running and deploying

The app is static files with no build step. Audio worklets need `http://localhost` or HTTPS, not `file://`:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

The live site is served by GitHub Pages from the `main` branch of this repository, so pushing to `main` publishes it. To host it elsewhere, serve the repository root from any static host and change the `og:url`, `og:image`, and `twitter:image` tags in `index.html` to the new address; link previews need absolute image URLs.

Share links put the song in the URL fragment (`#s=…`), which never reaches the server, and use the shorter of two forms:

- **Seed links** (`g2.7.13oy3v8.tfc6`, about 15 characters). A song made by ✦ is rebuilt from the generator version, the style, and the seed. Four more characters fingerprint the generated song. Changes made since then travel as a patch that records only the positions that differ; a handful of edits adds about 60 characters. If the generator has changed since a link was made, it still opens as the closest song this version makes, with a note saying so.
- **Full links** (about 400 characters). The whole song is packed into positional arrays: knob settings as integers on a grid of 200 positions, note loudness and chance in steps of 5%, and note steps as distances from the previous note. The result is compressed with `deflate-raw` and written as base64url.

Any change to what `generateComposition` returns for a seed must increment `GENERATOR_VERSION` in `js/generate.js`. Once a link has loaded, the address bar is cleared so later edits survive a reload. The song in progress autosaves to `localStorage` in the full form, together with its seed, so it survives generator changes and can still be shared short.

## How it works

```text
index.html, css/app.css     page and styles; favicon.png is the tab and home-screen icon
js/tuning.js                the tuning: ratios, palettes, tempos, octave folding (shared with the worklet)
js/moods.js                 palettes and number families
js/instruments.js           instrument and effect parameters, ranges, and randomization ranges (shared)
js/state.js                 the composition model, validation, palette remapping
js/generate.js              styles, harmony scoring, chord, melody, bass, arp, drum, and texture generators
js/share.js, js/storage.js  link encoding, local library
js/app.js                   state, undo history, audio bridge
js/audio/engine.js          browser audio graph: worklet node, layer strips with sidechain duck, master bus
js/audio/balance.js         automatic balance: per-layer loudness measured in balance-worker.js
js/audio/loudness.js        K-weighted and gated loudness meters (shared with the tests)
js/audio/fx.js, space.js    native effects, reverb with synthesized impulse responses, echo
js/audio/sources.js         grain sources synthesized from the app's own instruments
js/audio/stems.js, zip.js   offline stem rendering and the ZIP writer
js/audio/recorder.js        WAV recording of the master output
js/ui/                      top bar, spiral, layers, editor, pattern grid, knobs, dialogs
worklet/processor.js        audio worklet entry: song, insert effects, master leveler, clipper, and limiter
worklet/dsp/                DSP core, voice management, sequencer and sidechain (song.js), effects, instruments
tests/                      headless checks for DSP, generation, links, and stems
tools/og-image.mjs          draws the link-preview card (og.png)
```

One `AudioWorkletNode` runs the sequencer and every instrument and gives each layer its own stereo output, so notes start on exact samples; a ninth, mono output carries the sidechain. Each layer then passes through native Web Audio insert effects (worklet ones for the resonator, shifter, lo-fi, pump, and squash, which read the song's beat directly), the sidechain duck (a gain node whose gain the sidechain output drives directly), a fader carrying the automatic balance, and a panner, and sends to the shared convolution reverb and ping-pong echo. The master bus goes through a glue compressor and then a worklet stage with the peak leveler, soft clipper, and look-ahead limiter at -0.3 dBFS.

Performance: a typical song costs a few percent of one CPU core. The DSP is plain JavaScript with no allocation in the audio callback. Silent voices and effect tails switch themselves off, only one reverb convolver runs at a time, and the visuals animate only while something moves. The browser renders a full stem set at about 28× real time.

## Tests

```bash
npm test
```

The suites run in Node 18 or later:

- `tests/dsp.test.mjs` renders every instrument and effect. It checks tuning accuracy (within 0.35 Hz at 192 Hz), levels, release, the extremes of every parameter, limiter ceilings, and CPU cost. It also runs every bass model under random settings, checks that glide lands on the next note, checks that every drum row of every kit sits within 2 dB of its loudness target through the drum bus, checks that the pump ducks on the beat, and checks that the master chain normalizes both far too hot and far too quiet input to -0.3 dBFS without ever passing it. Set `WAV_DIR=<dir>` to write each instrument's demo as a WAV.
- `tests/gen.test.mjs` generates 400 songs. It checks that every pitch, tempo, and echo time is `48 × X / 2^N`, that registers stay within 40 Hz–4.2 kHz, and that whole songs play through the sequencer at sensible levels. It also checks that drums still land on the downbeat although they render ahead, that the ring-mod sidechain follows the kick's waveform in phase, that a sidechain gap opens before the snare, and that the automatic balance judges a sparse phrase by its notes rather than its rests.
- `tests/share.test.mjs` checks that seed, patched, and full links reproduce songs exactly and stay short, that stale seed links are flagged, and that links in the first format still open.
- `tests/stems.test.mjs` checks the ZIP writer with the system `unzip` and the cycle-length arithmetic.

These do not cover the browser graph or how things sound. Listen in a browser to judge the music.

## Contributing

Issues and pull requests are welcome. Run `npm test` before sending a change, and listen to anything that affects the sound. Keep every pitch and rate inside the tuning: produce pitches through `js/tuning.js`, never from raw frequencies.

## License

Code is licensed under MIT OR Apache-2.0, as is The Seeker game. Project artwork (`favicon.png`, `og.png`) is licensed under Creative Commons Attribution 4.0 (CC BY 4.0) unless noted otherwise. See [LICENSE.md](LICENSE.md) for details and attribution guidance.
