// relay gameplay only; handshakes stay independent
export function relayPlayPacket(source, destination, data, meta, buffer) {
  if (meta.state !== 'play' || source.state !== 'play' || destination.state !== 'play') return false;
  if (meta.name === 'keep_alive' || meta.name === 'set_compression') return false;
  if (Buffer.isBuffer(buffer) && typeof destination.writeRaw === 'function') {
    destination.writeRaw(buffer);
  } else {
    destination.write(meta.name, data);
  }
  return true;
}
