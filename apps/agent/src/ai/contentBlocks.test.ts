// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { attachmentsToContentBlocks } from './contentBlocks.js';
import type { Attachment } from '@sumicom/quicksave-shared';

// ── Helpers ─────────────────────────────────────────────────────────────────

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

function makeImage(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'att-img-1',
    kind: 'image',
    mimeType: 'image/png',
    name: 'photo.png',
    size: 4,
    data: b64('PNG!'),
    ...overrides,
  };
}

function makePdf(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'att-pdf-1',
    kind: 'pdf',
    mimeType: 'application/pdf',
    name: 'doc.pdf',
    size: 5,
    data: b64('%PDF-'),
    ...overrides,
  };
}

function makeText(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'att-txt-1',
    kind: 'text',
    mimeType: 'text/plain',
    name: 'pasted-1.txt',
    size: 11,
    data: b64('hello\nworld'),
    ...overrides,
  };
}

// Narrow the union return so tests can index into the array.
function asArray(value: ReturnType<typeof attachmentsToContentBlocks>): any[] {
  if (typeof value === 'string') {
    throw new Error(`expected ContentBlockParam[], got string: ${JSON.stringify(value)}`);
  }
  return value as any[];
}

// ============================================================================
// Passthrough — string return
// ============================================================================

describe('attachmentsToContentBlocks — passthrough (no attachments)', () => {
  it('returns the prompt verbatim when attachments is undefined', () => {
    const result = attachmentsToContentBlocks('hello world');
    expect(result).toBe('hello world');
    expect(typeof result).toBe('string');
  });

  it('returns the prompt verbatim (string, NOT array) when attachments is empty array', () => {
    const result = attachmentsToContentBlocks('hello world', []);
    expect(result).toBe('hello world');
    expect(Array.isArray(result)).toBe(false);
    expect(typeof result).toBe('string');
  });

  it('returns empty string when prompt is empty and no attachments', () => {
    const result = attachmentsToContentBlocks('');
    expect(result).toBe('');
  });

  it('returns empty string when prompt is empty and attachments is empty array', () => {
    const result = attachmentsToContentBlocks('', []);
    expect(result).toBe('');
  });
});

// ============================================================================
// Image only
// ============================================================================

describe('attachmentsToContentBlocks — image attachments', () => {
  it('builds [imageBlock, textBlock] for a single image with non-empty prompt', () => {
    const data = b64('PNG-bytes');
    const att = makeImage({ data, mimeType: 'image/png' });
    const result = asArray(attachmentsToContentBlocks('describe this', [att]));

    expect(result).toHaveLength(2);

    expect(result[0]).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data,
      },
    });

    expect(result[1]).toEqual({ type: 'text', text: 'describe this' });
  });

  it('normalizes uppercase mime type "IMAGE/JPEG" to "image/jpeg"', () => {
    const att = makeImage({ mimeType: 'IMAGE/JPEG' });
    const result = asArray(attachmentsToContentBlocks('q', [att]));

    expect(result[0].type).toBe('image');
    expect(result[0].source.media_type).toBe('image/jpeg');
  });

  it('falls back to "image/png" for a disallowed mime type (e.g. image/svg+xml)', () => {
    const att = makeImage({ mimeType: 'image/svg+xml' });
    const result = asArray(attachmentsToContentBlocks('q', [att]));

    expect(result[0].type).toBe('image');
    expect(result[0].source.media_type).toBe('image/png');
  });

  it('preserves all four allowed image media types', () => {
    const allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
    for (const mime of allowed) {
      const att = makeImage({ mimeType: mime });
      const result = asArray(attachmentsToContentBlocks('q', [att]));
      expect(result[0].source.media_type).toBe(mime);
    }
  });
});

// ============================================================================
// PDF only
// ============================================================================

describe('attachmentsToContentBlocks — pdf attachments', () => {
  it('builds [documentBlock, textBlock] for a single PDF with non-empty prompt, including title', () => {
    const data = b64('%PDF-1.4 fake');
    const att = makePdf({ data, name: 'invoice-2026-q1.pdf' });
    const result = asArray(attachmentsToContentBlocks('summarize', [att]));

    expect(result).toHaveLength(2);

    // The `title` field is critical: it is what cardBuilder reads on cold
    // JSONL replay to recover the original filename when the persisted
    // attachment meta is no longer available.
    expect(result[0]).toEqual({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data,
      },
      title: 'invoice-2026-q1.pdf',
    });

    expect(result[1]).toEqual({ type: 'text', text: 'summarize' });
  });

  it('preserves the exact attachment name in the document title (unicode + spaces)', () => {
    const att = makePdf({ name: '会議メモ 2026-05-03.pdf' });
    const result = asArray(attachmentsToContentBlocks('q', [att]));

    expect(result[0].type).toBe('document');
    expect(result[0].title).toBe('会議メモ 2026-05-03.pdf');
  });
});

// ============================================================================
// Text only
// ============================================================================

describe('attachmentsToContentBlocks — text attachments', () => {
  it('wraps decoded utf-8 content in <<<file:NAME>>> / <<<end:NAME>>> fences', () => {
    const att = makeText({ name: 'pasted-1.txt', data: b64('hello\nworld') });
    const result = asArray(attachmentsToContentBlocks('go', [att]));

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      type: 'text',
      text: '<<<file:pasted-1.txt>>>\nhello\nworld\n<<<end:pasted-1.txt>>>',
    });
    expect(result[1]).toEqual({ type: 'text', text: 'go' });
  });

  it('decodes multi-byte UTF-8 content correctly (Japanese)', () => {
    const original = '日本語テスト';
    const att = makeText({ name: 'jp.txt', data: b64(original) });
    const result = asArray(attachmentsToContentBlocks('translate', [att]));

    expect(result[0].type).toBe('text');
    expect(result[0].text).toBe(`<<<file:jp.txt>>>\n${original}\n<<<end:jp.txt>>>`);

    // Sanity-check: the original string is recoverable from the fenced text.
    expect(result[0].text).toContain(original);
  });

  it('round-trips through Buffer.from(b64).toString(utf8) without mangling', () => {
    const original = 'café — naïve résumé 😀';
    const data = b64(original);
    // Verify our test fixture is correct: decoding gives us the original back.
    expect(Buffer.from(data, 'base64').toString('utf8')).toBe(original);

    const att = makeText({ name: 'unicode.txt', data });
    const result = asArray(attachmentsToContentBlocks('', [att]));

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe(`<<<file:unicode.txt>>>\n${original}\n<<<end:unicode.txt>>>`);
  });
});

// ============================================================================
// Mixed attachments — ordering
// ============================================================================

describe('attachmentsToContentBlocks — mixed attachment ordering', () => {
  it('places attachments before the prompt text block, preserving input order', () => {
    const img = makeImage({ data: b64('IMG'), mimeType: 'image/png' });
    const pdf = makePdf({ data: b64('PDF') });
    const txt = makeText({ name: 'note.md', data: b64('# heading') });

    const result = asArray(attachmentsToContentBlocks('q', [img, pdf, txt]));

    expect(result).toHaveLength(4);

    // Order: image, pdf, text-attachment, prompt-text
    expect(result[0].type).toBe('image');
    expect(result[1].type).toBe('document');
    expect(result[2].type).toBe('text');
    expect(result[2].text).toBe('<<<file:note.md>>>\n# heading\n<<<end:note.md>>>');
    expect(result[3].type).toBe('text');
    expect(result[3].text).toBe('q');

    // The prompt text block is strictly last.
    const promptIndex = result.findIndex(b => b.type === 'text' && b.text === 'q');
    expect(promptIndex).toBe(result.length - 1);
  });
});

// ============================================================================
// Empty prompt with attachments
// ============================================================================

describe('attachmentsToContentBlocks — empty prompt with attachments', () => {
  it('omits the trailing prompt text block when prompt is empty', () => {
    const att = makeImage();
    const result = asArray(attachmentsToContentBlocks('', [att]));

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('image');
    // No trailing { type: 'text', text: '' } block.
    expect(result.some(b => b.type === 'text' && b.text === '')).toBe(false);
  });
});

// ============================================================================
// Unknown kind is dropped, not thrown
// ============================================================================

describe('attachmentsToContentBlocks — unknown kind is dropped', () => {
  it('silently ignores an attachment with an unknown kind without throwing', () => {
    const bogus = {
      id: 'att-vid',
      kind: 'video' as any,
      mimeType: 'video/mp4',
      name: 'clip.mp4',
      size: 3,
      data: b64('vid'),
    } as Attachment;

    expect(() => attachmentsToContentBlocks('q', [bogus])).not.toThrow();

    const result = attachmentsToContentBlocks('q', [bogus]);
    // Only the unknown attachment + a non-empty prompt: result is an array
    // with just the prompt's text block (the unknown was dropped).
    const arr = asArray(result);
    expect(arr).toHaveLength(1);
    expect(arr[0]).toEqual({ type: 'text', text: 'q' });
  });

  it('drops the unknown kind from a mixed [good, bad, good] array', () => {
    const goodImage = makeImage({ data: b64('IMG') });
    const badKind = {
      id: 'att-bad',
      kind: 'video' as any,
      mimeType: 'video/mp4',
      name: 'clip.mp4',
      size: 3,
      data: b64('vid'),
    } as Attachment;
    const goodText = makeText({ name: 'n.txt', data: b64('hi') });

    const result = asArray(
      attachmentsToContentBlocks('go', [goodImage, badKind, goodText]),
    );

    // 2 valid attachment blocks + 1 prompt block = 3 total.
    expect(result).toHaveLength(3);
    expect(result[0].type).toBe('image');
    expect(result[1].type).toBe('text');
    expect(result[1].text).toBe('<<<file:n.txt>>>\nhi\n<<<end:n.txt>>>');
    expect(result[2].type).toBe('text');
    expect(result[2].text).toBe('go');

    // No "document" block snuck in for the dropped video.
    expect(result.some(b => b.type === 'document')).toBe(false);
  });
});
