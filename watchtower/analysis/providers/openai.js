// Local/self-hosted servers (Ollama, LM Studio, vLLM, ...) commonly need no
// API key at all. Exported so config.js can compute "is this provider usable"
// without duplicating the pattern.
function isLocalUrl(url) {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0|\.local(?::|\/|$)/i.test(url || '');
}

// Wraps any OpenAI-compatible Chat Completions endpoint behind the same
// `complete()` interface as the Anthropic provider. Raw fetch, no SDK
// dependency — this is deliberately "OpenAI-compatible" rather than
// "OpenAI-only" so a single provider covers OpenAI itself, Azure OpenAI
// (via baseUrl), and self-hosted/local servers that speak the same wire
// protocol (Ollama, LM Studio, vLLM, Groq, OpenRouter, together.ai, ...).
function createOpenAIProvider({ apiKey, baseUrl, timeoutMs }) {
  const url = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const isLocal = isLocalUrl(url);

  return {
    name: 'openai',
    available: () => Boolean(apiKey) || isLocal,

    // { model, maxTokens, system, prompt, images?: [{mediaType, base64}], schema? }
    // -> { text, usage, stopReason }
    async complete({ model, maxTokens, system, prompt, images, schema }) {
      if (!apiKey && !isLocal) throw new Error('OpenAI provider unavailable (missing OPENAI_API_KEY)');

      let userContent = prompt;
      if (images && images.length) {
        userContent = [];
        for (const img of images) {
          if (img.caption) userContent.push({ type: 'text', text: img.caption });
          userContent.push({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.base64}` } });
        }
        userContent.push({ type: 'text', text: prompt });
      }

      const body = {
        model,
        max_tokens: maxTokens,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: userContent },
        ],
        ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: 'response', strict: true, schema } } } : {}),
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${url}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error((data.error && data.error.message) || `provider responded ${res.status}`);
        }
        const choice = (data.choices || [])[0];
        const text = (choice && choice.message && choice.message.content) || '';
        return { text, usage: data.usage, stopReason: choice && choice.finish_reason };
      } catch (e) {
        if (e.name === 'AbortError') throw new Error(`request timed out after ${timeoutMs}ms`);
        throw e;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

module.exports = { createOpenAIProvider, isLocalUrl };
