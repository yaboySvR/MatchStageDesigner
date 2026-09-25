// action: { label, onClick } adds a button (e.g. Undo) to the toast.
export function toast(message, { error = false, ms = 3200, action = null } = {}) {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = error ? 'toast err' : 'toast';
  const text = document.createElement('span');
  text.textContent = message;
  el.appendChild(text);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-action';
    b.textContent = action.label;
    b.addEventListener('click', () => {
      action.onClick();
      el.remove();
    });
    el.appendChild(b);
  }
  host.appendChild(el);
  setTimeout(() => el.remove(), action ? Math.max(ms, 6000) : ms);
  return el;
}
