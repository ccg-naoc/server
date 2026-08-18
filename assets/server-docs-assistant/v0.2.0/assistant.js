const DEFAULT_CONTEXT_ROUNDS = 4;
const MAX_CONTEXT_ROUNDS = 10;

export function normalizeContextRounds(value) {
  const rounds = value ?? DEFAULT_CONTEXT_ROUNDS;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_CONTEXT_ROUNDS) {
    throw new RangeError("context rounds must be between 1 and 10");
  }
  return rounds;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderInlineMarkdown(value) {
  const source = String(value ?? "");
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
      rendered += `<a class="sda-evidence-ref" href="#sda-source-${number}" aria-label="来源 ${number}">[${number}]</a>`;
    }
    cursor = match.index + token.length;
  }
  return rendered + escapeHtml(source.slice(cursor));
}

export function renderMarkdown(value) {
  const lines = String(value ?? "").replaceAll("\r\n", "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let listType = null;
  let listItems = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(`<p>${paragraph.map(renderInlineMarkdown).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!listType) return;
    const items = listItems.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("");
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
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const quote = line.match(/^>\s?(.+)$/);
    if (quote) {
      flushText();
      blocks.push(`<blockquote>${renderInlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushText();
  return blocks.join("");
}

export function renderCitations(citations = []) {
  if (!citations.length) return "";
  const items = citations
    .map((citation, index) => {
      const title = escapeHtml(citation.document_title || citation.relative_path || "文档");
      const heading = escapeHtml((citation.heading_path || []).join(" › "));
      const revision = escapeHtml(citation.source_revision || "unknown");
      const url = escapeHtml(citation.url || "#");
      return `<li id="sda-source-${index + 1}"><a href="${url}">${title}: ${heading}</a> <code>${revision}</code></li>`;
    })
    .join("");
  return `<section class="sda-citations" aria-label="来源"><h3>来源</h3><ol>${items}</ol></section>`;
}

export function renderAnswerResult(result) {
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
  return `${notices.join("")}<div class="sda-answer">${renderMarkdown(result.answer || "")}</div>${renderCitations(result.citations)}${feedback}`;
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

export function mountAssistant({ apiBaseUrl, target = document.body, contextRounds = 4 }) {
  const client = createAssistantClient({ apiBaseUrl });
  const root = document.createElement("aside");
  root.className = "sda-widget";
  root.setAttribute("aria-label", "服务器文档助手");
  root.innerHTML = `
    <details>
      <summary>文档助手</summary>
      <div class="sda-panel">
        <p class="sda-warning">请勿提交密码、令牌、私钥、个人数据或其他敏感信息。</p>
        <div class="sda-output" aria-live="polite"></div>
        <form>
          <label for="sda-question">询问当前服务器文档</label>
          <textarea id="sda-question" maxlength="2000" required></textarea>
          <button type="submit">提问</button>
        </form>
      </div>
    </details>`;
  const form = root.querySelector("form");
  const question = root.querySelector("textarea");
  const output = root.querySelector(".sda-output");
  const button = root.querySelector("button");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    output.textContent = "正在检索文档…";
    try {
      const result = await client.ask(question.value, { contextRounds });
      output.innerHTML = renderAnswerResult(result);
      for (const copyButton of output.querySelectorAll("[data-sda-copy]")) {
        copyButton.addEventListener("click", async () => {
          const code = copyButton.parentElement?.querySelector("code")?.textContent || "";
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
      for (const feedbackButton of output.querySelectorAll(".sda-feedback button")) {
        feedbackButton.addEventListener("click", async () => {
          const group = feedbackButton.closest(".sda-feedback");
          for (const item of group.querySelectorAll("button")) item.disabled = true;
          try {
            await client.feedback(group.dataset.answerId, feedbackButton.dataset.rating);
            group.textContent = "感谢反馈。";
          } catch (error) {
            group.textContent = error instanceof Error ? error.message : "反馈提交失败";
          }
        });
      }
      question.value = "";
    } catch (error) {
      output.textContent = error instanceof Error ? error.message : "请求失败";
    } finally {
      button.disabled = false;
    }
  });
  target.append(root);
  return root;
}
