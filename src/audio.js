// All sound is synthesised with Web Audio: no files. Continuous layers (engine roar, hull rumble,
// rushing air) follow the flight; short one-shots mark what the player does.
class Sfx {
  constructor() {
    this.ctx = null;
    try { this.muted = localStorage.getItem('apogee.mute') === '1'; } catch { this.muted = false; }
  }
  // Browsers only allow audio after a click or key press, so this is called from those.
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : 0.8;
    const comp = ctx.createDynamicsCompressor(); this.master.connect(comp); comp.connect(ctx.destination);
    const len = ctx.sampleRate * 2, buf = (this.noise = ctx.createBuffer(1, len, ctx.sampleRate)), d = buf.getChannelData(0);
    let b = 0; for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; b = 0.985 * b + 0.15 * w; d[i] = w * 0.45 + b * 1.6; } // white + a brown tail
    const layer = (type, freq, q) => {
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(f); f.connect(g); g.connect(this.master); src.start();
      return { f, g };
    };
    this.eng = layer('lowpass', 300, 0.7);
    this.wind = layer('bandpass', 600, 0.6);
    const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 41;
    const of = ctx.createBiquadFilter(); of.type = 'lowpass'; of.frequency.value = 110;
    const og = ctx.createGain(); og.gain.value = 0;
    osc.connect(of); of.connect(og); og.connect(this.master); osc.start();
    this.rumble = { g: og, osc };
  }
  setMuted(m) {
    this.muted = m; try { localStorage.setItem('apogee.mute', m ? '1' : '0'); } catch { /* ignore */ }
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.03);
  }
  // thrust, air, wind, heat: all 0..1
  flight(thrust, air, wind, heat) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, set = (p, v, tc = 0.08) => p.setTargetAtTime(v, t, tc);
    set(this.eng.g.gain, thrust > 0.001 ? Math.pow(thrust, 0.6) * (0.1 + 0.55 * air) : 0);
    set(this.eng.f.frequency, 160 + 1300 * thrust * (0.15 + 0.85 * air));
    set(this.rumble.g.gain, thrust > 0.001 ? 0.1 + 0.22 * thrust : 0);
    set(this.rumble.osc.frequency, 34 + 14 * thrust);
    set(this.wind.g.gain, Math.min(0.5, wind * 0.4 + heat * 0.45), 0.2);
    set(this.wind.f.frequency, 350 + 1100 * wind + 500 * heat, 0.2);
  }
  quiet() { this.flight(0, 0, 0, 0); }

  tone(freq, to, dur, vol = 0.15, type = 'sine', at = 0) {
    const ctx = this.ctx, t = ctx.currentTime + at;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t); if (to !== freq) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.02);
  }
  burst(dur, f0, f1, vol = 0.4, type = 'lowpass', at = 0) {
    const ctx = this.ctx, t = ctx.currentTime + at;
    const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master); src.start(t, Math.random()); src.stop(t + dur + 0.02);
  }
  play(name) {
    if (!this.ctx || this.muted) return;
    switch (name) {
      case 'click': this.tone(820, 620, 0.045, 0.07, 'triangle'); break;
      case 'pick': this.tone(420, 620, 0.07, 0.1, 'triangle'); break;
      case 'snap': this.tone(260, 150, 0.09, 0.3); this.burst(0.035, 3200, 1800, 0.22, 'highpass'); break;
      case 'drop': this.tone(300, 170, 0.12, 0.1, 'triangle'); break;
      case 'del': this.tone(330, 110, 0.18, 0.14, 'triangle'); this.burst(0.12, 900, 300, 0.1); break;
      case 'ignite': this.burst(0.9, 150, 1400, 0.45); this.tone(50, 90, 0.5, 0.3); break;
      case 'stage': this.burst(0.28, 1400, 300, 0.5); this.tone(110, 38, 0.32, 0.5); this.tone(1400, 900, 0.05, 0.08, 'square'); break;
      case 'nuke': this.burst(7, 300, 25, 1.0); this.tone(42, 16, 6, 0.9); this.burst(2.5, 1600, 120, 0.6); break;
      case 'boom': this.burst(1.8, 900, 60, 0.9); this.tone(80, 24, 1.1, 0.7); this.burst(0.2, 4000, 800, 0.5, 'highpass'); break;
      case 'chute': this.burst(0.55, 500, 1600, 0.35, 'bandpass'); this.tone(140, 70, 0.2, 0.25, 'sine', 0.3); break;
      case 'goal': this.tone(659, 659, 0.14, 0.13); this.tone(988, 988, 0.3, 0.13, 'sine', 0.11); break;
      case 'orbit': [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, f, i === 4 ? 0.9 : 0.22, 0.15, 'sine', i * 0.13)); this.tone(262, 262, 1.4, 0.1, 'triangle', 0.5); break;
      case 'land': this.tone(70, 38, 0.3, 0.6); this.burst(0.25, 500, 120, 0.4); this.tone(784, 784, 0.16, 0.12, 'sine', 0.35); this.tone(1047, 1047, 0.4, 0.12, 'sine', 0.48); break;
      case 'fail': [392, 330, 247].forEach((f, i) => this.tone(f, f * 0.97, 0.32, 0.12, 'triangle', 0.5 + i * 0.22)); break;
      case 'warn': this.tone(880, 880, 0.08, 0.06, 'square'); this.tone(880, 880, 0.08, 0.06, 'square', 0.14); break;
      case 'tick': this.tone(1200, 1200, 0.03, 0.05, 'square'); break;
      default:
    }
  }
}
export const sfx = new Sfx();
