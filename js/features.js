// Parts of the site that are switched off for now. Their code and markup stay
// in place; they just don't show. Set a flag to true to bring one back.
//   jsfbExport: Export → Game prop set (.jsfb), with Save to game folder and
//               Ctrl+S straight into the game folder.
//   jsfbImport: opening a game prop set (.jsfb) with Import or drag and drop.
//   matches:    the Match panel (each match's game prop set, and the
//               connected PropsSet folder).
export const FEATURES = {
  jsfbExport: false,
  jsfbImport: false,
  matches: false,
};

const allOn = (names) => names.split(/\s+/).every((n) => FEATURES[n]);

// Show or hide the page parts tagged data-feature="name …" (shown while all
// those features are on) or data-feature-off="name" (shown while it's off).
export function applyFeatures(root = document) {
  for (const el of root.querySelectorAll('[data-feature]')) el.hidden = !allOn(el.dataset.feature);
  for (const el of root.querySelectorAll('[data-feature-off]')) el.hidden = allOn(el.dataset.featureOff);
}
