/**
 * @jest-environment node
 *
 * tests for web/lib/sanitize.ts (roost wave 3.8).
 */
import { isFilenameClean, sanitizeFilename } from '@/lib/sanitize';

describe('sanitizeFilename', () => {
  describe('happy path', () => {
    it('passes clean ascii filenames through unchanged', () => {
      const r = sanitizeFilename('project.toe');
      expect(r).toEqual({ ok: true, value: 'project.toe', changed: false });
    });

    it('passes accented + unicode filenames through', () => {
      const r = sanitizeFilename('café-résumé.toe');
      expect(r.ok).toBe(true);
      expect(r.ok && r.value).toBe('café-résumé.toe');
    });

    it('passes CJK filenames through', () => {
      const r = sanitizeFilename('プロジェクト.toe');
      expect(r.ok).toBe(true);
      expect(r.ok && r.value).toBe('プロジェクト.toe');
    });

    it('passes emoji filenames through', () => {
      const r = sanitizeFilename('🦉owlette-🚀.toe');
      expect(r.ok).toBe(true);
      expect(r.ok && r.value).toBe('🦉owlette-🚀.toe');
    });
  });

  describe('xss-adjacent inputs', () => {
    // React escapes by default — but we must confirm we don't CORRUPT
    // these names (leaving them to fool a later non-JSX render surface).
    // The sanitiser preserves the literal characters; JSX escaping is
    // what makes them safe at render.
    it('preserves an <img onerror=...> literal as text', () => {
      const r = sanitizeFilename('<img onerror=alert(1)>.toe');
      expect(r.ok).toBe(true);
      // preserved verbatim — escaping is the render layer's responsibility.
      expect(r.ok && r.value).toBe('<img onerror=alert(1)>.toe');
    });

    it('rejects filenames containing a path separator (even inside script-tag-ish payloads)', () => {
      // `</script>` has a `/`, which is rejected as a path separator.
      // XSS payloads that don't contain a slash are preserved verbatim;
      // JSX escaping handles safe rendering. See the <img onerror=...>
      // case above.
      const r = sanitizeFilename('</script>payload.toe');
      expect(r).toEqual({
        ok: false,
        reason: 'filename contains a path separator',
      });
    });

    it('preserves non-slash script-tag-ish payloads', () => {
      const r = sanitizeFilename('<script>alert(1)<-script>.toe');
      expect(r.ok).toBe(true);
      expect(r.ok && r.value).toBe('<script>alert(1)<-script>.toe');
    });

    it('preserves html entities as literal text', () => {
      const r = sanitizeFilename('&amp;&#x27;.toe');
      expect(r.ok).toBe(true);
      expect(r.ok && r.value).toBe('&amp;&#x27;.toe');
    });
  });

  describe('unicode spoofing defenses', () => {
    it('strips zero-width space', () => {
      const r = sanitizeFilename('invoice\u200b.pdf');
      expect(r.ok).toBe(true);
      expect(r.ok && r.value).toBe('invoice.pdf');
      expect(r.ok && r.changed).toBe(true);
    });

    it('strips RTL override (classic extension spoof)', () => {
      // `photo\u202Egpj.exe` visually renders as `photoexe.jpg`.
      // strip the override so operators see the true name.
      const r = sanitizeFilename('photo\u202Egpj.exe');
      expect(r.ok).toBe(true);
      expect(r.ok && r.value).toBe('photogpj.exe');
      expect(r.ok && r.changed).toBe(true);
    });

    it('strips all listed directional / invisible formatting chars', () => {
      const invisibles = [
        '\u200c', // ZWNJ
        '\u200d', // ZWJ
        '\u200e', // LRM
        '\u200f', // RLM
        '\u202a', // LRE
        '\u202b', // RLE
        '\u202c', // PDF
        '\u202d', // LRO
        '\u2060', // WORD JOINER
        '\u2066', // LRI
        '\u2069', // PDI
        '\ufeff', // BOM
      ];
      for (const ch of invisibles) {
        const r = sanitizeFilename(`x${ch}y.toe`);
        expect(r.ok).toBe(true);
        expect(r.ok && r.value).toBe('xy.toe');
      }
    });

    it('NFC-normalises decomposed forms', () => {
      // café in NFD (e + combining acute) vs NFC (single codepoint).
      const nfd = 'cafe\u0301.toe'; // e + ́
      const r = sanitizeFilename(nfd);
      expect(r.ok).toBe(true);
      expect(r.ok && r.value).toBe('café.toe');
    });
  });

  describe('control characters', () => {
    it('strips NUL byte by rejecting the whole name', () => {
      const r = sanitizeFilename('a\x00b.toe');
      expect(r).toEqual({ ok: false, reason: 'filename contains NUL byte' });
    });

    it('strips low ASCII control chars', () => {
      const r = sanitizeFilename('name\x01\x02\x1b.toe');
      expect(r.ok).toBe(true);
      expect(r.ok && r.value).toBe('name.toe');
    });

    it('strips newlines (filenames should never have them; they break terminal rendering)', () => {
      const r = sanitizeFilename('name\nline.toe');
      expect(r.ok).toBe(true);
      expect(r.ok && r.value).toBe('nameline.toe');
    });

    it('strips tabs and carriage returns', () => {
      const r = sanitizeFilename('a\tb\rc.toe');
      expect(r.ok).toBe(true);
      expect(r.ok && r.value).toBe('abc.toe');
    });
  });

  describe('rejection cases', () => {
    it('rejects non-string input', () => {
      // @ts-expect-error — deliberately wrong type to check runtime guard
      const r = sanitizeFilename(123);
      expect(r.ok).toBe(false);
    });

    it('rejects forward-slash filenames (paths, not names)', () => {
      const r = sanitizeFilename('dir/file.toe');
      expect(r).toEqual({
        ok: false,
        reason: 'filename contains a path separator',
      });
    });

    it('rejects backslash filenames', () => {
      const r = sanitizeFilename('dir\\file.toe');
      expect(r).toEqual({
        ok: false,
        reason: 'filename contains a path separator',
      });
    });

    it('rejects "."', () => {
      const r = sanitizeFilename('.');
      expect(r.ok).toBe(false);
    });

    it('rejects ".."', () => {
      const r = sanitizeFilename('..');
      expect(r.ok).toBe(false);
    });

    it('rejects a name that is only invisible characters', () => {
      const r = sanitizeFilename('\u200b\u200c\u200d');
      expect(r.ok).toBe(false);
    });

    it('rejects a name that is only whitespace + dots', () => {
      const r = sanitizeFilename('  ...');
      expect(r.ok).toBe(false);
    });
  });

  describe('windows-style trailing normalisation', () => {
    it('strips trailing dots (windows silently drops them on write)', () => {
      const r = sanitizeFilename('file.toe.');
      expect(r.ok).toBe(true);
      expect(r.ok && r.value).toBe('file.toe');
    });

    it('strips trailing spaces', () => {
      const r = sanitizeFilename('file.toe   ');
      expect(r.ok).toBe(true);
      expect(r.ok && r.value).toBe('file.toe');
    });

    it('strips leading spaces', () => {
      const r = sanitizeFilename('   file.toe');
      expect(r.ok).toBe(true);
      expect(r.ok && r.value).toBe('file.toe');
    });

    it('preserves leading dots (unix hidden files)', () => {
      const r = sanitizeFilename('.env');
      expect(r.ok).toBe(true);
      expect(r.ok && r.value).toBe('.env');
    });
  });

  describe('length', () => {
    it('truncates names longer than 255 codepoints', () => {
      const long = 'a'.repeat(500) + '.toe';
      const r = sanitizeFilename(long);
      expect(r.ok).toBe(true);
      expect(r.ok && Array.from(r.value).length).toBe(255);
    });

    it('truncates by codepoint count, not utf-16 code units', () => {
      // Each 🦉 is one codepoint (two utf-16 units). 300 of them should
      // truncate to 255 codepoints, not split a surrogate pair.
      const owls = '🦉'.repeat(300);
      const r = sanitizeFilename(owls);
      expect(r.ok).toBe(true);
      expect(r.ok && Array.from(r.value).length).toBe(255);
      // no stray surrogate: the string should parse back cleanly.
      expect(r.ok && r.value.includes('\uFFFD')).toBe(false);
    });
  });
});

describe('isFilenameClean', () => {
  it('is true for already-clean names', () => {
    expect(isFilenameClean('project.toe')).toBe(true);
  });

  it('is false when sanitiser would change the name', () => {
    expect(isFilenameClean('file\u200b.toe')).toBe(false);
  });

  it('is false when sanitiser would reject the name', () => {
    expect(isFilenameClean('has/slash.toe')).toBe(false);
  });
});
