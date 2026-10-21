// AudioWorklet: hands mic samples to the page while recording. The page
// downsamples and encodes them when the button is released.
class WalkiRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.buf = new Float32Array(4096);
    this.n = 0;
    this.port.onmessage = (e) => {
      this.on = e.data;
      if (this.on) return;
      this.flush();
      this.port.postMessage(null); // end of recording
    };
  }

  flush() {
    if (this.n) this.port.postMessage(this.buf.slice(0, this.n));
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!this.on || !ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) this.flush();
    }
    return true;
  }
}

registerProcessor('walki-rec', WalkiRecorder);
