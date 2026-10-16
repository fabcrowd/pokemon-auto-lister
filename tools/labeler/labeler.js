import { MIN_BOX_PX, boxFromCorners, defaultBox, keyStep, moveBox, resizeBox } from "/box-geometry.js";
import { escHtml, renderPickList, thumbUrl } from "/lib/card-picker.js";

const $ = (id) => document.getElementById(id);
const EDITIONS = [["first", "1st Edition"], ["shadowless", "Shadowless"], ["standard", "Standard"], [null, "Can't tell"]];
const FINISHES = [["holofoil", "Holo"], ["reverse", "Reverse"], ["normal", "Normal"], [null, "Can't tell"]];
const CROP_BOX = { width: 360, height: 480 };
const MAX_DRAWN = 60;

// mode: "box" labels a detector box, "review" is the end-of-photo check, "drawn" labels a box the person just drew.
const state = {
  mode: "box", item: null, found: [], card: null, edition: undefined, finish: undefined,
  history: [], image: null, imageSha: null, drawnBox: null, drawnId: null,
};
let searchTimer = 0;
let searchSeq = 0;

function say(text, ok = false) {
  const message = $("message");
  message.textContent = text;
  message.classList.toggle("ok", ok);
}

async function api(route, init) {
  const response = await fetch(route, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function showProgress(progress) {
  $("progress").max = Math.max(1, progress.total);
  $("progress").value = progress.labeled;
  $("progress-text").textContent = `${progress.labeled} of ${progress.total} labeled`;
}

function loadImage(item) {
  if (state.imageSha === item.sha && state.image) return Promise.resolve(state.image);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      state.image = image;
      state.imageSha = item.sha;
      resolve(image);
    };
    image.onerror = () => reject(new Error("The photo did not load."));
    image.src = item.photoUrl;
  });
}

function drawCrop(image, box) {
  const canvas = $("crop");
  const [x1, y1, x2, y2] = box;
  const w = Math.max(1, x2 - x1);
  const h = Math.max(1, y2 - y1);
  const scale = Math.min(CROP_BOX.width / w, CROP_BOX.height / h);
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext("2d").drawImage(image, x1, y1, w, h, 0, 0, canvas.width, canvas.height);
}

function placeRect(element, item, box) {
  element.style.left = `${(box[0] / item.width) * 100}%`;
  element.style.top = `${(box[1] / item.height) * 100}%`;
  element.style.width = `${((box[2] - box[0]) / item.width) * 100}%`;
  element.style.height = `${((box[3] - box[1]) / item.height) * 100}%`;
}

function placeOutline(item, box) {
  $("outline").hidden = !box;
  if (box) placeRect($("outline"), item, box);
}

function choiceButtons(host, options, kind) {
  host.replaceChildren(...options.map(([value, label]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.dataset.kind = kind;
    button.dataset.value = value ?? "";
    button.setAttribute("aria-pressed", "false");
    return button;
  }));
}

function syncChoices() {
  for (const [host, key] of [[$("edition"), "edition"], [$("finish"), "finish"]]) {
    for (const button of host.children) {
      const value = button.dataset.value === "" ? null : button.dataset.value;
      button.setAttribute("aria-pressed", String(state[key] !== undefined && state[key] === value));
    }
  }
  $("save").disabled = !state.card || state.edition === undefined || state.finish === undefined;
}

function resetPick() {
  state.card = null;
  state.edition = undefined;
  state.finish = undefined;
  $("variant-pane").hidden = true;
  $("results").hidden = false;
  $("q").value = "";
  $("results").innerHTML = "";
  $("found").textContent = "";
  state.found = [];
  syncChoices();
}

function setMode(mode) {
  state.mode = mode;
  $("box-view").hidden = mode === "review";
  $("review-view").hidden = mode !== "review";
  $("find-pane").hidden = mode === "review";
  $("box-actions").hidden = mode !== "box";
  $("drawn-actions").hidden = mode !== "drawn";
  $("back").disabled = state.history.length === 0 || mode === "drawn";
}

async function showBox(item) {
  setMode("box");
  resetPick();
  $("crop-title").textContent = "This box";
  $("where").textContent = `Box ${item.boxIndex + 1} of ${item.boxes.length} in this photo.`;
  $("whole").src = item.photoUrl;
  try {
    const image = await loadImage(item);
    drawCrop(image, item.boxes[item.boxIndex]);
    $("crop").setAttribute("aria-label", `Box ${item.boxIndex + 1} of ${item.boxes.length}, cropped from the photo`);
  } catch (err) {
    say(err.message);
  }
  placeOutline(item, item.boxes[item.boxIndex]);
  $("q").focus();
}

function drawnLabel(row) {
  return row.kind === "card" ? "a card you named" : "a card you could not name";
}

function renderReview(item) {
  $("review-photo").src = item.photoUrl;
  $("review-boxes").replaceChildren(
    ...item.boxes.map((box) => {
      const rect = document.createElement("div");
      rect.className = "outline labeled";
      placeRect(rect, item, box);
      return rect;
    }),
    ...item.drawn.map((row) => {
      const rect = document.createElement("div");
      rect.className = "outline";
      placeRect(rect, item, row.box);
      return rect;
    }),
  );
  $("drawn-list").replaceChildren(...item.drawn.map((row, index) => {
    const li = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = `Drawn box ${index + 1}: ${drawnLabel(row)}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn quiet";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove drawn box ${index + 1}`);
    remove.addEventListener("click", () => removeDrawn(row.drawnId));
    li.append(text, remove);
    return li;
  }));
  $("missed-count").textContent = item.missed ? `${item.missed} so far` : "";
}

function showReview(item) {
  setMode("review");
  state.drawnBox = null;
  endAssist();
  renderReview(item);
  $("done-photo").focus();
}

async function show(body) {
  const { item, progress } = body;
  showProgress(progress);
  state.item = item;
  $("empty").hidden = !body.done;
  $("main").hidden = Boolean(body.done);
  if (body.done) {
    say("");
    return;
  }
  if (item.review) showReview(item);
  else await showBox(item);
}

async function next() {
  try {
    await show(await api("/api/next"));
  } catch (err) {
    say(err.message);
  }
}

async function send(label) {
  try {
    const result = await api("/api/label", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha: state.item.sha, ...label }),
    });
    showProgress(result.progress);
    return result;
  } catch (err) {
    say(err.message);
    return null;
  }
}

async function reloadReview() {
  const body = await api(`/api/item?sha=${state.item.sha}`);
  showProgress(body.progress);
  state.item = body.item;
  showReview(body.item);
}

async function labelBox(label) {
  if (state.mode === "drawn") {
    const row = { drawn: true, drawnId: state.drawnId, box: state.drawnBox, ...label };
    if (!(await send(row))) return;
    say("Saved.", true);
    await reloadReview().catch((err) => say(err.message));
    return;
  }
  const { sha, boxIndex } = state.item;
  if (!(await send({ boxIndex, ...label }))) return;
  state.history.push({ sha, boxIndex });
  say("Saved.", true);
  await next();
}

async function removeDrawn(drawnId) {
  if (!(await send({ drawn: true, drawnId, kind: "removed" }))) return;
  say("Removed.", true);
  await reloadReview().catch((err) => say(err.message));
}

function showFound(cards) {
  state.found = cards;
  $("results").innerHTML = renderPickList(cards, 0);
  $("found").textContent = cards.length === 0 ? "No matches" : cards.length === 1 ? "1 match" : `${cards.length} matches`;
  if (cards.length === 0 && $("q").value.trim()) $("results").innerHTML = `<p class="note">No matches. Try the name, the number, or both.</p>`;
}

$("q").addEventListener("input", () => {
  clearTimeout(searchTimer);
  const query = $("q").value.trim();
  if (!query) {
    showFound([]);
    return;
  }
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    try {
      const { cards } = await api(`/api/find?q=${encodeURIComponent(query)}`);
      if (seq === searchSeq) showFound(cards);
    } catch (err) {
      say(err.message);
    }
  }, 150);
});

$("results").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-pick]");
  if (!button) return;
  const card = state.found.find((row) => row.id === button.dataset.pick);
  if (!card) return;
  state.card = card;
  state.edition = undefined;
  state.finish = undefined;
  const url = thumbUrl(card);
  $("chosen").innerHTML = `${url ? `<img src="${escHtml(url)}" alt="">` : ""}<div><strong>${escHtml(card.name)}</strong>${escHtml([card.set || card.setCode, card.number ? `#${card.number}` : ""].filter(Boolean).join(" "))}</div>`;
  $("variant-pane").hidden = false;
  $("results").hidden = true;
  syncChoices();
  $("edition").firstElementChild.focus();
});

for (const host of [$("edition"), $("finish")]) {
  host.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    state[button.dataset.kind] = button.dataset.value === "" ? null : button.dataset.value;
    syncChoices();
  });
}

$("save").addEventListener("click", () => labelBox({ kind: "card", cardId: state.card.id, edition: state.edition, finish: state.finish }));
$("change").addEventListener("click", () => {
  state.card = null;
  $("variant-pane").hidden = true;
  $("results").hidden = false;
  syncChoices();
  $("q").focus();
});
$("not-card").addEventListener("click", () => labelBox({ kind: "not-card" }));
$("bad-box").addEventListener("click", () => labelBox({ kind: "bad-box" }));
$("unknown").addEventListener("click", () => labelBox({ kind: "unknown" }));
$("drawn-unknown").addEventListener("click", () => labelBox({ kind: "unknown" }));
$("drawn-cancel").addEventListener("click", () => {
  say("");
  showReview(state.item);
});

$("missed").addEventListener("click", async () => {
  const count = (state.item.missed || 0) + 1;
  const result = await send({ kind: "photo", missed: count });
  if (!result) return;
  state.item.missed = result.missed;
  $("missed-count").textContent = `${result.missed} so far`;
  say(`Counted ${result.missed} that could not be boxed.`, true);
});

$("done-photo").addEventListener("click", async () => {
  if (await send({ kind: "photo", missed: state.item.missed || 0 })) await next();
});

$("back").addEventListener("click", async () => {
  const last = state.history.pop();
  if (!last) return;
  try {
    await show({ ...(await api(`/api/item?sha=${last.sha}&boxIndex=${last.boxIndex}`)), done: false });
    say("Pick again to replace the earlier label.", true);
  } catch (err) {
    say(err.message);
  }
});

// Drawing a box has three ways in: drag, click two opposite corners, or the keyboard.
const frame = $("review-frame");
let drag = null;
let corner = null;
let keyBox = null;

function pointFrom(event) {
  const rect = frame.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * state.item.width,
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) * state.item.height,
  };
}

function showPreview(box) {
  $("preview").hidden = false;
  placeRect($("preview"), state.item, box);
}

function describeBox([x1, y1, x2, y2]) {
  const { width, height } = state.item;
  const pct = (value, of) => Math.round((value / of) * 100);
  return `Box ${pct(x2 - x1, width)} percent wide and ${pct(y2 - y1, height)} percent tall, ${pct(x1, width)} percent from the left and ${pct(y1, height)} percent from the top.`;
}

function endAssist() {
  corner = null;
  keyBox = null;
  $("preview").hidden = true;
  $("preview").classList.remove("keyboard");
  $("kbd-help").hidden = true;
  frame.removeAttribute("tabindex");
}

async function startDrawn(box) {
  const used = new Set(state.item.drawn.map((row) => row.drawnId));
  let id = 0;
  while (used.has(id) && id < MAX_DRAWN) id += 1;
  endAssist();
  if (id >= MAX_DRAWN) {
    say("That is as many boxes as one photo can hold.");
    return;
  }
  state.drawnBox = box;
  state.drawnId = id;
  setMode("drawn");
  resetPick();
  $("crop-title").textContent = "The box you drew";
  $("where").textContent = "Pick the card in this box, or say you can't tell. Cancel if the box is wrong.";
  $("whole").src = state.item.photoUrl;
  placeOutline(state.item, box);
  try {
    drawCrop(await loadImage(state.item), box);
    $("crop").setAttribute("aria-label", "The box you drew, cropped from the photo");
  } catch (err) {
    say(err.message);
  }
  $("q").focus();
}

const isBigEnough = (box) => box[2] - box[0] >= MIN_BOX_PX && box[3] - box[1] >= MIN_BOX_PX;

frame.addEventListener("pointerdown", (event) => {
  if (state.mode !== "review" || event.button !== 0) return;
  if (keyBox) endAssist();
  drag = pointFrom(event);
  frame.setPointerCapture(event.pointerId);
  event.preventDefault();
});

frame.addEventListener("pointermove", (event) => {
  const from = drag || corner;
  if (!from) return;
  showPreview(boxFromCorners(from, pointFrom(event), state.item.width, state.item.height));
});

async function finishDrag(event) {
  if (!drag) return;
  const end = pointFrom(event);
  const { width, height } = state.item;
  const dragged = boxFromCorners(drag, end, width, height);
  drag = null;
  if (isBigEnough(dragged)) {
    await startDrawn(dragged);
    return;
  }
  if (!corner) {
    corner = end;
    $("preview").hidden = true;
    say("First corner set. Click the opposite corner of the card, or press Escape to start over.", true);
    return;
  }
  const clicked = boxFromCorners(corner, end, width, height);
  if (!isBigEnough(clicked)) {
    say("Those corners are too close together. Click the opposite corner of the card.");
    return;
  }
  await startDrawn(clicked);
}

frame.addEventListener("pointerup", finishDrag);
frame.addEventListener("pointercancel", () => {
  drag = null;
  $("preview").hidden = true;
});

$("kbd-draw").addEventListener("click", () => {
  endAssist();
  keyBox = defaultBox(state.item.width, state.item.height);
  frame.tabIndex = 0;
  $("preview").classList.add("keyboard");
  $("kbd-help").hidden = false;
  showPreview(keyBox);
  frame.focus();
  say(`Drawing a box. Arrow keys move it, Shift with arrow keys resizes it, Enter confirms, Escape cancels. ${describeBox(keyBox)}`, true);
});

frame.addEventListener("keydown", (event) => {
  if (!keyBox || event.altKey || event.ctrlKey || event.metaKey) return;
  const { width, height } = state.item;
  const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
  if (arrow) {
    event.preventDefault();
    const step = keyStep(width, height);
    const [dx, dy] = [arrow[0] * step, arrow[1] * step];
    keyBox = event.shiftKey ? resizeBox(keyBox, dx, dy, width, height) : moveBox(keyBox, dx, dy, width, height);
    showPreview(keyBox);
    say(describeBox(keyBox), true);
  } else if (event.key === "Enter") {
    event.preventDefault();
    startDrawn(keyBox);
  } else if (event.key === "Escape") {
    event.preventDefault();
    endAssist();
    say("Box cancelled.", true);
    $("kbd-draw").focus();
  }
});

frame.addEventListener("focusout", () => {
  if (!keyBox) return;
  endAssist();
  say("Box cancelled.", true);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !corner) return;
  endAssist();
  say("Corner cleared.", true);
});

choiceButtons($("edition"), EDITIONS, "edition");
choiceButtons($("finish"), FINISHES, "finish");
next();
