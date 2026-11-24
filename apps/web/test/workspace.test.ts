import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AGENT_LABELS,
  CHAT_SUGGESTIONS,
  WORKSPACE_NAV,
  WORKSPACE_NAV_IDS,
  activeWorkspaceNavId,
  agentLabel,
  chatSuggestions,
} from '../src/lib/workspace.js';
import { WEB_AGENT_SLUGS } from '../src/lib/agents.js';

describe('workspace navigation metadata', () => {
  it('covers every section id exactly once', () => {
    assert.deepEqual(
      WORKSPACE_NAV.map((item) => item.id),
      [...WORKSPACE_NAV_IDS],
    );
    const hrefs = new Set(WORKSPACE_NAV.map((item) => item.href));
    assert.equal(hrefs.size, WORKSPACE_NAV.length);
    for (const item of WORKSPACE_NAV) {
      assert.ok(item.label.length > 0, `${item.id} has a label`);
      assert.ok(item.prefixes.length > 0, `${item.id} has prefixes`);
    }
  });

  it('routes canonical and legacy chat URLs to the chat section', () => {
    assert.equal(activeWorkspaceNavId('/'), 'chat');
    // `/` is an exact-match prefix: other roots must not leak into chat.
    assert.equal(activeWorkspaceNavId('/memory'), 'memory');
    assert.equal(activeWorkspaceNavId('/agents/orchestrator/chat/abc?mode=plan'), 'chat');
    assert.equal(activeWorkspaceNavId('/agents/analyst/chat/52790846-b7b8-4520-8def-23aacf5a96f8'), 'chat');
    assert.equal(activeWorkspaceNavId('/chat/legacy-id'), 'chat');
    assert.equal(activeWorkspaceNavId('/agents/'), 'chat');
  });

  it('routes every workspace surface and its detail pages', () => {
    assert.equal(activeWorkspaceNavId('/memory'), 'memory');
    assert.equal(activeWorkspaceNavId('/memory/'), 'memory');
    assert.equal(activeWorkspaceNavId('/work'), 'work');
    assert.equal(activeWorkspaceNavId('/work/doc-1'), 'work');
    assert.equal(activeWorkspaceNavId('/delegations'), 'delegations');
    assert.equal(activeWorkspaceNavId('/schedules'), 'schedules');
  });

  it('falls back to chat for unknown paths', () => {
    assert.equal(activeWorkspaceNavId('/totally-unknown'), 'chat');
    assert.equal(activeWorkspaceNavId(''), 'chat');
  });
});

describe('agent labels', () => {
  it('labels every servable agent', () => {
    for (const slug of WEB_AGENT_SLUGS) {
      assert.ok(AGENT_LABELS[slug] !== undefined, `${slug} is labeled`);
      assert.equal(agentLabel(slug), AGENT_LABELS[slug]);
    }
  });

  it('labels every servable agent without hardcoding the roster here', () => {
    assert.deepEqual(Object.keys(AGENT_LABELS).sort(), [...WEB_AGENT_SLUGS].sort());
  });

  it('falls back to the raw slug for unknown values', () => {
    assert.equal(agentLabel('mystery'), 'mystery');
  });
});

describe('chat empty-state suggestions', () => {
  it('offers 3–4 non-empty unique suggestions per servable agent', () => {
    for (const slug of WEB_AGENT_SLUGS) {
      const suggestions = chatSuggestions(slug);
      assert.ok(suggestions.length >= 3 && suggestions.length <= 4, `${slug} has 3–4 suggestions`);
      for (const suggestion of suggestions) {
        assert.ok(suggestion.trim().length > 0, `${slug} suggestions are non-empty`);
      }
      assert.equal(new Set(suggestions).size, suggestions.length, `${slug} suggestions are unique`);
    }
  });

  it('falls back to the general suggestions for unknown slugs', () => {
    assert.deepEqual(chatSuggestions('mystery'), CHAT_SUGGESTIONS.general);
  });

  it('stays honest to each agent toolset (no invented capabilities)', () => {
    // general only calculates: no memory/work/delegation vocabulary.
    for (const text of CHAT_SUGGESTIONS.general) {
      assert.ok(!/memory|document|delegate|query/i.test(text), `general suggestion stays calculation-only: ${text}`);
    }
    // researcher has no SQL: its suggestions never mention querying data.
    for (const text of CHAT_SUGGESTIONS.researcher) {
      assert.ok(!/query|data|document|delegate/i.test(text), `researcher suggestion stays memory-only: ${text}`);
    }
    // orchestrator suggestions reference its real tool verbs.
    const orchestratorText = CHAT_SUGGESTIONS.orchestrator.join(' ').toLowerCase();
    assert.ok(orchestratorText.includes('memory'));
    assert.ok(orchestratorText.includes('query'));
    assert.ok(orchestratorText.includes('document'));
    assert.ok(orchestratorText.includes('delegate'));
  });
});
