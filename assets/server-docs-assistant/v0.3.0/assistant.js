const DEFAULT_CONTEXT_ROUNDS = 4;
const MAX_CONTEXT_ROUNDS = 10;

export function normalizeContextRounds(value) {
  const rounds = value ?? DEFAULT_CONTEXT_ROUNDS;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_CONTEXT_ROUNDS) {
    throw new RangeError("context rounds must be between 1 and 10");
  }
  return rounds;
}

export function createConversationState(initialContextRounds = DEFAULT_CONTEXT_ROUNDS) {
  let contextRounds = normalizeContextRounds(initialContextRounds);
  let locked = false;
  return {
    get contextRounds() {
      return contextRounds;
    },
    get locked() {
      return locked;
    },
    setContextRounds(value) {
      if (locked) {
        throw new Error("start a new conversation before changing context rounds");
      }
      contextRounds = normalizeContextRounds(value);
    },
    lock() {
      locked = true;
    },
    reset() {
      locked = false;
    },
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeSourceIdPrefix(value) {
  const prefix = String(value || "sda-source").replace(/[^A-Za-z0-9_-]/g, "-");
  return prefix || "sda-source";
}

function renderInlineMarkdown(value, sourceIdPrefix = "sda-source") {
  const source = String(value ?? "");
  const prefix = normalizeSourceIdPrefix(sourceIdPrefix);
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[E(\d+)\])/g;
  let rendered = "";
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    rendered += escapeHtml(source.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      rendered += `<code>${escapeHtml(token.slice(1, -1))}</code>`;
    } else if (token.startsWith("**")) {
      rendered += `<strong>${escapeHtml(token.slice(2, -2))}</strong>`;
    } else {
      const number = Number(match[2]);
      rendered += `<a class="sda-evidence-ref" href="#${prefix}-${number}" aria-label="来源 ${number}">[${number}]</a>`;
    }
    cursor = match.index + token.length;
  }
  return rendered + escapeHtml(source.slice(cursor));
}

export function renderMarkdown(value, { sourceIdPrefix = "sda-source" } = {}) {
  const lines = String(value ?? "").replaceAll("\r\n", "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let listType = null;
  let listItems = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(`<p>${paragraph.map((item) => renderInlineMarkdown(item, sourceIdPrefix)).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!listType) return;
    const items = listItems
      .map((item) => `<li>${renderInlineMarkdown(item, sourceIdPrefix)}</li>`)
      .join("");
    blocks.push(`<${listType}>${items}</${listType}>`);
    listType = null;
    listItems = [];
  };
  const flushText = () => {
    flushParagraph();
    flushList();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^```\s*([A-Za-z0-9_-]*)\s*$/);
    if (fence) {
      flushText();
      const code = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      const language = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : "";
      blocks.push(
        `<div class="sda-code-block"><button type="button" class="sda-copy-button" data-sda-copy>复制</button>`
        + `<pre><code${language}>${escapeHtml(code.join("\n"))}</code></pre></div>`,
      );
      continue;
    }
    if (!line.trim()) {
      flushText();
      continue;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    if (ordered || unordered) {
      flushParagraph();
      const nextType = ordered ? "ol" : "ul";
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      listItems.push((ordered || unordered)[1]);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushText();
      const level = Math.min(6, heading[1].length + 2);
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2], sourceIdPrefix)}</h${level}>`);
      continue;
    }
    const quote = line.match(/^>\s?(.+)$/);
    if (quote) {
      flushText();
      blocks.push(`<blockquote>${renderInlineMarkdown(quote[1], sourceIdPrefix)}</blockquote>`);
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushText();
  return blocks.join("");
}

export function renderCitations(citations = [], { sourceIdPrefix = "sda-source" } = {}) {
  if (!citations.length) return "";
  const prefix = normalizeSourceIdPrefix(sourceIdPrefix);
  const items = citations
    .map((citation, index) => {
      const title = escapeHtml(citation.document_title || citation.relative_path || "文档");
      const heading = escapeHtml((citation.heading_path || []).join(" › "));
      const revision = escapeHtml(citation.source_revision || "unknown");
      const url = escapeHtml(citation.url || "#");
      return `<li id="${prefix}-${index + 1}"><a href="${url}">${title}: ${heading}</a> <code>${revision}</code></li>`;
    })
    .join("");
  return `<section class="sda-citations" aria-label="来源"><details><summary>来源（${citations.length}）</summary><ol>${items}</ol></details></section>`;
}

export function renderAnswerResult(result, { sourceIdPrefix = "sda-source" } = {}) {
  const notices = [];
  if (result.mode === "no_evidence") {
    notices.push('<p class="sda-boundary">文档依据不足，系统不会补造具体事实。</p>');
  }
  if (result.degraded) {
    notices.push('<p class="sda-degraded">生成服务已降级。</p>');
  }
  if (result.risk_warning) {
    notices.push(`<p class="sda-risk">${escapeHtml(result.risk_warning)}</p>`);
  }
  const feedback = result.answer_id
    ? `<div class="sda-feedback" data-answer-id="${escapeHtml(result.answer_id)}" aria-label="答案反馈">
        <span>这个回答有帮助吗？</span>
        <button type="button" data-rating="helpful">有帮助</button>
        <button type="button" data-rating="not_helpful">没帮助</button>
      </div>`
    : "";
  return `${notices.join("")}<div class="sda-answer">${renderMarkdown(result.answer || "", { sourceIdPrefix })}</div>${renderCitations(result.citations, { sourceIdPrefix })}${feedback}`;
}

export function renderUserMessage(value) {
  const content = escapeHtml(String(value ?? "")).replaceAll("\n", "<br>");
  return `<article class="sda-message sda-message-user">
    <div class="sda-message-label">你</div>
    <div class="sda-message-content"><p>${content}</p></div>
  </article>`;
}

function formatLatency(value) {
  const milliseconds = Math.max(0, Number(value) || 0);
  if (milliseconds < 1000) return `${Math.round(milliseconds)} 毫秒`;
  return `${(milliseconds / 1000).toFixed(1)} 秒`;
}

export function renderAssistantMessage(result, messageKey = "turn") {
  const key = normalizeSourceIdPrefix(messageKey);
  const rounds = Math.max(0, Number(result.context_rounds_used) || 0);
  const contextSummary = rounds
    ? `已参考最近 ${rounds} 轮`
    : "本轮未使用历史上下文";
  return `<article class="sda-message sda-message-assistant">
    <div class="sda-message-label">文档助手</div>
    <div class="sda-message-content">${renderAnswerResult(result, { sourceIdPrefix: `${key}-source` })}</div>
    <div class="sda-message-meta">${contextSummary} · ${formatLatency(result.latency_ms)}</div>
  </article>`;
}

export function createAssistantClient({ apiBaseUrl, fetchImpl = globalThis.fetch }) {
  if (!apiBaseUrl || typeof fetchImpl !== "function") {
    throw new TypeError("apiBaseUrl and fetch implementation are required");
  }
  let sessionId = null;
  return {
    get sessionId() {
      return sessionId;
    },
    resetSession() {
      sessionId = null;
    },
    async ask(question, { contextRounds } = {}) {
      const normalizedQuestion = String(question || "").trim();
      if (!normalizedQuestion || normalizedQuestion.length > 2000) {
        throw new RangeError("question must contain between 1 and 2000 characters");
      }
      const payload = {
        question: normalizedQuestion,
        context_rounds: normalizeContextRounds(contextRounds),
      };
      if (sessionId) payload.session_id = sessionId;
      const response = await fetchImpl(`${apiBaseUrl.replace(/\/$/, "")}/v1/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.detail || `request failed (${response.status})`);
      }
      if (body.session_id) sessionId = body.session_id;
      return body;
    },
    async feedback(answerId, rating, comment = null) {
      if (!sessionId) throw new Error("feedback requires an active anonymous session");
      if (!answerId || !["helpful", "not_helpful"].includes(rating)) {
        throw new RangeError("answer id and valid rating are required");
      }
      const payload = { session_id: sessionId, answer_id: answerId, rating };
      if (comment) payload.comment = String(comment).slice(0, 1000);
      const response = await fetchImpl(`${apiBaseUrl.replace(/\/$/, "")}/v1/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        let body = {};
        try { body = await response.json(); } catch { /* no response body */ }
        throw new Error(body.detail || `request failed (${response.status})`);
      }
    },
  };
}

function appendHtmlElement(container, html) {
  container.insertAdjacentHTML("beforeend", html.trim());
  return container.lastElementChild;
}

function renderPendingMessage() {
  return `<article class="sda-message sda-message-assistant sda-message-pending" aria-label="文档助手正在回答">
    <div class="sda-message-label">文档助手</div>
    <div class="sda-message-content"><span>正在检索文档</span><span class="sda-typing-dots" aria-hidden="true"><i></i><i></i><i></i></span></div>
  </article>`;
}

function renderErrorMessage(error) {
  const message = error instanceof Error ? error.message : "请求失败，请稍后重试。";
  return `<article class="sda-message sda-message-assistant sda-message-error" role="alert">
    <div class="sda-message-label">文档助手</div>
    <div class="sda-message-content"><p>${escapeHtml(message)}</p></div>
  </article>`;
}

function renderEmptyConversation() {
  return `<div class="sda-empty">
    <strong>可以连续追问服务器文档</strong>
    <span>例如先问“怎么提交 Slurm 作业？”，再问“那怎么取消？”</span>
  </div>`;
}

function bindAnswerControls(container, client) {
  for (const copyButton of container.querySelectorAll("[data-sda-copy]")) {
    copyButton.addEventListener("click", async () => {
      const code = copyButton.closest(".sda-code-block")?.querySelector("code")?.textContent || "";
      if (!globalThis.navigator?.clipboard?.writeText) {
        copyButton.textContent = "请手动复制";
        return;
      }
      try {
        await globalThis.navigator.clipboard.writeText(code);
        copyButton.textContent = "已复制";
      } catch {
        copyButton.textContent = "复制失败";
      }
    });
  }
  for (const feedbackButton of container.querySelectorAll(".sda-feedback button")) {
    feedbackButton.addEventListener("click", async () => {
      const group = feedbackButton.closest(".sda-feedback");
      if (!group) return;
      for (const item of group.querySelectorAll("button")) item.disabled = true;
      try {
        await client.feedback(group.dataset.answerId, feedbackButton.dataset.rating);
        group.textContent = "感谢反馈。";
      } catch (error) {
        group.textContent = error instanceof Error ? error.message : "反馈提交失败";
      }
    });
  }
}

export function mountAssistant({ apiBaseUrl, target = document.body, contextRounds = 4 }) {
  const client = createAssistantClient({ apiBaseUrl });
  const conversation = createConversationState(contextRounds);
  const root = document.createElement("aside");
  root.className = "sda-widget";
  root.setAttribute("aria-label", "服务器文档助手");
  const roundOptions = Array.from({ length: MAX_CONTEXT_ROUNDS }, (_, index) => {
    const value = index + 1;
    const selected = value === conversation.contextRounds ? " selected" : "";
    return `<option value="${value}"${selected}>${value} 轮</option>`;
  }).join("");
  root.innerHTML = `
    <details>
      <summary><span>文档助手</span><small>连续对话</small></summary>
      <div class="sda-panel">
        <div class="sda-toolbar">
          <label for="sda-context-rounds">记忆轮数</label>
          <select id="sda-context-rounds">${roundOptions}</select>
          <button type="button" class="sda-new-conversation" data-sda-new>新对话</button>
        </div>
        <p class="sda-context-note"></p>
        <p class="sda-warning">请勿提交密码、令牌、私钥、个人数据或其他敏感信息。</p>
        <div class="sda-messages" role="log" aria-live="polite" aria-relevant="additions">
          ${renderEmptyConversation()}
        </div>
        <form class="sda-composer">
          <label class="sda-visually-hidden" for="sda-question">询问当前服务器文档</label>
          <textarea id="sda-question" maxlength="2000" rows="3" required placeholder="输入问题，Enter 发送，Shift+Enter 换行"></textarea>
          <div class="sda-composer-actions">
            <span class="sda-character-count" aria-live="off">0 / 2000</span>
            <button type="submit" class="sda-send">发送</button>
          </div>
        </form>
      </div>
    </details>`;
  const form = root.querySelector("form");
  const question = root.querySelector("textarea");
  const messages = root.querySelector(".sda-messages");
  const sendButton = root.querySelector(".sda-send");
  const newConversationButton = root.querySelector("[data-sda-new]");
  const contextSelect = root.querySelector("#sda-context-rounds");
  const contextNote = root.querySelector(".sda-context-note");
  const characterCount = root.querySelector(".sda-character-count");
  let busy = false;
  let turnNumber = 0;

  const updateControls = () => {
    contextSelect.disabled = busy || conversation.locked;
    newConversationButton.disabled = busy;
    sendButton.disabled = busy;
    contextNote.textContent = `本次对话最多参考最近 ${conversation.contextRounds} 轮。匿名历史经脱敏后保存在服务端；新对话不会删除旧历史。`;
  };
  const scrollToLatest = () => {
    messages.scrollTop = messages.scrollHeight;
  };

  contextSelect.addEventListener("change", () => {
    conversation.setContextRounds(Number(contextSelect.value));
    updateControls();
  });
  newConversationButton.addEventListener("click", () => {
    client.resetSession();
    conversation.reset();
    turnNumber = 0;
    contextSelect.disabled = false;
    messages.innerHTML = renderEmptyConversation();
    question.value = "";
    characterCount.textContent = "0 / 2000";
    updateControls();
    question.focus();
  });
  question.addEventListener("input", () => {
    characterCount.textContent = `${question.value.length} / 2000`;
  });
  question.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!busy) form.requestSubmit();
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const askedQuestion = question.value.trim();
    if (!askedQuestion || busy) return;
    const startedWithSession = Boolean(client.sessionId);
    busy = true;
    conversation.lock();
    updateControls();
    messages.querySelector(".sda-empty")?.remove();
    appendHtmlElement(messages, renderUserMessage(askedQuestion));
    const pending = appendHtmlElement(messages, renderPendingMessage());
    turnNumber += 1;
    question.value = "";
    characterCount.textContent = "0 / 2000";
    scrollToLatest();
    try {
      const result = await client.ask(askedQuestion, {
        contextRounds: conversation.contextRounds,
      });
      const answer = appendHtmlElement(
        messages,
        renderAssistantMessage(result, `sda-turn-${turnNumber}`),
      );
      pending.remove();
      bindAnswerControls(answer, client);
    } catch (error) {
      const failure = appendHtmlElement(messages, renderErrorMessage(error));
      pending.remove();
      if (!startedWithSession && !client.sessionId) conversation.reset();
      failure.focus?.();
    } finally {
      busy = false;
      updateControls();
      scrollToLatest();
      question.focus();
    }
  });
  updateControls();
  target.append(root);
  return root;
}
