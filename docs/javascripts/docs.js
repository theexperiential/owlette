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
