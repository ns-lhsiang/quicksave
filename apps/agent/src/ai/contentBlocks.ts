// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
// ============================================================================
// Convert resolved Attachments into Anthropic content blocks for the user
// turn pushed to Claude (CLI or SDK — both accept the same MessageParam shape).
//
// Attachments are placed first, the prompt last, so the model reads files
// before the question. Text attachments inline as fenced text blocks (with
// the filename in the fence) since `PlainTextSource.media_type` is strictly
// `'text/plain'` and we want to preserve the user's actual mime
// (`text/markdown`, `application/json`, etc.) for the model to see.
// ============================================================================

import type { Attachment } from '@sumicom/quicksave-shared';
import type {
  Base64ImageSource,
  ContentBlockParam,
  MessageParam,
} from '@anthropic-ai/sdk/resources';

type ImageMediaType = Base64ImageSource['media_type'];

const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

/**
 * Build the user turn's `content` field. With no attachments, returns the
 * prompt verbatim as a string so the existing single-string fast path is
 * preserved; with attachments, returns a content-block array.
 */
export function attachmentsToContentBlocks(
  prompt: string,
  attachments?: readonly Attachment[],
): MessageParam['content'] {
  if (!attachments || attachments.length === 0) return prompt;

  const blocks: ContentBlockParam[] = [];

  for (const a of attachments) {
    if (a.kind === 'image') {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: normalizeImageMime(a.mimeType),
          data: a.data,
        },
      });
      continue;
    }
    if (a.kind === 'pdf') {
      // `title` is preserved in the JSONL transcript, so on cold replay the
      // cardBuilder rebind can recover the original filename even when the
      // persisted attachment meta is gone (eviction, fresh daemon, etc.).
      blocks.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: a.data,
        },
        title: a.name,
      });
      continue;
    }
    if (a.kind === 'text') {
      const decoded = decodeBase64Utf8(a.data);
      blocks.push({
        type: 'text',
        text: `<<<file:${a.name}>>>\n${decoded}\n<<<end:${a.name}>>>`,
      });
      continue;
    }
    // Defensive: an unknown kind is silently dropped rather than thrown,
    // because attachments are best-effort enrichments to the user turn —
    // we'd rather forward the prompt than refuse the whole send.
  }

  if (prompt.length > 0) {
    blocks.push({ type: 'text', text: prompt });
  }

  return blocks;
}

function normalizeImageMime(mimeType: string): ImageMediaType {
  const lowered = mimeType.toLowerCase();
  if ((IMAGE_MEDIA_TYPES as readonly string[]).includes(lowered)) {
    return lowered as ImageMediaType;
  }
  // Fallback: PNG is the most forgiving default. Validation upstream
  // (attachmentStaging / PWA `pasteToAttachments`) rejects unknown image
  // mimes, so this branch is mainly belt-and-braces.
  return 'image/png';
}

function decodeBase64Utf8(b64: string): string {
  // Node-only: agent always runs on Node, no browser fallback needed.
  return Buffer.from(b64, 'base64').toString('utf8');
}
