export const CAPTURE_FLUSH_SAMPLES = 4096

export const CAPTURE_PROCESSOR = 'vo-capture'

export const CAPTURE_WORKLET_SOURCE = `
const FLUSH = ${CAPTURE_FLUSH_SAMPLES}
const METER_SAMPLES = 1024

class VoCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(FLUSH)
    this.n = 0
    this.at = -1
    this.acc = 0
    this.accN = 0
    this.port.onmessage = (e) => {
      const m = e.data
      if (m && m.cmd === 'flush') {
        this.flush()
        this.port.postMessage({ flushed: true, token: m.token, frame: currentFrame })
      }
    }
  }

  flush() {
    if (this.n === 0) return
    const out = this.buf.slice(0, this.n)
    const at = this.at
    this.n = 0
    this.at = -1
    this.port.postMessage({ samples: out, at: at }, [out.buffer])
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true

    let sum = 0
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i]
      sum += v * v
    }
    this.acc += sum
    this.accN += ch.length
    if (this.accN >= METER_SAMPLES) {
      this.port.postMessage({ rms: Math.sqrt(this.acc / this.accN) })
      this.acc = 0
      this.accN = 0
    }

    for (let i = 0; i < ch.length; i++) {
      if (this.n === 0) this.at = currentFrame + i
      this.buf[this.n++] = ch[i]
      if (this.n === FLUSH) this.flush()
    }
    return true
  }
}

registerProcessor('${CAPTURE_PROCESSOR}', VoCaptureProcessor)
`
