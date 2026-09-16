/*
 * Paper.
 *
 * One stylesheet for both ways a page reaches a printer: the Print action,
 * which prints a self-contained copy of the page, and the browser's own print
 * command pressed while the app is open. The first never has app chrome in
 * it, the second always does, so the chrome rules below matter for the second.
 *
 * PDF is the browser's "Save as PDF" in the same dialog. It works everywhere
 * the app does and needs nothing on the server, which also runs as a
 * Cloudflare Worker where a headless browser is not available.
 */

/**
 * Held as a string rather than a .css file because it has two destinations:
 * the app's document, where `installPrintStyles` adds it once, and every
 * exported HTML file, which embeds it.
 */
export const PRINT_CSS = `@media print {
  @page {
    margin: 18mm 16mm;
  }

  /* App chrome: navigation, the documents tree, the inspector, the top bar
     and its actions, and anything that only makes sense on a screen. */
  .nb-shell__sidebar,
  .nb-shell__topbar,
  .nb-shell__contextbar,
  .nb-shell__contextbar-toggle,
  .nb-shell__inspector,
  .nb-shell__fixedbar,
  .nb-shell__menubar,
  .nb-shell__bottom,
  .nb-shell__notification,
  .nb-shell__scrim,
  .nb-shell__skip-link,
  .nb-shell__nav-toggle,
  .docs__history,
  .docs__comments,
  .docs__backlinks,
  .md-wrap__toggle,
  .md__anchor,
  .md__code-copy,
  .doc-transfer__stage,
  [data-print='hide'] {
    display: none !important;
  }

  html,
  body,
  .nb-shell,
  .nb-shell__body,
  .nb-shell__main,
  .nb-shell__main-row,
  .nb-shell__content-row,
  .nb-shell__middle {
    display: block !important;
    overflow: visible !important;
    height: auto !important;
    max-height: none !important;
    background: #fff !important;
    color: #1b1f24 !important;
  }

  .md,
  .md--clamped {
    max-block-size: none !important;
    mask-image: none !important;
    overflow: visible !important;
  }

  /* Never cut a block that reads as one thing in half. */
  .md pre,
  .md blockquote,
  .md__callout,
  .md details,
  .md tr,
  .md img,
  .md figure,
  .md__math,
  .md__diagram-figure,
  .md__card,
  .md__card-slot,
  .md__embed,
  .md__file {
    break-inside: avoid;
    page-break-inside: avoid;
  }

  .md h1,
  .md h2,
  .md h3,
  .md h4 {
    break-after: avoid;
    page-break-after: avoid;
  }

  .md p,
  .md li {
    orphans: 3;
    widows: 3;
  }

  /* A table longer than a page repeats its header on the next one. */
  .md thead {
    display: table-header-group;
  }

  /* Code wraps on paper, since nobody can scroll a printout sideways. */
  .md pre,
  .md pre code {
    white-space: pre-wrap !important;
    overflow: visible !important;
    overflow-wrap: anywhere;
  }

  /* A closed toggle hides its content, which paper cannot open. */
  .md details::details-content {
    content-visibility: visible;
    display: block;
  }

  .md details > summary::marker {
    content: '';
  }

  /* A link is only useful on paper if you can read where it goes. */
  .md a[href^='http']:not(.md__card):not(.md__drive):not(.md__card-plain)::after {
    content: ' (' attr(href) ')';
    font-size: 0.85em;
    color: #57606a;
    overflow-wrap: anywhere;
  }

  /* A link card becomes a bordered reference with its address, and loses its
     picture, which is decoration that costs ink. */
  .md__card {
    display: block !important;
    border: 1px solid #d0d7de !important;
    box-shadow: none !important;
    background: #fff !important;
    padding: 8px 12px !important;
    text-decoration: none !important;
  }

  .md__card-shot {
    display: none !important;
  }

  .md__card::after {
    content: attr(href);
    display: block;
    margin-top: 4px;
    font-size: 0.8em;
    color: #57606a;
    overflow-wrap: anywhere;
  }

  /* An embed has nothing live to show on paper, so it says what it was. */
  .md__embed {
    border: 1px dashed #afb8c1 !important;
    color: #57606a !important;
    background: none !important;
  }

  .md__file::after {
    content: ' (attachment)';
    color: #57606a;
  }

  .md__diagram-figure svg,
  .md img {
    max-width: 100% !important;
    max-height: 90vh !important;
  }

  .export__page + .export__page {
    break-before: page;
    page-break-before: always;
  }
}
`

/** Adds the print rules to the app's own document, once. */
export function installPrintStyles(): void {
  if (typeof document === 'undefined') return
  if (document.head.querySelector('style[data-acta-print]')) return
  const style = document.createElement('style')
  style.setAttribute('data-acta-print', '')
  style.textContent = PRINT_CSS
  document.head.append(style)
}
