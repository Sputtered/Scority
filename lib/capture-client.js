import mc from 'minecraft-protocol';

// keep undecodable gameplay frames verbatim
export class CaptureClient extends mc.Client {
  setSerializer(state) {
    super.setSerializer(state);
    if (state !== 'play') return;
    const parse = this.deserializer.parsePacketBuffer.bind(this.deserializer);
    this.deserializer.parsePacketBuffer = buffer => {
      try {
        const result = parse(buffer);
        if (result.metadata.size !== buffer.length) throw new Error(`Decoded ${result.metadata.size} of ${buffer.length} bytes`);
        return result;
      } catch (error) {
        return { data: { name: 'capture_unparsed', params: { error: error.message, raw: Buffer.from(buffer) } },
          metadata: { size: buffer.length }, buffer, fullBuffer: buffer };
      }
    };
  }
}
