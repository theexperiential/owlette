/**
 * Wraps each h3 and its following content (until the next h2/h3 or hr) in a
 * .endpoint-card div so endpoints can be styled as distinct cards.
 */
document.addEventListener('DOMContentLoaded', () => {
  const article = document.querySelector('article.md-content__inner');
  if (!article) return;

  const children = Array.from(article.childNodes);
  let i = 0;

  while (i < children.length) {
    const node = children[i];

    if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'H3') {
      const card = document.createElement('div');
      card.className = 'endpoint-card';

      // Collect the h3 and all following nodes until the next h2/h3/hr
      const collected = [];
      let j = i;
      while (j < children.length) {
        const sibling = children[j];
        if (j > i && sibling.nodeType === Node.ELEMENT_NODE &&
            (sibling.tagName === 'H2' || sibling.tagName === 'H3' || sibling.tagName === 'HR')) {
          break;
        }
        collected.push(sibling);
        j++;
      }

      // Insert card before the first collected node and move nodes into it
      article.insertBefore(card, collected[0]);
      collected.forEach(n => card.appendChild(n));

      // Refresh children array after DOM mutation and restart from current position
      children.splice(i, collected.length, card);
    }

    i++;
  }
});

/**
 * Highlights the active TOC entry on scroll by adding .toc-active to the
 * link whose section is currently in view.
 */
(() => {
  let ticking = false;

  function updateTOC() {
    const links = document.querySelectorAll('.md-sidebar--secondary .md-nav__link');
    if (!links.length) return;

    let active = null;
    links.forEach(link => {
      const href = link.getAttribute('href');
      if (!href || !href.startsWith('#')) return;
      const id = href.slice(1);
      const el = document.getElementById(id);
      if (el && el.getBoundingClientRect().top <= 100) {
        active = link;
      }
    });

    links.forEach(l => l.classList.remove('toc-active'));
    if (active) {
      active.classList.add('toc-active');
      // Highlight parent section: walk up from active link's <li> through
      // <ul> → <nav> → parent <li>, then find its direct <a> child
      const parentItem = active.closest('.md-nav__item')
        ?.parentElement?.parentElement?.parentElement;
      if (parentItem?.classList.contains('md-nav__item')) {
        const parentLink = parentItem.querySelector(':scope > .md-nav__link');
        if (parentLink) parentLink.classList.add('toc-active');
      }
    }
  }

  function onScroll() {
    if (!ticking) {
      requestAnimationFrame(() => {
        updateTOC();
        ticking = false;
      });
      ticking = true;
    }
  }

  // Run on initial load
  window.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('DOMContentLoaded', updateTOC);
  // Also run after a short delay to catch late-rendered TOC
  setTimeout(updateTOC, 500);
})();
