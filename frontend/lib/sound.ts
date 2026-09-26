/* Browsers block audio until the page has been tapped, so the kitchen board
   arms this context once from the "Start shift" gesture (the documented
   workaround in docs/2-mvp-ideation.md → Screen Flash & Sounds). */

let context: AudioContext | null = null;

export function armAudio() {
  if (typeof window === "undefined" || !window.AudioContext) return false;

  context ??= new window.AudioContext();
  void context.resume();

  return true;
}

export function isAudioArmed() {
  return Boolean(context && context.state === "running");
}

export function playChime() {
  const audio = context;
  if (!audio || audio.state !== "running") return;

  const start = audio.currentTime;

  [880, 1320].forEach((frequency, index) => {
    const at = start + index * 0.14;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();

    oscillator.type = "sine";
    oscillator.frequency.value = frequency;

    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.2, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.36);

    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.4);
  });
}
