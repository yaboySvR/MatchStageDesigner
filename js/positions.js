// EnvironmentSetup/PropsPositions.jsfb: which PropsSet file the game loads
// for each match type. The game's own file only lists the Gameplay sets, the
// Ambulance, the Casket and the Dumpster; a match missing from it never loads
// its PropsSet file, however it was edited. The mod tool adds the rest when it
// saves a match (the rows in TYPES, as it writes them), and so does the site,
// whenever a match is written into a connected folder that has the file's
// folder (matches.js, gamefolder.js).
//
// Only missing rows are added, at the end. Every other byte of the file stays
// as it was: a match type that already points at a file is never changed,
// and a file that needs nothing isn't rewritten.

import { decode, encode, POSITIONS } from './jsfb.js';

export const FILE = 'PropsPositions.jsfb';

// match file -> the match types that load it (as the mod tool writes them)
const TYPES = {
  PropsSet_HIAC: [22, 23, 24, 25, 26, 83, 84, 18],
  PropsSet_FallsCountAnywhere: [19, 20, 21],
  PropsSet_SteelCage: [37, 38, 39],
  PropsSet_EliminationChamber: [17],
  PropsSet_Underground: [103, 104, 105, 106],
  PropsSet_ExtremeRules: [50, 51, 52, 53],
  PropsSet_LastManStanding: [32],
  PropsSet_IQuit: [142],
  PropsSet_Inferno: [143],
  PropsSet_BloodlineRules: [141],
};

// The game names a file by the FNV-1a 64 hash of its lowercase path.
export function fileHash(file) {
  let h = 0xcbf29ce484222325n;
  for (const c of new TextEncoder().encode(`environment/propsset/${file.toLowerCase()}.jsfb`)) {
    h = ((h ^ BigInt(c)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}

// The rows `files` (match files, e.g. 'PropsSet_HIAC') need that `bytes`
// doesn't have: [{ match, file }].
export function missingRows(bytes, files) {
  const have = new Set(decode(bytes, POSITIONS).sets?.map((r) => r.match ?? 0));
  const rows = [];
  for (const f of files) {
    for (const match of TYPES[f] ?? []) {
      if (have.has(match)) continue;
      have.add(match);
      rows.push({ match, file: fileHash(f) });
    }
  }
  return rows;
}

// `bytes` with the rows `files` need added, or null if it has them all.
export function withMatches(bytes, files) {
  const rows = missingRows(bytes, files);
  if (!rows.length) return null;
  const doc = decode(bytes, POSITIONS);
  doc.sets = [...(doc.sets ?? []), ...rows];
  return encode(doc, POSITIONS);
}

// Does the game need a row in the file to load this match file?
export const listed = (file) => file in TYPES;

// Has neither the site nor the mod tool added a row to the file yet (the
// game's own, as far as these rows go)?
export function untouched(bytes) {
  const all = Object.keys(TYPES);
  return missingRows(bytes, all).length === all.reduce((n, f) => n + TYPES[f].length, 0);
}

// Does the file let every one of `files` load?
export const covers = (bytes, files) => !missingRows(bytes, files).length;
