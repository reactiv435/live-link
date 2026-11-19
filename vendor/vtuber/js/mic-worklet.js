// Runs on the audio thread: loudness (RMS) of the microphone about 60 times a second. The audio thread is never slowed
// down when the control panel is in the background, so the mouth keeps moving while OBS is in front.
// V5: when the page loaded js/voice.js into this audio thread first and asks for it (processorOptions.bands), each
// message is { rms, b: [4 band levels] } (the vowel shapes of the mouth); otherwise the plain number as before.
class VTLevelProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.sum = 0; this.count = 0;
    this.block = Math.max(128, Math.round(sampleRate / 60));
    const want = options && options.processorOptions && options.processorOptions.bands;
    this.bands = want && globalThis.VTVoice && globalThis.VTVoice.Bands ? new globalThis.VTVoice.Bands(sampleRate) : null;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      if (this.bands) {
        this.bands.push(channel);
        this.count += channel.length;
        if (this.count >= this.block) { this.port.postMessage(this.bands.read()); this.count = 0; }
        return true;
      }
      for (let i = 0; i < channel.length; i++) this.sum += channel[i] * channel[i];
      this.count += channel.length;
      if (this.count >= this.block) {
        this.port.postMessage(Math.sqrt(this.sum / this.count));
        this.sum = 0; this.count = 0;
      }
    }
    return true;
  }
}
registerProcessor('vt-level', VTLevelProcessor);
