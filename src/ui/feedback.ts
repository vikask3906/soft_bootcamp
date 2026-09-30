/**
 * Tiny synthesized audio + haptic cues. Generated with WebAudio (no audio
 * files) so they work offline and add zero bytes to the bundle.
 */
let audio: AudioContext | null = null;
export let soundEnabled = true;

export function setSoundEnabled(on: boolean) {
  soundEnabled = on;
}

function ctx() {
  if (!audio) audio = new AudioContext();
  if (audio.state === 'suspended') void audio.resume();
  return audio;
}

/** Soft two-note "pencil tick" for a new answer; a low blip for Undefined/errors. */
export function playAnswerCue(kind: 'ok' | 'undefined' | 'error') {
  if (soundEnabled) {
    try {
      const ac = ctx();
      const notes = kind === 'ok' ? [880, 1320] : [330, 262];
      notes.forEach((freq, i) => {
        const t = ac.currentTime + i * 0.07;
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.06, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
        osc.connect(gain).connect(ac.destination);
        osc.start(t);
        osc.stop(t + 0.13);
      });
    } catch {
      /* audio unavailable — silently ignore */
    }
  }
  navigator.vibrate?.(kind === 'ok' ? 8 : [6, 40, 6]);
}

export function playEraseCue() {
  navigator.vibrate?.(12);
}
