// SVG icons for file kinds, styled to echo macOS Finder.
// Each returns an inline SVG string sized to a 1:1 box.

(function () {
  // Classic two-tone macOS folder.
  function folder() {
    return `<svg viewBox="0 0 56 44" class="ico ico-folder" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="fb" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#7cc4f7"/><stop offset="1" stop-color="#4aa3ef"/>
        </linearGradient>
        <linearGradient id="ff" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#a9d8fb"/><stop offset="1" stop-color="#5fb0f2"/>
        </linearGradient>
      </defs>
      <path d="M3 10a4 4 0 014-4h12l5 5h26a4 4 0 014 4v3H3z" fill="url(#fb)"/>
      <path d="M3 15a4 4 0 014-4h42a4 4 0 014 4v21a4 4 0 01-4 4H7a4 4 0 01-4-4z" fill="url(#ff)"/>
    </svg>`;
  }

  // Generic document page with a folded corner; tint + label by kind.
  function doc(label, tint) {
    return `<svg viewBox="0 0 48 60" class="ico ico-doc" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="dg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#f1f1f4"/></linearGradient></defs>
      <path d="M6 3a3 3 0 013-3h22l11 11v46a3 3 0 01-3 3H9a3 3 0 01-3-3z" fill="url(#dg)" stroke="#d2d2d7" stroke-width="1"/>
      <path d="M31 0l11 11H34a3 3 0 01-3-3z" fill="#dfe0e5"/>
      ${label ? `<rect x="6" y="34" width="36" height="15" rx="3" fill="${tint}"/>
      <text x="24" y="45" font-size="9" font-family="-apple-system,Helvetica,Arial" font-weight="700" fill="#fff" text-anchor="middle">${label}</text>` : ''}
    </svg>`;
  }

  function appIcon() {
    return `<svg viewBox="0 0 56 56" class="ico ico-app" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#5b6cff"/><stop offset="1" stop-color="#7b3ff2"/></linearGradient></defs>
      <rect x="4" y="4" width="48" height="48" rx="12" fill="url(#ag)"/>
      <path d="M28 16l4 8h-8z M20 30h16l-3 10H23z" fill="#fff" opacity="0.95"/>
    </svg>`;
  }

  const TINTS = {
    pdf: '#e2453c', doc: '#2b7cff', text: '#8a8f98', sheet: '#1f9d55',
    slides: '#e8743b', code: '#34414e', archive: '#b98b34', image: '#9b59b6',
    video: '#c0392b', audio: '#d35400', file: '#9aa0a8',
  };
  const LABELS = {
    pdf: 'PDF', doc: 'DOC', text: 'TXT', sheet: 'XLS', slides: 'PPT',
    code: '{ }', archive: 'ZIP', image: 'IMG', video: 'MOV', audio: 'AAC', file: '',
  };

  function iconFor(kind) {
    if (kind === 'folder') return folder();
    if (kind === 'app') return appIcon();
    return doc(LABELS[kind] ?? '', TINTS[kind] ?? TINTS.file);
  }

  // Small monochrome glyphs for the sidebar.
  const SIDEBAR = {
    home: `<svg viewBox="0 0 24 24"><path d="M4 11l8-7 8 7M6 9.5V20h12V9.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
    desktop: `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M9 20h6M12 16v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
    documents: `<svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M13 3v5h5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`,
    downloads: `<svg viewBox="0 0 24 24"><path d="M12 3v11m0 0l-4-4m4 4l4-4M5 19h14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    pictures: `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="8.5" cy="10" r="1.6" fill="currentColor"/><path d="M5 17l5-5 4 4 2-2 3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
    music: `<svg viewBox="0 0 24 24"><path d="M9 18V6l10-2v10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="16.5" cy="16" r="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`,
    movies: `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 9l5 3-5 3z" fill="currentColor"/></svg>`,
    folder: `<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`,
    computer: `<svg viewBox="0 0 24 24"><rect x="2.5" y="4" width="19" height="12" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 20h8M12 16v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
    drive: `<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="8" cy="12" r="1.3" fill="currentColor"/><path d="M12 12h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
    applications: `<svg viewBox="0 0 24 24"><path d="M12 3l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 8.7l5.4-.8z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
    cloud: `<svg viewBox="0 0 24 24"><path d="M7 18a4 4 0 01-.5-7.97A5 5 0 0116.9 9.2 3.5 3.5 0 0117 18z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
    icloud: `<svg viewBox="0 0 24 24"><path d="M7 18a4 4 0 01-.5-7.97A5 5 0 0116.9 9.2 3.5 3.5 0 0117 18z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
  };

  function sidebarIcon(name) {
    return SIDEBAR[name] || SIDEBAR.folder;
  }

  window.Icons = { iconFor, sidebarIcon };
})();
