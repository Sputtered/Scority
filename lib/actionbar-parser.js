import { flattenToText } from "./death-parser.js";

const ACTIONBAR_RE = /(Paused|Playing|Finished)\D+(\d{1,3}):(\d{2})\s*\/\s*(\d{1,3}):(\d{2})\D+(\d+(?:\.\d+)?)x/i;

function toSeconds(min, sec) {
  return Number(min) * 60 + Number(sec);
}

export function parseActionBar(component) {
  const text = flattenToText(component);
  const match = text.match(ACTIONBAR_RE);
  if (!match) return null;

  const [, stateWord, elapsedMin, elapsedSec, totalMin, totalSec, speedStr] = match;
  if (Number(elapsedSec) >= 60 || Number(totalSec) >= 60 || Number(speedStr) <= 0) return null;
  return {
    state: stateWord.toLowerCase(),
    elapsedSec: toSeconds(elapsedMin, elapsedSec),
    totalSec: toSeconds(totalMin, totalSec),
    speed: Number(speedStr),
  };
}
