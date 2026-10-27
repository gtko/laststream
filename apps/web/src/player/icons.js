/* Icônes du lecteur (SVG en ligne). */
const svg = (d, extra = '') => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' + extra + '>' + d + '</svg>';
export const LI = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4l13 8-13 8z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
  back10: svg('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M9.5 15.5v-4.2l-1 .6M13 11.3h2.2a.9.9 0 0 1 .9.9v2.4a.9.9 0 0 1-.9.9H13z"/>'),
  fwd10: svg('<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/><path d="M9.5 15.5v-4.2l-1 .6M13 11.3h2.2a.9.9 0 0 1 .9.9v2.4a.9.9 0 0 1-.9.9H13z"/>'),
  vol: svg('<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>'),
  mute: svg('<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9l5 6M22 9l-5 6"/>'),
  tracks: svg('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 12h3M12.5 12H17M7 15.5h5M14 15.5h3"/>'),
  source: svg('<path d="M4 7h16M4 12h16M4 17h10"/><circle cx="18" cy="17" r="2"/>'),
  list: svg('<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>'),
  pip: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor"/>'),
  full: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  fullExit: svg('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  back: svg('<path d="M19 12H5M12 19l-7-7 7-7"/>'),
  next: svg('<path d="M5 5l9 7-9 7zM18 5v14"/>'),
  skip: svg('<path d="M5 5l9 7-9 7zM16 5l5 7-5 7"/>'),
  // Réduire dans l'app (mini-lecteur) : chevron vers le bas, comme YouTube ; distinct du PiP (fenêtre flottante).
  mini: svg('<path d="M6 9l6 6 6-6"/>'),
  expand: svg('<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>'),
  people: svg('<circle cx="9" cy="8" r="3.2"/><path d="M3 20c.6-3.3 3-5 6-5s5.400 1.700 6 5"/><circle cx="17" cy="9" r="2.500"/><path d="M16.500 14.200c2.600.1 4.100 1.600 4.500 4.300"/>'),
  // Chromecast : écran et ondes dans le coin bas gauche.
  cast: svg('<path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/><path d="M2 12a9 9 0 0 1 8 8M2 16a5 5 0 0 1 4 4M2 20h.01"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
};
