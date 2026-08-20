import { openDatabase } from "./db.js";

const form = document.querySelector("#note-form");
const input = document.querySelector("#note-input");
const list = document.querySelector("#notes");
const empty = document.querySelector("#empty");
const clearAll = document.querySelector("#clear-all");
const backendBadge = document.querySelector("#backend");

const formatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
  timeStyle: "short",
});

let db;

async function render() {
  const notes = await db.all();
  list.replaceChildren(...notes.map(noteElement));
  empty.hidden = notes.length > 0;
}

function noteElement(note) {
  const li = document.createElement("li");

  const body = document.createElement("div");
  const text = document.createElement("span");
  text.className = "text";
  text.textContent = note.text;
  const when = document.createElement("span");
  when.className = "when";
  when.textContent = formatter.format(new Date(note.createdAt));
  body.append(text, when);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "delete";
  remove.textContent = "✕";
  remove.setAttribute("aria-label", `Delete note: ${note.text}`);
  remove.addEventListener("click", async () => {
    await db.remove(note.id);
    await render();
  });

  li.append(body, remove);
  return li;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  await db.add(text);
  form.reset();
  input.focus();
  await render();
});

clearAll.addEventListener("click", async () => {
  await db.clear();
  await render();
});

async function main() {
  db = await openDatabase();
  backendBadge.textContent = db.name;
  await render();
}

main().catch((error) => {
  console.error(error);
  backendBadge.textContent = "storage error";
  empty.textContent = `Could not open the database: ${error.message}`;
  empty.hidden = false;
});
