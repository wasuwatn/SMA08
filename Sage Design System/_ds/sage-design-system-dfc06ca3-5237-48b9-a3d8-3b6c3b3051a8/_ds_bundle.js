/* @ds-bundle: {"format":3,"namespace":"SageDesignSystem_dfc06c","components":[{"name":"Button","sourcePath":"components/actions/Button.jsx"},{"name":"Avatar","sourcePath":"components/data-display/Avatar.jsx"},{"name":"Badge","sourcePath":"components/data-display/Badge.jsx"},{"name":"Tag","sourcePath":"components/data-display/Tag.jsx"},{"name":"Input","sourcePath":"components/forms/Input.jsx"},{"name":"Card","sourcePath":"components/surfaces/Card.jsx"}],"sourceHashes":{"components/actions/Button.jsx":"c36104eb2d62","components/data-display/Avatar.jsx":"73cfa05b2310","components/data-display/Badge.jsx":"5eb7920e91ff","components/data-display/Tag.jsx":"e7785ba9506a","components/forms/Input.jsx":"ba133b09d115","components/surfaces/Card.jsx":"6caf1a33f281"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.SageDesignSystem_dfc06c = window.SageDesignSystem_dfc06c || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/actions/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function injectStyles(id, css) {
  if (typeof document !== 'undefined' && !document.getElementById(id)) {
    const el = document.createElement('style');
    el.id = id;
    el.textContent = css;
    document.head.appendChild(el);
  }
}
injectStyles('sage-button-styles', `
  .sage-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    font-family: var(--font-body);
    font-weight: var(--font-medium);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    cursor: pointer;
    border: 1px solid transparent;
    transition: var(--transition-color), var(--transition-shadow);
    border-radius: var(--radius-sm);
    text-decoration: none;
    white-space: nowrap;
    outline: none;
    user-select: none;
    line-height: 1;
    -webkit-font-smoothing: antialiased;
    box-sizing: border-box;
  }
  .sage-btn:focus-visible { box-shadow: var(--ring-focus); }
  .sage-btn:disabled { cursor: not-allowed; opacity: 0.45; }

  .sage-btn-sm { padding: var(--space-2) var(--space-3);  font-size: var(--text-xs); }
  .sage-btn-md { padding: 10px var(--space-5);            font-size: var(--text-xs); }
  .sage-btn-lg { padding: var(--space-3) var(--space-6);  font-size: var(--text-sm); }

  .sage-btn-solid  { background: var(--accent); color: var(--fg-on-accent); border-color: var(--accent); }
  .sage-btn-solid:not(:disabled):hover  { background: var(--accent-hover);  border-color: var(--accent-hover); }
  .sage-btn-solid:not(:disabled):active { background: var(--accent-active); border-color: var(--accent-active); }

  .sage-btn-outline { background: transparent; color: var(--accent-fg); border-color: var(--olive-400); }
  .sage-btn-outline:not(:disabled):hover  { background: var(--accent-subtle); border-color: var(--accent); }
  .sage-btn-outline:not(:disabled):active { background: var(--accent-muted); }

  .sage-btn-ghost { background: transparent; color: var(--accent-fg); border-color: transparent; }
  .sage-btn-ghost:not(:disabled):hover  { background: var(--accent-subtle); }
  .sage-btn-ghost:not(:disabled):active { background: var(--accent-muted); }

  .sage-btn-soft { background: var(--accent-subtle); color: var(--olive-700); border-color: transparent; }
  .sage-btn-soft:not(:disabled):hover  { background: var(--accent-muted); }
  .sage-btn-soft:not(:disabled):active { background: var(--olive-300); color: var(--olive-800); }
`);

/**
 * Primary interactive control.
 * Use solid for key actions, outline for secondary, ghost for tertiary, soft for low-emphasis.
 */
function Button({
  children,
  variant = 'solid',
  size = 'md',
  disabled = false,
  type = 'button',
  onClick,
  className = '',
  ...props
}) {
  const cls = ['sage-btn', `sage-btn-${variant}`, `sage-btn-${size}`, className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("button", _extends({
    className: cls,
    disabled: disabled,
    type: type,
    onClick: onClick
  }, props), children);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/actions/Button.jsx", error: String((e && e.message) || e) }); }

// components/data-display/Avatar.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function injectStyles(id, css) {
  if (typeof document !== 'undefined' && !document.getElementById(id)) {
    const el = document.createElement('style');
    el.id = id;
    el.textContent = css;
    document.head.appendChild(el);
  }
}
injectStyles('sage-avatar-styles', `
  .sage-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-full);
    overflow: hidden;
    background: var(--accent-subtle);
    color: var(--accent-fg);
    font-family: var(--font-body);
    font-weight: var(--font-medium);
    flex-shrink: 0;
    user-select: none;
    letter-spacing: var(--tracking-wide);
    -webkit-font-smoothing: antialiased;
  }
  .sage-avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .sage-avatar-xs  { width: 24px;  height: 24px;  font-size: var(--text-2xs); }
  .sage-avatar-sm  { width: 32px;  height: 32px;  font-size: var(--text-xs); }
  .sage-avatar-md  { width: 40px;  height: 40px;  font-size: var(--text-sm); }
  .sage-avatar-lg  { width: 48px;  height: 48px;  font-size: var(--text-base); }
  .sage-avatar-xl  { width: 64px;  height: 64px;  font-size: var(--text-xl); }
  .sage-avatar-2xl { width: 80px;  height: 80px;  font-size: var(--text-2xl); }

  .sage-avatar-olive { background: var(--accent-subtle);      color: var(--accent-fg); }
  .sage-avatar-sage  { background: var(--accent-sage-subtle); color: var(--accent-sage-fg); }
  .sage-avatar-stone { background: var(--bg-muted);            color: var(--stone-700); }
  .sage-avatar-solid { background: var(--accent);              color: var(--fg-on-accent); }
`);
function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

/** User or entity representation — image with initials fallback. */
function Avatar({
  name,
  src,
  size = 'md',
  colorScheme = 'olive',
  alt,
  className = '',
  ...props
}) {
  const cls = ['sage-avatar', `sage-avatar-${size}`, !src ? `sage-avatar-${colorScheme}` : '', className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("div", _extends({
    className: cls,
    role: "img",
    "aria-label": alt || name
  }, props), src ? /*#__PURE__*/React.createElement("img", {
    src: src,
    alt: alt || name || ''
  }) : /*#__PURE__*/React.createElement("span", null, getInitials(name)));
}
Object.assign(__ds_scope, { Avatar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data-display/Avatar.jsx", error: String((e && e.message) || e) }); }

// components/data-display/Badge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function injectStyles(id, css) {
  if (typeof document !== 'undefined' && !document.getElementById(id)) {
    const el = document.createElement('style');
    el.id = id;
    el.textContent = css;
    document.head.appendChild(el);
  }
}
injectStyles('sage-badge-styles', `
  .sage-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font-family: var(--font-body);
    font-weight: var(--font-medium);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    border-radius: var(--radius-full);
    white-space: nowrap;
    line-height: 1;
    -webkit-font-smoothing: antialiased;
  }
  .sage-badge-sm { font-size: var(--text-2xs); padding: 3px var(--space-2); }
  .sage-badge-md { font-size: var(--text-xs);  padding: var(--space-1) var(--space-3); }

  .sage-badge-olive   { background: var(--accent-subtle);      color: var(--olive-700); }
  .sage-badge-sage    { background: var(--accent-sage-subtle);  color: var(--accent-sage-fg); }
  .sage-badge-stone   { background: var(--bg-muted);            color: var(--stone-700); }
  .sage-badge-success { background: var(--status-success-bg);   color: var(--status-success-fg); }
  .sage-badge-warning { background: var(--status-warning-bg);   color: var(--status-warning-fg); }
  .sage-badge-error   { background: var(--status-error-bg);     color: var(--status-error-fg); }
  .sage-badge-info    { background: var(--status-info-bg);      color: var(--status-info-fg); }
  .sage-badge-solid   { background: var(--accent);              color: var(--fg-on-accent); }
  .sage-badge-outline {
    background: transparent;
    color: var(--accent-fg);
    box-shadow: inset 0 0 0 1px var(--olive-300);
  }
`);

/** Short status or label indicator. Non-interactive. */
function Badge({
  children,
  variant = 'olive',
  size = 'md',
  className = '',
  ...props
}) {
  const cls = ['sage-badge', `sage-badge-${variant}`, `sage-badge-${size}`, className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("span", _extends({
    className: cls
  }, props), children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data-display/Badge.jsx", error: String((e && e.message) || e) }); }

// components/data-display/Tag.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function injectStyles(id, css) {
  if (typeof document !== 'undefined' && !document.getElementById(id)) {
    const el = document.createElement('style');
    el.id = id;
    el.textContent = css;
    document.head.appendChild(el);
  }
}
injectStyles('sage-tag-styles', `
  .sage-tag {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font-family: var(--font-body);
    font-size: var(--text-xs);
    font-weight: var(--font-regular);
    color: var(--fg-subtle);
    background: var(--bg-subtle);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: 4px var(--space-3);
    line-height: 1.4;
    white-space: nowrap;
    transition: var(--transition-color);
  }
  .sage-tag-olive {
    background: var(--accent-subtle);
    border-color: var(--olive-200);
    color: var(--olive-700);
  }
  .sage-tag-sage {
    background: var(--accent-sage-subtle);
    border-color: var(--sage-200);
    color: var(--sage-700);
  }
  .sage-tag-interactive { cursor: pointer; }
  .sage-tag-interactive:hover {
    background: var(--accent-muted);
    border-color: var(--olive-300);
    color: var(--olive-800);
  }
  .sage-tag-dismiss {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border-radius: var(--radius-full);
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    padding: 0;
    opacity: 0.55;
    font-size: 12px;
    line-height: 1;
    transition: opacity var(--duration-fast) var(--ease-out);
  }
  .sage-tag-dismiss:hover { opacity: 1; }
`);

/** Categorisation label, optionally dismissible or interactive. */
function Tag({
  children,
  variant = 'default',
  onDismiss,
  onClick,
  className = '',
  ...props
}) {
  const cls = ['sage-tag', variant !== 'default' ? `sage-tag-${variant}` : '', onClick ? 'sage-tag-interactive' : '', className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("span", _extends({
    className: cls,
    onClick: onClick,
    role: onClick ? 'button' : undefined,
    tabIndex: onClick ? 0 : undefined
  }, props), children, onDismiss && /*#__PURE__*/React.createElement("button", {
    className: "sage-tag-dismiss",
    onClick: e => {
      e.stopPropagation();
      onDismiss(e);
    },
    "aria-label": "Remove",
    type: "button"
  }, "\xD7"));
}
Object.assign(__ds_scope, { Tag });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data-display/Tag.jsx", error: String((e && e.message) || e) }); }

// components/forms/Input.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function injectStyles(id, css) {
  if (typeof document !== 'undefined' && !document.getElementById(id)) {
    const el = document.createElement('style');
    el.id = id;
    el.textContent = css;
    document.head.appendChild(el);
  }
}
injectStyles('sage-input-styles', `
  .sage-input-wrap {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    font-family: var(--font-body);
  }
  .sage-label {
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    color: var(--fg-subtle);
  }
  .sage-input {
    display: block;
    width: 100%;
    font-family: var(--font-body);
    font-size: var(--text-base);
    color: var(--fg-default);
    background: var(--surface-default);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
    outline: none;
    transition: var(--transition-color), var(--transition-shadow);
    line-height: var(--leading-normal);
    box-sizing: border-box;
    -webkit-font-smoothing: antialiased;
  }
  .sage-input::placeholder { color: var(--fg-disabled); }
  .sage-input:hover:not(:disabled):not(.sage-input-error) { border-color: var(--border-strong); }
  .sage-input:focus:not(:disabled) {
    border-color: var(--olive-400);
    box-shadow: var(--ring-focus);
  }
  .sage-input:disabled {
    background: var(--bg-subtle);
    color: var(--fg-disabled);
    cursor: not-allowed;
  }
  .sage-input-error { border-color: var(--status-error); }
  .sage-input-error:focus {
    box-shadow: 0 0 0 2px var(--focus-ring-offset), 0 0 0 4px var(--status-error);
  }
  .sage-input-sm { padding: var(--space-2) var(--space-3); font-size: var(--text-sm); }
  .sage-input-lg { padding: var(--space-4) var(--space-5); font-size: var(--text-md); }

  .sage-helper       { font-size: var(--text-xs); color: var(--fg-muted); line-height: var(--leading-relaxed); }
  .sage-helper-error { color: var(--status-error-fg); }
`);

/** Text input with optional label, helper text, and validation state. */
function Input({
  label,
  helperText,
  error,
  size = 'md',
  disabled = false,
  id,
  className = '',
  ...props
}) {
  const inputId = id || (label ? 'sage-' + label.toLowerCase().replace(/\s+/g, '-') : undefined);
  const inputCls = ['sage-input', size !== 'md' ? `sage-input-${size}` : '', error ? 'sage-input-error' : '', className].filter(Boolean).join(' ');
  const helpId = inputId ? `${inputId}-help` : undefined;
  return /*#__PURE__*/React.createElement("div", {
    className: "sage-input-wrap"
  }, label && /*#__PURE__*/React.createElement("label", {
    className: "sage-label",
    htmlFor: inputId
  }, label), /*#__PURE__*/React.createElement("input", _extends({
    className: inputCls,
    id: inputId,
    disabled: disabled,
    "aria-invalid": error ? 'true' : undefined,
    "aria-describedby": (error || helperText) && helpId ? helpId : undefined
  }, props)), (helperText || error) && /*#__PURE__*/React.createElement("span", {
    id: helpId,
    className: `sage-helper${error ? ' sage-helper-error' : ''}`
  }, error || helperText));
}
Object.assign(__ds_scope, { Input });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Input.jsx", error: String((e && e.message) || e) }); }

// components/surfaces/Card.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function injectStyles(id, css) {
  if (typeof document !== 'undefined' && !document.getElementById(id)) {
    const el = document.createElement('style');
    el.id = id;
    el.textContent = css;
    document.head.appendChild(el);
  }
}
injectStyles('sage-card-styles', `
  .sage-card {
    background: var(--surface-default);
    border-radius: var(--radius-xl);
    overflow: hidden;
    box-sizing: border-box;
  }

  .sage-card-p-none { padding: 0; }
  .sage-card-p-sm   { padding: var(--space-4); }
  .sage-card-p-md   { padding: var(--space-6); }
  .sage-card-p-lg   { padding: var(--space-8); }

  .sage-card-default  { border: 1px solid var(--border-default); box-shadow: var(--shadow-xs); }
  .sage-card-elevated { box-shadow: var(--shadow-md); }
  .sage-card-bordered { border: 1px solid var(--border-strong); }
  .sage-card-soft     { background: var(--bg-subtle); border: 1px solid var(--border-subtle); }
  .sage-card-ghost    { background: transparent; border: 1px solid var(--border-default); }

  .sage-card-interactive {
    cursor: pointer;
    transition: var(--transition-shadow);
  }
  .sage-card-interactive:hover  { box-shadow: var(--shadow-md); }
  .sage-card-interactive:active { box-shadow: var(--shadow-sm); }
`);

/**
 * Content container with visual separation.
 * Composes with any child content; does not impose internal layout.
 */
function Card({
  children,
  variant = 'default',
  padding = 'md',
  onClick,
  className = '',
  ...props
}) {
  const cls = ['sage-card', `sage-card-${variant}`, `sage-card-p-${padding}`, onClick ? 'sage-card-interactive' : '', className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("div", _extends({
    className: cls,
    onClick: onClick
  }, props), children);
}
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/surfaces/Card.jsx", error: String((e && e.message) || e) }); }

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Avatar = __ds_scope.Avatar;

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Tag = __ds_scope.Tag;

__ds_ns.Input = __ds_scope.Input;

__ds_ns.Card = __ds_scope.Card;

})();
