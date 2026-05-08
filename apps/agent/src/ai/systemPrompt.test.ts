// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { SANDBOX_BASH_TOOL, UPDATE_SESSION_STATUS_TOOL } from './sandboxMcp.js';
import { buildSystemPrompt } from './systemPrompt.js';

describe('buildSystemPrompt', () => {
  it('uses Claude-specific direct MCP wording', () => {
    const prompt = buildSystemPrompt('claude-code');
    expect(prompt).toContain(`prefer \`${SANDBOX_BASH_TOOL}\` over Bash`);
    expect(prompt).toContain(`The session status tool name is \`${UPDATE_SESSION_STATUS_TOOL}\`.`);
  });

  it('uses Codex-specific availability-aware MCP wording', () => {
    const prompt = buildSystemPrompt('codex');
    expect(prompt).toContain(`prefer the \`${SANDBOX_BASH_TOOL}\` MCP tool when it is available`);
    expect(prompt).toContain(`The session status tool name is \`${UPDATE_SESSION_STATUS_TOOL}\`.`);
  });

  it('appends caller-provided instructions', () => {
    expect(buildSystemPrompt('codex', 'extra instruction')).toContain('\n\nextra instruction');
  });

  it('instructs every agent to add the Quicksave AI commit trailer alongside the platform default', () => {
    for (const agent of ['claude-code', 'codex'] as const) {
      const prompt = buildSystemPrompt(agent);
      expect(prompt).toContain('Co-Authored-By: Quicksave AI');
      expect(prompt).toContain('alongside');
      expect(prompt).toContain('in addition to');
    }
  });
});
