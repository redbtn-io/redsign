import { createElement } from 'react';

export function Nav({ fixed, styles, children }) {
  const style = {
    ...(fixed ? { position: 'fixed', top: 0, left: 0, right: 0, zIndex: 10 } : {}),
    ...(styles || {}),
  };
  return createElement('nav', { className: 'xiro-nav', style }, children);
}

export function Main({ styles, children }) {
  const style = { ...(styles || {}) };
  return createElement('main', { className: 'xiro-main', style }, children);
}

export function Button({ styles, children, ...rest }) {
  const style = { ...(styles || {}) };
  return createElement('button', { type: 'button', className: 'xiro-button', style, ...rest }, children);
}

export function Modal({ show, onClose, styles, children }) {
  if (show === false) return null;
  const overlayStyle = {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0, 0, 0, 0.4)',
    zIndex: 1000,
  };
  const contentStyle = {
    background: '#fff',
    borderRadius: 8,
    padding: 16,
    ...(styles || {}),
  };
  return createElement(
    'div',
    { className: 'xiro-modal-overlay', onClick: onClose },
    createElement(
      'div',
      {
        className: 'xiro-modal',
        role: 'dialog',
        'aria-modal': 'true',
        style: contentStyle,
        onClick: (event) => event.stopPropagation(),
      },
      children,
    ),
  );
}
