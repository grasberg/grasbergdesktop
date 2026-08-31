// AudioWorklet processor for push-to-talk capture: forwards each render
// quantum's mono Float32 samples to the main thread. Shipped as a static
// same-origin asset so the packaged build's default-src 'self' CSP allows it.
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel && channel.length > 0) {
      this.port.postMessage(new Float32Array(channel))
    }
    return true
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor)
