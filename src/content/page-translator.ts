import type { ExtensionMessage, PlainBatchTranslationResponse } from "../shared/messages";
import { safeRuntimeSendMessage } from "../shared/extension-context";

const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEXTAREA",
  "INPUT",
  "CODE",
  "PRE",
  "SVG",
  "MATH",
  "KBD",
  "SAMP"
]);

interface TextNodeJob {
  node: Text;
  original: string;
}

/**
 * In-place full-page translation: replaces visible text nodes with Chinese,
 * remembering originals so the page can be restored.
 */
export class PageTranslator {
  private readonly originals = new WeakMap<Text, string>();
  private translating = false;

  async translatePage(): Promise<{ ok: boolean; message: string }> {
    if (this.translating) {
      return { ok: false, message: "全页翻译进行中…" };
    }
    this.translating = true;
    try {
      const jobs = collectTextJobs(document.body);
      if (jobs.length === 0) {
        return { ok: false, message: "没有找到可翻译的文本。" };
      }

      const chunkSize = 40;
      let done = 0;
      for (let offset = 0; offset < jobs.length; offset += chunkSize) {
        const slice = jobs.slice(offset, offset + chunkSize);
        const response = await safeRuntimeSendMessage<PlainBatchTranslationResponse>({
          type: "TRANSLATE_PLAIN_BATCH",
          texts: slice.map((job) => job.original)
        } satisfies ExtensionMessage);
        if (!response?.ok || !response.texts) {
          return {
            ok: false,
            message: response?.error ?? "本机翻译失败。请确认 LibreTranslate 已启动。"
          };
        }
        for (let index = 0; index < slice.length; index += 1) {
          const job = slice[index];
          const translated = response.texts[index];
          if (!job || !translated || translated === job.original) {
            continue;
          }
          if (!this.originals.has(job.node)) {
            this.originals.set(job.node, job.original);
          }
          job.node.textContent = translated;
          done += 1;
        }
      }
      return { ok: true, message: `全页翻译完成（${done} 段）。` };
    } finally {
      this.translating = false;
    }
  }

  restorePage(): { ok: boolean; message: string } {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let restored = 0;
    let current = walker.nextNode();
    while (current) {
      const text = current as Text;
      const original = this.originals.get(text);
      if (original !== undefined) {
        text.textContent = original;
        this.originals.delete(text);
        restored += 1;
      }
      current = walker.nextNode();
    }
    return { ok: true, message: restored > 0 ? `已恢复 ${restored} 段原文。` : "没有可恢复的译文。" };
  }
}

function collectTextJobs(root: HTMLElement): TextNodeJob[] {
  const jobs: TextNodeJob[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node as Text;
      const parent = text.parentElement;
      if (!parent || SKIP_TAGS.has(parent.tagName)) {
        return NodeFilter.FILTER_REJECT;
      }
      if (parent.closest("[data-tranlithion-overlay],[data-tranlithion-mascot],.tranlithion-skip")) {
        return NodeFilter.FILTER_REJECT;
      }
      const value = text.nodeValue?.replace(/\s+/g, " ").trim() ?? "";
      if (value.length < 2) {
        return NodeFilter.FILTER_REJECT;
      }
      // Skip nodes that look already mostly Latin UI chrome on JP sites? Keep simple.
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let current = walker.nextNode();
  while (current && jobs.length < 500) {
    const text = current as Text;
    const original = text.nodeValue?.replace(/\s+/g, " ").trim() ?? "";
    if (original) {
      jobs.push({ node: text, original });
    }
    current = walker.nextNode();
  }
  return jobs;
}
