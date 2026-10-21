// discard copied replay time markers
export function normalizeReplayId(input) {
  const id = String(input || '').trim()
    .replace(/^\/replay[ \t]+/i, '')
    .replace(/[ \t]*#[0-9a-f]+$/i, '');
  return /^[a-zA-Z0-9_-]{1,100}$/.test(id) ? id : null;
}
