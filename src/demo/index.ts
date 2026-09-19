const samples = [
  {
    source: "こんにちは。今日はいい天気ですね。",
    translated: "你好。今天天气真不错。"
  },
  {
    source: "この店のラーメンは本当においしいです。",
    translated: "这家店的拉面真的很好吃。"
  },
  {
    source: "次の駅で降りましょう。",
    translated: "我们下一站下车吧。"
  },
  {
    source: "約束の時間に間に合ってよかった。",
    translated: "幸好赶上了约定的时间。"
  }
];

const captionPreview = byId<HTMLElement>("caption-preview");
const translatedCaption = byId<HTMLParagraphElement>("translated-caption");
const sourceCaption = byId<HTMLParagraphElement>("source-caption");
const progressLabel = byId<HTMLSpanElement>("progress-label");
const previousCue = byId<HTMLButtonElement>("previous-cue");
const nextCue = byId<HTMLButtonElement>("next-cue");
const playToggle = byId<HTMLButtonElement>("play-toggle");
const bilingualToggle = byId<HTMLInputElement>("bilingual-toggle");

let index = 0;
let playing = true;
let timer = window.setInterval(next, 3_200);

render();

previousCue.addEventListener("click", () => {
  index = (index - 1 + samples.length) % samples.length;
  render();
  restartTimer();
});
nextCue.addEventListener("click", () => {
  next();
  restartTimer();
});
playToggle.addEventListener("click", () => {
  playing = !playing;
  playToggle.setAttribute("aria-pressed", String(playing));
  playToggle.textContent = playing ? "暂停演示" : "继续演示";
  if (playing) {
    restartTimer();
  } else {
    window.clearInterval(timer);
  }
});
bilingualToggle.addEventListener("change", () => {
  captionPreview.dataset.bilingual = String(bilingualToggle.checked);
});

function next(): void {
  index = (index + 1) % samples.length;
  render();
}

function render(): void {
  const sample = samples[index];
  translatedCaption.textContent = sample.translated;
  sourceCaption.textContent = sample.source;
  progressLabel.textContent = `00:${String(index * 3 + 2).padStart(2, "0")}`;
}

function restartTimer(): void {
  window.clearInterval(timer);
  if (playing) {
    timer = window.setInterval(next, 3_200);
  }
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required element: ${id}`);
  }
  return element as T;
}
