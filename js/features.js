// Parts of the site that are switched off for now. Their code and markup stay
// in place; they just don't show. Set a flag to true to bring one back.
//   jsfbExport: Export → Game prop set (.jsfb), with Save to game folder and
//               Ctrl+S straight into the game folder.
//   matches:    the Match panel (each match's game prop set, and the
//               connected PropsSet folder).
export const FEATURES = {
  jsfbExport: false,
  matches: false,
};

// Show or hide the page parts tagged data-feature="name" (shown while that
// feature is on) or data-feature-off="name" (shown while it's off).
export function applyFeatures(root = document) {
  for (const el of root.querySelectorAll('[data-feature]')) el.hidden = !FEATURES[el.dataset.feature];
  for (const el of root.querySelectorAll('[data-feature-off]')) el.hidden = !!FEATURES[el.dataset.featureOff];
}
