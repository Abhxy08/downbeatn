/** Builds a WAV file buffer from float channels. */
export function makeWav(channels: Float32Array[], fs: number, bits: 16 | 24 | 32 = 24, float = false): Buffer {
  const n = channels[0].length, ch = channels.length, bytes = bits / 8;
  const data = Buffer.alloc(n * ch * bytes);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      const p = (i * ch + c) * bytes;
      if (float) data.writeFloatLE(v, p);
      else if (bits === 16) data.writeInt16LE(Math.round(v * 32767), p);
      else if (bits === 24) data.writeIntLE(Math.round(v * 8388607), p, 3);
      else data.writeInt32LE(Math.round(v * 2147483647), p);
    }
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(float ? 3 : 1, 20); h.writeUInt16LE(ch, 22);
  h.writeUInt32LE(fs, 24); h.writeUInt32LE(fs * ch * bytes, 28); h.writeUInt16LE(ch * bytes, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

