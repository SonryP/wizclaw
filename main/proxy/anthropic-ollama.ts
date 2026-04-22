/**
 * Anthropic ↔ Ollama translation proxy.
 *
 * The source below is a standalone CommonJS Node script (uses `require`,
 * `module.exports` semantics via bare top-level code). It's exported as a
 * string constant so the main process can write it to disk next to
 * `win-hide-patch.cjs` inside NanoClaw's working dir and spawn it as a child
 * process, mirroring the WIN_HIDE_PATCH pattern in ipc-handlers.ts.
 *
 * Why a string and not a compiled-in-place TS module:
 *   - The proxy runs as a separate `node` child process, not inside Electron.
 *   - It lives alongside `win-hide-patch.cjs` in NanoClaw's dir so the
 *     `--require ./win-hide-patch.cjs` flag resolves locally on Windows.
 *   - Using `.cjs` forces CommonJS regardless of what NanoClaw's package.json
 *     says about module type, same reason the existing hide-patch is `.cjs`.
 *
 * Scope (experimental subset):
 *   - POST /v1/messages   — translates to Ollama /api/chat
 *   - Flattens Anthropic `system` into a system-role message at index 0
 *   - Translates `tools[]` (field renames only; both use JSON Schema)
 *   - Streams responses as Anthropic SSE, synthesized from Ollama's NDJSON
 *   - Drops thinking blocks, vision content, computer-use tools with a warn
 *   - Ignores the Anthropic model name from the request; uses OLLAMA_MODEL env
 *
 * Env:
 *   PROXY_PORT     — listen port (default 11435)
 *   OLLAMA_HOST    — ollama daemon host (default 127.0.0.1)
 *   OLLAMA_PORT    — ollama daemon port (default 11434)
 *   OLLAMA_MODEL   — model tag to always use (e.g. qwen2.5-coder:7b)
 */
export const PROXY_SOURCE = `/* Auto-written by WizClaw. Do not edit directly — source lives in
 * wizclaw/main/proxy/anthropic-ollama.ts (PROXY_SOURCE).
 */
'use strict';

const http = require('http');

const PROXY_PORT = parseInt(process.env.PROXY_PORT || '11435', 10);
const OLLAMA_HOST = process.env.OLLAMA_HOST || '127.0.0.1';
const OLLAMA_PORT = parseInt(process.env.OLLAMA_PORT || '11434', 10);
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b';

function log(level, msg) {
  const line = \`[\${new Date().toISOString()}] [\${level}] \${msg}\\n\`;
  (level === 'ERROR' ? process.stderr : process.stdout).write(line);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function randomId(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 14);
}

/**
 * Small local models often emit tool calls as raw JSON text in
 * message.content instead of using Ollama's structured tool_calls field.
 * Detect that shape and recover it as proper Anthropic tool_use blocks.
 *
 * Handles both single-call objects and arrays of calls. Recognizes both
 * OpenAI-style { name, arguments } and Anthropic-style { name, input }.
 * Strips surrounding markdown fences and prose if present.
 */
function extractToolCallsFromText(text) {
  if (!text || typeof text !== 'string') return null;
  // Strip code fences (\`\`\`json ... \`\`\` or bare \`\`\`)
  let s = text.trim();
  const fence = s.match(/^\`\`\`(?:json)?\\s*([\\s\\S]*?)\\s*\`\`\`$/);
  if (fence) s = fence[1].trim();

  // Format A: bare "tool_name {json...}" — many local models output this.
  // Search anywhere in the text (not just anchored), tolerate leading prose.
  const bareRe = /([A-Za-z_][\\w-]*)\\s*(\\{[\\s\\S]*?\\})/g;
  const bareCalls = [];
  let m;
  while ((m = bareRe.exec(s)) !== null) {
    // Try progressively longer JSON candidates from this start position to
    // find the shortest balanced one that parses.
    const startIdx = s.indexOf('{', m.index);
    if (startIdx === -1) continue;
    let depth = 0;
    let endIdx = -1;
    for (let i = startIdx; i < s.length; i += 1) {
      const ch = s[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) { endIdx = i; break; }
      }
    }
    if (endIdx === -1) continue;
    const jsonStr = s.slice(startIdx, endIdx + 1);
    let bareInput;
    try {
      bareInput = JSON.parse(jsonStr);
    } catch {
      continue;
    }
    if (bareInput && typeof bareInput === 'object' && !Array.isArray(bareInput)) {
      // Skip if the object itself looks like a structured call (has "name").
      if (typeof bareInput.name === 'string' && (bareInput.input !== undefined || bareInput.arguments !== undefined || bareInput.parameters !== undefined)) {
        continue;
      }
      bareCalls.push({ name: m[1], input: bareInput });
    }
    bareRe.lastIndex = endIdx + 1;
  }
  if (bareCalls.length) {
    log('INFO', 'Bare-format recovery matched ' + bareCalls.length + ' call(s)');
    return bareCalls;
  } else {
    log('INFO', 'Recovery: no bare match in ' + s.length + ' chars (preview: ' + s.slice(0, 200).replace(/\\n/g, ' ') + ')');
  }

  // Format B: structured JSON { name, input/arguments/parameters }
  // Find the first { and last } — tolerate prose around the JSON
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  const candidate = s.slice(first, last + 1);
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const calls = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.name !== 'string') continue;
    // Accept Anthropic's "input", OpenAI's "arguments", and the
    // "parameters" variant some models emit.
    const args =
      item.input !== undefined
        ? item.input
        : item.arguments !== undefined
          ? item.arguments
          : item.parameters;
    if (args === undefined) continue;
    // Some models double-encode the args as a JSON string.
    let normalized = args;
    if (typeof args === 'string') {
      try {
        normalized = JSON.parse(args);
      } catch {
        normalized = { _raw: args };
      }
    }
    calls.push({ name: item.name, input: normalized });
  }
  return calls.length ? calls : null;
}

/**
 * Flatten an Anthropic content block (string or array) into plain text for
 * Ollama's message.content. Drop non-text blocks with a warning.
 */
function flattenAnthropicContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'tool_use') {
      // Preserve as JSON so the model can see what it did previously.
      parts.push(
        '[tool_use ' +
          (block.name || '?') +
          ' ' +
          JSON.stringify(block.input || {}) +
          ']',
      );
    } else if (block.type === 'tool_result') {
      const inner =
        typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content);
      parts.push('[tool_result ' + (block.tool_use_id || '?') + ' ' + inner + ']');
    } else if (block.type === 'thinking') {
      log('WARN', 'Dropping Anthropic thinking block (unsupported by proxy)');
    } else if (block.type === 'image') {
      log('WARN', 'Dropping Anthropic image block (unsupported by proxy)');
    } else {
      log('WARN', 'Dropping unknown content block type: ' + block.type);
    }
  }
  return parts.join('\\n');
}

/**
 * Translate an Anthropic /v1/messages request body into an Ollama /api/chat
 * request body.
 */
// Extra guidance injected into the system prompt for local models. Real
// Claude naturally uses tools when they're offered; local models often
// reply in plain text instead, which means NanoClaw never gets a
// send_message call and the reply never reaches the user's channel.
const LOCAL_MODEL_SYSTEM_NUDGE = [
  '',
  'IMPORTANT: You are running in an agent environment. You MUST use the',
  'available tools to respond — do NOT reply with plain text, because',
  'plain-text responses will not be delivered to the user. In particular,',
  'when you want to send a message, call the mcp__nanoclaw__send_message',
  'tool (or an equivalent send/reply tool listed in your tools). Only end',
  'your turn after you have invoked at least one tool.',
].join('\\n');

function anthropicToOllama(req) {
  const messages = [];
  if (req.system) {
    const sysText =
      typeof req.system === 'string'
        ? req.system
        : flattenAnthropicContent(req.system);
    if (sysText) {
      messages.push({
        role: 'system',
        content: sysText + LOCAL_MODEL_SYSTEM_NUDGE,
      });
    }
  } else if (Array.isArray(req.tools) && req.tools.length) {
    // No system prompt from caller but tools are offered — inject the nudge
    // so the model still understands it must use them.
    messages.push({ role: 'system', content: LOCAL_MODEL_SYSTEM_NUDGE.trim() });
  }
  if (Array.isArray(req.messages)) {
    for (const m of req.messages) {
      if (!m || typeof m !== 'object') continue;
      messages.push({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: flattenAnthropicContent(m.content),
      });
    }
  }

  const body = {
    model: OLLAMA_MODEL,
    messages,
    stream: !!req.stream,
    options: {},
  };
  // Pin low temperature by default — local models are chatty at default
  // temps and the agent loop amplifies the verbosity. Caller can still
  // override via the Anthropic request.
  body.options.temperature = typeof req.temperature === 'number' ? req.temperature : 0.1;
  if (typeof req.top_p === 'number') body.options.top_p = req.top_p;
  // Clamp num_predict so each turn stops sooner. Anthropic \`max_tokens\` is
  // per-call; we cap it at 1024 for local inference to reduce runaway loops.
  const maxTokens = typeof req.max_tokens === 'number' ? Math.min(req.max_tokens, 1024) : 1024;
  body.options.num_predict = maxTokens;

  if (Array.isArray(req.tools) && req.tools.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
  }

  return body;
}

/**
 * Make an HTTP request to the local Ollama daemon. Returns an IncomingMessage
 * stream — caller is responsible for consuming it.
 */
function callOllama(payload) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(payload);
    const r = http.request(
      {
        hostname: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: '/api/chat',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(json),
        },
      },
      resolve,
    );
    r.on('error', reject);
    r.write(json);
    r.end();
  });
}

async function handleNonStreaming(req, res, anthropicReq) {
  const ollamaReq = anthropicToOllama({ ...anthropicReq, stream: false });
  let upstream;
  try {
    upstream = await callOllama(ollamaReq);
  } catch (err) {
    log('ERROR', 'Ollama connection failed: ' + err.message);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: 'Ollama daemon not reachable: ' + err.message },
      }),
    );
    return;
  }

  const upstreamStatus = upstream.statusCode || 0;
  const chunks = [];
  upstream.on('data', (c) => chunks.push(c));
  upstream.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    if (upstreamStatus >= 400) {
      log('ERROR', 'Ollama returned ' + upstreamStatus + ': ' + body.slice(0, 500));
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      log('ERROR', 'Non-JSON from Ollama: ' + body.slice(0, 200));
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Bad Ollama response' } }));
      return;
    }
    if (parsed.error) {
      log('ERROR', 'Ollama error payload: ' + parsed.error);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Ollama: ' + parsed.error } }));
      return;
    }
    const msgContent = parsed.message && parsed.message.content ? parsed.message.content : '';
    const toolCalls =
      parsed.message && Array.isArray(parsed.message.tool_calls)
        ? parsed.message.tool_calls
        : [];

    const contentBlocks = [];
    // Fallback: if Ollama returned no structured tool_calls but the text
    // looks like tool-call JSON, recover it.
    const recovered = toolCalls.length ? null : extractToolCallsFromText(msgContent);
    if (recovered) {
      log('INFO', 'Recovered ' + recovered.length + ' tool call(s) from text content');
      for (const c of recovered) {
        contentBlocks.push({
          type: 'tool_use',
          id: randomId('toolu'),
          name: c.name,
          input: c.input,
        });
      }
    } else if (msgContent) {
      contentBlocks.push({ type: 'text', text: msgContent });
    }
    for (const tc of toolCalls) {
      contentBlocks.push({
        type: 'tool_use',
        id: randomId('toolu'),
        name: tc.function && tc.function.name ? tc.function.name : 'unknown',
        input: tc.function && tc.function.arguments ? tc.function.arguments : {},
      });
    }

    const response = {
      id: randomId('msg'),
      type: 'message',
      role: 'assistant',
      // Always echo a Claude-shaped model name back. The SDK validates the
// response model against its known list and synthesizes a "model may not
// exist" error if it sees something unexpected (e.g. "qwen2.5-coder:7b").
model: (typeof anthropicReq.model === 'string' && anthropicReq.model.startsWith('claude-'))
  ? anthropicReq.model
  : 'claude-sonnet-4-5-20250929',
      content: contentBlocks.length ? contentBlocks : [{ type: 'text', text: '' }],
      stop_reason: (toolCalls.length || (recovered && recovered.length)) ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: parsed.prompt_eval_count || 0,
        output_tokens: parsed.eval_count || 0,
      },
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  upstream.on('error', (err) => {
    log('ERROR', 'Upstream stream error: ' + err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
    }
    res.end();
  });
}

/**
 * Stream an Anthropic-flavored SSE response by consuming Ollama's NDJSON.
 */
async function handleStreaming(req, res, anthropicReq) {
  const ollamaReq = anthropicToOllama({ ...anthropicReq, stream: true });
  let upstream;
  try {
    upstream = await callOllama(ollamaReq);
  } catch (err) {
    log('ERROR', 'Ollama connection failed: ' + err.message);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: 'Ollama daemon not reachable: ' + err.message },
      }),
    );
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const msgId = randomId('msg');
  const sendEvent = (type, data) => {
    res.write('event: ' + type + '\\n');
    res.write('data: ' + JSON.stringify({ type, ...data }) + '\\n\\n');
  };

  sendEvent('message_start', {
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      // Always echo a Claude-shaped model name back. The SDK validates the
// response model against its known list and synthesizes a "model may not
// exist" error if it sees something unexpected (e.g. "qwen2.5-coder:7b").
model: (typeof anthropicReq.model === 'string' && anthropicReq.model.startsWith('claude-'))
  ? anthropicReq.model
  : 'claude-sonnet-4-5-20250929',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  // Buffer all text instead of streaming deltas live. Local models often
  // emit tool calls as JSON in the text stream and we can only detect that
  // shape after seeing the full content. Latency cost is acceptable since
  // local inference is slow anyway.
  let buffer = '';
  let textBuf = '';
  let nativeToolCalls = [];
  let totalIn = 0;
  let totalOut = 0;

  upstream.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        log('WARN', 'Skipping non-JSON line: ' + trimmed.slice(0, 120));
        continue;
      }
      if (obj.message && typeof obj.message.content === 'string' && obj.message.content) {
        textBuf += obj.message.content;
      }
      if (obj.message && Array.isArray(obj.message.tool_calls) && obj.message.tool_calls.length) {
        nativeToolCalls = nativeToolCalls.concat(obj.message.tool_calls);
      }
      if (obj.prompt_eval_count) totalIn = obj.prompt_eval_count;
      if (obj.eval_count) totalOut = obj.eval_count;
    }
  });

  upstream.on('end', () => {
    let stopReason = 'end_turn';
    let idx = 0;
    // Prefer Ollama's native tool_calls; fall back to JSON-in-text recovery.
    const recovered =
      nativeToolCalls.length === 0 ? extractToolCallsFromText(textBuf) : null;

    if (nativeToolCalls.length === 0 && (!recovered || recovered.length === 0) && textBuf) {
      // Plain text response.
      sendEvent('content_block_start', {
        index: idx,
        content_block: { type: 'text', text: '' },
      });
      sendEvent('content_block_delta', {
        index: idx,
        delta: { type: 'text_delta', text: textBuf },
      });
      sendEvent('content_block_stop', { index: idx });
      idx += 1;
    }

    if (nativeToolCalls.length) {
      stopReason = 'tool_use';
      for (const tc of nativeToolCalls) {
        const toolId = randomId('toolu');
        const name = tc.function && tc.function.name ? tc.function.name : 'unknown';
        const input = tc.function && tc.function.arguments ? tc.function.arguments : {};
        sendEvent('content_block_start', {
          index: idx,
          content_block: { type: 'tool_use', id: toolId, name: name, input: {} },
        });
        sendEvent('content_block_delta', {
          index: idx,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
        });
        sendEvent('content_block_stop', { index: idx });
        idx += 1;
      }
    } else if (recovered && recovered.length) {
      log('INFO', 'Recovered ' + recovered.length + ' tool call(s) from text stream');
      stopReason = 'tool_use';
      for (const c of recovered) {
        const toolId = randomId('toolu');
        sendEvent('content_block_start', {
          index: idx,
          content_block: { type: 'tool_use', id: toolId, name: c.name, input: {} },
        });
        sendEvent('content_block_delta', {
          index: idx,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) },
        });
        sendEvent('content_block_stop', { index: idx });
        idx += 1;
      }
    }

    sendEvent('message_delta', {
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: totalIn, output_tokens: totalOut },
    });
    sendEvent('message_stop', {});
    res.end();
  });

  upstream.on('error', (err) => {
    log('ERROR', 'Upstream stream error: ' + err.message);
    try {
      res.end();
    } catch {
      /* no-op */
    }
  });
}

const server = http.createServer(async (req, res) => {
  log('INFO', req.method + ' ' + req.url);
  // Health probe
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, model: OLLAMA_MODEL, port: PROXY_PORT }));
    return;
  }
  // Claude Code does a pre-flight model check against /v1/models/<name>.
  // Accept any model name and report it as available — we always route to
  // the configured Ollama model regardless of what was requested.
  if (req.method === 'GET' && req.url && req.url.startsWith('/v1/models')) {
    const parts = req.url.split('/').filter(Boolean); // ['v1','models'] or ['v1','models','<name>']
    if (parts.length === 2) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: [{
          type: 'model',
          id: 'claude-sonnet-4-6',
          display_name: 'Ollama (' + OLLAMA_MODEL + ')',
          created_at: new Date().toISOString(),
        }],
        has_more: false,
        first_id: 'claude-sonnet-4-6',
        last_id: 'claude-sonnet-4-6',
      }));
      return;
    }
    const modelId = decodeURIComponent(parts[2] || 'unknown');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      type: 'model',
      id: modelId,
      display_name: 'Ollama (' + OLLAMA_MODEL + ')',
      created_at: new Date().toISOString(),
    }));
    return;
  }
  // Claude Code also hits /v1/messages/count_tokens before streaming. Return
  // a rough estimate based on message char length — accurate enough that
  // Claude Code's context-window math doesn't reject the request.
  if (req.method === 'POST' && req.url && (req.url === '/v1/messages/count_tokens' || req.url.startsWith('/v1/messages/count_tokens?'))) {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Bad JSON: ' + err.message } }));
      return;
    }
    let chars = 0;
    if (typeof body.system === 'string') chars += body.system.length;
    else if (Array.isArray(body.system)) chars += flattenAnthropicContent(body.system).length;
    if (Array.isArray(body.messages)) {
      for (const m of body.messages) chars += flattenAnthropicContent(m && m.content).length;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ input_tokens: Math.ceil(chars / 4) }));
    return;
  }
  if (req.method === 'POST' && (req.url === '/v1/messages' || (req.url && req.url.startsWith('/v1/messages?')))) {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Bad JSON: ' + err.message },
        }),
      );
      return;
    }
    if (body.stream) {
      await handleStreaming(req, res, body);
    } else {
      await handleNonStreaming(req, res, body);
    }
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'not_found', message: 'Route not found' } }));
});

// Bind to loopback only. NanoClaw's container doesn't talk to us directly —
// it goes through NanoClaw's host-side credential proxy (port 3001), which
// runs on the host and can reach us on 127.0.0.1.
server.listen(PROXY_PORT, '127.0.0.1', () => {
  log('INFO', 'Anthropic→Ollama proxy listening on 127.0.0.1:' + PROXY_PORT);
  log('INFO', 'Forwarding to ' + OLLAMA_HOST + ':' + OLLAMA_PORT + ' model=' + OLLAMA_MODEL);
});

// Graceful shutdown so the parent can \`taskkill /PID\` without zombies.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('INFO', 'Received ' + sig + ', shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
`;
