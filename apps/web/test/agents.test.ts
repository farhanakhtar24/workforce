import test from 'node:test';
import assert from 'node:assert/strict';
import type { UIMessage } from 'ai';
import {
  AGENT_GUIDANCE,
  DEFAULT_AGENT,
  DEFAULT_MODE,
  WEB_AGENT_MODES,
  WEB_AGENT_SLUGS,
  backToChatUrl,
  buildChatUrl,
  buildNewChatUrl,
  childChatUrl,
  isAgentMode,
  isAgentSlug,
  isDefaultSelection,
  isPlanActionMeaningful,
  modeGuidance,
  modeLabel,
  parseAgentSelection,
} from '../src/lib/agents.js';
import { buildSendRequest, hydrationEndpoint, resumeStreamEndpoint, sendMessagesEndpoint } from '../src/lib/api.js';

/**
 * Pure agents/mode URL + request-contract tests (no live API, no network).
 * Pinned against apps/api/src/validation.ts (chatRequestSchema accepts exactly
 * `{ id, message }` + optional `mode: 'plan' | 'action'`) and the chat route
 * (transcripts are keyed (slug, chatId), so send/hydrate/resume MUST use the
 * selected slug).
 */

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function userMessage(id: string, text: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

test('roster + defaults match the API slug/mode vocabulary', () => {
  assert.deepEqual([...WEB_AGENT_SLUGS], ['general', 'orchestrator', 'analyst', 'researcher']);
  assert.deepEqual([...WEB_AGENT_MODES], ['plan', 'action']);
  assert.equal(DEFAULT_AGENT, 'general');
  assert.equal(DEFAULT_MODE, 'action');
  for (const slug of WEB_AGENT_SLUGS) assert.equal(isAgentSlug(slug), true);
  for (const mode of WEB_AGENT_MODES) assert.equal(isAgentMode(mode), true);
  assert.equal(isAgentSlug('orchestrator '), false);
  assert.equal(isAgentSlug('admin'), false);
  assert.equal(isAgentSlug(null), false);
  assert.equal(isAgentMode('PLAN'), false);
  assert.equal(isAgentMode(undefined), false);
});

test('parseAgentSelection: unknown/missing values fall back to general/action', () => {
  assert.deepEqual(parseAgentSelection({}), { agent: 'general', mode: 'action' });
  assert.deepEqual(parseAgentSelection({ agent: null, mode: null }), { agent: 'general', mode: 'action' });
  assert.deepEqual(parseAgentSelection({ agent: 'hacker', mode: 'PLAN' }), { agent: 'general', mode: 'action' });
  assert.deepEqual(parseAgentSelection({ agent: 'orchestrator', mode: 'plan' }), {
    agent: 'orchestrator',
    mode: 'plan',
  });
  // A valid agent with a garbage mode keeps the agent, defaults the mode.
  assert.deepEqual(parseAgentSelection({ agent: 'analyst', mode: 'nonsense' }), {
    agent: 'analyst',
    mode: 'action',
  });
});

test('buildChatUrl: canonical agent-scoped URLs; action/default omitted', () => {
  assert.equal(buildChatUrl(UUID), `/agents/general/chat/${UUID}`);
  assert.equal(buildChatUrl(UUID, { agent: 'general', mode: 'action' }), `/agents/general/chat/${UUID}`);
  assert.equal(buildChatUrl(UUID, { agent: 'orchestrator' }), `/agents/orchestrator/chat/${UUID}`);
  assert.equal(
    buildChatUrl(UUID, { agent: 'orchestrator', mode: 'plan' }),
    `/agents/orchestrator/chat/${UUID}?mode=plan`,
  );
  assert.equal(buildChatUrl(UUID, { agent: 'general', mode: 'plan' }), `/agents/general/chat/${UUID}?mode=plan`);
  // Unknown selection values are coerced to the defaults, never echoed.
  assert.equal(
    buildChatUrl('a_b-c', { agent: 'evil' as never, mode: 'steal' as never }),
    '/agents/general/chat/a_b-c',
  );
});

test('buildChatUrl: encodes unsafe chat ids but pages notFound on them', () => {
  assert.equal(buildChatUrl('../etc'), '/agents/general/chat/..%2Fetc');
  assert.equal(buildChatUrl('a b'), '/agents/general/chat/a%20b');
  assert.equal(buildChatUrl('chat/with slash'), '/agents/general/chat/chat%2Fwith%20slash');
});

test('buildNewChatUrl: "/" when default; selection travels as params', () => {
  assert.equal(buildNewChatUrl(), '/');
  assert.equal(buildNewChatUrl({ agent: 'general', mode: 'action' }), '/');
  assert.equal(buildNewChatUrl({ agent: 'orchestrator' }), '/?agent=orchestrator');
  assert.equal(buildNewChatUrl({ agent: 'orchestrator', mode: 'plan' }), '/?agent=orchestrator&mode=plan');
});

test('childChatUrl: worker children only, canonical form', () => {
  assert.equal(childChatUrl(UUID, 'analyst'), `/agents/analyst/chat/${UUID}`);
  assert.equal(childChatUrl(UUID, 'researcher'), `/agents/researcher/chat/${UUID}`);
  assert.equal(childChatUrl(UUID, 'orchestrator'), null);
  assert.equal(childChatUrl(UUID, 'general'), null);
  assert.equal(childChatUrl('not safe', 'analyst'), null);
});

test('backToChatUrl: explicit agent wins, default legacy target is general', () => {
  assert.equal(backToChatUrl('c1', 'orchestrator'), '/agents/orchestrator/chat/c1');
  assert.equal(backToChatUrl('c1', 'admin'), '/agents/general/chat/c1');
  assert.equal(backToChatUrl('c1', undefined), '/agents/general/chat/c1');
});

test('send/hydrate/resume use the selected slug; default stays general', () => {
  const base = 'http://localhost:3001';
  assert.equal(sendMessagesEndpoint(base, 'orchestrator'), `${base}/api/agents/orchestrator/chat`);
  assert.equal(sendMessagesEndpoint(base), `${base}/api/agents/general/chat`);
  assert.equal(hydrationEndpoint(base, 'c_1', 'analyst'), `${base}/api/agents/analyst/chat/c_1`);
  assert.equal(resumeStreamEndpoint(base, 'c_1', 'researcher'), `${base}/api/agents/researcher/chat/c_1/stream`);
  assert.equal(hydrationEndpoint(base, 'c_1'), `${base}/api/agents/general/chat/c_1`);
  assert.equal(resumeStreamEndpoint(base, 'c_1'), `${base}/api/agents/general/chat/c_1/stream`);
});

test('buildSendRequest: mode rides the documented body; idempotency header unchanged', () => {
  const messages = [userMessage('m-9', 'newest')];
  const withMode = buildSendRequest({
    apiBaseUrl: 'http://localhost:3001',
    chatId: 'chat-abc',
    messages,
    slug: 'orchestrator',
    mode: 'plan',
  });
  assert.equal(withMode.url, 'http://localhost:3001/api/agents/orchestrator/chat');
  assert.deepEqual(Object.keys(withMode.body).sort(), ['id', 'message', 'mode']);
  assert.deepEqual(withMode.body, {
    id: 'chat-abc',
    message: messages[0],
    mode: 'plan',
  });
  assert.deepEqual(withMode.headers, { 'Idempotency-Key': 'chat-abc:m-9' });

  const withoutMode = buildSendRequest({
    apiBaseUrl: 'http://localhost:3001',
    chatId: 'chat-abc',
    messages,
  });
  // Default: byte-compatible Phase 2 body (exactly { id, message }).
  assert.deepEqual(Object.keys(withoutMode.body).sort(), ['id', 'message']);
  assert.deepEqual(withoutMode.headers, { 'Idempotency-Key': 'chat-abc:m-9' });
});

test('mode selector semantics: plan guidance names only withheld tools; default action', () => {
  assert.equal(modeLabel('plan'), 'Plan');
  assert.equal(modeLabel('action'), 'Action');
  assert.equal(isPlanActionMeaningful('orchestrator'), true);
  assert.equal(isPlanActionMeaningful('general'), false);
  const planLine = modeGuidance({ agent: 'orchestrator', mode: 'plan' });
  assert.equal(planLine.includes('write_doc'), true);
  assert.equal(planLine.includes('delegate_task'), true);
  const actionLine = modeGuidance({ agent: 'analyst', mode: 'action' });
  assert.equal(actionLine.includes('full toolset'), true);
  // Workers note their fixed toolset under plan (writes/delegation never exist).
  const planWorker = modeGuidance({ agent: 'researcher', mode: 'plan' });
  assert.equal(planWorker.includes('no write or delegation tools'), true);
});

test('AGENT_GUIDANCE names only the tools each agent actually composes', () => {
  const guidance = AGENT_GUIDANCE;
  assert.equal(guidance['general'].includes('calculate'), true);
  for (const tool of ['write_doc', 'delegate_task', 'query_data', 'search_memory', 'ask_user']) {
    assert.equal(guidance['general'].includes(tool), false);
  }
  const orchestratorExpected = ['query_data', 'search_memory', 'write_doc', 'delegate_task', 'ask_user'];
  for (const tool of orchestratorExpected) {
    assert.equal(guidance['orchestrator'].includes(tool), true);
  }
  const analystExpected = ['query_data', 'search_memory', 'ask_user'];
  for (const tool of analystExpected) {
    assert.equal(guidance['analyst'].includes(tool), true);
  }
  assert.equal(guidance['analyst'].includes('write_doc'), false);
  assert.equal(guidance['analyst'].includes('delegate_task'), false);
  const researcherExpected = ['search_memory', 'ask_user'];
  for (const tool of researcherExpected) {
    assert.equal(guidance['researcher'].includes(tool), true);
  }
  assert.equal(guidance['researcher'].includes('query_data'), false);
  assert.equal(guidance['researcher'].includes('write_doc'), false);
  assert.equal(guidance['researcher'].includes('delegate_task'), false);
  assert.equal(Object.keys(guidance).length, WEB_AGENT_SLUGS.length);
});
